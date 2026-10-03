// F3c1: migration v27 (source credential connections, team bindings, audit)
// on disposable databases only. Contract: docs/ai/gpexe-f3c-auth-discovery.md
// sections 3, 5, 6 (F3c1), 8c; runbook docs/runbooks/source-connections-v27.md.
//
// Nothing here touches OPTIMOVE or any persistent database, calls a source,
// or uses a real credential: the "credential" stored is a marker string
// encrypted under a key generated in this process.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import * as runner from "../src/migrate.js";
import * as cryptoMod from "../src/sourceCredentialCrypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const V26 = "202609252000_training_load_v26_activity_roster_decisions.sql";
const V27 = "202609271000_training_load_v27_source_credential_connections.sql";
const UP_TO_V26 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V26) + 1);
const ROLLBACK_SQL = path.resolve(__dirname, "../../docs/runbooks/source-connections-v27-rollback.sql");
const MARKER = "MARKER-credential-f3c1-not-real";
// The only host keys the tests themselves add to a disposable catalog.
const TEST_ONLY_HOST_KEYS = ["e98", "e99"];
// What v28 adds to the catalog (test 1 runs on v27 alone and sees the v27 seed only).
const V28_CATALOG_ROW = {
  source_system: "gpexe", host_key: "server3", label: "GPEXE server3", state: "approved",
  note: "API family rest/v1. Confirmed by the owner-run read-only verification of 2026-09-29. Approved for F3c2.",
};
const SEEDED_CATALOG = [{
  source_system: "gpexe", host_key: "e03", label: "GPEXE e03", state: "approved",
  note: "The server of the owner's organisation (UI at e03-ui.gpexe.com). Approved for F3c1.",
}];

let db;
let c;
let fx;

const uid = () => crypto.randomBytes(3).toString("hex");
async function q(sql, params = []) { return (await c.query(sql, params)).rows; }
// Runs one statement (or one call) in its own transaction and expects the
// database to refuse it; the transaction is always rolled back.
async function refusedCall(fn, pattern, label = "call") {
  await c.query("begin");
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  } finally {
    await c.query("rollback");
  }
  if (!error) assert.fail(`expected a refusal: ${label}`);
  if (pattern) assert.match(`${error.code} ${error.message}`, pattern, error.message);
  return error;
}
async function refused(sql, params, pattern) {
  return refusedCall(() => c.query(sql, params), pattern, sql.slice(0, 80));
}

async function catalogDigest(client) {
  return (await client.query(
    `select 'f:' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || md5(pg_get_functiondef(p.oid)) as x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','training','training_load') and p.prokind = 'f'
     union all
     select 't:' || c.relname || '.' || t.tgname || '=' || t.tgenabled::text || md5(pg_get_triggerdef(t.oid))
       from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname in ('public','training','training_load')
     union all
     select 'i:' || schemaname || '.' || indexname || '=' || md5(indexdef) from pg_indexes where schemaname in ('public','training','training_load')
     union all
     select 'c:' || n.nspname || '.' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public','training','training_load') and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
     union all
     select 'k:' || n.nspname || '.' || c.relname || '.' || con.conname || '=' || md5(pg_get_constraintdef(con.oid))
       from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public','training','training_load')
     order by 1`,
  )).rows.map((r) => r.x);
}

async function fixture() {
  const club = (await q(`insert into public.clubs (name) values ($1) returning id`, [`Club ${uid()}`]))[0].id;
  const otherClub = (await q(`insert into public.clubs (name) values ($1) returning id`, [`Other club ${uid()}`]))[0].id;
  const team = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [club, `Team ${uid()}`]))[0].id;
  const team2 = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [club, `Team B ${uid()}`]))[0].id;
  const foreignTeam = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [otherClub, `Foreign ${uid()}`]))[0].id;
  const admin = (await q(`insert into public.users (email, full_name) values ($1,'Admin') returning id`, [`admin-${uid()}@test.local`]))[0].id;
  return { club, otherClub, team, team2, foreignTeam, admin };
}

async function connection(over = {}) {
  const f = fx;
  const row = {
    source_system: "gpexe", owner_scope: "club", owner_club_id: f.club, owner_team_id: null, host_key: "e03",
    account_label: "Test account", credential_kind: "api_token", created_by_user_id: f.admin, ...over,
  };
  const cols = Object.keys(row);
  return (await q(
    `insert into training_load.source_credential_connections (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
    cols.map((k) => row[k]),
  ))[0];
}

function encrypted(conn, plaintext = MARKER, ring = fx.ring) {
  return cryptoMod.encryptCredential(plaintext, {
    connectionId: conn.id, ownerScope: conn.owner_scope, ownerClubId: conn.owner_club_id, ownerTeamId: conn.owner_team_id,
    sourceSystem: conn.source_system, hostKey: conn.host_key, credentialKind: conn.credential_kind,
  }, ring);
}

async function bind(conn, teamId, over = {}) {
  const row = { team_id: teamId, connection_id: conn.id, source_system: conn.source_system, source_team_id: String(1000 + Math.floor(Math.random() * 1e9)), bound_by_user_id: fx.admin, ...over };
  const cols = Object.keys(row);
  return (await q(
    `insert into training_load.source_team_bindings (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
    cols.map((k) => row[k]),
  ))[0];
}

before(async () => {
  // The v27 contract is tested on a database up to v28: v29 (F3c2d) tightens
  // two of these rules (every state but not_connected holds a credential,
  // linked_untested carries its facts) and is tested in source-connections-f3c2d.test.mjs.
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "f3c1", migrations: GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf("202609291000_training_load_v28_source_host_server3.sql") + 1) });
  c = new pg.Client({ connectionString: db.url });
  await c.connect();
  assert.equal((await q("select current_database() as db"))[0].db, db.name);
  fx = await fixture();
  fx.ring = cryptoMod.parseKeyring(cryptoMod.generateKeyEntry(1));
});

after(async () => {
  await c?.end();
  await db?.drop();
});

// ---------------------------------------------------------------------------
// 1. The migration itself
// ---------------------------------------------------------------------------
test("1. v27 applies on v26, the rollback returns exactly the v26 catalog and keeps every older row, v27 applies again, the rollback refuses a changed catalog, a later migration and first use, and a v27 that fails at its end leaves nothing", async () => {
  const m = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v27mig", migrations: UP_TO_V26 });
  const k = new pg.Client({ connectionString: m.url });
  await k.connect();
  try {
    assert.equal((await k.query("select current_database() as db")).rows[0].db, m.name);
    // A legacy GPEXE settings row for team 980 exists BEFORE v27, as in production.
    const club = (await k.query(`insert into public.clubs (name) values ('Legacy club') returning id`)).rows[0].id;
    const team = (await k.query(`insert into public.teams (club_id, name) values ($1,'Legacy team') returning id`, [club])).rows[0].id;
    const user = (await k.query(`insert into public.users (email) values ('legacy@test.local') returning id`)).rows[0].id;
    await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,'980',$2)`, [team, user]);
    const legacyBefore = (await k.query(`select owner_team_id, gpexe_team_id, configured_by_user_id, configured_at from training_load.gpexe_team_settings`)).rows;
    const historyBefore = (await k.query(`select count(*)::int as n from training_load.gpexe_team_settings_history`)).rows[0].n;

    const v26 = await catalogDigest(k);
    await applyGpexeTestMigrations(m.url, [...UP_TO_V26, V27]);
    const v27 = await catalogDigest(k);
    assert.notDeepEqual(v27, v26);
    assert.equal((await k.query(`select count(*)::int as n from public.schema_migrations where migration_name like $1`, [`%${V27}`])).rows[0].n, 1);
    // No row was created for team 980 or anyone; the legacy row is untouched.
    assert.equal((await k.query(`select count(*)::int as n from training_load.source_credential_connections`)).rows[0].n, 0);
    assert.equal((await k.query(`select count(*)::int as n from training_load.source_team_bindings`)).rows[0].n, 0);
    assert.equal((await k.query(`select count(*)::int as n from training_load.source_connection_audit`)).rows[0].n, 0);
    assert.deepEqual((await k.query(`select owner_team_id, gpexe_team_id, configured_by_user_id, configured_at from training_load.gpexe_team_settings`)).rows, legacyBefore);
    assert.equal((await k.query(`select count(*)::int as n from training_load.gpexe_team_settings_history`)).rows[0].n, historyBefore);

    // The seeded host catalog holds e03 only; server3 is deliberately absent.
    assert.deepEqual((await k.query(`select source_system, host_key, state from training_load.source_host_catalog order by 1, 2`)).rows, [{ source_system: "gpexe", host_key: "e03", state: "approved" }]);

    // While every v27 table is still empty the rollback drops v27 objects only.
    await k.query(await fsp.readFile(ROLLBACK_SQL, "utf8"));
    assert.deepEqual(await catalogDigest(k), v26, "the rollback leaves exactly the v26 catalog");
    assert.equal((await k.query(`select count(*)::int as n from public.schema_migrations where migration_name like $1`, [`%${V27}`])).rows[0].n, 0);
    assert.deepEqual((await k.query(`select owner_team_id, gpexe_team_id, configured_by_user_id, configured_at from training_load.gpexe_team_settings`)).rows, legacyBefore, "older rows kept");
    assert.equal((await k.query(`select count(*)::int as n from public.users`)).rows[0].n, 1);

    await applyGpexeTestMigrations(m.url, [...UP_TO_V26, V27]);
    assert.deepEqual(await catalogDigest(k), v27, "v27 applies again, identically");
    const rollbackSql = await fsp.readFile(ROLLBACK_SQL, "utf8");
    const catalogRows = async () => (await k.query(`select source_system, host_key, label, state, note, approved_at from training_load.source_host_catalog order by 1, 2`)).rows;
    const migrationNames = async () => (await k.query(`select migration_name from public.schema_migrations where migration_name > $1 or migration_name like $2 order by 1`, [`migrations_v2/${V27}`, `%${V27}`])).rows.map((r) => r.migration_name);
    assert.deepEqual((await catalogRows()).map(({ approved_at, ...r }) => r), SEEDED_CATALOG, "the catalog is exactly the seed");

    // A changed catalog row alone (no later migration) is refused; nothing is dropped.
    await k.query(`update training_load.source_host_catalog set label = 'GPEXE e03 (renamed)' where host_key = 'e03'`);
    await assert.rejects(k.query(rollbackSql), /v27 rollback refused: the host catalog is not the v27 seed/);
    await k.query("rollback").catch(() => {});
    assert.deepEqual(await catalogDigest(k), v27, "a refused rollback drops nothing");
    await k.query(`update training_load.source_host_catalog set label = 'GPEXE e03' where host_key = 'e03'`);

    // A later migration recorded alone (catalog still the seed) is refused as well.
    await k.query("begin");
    await k.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ('migrations_v2/209901010000_test_only_later.sql', repeat('0', 64), 0, 'test')`);
    await assert.rejects(k.query(rollbackSql), /v27 rollback refused: later migrations are applied: migrations_v2\/209901010000_test_only_later\.sql/);
    await k.query("rollback");

    // The reviewed scenario: a later DATA-ONLY migration approves another server (no connection
    // yet). The rollback refuses, and the catalog and both migration records stay exactly as they were.
    const SHARD = "209901010100_test_only_gpexe_shard.sql";
    const shardRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v27-shard-"));
    const shardDir = path.join(shardRoot, "migrations_v2");
    await fsp.mkdir(shardDir);
    try {
      for (const f of [...UP_TO_V26, V27]) await fsp.copyFile(path.resolve(__dirname, "../../migrations_v2", f), path.join(shardDir, f));
      await fsp.writeFile(path.join(shardDir, SHARD), "insert into training_load.source_host_catalog (source_system, host_key, label, note)\nvalues ('gpexe', 'e98', 'GPEXE e98 (test only)', 'test-only data migration');\n", "utf8");
      await runner.runMigrations({ databaseUrl: m.url, migrationsRoot: shardDir });
    } finally {
      await fsp.rm(shardRoot, { recursive: true, force: true });
    }
    const catalogBefore = await catalogRows();
    const migrationsBefore = await migrationNames();
    assert.deepEqual(catalogBefore.map((r) => r.host_key), ["e03", "e98"]);
    assert.deepEqual(migrationsBefore, [`migrations_v2/${SHARD}`, `migrations_v2/${V27}`].sort());
    assert.equal((await k.query(`select count(*)::int as n from training_load.source_credential_connections`)).rows[0].n, 0, "no connection exists yet");
    const shardError = await k.query(rollbackSql).then(() => null, (e) => e);
    await k.query("rollback").catch(() => {});
    assert.ok(shardError, "the rollback refuses once a later migration approved another server");
    assert.match(shardError.message, /the host catalog is not the v27 seed/);
    assert.match(shardError.message, new RegExp(`later migrations are applied: migrations_v2/${SHARD.replace(/\./g, "\\.")}`));
    assert.deepEqual(await catalogRows(), catalogBefore, "the catalog is kept exactly");
    assert.deepEqual(await migrationNames(), migrationsBefore, "both schema_migrations records are kept");
    assert.deepEqual(await catalogDigest(k), v27, "nothing was dropped");

    // After first use the rollback refuses and drops nothing: forward only.
    const conn = (await k.query(
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id)
       values ('gpexe','club',$1,'e03','Rollback test','api_token',$2) returning id`, [club, user])).rows[0].id;
    await k.query(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis) values ($1,'create','ok',$2,'platform_admin')`, [conn, user]);
    await assert.rejects(k.query(rollbackSql), /v27 rollback refused: .*source_credential_connections=1 source_team_bindings=0 source_connection_audit=1 rows exist/);
    await k.query("rollback").catch(() => {});
    assert.deepEqual(await catalogDigest(k), v27, "a refused rollback drops nothing");
    assert.equal((await k.query(`select count(*)::int as n from training_load.source_connection_audit`)).rows[0].n, 1, "the audit row is still there");
    assert.equal((await k.query(`select count(*)::int as n from public.schema_migrations where migration_name like $1`, [`%${V27}`])).rows[0].n, 1);
  } finally {
    await k.end();
    await m.drop();
  }

  // A v27 broken at its very last statement leaves nothing and is not recorded (fresh v26 database).
  const m2 = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v27fail", migrations: UP_TO_V26 });
  const k2 = new pg.Client({ connectionString: m2.url });
  await k2.connect();
  try {
    const v26b = await catalogDigest(k2);
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v27-fail-"));
    const dir = path.join(tempRoot, "migrations_v2");
    await fsp.mkdir(dir);
    try {
      for (const f of UP_TO_V26) await fsp.copyFile(path.resolve(__dirname, "../../migrations_v2", f), path.join(dir, f));
      const broken = `${await fsp.readFile(path.resolve(__dirname, "../../migrations_v2", V27), "utf8")}\nselect 1 / 0;\n`;
      await fsp.writeFile(path.join(dir, V27), broken, "utf8");
      await assert.rejects(runner.runMigrations({ databaseUrl: m2.url, migrationsRoot: dir }), /ABORT while applying .*v27_source_credential_connections.sql.*22012/);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
    assert.deepEqual(await catalogDigest(k2), v26b, "a failed v27 leaves nothing behind");
    assert.equal((await k2.query(`select count(*)::int as n from public.schema_migrations where migration_name like $1`, [`%${V27}`])).rows[0].n, 0);
    assert.equal((await k2.query(`select to_regclass('training_load.source_credential_connections') as r`)).rows[0].r, null);
    assert.equal((await k2.query(`select to_regclass('training_load.source_host_catalog') as r`)).rows[0].r, null);
  } finally {
    await k2.end();
    await m2.drop();
  }
});

test("2. the migration file carries no key, no URL and no transaction control; the rollback never copies or decrypts a credential", async () => {
  const sql = await fsp.readFile(path.resolve(__dirname, "../../migrations_v2", V27), "utf8");
  assert.doesNotMatch(sql, /https?:\/\//, "no URL in the schema");
  assert.doesNotMatch(sql, /SOURCE_CREDENTIAL_KEYS\s*=|pgp_sym|pgcrypto\.encrypt|decrypt\(/i);
  assert.deepEqual(runner.findTransactionControl(sql), [], "no transaction control (the runner's own lexer)");
  assert.ok(runner.findTransactionControl(`start transaction;\n${sql}`).length > 0, "the lexer would catch one");
  for (const doc of [sql, await fsp.readFile(path.resolve(__dirname, "../../docs/runbooks/source-connections-v27.md"), "utf8"), await fsp.readFile(path.resolve(__dirname, "../../docs/ai/CURRENT_STATE.md"), "utf8")]) {
    assert.doesNotMatch(doc, /source team per connection/i, "the documented invariant is the global one");
  }
  const rollback = (await fsp.readFile(ROLLBACK_SQL, "utf8")).split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(rollback, /create table|insert into|decrypt|copy /i, "the rollback holds only the emptiness guard, drops and the schema_migrations delete");
  assert.match(rollback, /rollback refused/, "the rollback refuses once any v27 table has a row");
  assert.match(rollback, /from training_load\.source_host_catalog/, "the rollback compares the catalog with the v27 seed");
  assert.match(rollback, /migration_name > 'migrations_v2\/202609271000_training_load_v27_source_credential_connections\.sql'/, "the rollback refuses under a later migration");
});

// ---------------------------------------------------------------------------
// 2. Connections: constraints
// ---------------------------------------------------------------------------
test("3. connection ownership: exactly one owner, club or team; never user or system", async () => {
  await refused(`insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, owner_team_id, host_key, account_label, credential_kind, created_by_user_id) values ('gpexe','club',$1,$2,'e03','x','api_token',$3)`, [fx.club, fx.team, fx.admin], /owner_check/);
  await refused(`insert into training_load.source_credential_connections (source_system, owner_scope, host_key, account_label, credential_kind, created_by_user_id) values ('gpexe','club','e03','x','api_token',$1)`, [fx.admin], /owner_check/);
  await refused(`insert into training_load.source_credential_connections (source_system, owner_scope, owner_team_id, host_key, account_label, credential_kind, created_by_user_id) values ('gpexe','club',$1,'e03','x','api_token',$2)`, [fx.team, fx.admin], /owner_check/);
  await refused(`insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id) values ('gpexe','user',$1,'e03','x','api_token',$2)`, [fx.club, fx.admin], /owner_scope_check|owner_check/);
  await refused(`insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id) values ('gpexe','system',$1,'e03','x','api_token',$2)`, [fx.club, fx.admin], /owner_scope_check|owner_check/);
  const teamOwned = await connection({ owner_scope: "team", owner_club_id: null, owner_team_id: fx.team });
  assert.equal(teamOwned.owner_team_id, fx.team);
});

test("4. host_key must be an APPROVED catalog key: unknown keys, URLs and case variants are refused, two approved keys serve different connections, a retired key is refused, and a host never changes under a stored credential", async () => {
  for (const bad of ["server4", "https://server3.gpexe.com/", "https://e03.gpexe.com/", "E03", "SERVER3", "e03 ", "", "e03/../x"]) {
    await refused(`insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id) values ('gpexe','club',$1,$2,'x','api_token',$3)`, [fx.club, bad, fx.admin], /host_key_format|not in the catalog|host_in_catalog/);
  }
  // A second confirmed server is one catalog ROW (data), not a structure change.
  await c.query(`insert into training_load.source_host_catalog (source_system, host_key, label, note) values ('gpexe','e99','GPEXE e99 (test only)','test-only row of the disposable database')`);
  const a = await connection({ host_key: "e03" });
  const b = await connection({ host_key: "e99" });
  assert.notEqual(a.host_key, b.host_key);
  // The catalog key is per source: another source cannot borrow it.
  await refused(`insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id) values ('catapult','club',$1,'e03','x','api_token',$2)`, [fx.club, fx.admin], /not in the catalog|host_in_catalog/);
  // A retired key takes no new connection; existing ones stay (F3c2 answers host_not_allowed for them).
  await c.query(`update training_load.source_host_catalog set state = 'retired' where source_system = 'gpexe' and host_key = 'e99'`);
  await refused(`insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id) values ('gpexe','club',$1,'e99','x','api_token',$2)`, [fx.club, fx.admin], /is retired/);
  assert.equal((await q(`select host_key from training_load.source_credential_connections where id = $1`, [b.id]))[0].host_key, "e99");
  // A connection on a retired key takes no new team binding either.
  await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','555001',$3)`, [fx.team2, b.id, fx.admin], /which is retired; no new binding/);
  await c.query(`update training_load.source_host_catalog set state = 'approved' where source_system = 'gpexe' and host_key = 'e99'`);
  // Approved again: the same binding is accepted (then ended, so later tests start clean).
  const onE99 = await bind(b, fx.team2, { source_team_id: "555001" });
  await c.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'test' where id = $1`, [onE99.id, fx.admin]);
  // The catalog itself keeps every key.
  await refused(`delete from training_load.source_host_catalog where host_key = 'e99'`, [], /DELETE refused/);
  await refused(`update training_load.source_host_catalog set host_key = 'e98' where host_key = 'e99'`, [], /host key is immutable/);
  // A host change under a stored credential is refused; wiping in the same statement passes; once bound the host is frozen for good.
  const rec = encrypted(a);
  await c.query(`update training_load.source_credential_connections set credential_ciphertext = $2, credential_nonce = $3, credential_auth_tag = $4, credential_key_version = $5, state = 'linked_untested' where id = $1`, [a.id, rec.ciphertext, rec.nonce, rec.authTag, rec.keyVersion]);
  await refused(`update training_load.source_credential_connections set host_key = 'e99' where id = $1`, [a.id], /credential context changed while its ciphertext stayed/);
  await c.query(`update training_load.source_credential_connections set host_key = 'e99', credential_ciphertext = null, credential_nonce = null, credential_auth_tag = null, credential_key_version = null, state = 'not_connected' where id = $1`, [a.id]);
  await c.query(`update training_load.source_credential_connections set host_key = 'e03' where id = $1`, [a.id]);
  const pinned = await bind(a, fx.team);
  await refused(`update training_load.source_credential_connections set host_key = 'e99' where id = $1`, [a.id], /has been bound: owner, source and host are immutable/);
  await c.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'test' where id = $1`, [pinned.id, fx.admin]);
  await refused(`insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id) values ('gpexe','club',$1,'e03','   ','api_token',$2)`, [fx.club, fx.admin], /account_label_check/);
  await refused(`insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id) values ('GPEXE','club',$1,'e03','x','api_token',$2)`, [fx.club, fx.admin], /source_system_format|not in the catalog/);
});

test("5. credential_kind is mandatory and open: api_token and exchanged_token both store, a malformed kind or a missing one is refused", async () => {
  const a = await connection({ credential_kind: "api_token" });
  const b = await connection({ credential_kind: "exchanged_token" });
  assert.equal(a.credential_kind, "api_token");
  assert.equal(b.credential_kind, "exchanged_token");
  await refused(`insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, created_by_user_id) values ('gpexe','club',$1,'e03','x',$2)`, [fx.club, fx.admin], /credential_kind/);
  await refused(`insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id) values ('gpexe','club',$1,'e03','x','Password!',$2)`, [fx.club, fx.admin], /credential_kind_format/);
});

test("6. the four credential parts are present together or all NULL, with AES-GCM sizes; there is no plaintext column", async () => {
  const conn = await connection();
  const cols = (await q(`select column_name from information_schema.columns where table_schema = 'training_load' and table_name = 'source_credential_connections'`)).map((r) => r.column_name);
  assert.ok(!cols.some((n) => /plain|password|secret|token$/.test(n)), cols.join(","));
  const rec = encrypted(conn);
  const set = async (parts) => c.query(
    `update training_load.source_credential_connections set credential_ciphertext = $2, credential_nonce = $3, credential_auth_tag = $4, credential_key_version = $5, state = 'linked_untested' where id = $1`,
    [conn.id, ...parts],
  );
  await set([rec.ciphertext, rec.nonce, rec.authTag, rec.keyVersion]);
  for (const partial of [
    [rec.ciphertext, null, null, null], [null, rec.nonce, rec.authTag, rec.keyVersion], [rec.ciphertext, rec.nonce, rec.authTag, null],
    [rec.ciphertext, Buffer.alloc(11), rec.authTag, 1], [rec.ciphertext, rec.nonce, Buffer.alloc(15), 1], [Buffer.alloc(0), rec.nonce, rec.authTag, 1], [rec.ciphertext, rec.nonce, rec.authTag, 0],
  ]) {
    await refusedCall(() => set(partial), /credential_complete/);
  }
  await c.query(`update training_load.source_credential_connections set credential_ciphertext = null, credential_nonce = null, credential_auth_tag = null, credential_key_version = null, state = 'not_connected' where id = $1`, [conn.id]);
  // What the database holds decrypts only with the right key and context.
  await set([rec.ciphertext, rec.nonce, rec.authTag, rec.keyVersion]);
  const stored = (await q(`select credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version from training_load.source_credential_connections where id = $1`, [conn.id]))[0];
  assert.ok(!stored.credential_ciphertext.toString("latin1").includes("MARKER"));
  assert.equal(cryptoMod.decryptCredential({ ciphertext: stored.credential_ciphertext, nonce: stored.credential_nonce, authTag: stored.credential_auth_tag, keyVersion: stored.credential_key_version }, {
    connectionId: conn.id, ownerScope: "club", ownerClubId: fx.club, ownerTeamId: null, sourceSystem: "gpexe", hostKey: "e03", credentialKind: "api_token",
  }, fx.ring), MARKER);
  const other = await connection();
  assert.throws(() => cryptoMod.decryptCredential({ ciphertext: stored.credential_ciphertext, nonce: stored.credential_nonce, authTag: stored.credential_auth_tag, keyVersion: stored.credential_key_version }, {
    connectionId: other.id, ownerScope: "club", ownerClubId: fx.club, ownerTeamId: null, sourceSystem: "gpexe", hostKey: "e03", credentialKind: "api_token",
  }, fx.ring), (e) => e.code === "decrypt_failed", "a ciphertext copied to another row is worthless");
});

test("7. state is one of the five and bound to its facts; verified needs a credential, not_connected must have none", async () => {
  const conn = await connection();
  const rec = encrypted(conn);
  const upd = (sql, params = []) => c.query(`update training_load.source_credential_connections set ${sql} where id = $1`, [conn.id, ...params]);
  await refusedCall(() => upd(`state = 'connected'`), /state_check/);
  await refusedCall(() => upd(`state = 'needs_reconnect'`), /needs_reconnect_facts/);
  await refusedCall(() => upd(`state = 'source_unavailable'`), /unavailable_facts/);
  await refusedCall(() => upd(`state = 'verified', last_verified_at = now()`), /verified_has_credential/);
  await refusedCall(() => upd(`state = 'verified', credential_ciphertext = $2, credential_nonce = $3, credential_auth_tag = $4, credential_key_version = $5`, [rec.ciphertext, rec.nonce, rec.authTag, 1]), /verified_facts/);
  await refusedCall(() => upd(`credential_ciphertext = $2, credential_nonce = $3, credential_auth_tag = $4, credential_key_version = $5`, [rec.ciphertext, rec.nonce, rec.authTag, 1]), /not_connected_no_credential/);
  await refusedCall(() => upd(`last_error_code = 'Bad Code'`), /last_error_code_format/);
  // The valid transitions of section 5.
  await upd(`state = 'linked_untested'`);
  await upd(`state = 'verified', last_verified_at = now(), credential_ciphertext = $2, credential_nonce = $3, credential_auth_tag = $4, credential_key_version = $5`, [rec.ciphertext, rec.nonce, rec.authTag, 1]);
  await upd(`state = 'needs_reconnect', last_error_code = 'source_unauthorized', last_error_at = now()`);
  await upd(`state = 'source_unavailable', last_error_code = 'source_unreachable', last_error_at = now()`);
  await upd(`state = 'not_connected', credential_ciphertext = null, credential_nonce = null, credential_auth_tag = null, credential_key_version = null`);
  assert.equal((await q(`select state from training_load.source_credential_connections where id = $1`, [conn.id]))[0].state, "not_connected");
});

// ---------------------------------------------------------------------------
// 3. Bindings
// ---------------------------------------------------------------------------
test("8. a binding needs its connection's source and a team inside the connection's owner; foreign clubs and other teams are refused", async () => {
  const clubConn = await connection();
  const b = await bind(clubConn, fx.team);
  assert.equal(b.state, "active");
  await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','981',$3)`, [fx.foreignTeam, clubConn.id, fx.admin], /not in the club that owns/);
  await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'catapult','981',$3)`, [fx.team2, clubConn.id, fx.admin], /must carry its connection/);
  await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','981',$3)`, [fx.team2, crypto.randomUUID(), fx.admin], /does not exist|foreign key/);
  const teamConn = await connection({ owner_scope: "team", owner_club_id: null, owner_team_id: fx.team2 });
  await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','982',$3)`, [fx.team, teamConn.id, fx.admin], /not the team that owns/);
  await bind(teamConn, fx.team2, { source_team_id: "982" });
});

test("9. one active binding per team and source, one active OptiMove team per source team across every connection; an ended binding frees both; GPEXE ids are canonical", async () => {
  const f2 = await fixture();
  fx = { ...fx, ...f2 };
  const conn = await connection();
  const first = await bind(conn, fx.team, { source_team_id: "100" });
  await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','101',$3)`, [fx.team, conn.id, fx.admin], /one_active_per_team_source/);
  await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','100',$3)`, [fx.team2, conn.id, fx.admin], /one_active_per_source_team/);
  // ... and across connections of other clubs (v22's global guarantee).
  const otherConn = await connection({ owner_club_id: fx.otherClub });
  await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','100',$3)`, [fx.foreignTeam, otherConn.id, fx.admin], /one_active_per_source_team/);
  await bind(otherConn, fx.foreignTeam, { source_team_id: "100100" });
  for (const bad of ["0980", "abc", "1234567890123", ""]) {
    await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe',$3,$4)`, [fx.team2, conn.id, bad, fx.admin], /gpexe_team_id_canonical|source_team_id_format/);
  }
  await c.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'moved' where id = $1`, [first.id, fx.admin]);
  const again = await bind(conn, fx.team, { source_team_id: "100" });
  assert.notEqual(again.id, first.id);
  assert.equal((await q(`select count(*)::int as n from training_load.source_team_bindings where team_id = $1`, [fx.team]))[0].n, 2, "history kept");
});

test("10. a binding is history: it can only end, an ended one is immutable, DELETE and TRUNCATE are refused, and the end needs its facts", async () => {
  const conn = await connection();
  const b = await bind(conn, fx.team2, { source_team_id: "200" });
  await refused(`update training_load.source_team_bindings set source_team_id = '201' where id = $1`, [b.id], /immutable except for ending/);
  await refused(`update training_load.source_team_bindings set team_id = $2 where id = $1`, [b.id, fx.team], /immutable except for ending/);
  await refused(`update training_load.source_team_bindings set bind_reason = 'later' where id = $1`, [b.id], /immutable except for ending/);
  await refused(`update training_load.source_team_bindings set state = 'ended' where id = $1`, [b.id], /ended_facts/);
  await refused(`delete from training_load.source_team_bindings where id = $1`, [b.id], /DELETE refused/);
  await refused(`truncate training_load.source_team_bindings`, [], /TRUNCATE refused/);
  await c.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'done' where id = $1`, [b.id, fx.admin]);
  await refused(`update training_load.source_team_bindings set end_reason = 'changed my mind' where id = $1`, [b.id], /has ended and is immutable/);
  await refused(`update training_load.source_team_bindings set state = 'active', ended_at = null, ended_by_user_id = null, end_reason = null where id = $1`, [b.id], /has ended and is immutable/);
});

test("11. the legacy GPEXE settings pointer keeps provenance without touching gpexe_team_settings, and only for the binding's own team", async () => {
  const f = await fixture();
  await c.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,'980',$2)`, [f.team, f.admin]);
  const legacy = (await q(`select * from training_load.gpexe_team_settings where owner_team_id = $1`, [f.team]))[0];
  const historyN = (await q(`select count(*)::int as n from training_load.gpexe_team_settings_history`))[0].n;
  const conn = await connection({ owner_club_id: f.club, created_by_user_id: f.admin });
  await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1,$2,'gpexe','980',$3,$4)`, [f.team2, conn.id, f.admin, f.team], /must be the binding.s own team/);
  await c.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1,$2,'gpexe','980',$3,$1)`, [f.team, conn.id, f.admin]);
  assert.deepEqual((await q(`select * from training_load.gpexe_team_settings where owner_team_id = $1`, [f.team]))[0], legacy, "the legacy row is unchanged");
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_team_settings_history`))[0].n, historyN, "no history row written");
  await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1,$2,'gpexe','980',$3,$4)`, [f.team2, conn.id, f.admin, f.team2], /foreign key|violates/);
});

test("12. the bound team ids of a connection come back ascending, active only — the lock order F3c2 will use", async () => {
  const f = await fixture();
  const conn = await connection({ owner_club_id: f.club, created_by_user_id: f.admin });
  const t3 = (await q(`insert into public.teams (club_id, name) values ($1,'Team C') returning id`, [f.club]))[0].id;
  const teams = [f.team, f.team2, t3];
  for (const [i, t] of teams.entries()) await bind(conn, t, { source_team_id: String(300 + i), bound_by_user_id: f.admin });
  const ended = (await q(`select id from training_load.source_team_bindings where connection_id = $1 and team_id = $2`, [conn.id, t3]))[0].id;
  await c.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'x' where id = $1`, [ended, f.admin]);
  const ids = (await q(`select training_load.source_connection_bound_team_ids($1) as id`, [conn.id])).map((r) => r.id);
  assert.deepEqual(ids, [f.team, f.team2].sort());
  const plan = (await q(`explain select team_id from training_load.source_team_bindings where connection_id = $1 and state = 'active' order by team_id`, [conn.id])).map((r) => r["QUERY PLAN"]).join("\n");
  assert.ok((await q(`select indexname from pg_indexes where indexname = 'source_team_bindings_connection_team_idx'`)).length === 1, plan);
});

// ---------------------------------------------------------------------------
// 4. Connection identity once bound
// ---------------------------------------------------------------------------
test("13. owner, source and host of a connection are immutable once it has ever been bound (also after the binding ended); before that they may change; the label and state stay editable", async () => {
  const f = await fixture();
  const conn = await connection({ owner_club_id: f.club, created_by_user_id: f.admin });
  await c.query(`update training_load.source_credential_connections set owner_scope = 'team', owner_club_id = null, owner_team_id = $2 where id = $1`, [conn.id, f.team]);
  await c.query(`update training_load.source_credential_connections set owner_scope = 'club', owner_club_id = $2, owner_team_id = null where id = $1`, [conn.id, f.club]);
  {
    // Unbound but holding a credential: an owner change without touching the ciphertext is refused.
    const rec0 = encrypted(conn);
    await c.query(`update training_load.source_credential_connections set credential_ciphertext = $2, credential_nonce = $3, credential_auth_tag = $4, credential_key_version = $5, state = 'linked_untested' where id = $1`, [conn.id, rec0.ciphertext, rec0.nonce, rec0.authTag, rec0.keyVersion]);
    await refused(`update training_load.source_credential_connections set owner_club_id = $2 where id = $1`, [conn.id, f.otherClub], /credential context changed while its ciphertext stayed/);
    await c.query(`update training_load.source_credential_connections set credential_ciphertext = null, credential_nonce = null, credential_auth_tag = null, credential_key_version = null, state = 'not_connected' where id = $1`, [conn.id]);
  }
  const b = await bind(conn, f.team, { source_team_id: "400", bound_by_user_id: f.admin });
  await refused(`update training_load.source_credential_connections set owner_club_id = $2 where id = $1`, [conn.id, f.otherClub], /has been bound: owner, source and host are immutable/);
  await refused(`update training_load.source_credential_connections set owner_scope = 'team', owner_club_id = null, owner_team_id = $2 where id = $1`, [conn.id, f.team], /immutable/);
  await refused(`update training_load.source_credential_connections set source_system = 'catapult' where id = $1`, [conn.id], /immutable|not in the catalog/);
  await refused(`update training_load.source_credential_connections set id = $2 where id = $1`, [conn.id, crypto.randomUUID()], /id is immutable/);
  // credential_kind: free while no credential is stored, frozen while one is.
  await c.query(`update training_load.source_credential_connections set credential_kind = 'exchanged_token' where id = $1`, [conn.id]);
  const rec = encrypted({ ...conn, credential_kind: "exchanged_token" });
  await c.query(`update training_load.source_credential_connections set credential_ciphertext = $2, credential_nonce = $3, credential_auth_tag = $4, credential_key_version = $5, state = 'linked_untested' where id = $1`, [conn.id, rec.ciphertext, rec.nonce, rec.authTag, rec.keyVersion]);
  await refused(`update training_load.source_credential_connections set credential_kind = 'api_token' where id = $1`, [conn.id], /credential context changed while its ciphertext stayed/);
  // Every AAD column is frozen while the ciphertext stays; wiping or re-encrypting in the same statement passes.
  const fresh = encrypted({ ...conn, credential_kind: "api_token" });
  await c.query(`update training_load.source_credential_connections set credential_kind = 'api_token', credential_ciphertext = $2, credential_nonce = $3, credential_auth_tag = $4, credential_key_version = $5 where id = $1`, [conn.id, fresh.ciphertext, fresh.nonce, fresh.authTag, fresh.keyVersion]);
  await c.query(`update training_load.source_credential_connections set credential_ciphertext = null, credential_nonce = null, credential_auth_tag = null, credential_key_version = null, state = 'not_connected' where id = $1`, [conn.id]);
  await c.query(`update training_load.source_credential_connections set credential_kind = 'api_token' where id = $1`, [conn.id]);
  await c.query(`update training_load.source_credential_connections set account_label = 'Renamed', updated_by_user_id = $2, updated_at = now() where id = $1`, [conn.id, f.admin]);
  await c.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'x' where id = $1`, [b.id, f.admin]);
  await refused(`update training_load.source_credential_connections set owner_club_id = $2 where id = $1`, [conn.id, f.otherClub], /immutable/);
  await refused(`delete from training_load.source_credential_connections where id = $1`, [conn.id], /foreign key|violates/);
});

// ---------------------------------------------------------------------------
// 5. Audit
// ---------------------------------------------------------------------------
test("14. the audit is append-only, names who/when/what/outcome/reason/object, refuses secret-named metadata keys and an actor-less human action", async () => {
  const f = await fixture();
  const conn = await connection({ owner_club_id: f.club, created_by_user_id: f.admin });
  const row = (await q(
    `insert into training_load.source_connection_audit (connection_id, team_id, action, outcome, reason, performed_by_user_id, basis, metadata)
     values ($1,$2,'bind','ok','first binding',$3,'platform_admin','{"host_key":"e03","source_team_id":"980","credential_kind":"api_token"}') returning *`,
    [conn.id, f.team, f.admin],
  ))[0];
  assert.ok(row.performed_at);
  await refused(`update training_load.source_connection_audit set reason = 'edited' where id = $1`, [row.id], /append-only/);
  await refused(`delete from training_load.source_connection_audit where id = $1`, [row.id], /append-only/);
  await refused(`truncate training_load.source_connection_audit`, [], /TRUNCATE refused/);
  for (const key of ["token", "Authorization", "PASSWORD", "Set-Cookie", "cookie", "jwt", "Bearer", "api_key", "apiKey", "X-Auth-Token", "sessionId", "username", "ciphertext", "credential", "keys", "key", "signing_key", "Encryption_Key", "device_key", "x_credential_kind", "credential_kind_x", "signingKey", "private-key", "deviceKey", "auth", "Auth.Token", "privateKey", "refreshToken", "pwd", "access token", "accesstoken", "authtoken", "sessionid", "passcode", "Xauth"]) {
    await c.query("begin");
    const err = await c.query(
      `insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis, metadata) values ($1,'test','ok',$2,'platform_admin',$3)`,
      [conn.id, f.admin, JSON.stringify({ [key]: "MARKER-should-never-land" })],
    ).then(() => null, (e) => e);
    await c.query("rollback");
    assert.ok(err, `metadata key ${key} must be refused whatever its case`);
    assert.match(err.message, /metadata_no_secret_keys/);
  }
  await refused(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis, metadata) values ($1,'test','ok',$2,'platform_admin','["a"]')`, [conn.id, f.admin], /metadata_is_object/);
  await c.query(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis, metadata) values ($1,'test','ok',$2,'platform_admin','{"host_key":"e03","hostKey":"e03","status":401,"attempt":2,"credential_kind":"api_token","credentialKind":"api_token","monkey":"business","keyboard":"qwerty","donkey":1,"authorName":"n","sourceTeamId":"980","turkey":true}')`, [conn.id, f.admin]);
  await refused(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis, metadata) values ($1,'test','ok',$2,'platform_admin','{"headers":{"token":"MARKER"}}')`, [conn.id, f.admin], /metadata_no_secret_keys/);
  await refused(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis, metadata) values ($1,'test','ok',$2,'platform_admin','{"list":[1,2]}')`, [conn.id, f.admin], /metadata_no_secret_keys/);
  await refused(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis) values ($1,'test','ok',$2,'team_coach')`, [conn.id, f.admin], /basis_check|audit_actor/);
  await refused(`insert into training_load.source_connection_audit (connection_id, action, outcome, basis) values ($1,'connect','ok','platform_admin')`, [conn.id], /audit_actor/);
  await refused(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis) values ($1,'auto_invalidate','ok',$2,'system')`, [conn.id, f.admin], /audit_actor/);
  await refused(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis) values ($1,'connect','failed',$2,'platform_admin')`, [conn.id, f.admin], /failed_has_code/);
  await refused(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis) values ($1,'connect','ok',$2,'team_coach')`, [conn.id, f.admin], /basis_check|audit_actor/);
  await refused(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis) values ($1,'bind','ok',$2,'platform_admin')`, [conn.id, f.admin], /bind_names_team/);
  await c.query(`insert into training_load.source_connection_audit (connection_id, action, outcome, error_code, basis) values ($1,'auto_invalidate','failed','source_unauthorized','system')`, [conn.id]);
  assert.equal((await q(`select count(*)::int as n from training_load.source_connection_audit where connection_id = $1`, [conn.id]))[0].n, 3, "bind, the sanitized test row and the system auto_invalidate");
});

// ---------------------------------------------------------------------------
// 6. Mutation proofs: the guards are what refuse, not chance
// ---------------------------------------------------------------------------
test("15. mutation proof: with the identity trigger disabled a bound connection CAN be re-owned; with the audit trigger disabled a row CAN be edited; with the owner trigger disabled a foreign team CAN bind", async () => {
  const f = await fixture();
  const conn = await connection({ owner_club_id: f.club, created_by_user_id: f.admin });
  await bind(conn, f.team, { source_team_id: "500", bound_by_user_id: f.admin });
  await c.query("begin");
  try {
    await c.query(`alter table training_load.source_credential_connections disable trigger source_credential_connections_protect_identity`);
    await c.query(`update training_load.source_credential_connections set owner_club_id = $2 where id = $1`, [conn.id, f.otherClub]);
    await c.query(`alter table training_load.source_team_bindings disable trigger source_team_bindings_check_owner`);
    await c.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'catapult','501',$3)`, [f.foreignTeam, conn.id, f.admin]);
    const a = (await q(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis) values ($1,'create','ok',$2,'platform_admin') returning id`, [conn.id, f.admin]))[0].id;
    await c.query(`alter table training_load.source_connection_audit disable trigger source_connection_audit_no_update_delete`);
    await c.query(`update training_load.source_connection_audit set reason = 'rewritten' where id = $1`, [a]);
  } finally {
    await c.query("rollback");
  }
  // Back with the triggers: the same statements are refused again.
  await refused(`update training_load.source_credential_connections set owner_club_id = $2 where id = $1`, [conn.id, f.otherClub], /immutable/);
  await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'catapult','501',$3)`, [f.foreignTeam, conn.id, f.admin], /must carry its connection|not in the club/);
});

// ---------------------------------------------------------------------------
// 7. The server starts without the key
// ---------------------------------------------------------------------------
test("16. the app server starts and answers /api/health with no SOURCE_CREDENTIAL_KEYS in the environment; the crypto module then refuses with key_missing, never a crash", async () => {
  delete process.env.SOURCE_CREDENTIAL_KEYS;
  delete process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION;
  process.env.DATABASE_URL = db.url;
  const { app } = await import("../src/server.js");
  const { pool } = await import("../src/db.js");
  assert.equal((await pool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app pool is on the disposable database");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const res = await fetch(`http://localhost:${server.address().port}/api/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
  assert.throws(() => cryptoMod.encryptCredential(MARKER, { connectionId: crypto.randomUUID(), ownerScope: "club", ownerClubId: fx.club, ownerTeamId: null, sourceSystem: "gpexe", hostKey: "e03", credentialKind: "api_token" }), (e) => e.code === "key_missing");
});

// ---------------------------------------------------------------------------
// 8. The team lock, taken by the database itself
// ---------------------------------------------------------------------------
test("17. creating or ending a binding takes the team's import lock try-lock style: while another session holds it, the write is refused with 'try again' and nothing waits; a different team is unaffected", async () => {
  const f = await fixture();
  const conn = await connection({ owner_club_id: f.club, created_by_user_id: f.admin });
  const other = new pg.Client({ connectionString: db.url });
  await other.connect();
  try {
    await other.query("begin");
    await other.query(`select training_load.hold_gpexe_team_lock($1, 'a running check')`, [f.team]);
    const started = Date.now();
    await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','600',$3)`, [f.team, conn.id, f.admin], /try again when it has finished/);
    assert.ok(Date.now() - started < 2000, "a try-lock refuses at once, it does not wait");
    const b2 = await bind(conn, f.team2, { source_team_id: "601", bound_by_user_id: f.admin });
    await other.query("rollback");
    const b1 = await bind(conn, f.team, { source_team_id: "600", bound_by_user_id: f.admin });
    await other.query("begin");
    await other.query(`select training_load.hold_gpexe_team_lock($1, 'a running check')`, [f.team]);
    await refused(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'x' where id = $1`, [b1.id, f.admin], /try again when it has finished/);
    await c.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'x' where id = $1`, [b2.id, f.admin]);
    await other.query("rollback");
    // Mutation proof: without the lock call the same insert would go through next to the held lock.
    await other.query("begin");
    await other.query(`select training_load.hold_gpexe_team_lock($1, 'a running check')`, [f.team2]);
    await c.query("begin");
    try {
      await c.query(`alter table training_load.source_team_bindings disable trigger source_team_bindings_check_owner`);
      await c.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','602',$3)`, [f.team2, conn.id, f.admin]);
    } finally {
      await c.query("rollback");
    }
    await other.query("rollback");
  } finally {
    await other.end();
  }
});

test("18. every approved key the migration seeds resolves in the backend catalog to an exact https host, the backend resolves nothing else, and a network caller's host needs BOTH an approved catalog row and the code entry", async () => {
  // Every row that is not one of the tests' own keys must be exactly the seed; a NULL note is
  // compared like any other value, never skipped.
  const rows = await q(`select source_system, host_key, label, state, note from training_load.source_host_catalog order by 1, 2`);
  assert.deepEqual(rows.filter((r) => !TEST_ONLY_HOST_KEYS.includes(r.host_key)), [...SEEDED_CATALOG, V28_CATALOG_ROW]);
  for (const r of rows.filter((x) => TEST_ONLY_HOST_KEYS.includes(x.host_key))) assert.match(r.note ?? "", /^test-only/, "only the tests add rows, and they say so");
  const seeded = rows.filter((r) => !TEST_ONLY_HOST_KEYS.includes(r.host_key) && r.state === "approved");
  const { sourceHost, resolvableHostKeys, resolveApprovedSourceHost, SOURCE_HOSTS } = await import("../src/sourceHosts.js");
  for (const row of seeded) assert.match(sourceHost(row.source_system, row.host_key).baseUrl, /^https:\/\/[a-z0-9.-]+\/$/);

  // The gate before any network call: the DB row must be approved AND the code must resolve the key.
  await c.query(`insert into training_load.source_host_catalog (source_system, host_key, label, note) values ('gpexe','e99','GPEXE e99 (test only)','test-only row of the disposable database') on conflict do nothing`);
  const row = async (key) => (await q(`select source_system, host_key, state from training_load.source_host_catalog where source_system = 'gpexe' and host_key = $1`, [key]))[0];
  const e03 = await row("e03");
  assert.equal(resolveApprovedSourceHost("gpexe", "e03", e03).baseUrl, "https://e03.gpexe.com/");
  const notAllowed = (fn) => assert.throws(fn, (e) => e.code === "host_not_allowed");
  notAllowed(() => resolveApprovedSourceHost("gpexe", "e03", { ...e03, state: "retired" }));
  notAllowed(() => resolveApprovedSourceHost("gpexe", "e03", null));
  notAllowed(() => resolveApprovedSourceHost("gpexe", "e03", { ...e03, host_key: "e99" }));
  notAllowed(() => resolveApprovedSourceHost("catapult", "e03", e03));
  const e99 = await row("e99");
  assert.equal(e99.state, "approved");
  notAllowed(() => resolveApprovedSourceHost("gpexe", "e99", e99)); // approved in the database, absent from the code
  notAllowed(() => resolveApprovedSourceHost("gpexe", "server4", { source_system: "gpexe", host_key: "server4", state: "approved" })); // in no layer
  assert.deepEqual(resolvableHostKeys("gpexe"), ["e03", "server3"], "the two confirmed servers, nothing else");
  assert.deepEqual(Object.keys(SOURCE_HOSTS), ["gpexe"]);
});

// ---------------------------------------------------------------------------
// 9. A team never leaves the club it is bound through
// ---------------------------------------------------------------------------
test("19. moving a team to another club is refused while it has an active binding to its club's connection, allowed after the binding ended or for a team-owned connection, and serialized with a binding insert in both orders", async () => {
  const f = await fixture();
  const conn = await connection({ owner_club_id: f.club, created_by_user_id: f.admin });
  const b = await bind(conn, f.team, { bound_by_user_id: f.admin });
  await refused(`update public.teams set club_id = $2 where id = $1`, [f.team, f.otherClub], /bound through connection .* end that binding before moving the team/);
  // A team-owned connection does not pin the club; a team with no binding moves freely.
  const teamConn = await connection({ owner_scope: "team", owner_club_id: null, owner_team_id: f.team2, created_by_user_id: f.admin });
  await bind(teamConn, f.team2, { bound_by_user_id: f.admin });
  await c.query(`update public.teams set club_id = $2 where id = $1`, [f.team2, f.otherClub]);
  await c.query(`update public.teams set club_id = $2 where id = $1`, [f.team2, f.club]);
  // Ended binding: the move is allowed again.
  await c.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'moving' where id = $1`, [b.id, f.admin]);
  await c.query(`update public.teams set club_id = $2 where id = $1`, [f.team, f.otherClub]);
  await c.query(`update public.teams set club_id = $2 where id = $1`, [f.team, f.club]);

  // Concurrency, order 1: a binding insert is in flight. Its trigger holds the team row FOR SHARE,
  // so the move WAITS on that row (an UPDATE locks its row before its BEFORE trigger runs), and
  // once the binding commits the guard sees it and refuses. Serialized, never interleaved.
  const other = new pg.Client({ connectionString: db.url });
  await other.connect();
  try {
    await other.query("begin");
    await other.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','710',$3)`, [f.team, conn.id, f.admin]);
    const mover = new pg.Client({ connectionString: db.url });
    await mover.connect();
    try {
      const moving = mover.query(`update public.teams set club_id = $2 where id = $1`, [f.team, f.otherClub]).then(() => null, (e) => e);
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        waiting = (await q(`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like 'update public.teams set club_id%'`)).length > 0;
      }
      assert.ok(waiting, "the move waits for the binding transaction instead of interleaving with it");
      await other.query("commit");
      const err = await moving;
      assert.ok(err, "after the binding committed the move is refused");
      assert.match(err.message, /end that binding before moving the team/);
    } finally {
      await mover.end();
    }
    const b2 = (await q(`select id from training_load.source_team_bindings where team_id = $1 and state = 'active'`, [f.team]))[0].id;
    await c.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'x' where id = $1`, [b2, f.admin]);
    // Order 2: the move is in flight (holds the team's try-lock) -> the binding insert, whose
    // trigger takes the try-lock first, is refused at once with "try again".
    await other.query("begin");
    await other.query(`update public.teams set club_id = $2 where id = $1`, [f.team, f.otherClub]);
    await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','711',$3)`, [f.team, conn.id, f.admin], /try again when it has finished/);
    await other.query("commit");
    // After the move committed, the team is in another club: the club connection refuses it outright.
    await refused(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','711',$3)`, [f.team, conn.id, f.admin], /not in the club that owns/);
    await c.query(`update public.teams set club_id = $2 where id = $1`, [f.team, f.club]);
    // Mutation proof: without the guard trigger the move goes through next to an active binding.
    await bind(conn, f.team, { bound_by_user_id: f.admin, source_team_id: "712" });
    await c.query("begin");
    try {
      await c.query(`alter table public.teams disable trigger teams_source_binding_guard_move`);
      await c.query(`update public.teams set club_id = $2 where id = $1`, [f.team, f.otherClub]);
    } finally {
      await c.query("rollback");
    }
    await refused(`update public.teams set club_id = $2 where id = $1`, [f.team, f.otherClub], /end that binding before moving the team/);
  } finally {
    await other.end();
  }
});

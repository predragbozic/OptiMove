// Migration v42, the zone model (option A; C102, C103; contract
// docs/ai/phase5-zone-model-contract.md, section 6; J7 of
// docs/ai/gpexe-metric-variable-mapping-discovery.md).
//
// Two disposable databases: a rehearsal one migrated through v41 (the
// preflight, v42's fail-closed refusals, its application through the runner,
// the post-check, every refusal of the rollback, the rollback itself back to
// v41's exact catalog and data, and v42 again), and a behaviour one migrated
// through v42 (the database rule, the F3 route on the seeded zone fields, M2's
// mapping versions on them end to end, and a dump and restore). Every write in
// the rehearsal's refusal cases runs inside a transaction that is rolled back.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { writeRevision } from "./support/source-revisions.mjs";
import { createDisposableDatabase } from "./support/disposable-db.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V42 = "202610282300_training_load_v42_source_metric_zone_model.sql";
const V42_NAME = `migrations_v2/${V42}`;
const V41_NAME = "migrations_v2/202610281000_training_load_v41_metric_classification.sql";
const V34_NAME = "migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql";
const UP_TO_V41 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V42));
const V42_FILE = path.resolve(ROOT, "migrations_v2", V42);
const RUNBOOKS = path.resolve(ROOT, "docs/runbooks");
const ROLLBACK = path.join(RUNBOOKS, "source-metric-zone-model-v42-rollback.sql");
const PREFLIGHT = path.join(RUNBOOKS, "source-metric-zone-model-v42-preflight.sql");
const POSTCHECK = path.join(RUNBOOKS, "source-metric-zone-model-v42-postcheck.sql");
const PREFIX = "/api/training-load/sources/metrics";
const OPEN_TOP = "more.complementary_data.power.distance.open_top";
const POWER = "more.complementary_data.power.distance";
const SPEED = "more.complementary_data.speed.distance";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const UNIT_NOTE = "Expected unit is a hypothesis from the e03 pilot; not proven on server3. The open top zone of the power zone list: the zone whose upper extreme is null.";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const ZONE = /^source_metric_definition_versions: a zone takes the operator between or >=$/;
const EVENT_OP = /^source_metric_definition_versions: an event threshold takes a one-sided operator$/;
const NO_ACTOR = /no acting user is set for this transaction/;
const NOT_ADMIN = /not an active platform admin|may not verify a source metric/;
const SEED_WINDOW = /^source metric mapping: a seed marker is accepted only from the seeding migration$/;

let rdb, db, r, k, server, apiBase, dbModule, appPool, createSession;
const W = {};

async function migrate(url, files) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v42-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of files) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

before(async () => {
  assert.equal(GPEXE_TEST_MIGRATIONS.at(-1), V42, "v42 is the last test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v42rb", migrations: UP_TO_V41 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v42" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  await r.connect();
  await k.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  dbModule = await import("../src/db.js");
  ({ createSession } = await import("../src/auth.js"));
  appPool = dbModule.pool;
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await world();
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) {
    let timer;
    await Promise.race([appPool.end(), new Promise((res) => { timer = setTimeout(res, 5_000); })]);
    clearTimeout(timer);
  }
  await r?.end().catch(() => {});
  await k?.end().catch(() => {});
  await rdb?.drop();
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

// ---------------------------------------------------------------------------
// helpers
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const key = () => crypto.randomUUID();

async function api(p, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${PREFIX}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const post = (p, cookie, body) => api(p, { method: "POST", cookie, body });
const unitPath = (f) => `/fields/${f.fieldId}/revisions/${f.revId}/unit-verification`;
const meaningPath = (f) => `/fields/${f.fieldId}/revisions/${f.revId}/meaning-verification`;

async function user(label) {
  return (await one(k, `insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,true) returning id`, [`${label}-${uid()}@test.local`, label])).id;
}
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
async function platformAdmin(ws = ["platform", null]) {
  const id = await user("platform-admin");
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  if (ws[0] === "club") await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, ws[1]]);
  await workspace(id, ws[0], ws[1]);
  return { id, cookie: await cookieFor(id) };
}
async function clubAdmin(clubId) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await workspace(id, "club", clubId);
  return { id, cookie: await cookieFor(id) };
}
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;

// A system canonical variable in metres with a condition (as the M2 suite writes it).
async function canonical(cd) {
  const id = (await one(k, `insert into training_load.metric_definitions (key, label, owner_scope, state) values ($1,'v42 test variable','system','active') returning id`, [`v42_${uid()}`])).id;
  const versionId = (await one(k, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, condition_description) values ($1,1,'m','numeric',$2) returning id`, [id, cd])).id;
  await k.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [versionId, id]);
  for (const s of ["session", "component"]) await k.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,$2)`, [id, s]);
  return { id, versionId };
}

// A test field of gpexe / rest_v1 with revision 1 through the lifecycle's database path.
async function field(kind = "none") {
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Test field',$2) returning id`,
    [`v42.test.f${uid()}`, W.pa.id])).id;
  const shape = kind === "zone_bounds" ? "zone_distance" : kind === "event_threshold" ? "event_count" : "number";
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: shape, parameterKind: kind, evidenceRef: COMPAT });
  return { fieldId, revId };
}
const seeded = async (c, sourceKey) => {
  const row = await one(c, `select d.id as "fieldId", r.id as "revId" from training_load.source_metric_definitions d
                              join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id
                             where d.source_system = 'gpexe' and d.api_family = 'rest_v1' and d.source_metric_key = $1 and r.revision_number = 1`, [sourceKey]);
  assert.ok(row, sourceKey);
  return row;
};

// One transaction with the acting user set as the services set it.
async function tx(actor, fn, client = k) {
  await client.query("begin");
  try {
    if (actor) await client.query(CTX, [actor]);
    const value = await fn(client);
    await client.query("commit");
    return { ok: true, value };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    return { ok: false, error };
  }
}
function refusedWith(res, code, pattern) {
  assert.equal(res.ok, false, `expected a refusal (${pattern})`);
  assert.equal(res.error.code, code, res.error.message);
  if (pattern) assert.match(res.error.message, pattern);
}
const meaningRaw = (c, { revId, by, operator }) => c.query(
  `update training_load.source_metric_definition_versions
      set bound_operator = $2, meaning_verified_by_user_id = $3, meaning_verified_at = now(), meaning_evidence_ref = $4
    where id = $1`, [revId, operator, by, MEANING_REF]);

async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    tables: await rows(c, `select table_schema, table_name from information_schema.tables where table_schema in ${S} order by 1, 2`),
    columns: await rows(c, `select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ${S} order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, c.contype, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    indexes: await rows(c, `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ${S} order by 1, 2, 3`),
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest, obj_description(p.oid, 'pg_proc') as comment from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
// The catalog and the content of the source fields and their revisions.
async function snapshot(c) {
  return {
    catalog: await catalog(c),
    fields: await rows(c, `select * from training_load.source_metric_definitions order by id`),
    revisions: await rows(c, `select * from training_load.source_metric_definition_versions order by id`),
    audit: (await one(c, `select count(*)::int as n from training_load.source_metric_audit`)).n,
  };
}
// The numbered read-only blocks of a preflight or post-check script, each run on its own.
async function blocks(c, file) {
  const text = await fsp.readFile(file, "utf8");
  const out = {};
  for (const part of text.split(/^(?=-- \d+\. )/m).slice(1)) out[Number(part.match(/^-- (\d+)\./)[1])] = (await c.query(part)).rows;
  return out;
}
// A script run on `c` after `plant` wrote, all of it inside one transaction
// that is rolled back: what the script refused with (or null).
async function inRolledBack(c, plant, sqlFile) {
  const sql = await fsp.readFile(sqlFile, "utf8");
  await c.query("begin");
  let error = null;
  try {
    if (plant) await plant(c);
    await c.query(sql);
  } catch (e) {
    error = e;
  }
  await c.query("rollback").catch(() => {});
  return error;
}
// A platform admin written inside the rehearsal's own transaction.
async function rehearsalAdmin(c) {
  const id = (await one(c, `insert into public.users (email, full_name, display_name, is_active) values ($1,'rb admin','rb admin',true) returning id`, [`rb-${uid()}@test.local`])).id;
  await c.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  return id;
}
const withTriggersOff = async (c, table, fn) => {
  await c.query(`alter table training_load.${table} disable trigger user`);
  await fn();
  await c.query(`alter table training_load.${table} enable trigger user`);
};

async function world() {
  W.clubA = await club("Club A");
  W.pa = await platformAdmin();
  W.paA = await platformAdmin(["club", W.clubA]);
  W.caA = await clubAdmin(W.clubA);
  W.power = await seeded(k, POWER);
  W.speed = await seeded(k, SPEED);
  W.openTop = await seeded(k, OPEN_TOP);
}

// ---------------------------------------------------------------------------
// The rehearsal database (through v41).
// ---------------------------------------------------------------------------
test("1. on v41: every expected value of the read-only preflight; the rollback refuses without v42; v42 fails closed (23514, its fixed message, nothing written) when the open top zone field already exists or a zone revision carries a meaning proof or an operator", async () => {
  const pre = await blocks(r, PREFLIGHT);
  assert.deepEqual(Object.keys(pre).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(pre[1][0].pg15_or_later, true);
  assert.deepEqual(pre[2][0], { v41_rows: "1", v41_checksum_ok: true, v42_rows: "0", at_or_after_v42: "0", last_migration: V41_NAME });
  assert.deepEqual(pre[3][0], { seed_window_is_v34: true, actor_guard_is_v39: true, seed_window_comment: null, actor_guard_comment: null });
  assert.deepEqual(pre[4][0], { fields: "9", v34_fields: "9", open_top_rows: "0" });
  assert.deepEqual(pre[5][0], { zone_revisions: "2", zones_with_meaning_or_operator: "0" });
  assert.deepEqual(pre[6][0], { owns_fields: true, owns_revisions: true, owns_functions: true, disabled_triggers: "0" });
  assert.deepEqual(Object.keys(pre[7][0]), ["mappings", "mapping_versions", "activations", "provenance_rows", "audit_rows"]);
  assert.deepEqual(pre[8][0], { actor_defaults: "0" });
  assert.deepEqual(pre[9][0], { conflicting_locks: "0", idle_in_transaction: "0" });

  const before = await snapshot(r);
  assert.match((await inRolledBack(r, null, ROLLBACK))?.message ?? "", /^v42 rollback refused: v42 is not recorded on this database$/);
  // The open top zone field already exists.
  const exists = await inRolledBack(r, async (c) => {
    const by = await rehearsalAdmin(c);
    await c.query(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Planted',$2)`, [OPEN_TOP, by]);
  }, V42_FILE);
  assert.deepEqual([exists?.code, exists?.message], ["23514", "source metric zone model: the open top zone field already exists"]);
  // A zone revision already carries a meaning proof and an operator.
  const proven = await inRolledBack(r, async (c) => {
    const by = await rehearsalAdmin(c);
    const power = await seeded(c, POWER);
    await withTriggersOff(c, "source_metric_definition_versions", () => c.query(
      `update training_load.source_metric_definition_versions set bound_operator = 'between', meaning_verified_by_user_id = $2, meaning_verified_at = now(), meaning_evidence_ref = $3 where id = $1`,
      [power.revId, by, MEANING_REF]));
  }, V42_FILE);
  assert.deepEqual([proven?.code, proven?.message], ["23514", "source metric zone model: a zone revision already carries a meaning proof or an operator"]);
  assert.deepEqual(await snapshot(r), before, "nothing of either attempt is left");
  W.before41 = before;
});

test("2. v42 through the runner on v41: the two function bodies change (v39's actor guard in its zone branch only, v34's seed window to v42's marker) and nothing else of the catalog; the seed is exactly the open top zone field and its revision 1 (observed, active, no proof, no actor, no audit row); every expected value of the post-check; after the COMMIT the seed window refuses every marker, v42's included", async () => {
  await migrate(rdb.url, [...UP_TO_V41, V42]);
  const after = await catalog(r);
  const before = W.before41.catalog;
  assert.deepEqual({ ...after, functions: undefined, migrations: undefined }, { ...before, functions: undefined, migrations: undefined }, "no table, column, constraint, index or trigger changed");
  const changed = after.functions.filter((x) => {
    const old = before.functions.find((y) => y.proname === x.proname && y.args === x.args);
    return !old || old.digest !== x.digest || old.comment !== x.comment;
  }).map((x) => x.proname).sort();
  assert.deepEqual(changed, ["source_metric_require_seed_window", "source_metric_revisions_actor_guard"]);
  assert.equal(after.functions.length, before.functions.length, "no function added or dropped");
  assert.deepEqual(after.migrations, [...before.migrations, V42_NAME].sort());
  // The guard is v39's but for the zone branch.
  const src = async (name) => (await one(r, `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = $1`, [name])).prosrc;
  const v39File = await fsp.readFile(path.resolve(ROOT, "migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql"), "utf8");
  const bodyOf = (text, fn) => { const i = text.indexOf(`function training_load.${fn}(`); const a = text.indexOf("$$", i) + 2; return text.slice(a, text.indexOf("$$ language plpgsql", a)); };
  const v39Guard = bodyOf(v39File, "source_metric_revisions_actor_guard");
  const v42Guard = await src("source_metric_revisions_actor_guard");
  const zoneOld = "  if meaning_act and new.parameter_kind = 'zone_bounds' then\n    raise exception 'source_metric_definition_versions: the verification model of a zone is unresolved' using errcode = '23514';\n  end if;\n";
  assert.ok(v39Guard.includes(zoneOld));
  const zoneNew = "  -- v42 (Z3): a zone's meaning act confirms the operator of its shape -\n  -- between for the closed zones, >= for the open top zone.\n  if meaning_act and new.parameter_kind = 'zone_bounds'\n     and (new.bound_operator is null or new.bound_operator not in ('between', '>=')) then\n    raise exception 'source_metric_definition_versions: a zone takes the operator between or >=' using errcode = '23514';\n  end if;\n";
  assert.equal(v42Guard, v39Guard.replace(zoneOld, zoneNew), "every other branch is v39's, byte for byte");
  // The seed.
  const f = await one(r, `select * from training_load.source_metric_definitions where source_metric_key = $1`, [OPEN_TOP]);
  assert.deepEqual([f.source_system, f.api_family, f.source_label, f.state, f.retired_by_user_id, f.retired_at, f.retired_reason, f.created_by_user_id, f.seed_migration],
    ["gpexe", "rest_v1", "Power zone distance (open top zone)", "active", null, null, null, null, V42_NAME]);
  const revs = await rows(r, `select * from training_load.source_metric_definition_versions where source_metric_definition_id = $1`, [f.id]);
  assert.equal(revs.length, 1);
  const rev = revs[0];
  assert.deepEqual([rev.revision_number, rev.value_shape, rev.parameter_kind, rev.supports_session, rev.supports_drill, rev.expected_source_unit, rev.expected_source_bound_unit, rev.unit_note,
    rev.source_unit, rev.source_bound_unit, rev.bound_operator, rev.unit_verified_at, rev.meaning_verified_at, rev.evidence_status, rev.evidence_ref, rev.state, rev.activated_by_user_id, rev.created_by_user_id, rev.seed_migration],
  [1, "zone_distance", "zone_bounds", true, true, "m", "W/kg", UNIT_NOTE, null, null, null, null, null, "observed", COMPAT, "active", null, null, V42_NAME]);
  assert.ok(rev.activated_at instanceof Date);
  assert.equal((await one(r, `select count(*)::int as n from training_load.source_metric_audit where source_metric_definition_id = $1`, [f.id])).n, 0, "a seed writes no audit row");
  assert.equal((await one(r, `select count(*)::int as n from training_load.source_metric_definitions`)).n, 10);
  // The post-check.
  const post = await blocks(r, POSTCHECK);
  assert.deepEqual(Object.keys(post).map(Number), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(post[1][0], { v42_rows: "1", v42_checksum_ok: true, later_rows: "0", last_migration: V42_NAME, v41_rows: "1" });
  assert.deepEqual(post[2][0], { seed_window_is_v42: true, actor_guard_is_v42: true, zone_rule: true, comments_name_v42: true });
  assert.deepEqual(post[3][0], { names_only_v42: true, v42_recorded: true });
  assert.deepEqual(post[4][0], { fields: "10", v34_fields: "9", open_top_seed: "1", open_top_revisions: "1", zones_with_meaning_or_operator: "0" });
  assert.deepEqual(post[5][0], { disabled_triggers: "0" });
  assert.deepEqual(post[6][0], { open_top_audit_rows: "0" });
  assert.deepEqual(post[7][0], { actor_defaults: "0", conflicting_locks: "0" });
  // The seed window is closed.
  for (const marker of [V42_NAME, V34_NAME, "migrations_v2/209912312359_training_load_v99_test_only.sql", null]) {
    refusedWith(await tx(null, (c) => c.query(`select training_load.source_metric_require_seed_window($1)`, [marker]), r), "42501", SEED_WINDOW);
  }
  W.after42 = await snapshot(r);
});

test("3. the rollback refuses, changing nothing, under a later migration, once a zone revision carries a meaning proof or an operator, while the open top zone field is not exactly its seed (its label, a second revision, an audit row naming it) and while a trigger of the two tables is disabled when it starts", async () => {
  const refuses = async (plant, pattern) => {
    const error = await inRolledBack(r, plant, ROLLBACK);
    assert.match(error?.message ?? "", pattern);
    assert.deepEqual(await snapshot(r), W.after42, `nothing changed (${pattern})`);
  };
  await refuses((c) => c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', $1, 'test')`, ["0".repeat(64)]),
    /^v42 rollback refused: later migrations are applied$/);
  await refuses(async (c) => {
    const by = await rehearsalAdmin(c);
    const power = await seeded(c, POWER);
    await withTriggersOff(c, "source_metric_definition_versions", () => c.query(
      `update training_load.source_metric_definition_versions set bound_operator = 'between', meaning_verified_by_user_id = $2, meaning_verified_at = now(), meaning_evidence_ref = $3 where id = $1`,
      [power.revId, by, MEANING_REF]));
  }, /^v42 rollback refused: a zone revision carries a meaning proof or an operator$/);
  await refuses((c) => withTriggersOff(c, "source_metric_definitions", () => c.query(`update training_load.source_metric_definitions set source_label = 'Changed' where source_metric_key = $1`, [OPEN_TOP])),
    /^v42 rollback refused: the open top zone field is not its seed$/);
  await refuses(async (c) => {
    const by = await rehearsalAdmin(c);
    const top = await seeded(c, OPEN_TOP);
    await withTriggersOff(c, "source_metric_definition_versions", () => c.query(
      `insert into training_load.source_metric_definition_versions (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill, evidence_status, created_by_user_id)
       values ($1, 2, 'zone_distance', 'zone_bounds', true, true, 'unproven', $2)`, [top.fieldId, by]));
  }, /^v42 rollback refused: the open top zone revision is not its seed$/);
  await refuses(async (c) => {
    const by = await rehearsalAdmin(c);
    const top = await seeded(c, OPEN_TOP);
    await withTriggersOff(c, "source_metric_audit", () => c.query(
      `insert into training_load.source_metric_audit (action, source_metric_definition_id, source_metric_version_id, to_status, performed_by_user_id, basis, operation_id)
       values ('source_metric_revision_create', $1, $2, 'draft', $3, 'platform_admin', $4)`, [top.fieldId, top.revId, by, crypto.randomUUID()]));
  }, /^v42 rollback refused: a mapping, an activation, a value or an audit row names the open top zone field$/);
  await refuses((c) => c.query(`alter table training_load.source_metric_definition_versions disable trigger source_metric_revisions_no_truncate`),
    /^v42 rollback refused: a trigger of the two tables is disabled$/);
});

test("4. the rollback returns v41's catalog (both function bodies and their comments) and the content of the source fields and their revisions exactly; v42 then applies again to the same catalog and the same seed", async () => {
  const error = await inRolledBack(r, null, ROLLBACK);
  // inRolledBack's final rollback is a no-op after the script's own COMMIT.
  assert.equal(error, null, error?.message);
  assert.deepEqual(await snapshot(r), W.before41, "v41's catalog and data again");
  await migrate(rdb.url, [...UP_TO_V41, V42]);
  const again = await snapshot(r);
  assert.deepEqual(again.catalog, W.after42.catalog, "the same catalog");
  const seedOf = (snap) => ({
    fields: snap.fields.filter((x) => x.seed_migration === V42_NAME).map(({ id, created_at, ...rest }) => rest),
    revisions: snap.revisions.filter((x) => x.seed_migration === V42_NAME).map(({ id, source_metric_definition_id, created_at, activated_at, ...rest }) => rest),
  });
  assert.deepEqual(seedOf(again), seedOf(W.after42), "the same seed");
  assert.deepEqual(again.revisions.filter((x) => x.seed_migration === V34_NAME), W.after42.revisions.filter((x) => x.seed_migration === V34_NAME), "v34's seeds untouched");
});

// ---------------------------------------------------------------------------
// The behaviour database (through v42).
// ---------------------------------------------------------------------------
test("5. the database rule: a zone's meaning act with between or >= is saved with the acting platform admin; >, <=, < and no operator are 23514; an event threshold still takes a one-sided operator only, a plain field none; without an acting user or by a club admin it is 42501; the seed path stays closed", async () => {
  for (const operator of ["between", ">="]) {
    const z = await field("zone_bounds");
    okTx(await tx(W.pa.id, async (c) => {
      await meaningRaw(c, { revId: z.revId, by: W.pa.id, operator });
      await c.query(`insert into training_load.source_metric_audit (action, source_metric_definition_id, source_metric_version_id, evidence_ref, performed_by_user_id, basis, operation_id)
                     values ('source_metric_meaning_verified', $1, $2, $3, $4, 'platform_admin', $5)`, [z.fieldId, z.revId, MEANING_REF, W.pa.id, crypto.randomUUID()]);
    }));
    const row = await one(k, `select bound_operator, meaning_verified_by_user_id from training_load.source_metric_definition_versions where id = $1`, [z.revId]);
    assert.deepEqual([row.bound_operator, row.meaning_verified_by_user_id], [operator, W.pa.id]);
  }
  const zone = await field("zone_bounds");
  for (const operator of [">", "<=", "<", null]) refusedWith(await tx(W.pa.id, (c) => meaningRaw(c, { revId: zone.revId, by: W.pa.id, operator })), "23514", ZONE);
  refusedWith(await tx(null, (c) => meaningRaw(c, { revId: zone.revId, by: W.pa.id, operator: "between" })), "42501", NO_ACTOR);
  refusedWith(await tx(W.caA.id, (c) => meaningRaw(c, { revId: zone.revId, by: W.caA.id, operator: "between" })), "42501", NOT_ADMIN);
  const ev = await field("event_threshold");
  refusedWith(await tx(W.pa.id, (c) => meaningRaw(c, { revId: ev.revId, by: W.pa.id, operator: "between" })), "23514", EVENT_OP);
  const evProven = await writeRevision(k, { fieldId: (await field("event_threshold")).fieldId, by: W.pa.id, revisionNumber: 2, valueShape: "event_count", parameterKind: "event_threshold", evidenceRef: COMPAT, meaning: true, operator: ">=", meaningRef: MEANING_REF, state: "draft" });
  assert.equal((await one(k, `select bound_operator from training_load.source_metric_definition_versions where id = $1`, [evProven])).bound_operator, ">=");
  const plainProven = await writeRevision(k, { fieldId: (await field()).fieldId, by: W.pa.id, revisionNumber: 2, evidenceRef: COMPAT, meaning: true, meaningRef: MEANING_REF, state: "draft" });
  assert.equal((await one(k, `select bound_operator from training_load.source_metric_definition_versions where id = $1`, [plainProven])).bound_operator, null);
  // The seed path is closed for every marker.
  for (const marker of [V42_NAME, V34_NAME]) {
    refusedWith(await tx(null, (c) => c.query(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, seed_migration) values ('gpexe','rest_v1',$1,'Seed',$2)`, [`v42.seed.${uid()}`, marker])), "42501", SEED_WINDOW);
  }
  assert.equal((await one(k, `select count(*)::int as n from training_load.source_metric_definition_versions where parameter_kind = 'zone_bounds' and seed_migration is not null and (meaning_verified_at is not null or bound_operator is not null)`)).n, 0, "no seeded zone was touched");
});
const okTx = (res) => { assert.equal(res.ok, true, res.error ? `${res.error.code}: ${res.error.message}` : ""); return res.value; };

test("6. F3 through the real route on the seeded zone fields: the power field (closed zones) takes between, the open top zone and the speed field take >=; without an operator 400 operator_required, >, <=, < and any other value 400 invalid_operator, each with the zone's text and nothing written; the status is verified after both acts with one audit row per act; a replay answers the same, the same key with another body is request_key_reused; a club admin and a platform admin in a club workspace get the identical 404", async () => {
  const unit = (f, boundUnit) => post(unitPath(f), W.pa.cookie, { requestKey: key(), sourceUnit: "m", sourceBoundUnit: boundUnit, evidenceRef: UNIT_REF });
  const meaning = (f, extra = {}, who = W.pa) => post(meaningPath(f), who.cookie, { requestKey: key(), evidenceRef: MEANING_REF, ...extra });
  const u = await unit(W.power, "W/kg");
  assert.deepEqual([u.status, u.body.revision?.evidenceStatus], [201, "observed"], u.text);
  for (const [extra, code] of [[{}, "operator_required"], [{ boundOperator: ">" }, "invalid_operator"], [{ boundOperator: "<=" }, "invalid_operator"], [{ boundOperator: "<" }, "invalid_operator"], [{ boundOperator: "==" }, "invalid_operator"]]) {
    const res = await meaning(W.power, extra);
    assert.deepEqual([res.status, res.body.error], [400, code], res.text);
    assert.equal(res.body.message, code === "operator_required"
      ? "This revision is a zone: boundOperator (between or >=) is confirmed together with the meaning."
      : "A zone is either a closed zone (between) or the open top zone (>=).", "the zone's own text (J7 section 4)");
  }
  assert.equal((await one(k, `select meaning_verified_at from training_load.source_metric_definition_versions where id = $1`, [W.power.revId])).meaning_verified_at, null, "nothing written");
  for (const who of [W.caA, W.paA]) {
    const res = await meaning(W.power, { boundOperator: "between" }, who);
    assert.deepEqual([res.status, res.body], [404, { error: "notFound" }]);
  }
  const body = { requestKey: key(), evidenceRef: MEANING_REF, boundOperator: "between" };
  const m = await post(meaningPath(W.power), W.pa.cookie, body);
  assert.deepEqual([m.status, m.body.revision?.boundOperator, m.body.revision?.evidenceStatus], [201, "between", "verified"], m.text);
  const replay = await post(meaningPath(W.power), W.pa.cookie, body);
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.revision?.boundOperator], [200, true, "between"]);
  const reused = await post(meaningPath(W.power), W.pa.cookie, { ...body, boundOperator: ">=" });
  assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"]);
  assert.deepEqual((await rows(k, `select action from training_load.source_metric_audit where source_metric_version_id = $1 order by performed_at`, [W.power.revId])).map((x) => x.action),
    ["source_metric_unit_verified", "source_metric_meaning_verified"], "one audit row per act");
  for (const [f, boundUnit] of [[W.openTop, "W/kg"], [W.speed, "m/s"]]) {
    assert.equal((await unit(f, boundUnit)).status, 201);
    const res = await meaning(f, { boundOperator: ">=" });
    assert.deepEqual([res.status, res.body.revision?.boundOperator, res.body.revision?.evidenceStatus], [201, ">=", "verified"], res.text);
  }
});

test("7. end to end through M2: with both proofs, a version of a closed zone (25-60 W/kg) on the power field and of the open zone (>= 75 W/kg) on the open top zone field are created; a version that asks for the other operator is 409 parameters_not_equivalent, and forced past the route T4 refuses it (23514)", async () => {
  const closed = await canonical({ operator: "between", min: 25, max: 60, unit: "W/kg" });
  const open = await canonical({ operator: ">=", value: 75, unit: "W/kg" });
  const mapping = async (f, target) => {
    const res = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id });
    assert.equal(res.status, 201, res.text);
    return res.body.mapping.id;
  };
  const version = (mappingId, f, sourceParameters) => post(`/mappings/${mappingId}/versions`, W.pa.cookie, { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true, sourceParameters });
  const a = await version(await mapping(W.power, closed), W.power, { lower: "25", upper: "60" });
  assert.equal(a.status, 201, a.text);
  const b = await version(await mapping(W.openTop, open), W.openTop, { lower: "75", upper: null });
  assert.equal(b.status, 201, b.text);
  const crossPower = await mapping(W.power, open);
  const c1 = await version(crossPower, W.power, { lower: "75", upper: "100" });
  assert.deepEqual([c1.status, c1.body.error], [409, "parameters_not_equivalent"], c1.text);
  const c2 = await version(await mapping(W.openTop, closed), W.openTop, { lower: "25", upper: null });
  assert.deepEqual([c2.status, c2.body.error], [409, "parameters_not_equivalent"], c2.text);
  // Forced: T4's own parameter check refuses the other operator.
  const forced = await tx(W.pa.id, (c) => c.query(
    `insert into training_load.source_metric_mapping_versions
       (mapping_id, source_metric_definition_id, metric_definition_id, source_metric_version_id, version_number, metric_definition_version_id,
        conversion_kind, scale, scale_divisor, "offset", source_unit, target_unit, parameter_kind, source_parameters, canonical_parameters,
        parameter_scale, parameter_scale_divisor, parameter_offset, applies_to_session, applies_to_drill, created_by_user_id)
     values ($1, $2, $3, $4, 1, $5, 'numeric_linear', 1, 1, 0, 'm', 'm', 'zone_bounds', $6::jsonb, $7::jsonb, 1, 1, 0, true, true, $8)`,
    [crossPower, W.power.fieldId, open.id, W.power.revId, open.versionId,
      JSON.stringify({ operator: "between", lower: 75, upper: 100, unit: "W/kg" }), JSON.stringify({ operator: ">=", lower: 75, upper: null, unit: "W/kg" }), W.pa.id]));
  assert.equal(forced.ok, false);
  assert.equal(forced.error.code, "23514", forced.error.message);
  assert.match(forced.error.message, /^source_metric_mapping_versions: /);
});

test("8. a v42 database reads back the same after pg_dump and pg_restore: both function bodies and comments, every trigger of the two tables, and the seeds", async () => {
  const target = await createDisposableDatabase({ prefix: "gpexe", label: "v42rt", baseDatabaseUrl: ORIGINAL_DATABASE_URL });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v42-roundtrip-"));
  const restored = new pg.Client({ connectionString: target.url });
  try {
    assert.match(target.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
    const u = new URL(db.url);
    const conn = ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username)];
    const env = { PATH: process.env.PATH, PGPASSWORD: decodeURIComponent(u.password) };
    const file = path.join(dir, "v42.dump");
    execFileSync("pg_dump", [...conn, "-d", db.name, "-Fc", "-f", file], { env, stdio: "pipe" });
    execFileSync("pg_restore", [...conn, "--no-owner", "--no-privileges", "-d", target.name, file], { env, stdio: "pipe" });
    await restored.connect();
    const objects = async (c) => ({
      functions: await rows(c, `select p.proname, md5(pg_get_functiondef(p.oid)) as digest, obj_description(p.oid, 'pg_proc') as comment from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'training_load' and p.proname in ('source_metric_require_seed_window', 'source_metric_revisions_actor_guard') order by 1`),
      triggers: await rows(c, `select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'training_load' and not t.tgisinternal and c.relname in ('source_metric_definitions', 'source_metric_definition_versions') order by 1, 2`),
      seeds: await rows(c, `select d.source_metric_key, r.* from training_load.source_metric_definitions d join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id
        where d.seed_migration is not null order by d.source_metric_key, r.revision_number`),
    });
    const source = await objects(k);
    assert.equal(source.functions.length, 2);
    assert.ok(source.functions.every((x) => /^v42 /.test(x.comment)));
    assert.ok(source.seeds.some((x) => x.source_metric_key === OPEN_TOP));
    assert.deepEqual(await objects(restored), source);
  } finally {
    await restored.end().catch(() => {});
    await target.drop();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

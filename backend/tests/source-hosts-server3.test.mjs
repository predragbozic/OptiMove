// Host profiles (backend/src/sourceHosts.js) and migration v28 (one approved
// catalog row, gpexe / server3). The profile tests touch no network and no
// database; the migration tests run on disposable optimove_tests_gpexe_*
// databases only. No credential exists anywhere in this file: every
// "secret" below is a marker made up for the test. Test 12 is a tripwire
// over the files of this change, not a guarantee: the proof that the legacy
// credential file never entered Git is the scan of every commit's tree.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import {
  API_FAMILIES, EXCHANGE_ENCODINGS, SOURCE_DOMAINS, SOURCE_HOSTS, isAllowedHostKey, resolvableHostKeys, resolveApprovedSourceHost,
  sourceApiUrl as gatedApiUrl, sourceExchange as gatedExchange, sourceHost,
} from "../src/sourceHosts.js";
import { GPEXE_API_BASE } from "../src/gpexeClient.js";

// The approved catalog row a caller reads from the database for a key.
const row = (hostKey, state = "approved") => ({ source_system: "gpexe", host_key: hostKey, state });
// Shorthand for the profile tests: the key's own approved row.
const sourceApiUrl = (source, hostKey, resourcePath) => gatedApiUrl(source, hostKey, row(hostKey), resourcePath);
const sourceExchange = (source, hostKey) => gatedExchange(source, hostKey, row(hostKey));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V27 = "202609271000_training_load_v27_source_credential_connections.sql";
const V28 = "202609291000_training_load_v28_source_host_server3.sql";
const UP_TO_V27 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V27) + 1);
const V28_ROLLBACK = path.resolve(ROOT, "docs/runbooks/source-hosts-v28-rollback.sql");
const V27_ROLLBACK = path.resolve(ROOT, "docs/runbooks/source-connections-v27-rollback.sql");
const code = (c) => (e) => e.code === c;

// ---------------------------------------------------------------------------
// 1. Profiles
// ---------------------------------------------------------------------------
test("1. the server3 profile is exactly the confirmed one: host, family, scheme, exchange path, encoding and token field", () => {
  assert.deepEqual(resolvableHostKeys("gpexe"), ["e03", "server3"]);
  const s3 = sourceHost("gpexe", "server3");
  assert.deepEqual(JSON.parse(JSON.stringify(s3)), {
    baseUrl: "https://server3.gpexe.com/", label: "GPEXE server3", apiFamily: "rest_v1", authScheme: "Token",
    exchange: { path: "api-token-auth/", encoding: "form", tokenField: "token" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(sourceExchange("gpexe", "server3"))), {
    url: "https://server3.gpexe.com/api-token-auth/", encoding: "form", tokenField: "token", authScheme: "Token",
  });
  assert.deepEqual({ ...API_FAMILIES }, { api: "api/", rest_v1: "rest/v1/" });
  assert.deepEqual([...EXCHANGE_ENCODINGS], ["form", "json"]);
});

test("2. the e03 profile stays separate and unchanged: same host and label, the api family, and no exchange (none was ever confirmed there)", () => {
  const e03 = sourceHost("gpexe", "e03");
  assert.equal(e03.baseUrl, "https://e03.gpexe.com/");
  assert.equal(e03.label, "GPEXE e03");
  assert.equal(e03.apiFamily, "api");
  assert.equal(e03.authScheme, "Token");
  assert.equal(e03.exchange, null);
  assert.throws(() => sourceExchange("gpexe", "e03"), code("exchange_not_supported"), "e03 never borrows server3's exchange");
  assert.equal(sourceApiUrl("gpexe", "e03", "team/980/"), "https://e03.gpexe.com/api/team/980/");
  // The importer's own constant (a second, older source of truth) names the same root.
  assert.equal(sourceApiUrl("gpexe", "e03", "x/"), `${GPEXE_API_BASE}x/`);
  assert.deepEqual({ ...SOURCE_DOMAINS }, { gpexe: ".gpexe.com" });
  assert.notEqual(e03.baseUrl, sourceHost("gpexe", "server3").baseUrl);
});

test("3. server3 builds /rest/v1/ paths only, e03 builds /api/ paths only, and the same resource path never crosses over", () => {
  const resources = ["team/", "team/980/", "team_session/?team=980&limit=1", "team_session/186942/details/", "athlete_session/?teamsession=1&limit=100"];
  for (const r of resources) {
    const s3 = new URL(sourceApiUrl("gpexe", "server3", r));
    const e03 = new URL(sourceApiUrl("gpexe", "e03", r));
    assert.equal(s3.origin, "https://server3.gpexe.com");
    assert.ok(s3.pathname.startsWith("/rest/v1/"), s3.href);
    assert.ok(!s3.pathname.startsWith("/api/"));
    assert.equal(e03.origin, "https://e03.gpexe.com");
    assert.ok(e03.pathname.startsWith("/api/"), e03.href);
    assert.ok(!e03.pathname.includes("/rest/"));
  }
  assert.equal(sourceApiUrl("gpexe", "server3", "team_session/?team=980&limit=1"), "https://server3.gpexe.com/rest/v1/team_session/?team=980&limit=1");
});

test("4. a resource path can never leave its host or its family: absolute, protocol-relative, dotted, encoded, schemed and family-named paths are refused", () => {
  const bad = [
    "/team/", "//evil.example/team/", "https://evil.example/team/", "../api/team/", "team/../../api/team/", "./team/",
    "team", "", " team/", "team/ ", "Team/", "team\\x/", "team/%2e%2e/", "team/?a=b#frag", "team/?next=https://evil.example/",
    "@evil.example/team/", "team/;x/", "team/?a", "team//x/", "javascript:alert/", null, undefined, 5, {}, ["team/"], "a".repeat(600) + "/",
  ];
  for (const b of bad) {
    for (const key of ["server3", "e03"]) assert.throws(() => sourceApiUrl("gpexe", key, b), code("path_not_allowed"), `${key} ${JSON.stringify(b)}`);
  }
  // Naming the other family inside a path does not reach it: the prefix is always the host's own.
  assert.equal(sourceApiUrl("gpexe", "e03", "rest/v1/team/"), "https://e03.gpexe.com/api/rest/v1/team/");
  assert.equal(sourceApiUrl("gpexe", "server3", "api/team/"), "https://server3.gpexe.com/rest/v1/api/team/");
});

test("5. an arbitrary host is refused everywhere: URLs, other shards, case variants, prototype names, other sources", () => {
  const bad = ["server4", "server30", "server", "e04", "SERVER3", "Server3", "server3 ", " server3", "server3.gpexe.com", "https://server3.gpexe.com/", "https://server3.gpexe.com", "//server3.gpexe.com/", "", "__proto__", "constructor", "hasOwnProperty", "toString", null, undefined, 3, {}, ["server3"]];
  for (const b of bad) {
    assert.throws(() => sourceHost("gpexe", b), code("host_not_allowed"), JSON.stringify(b));
    assert.throws(() => sourceApiUrl("gpexe", b, "team/"), code("host_not_allowed"), JSON.stringify(b));
    assert.throws(() => sourceExchange("gpexe", b), code("host_not_allowed"), JSON.stringify(b));
    assert.equal(isAllowedHostKey("gpexe", b), false);
  }
  for (const source of ["catapult", "GPEXE", "", "__proto__", null]) {
    assert.throws(() => sourceHost(source, "server3"), code("host_not_allowed"), JSON.stringify(source));
    assert.deepEqual(resolvableHostKeys(source), []);
  }
});

test("6. no profile ever answers for another: a refused or unknown key is an error, never the other host, and the catalog cannot be changed at run time", () => {
  // A retired or missing catalog row for server3 never resolves to e03.
  const approved = { source_system: "gpexe", host_key: "server3", state: "approved" };
  assert.equal(resolveApprovedSourceHost("gpexe", "server3", approved).baseUrl, "https://server3.gpexe.com/");
  for (const row of [null, undefined, { ...approved, state: "retired" }, { ...approved, host_key: "e03" }, { ...approved, source_system: "catapult" }, { source_system: "gpexe", host_key: "e03", state: "approved" }]) {
    assert.throws(() => resolveApprovedSourceHost("gpexe", "server3", row), code("host_not_allowed"));
  }
  // The e03 row never opens server3, and the reverse.
  assert.throws(() => resolveApprovedSourceHost("gpexe", "e03", approved), code("host_not_allowed"));
  // Frozen all the way down.
  for (const o of [SOURCE_HOSTS, SOURCE_HOSTS.gpexe, SOURCE_HOSTS.gpexe.e03, SOURCE_HOSTS.gpexe.server3, SOURCE_HOSTS.gpexe.server3.exchange, API_FAMILIES, EXCHANGE_ENCODINGS]) assert.ok(Object.isFrozen(o));
  assert.throws(() => { "use strict"; SOURCE_HOSTS.gpexe.server3.baseUrl = "https://evil.example/"; }, TypeError);
  assert.throws(() => { "use strict"; SOURCE_HOSTS.gpexe.e03.exchange = SOURCE_HOSTS.gpexe.server3.exchange; }, TypeError);
  assert.equal(sourceHost("gpexe", "server3").baseUrl, "https://server3.gpexe.com/");
});

test("6b. the URL builders are behind the gate themselves: without the key's own APPROVED catalog row there is no data URL and no exchange", () => {
  assert.equal(gatedApiUrl("gpexe", "server3", row("server3"), "team/"), "https://server3.gpexe.com/rest/v1/team/");
  for (const bad of [undefined, null, row("server3", "retired"), row("e03"), { source_system: "catapult", host_key: "server3", state: "approved" }, { host_key: "server3", state: "approved" }, "approved", true]) {
    assert.throws(() => gatedApiUrl("gpexe", "server3", bad, "team/"), code("host_not_allowed"), JSON.stringify(bad));
    assert.throws(() => gatedExchange("gpexe", "server3", bad), code("host_not_allowed"), JSON.stringify(bad));
  }
  // The old two-argument call shape (path in the row's place) yields nothing.
  assert.throws(() => gatedApiUrl("gpexe", "server3", "team/"), code("host_not_allowed"));
  // The builder scopes host and family only: it is NOT the team boundary (the adapter's duty).
  assert.equal(gatedApiUrl("gpexe", "server3", row("server3"), "team/981/"), "https://server3.gpexe.com/rest/v1/team/981/");
});

test("7. the module itself refuses an arbitrary family, encoding, scheme or URL in a profile (import-time validation, proven on a copy)", async () => {
  const source = await fsp.readFile(path.resolve(ROOT, "backend/src/sourceHosts.js"), "utf8");
  const variants = {
    "an unknown API family": source.replace('apiFamily: "rest_v1", authScheme', 'apiFamily: "rest_v2", authScheme'),
    "an unknown encoding": source.replace('encoding: "form"', 'encoding: "multipart"'),
    "a URL with a path": source.replace('"https://server3.gpexe.com/"', '"https://server3.gpexe.com/rest/"'),
    "a plain http URL": source.replace('"https://server3.gpexe.com/"', '"http://server3.gpexe.com/"'),
    "a scheme with a space": source.replace('apiFamily: "rest_v1", authScheme: "Token"', 'apiFamily: "rest_v1", authScheme: "Token x"'),
    "an exchange path with a host": source.replace('path: "api-token-auth/"', 'path: "//evil.example/"'),
    "two keys on one URL": source.replace('"https://server3.gpexe.com/"', '"https://e03.gpexe.com/"'),
    "a host outside the source's domain": source.replace('"https://server3.gpexe.com/"', '"https://evil.example/"'),
    "a look-alike domain": source.replace('"https://server3.gpexe.com/"', '"https://server3.gpexe.com.evil.example/"'),
    "a domain without a host label": source.replace('"https://server3.gpexe.com/"', '"https://.gpexe.com/"'),
    "a token field named like a prototype member": source.replace('tokenField: "token"', 'tokenField: "__proto__"'),
  };
  const dir = await fsp.mkdtemp(path.join((await import("node:os")).tmpdir(), "optimove-hosts-"));
  try {
    let i = 0;
    for (const [what, text] of Object.entries(variants)) {
      assert.notEqual(text, source, `the variant "${what}" changed the source`);
      const file = path.join(dir, `hosts-${i += 1}.mjs`);
      await fsp.writeFile(file, text, "utf8");
      await assert.rejects(import(pathToFileURL(file).href), /sourceHosts:/, what);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Migration v28 and its rollback (disposable databases)
// ---------------------------------------------------------------------------
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
let db;
let k;

async function structure(client) {
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
const catalog = async () => (await k.query(`select source_system, host_key, label, state, note, approved_at from training_load.source_host_catalog order by 1, 2`)).rows;
const recorded = async () => (await k.query(`select migration_name from public.schema_migrations where migration_name like '%v27_%' or migration_name like '%v28_%' or migration_name > $1 order by 1`, [`migrations_v2/${V28}`])).rows.map((r) => r.migration_name);
async function refusedRollback(file, pattern) {
  const error = await k.query(await fsp.readFile(file, "utf8")).then(() => null, (e) => e);
  await k.query("rollback").catch(() => {});
  assert.ok(error, "the rollback must refuse");
  assert.match(error.message, pattern);
}

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v28host", migrations: UP_TO_V27 });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as db")).rows[0].db, db.name);
});
after(async () => {
  await k?.end();
  await db?.drop();
});

test("8. v28 adds exactly one catalog row and changes no structure; it creates no connection, binding or audit row and leaves the e03 row as it was", async () => {
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V28), "the test migration list carries v28 (v29 follows it since F3c2d)");
  const before27 = await structure(k);
  const e03Before = (await catalog()).filter((r) => r.host_key === "e03");
  await applyGpexeTestMigrations(db.url, [...UP_TO_V27, V28]);
  assert.deepEqual(await structure(k), before27, "no table, column, constraint, index, function or trigger changed");
  const rows = await catalog();
  assert.deepEqual(rows.map(({ approved_at, ...r }) => r), [
    { source_system: "gpexe", host_key: "e03", label: "GPEXE e03", state: "approved", note: "The server of the owner's organisation (UI at e03-ui.gpexe.com). Approved for F3c1." },
    { source_system: "gpexe", host_key: "server3", label: "GPEXE server3", state: "approved", note: "API family rest/v1. Confirmed by the owner-run read-only verification of 2026-09-29. Approved for F3c2." },
  ]);
  assert.deepEqual(rows.filter((r) => r.host_key === "e03"), e03Before, "the e03 row is untouched, approved_at included");
  for (const t of ["source_credential_connections", "source_team_bindings", "source_connection_audit"]) {
    assert.equal((await k.query(`select count(*)::int as n from training_load.${t}`)).rows[0].n, 0, t);
  }
  // Every approved catalog key resolves in the code, and the code resolves nothing the catalog does not approve.
  assert.deepEqual(rows.filter((r) => r.state === "approved").map((r) => r.host_key), resolvableHostKeys("gpexe"));
  for (const r of rows) assert.equal(resolveApprovedSourceHost(r.source_system, r.host_key, r).baseUrl, sourceHost("gpexe", r.host_key).baseUrl);
  const sql = await fsp.readFile(path.resolve(ROOT, "migrations_v2", V28), "utf8");
  const body = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(body, /\b(create|alter|drop|update|delete|truncate|grant)\b/i, "data only: one insert");
  assert.equal((body.match(/\binsert into\b/gi) || []).length, 1);
  assert.doesNotMatch(sql, /https?:\/\//i, "no URL in the migration");
});

test("9. the v27 rollback refuses while v28 is recorded, and keeps both catalog rows and both records", async () => {
  const c0 = await catalog();
  const r0 = await recorded();
  await refusedRollback(V27_ROLLBACK, /v27 rollback refused: .*later migrations are applied: migrations_v2\/202609291000_training_load_v28_source_host_server3\.sql/);
  assert.deepEqual(await catalog(), c0);
  assert.deepEqual(await recorded(), r0);
});

test("10. the v28 rollback refuses once the host is used by a connection; nothing changes on the refusal", async () => {
  const s0 = await structure(k);
  const c0 = await catalog();
  const r0 = await recorded();
  const club = (await k.query(`insert into public.clubs (name) values ('v28 club') returning id`)).rows[0].id;
  const user = (await k.query(`insert into public.users (email) values ('v28-admin@test.local') returning id`)).rows[0].id;

  // (a) used by a connection (no credential in it).
  await k.query("begin");
  await k.query(
    `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id)
     values ('gpexe','club',$1,'server3','v28 test','exchanged_token',$2)`, [club, user]);
  await k.query("commit");
  await refusedRollback(V28_ROLLBACK, /v28 rollback refused: 1 connection\(s\) use host key server3/);
  assert.deepEqual(await catalog(), c0, "the catalog row is kept");
  assert.deepEqual(await recorded(), r0, "the v28 record is kept");
  assert.deepEqual(await structure(k), s0, "the guard trigger is still enabled");
  assert.equal((await k.query(`select count(*)::int as n from training_load.source_credential_connections where host_key = 'server3'`)).rows[0].n, 1);
});

test("11. the v28 rollback also refuses a changed row, a later migration and a connection insert in flight (bounded wait); on an unused host it removes the one row and the v28 record, leaves e03 and the structure alone, and v28 applies again", async () => {
  const fresh = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v28rb", migrations: [...UP_TO_V27, V28] });
  const c = new pg.Client({ connectionString: fresh.url });
  await c.connect();
  const saved = k;
  k = c;
  try {
    assert.equal((await c.query("select current_database() as db")).rows[0].db, fresh.name);
    const s0 = await structure(c);
    const e03 = (await catalog()).filter((r) => r.host_key === "e03");

    // (b) a changed row is a use of its own.
    await c.query(`update training_load.source_host_catalog set state = 'retired' where host_key = 'server3'`);
    await refusedRollback(V28_ROLLBACK, /v28 rollback refused: the server3 catalog row is missing or is not what v28 inserted/);
    await c.query(`update training_load.source_host_catalog set state = 'approved' where host_key = 'server3'`);
    // (c) a later migration.
    await c.query("begin");
    await c.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ('migrations_v2/209901010000_test_only_later.sql', repeat('0', 64), 0, 'test')`);
    await refusedRollback(V28_ROLLBACK, /v28 rollback refused: later migrations are applied: migrations_v2\/209901010000_test_only_later\.sql/);
    assert.equal((await catalog()).length, 2);

    await c.query("rollback");

    // (d) a connection insert IN FLIGHT (not committed, so the count cannot see it) holds the
    // catalog row: the rollback waits at most its lock timeout and fails; nothing is removed.
    const club = (await c.query(`insert into public.clubs (name) values ('v28 race club') returning id`)).rows[0].id;
    const user = (await c.query(`insert into public.users (email) values ('v28-race@test.local') returning id`)).rows[0].id;
    const other = new pg.Client({ connectionString: fresh.url });
    await other.connect();
    try {
      await other.query("begin");
      await other.query(
        `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id)
         values ('gpexe','club',$1,'server3','in flight','exchanged_token',$2)`, [club, user]);
      const started = Date.now();
      await refusedRollback(V28_ROLLBACK, /lock timeout|could not obtain lock/i);
      assert.ok(Date.now() - started < 15000, "the wait is bounded");
      assert.equal((await catalog()).length, 2, "the row is kept");
      assert.deepEqual(await structure(c), s0, "the guard trigger is enabled");
      await other.query("rollback");
    } finally {
      await other.end();
    }
    assert.equal((await c.query(`select count(*)::int as n from training_load.source_credential_connections`)).rows[0].n, 0);

    await c.query(await fsp.readFile(V28_ROLLBACK, "utf8"));
    assert.deepEqual(await catalog(), e03, "only the e03 row is left, untouched");
    assert.deepEqual(await structure(c), s0, "the structure is as before, the guard trigger enabled");
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name like '%v28_%'`)).rows[0].n, 0);
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name like '%v27_%'`)).rows[0].n, 1);
    await assert.rejects(c.query(`delete from training_load.source_host_catalog where host_key = 'e03'`), /DELETE refused/, "the guard works again");

    await applyGpexeTestMigrations(fresh.url, [...UP_TO_V27, V28]);
    assert.deepEqual((await catalog()).map((r) => r.host_key), ["e03", "server3"]);
  } finally {
    k = saved;
    await c.end();
    await fresh.drop();
  }
});

// ---------------------------------------------------------------------------
// 3. No secret in anything this change ships
// ---------------------------------------------------------------------------
test("12. no credential, account address or token is in any file of this change, and the legacy credential file is ignored by Git", async () => {
  const files = [
    "backend/src/sourceHosts.js", "backend/scripts/gpexe-auth-discovery.mjs",
    "backend/tests/source-hosts-server3.test.mjs", "backend/tests/gpexe-auth-discovery.test.mjs",
    `migrations_v2/${V28}`, "docs/runbooks/source-hosts-v28-rollback.sql", "docs/runbooks/source-connections-v27.md",
    "docs/ai/source-connections-f3c2-contract.md", "docs/ai/CURRENT_STATE.md", ".gitignore",
    "backend/tests/_gpexe-disposable-db.mjs", "backend/tests/source-connections-f3c1.test.mjs", "backend/tests/source-credential-crypto.test.mjs",
    "docs/ai/gpexe-f3c-auth-discovery.md",
  ];
  // Addresses that may appear: made-up test domains and the commit trailer's.
  const allowedAddress = /@(test\.local|example\.invalid|example\.com|anthropic\.com)$/i;
  for (const f of files) {
    const text = await fsp.readFile(path.resolve(ROOT, f), "utf8");
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)) {
      assert.match(m[0], allowedAddress, `${f}: an e-mail address of a real domain`);
    }
    assert.doesNotMatch(text, /\bToken\s+[0-9a-f]{20,}\b/i, `${f}: a token value`);
    // A 40-hex value has the shape of a REST token. The only ones allowed are Git commit ids
    // already written in the documents, named here by their short form.
    const knownCommits = ["7e4d92d"];
    for (const m of text.matchAll(/\b[0-9a-f]{40}\b/gi)) {
      assert.ok(knownCommits.some((c) => m[0].toLowerCase().startsWith(c)), `${f}: a 40-hex value (the shape of a REST token)`);
    }
    assert.doesNotMatch(text, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, `${f}: a JWT`);
    assert.doesNotMatch(text, /\b(Bearer|Token)\s+[A-Za-z0-9_\-.]{24,}(?<!not-real)\b(?![^\n]*not-real)/, `${f}: a header credential`);
    assert.doesNotMatch(text, /GPEXE_(PASSWORD|USERNAME|API_TOKEN)\s*=\s*['"]?[^\s'"$R(\[][^\s'"]{2,}/, `${f}: a credential assigned on a line`);
    // Made-up test markers say so in their value ("not-real").
    assert.doesNotMatch(text, /(password|lozinka)\s*[:=]\s*['"](?![^'"]*not-real)[^'"\s]{3,}['"]/i, `${f}: a literal password`);
  }
  assert.equal(files.length, 14, "every file of the change is scanned");
  // The documents state the current allowlist: a sentence that calls server3 unapproved is dated.
  for (const f of ["docs/ai/CURRENT_STATE.md", "docs/ai/source-connections-f3c2-contract.md", "docs/runbooks/source-connections-v27.md", "docs/ai/gpexe-f3c-auth-discovery.md"]) {
    const text = (await fsp.readFile(path.resolve(ROOT, f), "utf8")).replace(/\r?\n/g, " ");
    assert.doesNotMatch(text, /server3`?[^.]{0,80}\b(stays unapproved|is not approved|is in neither)\b/, `${f}: a present-tense claim that server3 is unapproved`);
    assert.doesNotMatch(text, /refuses every host but the approved .e03. key/, f);
    assert.doesNotMatch(text, /password literal|identifier literal|no character special/i, `${f}: a property of the real credential`);
  }
  // The contract document keeps every section the state file and the runbook point at.
  const contract = await fsp.readFile(path.resolve(ROOT, "docs/ai/source-connections-f3c2-contract.md"), "utf8");
  for (const heading of [/^## 1\. Owner-run read-only discovery/m, /^## 2\. Source-neutral shape of F3c2/m, /^### 2\.3 The mandatory conditions/m, /^## 3\. Test plan/m, /^## 4\. Stop line/m]) assert.match(contract, heading);
  for (let n = 1; n <= 8; n += 1) assert.match(contract, new RegExp(`^\\| ${n} \\| `, "m"), `mandatory condition ${n}`);
  const ignore = (await fsp.readFile(path.resolve(ROOT, ".gitignore"), "utf8")).split(/\r?\n/).map((l) => l.trim());
  assert.ok(ignore.includes("gpexe-code-check.js"), "the legacy credential file can never be added by accident");
});

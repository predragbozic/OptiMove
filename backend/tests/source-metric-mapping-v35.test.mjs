// v35 - the database actor guards of the source metric mapping writes (T3
// mappings, T4 mapping versions, T8 audit rows): the transaction-local actor
// setting, the user / owner scope / basis checks, the audit chain of the same
// transaction and the deferred audit link at COMMIT; the M2 service under
// them. On disposable optimove_tests_gpexe_* databases only (never OPTIMOVE):
// one migrated through v34 that rehearses v35's apply / rollback / re-apply,
// one migrated through v35 for the behaviour and the M2 HTTP stack.
// Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, C73-C79, J2.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { allowSyntheticTestFields } from "./support/test-extractors.mjs";

allowSyntheticTestFields();

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V35 = "202610131000_training_load_v35_source_metric_actor_guards.sql";
const V35_NAME = `migrations_v2/${V35}`;
const UP_TO_V34 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V35));
const MIGRATION_PATH = path.resolve(ROOT, "migrations_v2", V35);
const ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/source-metric-mapping-v35-rollback.sql");
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const PREFIX = "/api/training-load/sources/metrics";
// What the M2 service sets (and what a sanctioned raw writer would set).
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const V35_MESSAGES = new Set([
  "source metric mapping: no acting user is set for this transaction",
  "source metric mapping: the row names another user than the acting user",
  "source metric mapping: the acting user may not write this mapping",
  "source metric mapping: the basis is not the acting user's own",
  "source metric mapping: the acting user may not write this audit row",
  "source_metric_audit: the audit row must follow its own operation in the same transaction",
  "source_metric_audit: the operation already has its audit row",
  "source_metric_mappings: a mapping is written with its mapping_create audit row",
  "source_metric_mapping_versions: a version is written with its mapping_version_create audit row",
  "source_metric_mapping_versions: a status transition is written with its mapping_status audit row",
]);
const NO_ACTOR = /no acting user is set for this transaction/;
const OTHER_USER = /the row names another user than the acting user/;
const MAY_NOT = /the acting user may not write this mapping/;
const BASIS = /the basis is not the acting user's own/;
const FOLLOW = /the audit row must follow its own operation in the same transaction/;
const ALREADY = /the operation already has its audit row/;
const AUDIT_ROW = /the acting user may not write this audit row/;
const LINK_MAPPING = /a mapping is written with its mapping_create audit row/;
const LINK_VERSION = /a version is written with its mapping_version_create audit row/;
const LINK_STATUS = /a status transition is written with its mapping_status audit row/;
const V35_PATTERNS = new Set([NO_ACTOR, OTHER_USER, MAY_NOT, BASIS, FOLLOW, ALREADY, AUDIT_ROW, LINK_MAPPING, LINK_VERSION, LINK_STATUS]);

let rdb, db, r, k, server, apiBase, service, dbModule, appPool, createSession;
const W = {};
const seen = new Set();
const logLines = [];
const responses = [];
const originalConsole = {};

async function applyV35(url) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v35-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of UP_TO_V34) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    await fsp.copyFile(MIGRATION_PATH, path.join(dir, V35));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

before(async () => {
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V35), "v35 is a test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v35rb", migrations: UP_TO_V34 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v35", migrations: UP_TO_V34 }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  await r.connect();
  await k.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  await applyV35(db.url);
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.V35_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
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
  service?.setMappingCommitForTests();
  service?.setMappingWriteHoldForTests(null);
  service?.setMappingRightsHoldForTests(null);
  service?.setMappingReadFaultForTests(null);
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
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

afterEach(() => {
  service.setMappingCommitForTests();
  service.setMappingWriteHoldForTests(null);
  service.setMappingRightsHoldForTests(null);
  service.setMappingReadFaultForTests(null);
});

// ---------------------------------------------------------------------------
// helpers
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const q = (sql, params) => rows(k, sql, params);

async function ins(c, table, obj) {
  const keys = Object.keys(obj);
  const sql = `insert into training_load.${table} (${keys.map((x) => `"${x}"`).join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`;
  return (await c.query(sql, keys.map((x) => obj[x]))).rows[0];
}

// One transaction on `client`, with the acting user set the way the M2
// service sets it (no actor: none set). Committed when fn succeeds; any
// refusal - in fn or at the COMMIT - rolls everything back and is returned.
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
  assert.equal(res.error.code, code, `${res.error.code}: ${res.error.message}`);
  assert.match(res.error.message, pattern);
  if (V35_PATTERNS.has(pattern)) seen.add(res.error.message);
  return res.error;
}
const okTx = (res) => { assert.equal(res.ok, true, res.error ? `${res.error.code}: ${res.error.message}` : ""); return res.value; };

async function user(label, { active = true } = {}) {
  return (await one(k, `insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,$3) returning id`, [`${label}-${uid()}@test.local`, label, active])).id;
}
async function platformAdmin({ roleActive = true, active = true } = {}) {
  const id = await user("platform-admin", { active });
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',$2)`, [id, roleActive]);
  return id;
}
async function clubAdmin(clubId, { roleActive = true } = {}) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',$3)`, [id, clubId, roleActive]);
  return id;
}
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;

async function canonical({ scope = "system", clubId = null, unit = "s" } = {}) {
  const id = (await one(k, `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id, state) values ($1,'v35 test variable',$2,$3,'active') returning id`, [`v35_${uid()}`, scope, clubId])).id;
  const versionId = (await one(k, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1,1,$2,'numeric') returning id`, [id, unit])).id;
  await k.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [versionId, id]);
  for (const s of ["session", "component"]) await k.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,$2)`, [id, s]);
  return { id, versionId, unit };
}
// A verified, active gpexe / rest_v1 field with unit s (v34 T2a / T2b, a platform admin as their actor).
async function field() {
  const by = W.pa;
  const def = await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Test field',$2) returning id`, [`v35.test.f${uid()}`, by]);
  const rev = await one(k, `insert into training_load.source_metric_definition_versions (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill, evidence_status, evidence_ref, created_by_user_id)
                            values ($1,1,'number','none',true,true,'observed',$2,$3) returning id`, [def.id, COMPAT, by]);
  await k.query(`update training_load.source_metric_definition_versions set source_unit = 's', unit_verified_by_user_id = $2, unit_verified_at = now(), unit_evidence_ref = $3 where id = $1`, [rev.id, by, COMPAT]);
  await k.query(`update training_load.source_metric_definition_versions set meaning_verified_by_user_id = $2, meaning_verified_at = now(), meaning_evidence_ref = $3, evidence_status = 'verified' where id = $1`, [rev.id, by, COMPAT]);
  await k.query(`update training_load.source_metric_definition_versions set state = 'active', activated_by_user_id = $2, activated_at = now() where id = $1`, [rev.id, by]);
  return { id: def.id, revId: rev.id };
}

const T3 = (c, { f, md, scope = "system", clubId = null, by }) => ins(c, "source_metric_mappings", {
  source_metric_definition_id: f.id, source_system: "gpexe", api_family: "rest_v1", metric_definition_id: md.id, owner_scope: scope, owner_club_id: clubId, created_by_user_id: by,
});
let versionNumber = 1;
const T4 = (c, { m, f, md, by }) => ins(c, "source_metric_mapping_versions", {
  mapping_id: m.id, source_metric_definition_id: f.id, metric_definition_id: md.id, source_metric_version_id: f.revId, version_number: versionNumber++,
  metric_definition_version_id: md.versionId, conversion_kind: "numeric_linear", scale: "1", scale_divisor: "1", offset: "0", source_unit: "s", target_unit: md.unit,
  parameter_kind: "none", source_parameters: {}, canonical_parameters: {}, parameter_scale: "1", parameter_scale_divisor: "1", parameter_offset: "0",
  applies_to_session: true, applies_to_drill: true, created_by_user_id: by,
});
const T8 = (c, { action, m, v = null, from = null, to = null, by, basis, reason = null }) => ins(c, "source_metric_audit", {
  action, mapping_id: m.id, mapping_version_id: v ? v.id : null, from_status: from, to_status: to, reason, performed_by_user_id: by, basis, operation_id: crypto.randomUUID(),
});
const submitRow = (c, v, by, basis) => c.query(`update training_load.source_metric_mapping_versions set status = 'needs_review', submitted_by_user_id = $2, submitted_at = now(), submitted_basis = $3 where id = $1`, [v.id, by, basis]);
const activateRow = (c, v, by) => c.query(`update training_load.source_metric_mapping_versions set status = 'active', activated_by_user_id = $2, activated_at = now(), activated_basis = 'platform_admin' where id = $1`, [v.id, by]);
const disableRow = (c, v, by) => c.query(`update training_load.source_metric_mapping_versions set status = 'disabled', disabled_by_user_id = $2, disabled_at = now(), disabled_basis = 'platform_admin', disable_reason = 'Replaced in a test' where id = $1`, [v.id, by]);

// The legitimate operations, each in its own transaction with its audit row.
async function mappingOf(actor, md, { scope = "system", clubId = null, basis = "platform_admin" } = {}) {
  const f = await field();
  const m = okTx(await tx(actor, async (c) => {
    const row = await T3(c, { f, md, scope, clubId, by: actor });
    await T8(c, { action: "mapping_create", m: row, by: actor, basis });
    return row;
  }));
  return { m, f, md };
}
async function versionOf(actor, { m, f, md }, basis = "platform_admin") {
  return okTx(await tx(actor, async (c) => {
    const v = await T4(c, { m, f, md, by: actor });
    await T8(c, { action: "mapping_version_create", m, v, to: "draft", by: actor, basis });
    return v;
  }));
}
async function submitOf(actor, m, v, basis = "platform_admin") {
  okTx(await tx(actor, async (c) => {
    await submitRow(c, v, actor, basis);
    await T8(c, { action: "mapping_status", m, v, from: "draft", to: "needs_review", by: actor, basis });
  }));
}

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.clubC = await club("Club C");
  W.pa = await platformAdmin();
  W.pa2 = await platformAdmin();
  W.paRevoked = await platformAdmin({ roleActive: false });
  W.paInactive = await platformAdmin({ active: false });
  W.caA = await clubAdmin(W.clubA);
  // A platform admin who also holds the club admin role of club A: the database derives platform_admin.
  W.paA = await platformAdmin();
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [W.paA, W.clubA]);
  W.caB = await clubAdmin(W.clubB);
  W.caRevoked = await clubAdmin(W.clubA, { roleActive: false });
  W.caC = await clubAdmin(W.clubC);
  W.caInactive = await clubAdmin(W.clubA);
  await k.query(`update public.users set is_active = false where id = $1`, [W.caInactive]);
  W.teamA = (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [W.clubA, `Team ${uid()}`])).id;
  W.coach = await user("coach");
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [W.coach, W.teamA]);
  W.athleteUser = await user("athlete");
  W.sys = await canonical();
  W.clubAmd = await canonical({ scope: "club", clubId: W.clubA });
  W.clubBmd = await canonical({ scope: "club", clubId: W.clubB });
  W.clubCmd = await canonical({ scope: "club", clubId: W.clubC });
  await k.query(`update public.clubs set is_active = false where id = $1`, [W.clubC]);
  await workspace(W.pa, "platform", null);
  W.paCookie = await cookieFor(W.pa);
  W.pa2Cookie = await cookieFor(W.pa2);
  await workspace(W.pa2, "platform", null);
}

async function api(p, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${PREFIX}${p}`, {
    method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  responses.push(text);
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const post = (p, cookie, body) => api(p, { method: "POST", cookie, body });
const key = () => crypto.randomUUID();

async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    tables: await rows(c, `select table_schema, table_name from information_schema.tables where table_schema in ${S} order by 1, 2`),
    columns: await rows(c, `select table_schema, table_name, column_name, data_type, is_nullable, column_default, is_generated, generation_expression from information_schema.columns where table_schema in ${S} order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, c.contype, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    indexes: await rows(c, `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ${S} order by 1, 2, 3`),
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled, t.tgdeferrable, t.tginitdeferred from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
async function runRollback(c) {
  const sql = await fsp.readFile(ROLLBACK_PATH, "utf8");
  try {
    await c.query(sql);
    return null;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    return e;
  }
}
const V35_FUNCTIONS = ["source_metric_actor_basis", "source_metric_audit_actor_guard", "source_metric_context_actor", "source_metric_current_xmin",
  "source_metric_mapping_versions_actor_guard", "source_metric_mapping_versions_audit_link", "source_metric_mappings_actor_guard", "source_metric_mappings_audit_link"];
const V35_TRIGGERS = [
  ["source_metric_audit", "source_metric_audit_v35_actor_guard", false],
  ["source_metric_mapping_versions", "source_metric_mapping_versions_v35_actor_guard", false],
  ["source_metric_mapping_versions", "source_metric_mapping_versions_v35_audit_link_insert", true],
  ["source_metric_mapping_versions", "source_metric_mapping_versions_v35_audit_link_update", true],
  ["source_metric_mappings", "source_metric_mappings_v35_actor_guard", false],
  ["source_metric_mappings", "source_metric_mappings_v35_audit_link", true],
];

async function waitsForLock(pid, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await one(k, `select wait_event_type from pg_stat_activity where pid = $1`, [pid]);
    if (row?.wait_event_type === "Lock") return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}
async function someoneWaits(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await one(k, `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`)).n > 0) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}
async function until(condition, label, timeoutMs = 10000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting: ${label}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

// ---------------------------------------------------------------------------
test("1. migration v35 on v34: eight functions and six triggers (the BEFORE guards after the v34 guards by name; three deferrable, initially deferred constraint triggers), no table, column, index or data change; the rollback refuses without v35, under a later migration, with a v35 trigger missing or disabled; it returns the identical v34 catalog, and v35 applies again identically", async () => {
  const notYet = await runRollback(r);
  assert.match(notYet?.message ?? "", /^v35 rollback refused: v35 is not recorded/);
  const before34 = await catalog(r);
  await applyV35(rdb.url);
  const after35 = await catalog(r);
  assert.ok(after35.migrations.includes(V35_NAME));
  for (const part of ["tables", "columns"]) assert.deepEqual(after35[part], before34[part], `v35 changes no ${part}`);
  assert.deepEqual(after35.indexes.filter((x) => !before34.indexes.some((y) => y.indexname === x.indexname)).map((x) => x.indexname).sort(),
    ["source_metric_audit_v35_mapping_create_idx", "source_metric_audit_v35_version_idx"], "the only new indexes are the two audit lookups");
  assert.deepEqual(before34.indexes, after35.indexes.filter((x) => !x.indexname.includes("_v35_")), "no v34 index changed");
  const added = (list, base, keyOf) => list.filter((x) => !base.some((y) => keyOf(y) === keyOf(x)));
  assert.deepEqual(added(after35.functions, before34.functions, (x) => x.proname).map((x) => x.proname).sort(), V35_FUNCTIONS);
  assert.deepEqual(before34.functions, after35.functions.filter((x) => !V35_FUNCTIONS.includes(x.proname)), "no v34 function changed");
  const newTriggers = added(after35.triggers, before34.triggers, (x) => `${x.relname}.${x.tgname}`);
  assert.deepEqual(newTriggers.map((x) => [x.relname, x.tgname, x.tgdeferrable && x.tginitdeferred]).sort(), V35_TRIGGERS.map((x) => [...x]).sort());
  for (const t of newTriggers) assert.equal(t.tgenabled, "O");
  assert.deepEqual(before34.triggers, after35.triggers.filter((x) => !x.tgname.includes("_v35_")), "no v34 trigger changed");
  assert.deepEqual(added(after35.constraints, before34.constraints, (x) => `${x.rel}.${x.conname}`).map((x) => [x.conname, x.contype]).sort(),
    V35_TRIGGERS.filter((x) => x[2]).map((x) => [x[1], "t"]).sort(), "the only new constraints are the three constraint triggers");
  // Each v35 guard fires after the v34 guard of its table and event (trigger order is by name).
  for (const [table, v34] of [["source_metric_mappings", "source_metric_mappings_guard"], ["source_metric_mapping_versions", "source_metric_mapping_versions_insert_guard"], ["source_metric_mapping_versions", "source_metric_mapping_versions_update_guard"], ["source_metric_audit", "source_metric_audit_insert_guard"]]) {
    const v35 = V35_TRIGGERS.find((x) => x[0] === table && !x[2])[1];
    assert.ok(v34 < v35, `${v34} runs before ${v35}`);
  }
  // Refusals, each changing nothing.
  await r.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/202610131001_training_load_v36_test_only.sql', $1, 'test')`, ["0".repeat(64)]);
  assert.match((await runRollback(r))?.message ?? "", /^v35 rollback refused: later migrations are applied/);
  await r.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/202610131001_training_load_v36_test_only.sql'`);
  await r.query(`alter table training_load.source_metric_audit disable trigger source_metric_audit_v35_actor_guard`);
  assert.match((await runRollback(r))?.message ?? "", /^v35 rollback refused: a v35 trigger is disabled/);
  await r.query(`alter table training_load.source_metric_audit enable trigger source_metric_audit_v35_actor_guard`);
  await r.query(`alter trigger source_metric_mappings_v35_actor_guard on training_load.source_metric_mappings rename to v35_renamed`);
  assert.match((await runRollback(r))?.message ?? "", /^v35 rollback refused: the v35 triggers are not all present/);
  await r.query(`alter trigger v35_renamed on training_load.source_metric_mappings rename to source_metric_mappings_v35_actor_guard`);
  await r.query(`alter index training_load.source_metric_audit_v35_version_idx rename to v35_idx_renamed`);
  assert.match((await runRollback(r))?.message ?? "", /^v35 rollback refused: the v35 indexes are not all present/);
  await r.query(`alter index training_load.v35_idx_renamed rename to source_metric_audit_v35_version_idx`);
  assert.deepEqual(await catalog(r), after35, "every refusal changed nothing");
  // A clean rollback: the identical v34 catalog; then v35 again.
  assert.equal(await runRollback(r), null);
  assert.deepEqual(await catalog(r), before34, "the rollback returns the identical v34 catalog");
  await applyV35(rdb.url);
  assert.deepEqual(await catalog(r), after35, "v35 applies again identically");
});

test("2. the actor setting: none, empty, not a lowercase canonical uuid, without or with another transaction's id (a session-level SET left from an earlier transaction): every protected write is 42501; the setting is gone after COMMIT and after ROLLBACK on the same connection", async () => {
  const f = await field();
  const writeMapping = (c) => T3(c, { f, md: W.sys, by: W.pa });
  refusedWith(await tx(null, writeMapping), "42501", NO_ACTOR);
  const lastXid = okTx(await tx(null, async (c) => (await one(c, `select pg_current_xact_id()::text as x`)).x));
  for (const value of ["", W.pa, W.pa.toUpperCase(), `${W.pa}:`, `${W.pa}:abc`, `${W.pa}:${lastXid}`, `{${W.pa}}:1`, ` ${W.pa}:1`]) {
    refusedWith(await tx(null, async (c) => {
      await c.query(`select set_config('optimove.source_metric_actor', $1, true)`, [value]);
      return writeMapping(c);
    }), "42501", NO_ACTOR);
  }
  // Not a lowercase canonical uuid, even with this transaction's own id.
  for (const actor of [W.pa.toUpperCase(), `{${W.pa}}`, W.pa.replace(/-/g, "")]) {
    refusedWith(await tx(null, async (c) => {
      await c.query(CTX, [actor]);
      return writeMapping(c);
    }), "42501", NO_ACTOR);
  }
  // A session-level SET outlives its transaction - so it carries an old transaction's id and is refused.
  await k.query(`select set_config('optimove.source_metric_actor', $1, false)`, [`${W.pa}:${lastXid}`]);
  assert.equal((await one(k, `select current_setting('optimove.source_metric_actor', true) as v`)).v, `${W.pa}:${lastXid}`, "the session-level value is there");
  refusedWith(await tx(null, writeMapping), "42501", NO_ACTOR);
  refusedWith(await tx(null, (c) => T8(c, { action: "unit_conversion_create", m: { id: null }, by: W.pa, basis: "platform_admin" })), "42501", NO_ACTOR);
  await k.query(`reset optimove.source_metric_actor`);
  // Gone after COMMIT and after ROLLBACK on the same connection.
  const { m } = await mappingOf(W.pa, W.sys);
  assert.ok(m.id);
  assert.equal((await one(k, `select current_setting('optimove.source_metric_actor', true) as v`)).v, "", "nothing left after the COMMIT");
  refusedWith(await tx(null, writeMapping), "42501", NO_ACTOR);
  await k.query("begin");
  await k.query(CTX, [W.pa]);
  await k.query("rollback");
  assert.equal((await one(k, `select current_setting('optimove.source_metric_actor', true) as v`)).v, "", "nothing left after the ROLLBACK");
  refusedWith(await tx(null, writeMapping), "42501", NO_ACTOR);
  // A version and an audit row without the setting.
  const legit = await mappingOf(W.pa, W.sys);
  refusedWith(await tx(null, (c) => T4(c, { m: legit.m, f: legit.f, md: W.sys, by: W.pa })), "42501", NO_ACTOR);
  refusedWith(await tx(null, (c) => T8(c, { action: "mapping_create", m: legit.m, by: W.pa, basis: "platform_admin" })), "42501", NO_ACTOR);
});

test("3. the legitimate operations, each with its audit row in its own transaction: a platform admin in the system scope and in a club scope, a club's own admin in its club; versions, submissions, and a platform admin's activation and disabling; the basis is derived by the database", async () => {
  const sys = await mappingOf(W.pa, W.sys);
  const sv = await versionOf(W.pa, sys);
  await submitOf(W.pa, sys.m, sv);
  okTx(await tx(W.pa, async (c) => {
    await activateRow(c, sv, W.pa);
    await T8(c, { action: "mapping_status", m: sys.m, v: sv, from: "needs_review", to: "active", by: W.pa, basis: "platform_admin" });
  }));
  okTx(await tx(W.pa, async (c) => {
    await disableRow(c, sv, W.pa);
    await T8(c, { action: "mapping_status", m: sys.m, v: sv, from: "active", to: "disabled", by: W.pa, basis: "platform_admin", reason: "Replaced in a test" });
  }));
  assert.equal((await one(k, `select status from training_load.source_metric_mapping_versions where id = $1`, [sv.id])).status, "disabled");
  const paClub = await mappingOf(W.pa, W.clubAmd, { scope: "club", clubId: W.clubA });
  const pcv = await versionOf(W.pa, paClub);
  await submitOf(W.pa, paClub.m, pcv);
  const ca = await mappingOf(W.caA, W.clubAmd, { scope: "club", clubId: W.clubA, basis: "club_admin" });
  const cav = await versionOf(W.caA, ca, "club_admin");
  await submitOf(W.caA, ca.m, cav, "club_admin");
  const audit = await q(`select action, basis, performed_by_user_id from training_load.source_metric_audit where mapping_id = $1 order by performed_at, action`, [ca.m.id]);
  assert.deepEqual(audit.map((a) => [a.action, a.basis, a.performed_by_user_id]), [["mapping_create", "club_admin", W.caA], ["mapping_version_create", "club_admin", W.caA], ["mapping_status", "club_admin", W.caA]]);
  // The other audit actions need an active platform admin.
  const conv = (await one(k, `select id from training_load.unit_conversions limit 1`)).id;
  const convRow = (by) => (c) => ins(c, "source_metric_audit", { action: "unit_conversion_retire", unit_conversion_id: conv, from_status: "active", to_status: "retired", reason: "Test", performed_by_user_id: by, basis: "platform_admin", operation_id: crypto.randomUUID() });
  refusedWith(await tx(W.caA, convRow(W.caA)), "42501", AUDIT_ROW);
  okTx(await tx(W.pa, convRow(W.pa)));
});

test("4. who may write: another club's admin, a coach, an athlete, a revoked role, an inactive user and the admin of an archived club are 42501 on a mapping, a version and an audit row; a club admin never writes a system mapping; a platform admin never writes a mapping of an archived club; a version of another owner's mapping is 42501", async () => {
  const f = await field();
  const a = await mappingOf(W.caA, W.clubAmd, { scope: "club", clubId: W.clubA, basis: "club_admin" });
  // Each of them on each table: a mapping of club A, a version of club A's mapping, an audit row of it.
  for (const actor of [W.caB, W.coach, W.athleteUser, W.caRevoked, W.caInactive, W.paRevoked, W.paInactive]) {
    refusedWith(await tx(actor, (c) => T3(c, { f, md: W.clubAmd, scope: "club", clubId: W.clubA, by: actor })), "42501", MAY_NOT);
    refusedWith(await tx(actor, (c) => T4(c, { ...a, by: actor })), "42501", MAY_NOT);
    refusedWith(await tx(actor, (c) => T8(c, { action: "mapping_create", m: a.m, by: actor, basis: "club_admin" })), "42501", MAY_NOT);
  }
  refusedWith(await tx(W.caA, (c) => T3(c, { f, md: W.sys, by: W.caA })), "42501", MAY_NOT);
  refusedWith(await tx(W.caC, (c) => T3(c, { f, md: W.clubCmd, scope: "club", clubId: W.clubC, by: W.caC })), "42501", MAY_NOT);
  refusedWith(await tx(W.pa, (c) => T3(c, { f, md: W.clubCmd, scope: "club", clubId: W.clubC, by: W.pa })), "42501", MAY_NOT);
  const v = await versionOf(W.caA, a, "club_admin");
  refusedWith(await tx(W.caB, async (c) => {
    await submitRow(c, v, W.caB, "club_admin");
  }), "42501", /the acting user is not an active admin of the mapping.s club/);
  const sysMap = await mappingOf(W.pa, W.sys);
  refusedWith(await tx(W.caA, (c) => T4(c, { ...sysMap, by: W.caA })), "42501", MAY_NOT);
});

test("5. forged rows: a created_by_user_id, a performed_by_user_id or a transition's user other than the acting user, or a basis other than the derived one, is 42501", async () => {
  const f = await field();
  refusedWith(await tx(W.pa, (c) => T3(c, { f, md: W.sys, by: W.pa2 })), "42501", OTHER_USER);
  refusedWith(await tx(W.pa, async (c) => {
    const m = await T3(c, { f, md: W.sys, by: W.pa });
    await T8(c, { action: "mapping_create", m, by: W.pa2, basis: "platform_admin" });
  }), "42501", OTHER_USER);
  refusedWith(await tx(W.caA, async (c) => {
    const m = await T3(c, { f, md: W.clubAmd, scope: "club", clubId: W.clubA, by: W.caA });
    await T8(c, { action: "mapping_create", m, by: W.caA, basis: "platform_admin" });
  }), "42501", BASIS);
  refusedWith(await tx(W.pa, async (c) => {
    const m = await T3(c, { f, md: W.clubAmd, scope: "club", clubId: W.clubA, by: W.pa });
    await T8(c, { action: "mapping_create", m, by: W.pa, basis: "club_admin" });
  }), "42501", BASIS);
  const sys = await mappingOf(W.pa, W.sys);
  refusedWith(await tx(W.pa, (c) => T4(c, { ...sys, by: W.pa2 })), "42501", OTHER_USER);
  const v = await versionOf(W.pa, sys);
  refusedWith(await tx(W.pa, (c) => submitRow(c, v, W.pa2, "platform_admin")), "42501", OTHER_USER);
  const club = await mappingOf(W.paA, W.clubAmd, { scope: "club", clubId: W.clubA });
  const cv = await versionOf(W.paA, club);
  refusedWith(await tx(W.paA, (c) => submitRow(c, cv, W.paA, "club_admin")), "42501", BASIS);
  await submitOf(W.pa, sys.m, v);
  refusedWith(await tx(W.pa, (c) => activateRow(c, v, W.pa2)), "42501", OTHER_USER);
  refusedWith(await tx(W.pa, (c) => disableRow(c, v, W.pa2)), "42501", OTHER_USER);
});

test("6. the audit chain: an audit row for a mapping or version this transaction did not write, for the wrong status or action, or a second audit row of one operation is 23514 and the transaction is rolled back", async () => {
  const earlier = await mappingOf(W.pa, W.sys);
  refusedWith(await tx(W.pa, (c) => T8(c, { action: "mapping_create", m: earlier.m, by: W.pa, basis: "platform_admin" })), "23514", FOLLOW);
  const ev = await versionOf(W.pa, earlier);
  refusedWith(await tx(W.pa, (c) => T8(c, { action: "mapping_version_create", m: earlier.m, v: ev, to: "draft", by: W.pa, basis: "platform_admin" })), "23514", FOLLOW);
  refusedWith(await tx(W.pa, (c) => T8(c, { action: "mapping_status", m: earlier.m, v: ev, from: "draft", to: "needs_review", by: W.pa, basis: "platform_admin" })), "23514", FOLLOW);
  // A second audit row of one operation.
  const f = await field();
  const dup = await tx(W.pa, async (c) => {
    const m = await T3(c, { f, md: W.sys, by: W.pa });
    await T8(c, { action: "mapping_create", m, by: W.pa, basis: "platform_admin" });
    await T8(c, { action: "mapping_create", m, by: W.pa, basis: "platform_admin" });
  });
  refusedWith(dup, "23514", ALREADY);
  assert.equal((await q(`select 1 from training_load.source_metric_mappings where source_metric_definition_id = $1`, [f.id])).length, 0, "the whole transaction rolled back");
  refusedWith(await tx(W.pa, async (c) => {
    const v = await T4(c, { ...earlier, by: W.pa });
    await T8(c, { action: "mapping_version_create", m: earlier.m, v, to: "draft", by: W.pa, basis: "platform_admin" });
    await T8(c, { action: "mapping_version_create", m: earlier.m, v, to: "draft", by: W.pa, basis: "platform_admin" });
  }), "23514", ALREADY);
  const sv = await versionOf(W.pa, earlier);
  refusedWith(await tx(W.pa, async (c) => {
    await submitRow(c, sv, W.pa, "platform_admin");
    await T8(c, { action: "mapping_status", m: earlier.m, v: sv, from: "draft", to: "needs_review", by: W.pa, basis: "platform_admin" });
    await T8(c, { action: "mapping_status", m: earlier.m, v: sv, from: "draft", to: "needs_review", by: W.pa, basis: "platform_admin" });
  }), "23514", ALREADY);
  // A status row that lags behind the next transition of the same version (submitted, then disabled,
  // in one transaction): the version's status is no longer the row's target - each audit row follows
  // its own transition before the next one.
  const lag = await versionOf(W.pa, earlier);
  refusedWith(await tx(W.pa, async (c) => {
    await submitRow(c, lag, W.pa, "platform_admin");
    await disableRow(c, lag, W.pa);
    await T8(c, { action: "mapping_status", m: earlier.m, v: lag, from: "draft", to: "needs_review", by: W.pa, basis: "platform_admin" });
  }), "23514", FOLLOW);
  assert.equal((await one(k, `select status from training_load.source_metric_mapping_versions where id = $1`, [lag.id])).status, "draft");
  // The wrong action: a draft version followed by a status row.
  refusedWith(await tx(W.pa, async (c) => {
    const v = await T4(c, { ...earlier, by: W.pa });
    await T8(c, { action: "mapping_status", m: earlier.m, v, from: "draft", to: "needs_review", by: W.pa, basis: "platform_admin" });
  }), "23514", FOLLOW);
  // An audit row naming another mapping's version.
  const other = await mappingOf(W.pa, W.sys);
  refusedWith(await tx(W.pa, async (c) => {
    const v = await T4(c, { ...earlier, by: W.pa });
    await T8(c, { action: "mapping_version_create", m: other.m, v, to: "draft", by: W.pa, basis: "platform_admin" });
  }), "23514", FOLLOW);
});

test("7. at COMMIT every protected write needs its audit row: a mapping, a version or a status transition without one, or a transition whose audit row names another status, is refused (23514) and the whole transaction is rolled back; a trivial version update is not checked", async () => {
  const f = await field();
  refusedWith(await tx(W.pa, (c) => T3(c, { f, md: W.sys, by: W.pa })), "23514", LINK_MAPPING);
  assert.equal((await q(`select 1 from training_load.source_metric_mappings where source_metric_definition_id = $1`, [f.id])).length, 0);
  const g = await field();
  refusedWith(await tx(W.pa, async (c) => {
    const m = await T3(c, { f: g, md: W.sys, by: W.pa });
    await T8(c, { action: "mapping_create", m, by: W.pa, basis: "platform_admin" });
    await T4(c, { m, f: g, md: W.sys, by: W.pa });
  }), "23514", LINK_VERSION);
  assert.equal((await q(`select 1 from training_load.source_metric_mappings where source_metric_definition_id = $1`, [g.id])).length, 0, "the mapping of the same transaction is rolled back too");
  const m = await mappingOf(W.pa, W.sys);
  const v = await versionOf(W.pa, m);
  refusedWith(await tx(W.pa, (c) => submitRow(c, v, W.pa, "platform_admin")), "23514", LINK_STATUS);
  assert.equal((await one(k, `select status from training_load.source_metric_mapping_versions where id = $1`, [v.id])).status, "draft");
  // A transition whose audit row names another starting status.
  refusedWith(await tx(W.pa, async (c) => {
    await disableRow(c, v, W.pa);
    await T8(c, { action: "mapping_status", m: m.m, v, from: "needs_review", to: "disabled", by: W.pa, basis: "platform_admin", reason: "Replaced in a test" });
  }), "23514", LINK_STATUS);
  assert.equal((await one(k, `select status from training_load.source_metric_mapping_versions where id = $1`, [v.id])).status, "draft");
  // A trivial update: no status or actor change, so no actor and no audit row are asked for.
  okTx(await tx(null, (c) => c.query(`update training_load.source_metric_mapping_versions set status = status where id = $1`, [v.id])));
});

test("8. a savepoint: a mapping written inside a subtransaction carries the subtransaction's id, so its audit row is refused (fail closed) and the mapping cannot be committed", async () => {
  const f = await field();
  refusedWith(await tx(W.pa, async (c) => {
    await c.query("savepoint s1");
    const m = await T3(c, { f, md: W.sys, by: W.pa });
    await c.query("release savepoint s1");
    await T8(c, { action: "mapping_create", m, by: W.pa, basis: "platform_admin" });
  }), "23514", FOLLOW);
  assert.equal((await q(`select 1 from training_load.source_metric_mappings where source_metric_definition_id = $1`, [f.id])).length, 0);
});

test("9. the lock order, both directions: a guard holds the acting user's role row FOR SHARE until COMMIT, so a revocation waits for the write; a revocation in flight makes the guard wait, and once it commits the write is 42501", async () => {
  const caX = await clubAdmin(W.clubA);
  const fx = await field();
  const a = new pg.Client({ connectionString: db.url });
  const b = new pg.Client({ connectionString: db.url });
  await a.connect();
  await b.connect();
  try {
    // (a) the write first.
    const bPid = (await one(b, `select pg_backend_pid() as pid`)).pid;
    await a.query("begin");
    await a.query(CTX, [caX]);
    const m = await T3(a, { f: fx, md: W.clubAmd, scope: "club", clubId: W.clubA, by: caX });
    const revoking = b.query(`update public.user_club_roles set is_active = false where user_id = $1`, [caX]);
    assert.equal(await waitsForLock(bPid), true, "the revocation waits for the write's FOR SHARE");
    await T8(a, { action: "mapping_create", m, by: caX, basis: "club_admin" });
    await a.query("commit");
    await revoking;
    assert.equal((await q(`select 1 from training_load.source_metric_mappings where id = $1`, [m.id])).length, 1);
    // (b) the revocation first.
    const caY = await clubAdmin(W.clubA);
    const fy = await field();
    const aPid = (await one(a, `select pg_backend_pid() as pid`)).pid;
    await b.query("begin");
    await b.query(`update public.user_club_roles set is_active = false where user_id = $1`, [caY]);
    const writing = tx(caY, (c) => T3(c, { f: fy, md: W.clubAmd, scope: "club", clubId: W.clubA, by: caY }), a);
    assert.equal(await waitsForLock(aPid), true, "the write's guard waits for the revocation");
    await b.query("commit");
    refusedWith(await writing, "42501", MAY_NOT);
  } finally {
    await a.end().catch(() => {});
    await b.end().catch(() => {});
  }
});

test("10. the M2 service under v35: create, version and submit succeed with one audit row each, their replays write nothing and set no actor, a GET sets no actor, and no pooled connection keeps the setting; a version create and a submission of the same mapping serialize without a deadlock", async () => {
  const f = await field();
  const createBody = { requestKey: key(), sourceMetricId: f.id, metricDefinitionId: W.sys.id };
  const created = await post("/mappings", W.paCookie, createBody);
  assert.equal(created.status, 201, created.text);
  const mId = created.body.mapping.id;
  const vBody = { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true };
  const v1 = await post(`/mappings/${mId}/versions`, W.paCookie, vBody);
  assert.equal(v1.status, 201, v1.text);
  const sBody = { requestKey: key() };
  const s1 = await post(`/mappings/${mId}/versions/${v1.body.version.id}/submit`, W.paCookie, sBody);
  assert.equal(s1.status, 200, s1.text);
  const auditCount = async () => (await one(k, `select count(*)::int as n from training_load.source_metric_audit where mapping_id = $1`, [mId])).n;
  assert.equal(await auditCount(), 3);
  // A replay sets no actor: the right check of a replay sees none.
  const observed = [];
  service.setMappingRightsHoldForTests(async (client) => { observed.push((await one(client, `select current_setting('optimove.source_metric_actor', true) as v`)).v); });
  for (const [p, body] of [["/mappings", createBody], [`/mappings/${mId}/versions`, vBody], [`/mappings/${mId}/versions/${v1.body.version.id}/submit`, sBody]]) {
    const r2 = await post(p, W.paCookie, body);
    assert.deepEqual([r2.status, r2.body.replayed], [200, true], p);
  }
  service.setMappingRightsHoldForTests(null);
  assert.ok(observed.length >= 3 && observed.every((x) => !x), `no replay sets the actor: ${JSON.stringify(observed)}`);
  assert.equal(await auditCount(), 3, "a replay writes nothing");
  // A write sets the actor before its first protected write, bound to its transaction.
  const during = [];
  service.setMappingWriteHoldForTests(async (client) => { during.push((await one(client, `select current_setting('optimove.source_metric_actor', true) = $1 || ':' || pg_current_xact_id()::text as ok`, [W.pa])).ok); });
  const v2 = await post(`/mappings/${mId}/versions`, W.paCookie, { ...vBody, requestKey: key() });
  service.setMappingWriteHoldForTests(null);
  assert.deepEqual([v2.status, during], [201, [true]]);
  // A GET sets none.
  const inRead = [];
  service.setMappingReadFaultForTests(async (client) => { inRead.push((await one(client, `select current_setting('optimove.source_metric_actor', true) as v`)).v); });
  assert.equal((await api(`/mappings/${mId}`, { cookie: W.paCookie })).status, 200);
  service.setMappingReadFaultForTests(null);
  assert.ok(inRead.length >= 1 && inRead.every((x) => !x), "a GET sets no actor");
  // No pooled connection keeps the setting.
  const clients = [];
  try {
    for (let i = 0; i < appPool.totalCount; i += 1) clients.push(await appPool.connect());
    for (const c of clients) assert.ok(!(await one(c, `select current_setting('optimove.source_metric_actor', true) as v`)).v, "a pooled connection keeps no actor");
  } finally {
    for (const c of clients) c.release();
  }
  // A version create (held after its locks) and a submission of the same mapping by another admin.
  const g = gate();
  let entered = false;
  service.setMappingWriteHoldForTests(async (_c, where) => { if (where === "mapping_version_create") { entered = true; await g.promise; } });
  const holding = post(`/mappings/${mId}/versions`, W.paCookie, { ...vBody, requestKey: key() });
  await until(() => entered, "the version create holds its locks");
  const submitting = post(`/mappings/${mId}/versions/${v2.body.version.id}/submit`, W.pa2Cookie, { requestKey: key() });
  assert.equal(await someoneWaits(), true, "the submission waits for the version create's mapping row");
  g.open();
  const [h, s] = await Promise.all([holding, submitting]);
  service.setMappingWriteHoldForTests(null);
  assert.deepEqual([h.status, s.status], [201, 200], `${h.text} / ${s.text}`);
});

test("11. the COMMIT through the M2 service: a write missing its audit row (an audit insert skipped by a test-only trigger) is refused by PostgreSQL at COMMIT - a sanitized 500, nothing written, no database text; a deadlock answered by PostgreSQL is try_again; every other COMMIT error - FATAL, a pooler's own answer without a backend routine, a connection class, 40003 - is verified by the request key, never taken for a refusal", async () => {
  await k.query(`create function training_load.v35_test_skip_audit() returns trigger language plpgsql as $$ begin return null; end $$`);
  await k.query(`create trigger aaa_v35_test_skip_audit before insert on training_load.source_metric_audit for each row when (new.action = 'mapping_create') execute function training_load.v35_test_skip_audit()`);
  try {
    const f = await field();
    const r1 = await post("/mappings", W.paCookie, { requestKey: key(), sourceMetricId: f.id, metricDefinitionId: W.sys.id });
    assert.deepEqual([r1.status, r1.body], [500, { error: "internal_error", message: "Something went wrong." }]);
    assert.equal((await q(`select 1 from training_load.source_metric_mappings where source_metric_definition_id = $1`, [f.id])).length, 0, "nothing written");
    assert.ok(!r1.text.includes("audit row"), "no database text in the answer");
    assert.ok(!logLines.some((l) => l.includes("mapping_create audit row")), "no database text in the log");
  } finally {
    await k.query(`drop trigger aaa_v35_test_skip_audit on training_load.source_metric_audit`);
    await k.query(`drop function training_load.v35_test_skip_audit()`);
  }
  // An error answer to a COMMIT, after the COMMIT really ran (or really rolled back).
  const dbError = ({ severity, code, routine }) => {
    const e = new pg.DatabaseError("injected COMMIT answer", 0, "error");
    e.severity = severity;
    e.code = code;
    if (routine) e.routine = routine;
    return e;
  };
  const mappingsOf = async (fieldId) => (await q(`select 1 from training_load.source_metric_mappings where source_metric_definition_id = $1`, [fieldId])).length;
  for (const answer of [
    { severity: "FATAL", code: "57P01", routine: "ProcessInterrupts" },
    { severity: "ERROR", code: "XX000" },
    { severity: "ERROR", code: "53300" },
    { severity: "ERROR", code: "08006", routine: "pq_recvbuf" },
    { severity: "FATAL", code: "40001", routine: "ProcessInterrupts" },
    { severity: "ERROR", code: "40003", routine: "CommitTransaction" },
  ]) {
    const f = await field();
    service.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw dbError(answer); }), timeoutMs: 2_000 });
    const r = await post("/mappings", W.paCookie, { requestKey: key(), sourceMetricId: f.id, metricDefinitionId: W.sys.id });
    service.setMappingCommitForTests();
    assert.deepEqual([r.status, r.body.commitConfirmation], [200, "verified_after_commit_error"], `${JSON.stringify(answer)}: ${r.text}`);
    assert.equal(await mappingsOf(f.id), 1, "written once");
  }
  // Rolled back, then a FATAL answer: verified and not found - outcome_unknown; the same key then writes once.
  const g = await field();
  const gBody = { requestKey: key(), sourceMetricId: g.id, metricDefinitionId: W.sys.id };
  service.setMappingCommitForTests({ fault: (client) => client.query("rollback").then(() => { throw dbError({ severity: "FATAL", code: "57P01", routine: "ProcessInterrupts" }); }), timeoutMs: 2_000 });
  const unknown = await post("/mappings", W.paCookie, gBody);
  service.setMappingCommitForTests();
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.requestKey], [503, "outcome_unknown", gBody.requestKey]);
  assert.equal((await post("/mappings", W.paCookie, gBody)).status, 201);
  assert.equal(await mappingsOf(g.id), 1);
  // Rolled back by a deadlock PostgreSQL itself reports: a definite refusal - try_again, nothing written.
  const h = await field();
  service.setMappingCommitForTests({ fault: (client) => client.query("rollback").then(() => { throw dbError({ severity: "ERROR", code: "40P01", routine: "DeadLockReport" }); }), timeoutMs: 2_000 });
  const deadlock = await post("/mappings", W.paCookie, { requestKey: key(), sourceMetricId: h.id, metricDefinitionId: W.sys.id });
  service.setMappingCommitForTests();
  assert.deepEqual([deadlock.status, deadlock.body.error], [409, "try_again"]);
  assert.equal(await mappingsOf(h.id), 0);
});

test("12. every v35 refusal carries exactly one of the fixed messages, each produced here: no id, number, name or value; no v35 text reaches an HTTP answer", async () => {
  const own = new Set();
  const take = (res, code) => {
    assert.equal(res.ok, false, "a refusal");
    assert.equal(res.error.code, code, res.error.message);
    own.add(res.error.message);
  };
  const clubMapping = (f, actor) => (c) => T3(c, { f, md: W.clubAmd, scope: "club", clubId: W.clubA, by: actor });
  const f0 = await field();
  take(await tx(null, (c) => T3(c, { f: f0, md: W.sys, by: W.pa })), "42501");
  const f1 = await field();
  take(await tx(W.pa, (c) => T3(c, { f: f1, md: W.sys, by: W.pa2 })), "42501");
  const f2 = await field();
  take(await tx(W.coach, clubMapping(f2, W.coach)), "42501");
  const f3 = await field();
  take(await tx(W.caA, async (c) => {
    const m = await clubMapping(f3, W.caA)(c);
    await T8(c, { action: "mapping_create", m, by: W.caA, basis: "platform_admin" });
  }), "42501");
  const conv = (await one(k, `select id from training_load.unit_conversions limit 1`)).id;
  take(await tx(W.caA, (c) => ins(c, "source_metric_audit", { action: "unit_conversion_retire", unit_conversion_id: conv, from_status: "active", to_status: "retired", reason: "Test", performed_by_user_id: W.caA, basis: "platform_admin", operation_id: crypto.randomUUID() })), "42501");
  const earlier = await mappingOf(W.pa, W.sys);
  take(await tx(W.pa, (c) => T8(c, { action: "mapping_create", m: earlier.m, by: W.pa, basis: "platform_admin" })), "23514");
  const f4 = await field();
  take(await tx(W.pa, async (c) => {
    const m = await T3(c, { f: f4, md: W.sys, by: W.pa });
    await T8(c, { action: "mapping_create", m, by: W.pa, basis: "platform_admin" });
    await T8(c, { action: "mapping_create", m, by: W.pa, basis: "platform_admin" });
  }), "23514");
  const f5 = await field();
  take(await tx(W.pa, (c) => T3(c, { f: f5, md: W.sys, by: W.pa })), "23514");
  take(await tx(W.pa, (c) => T4(c, { ...earlier, by: W.pa })), "23514");
  const v = await versionOf(W.pa, earlier);
  take(await tx(W.pa, (c) => submitRow(c, v, W.pa, "platform_admin")), "23514");
  assert.deepEqual([...own].sort(), [...V35_MESSAGES].sort(), "every v35 refusal, each with exactly its fixed text");
  for (const m of own) assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}|[0-9]{3,}/i.test(m), `no id or number: ${m}`);
  for (const text of responses) assert.ok(!/acting user|audit row|source_metric_/.test(text), "no v35 text in an HTTP answer");
});

test("13. a club admin granted the platform admin role while its write runs repeats it (409 try_again, nothing written), because the database would derive platform_admin; the repeated request writes with that basis", async () => {
  const caP = await clubAdmin(W.clubA);
  await workspace(caP, "club", W.clubA);
  const cookie = await cookieFor(caP);
  const f = await field();
  const body = { requestKey: key(), sourceMetricId: f.id, metricDefinitionId: W.clubAmd.id };
  let granted = false;
  service.setMappingRightsHoldForTests(async () => {
    if (granted) return;
    granted = true;
    await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [caP]);
  });
  const first = await post("/mappings", cookie, body);
  service.setMappingRightsHoldForTests(null);
  assert.deepEqual([first.status, first.body.error], [409, "try_again"], first.text);
  assert.equal((await q(`select 1 from training_load.source_metric_mappings where source_metric_definition_id = $1`, [f.id])).length, 0, "nothing written");
  const again = await post("/mappings", cookie, body);
  assert.equal(again.status, 201, again.text);
  assert.equal((await one(k, `select basis from training_load.source_metric_audit where mapping_id = $1`, [again.body.mapping.id])).basis, "platform_admin");
});

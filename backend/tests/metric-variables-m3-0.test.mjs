// M3-0 - the canonical-variable admin API (backend/src/canonicalVariableAdminService.js,
// routes under /api/training-load/sources/metrics/variables) and migration v36, its
// durable request record (training_load.metric_variable_requests). Through the real
// HTTP stack, on disposable optimove_tests_gpexe_* databases only (never OPTIMOVE): one
// migrated through v35 that rehearses v36's apply / rollback / re-apply, one migrated
// through v36 for the behaviour. Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md,
// decisions C80-C88 and section J3.
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
import { writeRevision } from "./support/source-revisions.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V36 = "202610141000_training_load_v36_metric_variable_requests.sql";
const V36_NAME = `migrations_v2/${V36}`;
const UP_TO_V35 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V36));
const MIGRATION_PATH = path.resolve(ROOT, "migrations_v2", V36);
const ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/metric-variable-requests-v36-rollback.sql");
const V35_ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/source-metric-mapping-v35-rollback.sql");
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const ch = (cp) => String.fromCodePoint(cp);
const NO_ACTOR = /no acting user is set for this transaction/;
const OTHER_USER = /^metric variable request: the row names another user than the acting user$/;
const MAY_NOT = /^metric variable request: the acting user may not write this owner scope$/;
const BASIS = /^metric variable request: the basis is not the acting user's own$/;
const FOLLOW = /^metric_variable_requests: the request must follow its own operation in the same transaction$/;
const APPEND = /^metric_variable_requests: request records are append-only$/;

let rdb, db, r, k, server, apiBase, service, variables, dbModule, appPool, createSession;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};

async function applyV36(url) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v36-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of UP_TO_V35) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    await fsp.copyFile(MIGRATION_PATH, path.join(dir, V36));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

before(async () => {
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V36), "v36 is a test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v36rb", migrations: UP_TO_V35 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "m30" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  await r.connect();
  await k.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  assert.ok((await k.query(`select 1 from public.schema_migrations where migration_name = $1`, [V36_NAME])).rowCount === 1, "the behaviour database carries v36");
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.M30_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  variables = await import("../src/canonicalVariableAdminService.js");
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
  for (const g of openGates.splice(0)) g.open();
  service?.setMappingCommitForTests();
  service?.setMappingRightsHoldForTests(null);
  service?.setMappingRereadFaultForTests(null);
  variables?.setVariableWriteHoldForTests(null);
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
  for (const g of openGates.splice(0)) g.open();
  service.setMappingCommitForTests();
  service.setMappingRightsHoldForTests(null);
  service.setMappingRereadFaultForTests(null);
  variables.setVariableWriteHoldForTests(null);
});

// ---------------------------------------------------------------------------
// helpers
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const q = (sql, params) => rows(k, sql, params);
const key = () => crypto.randomUUID();

async function api(p, { method = "GET", body, cookie, base = PREFIX, contentType = "application/json" } = {}) {
  const res = await fetch(`${apiBase}${base}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": contentType }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  responses.push(text);
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, headers: res.headers, text };
}
const post = (p, cookie, body) => api(p, { method: "POST", cookie, body });
const vbody = (over = {}) => ({ requestKey: key(), label: `Total distance ${uid()}`, unit: "m", levels: ["session", "drill"], dailyAggregationMethod: "sum", ...over });
async function created(cookie, over = {}) {
  const res = await post("/variables", cookie, vbody(over));
  assert.equal(res.status, 201, res.text);
  return res.body.variable;
}
const versionBody = (variable, over = {}) => ({
  requestKey: key(), expectedCurrentVersionId: variable.currentVersion.id, unit: variable.currentVersion.unit,
  dailyAggregationMethod: variable.currentVersion.dailyAggregationMethod, ...over,
});

async function user(label, { active = true } = {}) {
  return (await one(k, `insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,$3) returning id`, [`${label}-${uid()}@test.local`, label, active])).id;
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
async function clubAdmin(clubId, { roleActive = true, active = true, ws = clubId } = {}) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',$3)`, [id, clubId, roleActive]);
  await workspace(id, "club", ws);
  const cookie = await cookieFor(id);
  if (!active) await k.query(`update public.users set is_active = false where id = $1`, [id]);
  return { id, cookie };
}
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const team = async (clubId) => (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;

// One transaction on `client` with the acting user set the way the service sets
// it (no actor: none set). Committed when fn succeeds; a refusal is returned.
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
// A raw label or state change of a system or club definition, as a fixture:
// since v38 the database records every such change with its acting user and
// rolls it back at COMMIT without its request row (R2, J3b.4), so the
// fixture writes it with v38's change trigger off, in one transaction.
async function rawDefinitionUpdate(sql, params) {
  await k.query("begin");
  try {
    await k.query(`alter table training_load.metric_definitions disable trigger metric_definitions_v38_record_change`);
    await k.query(sql, params);
    await k.query(`alter table training_load.metric_definitions enable trigger metric_definitions_v38_record_change`);
    await k.query("commit");
  } catch (error) {
    await k.query("rollback").catch(() => {});
    throw error;
  }
}
function refusedWith(res, code, pattern) {
  assert.equal(res.ok, false, `expected a refusal (${pattern})`);
  assert.equal(res.error.code, code, res.error.message);
  if (pattern) assert.match(res.error.message, pattern);
  return res.error;
}
const okTx = (res) => { assert.equal(res.ok, true, res.error ? `${res.error.code}: ${res.error.message}` : ""); return res.value; };
// A variable written with raw SQL (as the older catalog API writes one).
async function rawVariable(c, { scope = "system", clubId = null, teamId = null, by, label = "Raw variable", unit = "m", versions = 1, cd = null, state = "active" } = {}) {
  const defId = (await one(c, `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id, owner_team_id, created_by_user_id, state) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [`raw_${uid()}`, label, scope, clubId, teamId, by, state])).id;
  const verIds = [];
  for (let n = 1; n <= versions; n += 1) {
    verIds.push((await one(c, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, condition_description, created_by_user_id) values ($1,$2,$3,'numeric',$4,$5) returning id`, [defId, n, unit, cd, by])).id);
  }
  await c.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [verIds[verIds.length - 1], defId]);
  await c.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'session')`, [defId]);
  return { defId, verIds };
}
function rawRequest(c, { operation = "variable_create", defId, verId, by, basis = "platform_admin", scope = "system", clubId = null, requestKey = key() }) {
  return c.query(
    `insert into training_load.metric_variable_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_definition_id, metric_definition_version_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [requestKey, by, operation, "0".repeat(64), scope, clubId, basis, defId, verId],
  );
}

async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    tables: await rows(c, `select table_schema, table_name from information_schema.tables where table_schema in ${S} order by 1, 2`),
    columns: await rows(c, `select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ${S} order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, c.contype, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    indexes: await rows(c, `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ${S} order by 1, 2, 3`),
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
async function runScript(c, file) {
  const sql = await fsp.readFile(file, "utf8");
  try {
    await c.query(sql);
    return null;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    return e;
  }
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
const openGates = [];
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  const g = { promise, open };
  openGates.push(g);
  return g;
}
// Holds the FIRST write that reaches the hold point until the gate opens.
function holdFirst(where) {
  const g = gate();
  const state = { held: false };
  variables.setVariableWriteHoldForTests(async (_client, at) => {
    if (at !== where || state.held) return;
    state.held = true;
    await g.promise;
  });
  return { g, state };
}

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.clubC = await club("Club C");
  W.teamA = await team(W.clubA);
  W.pa = await platformAdmin();
  W.pa2 = await platformAdmin();
  W.paA = await platformAdmin(["club", W.clubA]);
  W.caA = await clubAdmin(W.clubA);
  W.caA2 = await clubAdmin(W.clubA);
  W.caB = await clubAdmin(W.clubB);
  W.caRevoked = await clubAdmin(W.clubA, { roleActive: false });
  W.caInactive = await clubAdmin(W.clubA, { active: false });
  W.caC = await clubAdmin(W.clubC);
  await k.query(`update public.clubs set is_active = false where id = $1`, [W.clubC]);
  const coachId = await user("coach");
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coachId, W.teamA]);
  await workspace(coachId, "team", W.teamA);
  W.coach = { id: coachId, cookie: await cookieFor(coachId) };
  const athleteId = await user("athlete");
  await k.query(`insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active) values ($1,$1,'Athlete','Only','Athlete Only','Athlete Only',$2,true)`, [`m30${uid()}`, athleteId]);
  await workspace(athleteId, "athlete", null);
  W.athlete = { id: athleteId, cookie: await cookieFor(athleteId) };
  W.paTeam = await platformAdmin();
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [W.paTeam.id, W.teamA]);
  await workspace(W.paTeam.id, "team", W.teamA);
  W.paPrivate = await platformAdmin();
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [W.paPrivate.id]);
  await workspace(W.paPrivate.id, "private_coach", null);
}

// ---------------------------------------------------------------------------
test("1. migration v36 on v35: one table (its checks, foreign keys and three uniques), two functions and three enabled triggers, nothing else changed; the rollback refuses without v36, under a later migration, with a request row, with a trigger missing or disabled; it returns the identical v35 catalog and v36 applies again identically; the v35 rollback refuses while v36 is recorded", async () => {
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v36 rollback refused: v36 is not recorded/);
  const before35 = await catalog(r);
  await applyV36(rdb.url);
  const after36 = await catalog(r);
  assert.ok(after36.migrations.includes(V36_NAME));
  const added = (list, base, keyOf) => list.filter((x) => !base.some((y) => keyOf(y) === keyOf(x)));
  assert.deepEqual(added(after36.tables, before35.tables, (x) => `${x.table_schema}.${x.table_name}`).map((x) => x.table_name), ["metric_variable_requests"]);
  assert.deepEqual(before35.tables, after36.tables.filter((x) => x.table_name !== "metric_variable_requests"));
  assert.deepEqual(before35.columns, after36.columns.filter((x) => x.table_name !== "metric_variable_requests"), "no existing column changed");
  assert.deepEqual(added(after36.columns, before35.columns, (x) => `${x.table_name}.${x.column_name}`).map((x) => x.column_name).sort(),
    ["basis", "created_at", "id", "metric_definition_id", "metric_definition_version_id", "operation", "owner_club_id", "owner_scope", "request_hash", "request_key", "requested_by_user_id"]);
  assert.deepEqual(added(after36.constraints, before35.constraints, (x) => `${x.rel}.${x.conname}`).map((x) => x.conname).sort(), [
    "metric_variable_requests_basis_check", "metric_variable_requests_basis_shape", "metric_variable_requests_hash_check",
    "metric_variable_requests_metric_definition_id_fkey", "metric_variable_requests_one_per_key", "metric_variable_requests_one_per_version",
    "metric_variable_requests_operation_check", "metric_variable_requests_owner_club_id_fkey", "metric_variable_requests_owner_scope_check",
    "metric_variable_requests_owner_shape", "metric_variable_requests_pkey", "metric_variable_requests_requested_by_user_id_fkey",
    "metric_variable_requests_version_fk",
  ]);
  assert.deepEqual(before35.constraints, after36.constraints.filter((x) => !x.rel.endsWith("metric_variable_requests")), "no existing constraint changed");
  assert.deepEqual(added(after36.indexes, before35.indexes, (x) => x.indexname).map((x) => x.indexname).sort(),
    ["metric_variable_requests_one_create_per_definition", "metric_variable_requests_one_per_key", "metric_variable_requests_one_per_version", "metric_variable_requests_pkey"]);
  assert.deepEqual(before35.indexes, after36.indexes.filter((x) => x.tablename !== "metric_variable_requests"));
  assert.deepEqual(added(after36.functions, before35.functions, (x) => x.proname).map((x) => x.proname).sort(),
    ["metric_variable_requests_append_only", "metric_variable_requests_insert_guard"]);
  assert.deepEqual(before35.functions, after36.functions.filter((x) => !x.proname.startsWith("metric_variable_requests_")), "no existing function changed (the v35 functions included)");
  const newTriggers = added(after36.triggers, before35.triggers, (x) => `${x.relname}.${x.tgname}`);
  assert.deepEqual(newTriggers.map((x) => x.tgname).sort(), ["metric_variable_requests_insert_guard", "metric_variable_requests_no_truncate", "metric_variable_requests_no_update_delete"]);
  for (const t of newTriggers) assert.equal(t.tgenabled, "O");
  assert.deepEqual(before35.triggers, after36.triggers.filter((x) => x.relname !== "metric_variable_requests"), "no existing trigger changed");
  // The v35 rollback refuses while v36 is recorded (v36 depends on its functions).
  assert.match((await runScript(r, V35_ROLLBACK_PATH))?.message ?? "", /^v35 rollback refused: later migrations are applied/);
  // Refusals of the v36 rollback, each changing nothing.
  await r.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/202610141001_training_load_v37_test_only.sql', $1, 'test')`, ["0".repeat(64)]);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v36 rollback refused: later migrations are applied/);
  await r.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/202610141001_training_load_v37_test_only.sql'`);
  await r.query(`alter table training_load.metric_variable_requests disable trigger metric_variable_requests_insert_guard`);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v36 rollback refused: a v36 trigger is disabled/);
  await r.query(`alter table training_load.metric_variable_requests enable trigger metric_variable_requests_insert_guard`);
  await r.query(`alter trigger metric_variable_requests_no_truncate on training_load.metric_variable_requests rename to v36_renamed`);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v36 rollback refused: the v36 triggers are not all present/);
  await r.query(`alter trigger v36_renamed on training_load.metric_variable_requests rename to metric_variable_requests_no_truncate`);
  // A real request row (written the way the service writes it) blocks the rollback.
  const by = (await one(r, `insert into public.users (email, full_name, display_name, is_active) values ($1,'pa','pa',true) returning id`, [`v36rb-${uid()}@test.local`])).id;
  await r.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [by]);
  okTx(await tx(by, async (c) => {
    const v = await rawVariable(c, { by });
    await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by });
  }, r));
  const withRow = await catalog(r);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v36 rollback refused: request records exist/);
  assert.deepEqual(await catalog(r), withRow, "every refusal changed nothing");
  // A clean rollback needs an empty table: rehearse it on the identical schema before any row.
  await r.query(`alter table training_load.metric_variable_requests disable trigger metric_variable_requests_no_update_delete`);
  await r.query(`delete from training_load.metric_variable_requests`);
  await r.query(`alter table training_load.metric_variable_requests enable trigger metric_variable_requests_no_update_delete`);
  assert.equal(await runScript(r, ROLLBACK_PATH), null);
  const back = await catalog(r);
  assert.deepEqual(back, before35, "the rollback returns the identical v35 catalog");
  await applyV36(rdb.url);
  assert.deepEqual(await catalog(r), after36, "v36 applies again identically");
});

test("2. the request guard: no actor setting, a setting of an earlier transaction (session-level SET) or one gone after COMMIT / ROLLBACK is 42501; another user than the acting one, an owner scope the actor may not write and a claimed basis that is not the derived one are 42501; a definition or version of another transaction, of another owner, not current, the wrong version number or a savepoint is 23514; the three uniques hold; the table is append-only", async () => {
  // No setting, and a session-level one left from an earlier transaction.
  refusedWith(await tx(null, async (c) => { const v = await rawVariable(c, { by: W.pa.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa.id }); }), "42501", NO_ACTOR);
  const lastXid = okTx(await tx(null, async (c) => (await one(c, `select pg_current_xact_id()::text as x`)).x));
  await k.query(`select set_config('optimove.source_metric_actor', $1, false)`, [`${W.pa.id}:${lastXid}`]);
  refusedWith(await tx(null, async (c) => { const v = await rawVariable(c, { by: W.pa.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa.id }); }), "42501", NO_ACTOR);
  await k.query(`reset optimove.source_metric_actor`);
  // The legitimate raw write, then nothing left after its COMMIT, nor after a ROLLBACK.
  okTx(await tx(W.pa.id, async (c) => { const v = await rawVariable(c, { by: W.pa.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa.id }); }));
  assert.equal((await one(k, `select current_setting('optimove.source_metric_actor', true) as v`)).v, "", "nothing left after the COMMIT");
  await k.query("begin");
  await k.query(CTX, [W.pa.id]);
  await k.query("rollback");
  assert.equal((await one(k, `select current_setting('optimove.source_metric_actor', true) as v`)).v, "", "nothing left after the ROLLBACK");
  refusedWith(await tx(null, async (c) => { const v = await rawVariable(c, { by: W.pa.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa.id }); }), "42501", NO_ACTOR);
  // Another user than the acting user.
  refusedWith(await tx(W.pa.id, async (c) => { const v = await rawVariable(c, { by: W.pa.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa2.id }); }), "42501", OTHER_USER);
  // An owner scope the actor may not write: a coach anywhere; a club admin for the system scope or another club; an archived club.
  refusedWith(await tx(W.coach.id, async (c) => { const v = await rawVariable(c, { scope: "club", clubId: W.clubA, by: W.coach.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.coach.id, scope: "club", clubId: W.clubA, basis: "club_admin" }); }), "42501", MAY_NOT);
  refusedWith(await tx(W.caA.id, async (c) => { const v = await rawVariable(c, { by: W.caA.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.caA.id }); }), "42501", MAY_NOT);
  refusedWith(await tx(W.caB.id, async (c) => { const v = await rawVariable(c, { scope: "club", clubId: W.clubA, by: W.caB.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.caB.id, scope: "club", clubId: W.clubA, basis: "club_admin" }); }), "42501", MAY_NOT);
  refusedWith(await tx(W.caC.id, async (c) => { const v = await rawVariable(c, { scope: "club", clubId: W.clubC, by: W.caC.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.caC.id, scope: "club", clubId: W.clubC, basis: "club_admin" }); }), "42501", MAY_NOT);
  refusedWith(await tx(W.caRevoked.id, async (c) => { const v = await rawVariable(c, { scope: "club", clubId: W.clubA, by: W.caRevoked.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.caRevoked.id, scope: "club", clubId: W.clubA, basis: "club_admin" }); }), "42501", MAY_NOT);
  // A claimed basis that is not the derived one (a club admin as a platform admin; a platform admin of club A as a club admin).
  refusedWith(await tx(W.caA.id, async (c) => { const v = await rawVariable(c, { scope: "club", clubId: W.clubA, by: W.caA.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.caA.id, scope: "club", clubId: W.clubA, basis: "platform_admin" }); }), "42501", BASIS);
  refusedWith(await tx(W.paA.id, async (c) => { const v = await rawVariable(c, { scope: "club", clubId: W.clubA, by: W.paA.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.paA.id, scope: "club", clubId: W.clubA, basis: "club_admin" }); }), "42501", BASIS);
  okTx(await tx(W.caA.id, async (c) => { const v = await rawVariable(c, { scope: "club", clubId: W.clubA, by: W.caA.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.caA.id, scope: "club", clubId: W.clubA, basis: "club_admin" }); }));
  // A definition written by another transaction (the older API's, or an earlier one).
  const earlier = okTx(await tx(null, (c) => rawVariable(c, { by: W.pa.id })));
  refusedWith(await tx(W.pa.id, (c) => rawRequest(c, { defId: earlier.defId, verId: earlier.verIds[0], by: W.pa.id })), "23514", FOLLOW);
  // Another owner than the request names.
  refusedWith(await tx(W.paA.id, async (c) => { const v = await rawVariable(c, { by: W.paA.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.paA.id, scope: "club", clubId: W.clubA }); }), "23514", FOLLOW);
  // A version that is not the current one; the wrong number for the operation.
  refusedWith(await tx(W.pa.id, async (c) => { const v = await rawVariable(c, { by: W.pa.id, versions: 2 }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa.id }); }), "23514", FOLLOW);
  refusedWith(await tx(W.pa.id, async (c) => { const v = await rawVariable(c, { by: W.pa.id, versions: 2 }); await rawRequest(c, { defId: v.defId, verId: v.verIds[1], by: W.pa.id }); }), "23514", FOLLOW);
  refusedWith(await tx(W.pa.id, async (c) => { const v = await rawVariable(c, { by: W.pa.id }); await rawRequest(c, { operation: "variable_version_create", defId: v.defId, verId: v.verIds[0], by: W.pa.id }); }), "23514", FOLLOW);
  // A version of an earlier transaction, repointed now (its definition is this transaction's, the version is not).
  const prior = okTx(await tx(null, (c) => rawVariable(c, { by: W.pa.id, versions: 2 })));
  refusedWith(await tx(W.pa.id, async (c) => {
    await c.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [prior.verIds[1], prior.defId]);
    await rawRequest(c, { operation: "variable_version_create", defId: prior.defId, verId: prior.verIds[1], by: W.pa.id });
  }), "23514", FOLLOW);
  // An archived definition.
  refusedWith(await tx(W.pa.id, async (c) => { const v = await rawVariable(c, { by: W.pa.id, state: "archived" }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa.id }); }), "23514", FOLLOW);
  // A version this transaction wrote in another user's name.
  refusedWith(await tx(W.pa.id, async (c) => { const v = await rawVariable(c, { by: W.pa2.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa.id }); }), "23514", FOLLOW);
  // A create whose definition this transaction wrote in another user's name (its version in the actor's).
  refusedWith(await tx(W.pa.id, async (c) => {
    const defId = (await one(c, `insert into training_load.metric_definitions (key, label, owner_scope, created_by_user_id) values ($1, 'Raw variable', 'system', $2) returning id`, [`raw_${uid()}`, W.pa2.id])).id;
    const verId = (await one(c, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, created_by_user_id) values ($1, 1, 'm', 'numeric', $2) returning id`, [defId, W.pa.id])).id;
    await c.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [verId, defId]);
    await rawRequest(c, { defId, verId, by: W.pa.id });
  }), "23514", FOLLOW);
  // ... and the other way round: the definition in the actor's name, its version in another user's.
  refusedWith(await tx(W.pa.id, async (c) => {
    const defId = (await one(c, `insert into training_load.metric_definitions (key, label, owner_scope, created_by_user_id) values ($1, 'Raw variable', 'system', $2) returning id`, [`raw_${uid()}`, W.pa.id])).id;
    const verId = (await one(c, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, created_by_user_id) values ($1, 1, 'm', 'numeric', $2) returning id`, [defId, W.pa2.id])).id;
    await c.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [verId, defId]);
    await rawRequest(c, { defId, verId, by: W.pa.id });
  }), "23514", FOLLOW);
  // Inside a savepoint (a subtransaction's rows): fail closed.
  refusedWith(await tx(W.pa.id, async (c) => {
    await c.query("savepoint s");
    const v = await rawVariable(c, { by: W.pa.id });
    await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa.id });
  }), "23514", FOLLOW);
  // The uniques: one per user and key, one per version, one create per definition.
  const dupKey = key();
  okTx(await tx(W.pa.id, async (c) => { const v = await rawVariable(c, { by: W.pa.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa.id, requestKey: dupKey }); }));
  const e1 = refusedWith(await tx(W.pa.id, async (c) => { const v = await rawVariable(c, { by: W.pa.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa.id, requestKey: dupKey }); }), "23505");
  assert.equal(e1.constraint, "metric_variable_requests_one_per_key");
  const e2 = refusedWith(await tx(W.pa.id, async (c) => { const v = await rawVariable(c, { by: W.pa.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa.id }); await rawRequest(c, { defId: v.defId, verId: v.verIds[0], by: W.pa.id }); }), "23505");
  // One version, one request: a second row for it breaks one of the two uniques (whichever is checked first).
  assert.ok(["metric_variable_requests_one_per_version", "metric_variable_requests_one_create_per_definition"].includes(e2.constraint), e2.constraint);
  // Append-only.
  const someRow = await one(k, `select id from training_load.metric_variable_requests limit 1`);
  refusedWith(await tx(null, (c) => c.query(`update training_load.metric_variable_requests set basis = basis where id = $1`, [someRow.id])), "23514", APPEND);
  refusedWith(await tx(null, (c) => c.query(`delete from training_load.metric_variable_requests where id = $1`, [someRow.id])), "23514", APPEND);
  refusedWith(await tx(null, (c) => c.query(`truncate training_load.metric_variable_requests`)), "23514", APPEND);
});

test("3. who may call: no session is 401; a team's coach and a platform admin in that team's workspace read the variables (R2, C99) but get the same 404 (no-store) on every admin-only route; an athlete, a platform admin in a private-coaching workspace, a revoked role and an archived club get it on every variable route; an inactive user has no session; a platform admin (platform and club workspace) and a club's own admin get 200", async () => {
  const routes = ["/variables", "/variables/key-suggestion?label=Total%20distance", `/variables/${crypto.randomUUID()}`];
  for (const p of routes) assert.equal((await api(p)).status, 401, p);
  assert.equal((await post("/variables", null, vbody())).status, 401);
  for (const who of [W.coach, W.athlete, W.paTeam, W.paPrivate, W.caRevoked, W.caC]) {
    // R2 (C99, J3b.3): a team's coach - a platform admin too, as that team's
    // coach (Q6) - reads the club's variables in the team workspace; the
    // key suggestion, an unknown id and the writes below stay the same 404.
    const teamReader = who === W.coach || who === W.paTeam;
    for (const p of routes) {
      const res = await api(p, { cookie: who.cookie });
      if (teamReader && p === "/variables") assert.equal(res.status, 200, `${p}: ${res.text}`);
      else assert.deepEqual([res.status, res.body], [404, { error: "notFound" }], `${p}: ${res.text}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual((await post("/variables", who.cookie, vbody())).body, { error: "notFound" });
    assert.equal((await post(`/variables/${crypto.randomUUID()}/versions`, who.cookie, { requestKey: key() })).status, 404);
  }
  assert.equal((await api("/variables", { cookie: W.caInactive.cookie })).status, 401);
  for (const who of [W.pa, W.paA, W.caA]) {
    const res = await api("/variables", { cookie: who.cookie });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  assert.equal((await api("/variables/key-suggestion?label=Total%20distance", { cookie: W.caA.cookie })).status, 200);
  // Unknown paths under the prefix: the same 404.
  assert.deepEqual((await api("/variables/x/y", { cookie: W.pa.cookie })).body, { error: "notFound" });
});

test("4. the body: a JSON object only; an unknown or a server-derived field (owner, actor, basis, value type, state, version number, levels as capabilities, ids) is invalid_body; the requestKey is a UUID; label, short label, description and key bounds; levels, aggregation and decimals checked; the unit is a token (invalid_unit); the condition takes only its three shapes (invalid_condition); the JavaScript unit rule agrees with the database's", async () => {
  const writtenBefore = (await one(k, `select count(*)::int as n from training_load.metric_variable_requests where requested_by_user_id = $1`, [W.pa.id])).n;
  const bad = async (over, code = "invalid_body", without = []) => {
    const body = vbody(over);
    for (const f of without) delete body[f];
    const res = await post("/variables", W.pa.cookie, body);
    assert.deepEqual([res.status, res.body.error], [400, code], `${JSON.stringify(over)} without ${without}: ${res.text}`);
  };
  for (const field of ["ownerScope", "ownerClubId", "ownerKey", "ownerUserId", "ownerTeamId", "createdByUserId", "requestedByUserId", "basis", "valueType", "state", "versionNumber", "currentVersionId", "scopeCapabilities", "id", "iconUrl", "extra"]) {
    await bad({ [field]: field === "valueType" ? "numeric" : "x" });
  }
  for (const missing of ["requestKey", "label", "unit", "levels", "dailyAggregationMethod"]) await bad({}, "invalid_body", [missing]);
  await bad({ requestKey: "not-a-uuid" });
  await bad({ label: "x".repeat(81) });
  await bad({ label: " leading" });
  await bad({ label: `bidi${ch(0x202e)}` });
  await bad({ label: `line${ch(0x2028)}break` });
  await bad({ shortLabel: "x".repeat(21) });
  await bad({ description: "x".repeat(501) });
  for (const k2 of ["Upper", "1abc", "a-b", "a".repeat(64), "", "ab c", "č"]) await bad({ key: k2 });
  for (const levels of [[], ["day"], ["session", "session"], "session", ["drill", "component"]]) await bad({ levels });
  // An inherited property name is no level (an `in` check would accept it and write a variable without levels).
  for (const levels of [["toString"], ["constructor"], ["__proto__"], ["hasOwnProperty"], ["session", "valueOf"], [["constructor"]], [1], [null]]) await bad({ levels });
  for (const agg of ["median", "", null]) await bad({ dailyAggregationMethod: agg });
  for (const value of [5, "1e3", "1.0000000001", "1234567890123", "+1", "1,5"]) await bad({ minValue: value });
  await bad({ minValue: "10", maxValue: "9.99" });
  for (const unit of ["", "km h", "a|b", "a=b", "x".repeat(31), `m${ch(0xa0)}`, `m${ch(0x200b)}`, 5]) await bad({ unit }, "invalid_unit");
  const cond = (c) => bad({ condition: c }, "invalid_condition");
  await cond("zone");
  await cond([]);
  await cond({ kind: "zone", operator: "between", lower: "7", upper: "7", unit: "m/s" });
  await cond({ kind: "zone", operator: "between", lower: "8", upper: "7", unit: "m/s" });
  await cond({ kind: "zone", operator: "between", value: "7", unit: "m/s" });
  await cond({ kind: "zone", operator: ">=", lower: "7", unit: "m/s" });
  await cond({ kind: "zone", operator: ">=", value: "7" });
  await cond({ kind: "zone", operator: ">=", value: "7", unit: "m s" });
  await cond({ kind: "zone", operator: ">=", value: 7, unit: "m/s" });
  await cond({ kind: "zone", operator: "==", value: "7", unit: "m/s" });
  await cond({ kind: "zone", operator: ">=", value: "7", unit: "m/s", extra: 1 });
  await cond({ kind: "event_threshold", operator: "between", value: "2", durationSeconds: "1", unit: "m/s2" });
  await cond({ kind: "event_threshold", operator: ">=", value: "2", unit: "m/s2" });
  await cond({ kind: "event_threshold", operator: ">=", value: "2", durationSeconds: "-1", unit: "m/s2" });
  await cond({ kind: "threshold", operator: ">=", value: "2", durationSeconds: "1", unit: "m/s2" });
  await cond({ operator: ">=", value: "7", unit: "m/s" });
  const notJson = await api("/variables", { method: "POST", cookie: W.pa.cookie, body: "label=x", contentType: "application/x-www-form-urlencoded" });
  assert.deepEqual([notJson.status, notJson.body.error], [415, "jsonRequired"]);
  assert.equal((await api("/variables", { method: "POST", cookie: W.pa.cookie, body: "[]" })).body.error, "invalid_body");
  // Nothing was written by any refusal.
  assert.equal((await one(k, `select count(*)::int as n from training_load.metric_variable_requests where requested_by_user_id = $1`, [W.pa.id])).n, writtenBefore);
  // The JavaScript unit rule and the database's agree.
  for (const unit of ["m", "km/h", "W/kg", "m/s2", "count", "%", "x".repeat(30), "x".repeat(31), "", "a b", "a|b", "a=b", `a${ch(0x9)}`, `a${ch(0xa0)}`, `a${ch(0x200b)}`, `a${ch(0x2028)}`, `a${ch(0x3000)}`, `a${ch(0xfeff)}`, `a${ch(0x85)}`, "č", "μs"]) {
    const dbOk = (await one(k, `select training_load.source_metric_unit_token_ok($1) as ok`, [unit])).ok === true;
    assert.equal(variables.unitTokenOk(unit), dbOk, `unit ${JSON.stringify(unit)}`);
  }
});

test("5. the key a name suggests: normalization, the combining marks removed, the Serbian Latin letters mapped (đ as dj), lower case, separators as one underscore, cut to 63; no transliteration of Cyrillic (key_required); the suggestion route says whether this owner already holds the key; a create without a key uses the suggestion; an explicit key of 1 character is valid", async () => {
  const s = variables.suggestVariableKey;
  assert.equal(s("Ukupna distanca"), "ukupna_distanca");
  assert.equal(s("Čćšžđ ČĆŠŽĐ"), "ccszdj_ccszdj");
  assert.equal(s("Sprint ≥ 25,2 km/h"), "sprint_25_2_km_h");
  assert.equal(s(`D${ch(0x17e)}ep ${ch(0x1c6)}ep`), "dzep_dzep");
  assert.equal(s("Brzina — maks. (km/h)"), "brzina_maks_km_h");
  assert.equal(s("Café crème"), "cafe_creme");
  assert.equal(s("Брзина"), null);
  assert.equal(s("Брзина max"), "max");
  assert.equal(s("25 m sprint"), null, "a key starts with a letter");
  assert.equal(s("  --  "), null);
  const long = s(`${"a".repeat(62)} bcd`);
  assert.equal(long, "a".repeat(62), "cut to 63 and a trailing underscore removed");
  assert.ok(s("x".repeat(80)).length === 63);
  assert.equal(s("a"), "a");
  const sug = await api(`/variables/key-suggestion?label=${encodeURIComponent("Ukupna distanca")}`, { cookie: W.pa.cookie });
  assert.deepEqual(sug.body, { key: "ukupna_distanca", taken: false });
  const made = await created(W.pa.cookie, { label: "Ukupna distanca" });
  assert.equal(made.key, "ukupna_distanca");
  assert.deepEqual((await api(`/variables/key-suggestion?label=${encodeURIComponent("Ukupna distanca")}`, { cookie: W.pa.cookie })).body, { key: "ukupna_distanca", taken: true });
  assert.deepEqual((await api(`/variables/key-suggestion?label=${encodeURIComponent("Ukupna distanca")}`, { cookie: W.caA.cookie })).body, { key: "ukupna_distanca", taken: false }, "club A's own scope is free");
  const cyr = await api(`/variables/key-suggestion?label=${encodeURIComponent("Брзина")}`, { cookie: W.pa.cookie });
  assert.deepEqual([cyr.status, cyr.body.error], [400, "key_required"]);
  for (const qs of ["", "?label=", `?label=${"x".repeat(81)}`, "?label=a&label=b", "?label=a&other=1"]) {
    assert.equal((await api(`/variables/key-suggestion${qs}`, { cookie: W.pa.cookie })).body.error, "invalid_query", qs);
  }
  const noKey = await post("/variables", W.pa.cookie, vbody({ label: "Брзина" }));
  assert.deepEqual([noKey.status, noKey.body.error], [400, "key_required"]);
  const withKey = await created(W.pa.cookie, { label: "Брзина", key: `brzina_${uid()}` });
  assert.equal(withKey.label, "Брзина");
  const single = await created(W.caB.cookie, { key: "z" });
  assert.equal(single.key, "z");
});

test("6. create: one transaction writes the definition (owner from the workspace, the acting user, active), its version 1 (numeric, the unit, exact bounds, the condition as JSON numbers), its levels (drill as component) and one request record (operation, owner, derived basis, hash); the answer has no actor id and a ready mapping target; a club admin writes its club, a platform admin in a club workspace writes that club", async () => {
  const label = `Sprint distance ${uid()}`;
  const res = await post("/variables", W.pa.cookie, vbody({
    label, shortLabel: "Sprint", description: "Distance above the sprint speed.", unit: "m", levels: ["drill", "session"], dailyAggregationMethod: "sum",
    minValue: "0", maxValue: "100000.5", condition: { kind: "zone", operator: ">=", value: "25.20", unit: "km/h" },
  }));
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.replayed, false);
  const v = res.body.variable;
  assert.deepEqual(Object.keys(v).sort(), ["actions", "createdAt", "currentVersion", "description", "editable", "icon", "id", "key", "label", "labelsToken", "levels", "mappingTarget", "ownerScope", "shortLabel", "state", "truncated", "updatedAt"]);
  assert.equal(v.icon, null, "no icon was chosen");
  assert.deepEqual([v.ownerScope, v.state, v.editable, v.levels, v.truncated], ["system", "active", true, ["session", "drill"], false]);
  assert.deepEqual(v.currentVersion.condition, { kind: "zone", operator: ">=", value: "25.2", unit: "km/h" });
  assert.deepEqual([v.currentVersion.versionNumber, v.currentVersion.unit, v.currentVersion.valueType, v.currentVersion.minValue, v.currentVersion.maxValue], [1, "m", "numeric", "0", "100000.5"]);
  assert.deepEqual(v.mappingTarget, { ready: true, notReadyCode: null });
  assert.ok(!res.text.includes(W.pa.id), "no acting user's id");
  const def = await one(k, `select owner_scope, owner_club_id, created_by_user_id, state, current_version_id, key, label, short_label, description from training_load.metric_definitions where id = $1`, [v.id]);
  assert.deepEqual(def, { owner_scope: "system", owner_club_id: null, created_by_user_id: W.pa.id, state: "active", current_version_id: v.currentVersion.id, key: v.key, label, short_label: "Sprint", description: "Distance above the sprint speed." });
  const ver = await one(k, `select version_number, unit, value_type, min_value::text as min, max_value::text as max, condition_description::text as cd, jsonb_typeof(condition_description -> 'value') as vt, (condition_description ->> 'value')::numeric = 25.2 as exact, daily_aggregation_method, created_by_user_id from training_load.metric_definition_versions where id = $1`, [v.currentVersion.id]);
  // The decimal arrives canonical ("25.20" is 25.2) and is stored as a JSON number through numeric.
  assert.deepEqual(ver, { version_number: 1, unit: "m", value_type: "numeric", min: "0", max: "100000.5", cd: '{"unit": "km/h", "value": 25.2, "operator": ">="}', vt: "number", exact: true, daily_aggregation_method: "sum", created_by_user_id: W.pa.id });
  assert.deepEqual((await q(`select scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 order by 1`, [v.id])).map((x) => x.scope_level), ["component", "session"]);
  const req = await q(`select operation, owner_scope, owner_club_id, basis, requested_by_user_id, metric_definition_version_id, request_hash ~ '^[0-9a-f]{64}$' as hashed from training_load.metric_variable_requests where metric_definition_id = $1`, [v.id]);
  assert.deepEqual(req, [{ operation: "variable_create", owner_scope: "system", owner_club_id: null, basis: "platform_admin", requested_by_user_id: W.pa.id, metric_definition_version_id: v.currentVersion.id, hashed: true }]);
  // The two other condition shapes, stored in exactly the M2 shapes (/targets normalizes them back).
  const between = await created(W.pa.cookie, { unit: "m", condition: { kind: "zone", operator: "between", lower: "25", upper: "60.0", unit: "W/kg" } });
  assert.equal((await one(k, `select condition_description::text as cd from training_load.metric_definition_versions where id = $1`, [between.currentVersion.id])).cd, '{"max": 60, "min": 25, "unit": "W/kg", "operator": "between"}');
  const threshold = await created(W.pa.cookie, { unit: "count", condition: { kind: "event_threshold", operator: "<=", value: "-2.5", durationSeconds: "0.5", unit: "m/s2" } });
  assert.deepEqual(threshold.currentVersion.condition, { kind: "event_threshold", operator: "<=", value: "-2.5", durationSeconds: "0.5", unit: "m/s2" });
  const targets = (await api("/targets", { cookie: W.pa.cookie })).body.targets;
  const t = targets.find((x) => x.id === threshold.id);
  assert.deepEqual([t.key, t.label, t.currentVersion.canonicalParameters], [threshold.key, threshold.label, { operator: "<=", value: "-2.5", duration_seconds: "0.5", unit: "m/s2" }]);
  assert.deepEqual(targets.find((x) => x.id === between.id).currentVersion.canonicalParameters, { operator: "between", lower: "25", upper: "60", unit: "W/kg" });
  // A club admin writes its club (basis club_admin); a platform admin in club A's workspace writes club A (basis platform_admin).
  const ca = await created(W.caA.cookie, { levels: ["session"] });
  assert.deepEqual([ca.ownerScope, ca.levels], ["club", ["session"]]);
  assert.deepEqual(await one(k, `select owner_club_id, basis from training_load.metric_variable_requests where metric_definition_id = $1`, [ca.id]), { owner_club_id: W.clubA, basis: "club_admin" });
  const pa = await created(W.paA.cookie);
  assert.deepEqual(await one(k, `select owner_club_id, basis from training_load.metric_variable_requests where metric_definition_id = $1`, [pa.id]), { owner_club_id: W.clubA, basis: "platform_admin" });
});

test("7. atomic: a failure between the definition's insert and the request record writes nothing; key_taken in the owner scope (the same key is free in another scope) writes nothing and consumes no requestKey", async () => {
  const before = await one(k, `select (select count(*) from training_load.metric_definitions)::int as d, (select count(*) from training_load.metric_definition_versions)::int as v, (select count(*) from training_load.metric_definition_scope_capabilities)::int as c, (select count(*) from training_load.metric_variable_requests)::int as r`);
  variables.setVariableWriteHoldForTests(async (client, at) => {
    if (at !== "variable_create") return;
    await client.query(`insert into training_load.metric_definitions (key, label, owner_scope) values ($1, 'Inside the write', 'system')`, [`inside_${uid()}`]);
    throw new Error("injected failure inside the write");
  });
  const failed = await post("/variables", W.pa.cookie, vbody());
  variables.setVariableWriteHoldForTests(null);
  assert.deepEqual([failed.status, failed.body], [500, { error: "internal_error", message: "Something went wrong." }]);
  const after = await one(k, `select (select count(*) from training_load.metric_definitions)::int as d, (select count(*) from training_load.metric_definition_versions)::int as v, (select count(*) from training_load.metric_definition_scope_capabilities)::int as c, (select count(*) from training_load.metric_variable_requests)::int as r`);
  assert.deepEqual(after, before, "nothing written");
  const taken = `taken_${uid()}`;
  await created(W.pa.cookie, { key: taken });
  const requestKey = key();
  const dup = await post("/variables", W.pa.cookie, vbody({ requestKey, key: taken }));
  assert.deepEqual([dup.status, dup.body.error], [409, "key_taken"]);
  assert.ok(!dup.text.includes("metric_definitions") && !dup.text.includes("violates"), "no database text");
  // The refused key was not consumed: the same requestKey with a free key creates.
  const reuse = await post("/variables", W.pa.cookie, vbody({ requestKey, key: `free_${uid()}` }));
  assert.equal(reuse.status, 201, reuse.text);
  assert.equal((await post("/variables", W.caA.cookie, vbody({ key: taken }))).status, 201, "the same key in another owner scope");
});

test("8. a new version: expectedCurrentVersionId is a precondition (current_version_changed names only the current version id and number); the version is immutable, repoints current, keeps key, owner and levels; a semantically equal version is version_unchanged (deterministic normalization, the reason not semantic); an archived variable is variable_not_active; another scope's variable is 404", async () => {
  const v = await created(W.pa.cookie, { unit: "m", minValue: "0", condition: { kind: "zone", operator: "between", lower: "7", upper: "8.5", unit: "m/s" } });
  const same = await post(`/variables/${v.id}/versions`, W.pa.cookie, versionBody(v, { minValue: "0.000", condition: { unit: "m/s", upper: "8.50", operator: "between", lower: "7.0", kind: "zone" }, reason: "Only the reason differs" }));
  assert.deepEqual([same.status, same.body.error], [409, "version_unchanged"]);
  // Only the condition differs: a real new version (on a twin variable, so the steps below keep their numbers).
  const twin = await created(W.pa.cookie, { unit: "m", minValue: "0", condition: { kind: "zone", operator: "between", lower: "7", upper: "8.5", unit: "m/s" } });
  const condOnly = await post(`/variables/${twin.id}/versions`, W.pa.cookie, versionBody(twin, { minValue: "0", condition: { kind: "zone", operator: "between", lower: "7", upper: "9", unit: "m/s" } }));
  assert.equal(condOnly.status, 201, condOnly.text);
  const boundsOnly = await post(`/variables/${twin.id}/versions`, W.pa.cookie, versionBody(condOnly.body.variable, { minValue: "1", condition: { kind: "zone", operator: "between", lower: "7", upper: "9", unit: "m/s" } }));
  assert.equal(boundsOnly.status, 201, "only minValue differs");
  const res = await post(`/variables/${v.id}/versions`, W.pa.cookie, versionBody(v, { unit: "km", dailyAggregationMethod: "max", reason: "Kilometres now." }));
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(Object.keys(res.body).sort(), ["replayed", "variable", "version"]);
  assert.deepEqual([res.body.version.versionNumber, res.body.version.unit, res.body.version.current, res.body.version.reason, res.body.version.condition], [2, "km", true, "Kilometres now.", null]);
  assert.deepEqual([res.body.variable.currentVersion.id, res.body.variable.key, res.body.variable.levels, res.body.variable.ownerScope], [res.body.version.id, v.key, v.levels, "system"]);
  const old = await one(k, `select unit from training_load.metric_definition_versions where id = $1`, [v.currentVersion.id]);
  assert.equal(old.unit, "m", "the old version is unchanged");
  assert.deepEqual(await one(k, `select operation, metric_definition_version_id from training_load.metric_variable_requests where metric_definition_version_id = $1`, [res.body.version.id]), { operation: "variable_version_create", metric_definition_version_id: res.body.version.id });
  // The old expected version again: the precondition fails, naming only the current version.
  const stale = await post(`/variables/${v.id}/versions`, W.pa.cookie, versionBody(v, { unit: "mm" }));
  assert.deepEqual([stale.status, stale.body.error, stale.body.current], [409, "current_version_changed", { versionId: res.body.version.id, versionNumber: 2 }]);
  // The body takes no key, label or levels.
  for (const field of ["key", "label", "levels", "ownerScope", "versionNumber"]) {
    assert.equal((await post(`/variables/${v.id}/versions`, W.pa.cookie, versionBody(res.body.variable, { [field]: "x" }))).body.error, "invalid_body", field);
  }
  assert.equal((await post(`/variables/${v.id}/versions`, W.pa.cookie, { requestKey: key(), unit: "m", dailyAggregationMethod: "sum" })).body.error, "invalid_body", "expectedCurrentVersionId is required");
  // An archived variable: variable_not_active. (The older catalog API no
  // longer archives a system or club variable - C98 - so the state is set
  // directly; no route archives a canonical variable yet.)
  const arch = await created(W.pa.cookie);
  await rawDefinitionUpdate(`update training_load.metric_definitions set state = 'archived' where id = $1`, [arch.id]);
  const na = await post(`/variables/${arch.id}/versions`, W.pa.cookie, versionBody(arch, { unit: "km" }));
  assert.deepEqual([na.status, na.body.error], [409, "variable_not_active"]);
  // Another scope: a system variable from a club workspace, a club A variable from club B or the platform workspace, an unknown or malformed id.
  const clubVar = await created(W.caA.cookie);
  for (const [who, id] of [[W.caA, v.id], [W.caB, clubVar.id], [W.pa, clubVar.id], [W.pa, crypto.randomUUID()], [W.pa, "not-a-uuid"]]) {
    assert.deepEqual((await post(`/variables/${id}/versions`, who.cookie, { requestKey: key(), expectedCurrentVersionId: crypto.randomUUID(), unit: "km", dailyAggregationMethod: "sum" })).body, { error: "notFound" });
  }
  assert.equal((await post(`/variables/${clubVar.id}/versions`, W.paA.cookie, versionBody(clubVar, { unit: "km" }))).status, 201, "a platform admin in club A's workspace versions club A's variable");
});

test("9. variable_pinned: a new version of a variable whose current version an active mapping version pins is refused with the stable code (the exact v34 guard), nothing written", async () => {
  const v = await created(W.pa.cookie, { unit: "m", levels: ["session"] });
  const def = await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Test field',$2) returning id`, [`m30.test.f${uid()}`, W.pa.id]);
  // Revision 1, verified and active, through the lifecycle's database path
  // (v39; backend/tests/support/source-revisions.mjs).
  const rev = { id: await writeRevision(k, {
    fieldId: def.id, by: W.pa.id, evidenceRef: COMPAT, unit: "m", unitRef: COMPAT, meaning: true, meaningRef: COMPAT,
  }) };
  const mapping = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: def.id, metricDefinitionId: v.id });
  assert.equal(mapping.status, 201, mapping.text);
  const mv = await post(`/mappings/${mapping.body.mapping.id}/versions`, W.pa.cookie, { requestKey: key(), sourceRevisionId: rev.id, appliesToSession: true, appliesToDrill: false });
  assert.equal(mv.status, 201, mv.text);
  assert.equal((await post(`/mappings/${mapping.body.mapping.id}/versions/${mv.body.version.id}/submit`, W.pa.cookie, { requestKey: key() })).status, 200);
  okTx(await tx(W.pa.id, async (c) => {
    await c.query(`update training_load.source_metric_mapping_versions set status = 'active', activated_by_user_id = $2, activated_at = now(), activated_basis = 'platform_admin' where id = $1`, [mv.body.version.id, W.pa.id]);
    await c.query(`insert into training_load.source_metric_audit (action, mapping_id, mapping_version_id, from_status, to_status, performed_by_user_id, basis, operation_id) values ('mapping_status',$1,$2,'needs_review','active',$3,'platform_admin',$4)`,
      [mapping.body.mapping.id, mv.body.version.id, W.pa.id, crypto.randomUUID()]);
  }));
  const versionsBefore = (await one(k, `select count(*)::int as n from training_load.metric_definition_versions where metric_definition_id = $1`, [v.id])).n;
  const pinned = await post(`/variables/${v.id}/versions`, W.pa.cookie, versionBody(v, { unit: "km" }));
  assert.deepEqual([pinned.status, pinned.body.error], [409, "variable_pinned"]);
  assert.ok(!pinned.text.includes("disable it first"), "no trigger text");
  assert.equal((await one(k, `select count(*)::int as n from training_load.metric_definition_versions where metric_definition_id = $1`, [v.id])).n, versionsBefore, "nothing written");
  // The classification is exactly the v34 guard's text, nothing broader.
  const guard = Object.assign(new Error("metric_definitions: an active mapping version pins the current version; disable it first"), { code: "23514" });
  assert.equal(variables.classifyVariableError(guard)?.code, "variable_pinned");
  assert.equal(variables.classifyVariableError(Object.assign(new Error("metric_definitions: an active mapping version pins the current version"), { code: "23514" })), null);
});

test("10. idempotency: the same user, key and body replays (200, the current state, nothing written twice); the same key with another body or the other operation is request_key_reused; a replay checks the right, the active workspace and the exact owner again (404 otherwise)", async () => {
  const body = vbody();
  const first = await post("/variables", W.caA.cookie, body);
  assert.equal(first.status, 201, first.text);
  const again = await post("/variables", W.caA.cookie, body);
  assert.deepEqual([again.status, again.body.replayed, again.body.variable.id], [200, true, first.body.variable.id]);
  assert.equal((await one(k, `select count(*)::int as n from training_load.metric_variable_requests where requested_by_user_id = $1 and request_key = $2`, [W.caA.id, body.requestKey])).n, 1);
  assert.equal((await one(k, `select count(*)::int as n from training_load.metric_definitions where key = $1`, [first.body.variable.key])).n, 1);
  // The replay answers the CURRENT state (a later version), not a stored body.
  const v2 = await post(`/variables/${first.body.variable.id}/versions`, W.caA.cookie, versionBody(first.body.variable, { unit: "km" }));
  assert.equal(v2.status, 201, v2.text);
  assert.equal((await post("/variables", W.caA.cookie, body)).body.variable.currentVersion.unit, "km");
  // Another body, the other operation: request_key_reused.
  assert.deepEqual((await post("/variables", W.caA.cookie, { ...body, label: `${body.label} changed` })).body.error, "request_key_reused");
  assert.deepEqual((await post(`/variables/${first.body.variable.id}/versions`, W.caA.cookie, versionBody(v2.body.variable, { requestKey: body.requestKey, unit: "mm" }))).body.error, "request_key_reused");
  // A version replay.
  const vb = versionBody(v2.body.variable, { unit: "cm" });
  const v3 = await post(`/variables/${first.body.variable.id}/versions`, W.caA.cookie, vb);
  assert.equal(v3.status, 201);
  const v3again = await post(`/variables/${first.body.variable.id}/versions`, W.caA.cookie, vb);
  assert.deepEqual([v3again.status, v3again.body.replayed, v3again.body.version.id, v3again.body.version.current], [200, true, v3.body.version.id, true]);
  assert.equal((await post(`/variables/${first.body.variable.id}/versions`, W.caA.cookie, { ...vb, unit: "dm" })).body.error, "request_key_reused", "a version's key with another body");
  // Another user with the same key is a new request of that user.
  const other = await post("/variables", W.caA2.cookie, { ...body, key: `other_${uid()}` });
  assert.equal(other.status, 201, other.text);
  // The right lost: the replay is the 404.
  const lost = await clubAdmin(W.clubA);
  const lostBody = vbody();
  assert.equal((await post("/variables", lost.cookie, lostBody)).status, 201);
  await k.query(`update public.user_club_roles set is_active = false where user_id = $1`, [lost.id]);
  assert.deepEqual((await post("/variables", lost.cookie, lostBody)).body, { error: "notFound" });
  // Another active workspace than the request's owner: the 404 (paA in club A, then in the platform workspace).
  const paBody = vbody();
  assert.equal((await post("/variables", W.paA.cookie, paBody)).status, 201);
  await workspace(W.paA.id, "platform", null);
  try {
    assert.deepEqual((await post("/variables", W.paA.cookie, paBody)).body, { error: "notFound" }, "a club request replayed from the platform workspace");
  } finally {
    await workspace(W.paA.id, "club", W.clubA);
  }
  assert.equal((await post("/variables", W.paA.cookie, paBody)).status, 200, "back in club A's workspace it replays");
});

test("11. concurrency: the same key and body twice at once (one 201, one replay); the same key with another body (one 201, one request_key_reused); two keys for one variable key (one 201, one key_taken); two new versions on one expected version (one 201, one current_version_changed)", async () => {
  const run = async (who, p, body) => post(p, who.cookie, body);
  // (a) the same key and body: the second waits on the user's advisory lock, then replays.
  {
    const { g, state } = holdFirst("variable_create");
    const body = vbody();
    const a = run(W.pa, "/variables", body);
    await until(() => state.held, "the first write held");
    const b = run(W.pa, "/variables", body);
    assert.ok(await someoneWaits(), "the second waits");
    g.open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status, rb.body.replayed], [201, 200, true]);
    assert.equal(ra.body.variable.id, rb.body.variable.id);
  }
  // (b) the same key, another body.
  {
    const { g, state } = holdFirst("variable_create");
    const body = vbody();
    const a = run(W.pa, "/variables", body);
    await until(() => state.held, "the first write held");
    const b = run(W.pa, "/variables", { ...body, label: `${body.label} other` });
    assert.ok(await someoneWaits(), "the second waits");
    g.open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status, rb.body.error], [201, 409, "request_key_reused"]);
  }
  // (c) two users, two keys, one variable key in the system scope.
  {
    const { g, state } = holdFirst("variable_create");
    const vkey = `race_${uid()}`;
    const a = run(W.pa, "/variables", vbody({ key: vkey }));
    await until(() => state.held, "the first write held");
    const rb = await run(W.pa2, "/variables", vbody({ key: vkey }));
    g.open();
    const ra = await a;
    assert.deepEqual([rb.status, ra.status, ra.body.error], [201, 409, "key_taken"]);
    assert.equal((await one(k, `select count(*)::int as n from training_load.metric_definitions where owner_scope = 'system' and key = $1`, [vkey])).n, 1);
  }
  // (d) two users, two new versions on one expected version: the second waits on the definition row.
  {
    const v = await created(W.pa.cookie);
    const { g, state } = holdFirst("variable_version_create");
    const a = run(W.pa, `/variables/${v.id}/versions`, versionBody(v, { unit: "km" }));
    await until(() => state.held, "the first version held");
    const b = run(W.pa2, `/variables/${v.id}/versions`, versionBody(v, { unit: "mm" }));
    assert.ok(await someoneWaits(), "the second waits on metric_definitions FOR UPDATE");
    g.open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status, rb.body.error, rb.body.current?.versionNumber], [201, 409, "current_version_changed", 2]);
    assert.equal((await one(k, `select count(*)::int as n from training_load.metric_definition_versions where metric_definition_id = $1`, [v.id])).n, 2);
  }
});

test("12. the COMMIT: a lost answer after a real COMMIT is verified by the request record (200, verified_after_commit_error, written once); a lost answer after a real rollback is 503 outcome_unknown and the same key then writes once; a deadlock answered by PostgreSQL is try_again with Retry-After; a read that fails after the COMMIT keeps 201 with readError and the variable id", async () => {
  const dbError = ({ severity, code, routine }) => {
    const e = new pg.DatabaseError("injected COMMIT answer", 0, "error");
    e.severity = severity;
    e.code = code;
    if (routine) e.routine = routine;
    return e;
  };
  const countOf = async (vkey) => (await one(k, `select count(*)::int as n from training_load.metric_definitions where key = $1`, [vkey])).n;
  const committed = vbody({ key: `commit_${uid()}` });
  service.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw dbError({ severity: "FATAL", code: "57P01", routine: "ProcessInterrupts" }); }), timeoutMs: 2_000 });
  const okRes = await post("/variables", W.pa.cookie, committed);
  service.setMappingCommitForTests();
  assert.deepEqual([okRes.status, okRes.body.commitConfirmation, okRes.body.variable?.key], [200, "verified_after_commit_error", committed.key]);
  assert.equal(await countOf(committed.key), 1);
  const rolled = vbody({ key: `rolled_${uid()}` });
  service.setMappingCommitForTests({ fault: (client) => client.query("rollback").then(() => { throw dbError({ severity: "FATAL", code: "57P01", routine: "ProcessInterrupts" }); }), timeoutMs: 2_000 });
  const unknown = await post("/variables", W.pa.cookie, rolled);
  service.setMappingCommitForTests();
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.requestKey], [503, "outcome_unknown", rolled.requestKey]);
  assert.equal(await countOf(rolled.key), 0);
  assert.equal((await post("/variables", W.pa.cookie, rolled)).status, 201);
  assert.equal(await countOf(rolled.key), 1);
  const deadlock = vbody({ key: `dead_${uid()}` });
  service.setMappingCommitForTests({ fault: (client) => client.query("rollback").then(() => { throw dbError({ severity: "ERROR", code: "40P01", routine: "DeadLockReport" }); }), timeoutMs: 2_000 });
  const dl = await post("/variables", W.pa.cookie, deadlock);
  service.setMappingCommitForTests();
  assert.deepEqual([dl.status, dl.body.error, dl.headers.get("retry-after")], [409, "try_again", "5"]);
  assert.equal(await countOf(deadlock.key), 0);
  // A new version's lost answer after a real COMMIT.
  const v = await created(W.pa.cookie);
  service.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw dbError({ severity: "ERROR", code: "XX000" }); }), timeoutMs: 2_000 });
  const vr = await post(`/variables/${v.id}/versions`, W.pa.cookie, versionBody(v, { unit: "km" }));
  service.setMappingCommitForTests();
  assert.deepEqual([vr.status, vr.body.commitConfirmation, vr.body.version?.versionNumber], [200, "verified_after_commit_error", 2]);
  // The read after a confirmed COMMIT fails: 201, readError, the variable id (the right confirmed first).
  service.setMappingRereadFaultForTests(async () => { throw new Error("injected read failure"); });
  const re = await post("/variables", W.pa.cookie, vbody());
  service.setMappingRereadFaultForTests(null);
  assert.equal(re.status, 201);
  assert.equal(re.body.readError, true);
  assert.match(re.body.variableId, /^[0-9a-f-]{36}$/);
  assert.equal(re.body.variable, undefined);
});

test("13. reads: the workspace's own variables (active by default, archived, all) in pages of 100 with an opaque cursor bound to owner, scope and state; the system variables as a read-only reference in a club workspace (never a mapping target); one variable with its versions; text cut to the output bounds is marked; an unsupported stored condition is only a marker; bad queries are invalid_query", async () => {
  // 101 club B variables, created through the older catalog shape (raw SQL), one archived.
  await k.query(`insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id, created_by_user_id, created_at)
                 select 'page_' || g, 'Page ' || g, 'club', $1, $2, now() + (g || ' milliseconds')::interval from generate_series(1, 101) g`, [W.clubB, W.caB.id]);
  await k.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) select id, 1, 'm', 'numeric' from training_load.metric_definitions where owner_club_id = $1 and key like 'page\\_%'`, [W.clubB]);
  await k.query(`update training_load.metric_definitions d set current_version_id = v.id from training_load.metric_definition_versions v where v.metric_definition_id = d.id and d.owner_club_id = $1 and d.key like 'page\\_%'`, [W.clubB]);
  await rawDefinitionUpdate(`update training_load.metric_definitions set state = 'archived' where owner_club_id = $1 and key = 'page_7'`, [W.clubB]);
  const all = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = await api(`/variables?state=all${cursor ? `&cursor=${cursor}` : ""}`, { cookie: W.caB.cookie });
    assert.equal(res.status, 200, res.text);
    all.push(...res.body.variables);
    cursor = res.body.nextCursor;
    pages += 1;
  } while (cursor && pages < 5);
  assert.equal(pages, 2);
  const pageKeys = all.map((x) => x.key).filter((x) => x.startsWith("page_"));
  assert.equal(pageKeys.length, 101);
  assert.equal(new Set(all.map((x) => x.id)).size, all.length, "no duplicate across pages");
  assert.ok(all.every((x) => x.ownerScope === "club" && x.editable === true));
  const active = (await api("/variables", { cookie: W.caB.cookie })).body;
  assert.ok(!active.variables.some((x) => x.key === "page_7") && active.nextCursor !== null);
  const archived = (await api("/variables?state=archived", { cookie: W.caB.cookie })).body;
  assert.deepEqual(archived.variables.map((x) => [x.key, x.state, x.mappingTarget]), [["page_7", "archived", { ready: false, notReadyCode: "target_not_active" }]]);
  // A cursor is bound to its scope and state; malformed queries.
  const firstAll = (await api("/variables?state=all", { cookie: W.caB.cookie })).body.nextCursor;
  for (const qs of [`?state=active&cursor=${firstAll}`, `?scope=system&state=all&cursor=${firstAll}`, "?cursor=abc", "?state=open", "?scope=team", "?other=1", "?state=all&state=active"]) {
    assert.equal((await api(`/variables${qs}`, { cookie: W.caB.cookie })).body.error, "invalid_query", qs);
  }
  assert.equal((await api(`/variables?state=all&cursor=${firstAll}`, { cookie: W.caA.cookie })).body.error, "invalid_query", "a cursor of another owner");
  // The system reference in a club workspace: read-only, never a mapping target; never another club's.
  const sys = await created(W.pa.cookie, { label: `Reference ${uid()}` });
  const ref = (await api("/variables?scope=system", { cookie: W.caA.cookie })).body.variables.find((x) => x.id === sys.id);
  assert.deepEqual([ref.editable, ref.mappingTarget], [false, { ready: false, notReadyCode: "target_scope_mismatch" }]);
  assert.ok(!(await api("/variables", { cookie: W.caA.cookie })).body.variables.some((x) => x.ownerScope !== "club"), "own scope only by default");
  assert.ok(!(await api("/variables?state=all", { cookie: W.caA.cookie })).body.variables.some((x) => x.key?.startsWith("page_")), "never another club's");
  const detailRef = await api(`/variables/${sys.id}`, { cookie: W.caA.cookie });
  assert.deepEqual([detailRef.status, detailRef.body.variable.editable], [200, false]);
  assert.equal((await api(`/variables/${sys.id}`, { cookie: W.caB.cookie })).status, 200, "every club reads the system reference");
  const clubAVar = await created(W.caA.cookie);
  assert.equal((await api(`/variables/${clubAVar.id}`, { cookie: W.caB.cookie })).status, 404);
  assert.equal((await api(`/variables/${clubAVar.id}`, { cookie: W.pa.cookie })).status, 404, "the platform workspace is the system scope");
  // One variable with its versions, the current one marked.
  const v2 = await post(`/variables/${clubAVar.id}/versions`, W.caA.cookie, versionBody(clubAVar, { unit: "km", reason: "Second." }));
  const detail = (await api(`/variables/${clubAVar.id}`, { cookie: W.caA.cookie })).body;
  assert.deepEqual(detail.variable.versions.map((x) => [x.versionNumber, x.current, x.reason]), [[2, true, "Second."], [1, false, null]]);
  assert.equal(detail.variable.currentVersion.id, v2.body.version.id);
  assert.equal(detail.nextCursor, null);
  // Text written by the older API beyond the output bounds is cut and marked; a 'day' level is not public; an unsupported condition is a marker.
  const longLabel = `L${"x".repeat(84)}`;
  const raw = okTx(await tx(null, (c) => rawVariable(c, { by: W.pa.id, label: longLabel, cd: JSON.stringify({ label: "fast", note: "secret-ish" }) })));
  await k.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'day')`, [raw.defId]);
  const rawOut = (await api(`/variables/${raw.defId}`, { cookie: W.pa.cookie }));
  assert.equal(rawOut.body.variable.label.length, 80);
  assert.equal(rawOut.body.variable.truncated, true);
  assert.deepEqual(rawOut.body.variable.levels, ["session"]);
  assert.deepEqual(rawOut.body.variable.currentVersion.condition, { kind: "unsupported" });
  assert.ok(!rawOut.text.includes("secret-ish") && !rawOut.text.includes("fast"), "never the stored condition");
  const target = (await api("/targets", { cookie: W.pa.cookie })).body.targets.find((x) => x.id === raw.defId);
  assert.deepEqual([target.label.length, target.truncated], [80, true]);
});

test("14. the acting user: the admin API sets the transaction-local setting from the session (the request row names the session's user, the database having checked it); no pool client carries a setting after the writes", async () => {
  const res = await created(W.caA.cookie);
  assert.equal((await one(k, `select requested_by_user_id from training_load.metric_variable_requests where metric_definition_id = $1`, [res.id])).requested_by_user_id, W.caA.id);
  const clients = [];
  try {
    for (let i = 0; i < Math.max(1, appPool.totalCount); i += 1) clients.push(await appPool.connect());
    for (const c of clients) assert.equal((await c.query(`select current_setting('optimove.source_metric_actor', true) as v`)).rows[0].v ?? "", "", "no setting left on a pool client");
  } finally {
    for (const c of clients) c.release();
  }
});

test("15. compatibility (C98, superseding part of C82): the older /api/training-load/metrics catalog API refuses to create or version a system variable (409 canonical_variable_read_only, nothing written) and still creates and versions a team definition without a request row or an actor; a team-owned definition (the GPEXE writer's shape) is written without either; its GET lists the admin API's variables; only the three known modules write Metrics Core definitions and only the admin service writes request records", async () => {
  const counts = async () => one(k, `select (select count(*) from training_load.metric_definitions)::int as d, (select count(*) from training_load.metric_definition_versions)::int as v, (select count(*) from training_load.metric_variable_requests)::int as r`);
  const before = await counts();
  const oldCreate = await api("/definitions", { method: "POST", cookie: W.pa.cookie, base: "/api/training-load/metrics", body: { key: `old_${uid()}`, label: "Old API", valueType: "numeric", unit: "m", ownerScope: "system", scopeCapabilities: ["session"] } });
  assert.deepEqual([oldCreate.status, oldCreate.body.code], [409, "canonical_variable_read_only"], oldCreate.text);
  const adminMade = await created(W.pa.cookie);
  const oldVersion = await api(`/definitions/${adminMade.id}/versions`, { method: "POST", cookie: W.pa.cookie, base: "/api/training-load/metrics", body: { valueType: "numeric", unit: "km" } });
  assert.deepEqual([oldVersion.status, oldVersion.body.code], [409, "canonical_variable_read_only"], oldVersion.text);
  const after = await counts();
  assert.deepEqual(after, { d: before.d + 1, v: before.v + 1, r: before.r + 1 }, "only the admin API's own create was written");
  const teamCreate = await api("/definitions", { method: "POST", cookie: W.pa.cookie, base: "/api/training-load/metrics", body: { key: `old_team_${uid()}`, label: "Old API team", valueType: "numeric", unit: "m", ownerScope: "team", ownerTeamId: W.teamA, scopeCapabilities: ["session"] } });
  assert.equal(teamCreate.status, 201, teamCreate.text);
  assert.equal((await api(`/definitions/${teamCreate.body.row.id}/versions`, { method: "POST", cookie: W.pa.cookie, base: "/api/training-load/metrics", body: { valueType: "numeric", unit: "km" } })).status, 201);
  assert.equal((await one(k, `select count(*)::int as n from training_load.metric_variable_requests where metric_definition_id = $1`, [teamCreate.body.row.id])).n, 0);
  okTx(await tx(null, (c) => rawVariable(c, { scope: "team", teamId: W.teamA, by: W.pa.id, label: "GPEXE team-owned" })));
  const made = await created(W.pa.cookie, { label: `Visible ${uid()}` });
  const list = await api(`/definitions?search=${encodeURIComponent(made.label)}`, { cookie: W.pa.cookie, base: "/api/training-load/metrics" });
  assert.equal(list.status, 200);
  assert.ok(list.body.rows.some((x) => x.id === made.id), "the older read lists it");
  // Architecture: the writers.
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join, relative } = await import("node:path");
  const src = path.resolve(ROOT, "backend/src");
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".js") || e.name.endsWith(".mjs")) files.push(join(dir, e.name));
    }
  };
  walk(src);
  const writes = (table) => new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+training_load\\.${table}\\b`, "i");
  const writers = (table) => files.filter((f) => writes(table).test(readFileSync(f, "utf8"))).map((f) => relative(src, f).replace(/\\/g, "/")).sort();
  assert.deepEqual(writers("metric_definitions"), ["canonicalVariableAdminService.js", "gpexeImportWriter.js", "trainingLoadMetricsCatalog.js"]);
  assert.deepEqual(writers("metric_definition_versions"), ["canonicalVariableAdminService.js", "gpexeImportWriter.js", "trainingLoadMetricsCatalog.js"]);
  assert.deepEqual(writers("metric_variable_requests"), ["canonicalVariableAdminService.js"]);
});

test("16. the right is checked again under FOR SHARE inside the write: a club admin whose role is revoked after the request began gets the identical 404 and nothing is written - a create and a new version alike", async () => {
  const lose = await clubAdmin(W.clubA);
  const v = await created(lose.cookie);
  const counts = async () => one(k, `select (select count(*) from training_load.metric_definitions)::int as d, (select count(*) from training_load.metric_definition_versions)::int as v, (select count(*) from training_load.metric_variable_requests)::int as r`);
  const before = await counts();
  service.setMappingRightsHoldForTests(async () => {
    await k.query(`update public.user_club_roles set is_active = false where user_id = $1`, [lose.id]);
  });
  const c = await post("/variables", lose.cookie, vbody());
  assert.deepEqual([c.status, c.body], [404, { error: "notFound" }]);
  service.setMappingRightsHoldForTests(null);
  await k.query(`update public.user_club_roles set is_active = true where user_id = $1`, [lose.id]);
  service.setMappingRightsHoldForTests(async () => {
    await k.query(`update public.user_club_roles set is_active = false where user_id = $1`, [lose.id]);
  });
  const nv = await post(`/variables/${v.id}/versions`, lose.cookie, versionBody(v, { unit: "km" }));
  assert.deepEqual([nv.status, nv.body], [404, { error: "notFound" }]);
  service.setMappingRightsHoldForTests(null);
  assert.deepEqual(await counts(), before, "nothing written");
});

test("17. no answer and no log line carries SQL, a trigger's or the database's text, a body's label or an acting user's id", async () => {
  const marker = `Secret label ${uid()}`;
  await created(W.pa.cookie, { label: marker });
  for (const text of responses) {
    for (const needle of ["metric_variable_requests", "training_load.", "violates", "SQLSTATE", "source metric mapping:", "metric variable request:", "duplicate key"]) {
      assert.ok(!text.includes(needle), `an answer carries ${needle}: ${text.slice(0, 200)}`);
    }
  }
  assert.ok(!logLines.some((l) => l.includes(marker)), "no log line carries a body's label");
  for (const l of logLines) for (const id of [W.pa.id, W.caA.id]) assert.ok(!l.includes(id), "no log line carries an acting user's id");
});

test("18. iconKey at create (Data configuration visual polish, PR-1): only a key of the icon library, stored as icon:<key>; no alias, stored value, URL or other type (invalid_body, nothing written); a create without it hashes exactly as before (the replay of an older request keeps its answer); an icon joins the hash only when sent; the reads give the key, and nothing for any other stored value", async () => {
  // The request hash of a create as it was before the icon existed (C87): the
  // same contract, operation and body fields, in the same order.
  const oldHash = (b) => crypto.createHash("sha256").update(JSON.stringify({
    contract: "metric-variables/v1", operation: "variable_create",
    body: {
      label: b.label, shortLabel: b.shortLabel ?? null, description: b.description ?? null, key: b.key ?? null, unit: b.unit,
      levels: ["session", "drill"].filter((l) => b.levels.includes(l)), dailyAggregationMethod: b.dailyAggregationMethod,
      minValue: null, maxValue: null, condition: null,
    },
  }), "utf8").digest("hex");
  const hashOfVariable = async (id) => (await one(k, `select request_hash from training_load.metric_variable_requests where metric_definition_id = $1`, [id])).request_hash;
  const counts = async () => one(k, `select (select count(*) from training_load.metric_definitions)::int as d, (select count(*) from training_load.metric_variable_requests)::int as r`);

  // Without an icon (absent or null): the old hash, no icon stored, icon null.
  const plainBody = vbody({ shortLabel: "Dist" });
  const plain = await post("/variables", W.pa.cookie, plainBody);
  assert.equal(plain.status, 201, plain.text);
  assert.equal(await hashOfVariable(plain.body.variable.id), oldHash(plainBody));
  assert.equal(plain.body.variable.icon, null);
  assert.equal((await one(k, `select icon_url from training_load.metric_definitions where id = $1`, [plain.body.variable.id])).icon_url, null);
  const nullBody = vbody({ iconKey: null });
  const withNull = await post("/variables", W.pa.cookie, nullBody);
  assert.equal(withNull.status, 201, withNull.text);
  assert.equal(await hashOfVariable(withNull.body.variable.id), oldHash(nullBody));
  // The very request replays with its answer.
  const replay = await post("/variables", W.pa.cookie, plainBody);
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.variable.id], [200, true, plain.body.variable.id]);

  // With an icon: stored as icon:<key>, given back as the key, and in the hash.
  const iconBody = vbody({ iconKey: "run" });
  const withIcon = await post("/variables", W.pa.cookie, iconBody);
  assert.equal(withIcon.status, 201, withIcon.text);
  assert.equal(withIcon.body.variable.icon, "run");
  assert.equal((await one(k, `select icon_url from training_load.metric_definitions where id = $1`, [withIcon.body.variable.id])).icon_url, "icon:run");
  assert.notEqual(await hashOfVariable(withIcon.body.variable.id), oldHash(iconBody), "the icon is part of the hash");
  assert.deepEqual([(await post("/variables", W.pa.cookie, iconBody)).status], [200], "the same request replays");
  const other = await post("/variables", W.pa.cookie, { ...iconBody, iconKey: "bike" });
  assert.deepEqual([other.status, other.body.error], [409, "request_key_reused"], "another icon under the same key is another request");
  const without = await post("/variables", W.pa.cookie, { ...iconBody, iconKey: undefined });
  assert.deepEqual([without.status, without.body.error], [409, "request_key_reused"], "dropping the icon is another request too");
  // A club admin's create takes an icon as well.
  assert.equal((await created(W.caA.cookie, { iconKey: "heart-rate" })).icon, "heart-rate");

  // Anything but a key of the library: invalid_body, nothing written.
  const before = await counts();
  for (const iconKey of ["dumbbell", "icon:run", "RUN", " run", "run ", "no-such-icon", "", "constructor", "__proto__", "toString", "https://example.test/i.svg", `<svg onload="x">`, 5, true, ["run"], { key: "run" }]) {
    const res = await post("/variables", W.pa.cookie, vbody({ iconKey }));
    assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], JSON.stringify(iconKey));
  }
  assert.deepEqual(await counts(), before, "nothing written");
  // A new version takes no icon.
  const nv = await post(`/variables/${withIcon.body.variable.id}/versions`, W.pa.cookie, versionBody(withIcon.body.variable, { unit: "km", iconKey: "bike" }));
  assert.deepEqual([nv.status, nv.body.error], [400, "invalid_body"]);

  // The reads: the list and the detail give the key; any other stored value
  // (an older URL, an alias, an unknown key, a value without the prefix) gives null.
  const list = (await api("/variables?state=all", { cookie: W.pa.cookie })).body.variables;
  assert.equal(list.find((x) => x.id === withIcon.body.variable.id).icon, "run");
  assert.equal((await api(`/variables/${withIcon.body.variable.id}`, { cookie: W.pa.cookie })).body.variable.icon, "run");
  for (const stored of ["/assets/icons/metric-default.svg", "icon:dumbbell", "icon:no-such-icon", "run", "icon:", "icon:run "]) {
    // Planted with v45's change trigger off: since v45 an icon update needs its
    // acting user and request row, as a rename does (J3b.11).
    await k.query("begin");
    await k.query("set local session_replication_role = replica");
    await k.query(`update training_load.metric_definitions set icon_url = $1 where id = $2`, [stored, plain.body.variable.id]);
    await k.query("commit");
    const read = (await api(`/variables/${plain.body.variable.id}`, { cookie: W.pa.cookie })).body.variable;
    assert.equal(read.icon, null, stored);
    assert.ok(!JSON.stringify(read).includes(stored === "run" ? "\"run\"" : stored), `the stored ${stored} is never sent`);
  }
});

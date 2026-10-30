// Phase 7b - activating, replacing and disabling a mapping version (A1 / A2 under
// /api/training-load/sources/metrics/mappings/:mappingId/versions/:versionId), the
// revision lifecycle's pinned step for an active version, and migration v43 (G1, G2).
// Contract: docs/ai/phase7b-mapping-transitions-contract.md (J8, C104), section 8.
// Through the real HTTP stack, on disposable optimove_tests_gpexe_* databases only
// (never OPTIMOVE, never a real GPEXE field): one migrated through v42 that rehearses
// v43 (the preflight, the runner, the post-check, every refusal of the rollback, the
// rollback back to v42's exact catalog, and v43 again), and one migrated through v43
// for the behaviour. Every field, variable and mapping here is a test row of this file;
// the seeded rest_v1 fields are never touched.
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
import { createConversion, retireConversion as retireConversionRow, retireConversionStatements } from "./support/unit-conversions.mjs";
import { allowSyntheticTestFields } from "./support/test-extractors.mjs";

allowSyntheticTestFields();

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V43 = "202610291430_training_load_v43_source_metric_mapping_transitions.sql";
const V43_NAME = `migrations_v2/${V43}`;
const V42_NAME = "migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql";
const UP_TO_V42 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V43));
const V43_FILE = path.resolve(ROOT, "migrations_v2", V43);
const RUNBOOKS = path.resolve(ROOT, "docs/runbooks");
const ROLLBACK = path.join(RUNBOOKS, "source-metric-mapping-transitions-v43-rollback.sql");
const PREFLIGHT = path.join(RUNBOOKS, "source-metric-mapping-transitions-v43-preflight.sql");
const POSTCHECK = path.join(RUNBOOKS, "source-metric-mapping-transitions-v43-postcheck.sql");
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const PINNED_REASON = "Source revision retired.";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const G1_REPLACED = /^source_metric_audit: a replacement records the disable of the version it replaces in its own operation$/;
const G1_ACTIVATION = /^source_metric_audit: an activation that disables another version of its mapping is recorded as a replacement$/;
const G2_REASON = /^source_metric_audit: a disable row carries its version's disable reason$/;
const G2_PERFORMED = /^source_metric_audit: a transition row carries its transaction's time$/;
const G2_TIME = /^source_metric_audit: a transition's time lies within its own transaction$/;

let rdb, db, r, k, server, apiBase, service, lifecycle, variables, dbModule, appPool, createSession;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};

async function migrate(url, files) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v43-migrations-"));
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
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V43), "v43 is a test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v43rb", migrations: UP_TO_V42 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v43" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  await r.connect();
  await k.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.V43_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  lifecycle = await import("../src/sourceRevisionLifecycleService.js");
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
  resetSeams();
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

function resetSeams() {
  service?.setMappingCommitForTests();
  service?.setMappingRightsHoldForTests(null);
  service?.setMappingRereadFaultForTests(null);
  service?.setMappingWriteHoldForTests(null);
  service?.setMappingTransitionAuditFaultForTests(null);
  lifecycle?.setRevisionWriteHoldForTests(null);
  variables?.setVariableWriteHoldForTests(null);
}
afterEach(() => {
  for (const g of openGates.splice(0)) g.open();
  resetSeams();
});

// ---------------------------------------------------------------------------
// helpers
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const key = () => crypto.randomUUID();

async function api(p, { method = "GET", body, cookie, contentType = "application/json", base = PREFIX } = {}) {
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
const actPath = (v) => `/mappings/${v.mappingId}/versions/${v.versionId}/activate`;
const disPath = (v) => `/mappings/${v.mappingId}/versions/${v.versionId}/disable`;
// Every reason sent through these two helpers; test 17 scans every answer and log line for them.
const sentReasons = new Set();
const activate = (v, cookie, { expected = null, reason, requestKey = key() } = {}) => {
  if (typeof reason === "string") sentReasons.add(reason);
  return post(actPath(v), cookie, { requestKey, expectedActiveVersionId: expected, ...(reason === undefined ? {} : { reason }) });
};
const disable = (v, cookie, { expectedStatus, reason = "Wrong mapping.", requestKey = key() } = {}) => {
  sentReasons.add(reason);
  return post(disPath(v), cookie, { requestKey, expectedStatus, reason });
};

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
async function clubAdmin(clubId) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await workspace(id, "club", clubId);
  return { id, cookie: await cookieFor(id) };
}
async function teamCoach(clubId, { platformAdmin: alsoPlatformAdmin = false } = {}) {
  const teamId = (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
  const id = await user("coach");
  if (alsoPlatformAdmin) await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await workspace(id, "team", teamId);
  return { id, cookie: await cookieFor(id) };
}
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;

// A canonical variable through the M3-0 API (numeric, both levels).
async function variable(owner, over = {}) {
  const res = await post("/variables", owner.cookie, { requestKey: key(), label: `Transition variable ${uid()}`, unit: "s", levels: ["session", "drill"], dailyAggregationMethod: "sum", ...over });
  assert.equal(res.status, 201, res.text);
  const id = res.body.variable.id;
  return { id, currentVersionId: (await one(k, `select current_version_id from training_load.metric_definitions where id = $1`, [id])).current_version_id };
}
// A test field of gpexe / rest_v1 whose revision 1 is active and, by default, verified.
async function field({ unit = "s", verified = true, kind = "none", boundUnit = null, operator = null, state = "active" } = {}) {
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'7b test field',$2) returning id`,
    [`v43.test.f${uid()}`, W.pa.id])).id;
  const shape = kind === "zone_bounds" ? "zone_distance" : kind === "event_threshold" ? "event_count" : "number";
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: shape, parameterKind: kind, evidenceRef: COMPAT, unit, boundUnit, unitRef: UNIT_REF, meaning: verified, operator, meaningRef: MEANING_REF, state });
  return { fieldId, revId };
}
const revisionOf = (f, n, over = {}) => writeRevision(k, { fieldId: f.fieldId, by: W.pa.id, revisionNumber: n, evidenceRef: COMPAT, unit: "s", unitRef: UNIT_REF, meaning: true, meaningRef: MEANING_REF, state: "draft", ...over });
// A mapping version of field `f` to `variable`, through the real M2 routes; submitted unless asked otherwise.
async function version(f, { owner = W.pa, target = W.sysVar, submit = true, revId = f.revId, body = {} } = {}) {
  let mappingId = (await one(k, `select id from training_load.source_metric_mappings where source_metric_definition_id = $1 and metric_definition_id = $2`, [f.fieldId, target.id]))?.id;
  if (!mappingId) {
    const m = await post("/mappings", owner.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id });
    assert.equal(m.status, 201, m.text);
    mappingId = m.body.mapping.id;
  }
  const v = await post(`/mappings/${mappingId}/versions`, owner.cookie, { requestKey: key(), sourceRevisionId: revId, appliesToSession: true, appliesToDrill: true, ...body });
  assert.equal(v.status, 201, v.text);
  if (submit) assert.equal((await post(`/mappings/${mappingId}/versions/${v.body.version.id}/submit`, owner.cookie, { requestKey: key() })).status, 200);
  return { mappingId, versionId: v.body.version.id };
}
const versionRow = (id) => one(k, `select * from training_load.source_metric_mapping_versions where id = $1`, [id]);
const statusOf = async (v) => (await versionRow(v.versionId)).status;
const auditOf = (sql, params) => rows(k, `select * from training_load.source_metric_audit where ${sql} order by performed_at, id`, params);
const ok200 = (res) => { assert.equal(res.status, 200, res.text); return res.body; };
const refused = (res, status, code) => { assert.deepEqual([res.status, res.body.error], [status, code], res.text); return res.body; };
const isNotFound = (res, label) => { assert.equal(res.status, 404, `${label}: ${res.text}`); assert.deepEqual(res.body, { error: "notFound" }, label); };
// An active version on its own (A1 through the route).
async function activeVersion(f, opts = {}) {
  const v = await version(f, opts);
  ok200(await activate(v, opts.admin?.cookie ?? W.pa.cookie));
  return v;
}

// One transaction on `client` with the acting user set the way the services set it.
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
  return res.error;
}
const okTx = (res) => { assert.equal(res.ok, true, res.error ? `${res.error.code}: ${res.error.message}` : ""); return res.value; };
// Triggers off for these statements only (session_replication_role), as phase 7d's
// writers or a future migration would write: a disposable database only.
async function asLaterPhase(sql, params) {
  assert.equal((await one(k, `select rolsuper from pg_roles where rolname = current_user`)).rolsuper, true, "this simulation needs a superuser on the disposable database");
  await k.query("begin");
  try {
    await k.query("set local session_replication_role = replica");
    const res = await k.query(sql, params);
    await k.query("commit");
    return res;
  } catch (error) {
    await k.query("rollback").catch(() => {});
    throw error;
  }
}
// An open T5 activation of version v, written raw (phase 7d's start has its own
// suite, mapping-activations-7d.test.mjs): a real team (the activation_end
// audit row of its end references it), a binding id that names no binding.
async function openActivation(v) {
  const row = await versionRow(v.versionId);
  const teamId = (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [W.clubA, `Team ${uid()}`])).id;
  return (await asLaterPhase(`insert into training_load.source_metric_mapping_activations (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, source_team_binding_id, team_id,
                        applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
                      values ($1,$2,$3,$4,$5,$6,$7,true,true,'required',$8,'platform_admin','Phase 7d simulation') returning id`,
  [v.versionId, v.mappingId, row.source_metric_definition_id, row.metric_definition_id, row.parameter_fingerprint, crypto.randomUUID(), teamId, W.pa.id])).rows[0].id;
}
// How an activation ended: [end_reason, ended_basis], and its activation_end row's reason.
async function endOf(activationId) {
  const a = await one(k, `select end_reason, ended_basis from training_load.source_metric_mapping_activations where id = $1`, [activationId]);
  const audit = await one(k, `select reason from training_load.source_metric_audit where action = 'activation_end' and activation_id = $1`, [activationId]);
  return [a.end_reason, a.ended_basis, audit?.reason ?? null];
}
// The active unit conversion of a pair; a retired pair gets a fresh active row again.
async function conversion(from, to) {
  return one(k, `select id, trim_scale(scale)::text as scale, trim_scale(scale_divisor)::text as scale_divisor from training_load.unit_conversions where from_unit = $1 and to_unit = $2 and state = 'active'`, [from, to]);
}
// Through v47's guarded path (support/unit-conversions.mjs): the acting user
// and the audit row, every trigger on - in its own transaction, or in the
// caller's open one (inTx).
const retireConversion = (c, id, by, { inTx = false } = {}) => (inTx ? retireConversionStatements(c, { id, by }) : retireConversionRow(c, { id, by }));
async function restoreConversion(from, to, scale, divisor) {
  if (await conversion(from, to)) return;
  await createConversion(k, { from, to, scale, divisor, evidenceRef: COMPAT, by: W.pa.id });
}

async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    tables: await rows(c, `select table_schema, table_name from information_schema.tables where table_schema in ${S} order by 1, 2`),
    columns: await rows(c, `select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ${S} order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, c.contype, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    indexes: await rows(c, `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ${S} order by 1, 2, 3`),
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled, obj_description(t.oid, 'pg_trigger') as comment from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest, obj_description(p.oid, 'pg_proc') as comment from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
// The numbered read-only blocks of a preflight or post-check script, each run on its own.
async function blocks(c, file) {
  const text = await fsp.readFile(file, "utf8");
  const out = {};
  for (const part of text.split(/^(?=-- \d+\. )/m).slice(1)) out[Number(part.match(/^-- (\d+)\./)[1])] = (await c.query(part)).rows;
  return out;
}
// The runbook's rule for post-check block 4 against preflight block 5: no active version
// and no activation; mappings, versions_total and mapping_audit_rows never below the
// preflight's (nothing removes one); the per-status counts are information only.
function postcheckBlock4Holds(pre5, post4) {
  const atLeast = (k) => Number(post4[k]) >= Number(pre5[k]);
  return post4.versions_active === "0" && post4.activations === "0" && ["mappings", "versions_total", "mapping_audit_rows"].every(atLeast);
}
// A script run on `c` after `plant` wrote, all of it inside one transaction that is
// rolled back: what the script refused with (or null).
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
// The lock types another session of this database waits on, once one waits. Two
// requests of one user serialize on runWrite's per-user advisory lock before any
// registry lock, so a concurrency test sends its second request as another user
// and asserts that the wait is not on an advisory lock.
async function waitsOnRows(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const types = (await rows(k, `select distinct l.locktype from pg_locks l join pg_stat_activity a on a.pid = l.pid
                                   where not l.granted and a.datname = current_database() and l.pid <> pg_backend_pid() order by 1`)).map((x) => x.locktype);
    if (types.length > 0) {
      assert.ok(!types.includes("advisory"), `the wait is on a row or a transaction, not the per-user lock (${types})`);
      return types;
    }
    await new Promise((res) => setTimeout(res, 20));
  }
  return null;
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
// Holds the next M2 write named `where` after its locks and checks until the gate opens.
function holdM2(where) {
  const g = gate();
  const state = { entered: false };
  service.setMappingWriteHoldForTests(async (_client, at) => {
    if (at !== where || state.entered) return;
    state.entered = true;
    await g.promise;
  });
  return { g, state };
}
function holdLifecycle() {
  const g = gate();
  const state = { entered: false };
  lifecycle.setRevisionWriteHoldForTests(async () => { state.entered = true; await g.promise; });
  return { g, state };
}
function holdVariables() {
  const g = gate();
  const state = { entered: false };
  variables.setVariableWriteHoldForTests(async () => { state.entered = true; await g.promise; });
  return { g, state };
}

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.pa = await platformAdmin();
  W.pa2 = await platformAdmin();
  W.paA = await platformAdmin(["club", W.clubA]);
  W.paB = await platformAdmin(["club", W.clubB]);
  W.caA = await clubAdmin(W.clubA);
  W.caB = await clubAdmin(W.clubB);
  W.coachA = await teamCoach(W.clubA);
  W.sysVar = await variable(W.pa);
  W.clubAVar = await variable(W.caA);
}

// ---------------------------------------------------------------------------
// The rehearsal database (through v42).
// ---------------------------------------------------------------------------
test("1. on v42: every expected value of the read-only preflight (block 4's hard assertion counts an active version and an activation when one exists); the rollback refuses without v43", async () => {
  const pre = await blocks(r, PREFLIGHT);
  assert.deepEqual(Object.keys(pre).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(pre[1][0].pg15_or_later, true);
  assert.deepEqual(pre[2][0], { v42_rows: "1", v42_checksum_ok: true, v43_rows: "0", at_or_after_v43: "0", last_migration: V42_NAME });
  assert.deepEqual(pre[3][0], { v43_functions: "0", v43_triggers: "0", actor_basis_is_v35: true });
  assert.deepEqual(pre[4][0], { active_versions: "0", activations: "0", safe_to_merge: true });
  assert.deepEqual(Object.keys(pre[5][0]), ["mappings", "versions_total", "versions_draft", "versions_needs_review", "versions_active", "versions_disabled", "mapping_audit_rows"]);
  W.pre5 = pre[5][0];
  assert.deepEqual(pre[6][0], { schema_create: true, owns_audit: true, disabled_triggers: "0" });
  assert.deepEqual(pre[7][0], { actor_defaults: "0" });
  assert.deepEqual(pre[8][0], { table_locks: "0", idle_in_transaction: "0" });
  const { advisory_locks: advisoryLocks, ...pre9 } = pre[9][0];
  assert.deepEqual(pre9, { running_checks: "0", running_identity_loads: "0" });
  assert.match(advisoryLocks, /^[0-9]+$/, "advisory_locks is information only");
  // Block 4 counts what it must stop on (rows planted with triggers off, rolled back).
  await r.query("begin");
  try {
    await r.query("set local session_replication_role = replica");
    const id = crypto.randomUUID();
    await r.query(`insert into training_load.source_metric_mapping_versions (id, mapping_id, source_metric_definition_id, metric_definition_id, owner_key, source_metric_version_id, version_number,
                     metric_definition_version_id, conversion_kind, scale, scale_divisor, "offset", source_unit, target_unit, parameter_kind, source_parameters, canonical_parameters,
                     parameter_fingerprint, parameter_scale, parameter_scale_divisor, parameter_offset, applies_to_session, applies_to_drill, status,
                     submitted_by_user_id, submitted_at, submitted_basis, activated_by_user_id, activated_at, activated_basis, created_by_user_id)
                   values ($1,$1,$1,$1,'system',$1,1,$1,'numeric_linear',1,1,0,'s','s','none','{}','{}','',1,1,0,true,true,'active',$1,now(),'platform_admin',$1,now(),'platform_admin',$1)`, [id]);
    await r.query(`insert into training_load.source_metric_mapping_activations (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, source_team_binding_id, team_id,
                     applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
                   values ($1,$1,$1,$1,'',$1,$1,true,true,'required',$1,'platform_admin','x')`, [id]);
    assert.deepEqual((await blocks(r, PREFLIGHT))[4][0], { active_versions: "1", activations: "1", safe_to_merge: false });
  } finally {
    await r.query("rollback");
  }
  assert.match((await inRolledBack(r, null, ROLLBACK))?.message ?? "", /^v43 rollback refused: v43 is not recorded on this database$/);
  W.before42 = await catalog(r);
});

test("2. v43 through the runner on v42 adds exactly its two functions (with their v43 comments) and its two triggers - no table, column, constraint or index, no other function or trigger changes, source_metric_actor_basis byte for byte; every expected value of the post-check", async () => {
  await migrate(rdb.url, [...UP_TO_V42, V43]);
  const after = await catalog(r);
  const before = W.before42;
  for (const part of ["tables", "columns", "indexes"]) assert.deepEqual(after[part], before[part], `${part} unchanged`);
  // A constraint trigger has its own pg_constraint row (contype 't'); nothing else changed.
  const conKey = (x) => `${x.rel}.${x.conname}`;
  assert.deepEqual(after.constraints.filter((x) => !before.constraints.some((y) => conKey(y) === conKey(x))).map((x) => [x.rel, x.conname, x.contype]),
    [["training_load.source_metric_audit", "source_metric_audit_v43_replacement_link", "t"]]);
  assert.deepEqual(after.constraints.filter((x) => x.conname !== "source_metric_audit_v43_replacement_link"), before.constraints, "every other constraint unchanged");
  const keyOf = (x) => `${x.nspname}.${x.proname}(${x.args})`;
  const newFunctions = after.functions.filter((x) => !before.functions.some((y) => keyOf(y) === keyOf(x)));
  assert.deepEqual(newFunctions.map((x) => x.proname).sort(), ["source_metric_audit_replacement_link", "source_metric_audit_transition_facts"]);
  for (const f of newFunctions) assert.match(f.comment, /^v43 \(J8, G[12]\): /);
  assert.deepEqual(after.functions.filter((x) => !newFunctions.includes(x)), before.functions, "every other function, body and comment unchanged");
  const trigKey = (x) => `${x.relname}.${x.tgname}`;
  const newTriggers = after.triggers.filter((x) => !before.triggers.some((y) => trigKey(y) === trigKey(x)));
  assert.deepEqual(newTriggers.map((x) => [x.relname, x.tgname, x.tgenabled]).sort(), [
    ["source_metric_audit", "source_metric_audit_v43_replacement_link", "O"], ["source_metric_audit", "source_metric_audit_v43_transition_facts", "O"]]);
  assert.deepEqual(after.triggers.filter((x) => !newTriggers.includes(x)), before.triggers, "every other trigger unchanged");
  assert.deepEqual(after.migrations, [...before.migrations, V43_NAME].sort());
  const post = await blocks(r, POSTCHECK);
  assert.deepEqual(Object.keys(post).map(Number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(post[1][0], { v43_rows: "1", v43_checksum_ok: true, later_rows: "0", last_migration: V43_NAME, v42_rows: "1" });
  assert.deepEqual(post[2][0], { replacement_link_is_v43: true, transition_facts_is_v43: true, comments_name_v43: true, actor_basis_is_v35: true });
  assert.deepEqual(post[3], [
    { tgname: "source_metric_audit_v43_replacement_link", tgtype: 5, tgdeferrable: true, tginitdeferred: true, tgenabled: "O", is_constraint_trigger: true, calls_v43_function: true, has_when: true },
    { tgname: "source_metric_audit_v43_transition_facts", tgtype: 7, tgdeferrable: false, tginitdeferred: false, tgenabled: "O", is_constraint_trigger: false, calls_v43_function: true, has_when: true },
  ]);
  const { activations, ...post4 } = post[4][0];
  assert.deepEqual(post4, W.pre5, "the numbers of preflight block 5, unchanged");
  assert.equal(activations, "0");
  assert.equal(postcheckBlock4Holds(W.pre5, post[4][0]), true);
  // An ordinary submission between the two checks lowers versions_draft: block 4 still
  // holds, while a rule asking every count to stay or rise would stop the owner for nothing
  // (rows planted with triggers off, rolled back).
  await r.query("begin");
  try {
    await r.query("set local session_replication_role = replica");
    const id = crypto.randomUUID();
    await r.query(`insert into training_load.source_metric_mapping_versions (id, mapping_id, source_metric_definition_id, metric_definition_id, owner_key, source_metric_version_id, version_number,
                     metric_definition_version_id, conversion_kind, scale, scale_divisor, "offset", source_unit, target_unit, parameter_kind, source_parameters, canonical_parameters,
                     parameter_fingerprint, parameter_scale, parameter_scale_divisor, parameter_offset, applies_to_session, applies_to_drill, status, created_by_user_id)
                   values ($1,$1,$1,$1,'system',$1,1,$1,'numeric_linear',1,1,0,'s','s','none','{}','{}','',1,1,0,true,true,'draft',$1)`, [id]);
    const pre5 = (await blocks(r, PREFLIGHT))[5][0];
    await r.query(`update training_load.source_metric_mapping_versions set status = 'needs_review', submitted_by_user_id = $1, submitted_at = now(), submitted_basis = 'platform_admin' where id = $1`, [id]);
    const after4 = (await blocks(r, POSTCHECK))[4][0];
    assert.ok(Number(after4.versions_draft) < Number(pre5.versions_draft), "the submission lowered versions_draft");
    assert.equal(postcheckBlock4Holds(pre5, after4), true, "block 4 holds after an ordinary submission");
    const { activations: _a, ...after4counts } = after4;
    assert.equal(Object.keys(pre5).every((k) => Number(after4counts[k]) >= Number(pre5[k])), false, "every-count-rises would be a false stop");
  } finally {
    await r.query("rollback");
  }
  assert.deepEqual(post[5][0], { actor_defaults: "0", disabled_triggers: "0" });
  assert.deepEqual(post[6][0], { table_locks: "0" });
  // The checksum the post-check carries is the file's own.
  const sha = crypto.createHash("sha256").update(await fsp.readFile(V43_FILE)).digest("hex");
  assert.ok((await fsp.readFile(POSTCHECK, "utf8")).includes(sha), "the post-check names the v43 file's sha256");
  W.after43 = after;
});

test("3. the rollback refuses, changing nothing, under a later migration, while a v43 trigger is disabled, while a v43 function or trigger is missing, and while the migrator holds its advisory lock", async () => {
  const refuses = async (plant, pattern) => {
    const error = await inRolledBack(r, plant, ROLLBACK);
    assert.match(error?.message ?? "", pattern);
    assert.deepEqual(await catalog(r), W.after43, `nothing changed (${pattern})`);
  };
  await refuses((c) => c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', $1, 'test')`, ["0".repeat(64)]),
    /^v43 rollback refused: later migrations are applied$/);
  await refuses((c) => c.query(`alter table training_load.source_metric_audit disable trigger source_metric_audit_v43_transition_facts`),
    /^v43 rollback refused: a v43 trigger is disabled$/);
  await refuses(async (c) => {
    await c.query(`drop trigger source_metric_audit_v43_transition_facts on training_load.source_metric_audit`);
    await c.query(`drop function training_load.source_metric_audit_transition_facts()`);
  }, /^v43 rollback refused: a v43 function is missing; a v43 trigger is missing$/);
  await refuses((c) => c.query(`drop trigger source_metric_audit_v43_replacement_link on training_load.source_metric_audit`),
    /^v43 rollback refused: a v43 trigger is missing$/);
  assert.match(await fsp.readFile(path.join(ROOT, "backend", "src", "migrate.js"), "utf8"), /export const MIGRATION_LOCK_KEY = 822026n;/);
  const migrator = new pg.Client({ connectionString: rdb.url });
  await migrator.connect();
  try {
    await migrator.query("select pg_advisory_lock(822026)");
    await refuses(null, /^v43 rollback refused: the migrator is running$/);
  } finally {
    await migrator.query("select pg_advisory_unlock(822026)").catch(() => {});
    await migrator.end();
  }
  for (const file of [ROLLBACK, PREFLIGHT, POSTCHECK, V43_FILE]) {
    assert.ok(!(await fsp.readFile(file, "utf8")).includes("\r"), `${path.basename(file)} has LF line endings`);
  }
});

test("4. the rollback returns v42's catalog exactly (comments included) and changes no row; v43 then applies again to the same catalog", async () => {
  const auditBefore = (await one(r, `select count(*)::int as n from training_load.source_metric_audit`)).n;
  const sql = await fsp.readFile(ROLLBACK, "utf8");
  await r.query(sql);
  assert.deepEqual(await catalog(r), W.before42, "v42's catalog");
  assert.equal((await one(r, `select count(*)::int as n from training_load.source_metric_audit`)).n, auditBefore);
  await migrate(rdb.url, [...UP_TO_V42, V43]);
  assert.deepEqual(await catalog(r), W.after43, "v43 again");
});

// ---------------------------------------------------------------------------
// The behaviour database (through v43).
// ---------------------------------------------------------------------------
test("5. A1, a plain activation: 200 with the version active (activatedAt set, no reason, no acting user) and replaced null; one keyed mapping_status row needs_review -> active without a reason; the same key replays the current state, another body on it is request_key_reused; the version reads show activatedAt", async () => {
  const f = await field();
  const v = await version(f);
  const k1 = key();
  const res = ok200(await activate(v, W.pa.cookie, { requestKey: k1 }));
  assert.equal(res.replayed, false);
  assert.equal(res.replaced, null);
  assert.equal(res.version.id, v.versionId);
  assert.equal(res.version.status, "active");
  assert.ok(res.version.activatedAt && res.version.submittedAt);
  assert.equal(res.version.disabledAt, null);
  for (const field of ["disableReason", "disable_reason", "activatedBy", "activated_by_user_id", "reason"]) assert.ok(!(field in res.version), field);
  const row = await versionRow(v.versionId);
  assert.deepEqual([row.status, row.activated_by_user_id, row.activated_basis], ["active", W.pa.id, "platform_admin"]);
  const audit = await auditOf(`request_key = $1`, [k1]);
  assert.deepEqual(audit.map((a) => [a.action, a.mapping_version_id, a.from_status, a.to_status, a.reason, a.basis]), [["mapping_status", v.versionId, "needs_review", "active", null, "platform_admin"]]);
  assert.equal((await auditOf(`operation_id = $1`, [audit[0].operation_id])).length, 1);
  const again = ok200(await activate(v, W.pa.cookie, { requestKey: k1 }));
  assert.deepEqual([again.replayed, again.replaced, again.version.status], [true, null, "active"]);
  refused(await activate(v, W.pa.cookie, { requestKey: k1, expected: v.versionId, reason: "Other body." }), 409, "request_key_reused");
  refused(await disable(v, W.pa.cookie, { requestKey: k1, expectedStatus: "active" }), 409, "request_key_reused");
  const page = ok200(await api(`/mappings/${v.mappingId}`, { cookie: W.pa.cookie }));
  const listed = page.mapping.versions.find((x) => x.id === v.versionId);
  assert.ok(listed.activatedAt);
  assert.equal(listed.disabledAt, null);
  const list = ok200(await api(`/mappings`, { cookie: W.pa.cookie }));
  assert.equal(list.mappings.find((m) => m.id === v.mappingId).activeVersionId, v.versionId);
});

test("6. A1, a replacement: naming the active version N with a reason disables N and activates N+1 in one transaction; the answer names N (replaced) and never the reason; N's mapping_status row (active -> disabled, unkeyed) and N+1's keyed mapping_version_replaced row share one operation and the reason; the replay names N again", async () => {
  const f = await field();
  const n = await activeVersion(f);
  const n1 = await version(f);
  const reason = "Replaced by the corrected factor.";
  const k1 = key();
  const res = ok200(await activate(n1, W.pa.cookie, { requestKey: k1, expected: n.versionId, reason }));
  assert.deepEqual([res.replayed, res.replaced, res.version.id, res.version.status], [false, n.versionId, n1.versionId, "active"]);
  assert.ok(!JSON.stringify(res).includes(reason), "the reason is never returned");
  const nRow = await versionRow(n.versionId);
  assert.deepEqual([nRow.status, nRow.disable_reason, nRow.disabled_by_user_id, nRow.disabled_basis], ["disabled", reason, W.pa.id, "platform_admin"]);
  const keyed = (await auditOf(`request_key = $1`, [k1]))[0];
  assert.deepEqual([keyed.action, keyed.mapping_version_id, keyed.from_status, keyed.to_status, keyed.reason], ["mapping_version_replaced", n1.versionId, "needs_review", "active", reason]);
  const op = await auditOf(`operation_id = $1`, [keyed.operation_id]);
  assert.deepEqual(op.map((a) => [a.action, a.mapping_version_id, a.from_status, a.to_status, a.reason, a.request_key === null]).sort(), [
    ["mapping_status", n.versionId, "active", "disabled", reason, true],
    ["mapping_version_replaced", n1.versionId, "needs_review", "active", reason, false],
  ].sort());
  // The keyed row is written last: cmin is the command id of the INSERT within its
  // transaction (never updated or deleted: T8 is append-only), so it orders the inserts.
  const order = await rows(k, `select request_key is not null as keyed, cmin::text::int as command
                                 from training_load.source_metric_audit where operation_id = $1 order by 2`, [keyed.operation_id]);
  assert.deepEqual(order.map((x) => x.keyed), [false, true], "N's row first, the request record last");
  const again = ok200(await activate(n1, W.pa.cookie, { requestKey: k1, expected: n.versionId, reason }));
  assert.deepEqual([again.replayed, again.replaced, again.version.status], [true, n.versionId, "active"]);
  const page = ok200(await api(`/mappings/${n.mappingId}`, { cookie: W.pa.cookie }));
  assert.ok(page.mapping.versions.find((x) => x.id === n.versionId).disabledAt);
  assert.ok(!JSON.stringify(page).includes(reason), "no read shows the reason (C63)");
});

test("7. A2 disables a draft, a needs_review and an active version with a reason, each with its keyed mapping_status row from its real status; a stale expectedStatus (the version moved, or is already disabled) is 409 version_status_changed with the current status and writes nothing; the same key replays", async () => {
  const f = await field();
  const g = await field();
  const h = await field();
  const draft = await version(f, { submit: false });
  const submitted = await version(g);
  const live = await activeVersion(h);
  for (const [v, status] of [[draft, "draft"], [submitted, "needs_review"], [live, "active"]]) {
    const k1 = key();
    const res = ok200(await disable(v, W.pa.cookie, { requestKey: k1, expectedStatus: status, reason: `Stopped from ${status}.` }));
    assert.deepEqual([res.replayed, res.version.status, typeof res.version.disabledAt], [false, "disabled", "string"]);
    assert.ok(!JSON.stringify(res).includes("Stopped from"), "the reason is never returned");
    const audit = await auditOf(`request_key = $1`, [k1]);
    assert.deepEqual(audit.map((a) => [a.action, a.from_status, a.to_status, a.reason]), [["mapping_status", status, "disabled", `Stopped from ${status}.`]]);
    const row = await versionRow(v.versionId);
    assert.deepEqual([row.disable_reason, row.disabled_by_user_id, row.disabled_basis], [`Stopped from ${status}.`, W.pa.id, "platform_admin"]);
    assert.equal(ok200(await disable(v, W.pa.cookie, { requestKey: k1, expectedStatus: status, reason: `Stopped from ${status}.` })).replayed, true);
  }
  assert.deepEqual(refused(await disable(draft, W.pa.cookie, { expectedStatus: "draft" }), 409, "version_status_changed").current, { status: "disabled" });
  const moved = await version(f);
  assert.deepEqual(refused(await disable(moved, W.pa.cookie, { expectedStatus: "draft" }), 409, "version_status_changed").current, { status: "needs_review" });
  assert.equal(await statusOf(moved), "needs_review", "nothing written");
});

test("8. the order of the answers: without a session the router's 401; a club admin gets the identical 404 before the body is looked at (no body, a wrong content type, a bad body); a platform admin gets 415, then 400 for a non-object body, the identical 404 for a malformed id, then 400 for each body rule; a refusal is no request record (the key works afterwards)", async () => {
  const f = await field({ verified: true });
  const clubV = await version(f, { owner: W.caA, target: W.clubAVar });
  // No session: the router's 401, with and without a body.
  for (const p of [actPath(clubV), disPath(clubV)]) {
    assert.equal((await api(p, { method: "POST" })).status, 401, p);
    assert.equal((await post(p, null, { requestKey: key(), expectedActiveVersionId: null, expectedStatus: "draft", reason: "x" })).status, 401, p);
  }
  for (const p of [actPath(clubV), disPath(clubV)]) {
    isNotFound(await api(p, { method: "POST", cookie: W.caA.cookie }), "no body");
    isNotFound(await api(p, { method: "POST", cookie: W.caA.cookie, body: "x", contentType: "text/plain" }), "text");
    isNotFound(await post(p, W.caA.cookie, [1]), "array");
    isNotFound(await post(p, W.caA.cookie, { requestKey: "nope" }), "bad body");
  }
  const v = await version(f);
  for (const p of [actPath(v), disPath(v)]) {
    assert.equal((await api(p, { method: "POST", cookie: W.pa.cookie, body: "x", contentType: "text/plain" })).status, 415);
    assert.deepEqual(refused(await post(p, W.pa.cookie, [1]), 400, "invalid_body").error, "invalid_body");
  }
  isNotFound(await post(`/mappings/not-a-uuid/versions/${v.versionId}/activate`, W.pa.cookie, { requestKey: key(), expectedActiveVersionId: null }), "mapping id");
  isNotFound(await post(`/mappings/${v.mappingId}/versions/not-a-uuid/disable`, W.pa.cookie, { requestKey: key(), expectedStatus: "draft", reason: "x" }), "version id");
  const bad = [
    [actPath(v), { requestKey: key() }],
    [actPath(v), { expectedActiveVersionId: null }],
    [actPath(v), { requestKey: key(), expectedActiveVersionId: null, extra: 1 }],
    [actPath(v), { requestKey: "nope", expectedActiveVersionId: null }],
    [actPath(v), { requestKey: key(), expectedActiveVersionId: "nope" }],
    [actPath(v), { requestKey: key(), expectedActiveVersionId: null, reason: "A reason without a replacement." }],
    [actPath(v), { requestKey: key(), expectedActiveVersionId: null, reason: null }],
    [actPath(v), { requestKey: key(), expectedActiveVersionId: key() }],
    [actPath(v), { requestKey: key(), expectedActiveVersionId: key(), reason: "two\nlines" }],
    [actPath(v), { requestKey: key(), expectedActiveVersionId: key(), reason: " padded" }],
    [actPath(v), { requestKey: key(), expectedActiveVersionId: key(), reason: "x".repeat(501) }],
    [actPath(v), { requestKey: key(), expectedActiveVersionId: key(), reason: `hidden${String.fromCodePoint(0x200b)}` }],
    [disPath(v), { requestKey: key(), expectedStatus: "needs_review" }],
    [disPath(v), { requestKey: key(), expectedStatus: "disabled", reason: "x" }],
    [disPath(v), { requestKey: key(), expectedStatus: "NEEDS_REVIEW", reason: "x" }],
    [disPath(v), { requestKey: key(), expectedStatus: "needs_review", reason: "" }],
    [disPath(v), { requestKey: key(), expectedStatus: "needs_review", reason: 5 }],
  ];
  for (const [p, body] of bad) refused(await post(p, W.pa.cookie, body), 400, "invalid_body");
  assert.equal(await statusOf(v), "needs_review");
  // A refusal writes no request record: the same key is then used for another request.
  const k1 = key();
  refused(await disable(v, W.pa.cookie, { requestKey: k1, expectedStatus: "active" }), 409, "version_status_changed");
  assert.equal((await auditOf(`request_key = $1`, [k1])).length, 0);
  ok200(await activate(v, W.pa.cookie, { requestKey: k1 }));
});

test("9. information hiding: a club admin (own and other club), a team coach, a platform admin in another owner's workspace or in a team workspace, an archived club's workspace, a revoked role, a foreign mapping id and a version of another mapping each answer the identical 404 and write nothing (an inactive user has no session: 401); the replay of an activation, a replacement and a disable from another workspace is the identical 404", async () => {
  const f = await field();
  const sysV = await version(f);
  const g = await field();
  const clubV = await version(g, { owner: W.caA, target: W.clubAVar });
  const callers = [
    ["club admin of the club", W.caA, clubV], ["club admin of another club", W.caB, clubV], ["team coach of the club", W.coachA, clubV],
    ["platform admin in another club's workspace", W.paB, clubV], ["platform admin in the club's workspace on a system mapping", W.paA, sysV],
    ["platform admin in the platform workspace on a club mapping", W.pa, clubV], ["club admin on a system mapping", W.caA, sysV],
  ];
  for (const [label, who, v] of callers) {
    isNotFound(await activate(v, who.cookie), `activate: ${label}`);
    isNotFound(await disable(v, who.cookie, { expectedStatus: "needs_review" }), `disable: ${label}`);
  }
  isNotFound(await post(`/mappings/${sysV.mappingId}/versions/${clubV.versionId}/activate`, W.pa.cookie, { requestKey: key(), expectedActiveVersionId: null }), "a version of another mapping");
  isNotFound(await post(`/mappings/${key()}/versions/${sysV.versionId}/disable`, W.pa.cookie, { requestKey: key(), expectedStatus: "needs_review", reason: "x" }), "a foreign mapping id");
  isNotFound(await activate({ mappingId: key(), versionId: key() }, W.pa.cookie), "nothing at all");
  // An archived club's workspace has no admin context (its own platform admin: the
  // workspace resolver stores a fallback workspace for a user whose club is gone).
  const paArchived = await platformAdmin(["club", W.clubA]);
  await k.query(`update public.clubs set is_active = false where id = $1`, [W.clubA]);
  try {
    isNotFound(await activate(clubV, paArchived.cookie), "archived club");
  } finally {
    await k.query(`update public.clubs set is_active = true where id = $1`, [W.clubA]);
  }
  // A platform admin whose active workspace is a team: no admin context.
  const coachAdmin = await teamCoach(W.clubA, { platformAdmin: true });
  isNotFound(await activate(clubV, coachAdmin.cookie), "platform admin in a team workspace");
  isNotFound(await disable(sysV, coachAdmin.cookie, { expectedStatus: "needs_review" }), "platform admin in a team workspace");
  // An inactive user has no session: the router's 401.
  const inactive = await platformAdmin();
  await k.query(`update public.users set is_active = false where id = $1`, [inactive.id]);
  assert.equal((await activate(sysV, inactive.cookie)).status, 401);
  assert.equal((await disable(sysV, inactive.cookie, { expectedStatus: "needs_review" })).status, 401);
  // A revoked platform admin.
  const revoked = await platformAdmin();
  await k.query(`update public.user_global_roles set is_active = false where user_id = $1`, [revoked.id]);
  isNotFound(await activate(sysV, revoked.cookie), "revoked role");
  assert.deepEqual([await statusOf(sysV), await statusOf(clubV)], ["needs_review", "needs_review"], "nothing written");
  // The club's version is the platform admin's in the club's workspace; a replay from another workspace is the identical 404.
  const k1 = key();
  ok200(await activate(clubV, W.paA.cookie, { requestKey: k1 }));
  await workspace(W.paA.id, "club", W.clubB);
  try {
    isNotFound(await activate(clubV, W.paA.cookie, { requestKey: k1 }), "replay from another workspace");
  } finally {
    await workspace(W.paA.id, "club", W.clubA);
  }
  assert.equal(ok200(await activate(clubV, W.paA.cookie, { requestKey: k1 })).replayed, true);
  assert.equal((await versionRow(clubV.versionId)).activated_basis, "platform_admin");
  // A replacement and a disable of the club's versions, each replayed from the platform workspace.
  const clubN1 = await version(g, { owner: W.caA, target: W.clubAVar });
  const k2 = key();
  ok200(await activate(clubN1, W.paA.cookie, { requestKey: k2, expected: clubV.versionId, reason: "Club replacement." }));
  const clubDraft = await version(g, { owner: W.caA, target: W.clubAVar, submit: false });
  const k3 = key();
  ok200(await disable(clubDraft, W.paA.cookie, { requestKey: k3, expectedStatus: "draft", reason: "Club disable." }));
  await workspace(W.paA.id, "platform", null);
  try {
    isNotFound(await activate(clubN1, W.paA.cookie, { requestKey: k2, expected: clubV.versionId, reason: "Club replacement." }), "a replacement's replay from another workspace");
    isNotFound(await disable(clubDraft, W.paA.cookie, { requestKey: k3, expectedStatus: "draft", reason: "Club disable." }), "a disable's replay from another workspace");
  } finally {
    await workspace(W.paA.id, "club", W.clubA);
  }
  assert.equal(ok200(await activate(clubN1, W.paA.cookie, { requestKey: k2, expected: clubV.versionId, reason: "Club replacement." })).replaced, clubV.versionId);
  assert.equal(ok200(await disable(clubDraft, W.paA.cookie, { requestKey: k3, expectedStatus: "draft", reason: "Club disable." })).replayed, true);
});

test("10. A1's refusals, each writing nothing: version_not_submitted, active_version_changed (null while one is active, a wrong id, a name while none is), revision_not_verified, target_not_active, canonical_version_changed, conversion_unavailable, bound_conversion_unavailable, level_not_allowed, source_metric_target_taken (a system and a club mapping of the same pair are both allowed); from phase 7d an open activation is ended by A1's replacement and by A2, never a refusal", async () => {
  const f = await field();
  const draft = await version(f, { submit: false });
  assert.deepEqual(refused(await activate(draft, W.pa.cookie), 409, "version_not_submitted").current, { status: "draft" });
  const n = await activeVersion(f);
  const n1 = await version(f);
  assert.deepEqual(refused(await activate(n1, W.pa.cookie), 409, "active_version_changed").current, { activeVersionId: n.versionId });
  assert.deepEqual(refused(await activate(n1, W.pa.cookie, { expected: key(), reason: "x" }), 409, "active_version_changed").current, { activeVersionId: n.versionId });
  const lone = await version(await field());
  assert.deepEqual(refused(await activate(lone, W.pa.cookie, { expected: key(), reason: "x" }), 409, "active_version_changed").current, { activeVersionId: null });
  assert.deepEqual([await statusOf(n), await statusOf(n1), await statusOf(lone)], ["active", "needs_review", "needs_review"]);
  // The revision is not verified (a unit proof only).
  const observed = await field({ verified: false });
  refused(await activate(await version(observed), W.pa.cookie), 409, "revision_not_verified");
  // The canonical variable is archived; then it has a new current version.
  const archivedVar = await variable(W.pa);
  const av = await version(await field(), { target: archivedVar });
  ok200(await post(`/variables/${archivedVar.id}/archive`, W.pa.cookie, { requestKey: key(), reason: "Retired variable." }));
  refused(await activate(av, W.pa.cookie), 409, "target_not_active");
  const movedVar = await variable(W.pa);
  const mv = await version(await field(), { target: movedVar });
  assert.equal((await post(`/variables/${movedVar.id}/versions`, W.pa.cookie, { requestKey: key(), expectedCurrentVersionId: movedVar.currentVersionId, unit: "s", dailyAggregationMethod: "avg" })).status, 201);
  refused(await activate(mv, W.pa.cookie), 409, "canonical_version_changed");
  // The value conversion s -> min is retired.
  const minVar = await variable(W.pa, { unit: "min" });
  const cv = await version(await field(), { target: minVar, body: { conversionNote: "Seconds to minutes." } });
  const sMin = await conversion("s", "min");
  await retireConversion(k, sMin.id, W.pa.id);
  try {
    refused(await activate(cv, W.pa.cookie), 409, "conversion_unavailable");
  } finally {
    await restoreConversion("s", "min", 1, 60);
  }
  // The bound conversion m/s -> km/h of an event threshold is retired.
  const threshold = await field({ kind: "event_threshold", unit: "count", boundUnit: "m/s", operator: ">=" });
  const tVar = await variable(W.pa, { unit: "count", condition: { kind: "event_threshold", operator: ">=", value: "25.2", durationSeconds: "1", unit: "km/h" } });
  const tv = await version(threshold, { target: tVar, body: { sourceParameters: { thresholdValue: "7", durationSeconds: "1" } } });
  const msKmh = await conversion("m/s", "km/h");
  await retireConversion(k, msKmh.id, W.pa.id);
  try {
    refused(await activate(tv, W.pa.cookie), 409, "bound_conversion_unavailable");
  } finally {
    await restoreConversion("m/s", "km/h", 3.6, 1);
  }
  ok200(await activate(tv, W.pa.cookie));
  // A level the version applies to was removed from the canonical variable.
  const levelVar = await variable(W.pa);
  const lv = await version(await field(), { target: levelVar });
  await k.query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'component'`, [levelVar.id]);
  refused(await activate(lv, W.pa.cookie), 409, "level_not_allowed");
  // Another mapping of the same owner holds an active version of the same field and parameters.
  const shared = await field();
  const otherSys = await variable(W.pa);
  const first = await activeVersion(shared);
  const second = await version(shared, { target: otherSys });
  const taken = refused(await activate(second, W.pa.cookie), 409, "source_metric_target_taken");
  assert.equal(taken.current, undefined);
  assert.ok(!JSON.stringify(taken).includes(first.mappingId) && !JSON.stringify(taken).includes(first.versionId), "names nothing of the other mapping");
  const clubSame = await version(shared, { owner: W.caA, target: W.clubAVar });
  ok200(await activate(clubSame, W.paA.cookie));
  // An open activation (phase 7d, D6): A1's replacement and A2 end it with
  // their own reason, never activation_open.
  const o = await field();
  const on = await activeVersion(o);
  const on1 = await version(o);
  const onActivation = await openActivation(on);
  const replaced = ok200(await activate(on1, W.pa.cookie, { expected: on.versionId, reason: "Replace." }));
  assert.deepEqual([replaced.activationsEnded, replaced.activations], [1, []]);
  assert.deepEqual(await endOf(onActivation), ["mapping_version_replaced", "platform_admin", "Replace."]);
  assert.deepEqual([await statusOf(on), await statusOf(on1)], ["disabled", "active"]);
  const on1Activation = await openActivation(on1);
  const disabledOne = ok200(await disable(on1, W.pa.cookie, { expectedStatus: "active" }));
  assert.equal(disabledOne.activationsEnded, 1);
  assert.deepEqual(await endOf(on1Activation), ["mapping_version_disabled", "platform_admin", "Wrong mapping."]);
  // Nothing of any refusal was recorded.
  for (const v of [draft, n1, lone, av, mv, cv, lv, second]) {
    assert.equal((await auditOf(`mapping_version_id = $1 and to_status in ('active', 'disabled')`, [v.versionId])).length, 0, v.versionId);
  }
});

test("11. decision 9: an active version keeps its canonical variable from a new version and an archive (409 variable_pinned); disabling it releases both", async () => {
  const pinnedVar = await variable(W.pa);
  const v = await activeVersion(await field(), { target: pinnedVar });
  refused(await post(`/variables/${pinnedVar.id}/versions`, W.pa.cookie, { requestKey: key(), expectedCurrentVersionId: pinnedVar.currentVersionId, unit: "s", dailyAggregationMethod: "avg" }), 409, "variable_pinned");
  refused(await post(`/variables/${pinnedVar.id}/archive`, W.pa.cookie, { requestKey: key(), reason: "Retire." }), 409, "variable_pinned");
  ok200(await disable(v, W.pa.cookie, { expectedStatus: "active" }));
  assert.equal((await post(`/variables/${pinnedVar.id}/versions`, W.pa.cookie, { requestKey: key(), expectedCurrentVersionId: pinnedVar.currentVersionId, unit: "s", dailyAggregationMethod: "avg" })).status, 201);
});

test("12. the database allowlist: both 23505 index names and the three v34 transition texts map to their codes, and nothing else does; two activations of one field and parameters on two mappings of one owner by two admins at once - the second passes the plain pre-read, waits for the first's transaction on the per-owner index and answers source_metric_target_taken through the 23505 mapping (or try_again, and its retry source_metric_target_taken)", async () => {
  const classify = service.classifyDatabaseError;
  assert.equal(classify({ code: "23505", constraint: "source_metric_mapping_versions_one_active_target_per_owner" }).code, "source_metric_target_taken");
  assert.equal(classify({ code: "23505", constraint: "source_metric_mapping_versions_one_active_per_mapping" }).code, "active_version_changed");
  assert.equal(classify({ code: "23505", constraint: "source_metric_mapping_versions_one_active_per_mapping_x" }), null);
  assert.equal(classify({ code: "23514", message: "source_metric_mapping_versions: the source revision must be active and verified" }).code, "revision_not_verified");
  assert.equal(classify({ code: "23514", message: "source_metric_mapping_versions: the canonical definition must be active with the pinned version current" }).code, "canonical_version_changed");
  assert.equal(classify({ code: "23514", message: "source_metric_mapping_versions: a mapping version with an open activation is not disabled" }).code, "activation_open");
  assert.equal(classify({ code: "23514", constraint: "x", message: "source_metric_mapping_versions: a mapping version with an open activation is not disabled" }), null);
  for (const text of ["source_metric_audit: a replacement records the disable of the version it replaces in its own operation", "source_metric_audit: a disable row carries its version's disable reason"]) {
    assert.equal(classify({ code: "23514", message: text }), null, "a v43 guard is never a 4xx");
  }
  // The race: the first activation's COMMIT is held; the second meets its index entry.
  const shared = await field();
  const otherSys = await variable(W.pa);
  const a = await version(shared);
  const b = await version(shared, { target: otherSys });
  const g = gate();
  let calls = 0;
  service.setMappingCommitForTests({ fault: async (client) => { calls += 1; if (calls === 1) await g.promise; return client.query("commit"); } });
  const first = activate(a, W.pa.cookie);
  await until(() => calls === 1, "the first activation reached its COMMIT");
  const second = activate(b, W.pa2.cookie);
  const waitedOn = await waitsOnRows();
  assert.ok(waitedOn?.includes("transactionid"), `the second waits for the first's transaction on the index (${waitedOn})`);
  g.open();
  ok200(await first);
  const res = await second;
  assert.ok(["source_metric_target_taken", "try_again"].includes(res.body.error), res.text);
  refused(await activate(b, W.pa2.cookie), 409, "source_metric_target_taken");
  assert.deepEqual([await statusOf(a), await statusOf(b)], ["active", "needs_review"]);
});

test("13. concurrency, in both orders, the second request always by another admin (so it waits on a row or a transaction, never on the per-user advisory lock): two activations of one mapping; an activation and a disable of one version; an activation against a canonical new version (M3-0) and an archive (R2); an activation against a conversion retirement; an activation against a level removal as the older Metrics catalog writes it (its route refuses a canonical variable, 409 canonical_variable_read_only, without waiting); an activation against L2, L4 (both orders) and L5 (both orders) on the same revision", async () => {
  // Two activations of two versions of one mapping (T3 serializes them).
  for (const order of [0, 1]) {
    const f = await field();
    const v = [await version(f), await version(f)];
    const held = holdM2("mapping_version_activate");
    const first = activate(v[order], W.pa.cookie);
    await until(() => held.state.entered, "the first activation holds its locks");
    const second = activate(v[1 - order], W.pa2.cookie);
    assert.ok(await waitsOnRows(), "the second waits on the mapping");
    held.g.open();
    ok200(await first);
    assert.deepEqual(refused(await second, 409, "active_version_changed").current, { activeVersionId: v[order].versionId });
  }
  // An activation and a disable of one version.
  {
    const v = await version(await field());
    const held = holdM2("mapping_version_activate");
    const act = activate(v, W.pa.cookie);
    await until(() => held.state.entered, "held");
    const dis = disable(v, W.pa2.cookie, { expectedStatus: "needs_review" });
    assert.ok(await waitsOnRows());
    held.g.open();
    ok200(await act);
    assert.deepEqual(refused(await dis, 409, "version_status_changed").current, { status: "active" });
  }
  {
    const v = await version(await field());
    const held = holdM2("mapping_version_disable");
    const dis = disable(v, W.pa.cookie, { expectedStatus: "needs_review" });
    await until(() => held.state.entered, "held");
    const act = activate(v, W.pa2.cookie);
    assert.ok(await waitsOnRows());
    held.g.open();
    ok200(await dis);
    assert.deepEqual(refused(await act, 409, "version_not_submitted").current, { status: "disabled" });
  }
  // An activation against a canonical new version and an archive.
  for (const write of ["version", "archive"]) {
    const cVar = await variable(W.pa);
    const v = await version(await field(), { target: cVar });
    const send = () => (write === "version"
      ? post(`/variables/${cVar.id}/versions`, W.pa2.cookie, { requestKey: key(), expectedCurrentVersionId: cVar.currentVersionId, unit: "s", dailyAggregationMethod: "avg" })
      : post(`/variables/${cVar.id}/archive`, W.pa2.cookie, { requestKey: key(), reason: "Retire." }));
    const held = holdM2("mapping_version_activate");
    const act = activate(v, W.pa.cookie);
    await until(() => held.state.entered, "held");
    const change = send();
    assert.ok(await waitsOnRows(), `the ${write} waits on the definition`);
    held.g.open();
    ok200(await act);
    refused(await change, 409, "variable_pinned");
    // The other order: the change first.
    const cVar2 = await variable(W.pa);
    const v2 = await version(await field(), { target: cVar2 });
    const heldVar = holdVariables();
    const change2 = write === "version"
      ? post(`/variables/${cVar2.id}/versions`, W.pa.cookie, { requestKey: key(), expectedCurrentVersionId: cVar2.currentVersionId, unit: "s", dailyAggregationMethod: "avg" })
      : post(`/variables/${cVar2.id}/archive`, W.pa.cookie, { requestKey: key(), reason: "Retire." });
    await until(() => heldVar.state.entered, "the change holds its locks");
    const act2 = activate(v2, W.pa2.cookie);
    assert.ok(await waitsOnRows(), "the activation waits on the definition");
    heldVar.g.open();
    assert.ok([200, 201].includes((await change2).status));
    refused(await act2, 409, write === "version" ? "canonical_version_changed" : "target_not_active");
  }
  // An activation against a conversion retirement (direct SQL until 7c).
  {
    const minVar = await variable(W.pa, { unit: "min" });
    const v = await version(await field(), { target: minVar, body: { conversionNote: "Seconds to minutes." } });
    const held = holdM2("mapping_version_activate");
    const act = activate(v, W.pa.cookie);
    await until(() => held.state.entered, "held");
    const retirer = new pg.Client({ connectionString: db.url });
    await retirer.connect();
    try {
      const sMin = await conversion("s", "min");
      const retiring = retireConversion(retirer, sMin.id, W.pa.id);
      assert.ok(await waitsOnRows(), "the retirement waits for the activation's FOR SHARE");
      held.g.open();
      ok200(await act);
      await retiring;
    } finally {
      await retirer.end();
    }
    await restoreConversion("s", "min", 1, 60);
    const v2 = await version(await field(), { target: minVar, body: { conversionNote: "Seconds to minutes." } });
    const writer = new pg.Client({ connectionString: db.url });
    await writer.connect();
    try {
      await writer.query("begin");
      await retireConversion(writer, (await conversion("s", "min")).id, W.pa.id, { inTx: true });
      const act2 = activate(v2, W.pa.cookie);
      assert.ok(await waitsOnRows(), "the activation waits for the retirement");
      await writer.query("commit");
      refused(await act2, 409, "conversion_unavailable");
    } finally {
      await writer.query("rollback").catch(() => {});
      await writer.end();
    }
    await restoreConversion("s", "min", 1, 60);
  }
  // An activation against a level removal: the older Metrics API refuses a canonical
  // variable outright; as that catalog writes a removal (the definition FOR UPDATE,
  // then the capability row), the database serializes it with an activation.
  {
    const lVar = await variable(W.pa);
    const v = await version(await field(), { target: lVar });
    const held = holdM2("mapping_version_activate");
    const act = activate(v, W.pa.cookie);
    await until(() => held.state.entered, "held");
    const older = await api(`/definitions/${lVar.id}/scope-capabilities`, { method: "PUT", cookie: W.pa.cookie, body: { scopeCapabilities: ["session"] }, base: "/api/training-load/metrics" });
    assert.deepEqual([older.status, older.body.code], [409, "canonical_variable_read_only"], older.text);
    const remover = new pg.Client({ connectionString: db.url });
    await remover.connect();
    try {
      // Settled at once into a value, so its refusal is never an unhandled rejection.
      const removed = (async () => {
        await remover.query("begin");
        await remover.query(`select 1 from training_load.metric_definitions where id = $1 for update`, [lVar.id]);
        await remover.query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'component'`, [lVar.id]);
        await remover.query("commit");
      })().then(() => null, (error) => error);
      assert.ok(await waitsOnRows(), "the removal waits for the activation");
      held.g.open();
      ok200(await act);
      assert.match((await removed)?.message ?? "", /an active mapping version applies to this level; disable it first/);
    } finally {
      await remover.query("rollback").catch(() => {});
      await remover.end();
    }
    const lVar2 = await variable(W.pa);
    const v2 = await version(await field(), { target: lVar2 });
    const remover2 = new pg.Client({ connectionString: db.url });
    await remover2.connect();
    try {
      await remover2.query("begin");
      await remover2.query(`select 1 from training_load.metric_definitions where id = $1 for update`, [lVar2.id]);
      await remover2.query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'component'`, [lVar2.id]);
      const act2 = activate(v2, W.pa.cookie);
      assert.ok(await waitsOnRows(), "the activation waits for the removal");
      await remover2.query("commit");
      refused(await act2, 409, "level_not_allowed");
    } finally {
      await remover2.query("rollback").catch(() => {});
      await remover2.end();
    }
  }
  // An activation against L5 and L4 (the revision FOR SHARE against FOR UPDATE).
  {
    const f = await field();
    const v = await version(f);
    const held = holdM2("mapping_version_activate");
    const act = activate(v, W.pa.cookie);
    await until(() => held.state.entered, "held");
    const l5 = post(`/fields/${f.fieldId}/revisions/${f.revId}/retire`, W.pa2.cookie, { requestKey: key(), expectedState: "active", reason: "Stopped." });
    assert.ok(await waitsOnRows(), "L5 waits for the activation");
    held.g.open();
    ok200(await act);
    assert.deepEqual(ok200(await l5).disabledVersions, { system: 1, club: 0 }, "L5 disables the version the activation made active");
    assert.equal(await statusOf(v), "disabled");
  }
  {
    const f = await field();
    const v = await version(f);
    const heldL = holdLifecycle();
    const l5 = post(`/fields/${f.fieldId}/revisions/${f.revId}/retire`, W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "Stopped." });
    await until(() => heldL.state.entered, "L5 holds its locks");
    const act = activate(v, W.pa2.cookie);
    assert.ok(await waitsOnRows(), "the activation waits for L5");
    heldL.g.open();
    ok200(await l5);
    assert.deepEqual(refused(await act, 409, "version_not_submitted").current, { status: "disabled" });
  }
  {
    const f = await field();
    const r2 = await revisionOf(f, 2);
    const v = await version(f);
    const held = holdM2("mapping_version_activate");
    const act = activate(v, W.pa.cookie);
    await until(() => held.state.entered, "held");
    const l4 = post(`/fields/${f.fieldId}/revisions/${r2}/replace`, W.pa2.cookie, { requestKey: key(), reason: "Corrected.", expectedActiveRevisionId: f.revId });
    assert.ok(await waitsOnRows(), "L4 waits for the activation");
    held.g.open();
    ok200(await act);
    assert.deepEqual(ok200(await l4).disabledVersions, { system: 1, club: 0 });
    assert.equal(await statusOf(v), "disabled");
  }
  {
    const f = await field();
    const r2 = await revisionOf(f, 2);
    const v = await version(f);
    const heldL = holdLifecycle();
    const l4 = post(`/fields/${f.fieldId}/revisions/${r2}/replace`, W.pa.cookie, { requestKey: key(), reason: "Corrected.", expectedActiveRevisionId: f.revId });
    await until(() => heldL.state.entered, "L4 holds its locks");
    const act = activate(v, W.pa2.cookie);
    assert.ok(await waitsOnRows(), "the activation waits for L4");
    heldL.g.open();
    assert.deepEqual(ok200(await l4).disabledVersions, { system: 1, club: 0 });
    assert.deepEqual(refused(await act, 409, "version_not_submitted").current, { status: "disabled" });
  }
  // L2 on a draft revision: a version pinned to it is never activated (revision_not_verified).
  {
    const f = await field({ state: "draft" });
    const v = await version(f);
    const heldL = holdLifecycle();
    const l2 = post(`/fields/${f.fieldId}/revisions/${f.revId}/retire`, W.pa.cookie, { requestKey: key(), expectedState: "draft", reason: "Abandoned." });
    await until(() => heldL.state.entered, "L2 holds its locks");
    const act = activate(v, W.pa2.cookie);
    assert.ok(await waitsOnRows(), "the activation waits for L2");
    heldL.g.open();
    ok200(await l2);
    assert.deepEqual(refused(await act, 409, "version_not_submitted").current, { status: "disabled" });
  }
});

test("14. the pinned step (Q5, Q7): L4 and L5 disable an active pinned version - a system one and a club's (from the platform workspace) - each with its mapping_status row from active and the fixed reason, counted by owner scope only; an archived club's active version is 409 club_archived naming that club; from phase 7d an open activation is ended with the fixed reason (O5)", async () => {
  const f = await field();
  const r2 = await revisionOf(f, 2);
  const sysActive = await activeVersion(f);
  const clubActive = await version(f, { owner: W.caA, target: W.clubAVar });
  ok200(await activate(clubActive, W.paA.cookie));
  const submitted = await version(f, { target: await variable(W.pa) });
  const kL4 = key();
  const l4 = ok200(await post(`/fields/${f.fieldId}/revisions/${r2}/replace`, W.pa.cookie, { requestKey: kL4, reason: "Corrected.", expectedActiveRevisionId: f.revId }));
  assert.deepEqual(l4.disabledVersions, { system: 2, club: 1 });
  for (const id of [sysActive.versionId, clubActive.versionId, clubActive.mappingId, W.clubA]) assert.ok(!JSON.stringify(l4).includes(id), "counts only");
  const op = (await auditOf(`request_key = $1`, [kL4]))[0].operation_id;
  const disabledRows = await auditOf(`operation_id = $1 and action = 'mapping_status'`, [op]);
  const fromOf = Object.fromEntries(disabledRows.map((a) => [a.mapping_version_id, [a.from_status, a.to_status, a.reason, a.basis]]));
  assert.deepEqual(fromOf[sysActive.versionId], ["active", "disabled", PINNED_REASON, "platform_admin"]);
  assert.deepEqual(fromOf[clubActive.versionId], ["active", "disabled", PINNED_REASON, "platform_admin"]);
  assert.deepEqual(fromOf[submitted.versionId], ["needs_review", "disabled", PINNED_REASON, "platform_admin"]);
  // An archived club's active version.
  const g = await field();
  const clubLive = await version(g, { owner: W.caB, target: await variable(W.caB) });
  ok200(await activate(clubLive, W.paB.cookie));
  await k.query(`update public.clubs set is_active = false where id = $1`, [W.clubB]);
  try {
    const res = refused(await post(`/fields/${g.fieldId}/revisions/${g.revId}/retire`, W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "x" }), 409, "club_archived");
    assert.deepEqual(res.clubIds, [W.clubB]);
    assert.ok(!/restore the club/.test(res.message), "no route restores a club (R8)");
    assert.equal(await statusOf(clubLive), "active", "nothing written");
  } finally {
    await k.query(`update public.clubs set is_active = true where id = $1`, [W.clubB]);
  }
  // An open activation (phase 7d, O5): the pinned step ends it with the fixed
  // reason, then disables and retires.
  const h = await field();
  const hv = await activeVersion(h);
  const hActivation = await openActivation(hv);
  ok200(await post(`/fields/${h.fieldId}/revisions/${h.revId}/retire`, W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "x" }));
  assert.deepEqual(await endOf(hActivation), ["mapping_version_disabled", "platform_admin", PINNED_REASON]);
  assert.equal(await statusOf(hv), "disabled");
  assert.equal(lifecycle.PINNED_DISABLE_REASON, PINNED_REASON);
});

test("15. the COMMIT through A1's replacement: a lost answer is verified by the request key (200, verified_after_commit_error, N named); an unverifiable one is 503 outcome_unknown and the same key then answers the committed state; a definite refusal at COMMIT by v43's G1 (a seam splits the operation) is the sanitized 500 with nothing written and the key free; a right lost during A1 or A2, and the club archived during A1 or A2, is the identical 404 with nothing written", async () => {
  const f = await field();
  const n = await activeVersion(f);
  const n1 = await version(f);
  service.setMappingCommitForTests({ fault: async (client) => { await client.query("commit"); throw Object.assign(new Error("lost"), { code: "08006" }); } });
  const verified = ok200(await activate(n1, W.pa.cookie, { expected: n.versionId, reason: "Replace." }));
  assert.deepEqual([verified.commitConfirmation, verified.replaced, verified.version.status], ["verified_after_commit_error", n.versionId, "active"]);
  service.setMappingCommitForTests();
  // Unverifiable: the COMMIT lands, its answer is lost, and the check cannot answer.
  const n2 = await version(f);
  const k2 = key();
  service.setMappingCommitForTests({
    fault: async (client) => { await client.query("commit"); throw Object.assign(new Error("lost"), { code: "08006" }); },
    checkFault: () => new Promise(() => {}), checkTimeoutMs: 200,
  });
  const unknown = await activate(n2, W.pa.cookie, { requestKey: k2, expected: n1.versionId, reason: "Replace again." });
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.requestKey], [503, "outcome_unknown", k2]);
  service.setMappingCommitForTests();
  const replay = ok200(await activate(n2, W.pa.cookie, { requestKey: k2, expected: n1.versionId, reason: "Replace again." }));
  assert.deepEqual([replay.replayed, replay.replaced, replay.version.status], [true, n1.versionId, "active"]);
  // A definite refusal at COMMIT: the replaced version's row in another operation.
  const g = await field();
  const m = await activeVersion(g);
  const m1 = await version(g);
  const k3 = key();
  service.setMappingTransitionAuditFaultForTests("split_operation");
  const before = (await one(k, `select count(*)::int as n from training_load.source_metric_audit`)).n;
  const definite = await activate(m1, W.pa.cookie, { requestKey: k3, expected: m.versionId, reason: "Replace." });
  assert.deepEqual([definite.status, definite.body], [500, { error: "internal_error", message: "Something went wrong." }]);
  service.setMappingTransitionAuditFaultForTests(null);
  assert.deepEqual([await statusOf(m), await statusOf(m1)], ["active", "needs_review"], "nothing written");
  assert.equal((await one(k, `select count(*)::int as n from training_load.source_metric_audit`)).n, before);
  assert.ok(!logLines.some((l) => /source_metric_audit:/.test(l)), "no trigger text in the log");
  assert.equal(ok200(await activate(m1, W.pa.cookie, { requestKey: k3, expected: m.versionId, reason: "Replace." })).replaced, m.versionId, "the key is free");
  // A right lost during the write.
  const lost = await platformAdmin();
  const h = await field();
  const hv = await version(h);
  service.setMappingRightsHoldForTests(async () => {
    const other = new pg.Client({ connectionString: db.url });
    await other.connect();
    await other.query(`update public.user_global_roles set is_active = false where user_id = $1`, [lost.id]);
    await other.end();
  });
  isNotFound(await activate(hv, lost.cookie), "a right lost during the write");
  service.setMappingRightsHoldForTests(null);
  assert.equal(await statusOf(hv), "needs_review");
  // A state refusal is answered only after the right: a caller who lost it on a
  // version that is not submitted gets the identical 404, never `current`.
  const lost2 = await platformAdmin();
  const dv = await version(await field(), { submit: false });
  service.setMappingRightsHoldForTests(async () => {
    const other = new pg.Client({ connectionString: db.url });
    await other.connect();
    await other.query(`update public.user_global_roles set is_active = false where user_id = $1`, [lost2.id]);
    await other.end();
  });
  isNotFound(await activate(dv, lost2.cookie), "a lost right before a state refusal");
  service.setMappingRightsHoldForTests(null);
  // A2: a right lost during the write is the identical 404, nothing written, the key free.
  const lost3 = await platformAdmin();
  const ev = await activeVersion(await field());
  const kLost = key();
  service.setMappingRightsHoldForTests(async () => {
    const other = new pg.Client({ connectionString: db.url });
    await other.connect();
    await other.query(`update public.user_global_roles set is_active = false where user_id = $1`, [lost3.id]);
    await other.end();
  });
  isNotFound(await disable(ev, lost3.cookie, { requestKey: kLost, expectedStatus: "active" }), "A2: a right lost during the write");
  service.setMappingRightsHoldForTests(null);
  assert.equal(await statusOf(ev), "active");
  assert.equal((await auditOf(`request_key = $1`, [kLost])).length, 0);
  assert.equal(ok200(await disable(ev, W.pa.cookie, { requestKey: kLost, expectedStatus: "active" })).replayed, false, "the key is free");
  // The club archived during A1 and A2 on its version: the identical 404, nothing written.
  const cf = await field();
  const cv = await version(cf, { owner: W.caA, target: await variable(W.caA) });
  const archiveClubMidWrite = async () => {
    const other = new pg.Client({ connectionString: db.url });
    await other.connect();
    await other.query(`update public.clubs set is_active = false where id = $1`, [W.clubA]);
    await other.end();
  };
  try {
    service.setMappingRightsHoldForTests(archiveClubMidWrite);
    isNotFound(await activate(cv, W.paA.cookie), "A1: the club archived during the write");
    await k.query(`update public.clubs set is_active = true where id = $1`, [W.clubA]);
    isNotFound(await disable(cv, W.paA.cookie, { expectedStatus: "needs_review" }), "A2: the club archived during the write");
  } finally {
    service.setMappingRightsHoldForTests(null);
    await k.query(`update public.clubs set is_active = true where id = $1`, [W.clubA]);
  }
  assert.equal(await statusOf(cv), "needs_review", "nothing written");
  assert.equal((await auditOf(`mapping_version_id = $1 and to_status in ('active', 'disabled')`, [cv.versionId])).length, 0);
});

test("16. v43 by direct SQL, each with its fixed text: G1 refuses a replacement row without the replaced version's row in its operation (none, in another operation, with another reason) and an activation row whose operation disabled the mapping's active version; G2 refuses a disable row with another reason, a performed_at that is not now(), and a transition time in the future or before the transaction; the rows the service writes pass", async () => {
  const f = await field();
  const n = await activeVersion(f);
  const n1 = await version(f);
  const disableN = (c, reason = "R") => c.query(`update training_load.source_metric_mapping_versions set status = 'disabled', disabled_by_user_id = $2, disabled_at = clock_timestamp(), disabled_basis = 'platform_admin', disable_reason = $3 where id = $1`, [n.versionId, W.pa.id, reason]);
  const activateN1 = (c, at = "clock_timestamp()") => c.query(`update training_load.source_metric_mapping_versions set status = 'active', activated_by_user_id = $2, activated_at = ${at}, activated_basis = 'platform_admin' where id = $1`, [n1.versionId, W.pa.id]);
  const row = (c, { action, v, from, to, reason = null, op, performedAt = null, mappingId = n.mappingId }) => c.query(
    `insert into training_load.source_metric_audit (action, mapping_id, mapping_version_id, from_status, to_status, reason, performed_by_user_id, basis, operation_id${performedAt ? ", performed_at" : ""})
     values ($1,$2,$3,$4,$5,$6,$7,'platform_admin',$8${performedAt ? `, ${performedAt}` : ""})`, [action, mappingId, v, from, to, reason, W.pa.id, op]);
  // G1, none: a version of a mapping with no active version, labelled a replacement.
  const lone = await version(await field());
  refusedWith(await tx(W.pa.id, async (c) => {
    await c.query(`update training_load.source_metric_mapping_versions set status = 'active', activated_by_user_id = $2, activated_at = clock_timestamp(), activated_basis = 'platform_admin' where id = $1`, [lone.versionId, W.pa.id]);
    await row(c, { action: "mapping_version_replaced", v: lone.versionId, from: "needs_review", to: "active", reason: "R", op: crypto.randomUUID(), mappingId: lone.mappingId });
  }), "23514", G1_REPLACED);
  assert.equal(await statusOf(lone), "needs_review");
  // G1: the replaced version's row in another operation, or with another reason.
  for (const [label, write] of [
    ["another operation", async (c, op) => { await disableN(c); await activateN1(c); await row(c, { action: "mapping_status", v: n.versionId, from: "active", to: "disabled", reason: "R", op: crypto.randomUUID() }); await row(c, { action: "mapping_version_replaced", v: n1.versionId, from: "needs_review", to: "active", reason: "R", op }); }],
    ["another reason", async (c, op) => { await disableN(c); await activateN1(c); await row(c, { action: "mapping_status", v: n.versionId, from: "active", to: "disabled", reason: "R", op }); await row(c, { action: "mapping_version_replaced", v: n1.versionId, from: "needs_review", to: "active", reason: "Other", op }); }],
  ]) {
    refusedWith(await tx(W.pa.id, (c) => write(c, crypto.randomUUID())), "23514", G1_REPLACED);
    assert.deepEqual([await statusOf(n), await statusOf(n1)], ["active", "needs_review"], label);
  }
  // G1: an activation row whose operation disabled the mapping's active version.
  refusedWith(await tx(W.pa.id, async (c) => {
    const op = crypto.randomUUID();
    await disableN(c); await activateN1(c);
    await row(c, { action: "mapping_status", v: n.versionId, from: "active", to: "disabled", reason: "R", op });
    await row(c, { action: "mapping_status", v: n1.versionId, from: "needs_review", to: "active", op });
  }), "23514", G1_ACTIVATION);
  // G2: a disable row with another reason than the version's.
  refusedWith(await tx(W.pa.id, async (c) => {
    await disableN(c, "Stored reason.");
    await row(c, { action: "mapping_status", v: n.versionId, from: "active", to: "disabled", reason: "Audited reason.", op: crypto.randomUUID() });
  }), "23514", G2_REASON);
  // G2: a performed_at that is not the transaction's time.
  refusedWith(await tx(W.pa.id, async (c) => {
    await disableN(c);
    await row(c, { action: "mapping_status", v: n.versionId, from: "active", to: "disabled", reason: "R", op: crypto.randomUUID(), performedAt: "now() - interval '1 second'" });
  }), "23514", G2_PERFORMED);
  // G2: the transition's own time in the future, and before the transaction.
  for (const at of ["clock_timestamp() + interval '1 day'", "now() - interval '1 second'"]) {
    refusedWith(await tx(W.pa.id, async (c) => {
      await c.query(`update training_load.source_metric_mapping_versions set status = 'disabled', disabled_by_user_id = $2, disabled_at = ${at}, disabled_basis = 'platform_admin', disable_reason = 'R' where id = $1`, [n.versionId, W.pa.id]);
      await row(c, { action: "mapping_status", v: n.versionId, from: "active", to: "disabled", reason: "R", op: crypto.randomUUID() });
    }), "23514", G2_TIME);
  }
  assert.deepEqual([await statusOf(n), await statusOf(n1)], ["active", "needs_review"], "nothing of any refusal stayed");
  // The rows the service writes pass: a replacement written the same way, committed.
  okTx(await tx(W.pa.id, async (c) => {
    const op = crypto.randomUUID();
    await disableN(c, "Replaced.");
    await activateN1(c);
    await row(c, { action: "mapping_status", v: n.versionId, from: "active", to: "disabled", reason: "Replaced.", op });
    await row(c, { action: "mapping_version_replaced", v: n1.versionId, from: "needs_review", to: "active", reason: "Replaced.", op });
  }));
  assert.deepEqual([await statusOf(n), await statusOf(n1)], ["disabled", "active"]);
});

test("17. no answer of this file carries a disable reason, a trigger text or SQL; the log carries no reason and no trigger text", async () => {
  // Reasons of at least eight characters: a one-letter reason ("x") occurs in any text.
  const reasons = [...sentReasons].filter((reason) => reason.length >= 8);
  assert.ok(reasons.length >= 8, `the helpers sent the suite's reasons (${reasons.length})`);
  for (const text of responses) {
    for (const reason of reasons) assert.ok(!text.includes(reason), `an answer carries a reason: ${text.slice(0, 120)}`);
    assert.ok(!/source_metric_audit:|source_metric_mapping_versions:|select |insert into/i.test(text), `an answer carries database text: ${text.slice(0, 120)}`);
  }
  for (const line of logLines) {
    for (const reason of reasons) assert.ok(!line.includes(reason), "the log carries a reason");
    assert.ok(!/source_metric_audit:/.test(line), "the log carries a v43 trigger text");
  }
});

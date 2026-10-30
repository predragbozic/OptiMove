// Phase 7d - T5 activations: S1 (POST /activations), S2 (POST
// /activations/:activationId/end), S3 (GET /activations), the D6 ends of A1, A2
// and the revision lifecycle's pinned step, and migration v48.
// Contract: docs/ai/phase7d-mapping-activations-contract.md (J10), section 10.
// Through the real HTTP stack, on disposable optimove_tests_gpexe_* databases only
// (never OPTIMOVE, never a real GPEXE field or connection): one migrated through
// v47 that rehearses v48 (the preflight, the runner, the post-check, every refusal
// of the rollback, the rollback back to v47's exact catalog, and v48 again), and
// one migrated through v48 for the behaviour. Every field, variable, mapping,
// connection and binding here is a test row of this file (a connection's
// credential parts are random bytes of the right lengths: nothing is ever
// decrypted or sent).
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
const V48 = "202610301900_training_load_v48_mapping_activations.sql";
const V48_NAME = `migrations_v2/${V48}`;
const V47_NAME = "migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql";
const UP_TO_V47 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V48));
const V48_FILE = path.resolve(ROOT, "migrations_v2", V48);
const RUNBOOKS = path.resolve(ROOT, "docs/runbooks");
const ROLLBACK = path.join(RUNBOOKS, "mapping-activations-v48-rollback.sql");
const PREFLIGHT = path.join(RUNBOOKS, "mapping-activations-v48-preflight.sql");
const POSTCHECK = path.join(RUNBOOKS, "mapping-activations-v48-postcheck.sql");
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const PINNED_REASON = "Source revision retired.";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const ACTOR_T5 = /^source metric activation: the acting user may not write this activation$/;
const ACTOR_T8 = /^source metric activation: the acting user may not write this audit row$/;
const NO_CLUB = /^source_metric_mapping_activations: the binding's connection is not owned by a club$/;
const END_TIME = /^source_metric_mapping_activations: an end carries the time of its own transaction$/;
const START_LINK = /^source_metric_mapping_activations: an activation is started with its activation_start audit row$/;
const END_LINK = /^source_metric_mapping_activations: an activation is ended with its activation_end audit row$/;
const VERSION_LINK = /^source_metric_mapping_activations: a version-driven end sits in the transaction that disabled its version$/;
const REPLACED_LINK = /^source_metric_mapping_activations: a replaced end sits in the operation of its mapping's replacement$/;
const AUDIT_FOLLOWS = /^source_metric_audit: the audit row must follow its own activation change in the same transaction$/;
const AUDIT_ONCE = /^source_metric_audit: the activation change already has its audit row$/;
const AUDIT_NAMES = /^source_metric_audit: an activation row must name its own mapping version and team$/;

let rdb, db, r, k, server, apiBase, service, activations, lifecycle, dbModule, appPool, createSession;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};

async function migrate(url, files, { extra = null } = {}) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v48-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of files) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    if (extra) await fsp.writeFile(path.join(dir, extra.name), extra.text);
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

before(async () => {
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V48), "v48 is a test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v48rb", migrations: UP_TO_V47 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v48" }),
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
      if (process.env.V48_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  activations = await import("../src/sourceMetricActivationService.js");
  lifecycle = await import("../src/sourceRevisionLifecycleService.js");
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
  service?.setMappingWriteHoldForTests(null);
  activations?.setActivationWriteHoldForTests(null);
  activations?.setActivationAuditFaultForTests(null);
  lifecycle?.setRevisionWriteHoldForTests(null);
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

async function api(p, { method = "GET", body, cookie, contentType = "application/json" } = {}) {
  const res = await fetch(`${apiBase}${PREFIX}${p}`, {
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
const post = (p, cookie, body, opts = {}) => api(p, { method: "POST", cookie, body, ...opts });
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const refused = (res, status, code) => { assert.deepEqual([res.status, res.body.error], [status, code], res.text); return res.body; };
const isNotFound = (res, label) => { assert.equal(res.status, 404, `${label}: ${res.text}`); assert.deepEqual(res.body, { error: "notFound" }, label); };

// Every reason sent; test 16 scans every answer and log line for them.
const sentReasons = new Set();
const reasonFor = (label) => { const text = `${label} ${uid()}`; sentReasons.add(text); return text; };
const actPath = (v) => `/mappings/${v.mappingId}/versions/${v.versionId}/activate`;
const disPath = (v) => `/mappings/${v.mappingId}/versions/${v.versionId}/disable`;
const activate = (v, cookie, { expected = null, reason, requestKey = key(), extra = {} } = {}) => {
  if (typeof reason === "string") sentReasons.add(reason);
  return post(actPath(v), cookie, { requestKey, expectedActiveVersionId: expected, ...(reason === undefined ? {} : { reason }), ...extra });
};
const disable = (v, cookie, { expectedStatus = "active", reason = reasonFor("Disable."), requestKey = key() } = {}) => post(disPath(v), cookie, { requestKey, expectedStatus, reason });
const listed = (bindings) => bindings.map((b) => ({ bindingId: b.bindingId ?? b, requirement: b.requirement ?? "required" }));
const startBody = (v, bindings, { reason = reasonFor("Start."), requestKey = key() } = {}) => ({ requestKey, mappingId: v.mappingId, versionId: v.versionId, bindings: listed(bindings), reason });
const start = (who, v, bindings, opts = {}) => post("/activations", who.cookie, startBody(v, bindings, opts));
const endBody = ({ reason = reasonFor("End."), requestKey = key(), expectedState = "open" } = {}) => ({ requestKey, expectedState, reason });
const end = (who, id, opts = {}) => post(`/activations/${id}/end`, who.cookie, endBody(opts));
const list = (who, query) => api(`/activations?${new URLSearchParams(query)}`, { cookie: who.cookie });

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
async function clubAdmin(clubId, ws = ["club", clubId]) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await workspace(id, ws[0], ws[1]);
  return { id, cookie: await cookieFor(id) };
}
async function teamCoach(clubId) {
  const teamId = (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
  const id = await user("coach");
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await workspace(id, "team", teamId);
  return { id, cookie: await cookieFor(id) };
}
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const setClubActive = (clubId, active) => k.query(`update public.clubs set is_active = $2 where id = $1`, [clubId, active]);
// Club C restored, with its admins back in its workspace (a request made while
// it was archived falls back to another workspace and stores that preference).
async function restoreClubC() {
  await setClubActive(W.clubC, true);
  for (const who of [W.caC, W.paC]) await workspace(who.id, "club", W.clubC);
}
const setTeamActive = (teamId, active) => k.query(`update public.teams set is_active = $2 where id = $1`, [teamId, active]);

// A club-owned server3 connection per club (state verified; the credential
// parts are random bytes, never decrypted), and one team binding per call.
const connectionOf = new Map();
let gpexeTeamCounter = 0;
async function connection(clubId) {
  if (!connectionOf.has(clubId)) {
    connectionOf.set(clubId, (await one(k,
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                                credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','club',$1,'server3','7d test','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
      [clubId, W.pa.id, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id);
  }
  return connectionOf.get(clubId);
}
async function binding(clubId, { connectionId = null } = {}) {
  const teamId = (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
  gpexeTeamCounter += 1;
  const sourceTeamId = String(970000 + gpexeTeamCounter);
  await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)`, [teamId, sourceTeamId, W.pa.id]);
  const bindingId = (await one(k,
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
     values ($1,$2,'gpexe',$3,$4,$1) returning id`, [teamId, connectionId ?? await connection(clubId), sourceTeamId, W.pa.id])).id;
  return { bindingId, teamId, clubId };
}
// An Unbind's effect on the row (v27; sourceConnectionService's unbindTeam
// writes the same columns).
const unbind = (b, client = k) => client.query(
  `update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'Test unbind.' where id = $1`, [b.bindingId, W.pa.id]);
const sortedBindings = (...bs) => [...bs].sort((a, b) => (a.bindingId < b.bindingId ? -1 : 1));

// A canonical variable through the M3-0 API (numeric, both levels).
async function variable(owner) {
  const res = await post("/variables", owner.cookie, { requestKey: key(), label: `Activation variable ${uid()}`, unit: "s", levels: ["session", "drill"], dailyAggregationMethod: "sum" });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.variable.id };
}
// A test field of gpexe / rest_v1 (or another API family) whose revision 1 is active and verified.
async function field({ apiFamily = "rest_v1" } = {}) {
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe',$1,$2,'7d test field',$3) returning id`,
    [apiFamily, `v48.test.f${uid()}`, W.pa.id])).id;
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: "number", parameterKind: "none", evidenceRef: COMPAT, unit: "s", unitRef: UNIT_REF, meaning: true, meaningRef: MEANING_REF, state: "active" });
  return { fieldId, revId };
}
// A mapping version of field `f` to `target`, through the real M2 routes, submitted.
async function version(f, { owner = W.pa, target }) {
  let mappingId = (await one(k, `select id from training_load.source_metric_mappings where source_metric_definition_id = $1 and metric_definition_id = $2`, [f.fieldId, target.id]))?.id;
  if (!mappingId) {
    const m = await post("/mappings", owner.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id });
    assert.equal(m.status, 201, m.text);
    mappingId = m.body.mapping.id;
  }
  const v = await post(`/mappings/${mappingId}/versions`, owner.cookie, { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true });
  assert.equal(v.status, 201, v.text);
  assert.equal((await post(`/mappings/${mappingId}/versions/${v.body.version.id}/submit`, owner.cookie, { requestKey: key() })).status, 200);
  return { mappingId, versionId: v.body.version.id, fieldId: f.fieldId, revId: f.revId, target };
}
// An active system version (a fresh field and variable), activated by A1 in the platform workspace.
async function sysVersion({ f = null, target = null } = {}) {
  const v = await version(f ?? await field(), { target: target ?? await variable(W.pa) });
  ok(await activate(v, W.pa.cookie));
  return v;
}
// An active club version of `clubAdminUser`'s club, activated by that club's platform admin.
async function clubVersion(clubAdminUser, clubPlatformAdmin) {
  const v = await version(await field(), { owner: clubAdminUser, target: await variable(clubAdminUser) });
  ok(await activate(v, clubPlatformAdmin.cookie));
  return v;
}
const t5 = (id) => one(k, `select * from training_load.source_metric_mapping_activations where id = $1`, [id]);
const t5Count = async () => (await one(k, `select count(*)::int as n from training_load.source_metric_mapping_activations`)).n;
const auditOf = (sql, params) => rows(k, `select * from training_load.source_metric_audit where ${sql} order by performed_at, id`, params);
const statusOf = async (v) => (await one(k, `select status from training_load.source_metric_mapping_versions where id = $1`, [v.versionId])).status;
// One raw open activation of version v on binding b (triggers off, as a fixture
// of a state the routes cannot build by themselves - a disposable database only).
async function rawActivation(v, b, { by = W.pa.id } = {}) {
  const row = await one(k, `select * from training_load.source_metric_mapping_versions where id = $1`, [v.versionId]);
  await k.query("begin");
  try {
    await k.query("set local session_replication_role = replica");
    const id = (await one(k, `insert into training_load.source_metric_mapping_activations (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint,
                                 source_team_binding_id, team_id, applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
                               values ($1,$2,$3,$4,$5,$6,$7,true,true,'required',$8,'platform_admin','Raw fixture') returning id`,
      [v.versionId, v.mappingId, row.source_metric_definition_id, row.metric_definition_id, row.parameter_fingerprint, b.bindingId, b.teamId, by])).id;
    await k.query("commit");
    return id;
  } catch (error) {
    await k.query("rollback").catch(() => {});
    throw error;
  }
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

async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    tables: await rows(c, `select table_schema, table_name, obj_description((quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass, 'pg_class') as comment from information_schema.tables where table_schema in ${S} order by 1, 2`),
    columns: await rows(c, `select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ${S} order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, c.contype, pg_get_constraintdef(c.oid) as def, c.convalidated from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    indexes: await rows(c, `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ${S} order by 1, 2, 3`),
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled, obj_description(t.oid, 'pg_trigger') as comment from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest, obj_description(p.oid, 'pg_proc') as comment from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
async function blocks(c, file) {
  const text = await fsp.readFile(file, "utf8");
  const out = {};
  for (const part of text.split(/^(?=-- \d+\. )/m).slice(1)) out[Number(part.match(/^-- (\d+)\./)[1])] = (await c.query(part)).rows;
  return out;
}
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
async function someoneWaits(c = k, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await one(c, `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`)).n > 0) return true;
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
// Holds the next activation write named `where` ("activation_start" or
// "activation_end") after its locks and checks until the gate opens.
function holdActivation(where) {
  const g = gate();
  const state = { entered: false };
  activations.setActivationWriteHoldForTests(async (_client, at) => {
    if (at !== where || state.entered) return;
    state.entered = true;
    await g.promise;
  });
  return { g, state };
}
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

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.pa = await platformAdmin();
  W.pa2 = await platformAdmin();
  W.paA = await platformAdmin(["club", W.clubA]);
  W.paB = await platformAdmin(["club", W.clubB]);
  W.caA = await clubAdmin(W.clubA);
  W.caA2 = await clubAdmin(W.clubA);
  W.caB = await clubAdmin(W.clubB);
  // An admin of two clubs, active in club B's workspace (a workspace preference
  // for a club a user holds no role in falls back to one it does).
  W.caAB = await clubAdmin(W.clubA, ["club", W.clubB]);
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [W.caAB.id, W.clubB]);
  // Club C is archived and restored by the tests that need an archived club.
  W.clubC = await club("Club C");
  W.caC = await clubAdmin(W.clubC);
  W.paC = await platformAdmin(["club", W.clubC]);
  // A platform admin who also holds club A and club B workspaces (the
  // cross-workspace replays switch its preference).
  W.pa3 = await platformAdmin();
  for (const c of [W.clubA, W.clubB]) await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [W.pa3.id, c]);
  W.coachA = await teamCoach(W.clubA);
  W.plain = { id: await user("no-role") };
  await workspace(W.plain.id, "platform", null);
  W.plain.cookie = await cookieFor(W.plain.id);
  W.bA1 = await binding(W.clubA);
  W.bA2 = await binding(W.clubA);
  W.bB1 = await binding(W.clubB);
}

// ---------------------------------------------------------------------------
// The rehearsal database (through v47).
// ---------------------------------------------------------------------------
test("1. on v47: every expected value of the read-only preflight (block 4 counts an activation and an activation audit row, block 5 a binding whose connection is not club-owned); the rollback refuses without v48", async () => {
  const pre = await blocks(r, PREFLIGHT);
  assert.deepEqual(Object.keys(pre).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(pre[1][0].pg15_or_later, true);
  assert.deepEqual(pre[2][0], { v47_rows: "1", v47_checksum_ok: true, v48_rows: "0", at_or_after_v48: "0", last_migration: V47_NAME });
  assert.deepEqual(pre[3][0], { t5_insert_guard_is_v34: true, t5_update_guard_is_v34: true, audit_row_ok_is_v34: true, audit_insert_guard_is_v34: true, audit_actor_guard_is_v35: true, audit_revision_guard_is_v47: true });
  assert.deepEqual(pre[4][0], { activations: "0", activation_audit_rows: "0", safe_to_merge: true });
  assert.deepEqual(pre[5][0], { bindings_without_club: "0", bindings_total: "0" });
  assert.deepEqual(pre[6][0], { v48_functions: "0", v48_triggers: "0", v48_index: "0", basis_checks_are_v34: true });
  assert.deepEqual(pre[7][0], { schema_create: true, owns_activations: true, owns_audit: true, disabled_triggers: "0" });
  assert.deepEqual(pre[8][0], { actor_defaults: "0" });
  assert.deepEqual(pre[9][0], { table_locks: "0", idle_in_transaction: "0" });
  // Blocks 4 and 5 count what they must stop on (rows planted with triggers off, rolled back).
  await r.query("begin");
  try {
    await r.query("set local session_replication_role = replica");
    const id = crypto.randomUUID();
    await r.query(`insert into training_load.source_metric_mapping_activations (id, mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, source_team_binding_id, team_id,
                     applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
                   values ($1,$1,$1,$1,$1,'',$1,$1,true,true,'required',$1,'platform_admin','x')`, [id]);
    await r.query(`insert into training_load.source_metric_audit (action, mapping_version_id, activation_id, team_id, reason, performed_by_user_id, basis, operation_id)
                   values ('activation_start',$1,$1,$1,'x',$1,'platform_admin',$1)`, [id]);
    await r.query(`insert into training_load.source_credential_connections (id, source_system, owner_scope, owner_team_id, host_key, account_label, credential_kind, created_by_user_id, state)
                   values ($1,'gpexe','team',$1,'server3','x','exchanged_token',$1,'not_connected')`, [id]);
    await r.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$1,'gpexe','1',$1)`, [id]);
    const planted = await blocks(r, PREFLIGHT);
    assert.deepEqual(planted[4][0], { activations: "1", activation_audit_rows: "1", safe_to_merge: false });
    assert.deepEqual(planted[5][0], { bindings_without_club: "1", bindings_total: "1" });
  } finally {
    await r.query("rollback");
  }
  assert.match((await inRolledBack(r, null, ROLLBACK))?.message ?? "", /^v48 rollback refused: v48 is not recorded on this database$/);
  W.before47 = await catalog(r);
});

test("2. v48 through the runner on v47 - waiting for a reader of the activations, then applying with no deadlock - adds exactly its three functions, two triggers and one index, widens the two basis CHECKs and the table comment, and replaces six bodies; every expected value of the post-check", async () => {
  const holder = new pg.Client({ connectionString: rdb.url });
  await holder.connect();
  let applying;
  try {
    await holder.query("begin");
    await holder.query(`select 1 from training_load.source_metric_mapping_activations for share`);
    applying = migrate(rdb.url, [...UP_TO_V47, V48]);
    assert.equal(await someoneWaits(r), true, "v48 waits for the reader");
    await holder.query("commit");
    await applying;
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  const after = await catalog(r);
  const before = W.before47;
  const t5Table = (x) => x.table_name === "source_metric_mapping_activations";
  assert.deepEqual(after.tables.filter((x) => !t5Table(x)), before.tables.filter((x) => !t5Table(x)), "every other table and comment unchanged");
  assert.match(after.tables.find(t5Table).comment, /^v34 \(D7, T5\): .* v48 \(C106\): started by a platform admin or by the active admin of the club that owns the binding's connection/);
  assert.deepEqual(after.columns, before.columns, "columns unchanged");
  const conKey = (x) => `${x.rel}.${x.conname}`;
  assert.deepEqual(after.constraints.filter((x) => !before.constraints.some((y) => conKey(y) === conKey(x))).map((x) => [x.rel, x.conname, x.contype, x.convalidated]).sort(), [
    ["training_load.source_metric_mapping_activations", "source_metric_activations_v48_audit_link_end", "t", true],
    ["training_load.source_metric_mapping_activations", "source_metric_activations_v48_audit_link_start", "t", true],
  ]);
  const changedConstraints = after.constraints.filter((x) => before.constraints.some((y) => conKey(y) === conKey(x) && y.def !== x.def));
  assert.deepEqual(changedConstraints.map((x) => [x.conname, x.def, x.convalidated]).sort(), [
    ["source_metric_activations_activated_basis_check", "CHECK ((activated_basis = ANY (ARRAY['platform_admin'::text, 'club_admin'::text])))", true],
    ["source_metric_activations_ended_basis_check", "CHECK (((ended_basis IS NULL) OR (ended_basis = ANY (ARRAY['platform_admin'::text, 'club_admin'::text]))))", true],
  ]);
  assert.deepEqual(after.indexes.filter((x) => !before.indexes.some((y) => y.indexname === x.indexname)).map((x) => x.indexname), ["source_metric_audit_v48_activation_once"]);
  assert.deepEqual(after.indexes.filter((x) => x.indexname !== "source_metric_audit_v48_activation_once"), before.indexes);
  const fnKey = (x) => `${x.nspname}.${x.proname}(${x.args})`;
  const newFunctions = after.functions.filter((x) => !before.functions.some((y) => fnKey(y) === fnKey(x)));
  assert.deepEqual(newFunctions.map((x) => x.proname).sort(), ["source_metric_activations_end_link", "source_metric_activations_start_link", "source_metric_binding_club"]);
  const changed = after.functions.filter((x) => !newFunctions.includes(x) && !before.functions.some((y) => fnKey(y) === fnKey(x) && y.digest === x.digest));
  assert.deepEqual(changed.map((x) => x.proname).sort(), ["source_metric_activations_insert_guard", "source_metric_activations_update_guard", "source_metric_audit_actor_guard",
    "source_metric_audit_insert_guard", "source_metric_audit_revision_guard", "source_metric_audit_row_ok"]);
  const trigKey = (x) => `${x.relname}.${x.tgname}`;
  const newTriggers = after.triggers.filter((x) => !before.triggers.some((y) => trigKey(y) === trigKey(x)));
  assert.deepEqual(newTriggers.map((x) => [x.relname, x.tgname, x.tgenabled]).sort(), [
    ["source_metric_mapping_activations", "source_metric_activations_v48_audit_link_end", "O"], ["source_metric_mapping_activations", "source_metric_activations_v48_audit_link_start", "O"]]);
  assert.deepEqual(after.triggers.filter((x) => !newTriggers.includes(x)), before.triggers, "every other trigger unchanged");
  assert.deepEqual(after.migrations, [...before.migrations, V48_NAME].sort());
  // v47's revision guard plus the activation branch, nothing else.
  const prosrc = async (c, name) => (await one(c, `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = $1`, [name])).prosrc;
  const v48Body = await prosrc(r, "source_metric_audit_revision_guard");
  const branchStart = v48Body.indexOf("  if new.action in ('activation_start', 'activation_end') then");
  const branchEnd = v48Body.indexOf("  if new.action not in ('source_metric_unit_verified', 'source_metric_meaning_verified') then");
  assert.ok(branchStart > 0 && branchEnd > branchStart);
  W.v47Body = v48Body.slice(0, branchStart) + v48Body.slice(branchEnd);
  const post = await blocks(r, POSTCHECK);
  assert.deepEqual(Object.keys(post).map(Number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(post[1][0], { v48_rows: "1", v48_checksum_ok: true, later_migrations: "0" });
  assert.deepEqual(post[2][0], { bodies_v48: "9" });
  assert.deepEqual(post[3][0], { basis_checks_v48: "2" });
  assert.deepEqual(post[4][0], { links_ok: "2", guards_enabled: "2" });
  assert.deepEqual(post[5][0], { index_ok: true });
  assert.deepEqual(post[6][0], { activations: "0", activation_audit_rows: "0" });
  const sha = crypto.createHash("sha256").update(await fsp.readFile(V48_FILE)).digest("hex");
  assert.ok((await fsp.readFile(POSTCHECK, "utf8")).includes(sha), "the post-check names the v48 file's sha256");
  W.after48 = after;
});

test("3. the rollback refuses, changing nothing: under a later migration, once an activation or an activation audit row exists, while a v48 object is missing or a v48 trigger is disabled, while a body in force is not v48's, and while the migrator holds its lock", async () => {
  const refuses = async (plant, pattern) => {
    const error = await inRolledBack(r, plant, ROLLBACK);
    assert.match(error?.message ?? "", pattern);
    assert.deepEqual(await catalog(r), W.after48, `nothing changed (${pattern})`);
  };
  const raw = async (c, sql, params) => { await c.query("set local session_replication_role = replica"); await c.query(sql, params); };
  await refuses((c) => c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', $1, 'test')`, ["0".repeat(64)]),
    /^v48 rollback refused: later migrations are applied$/);
  const id = crypto.randomUUID();
  await refuses((c) => raw(c, `insert into training_load.source_metric_mapping_activations (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, source_team_binding_id, team_id,
                     applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason) values ($1,$1,$1,$1,'',$1,$1,true,true,'required',$1,'platform_admin','x')`, [id]),
  /^v48 rollback refused: an activation exists$/);
  await refuses((c) => raw(c, `insert into training_load.source_metric_audit (action, mapping_version_id, activation_id, team_id, performed_by_user_id, basis, operation_id)
                                values ('activation_end',$1,$1,$1,$1,'platform_admin',$1)`, [id]),
  /^v48 rollback refused: an activation audit row exists$/);
  await refuses((c) => c.query(`alter table training_load.source_metric_mapping_activations disable trigger source_metric_activations_v48_audit_link_end`),
    /^v48 rollback refused: a v48 trigger is disabled$/);
  await refuses(async (c) => {
    await c.query(`drop trigger source_metric_activations_v48_audit_link_start on training_load.source_metric_mapping_activations`);
    await c.query(`drop function training_load.source_metric_activations_start_link()`);
  }, /^v48 rollback refused: a v48 function is missing; a v48 trigger is missing$/);
  await refuses(async (c) => {
    await c.query(`alter table training_load.source_metric_mapping_activations drop constraint source_metric_activations_ended_basis_check`);
    await c.query(`alter table training_load.source_metric_mapping_activations add constraint source_metric_activations_ended_basis_check check (ended_basis is null or ended_basis = 'platform_admin')`);
  }, /^v48 rollback refused: a v48 constraint is missing$/);
  await refuses((c) => c.query(`drop index training_load.source_metric_audit_v48_activation_once`), /^v48 rollback refused: the v48 index is missing$/);
  for (const name of ["source_metric_activations_insert_guard", "source_metric_activations_update_guard", "source_metric_audit_insert_guard", "source_metric_audit_actor_guard", "source_metric_audit_revision_guard"]) {
    await refuses((c) => c.query(`create or replace function training_load.${name}() returns trigger as $$ begin return new; end; $$ language plpgsql`),
      /^v48 rollback refused: a body in force is not v48's$/);
  }
  await refuses((c) => c.query(`create or replace function training_load.source_metric_audit_row_ok(p_action text, p_targets text, p_from text, p_to text, p_reason text, p_evidence text, p_basis text)
                                  returns boolean language sql immutable as $$ select true $$`), /^v48 rollback refused: a body in force is not v48's$/);
  assert.match(await fsp.readFile(path.join(ROOT, "backend", "src", "migrate.js"), "utf8"), /export const MIGRATION_LOCK_KEY = 822026n;/);
  const migrator = new pg.Client({ connectionString: rdb.url });
  await migrator.connect();
  try {
    await migrator.query("select pg_advisory_lock(822026)");
    await refuses(null, /^v48 rollback refused: the migrator is running$/);
  } finally {
    await migrator.query("select pg_advisory_unlock(822026)").catch(() => {});
    await migrator.end();
  }
  for (const file of [ROLLBACK, PREFLIGHT, POSTCHECK, V48_FILE]) {
    assert.ok(!(await fsp.readFile(file, "utf8")).includes("\r"), `${path.basename(file)} has LF line endings`);
  }
});

test("4. the rollback returns v47's catalog exactly (comments included; v47's body of the revision guard byte for byte) and changes no row; v48 then applies again to the same catalog; a v48 whose last statement fails leaves nothing", async () => {
  const before = (await one(r, `select count(*)::int as n from training_load.source_metric_audit`)).n;
  await r.query(await fsp.readFile(ROLLBACK, "utf8"));
  assert.deepEqual(await catalog(r), W.before47, "v47's catalog");
  assert.equal((await one(r, `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = 'source_metric_audit_revision_guard'`)).prosrc, W.v47Body);
  assert.equal((await one(r, `select count(*)::int as n from training_load.source_metric_audit`)).n, before);
  const failing = `${await fsp.readFile(V48_FILE, "utf8")}\nselect 1 / 0;\n`;
  await assert.rejects(migrate(rdb.url, UP_TO_V47, { extra: { name: V48, text: failing } }));
  assert.deepEqual(await catalog(r), W.before47, "a failing v48 leaves nothing");
  await migrate(rdb.url, [...UP_TO_V47, V48]);
  assert.deepEqual(await catalog(r), W.after48, "v48 again");
});

// ---------------------------------------------------------------------------
// The behaviour database (through v48).
// ---------------------------------------------------------------------------
test("5. the audience (section 2.1): 401 without a session; the identical 404 before the body for a coach and a user with no role; then, for the admins, another club's binding or mapping, an admin of two clubs in the other club's workspace, the platform workspace on a club mapping, a version not of the named mapping, an unknown binding, an archived club (both bases, S1 and S2) and an archived team (S1) - each the identical 404 with nothing written; S2 still ends an activation on an archived team's binding", async () => {
  const v = await sysVersion();
  const cv = await clubVersion(W.caA, W.paA);
  const vB = await clubVersion(W.caB, W.paB);
  const before = await t5Count();
  for (const p of ["/activations", `/activations/${crypto.randomUUID()}/end`]) assert.equal((await post(p, null, {})).status, 401);
  assert.equal((await api(`/activations?bindingId=${W.bA1.bindingId}`)).status, 401);
  for (const who of [W.coachA, W.plain]) {
    for (const p of ["/activations", `/activations/${crypto.randomUUID()}/end`]) {
      isNotFound(await post(p, who.cookie, "not json", { contentType: "text/plain" }), `${p} before 415`);
      isNotFound(await post(p, who.cookie, []), `${p} before 400`);
    }
    isNotFound(await start(who, v, [W.bA1]), "S1");
    isNotFound(await list(who, { bindingId: W.bA1.bindingId }), "S3");
    isNotFound(await activate(v, who.cookie), "A1");
  }
  for (const who of [W.pa, W.paA, W.caA]) {
    assert.equal((await post("/activations", who.cookie, "x", { contentType: "text/plain" })).status, 415);
    refused(await post("/activations", who.cookie, []), 400, "invalid_body");
    isNotFound(await post("/activations/not-a-uuid/end", who.cookie, endBody()), "a malformed id");
    isNotFound(await end(who, crypto.randomUUID()), "an unknown id");
  }
  for (const [who, ver, bs, label] of [
    [W.caA, v, [W.bB1], "a club admin on another club's binding"],
    [W.caA, vB, [W.bA1], "a club admin on another club's mapping"],
    [W.paA, v, [W.bB1], "a platform admin in club A's workspace on club B's binding"],
    [W.paA, vB, [W.bA1], "a platform admin in club A's workspace on club B's mapping"],
    [W.pa, cv, [W.bA1], "the platform workspace on a club mapping"],
    [W.caAB, v, [W.bA1], "an admin of two clubs in the other club's workspace"],
    [W.caA, { ...v, versionId: cv.versionId }, [W.bA1], "a version not of the named mapping"],
    [W.caA, v, [W.bA1, W.bB1], "one listed binding out of scope"],
    [W.caA, v, [crypto.randomUUID()], "an unknown binding"],
  ]) isNotFound(await start(who, ver, bs), label);
  assert.equal(await t5Count(), before, "nothing written");
  // An archived club: S1 and S2, both bases.
  const bC = await binding(W.clubC);
  const vC = await sysVersion();
  const onC = ok(await start(W.pa, vC, [bC]), 201).activations[0];
  await setClubActive(W.clubC, false);
  try {
    for (const who of [W.pa, W.caC, W.paC]) {
      isNotFound(await start(who, await sysVersion(), [bC]), "S1 on an archived club's binding");
      isNotFound(await end(who, onC.id), "S2 on an archived club's binding");
    }
    isNotFound(await list(W.pa, { bindingId: bC.bindingId }), "S3 filter on an archived club's binding");
    assert.equal((await t5(onC.id)).ended_at, null, "still open");
  } finally {
    await restoreClubC();
  }
  // An archived team: S1 is the identical 404; S2 ends it (a remedy, as an Unbind).
  const bT = await binding(W.clubA);
  const onT = ok(await start(W.caA, v, [bT]), 201).activations[0];
  await setTeamActive(bT.teamId, false);
  isNotFound(await start(W.caA, await sysVersion(), [bT]), "S1 on an archived team's binding");
  ok(await end(W.caA, onT.id));
});

test("6. S1: one binding and several (answered in ascending binding id, the requirement copied, the keyed audit row last, no acting user or reason in the answer); a club admin's start (club_admin on T5 and T8, a system mapping and its own club's); every refusal of section 3.7 with nothing written, the lowest failing binding named whatever its kind; both unique indexes as the backstop of a start that passed its pre-read", async () => {
  const v = await sysVersion();
  const [b1, b2] = sortedBindings(await binding(W.clubA), await binding(W.clubB));
  const reason = reasonFor("Start two.");
  const k1 = key();
  const res = ok(await post("/activations", W.pa.cookie, { requestKey: k1, mappingId: v.mappingId, versionId: v.versionId, reason,
    bindings: [{ bindingId: b2.bindingId, requirement: "optional" }, { bindingId: b1.bindingId, requirement: "required" }] }), 201);
  assert.equal(res.replayed, false);
  assert.deepEqual(res.activations.map((a) => [a.bindingId, a.requirement, a.basis, a.bindingState, a.teamId, a.versionId, a.mappingId, a.endedAt, a.endReason]), [
    [b1.bindingId, "required", "platform_admin", "active", b1.teamId, v.versionId, v.mappingId, null, null],
    [b2.bindingId, "optional", "platform_admin", "active", b2.teamId, v.versionId, v.mappingId, null, null],
  ]);
  for (const a of res.activations) assert.deepEqual(Object.keys(a).sort(), ["activatedAt", "appliesToDrill", "appliesToSession", "basis", "bindingId", "bindingState", "endReason", "endedAt", "id", "mappingId", "requirement", "teamId", "versionId"]);
  assert.ok(!JSON.stringify(res).includes(reason) && !JSON.stringify(res).includes(W.pa.id), "no reason and no acting user");
  for (const a of res.activations) {
    const row = await t5(a.id);
    assert.deepEqual([row.activated_by_user_id, row.activated_basis, row.reason, row.applies_to_session, row.applies_to_drill], [W.pa.id, "platform_admin", reason, true, true]);
  }
  const audit = await auditOf(`action = 'activation_start' and activation_id = any($1::uuid[])`, [res.activations.map((a) => a.id)]);
  assert.equal(new Set(audit.map((a) => a.operation_id)).size, 1, "one operation");
  assert.deepEqual(audit.filter((a) => a.request_key).map((a) => a.activation_id), [res.activations[1].id], "the keyed row is the last binding's");
  for (const a of audit) assert.deepEqual([a.reason, a.basis, a.performed_by_user_id, a.mapping_id], [reason, "platform_admin", W.pa.id, null]);
  // A club admin: a system mapping and its own club's, basis club_admin.
  const cv = await clubVersion(W.caA, W.paA);
  const bA = await binding(W.clubA);
  for (const ver of [cv, await sysVersion()]) {
    const row = ok(await start(W.caA, ver, [bA]), 201).activations[0];
    assert.equal(row.basis, "club_admin");
    assert.equal((await t5(row.id)).activated_basis, "club_admin");
    assert.equal((await auditOf(`action = 'activation_start' and activation_id = $1`, [row.id]))[0].basis, "club_admin");
  }
  // The body's shape.
  const count = await t5Count();
  const shape = (over) => post("/activations", W.pa.cookie, { ...startBody(v, [b1]), ...over });
  for (const [over, label] of [
    [{ bindings: [{ bindingId: b1.bindingId }] }, "requirement missing"],
    [{ bindings: [{ bindingId: b1.bindingId, requirement: "maybe" }] }, "requirement not required / optional"],
    [{ bindings: [{ bindingId: b1.bindingId, requirement: "required" }, { bindingId: b1.bindingId.toUpperCase(), requirement: "optional" }] }, "a duplicate binding"],
    [{ bindings: Array.from({ length: 51 }, () => ({ bindingId: crypto.randomUUID(), requirement: "required" })) }, "51 bindings"],
    [{ bindings: [] }, "no binding"],
    [{ bindings: "x" }, "not a list"],
    [{ bindings: [{ bindingId: b1.bindingId, requirement: "required", extra: 1 }] }, "an extra key in an entry"],
    [{ bindings: [{ bindingId: "nope", requirement: "required" }] }, "a malformed binding id"],
    [{ reason: " padded " }, "a reason with surrounding spaces"],
    [{ reason: "" }, "an empty reason"],
    [{ extra: true }, "an extra body key"],
    [{ mappingId: "nope" }, "a malformed mapping id"],
  ]) refused(await shape(over), 400, "invalid_body", label);
  const noReason = startBody(v, [b1]);
  delete noReason.reason;
  refused(await post("/activations", W.pa.cookie, noReason), 400, "invalid_body");
  assert.equal(await t5Count(), count, "nothing written");
  // version_not_active.
  const submitted = await version(await field(), { target: await variable(W.pa) });
  assert.deepEqual(refused(await start(W.pa, submitted, [b1]), 409, "version_not_active").current, { status: "needs_review" });
  // binding_not_active.
  const ended = await binding(W.clubA);
  await unbind(ended);
  assert.deepEqual(refused(await start(W.pa, await sysVersion(), [ended]), 409, "binding_not_active").current, { bindingId: ended.bindingId, bindingState: "ended" });
  // binding_source_mismatch: a field of another API family than the binding's host.
  const apiField = await sysVersion({ f: await field({ apiFamily: "api" }) });
  assert.deepEqual(refused(await start(W.pa, apiField, [b1]), 409, "binding_source_mismatch").current, { bindingId: b1.bindingId });
  // field_retired (v34's C42 backstop): a field retired raw while its version is active.
  const retiredField = await sysVersion();
  await k.query("begin");
  await k.query("set local session_replication_role = replica");
  await k.query(`update training_load.source_metric_definitions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Raw fixture.' where id = $1`, [retiredField.fieldId, W.pa.id]);
  await k.query("commit");
  refused(await start(W.pa, retiredField, [b1]), 409, "field_retired");
  // activation_exists and variable_taken_on_binding.
  const v2 = await sysVersion();
  const bX = await binding(W.clubA);
  ok(await start(W.pa, v2, [bX]), 201);
  assert.deepEqual(refused(await start(W.pa, v2, [bX]), 409, "activation_exists").current, { bindingId: bX.bindingId });
  const sameTarget = await sysVersion({ target: v2.target });
  assert.deepEqual(refused(await start(W.pa, sameTarget, [bX]), 409, "variable_taken_on_binding").current, { bindingId: bX.bindingId });
  // Several failing bindings of different kinds: the lowest is named.
  const v3 = await sysVersion();
  const [low, high] = sortedBindings(await binding(W.clubA), await binding(W.clubA));
  ok(await start(W.pa, v3, [low]), 201);
  await unbind(high);
  assert.deepEqual(refused(await start(W.pa, v3, [high, low]), 409, "activation_exists").current, { bindingId: low.bindingId });
  const v4 = await sysVersion();
  const [low2, high2] = sortedBindings(await binding(W.clubA), await binding(W.clubA));
  ok(await start(W.pa, v4, [high2]), 201);
  await unbind(low2);
  assert.deepEqual(refused(await start(W.pa, v4, [high2, low2]), 409, "binding_not_active").current, { bindingId: low2.bindingId, bindingState: "ended" });
  assert.equal(await t5Count(), count + 3, "only the three starts of this block wrote");
  // The two unique indexes, when a start passed its pre-read while another
  // start of the same binding was not yet committed: the first one held after
  // its checks, the second one committed meanwhile.
  for (const [makeSecond, code] of [[(ver) => ver, "activation_exists"], [async (ver) => sysVersion({ target: ver.target }), "variable_taken_on_binding"]]) {
    const ver = await sysVersion();
    const second = await makeSecond(ver);
    const b = await binding(W.clubA);
    const held = holdActivation("activation_start");
    const first = start(W.pa, ver, [b]);
    await until(() => held.state.entered, "the first start is held after its checks");
    activations.setActivationWriteHoldForTests(null);
    ok(await start(W.pa2, second, [b]), 201);
    held.g.open();
    assert.deepEqual(refused(await first, 409, code).current, { bindingId: b.bindingId });
  }
});

test("7. S2: an end (admin_ended, at the transaction's time, the reason in its audit row only); activation_not_open with current; a club admin ends a platform admin's start (club_admin); an end on an ended binding; Unbind, then the team moved to club B: club A's admin ends it, club B's admin gets the identical 404 and 42501 in SQL", async () => {
  const v = await sysVersion();
  const b = await binding(W.clubA);
  const on = ok(await start(W.pa, v, [b]), 201).activations[0];
  const reason = reasonFor("End it.");
  const kEnd = key();
  const res = ok(await post(`/activations/${on.id}/end`, W.pa.cookie, { requestKey: kEnd, expectedState: "open", reason }));
  assert.deepEqual([res.replayed, res.activation.id, res.activation.endReason, res.activation.bindingState], [false, on.id, "admin_ended", "active"]);
  assert.ok(res.activation.endedAt);
  assert.ok(!JSON.stringify(res).includes(reason) && !JSON.stringify(res).includes(W.pa.id));
  const row = await t5(on.id);
  assert.deepEqual([row.end_reason, row.ended_by_user_id, row.ended_basis], ["admin_ended", W.pa.id, "platform_admin"]);
  const audit = (await auditOf(`action = 'activation_end' and activation_id = $1`, [on.id]))[0];
  assert.deepEqual([audit.reason, audit.request_key, audit.basis, audit.team_id, audit.mapping_version_id], [reason, kEnd, "platform_admin", b.teamId, v.versionId]);
  assert.equal((await one(k, `select (select ended_at from training_load.source_metric_mapping_activations where id = $1) = performed_at as same from training_load.source_metric_audit where id = $2`, [on.id, audit.id])).same, true, "the end at its transaction's time");
  const notOpen = refused(await end(W.pa, on.id), 409, "activation_not_open");
  assert.deepEqual([notOpen.current.id, notOpen.current.endReason], [on.id, "admin_ended"]);
  refused(await post(`/activations/${on.id}/end`, W.pa.cookie, { ...endBody(), expectedState: "ended" }), 400, "invalid_body");
  // A club admin ends a platform admin's start.
  const on2 = ok(await start(W.pa, v, [b]), 201).activations[0];
  ok(await end(W.caA, on2.id));
  assert.equal((await t5(on2.id)).ended_basis, "club_admin");
  assert.equal((await auditOf(`action = 'activation_end' and activation_id = $1`, [on2.id]))[0].basis, "club_admin");
  // An end on an ended binding.
  const on3 = ok(await start(W.caA, v, [b]), 201).activations[0];
  await unbind(b);
  assert.equal(ok(await end(W.caA, on3.id)).activation.bindingState, "ended");
  // Unbind, move the team to club B, then end: the binding's club stays its connection's.
  const bm = await binding(W.clubA);
  const onm = ok(await start(W.caA, await sysVersion(), [bm]), 201).activations[0];
  await unbind(bm);
  await k.query(`update public.teams set club_id = $2 where id = $1`, [bm.teamId, W.clubB]);
  isNotFound(await end(W.caB, onm.id), "club B's admin");
  const sql = await tx(W.caB.id, (c) => c.query(`update training_load.source_metric_mapping_activations
      set ended_at = now(), ended_by_user_id = $2, ended_basis = 'club_admin', end_reason = 'admin_ended' where id = $1`, [onm.id, W.caB.id]));
  refusedWith(sql, "42501", ACTOR_T5);
  ok(await end(W.caA, onm.id));
});

test("8. S3: the filters (bindingId, versionId, state), pages of 100 with an opaque cursor that carries a position only, the scope of each workspace (the platform workspace sees system mappings only; a club admin its own club's bindings), a cursor from another workspace, bindingState, and the 400s", async () => {
  const v = await sysVersion();
  const cv = await clubVersion(W.caA, W.paA);
  const bA = await binding(W.clubA);
  const bB = await binding(W.clubB);
  const sysOnA = ok(await start(W.pa, v, [bA, bB]), 201).activations;
  const clubOnA = ok(await start(W.caA, cv, [bA]), 201).activations[0];
  const ids = (res) => ok(res).activations.map((a) => a.id);
  assert.deepEqual(ids(await list(W.pa, { bindingId: bA.bindingId })), [sysOnA.find((a) => a.bindingId === bA.bindingId).id], "the platform workspace: system mappings only");
  assert.deepEqual(ids(await list(W.caA, { bindingId: bA.bindingId })).sort(), [sysOnA.find((a) => a.bindingId === bA.bindingId).id, clubOnA.id].sort());
  assert.deepEqual(ids(await list(W.caA, { versionId: v.versionId })), [sysOnA.find((a) => a.bindingId === bA.bindingId).id], "club A's bindings only");
  assert.deepEqual(ids(await list(W.caB, { versionId: v.versionId })), [sysOnA.find((a) => a.bindingId === bB.bindingId).id]);
  isNotFound(await list(W.caB, { bindingId: bA.bindingId }), "another club's binding");
  isNotFound(await list(W.pa, { versionId: cv.versionId }), "a club mapping's version in the platform workspace");
  isNotFound(await list(W.paB, { versionId: cv.versionId }), "another club's mapping");
  isNotFound(await list(W.caA, { bindingId: crypto.randomUUID() }), "an unknown binding");
  isNotFound(await list(W.caA, { bindingId: "nope" }), "a malformed binding id");
  // state.
  ok(await end(W.caA, clubOnA.id));
  assert.deepEqual(ids(await list(W.caA, { bindingId: bA.bindingId, state: "ended" })), [clubOnA.id]);
  assert.equal(ids(await list(W.caA, { bindingId: bA.bindingId, state: "all" })).length, 2);
  // bindingState.
  await unbind(bB);
  assert.deepEqual(ok(await list(W.caB, { bindingId: bB.bindingId })).activations.map((a) => a.bindingState), ["ended"]);
  // The 400s.
  for (const q of [{}, { state: "open" }, { bindingId: bA.bindingId, state: "x" }, { bindingId: bA.bindingId, limit: "5" }, { bindingId: bA.bindingId, cursor: "nope!" },
    { bindingId: bA.bindingId, cursor: Buffer.from(JSON.stringify({ v: 1, k: "mappings", i: crypto.randomUUID() })).toString("base64url") }]) {
    refused(await list(W.caA, q), 400, "invalid_query");
  }
  // Pages: 101 activations of one version on 101 bindings of club A (raw rows).
  const pv = await sysVersion();
  for (let i = 0; i < 101; i += 1) await rawActivation(pv, await binding(W.clubA));
  const all = (await rows(k, `select id from training_load.source_metric_mapping_activations where mapping_version_id = $1 order by id`, [pv.versionId])).map((x) => x.id);
  const first = ok(await list(W.pa, { versionId: pv.versionId }));
  assert.equal(first.activations.length, 100);
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);
  const second = ok(await list(W.pa, { versionId: pv.versionId, cursor: first.nextCursor }));
  assert.deepEqual([second.activations.length, second.nextCursor], [1, null]);
  assert.deepEqual([...first.activations, ...second.activations].map((a) => a.id), all, "every row once, in id order");
  // A cursor from the platform workspace in club B's workspace only positions: club B sees none of these.
  assert.deepEqual(ok(await list(W.caB, { versionId: pv.versionId, cursor: first.nextCursor })).activations, []);
  assert.deepEqual(ok(await list(W.caA, { versionId: pv.versionId, cursor: first.nextCursor })).activations.map((a) => a.id), [all[100]]);
});

const retireRevision = (f, cookie, { expectedState = "active", reason = reasonFor("Retire.") } = {}) =>
  post(`/fields/${f.fieldId}/revisions/${f.revId}/retire`, cookie, { requestKey: key(), expectedState, reason });
const replaceRevision = async (f, cookie) => {
  const r2 = await writeRevision(k, { fieldId: f.fieldId, by: W.pa.id, revisionNumber: 2, evidenceRef: COMPAT, unit: "s", unitRef: UNIT_REF, meaning: true, meaningRef: MEANING_REF, state: "draft" });
  return post(`/fields/${f.fieldId}/revisions/${r2}/replace`, cookie, { requestKey: key(), reason: reasonFor("Replace the revision."), expectedActiveRevisionId: f.revId });
};
const endOf = async (id) => {
  const row = await t5(id);
  const audit = (await auditOf(`action = 'activation_end' and activation_id = $1`, [id]))[0];
  return [row.end_reason, row.ended_basis, row.ended_by_user_id, audit?.reason ?? null];
};

test("9. A1, A2 and the pinned step (D6, O5): a replacement ends the replaced version's activations - on an archived club's binding too - then activates and starts the listed bindings (activationsEnded, activations, also on replay); A2 and the pinned step (L4, L5) end a system version's activations on an archived club's binding; a club's own version on an archived club stays as 7b decided (A1 and A2 the identical 404, the pinned step 409 club_archived, the activation open); each activation_end reason is the version's disable_reason; A1's listed starts follow S1's scope and body rules; an A1 made before 7d replays", async () => {
  // A1 with a replacement: N active on a club A binding and on club C's binding (club C then archived).
  const f = await field();
  const target = await variable(W.pa);
  const n = await version(f, { target });
  ok(await activate(n, W.pa.cookie));
  const bA = await binding(W.clubA);
  const bC = await binding(W.clubC);
  const onN = ok(await start(W.pa, n, [bA, bC]), 201).activations;
  const n1 = await version(f, { target });
  const bNew = await binding(W.clubB);
  const replaceReason = reasonFor("Replace N.");
  const activationReason = reasonFor("Start N+1.");
  const kA1 = key();
  await setClubActive(W.clubC, false);
  let replaced;
  try {
    replaced = ok(await activate(n1, W.pa.cookie, { expected: n.versionId, reason: replaceReason, requestKey: kA1,
      extra: { activations: listed([{ bindingId: bNew.bindingId, requirement: "optional" }]), activationReason } }));
  } finally {
    await restoreClubC();
  }
  assert.deepEqual([replaced.replaced, replaced.activationsEnded, replaced.activations.map((a) => [a.bindingId, a.requirement, a.versionId])],
    [n.versionId, 2, [[bNew.bindingId, "optional", n1.versionId]]]);
  for (const a of onN) assert.deepEqual(await endOf(a.id), ["mapping_version_replaced", "platform_admin", W.pa.id, replaceReason]);
  assert.equal((await one(k, `select disable_reason from training_load.source_metric_mapping_versions where id = $1`, [n.versionId])).disable_reason, replaceReason);
  const started = await t5(replaced.activations[0].id);
  assert.deepEqual([started.reason, started.activated_basis], [activationReason, "platform_admin"]);
  const op = (await auditOf(`request_key = $1`, [kA1]))[0];
  assert.equal(op.action, "mapping_version_replaced");
  assert.deepEqual((await auditOf(`operation_id = $1`, [op.operation_id])).map((a) => a.action).sort(),
    ["activation_end", "activation_end", "activation_start", "mapping_status", "mapping_version_replaced"], "one operation; G1 holds");
  const replay = ok(await activate(n1, W.pa.cookie, { expected: n.versionId, reason: replaceReason, requestKey: kA1,
    extra: { activations: listed([{ bindingId: bNew.bindingId, requirement: "optional" }]), activationReason } }));
  assert.deepEqual([replay.replayed, replay.activationsEnded, replay.activations], [true, 2, replaced.activations]);
  // A2 of a system version ends its activation on an archived club's binding.
  const d = await sysVersion();
  const bC2 = await binding(W.clubC);
  const onD = ok(await start(W.pa, d, [bC2]), 201).activations[0];
  await setClubActive(W.clubC, false);
  try {
    const disableReason = reasonFor("Disable D.");
    const kA2 = key();
    const disabled = ok(await disable(d, W.pa.cookie, { reason: disableReason, requestKey: kA2 }));
    assert.equal(disabled.activationsEnded, 1);
    assert.deepEqual(await endOf(onD.id), ["mapping_version_disabled", "platform_admin", W.pa.id, disableReason]);
    assert.equal(ok(await disable(d, W.pa.cookie, { reason: disableReason, requestKey: kA2 })).activationsEnded, 1, "the replay counts the operation's ends");
  } finally {
    await restoreClubC();
  }
  // The pinned step: L5 and L4 end a system version's activations, on an archived club's binding too.
  for (const step of ["L5", "L4"]) {
    const p = await sysVersion();
    const bP = await binding(W.clubC);
    const onP = ok(await start(W.pa, p, [bP, await binding(W.clubA)]), 201).activations;
    await setClubActive(W.clubC, false);
    try {
      const pinned = { fieldId: p.fieldId, revId: p.revId };
      ok(step === "L5" ? await retireRevision(pinned, W.pa.cookie) : await replaceRevision(pinned, W.pa.cookie));
    } finally {
      await restoreClubC();
    }
    for (const a of onP) assert.deepEqual(await endOf(a.id), ["mapping_version_disabled", "platform_admin", W.pa.id, PINNED_REASON], step);
    assert.equal(await statusOf(p), "disabled");
  }
  // A club's own version on an archived club: stays as 7b decided.
  const cv = await clubVersion(W.caC, W.paC);
  const onCv = ok(await start(W.caC, cv, [await binding(W.clubC)]), 201).activations[0];
  const cvNext = await version({ fieldId: cv.fieldId, revId: cv.revId }, { owner: W.caC, target: cv.target });
  await setClubActive(W.clubC, false);
  try {
    isNotFound(await activate(cvNext, W.paC.cookie, { expected: cv.versionId, reason: reasonFor("x") }), "A1 in an archived club's workspace");
    isNotFound(await disable(cv, W.paC.cookie), "A2 in an archived club's workspace");
    const pinned = refused(await retireRevision({ fieldId: cv.fieldId, revId: cv.revId }, W.pa.cookie), 409, "club_archived");
    assert.deepEqual(pinned.clubIds, [W.clubC]);
    assert.equal((await t5(onCv.id)).ended_at, null, "the activation stays open");
  } finally {
    await restoreClubC();
  }
  // A1's listed starts: S1's scope (in the workspace of the mapping's owner) and body rules.
  const cvA = await version(await field(), { owner: W.caA, target: await variable(W.caA) });
  isNotFound(await activate(cvA, W.paA.cookie, { extra: { activations: listed([W.bB1]), activationReason: reasonFor("x") } }), "a club version on another club's binding");
  assert.equal(await statusOf(cvA), "needs_review", "nothing written");
  for (const extra of [{ activations: listed([W.bA1]) }, { activationReason: "Reason." }, { activations: listed([W.bA1, W.bA1]), activationReason: "Reason." },
    { activations: listed([W.bA1]), activationReason: " padded " }]) {
    refused(await activate(cvA, W.paA.cookie, { extra }), 400, "invalid_body");
  }
  // An A1 without activations hashes as before 7d (obligation (iv)): the stored
  // request hash is 7b's, and the same key with an empty list replays it.
  const old = await version(await field(), { target: await variable(W.pa) });
  const kOld = key();
  const plain = ok(await activate(old, W.pa.cookie, { requestKey: kOld }));
  assert.deepEqual([plain.activationsEnded, plain.activations], [0, []]);
  const hash7b = crypto.createHash("sha256").update(JSON.stringify({ route: "mapping_activate", mappingId: old.mappingId, versionId: old.versionId, toStatus: "active", expectedActiveVersionId: null, reason: null }), "utf8").digest("hex");
  assert.equal((await auditOf(`request_key = $1`, [kOld]))[0].request_hash, hash7b);
  assert.equal(ok(await activate(old, W.pa.cookie, { requestKey: kOld, extra: { activations: [] } })).replayed, true);
});

test("10. replay, keys and the COMMIT through the real route: a replay (S1 201 then 200 replayed; S2), request_key_reused (another body, another operation), a cross-workspace replay of S1, S2 and A1 (the identical 404), an answer lost but verified (200 verified_after_commit_error), one lost and not found (503 outcome_unknown, then the same key writes once), and a definite refusal by a deferred v48 link (500, nothing written, the key free)", async () => {
  const v = await sysVersion();
  const b = await binding(W.clubA);
  const body = startBody(v, [b]);
  const first = ok(await post("/activations", W.pa.cookie, body), 201);
  const again = ok(await post("/activations", W.pa.cookie, body));
  assert.deepEqual([again.replayed, again.activations], [true, first.activations]);
  refused(await post("/activations", W.pa.cookie, { ...body, reason: reasonFor("Another.") }), 409, "request_key_reused");
  refused(await post(`/activations/${first.activations[0].id}/end`, W.pa.cookie, { ...endBody(), requestKey: body.requestKey }), 409, "request_key_reused");
  const eBody = endBody();
  ok(await post(`/activations/${first.activations[0].id}/end`, W.pa.cookie, eBody));
  assert.equal(ok(await post(`/activations/${first.activations[0].id}/end`, W.pa.cookie, eBody)).replayed, true);
  // A cross-workspace replay: pa3 in the platform workspace, then in club B's.
  const s1 = startBody(v, [await binding(W.clubA)]);
  const s1Res = ok(await post("/activations", W.pa3.cookie, s1), 201);
  const s2 = endBody();
  ok(await post(`/activations/${s1Res.activations[0].id}/end`, W.pa3.cookie, s2));
  const a1v = await version(await field(), { target: await variable(W.pa) });
  const kA1 = key();
  ok(await activate(a1v, W.pa3.cookie, { requestKey: kA1 }));
  await workspace(W.pa3.id, "club", W.clubB);
  try {
    isNotFound(await post("/activations", W.pa3.cookie, s1), "S1's replay from club B's workspace");
    isNotFound(await post(`/activations/${s1Res.activations[0].id}/end`, W.pa3.cookie, s2), "S2's replay from club B's workspace");
    isNotFound(await activate(a1v, W.pa3.cookie, { requestKey: kA1 }), "A1's replay from club B's workspace");
  } finally {
    await workspace(W.pa3.id, "platform", null);
  }
  // The COMMIT.
  const lostVersion = await sysVersion();
  const lostBinding = await binding(W.clubA);
  service.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw new Error("answer lost"); }), timeoutMs: 2_000 });
  const lost = await start(W.pa, lostVersion, [lostBinding]);
  service.setMappingCommitForTests();
  assert.deepEqual([lost.status, lost.body.commitConfirmation, lost.body.replayed, lost.body.activations?.length], [200, "verified_after_commit_error", false, 1]);
  const unknownBody = startBody(await sysVersion(), [await binding(W.clubA)]);
  service.setMappingCommitForTests({ fault: () => Promise.reject(new Error("socket gone")), timeoutMs: 2_000 });
  const unknown = await post("/activations", W.pa.cookie, unknownBody);
  service.setMappingCommitForTests();
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.requestKey], [503, "outcome_unknown", unknownBody.requestKey]);
  ok(await post("/activations", W.pa.cookie, unknownBody), 201);
  ok(await post("/activations", W.pa.cookie, unknownBody));
  assert.equal((await one(k, `select count(*)::int as n from training_load.source_metric_mapping_activations where mapping_version_id = $1`, [unknownBody.versionId])).n, 1, "written once");
  // v48's deferred links refuse at COMMIT: a start without its audit row, an end without its.
  const count = await t5Count();
  const linkBody = startBody(await sysVersion(), [await binding(W.clubA), await binding(W.clubA)]);
  activations.setActivationAuditFaultForTests("skip_first_start");
  refused(await post("/activations", W.pa.cookie, linkBody), 500, "internal_error");
  activations.setActivationAuditFaultForTests(null);
  assert.equal(await t5Count(), count, "nothing written");
  const relinked = ok(await post("/activations", W.pa.cookie, linkBody), 201);
  activations.setActivationAuditFaultForTests("skip_end");
  refused(await end(W.pa, relinked.activations[0].id), 500, "internal_error");
  activations.setActivationAuditFaultForTests(null);
  assert.equal((await t5(relinked.activations[0].id)).ended_at, null, "nothing written");
});

test("11. direct SQL against v48: no actor, another user (a start, an end), a wrong basis (a start, its audit row), a club admin on another club, a start without its audit row at COMMIT, a second audit row, a savepoint, a version-driven end outside its disable's transaction, a replaced end without its replacement, a club admin's version-driven end, a version-driven end with another reason, an audit row naming no activation, a connection that is not club-owned, an end at another time - each refused", async () => {
  const v = await sysVersion();
  const insertT5 = (c, b, { by = W.pa.id, basis = "platform_admin", ver = v } = {}) => c.query(
    `insert into training_load.source_metric_mapping_activations (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint,
       source_team_binding_id, team_id, applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
     select v.id, v.mapping_id, v.source_metric_definition_id, v.metric_definition_id, v.parameter_fingerprint, $2, $3, v.applies_to_session, v.applies_to_drill,
            'required', $4, $5, 'SQL start.' from training_load.source_metric_mapping_versions v where v.id = $1 returning id`,
    [ver.versionId, b.bindingId, b.teamId, by, basis]).then((res) => res.rows[0].id);
  const startRow = (c, id, b, { by = W.pa.id, basis = "platform_admin", ver = v, reason = "SQL start." } = {}) => c.query(
    `insert into training_load.source_metric_audit (action, mapping_version_id, activation_id, team_id, reason, performed_by_user_id, basis, operation_id)
     values ('activation_start', $1, $2, $3, $4, $5, $6, gen_random_uuid())`, [ver.versionId, id, b.teamId, reason, by, basis]);
  const b = await binding(W.clubA);
  refusedWith(await tx(null, (c) => insertT5(c, b)), "42501", /^source metric mapping: no acting user is set for this transaction$/);
  refusedWith(await tx(W.pa.id, (c) => insertT5(c, b, { by: W.pa2.id })), "42501", ACTOR_T5);
  refusedWith(await tx(W.pa.id, (c) => insertT5(c, b, { basis: "club_admin" })), "42501", ACTOR_T5);
  refusedWith(await tx(W.caB.id, (c) => insertT5(c, b, { by: W.caB.id, basis: "club_admin" })), "42501", ACTOR_T5);
  refusedWith(await tx(W.pa.id, (c) => insertT5(c, b)), "23514", START_LINK);
  refusedWith(await tx(W.pa.id, async (c) => { const id = await insertT5(c, b); await startRow(c, id, b); await startRow(c, id, b); }), "23514", AUDIT_ONCE);
  refusedWith(await tx(W.pa.id, async (c) => { const id = await insertT5(c, b); await startRow(c, id, b, { basis: "club_admin" }); }), "42501", ACTOR_T8);
  refusedWith(await tx(W.pa.id, async (c) => { await c.query("savepoint s"); const id = await insertT5(c, b); await c.query("release savepoint s"); await startRow(c, id, b); }), "23514", AUDIT_FOLLOWS);
  refusedWith(await tx(W.pa.id, (c) => c.query(`insert into training_load.source_metric_audit (action, mapping_version_id, activation_id, team_id, reason, performed_by_user_id, basis, operation_id)
                                               values ('activation_start', $1, gen_random_uuid(), $2, 'x', $3, 'platform_admin', gen_random_uuid())`, [v.versionId, b.teamId, W.pa.id])), "23514", AUDIT_NAMES);
  const ok1 = await tx(W.pa.id, async (c) => { const id = await insertT5(c, b); await startRow(c, id, b); return id; });
  assert.equal(ok1.ok, true, ok1.error?.message);
  const open = ok1.value;
  // The ends.
  const endSql = (c, id, { by = W.pa.id, basis = "platform_admin", endReason = "admin_ended", at = "now()" } = {}) => c.query(
    `update training_load.source_metric_mapping_activations set ended_at = ${at}, ended_by_user_id = $2, ended_basis = $3, end_reason = $4 where id = $1`, [id, by, basis, endReason]);
  const endRow = (c, id, { by = W.pa.id, basis = "platform_admin", reason = "SQL end.", ver = v, team = b.teamId, operationId = crypto.randomUUID() } = {}) => c.query(
    `insert into training_load.source_metric_audit (action, mapping_version_id, activation_id, team_id, reason, performed_by_user_id, basis, operation_id)
     values ('activation_end', $1, $2, $3, $4, $5, $6, $7)`, [ver.versionId, id, team, reason, by, basis, operationId]);
  refusedWith(await tx(W.pa.id, (c) => endSql(c, open, { at: "now() - interval '1 minute'" })), "23514", END_TIME);
  refusedWith(await tx(W.pa.id, (c) => endSql(c, open, { by: W.pa2.id })), "42501", ACTOR_T5);
  refusedWith(await tx(W.caA.id, (c) => endSql(c, open, { by: W.caA.id, basis: "club_admin", endReason: "mapping_version_disabled" })), "42501", ACTOR_T5);
  refusedWith(await tx(W.pa.id, (c) => endSql(c, open)), "23514", END_LINK);
  // A version-driven end in a transaction that did not disable its version (a raw
  // disabled version with a raw open activation).
  const dv = await sysVersion();
  const rawOpen = await rawActivation(dv, await binding(W.clubA));
  await k.query("begin");
  await k.query("set local session_replication_role = replica");
  await k.query(`update training_load.source_metric_mapping_versions set status = 'disabled', disabled_by_user_id = $2, disabled_at = now(), disabled_basis = 'platform_admin', disable_reason = 'Raw disable.' where id = $1`, [dv.versionId, W.pa.id]);
  await k.query("commit");
  const rawTeam = (await t5(rawOpen)).team_id;
  refusedWith(await tx(W.pa.id, async (c) => { await endSql(c, rawOpen, { endReason: "mapping_version_disabled" }); await endRow(c, rawOpen, { ver: dv, team: rawTeam, reason: "Raw disable." }); }), "23514", VERSION_LINK);
  // A replaced end, and a version-driven end with another reason, inside a real disable.
  const disableIn = async (c, ver, reason, operationId) => {
    await c.query(`update training_load.source_metric_mapping_versions set status = 'disabled', disabled_by_user_id = $2, disabled_at = clock_timestamp(), disabled_basis = 'platform_admin', disable_reason = $3 where id = $1`, [ver.versionId, W.pa.id, reason]);
    await c.query(`insert into training_load.source_metric_audit (action, mapping_id, mapping_version_id, from_status, to_status, reason, performed_by_user_id, basis, operation_id)
                   values ('mapping_status', $1, $2, 'active', 'disabled', $3, $4, 'platform_admin', $5)`, [ver.mappingId, ver.versionId, reason, W.pa.id, operationId]);
  };
  const rv = await sysVersion();
  const rb = await binding(W.clubA);
  const ron = ok(await start(W.pa, rv, [rb]), 201).activations[0].id;
  refusedWith(await tx(W.pa.id, async (c) => {
    const opId = crypto.randomUUID();
    await endSql(c, ron, { endReason: "mapping_version_replaced" });
    await disableIn(c, rv, "Replaced.", opId);
    await endRow(c, ron, { ver: rv, team: rb.teamId, reason: "Replaced.", operationId: opId });
  }), "23514", REPLACED_LINK);
  refusedWith(await tx(W.pa.id, async (c) => {
    const opId = crypto.randomUUID();
    await endSql(c, ron, { endReason: "mapping_version_disabled" });
    await disableIn(c, rv, "Disabled.", opId);
    await endRow(c, ron, { ver: rv, team: rb.teamId, reason: "Another reason.", operationId: opId });
  }), "23514", AUDIT_FOLLOWS);
  // A connection that is not club-owned (team-owned): no start.
  const teamId = (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [W.clubA, `Team ${uid()}`])).id;
  const teamConn = (await one(k,
    `insert into training_load.source_credential_connections (source_system, owner_scope, owner_team_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                              credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
     values ('gpexe','team',$1,'server3','7d team','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
    [teamId, W.pa.id, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id;
  gpexeTeamCounter += 1;
  await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)`, [teamId, String(970000 + gpexeTeamCounter), W.pa.id]);
  const teamBinding = { teamId, bindingId: (await one(k, `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
                                                          values ($1,$2,'gpexe',$3,$4,$1) returning id`, [teamId, teamConn, String(970000 + gpexeTeamCounter), W.pa.id])).id };
  refusedWith(await tx(W.pa.id, (c) => insertT5(c, teamBinding)), "23514", NO_CLUB);
  isNotFound(await start(W.pa, await sysVersion(), [teamBinding]), "the route: the identical 404");
  assert.equal((await one(k, `select training_load.source_metric_binding_club($1) as club`, [teamBinding.bindingId])).club, null);
  assert.equal((await one(k, `select training_load.source_metric_binding_club($1) as club`, [b.bindingId])).club, W.clubA);
});

test("12. concurrency (section 5): S1 against A2 on one mapping; S2 against A2 and against the pinned step on one row, both orders; S1 against S2 on one binding and field; S1 against the pinned step, both orders; S1 against an Unbind (a raw UPDATE ending the binding), a team archive and a club archive, both orders; S2 against a club archive; a club admin promoted during S1 (try_again); S2 behind an importing transaction's FOR SHARE (C49); no 40P01", async () => {
  // S1 held after its locks; A2 of the same mapping waits at T3, then ends the new row.
  {
    const v = await sysVersion();
    const held = holdActivation("activation_start");
    const s1 = start(W.pa, v, [await binding(W.clubA)]);
    await until(() => held.state.entered, "S1 holds its locks");
    const a2 = disable(v, W.pa2.cookie);
    assert.equal(await someoneWaits(), true, "A2 waits");
    held.g.open();
    const started = ok(await s1, 201).activations[0];
    assert.equal(ok(await a2).activationsEnded, 1);
    assert.equal((await t5(started.id)).end_reason, "mapping_version_disabled");
  }
  // S2 against A2, both orders.
  for (const order of ["S2 first", "A2 first"]) {
    const v = await sysVersion();
    const on = ok(await start(W.pa, v, [await binding(W.clubA)]), 201).activations[0];
    if (order === "S2 first") {
      const held = holdActivation("activation_end");
      const s2 = end(W.caA, on.id);
      await until(() => held.state.entered, "S2 holds its locks");
      const a2 = disable(v, W.pa2.cookie);
      assert.equal(await someoneWaits(), true, "A2 waits");
      held.g.open();
      ok(await s2);
      assert.equal(ok(await a2).activationsEnded, 0, "A2 finds the row ended");
      assert.equal((await t5(on.id)).end_reason, "admin_ended");
    } else {
      const held = holdM2("mapping_version_disable");
      const a2 = disable(v, W.pa2.cookie);
      await until(() => held.state.entered, "A2 holds its locks");
      const s2 = end(W.caA, on.id);
      assert.equal(await someoneWaits(), true, "S2 waits");
      held.g.open();
      assert.equal(ok(await a2).activationsEnded, 1);
      refused(await s2, 409, "activation_not_open");
    }
  }
  // S2 against the pinned step, both orders.
  for (const order of ["S2 first", "pinned first"]) {
    const v = await sysVersion();
    const on = ok(await start(W.pa, v, [await binding(W.clubA)]), 201).activations[0];
    const pinned = { fieldId: v.fieldId, revId: v.revId };
    if (order === "S2 first") {
      const held = holdActivation("activation_end");
      const s2 = end(W.caA, on.id);
      await until(() => held.state.entered, "S2 holds its locks");
      const l5 = retireRevision(pinned, W.pa2.cookie);
      assert.equal(await someoneWaits(), true, "the pinned step waits");
      held.g.open();
      ok(await s2);
      ok(await l5);
      assert.equal((await t5(on.id)).end_reason, "admin_ended");
    } else {
      const held = holdLifecycle();
      const l5 = retireRevision(pinned, W.pa2.cookie);
      await until(() => held.state.entered, "the pinned step holds its locks");
      const s2 = end(W.caA, on.id);
      assert.equal(await someoneWaits(), true, "S2 waits");
      held.g.open();
      ok(await l5);
      refused(await s2, 409, "activation_not_open");
      assert.equal((await t5(on.id)).end_reason, "mapping_version_disabled");
    }
  }
  // S1 against S2 on one binding and field: S1's pre-read sees the row still open.
  {
    const v = await sysVersion();
    const b = await binding(W.clubA);
    const on = ok(await start(W.pa, v, [b]), 201).activations[0];
    const held = holdActivation("activation_end");
    const s2 = end(W.caA, on.id);
    await until(() => held.state.entered, "S2 holds its locks");
    activations.setActivationWriteHoldForTests(null);
    refused(await start(W.pa2, v, [b]), 409, "activation_exists");
    held.g.open();
    ok(await s2);
    ok(await start(W.pa2, v, [b]), 201);
  }
  // S1 against the pinned step, both orders (they meet at T2b).
  for (const order of ["S1 first", "pinned first"]) {
    const v = await sysVersion();
    const b = await binding(W.clubA);
    const pinned = { fieldId: v.fieldId, revId: v.revId };
    if (order === "S1 first") {
      const held = holdActivation("activation_start");
      const s1 = start(W.pa, v, [b]);
      await until(() => held.state.entered, "S1 holds its locks");
      const l5 = retireRevision(pinned, W.pa2.cookie);
      assert.equal(await someoneWaits(), true, "the pinned step waits");
      held.g.open();
      const started = ok(await s1, 201).activations[0];
      ok(await l5);
      assert.equal((await t5(started.id)).end_reason, "mapping_version_disabled", "the pinned step ends S1's new row");
    } else {
      const held = holdLifecycle();
      const l5 = retireRevision(pinned, W.pa2.cookie);
      await until(() => held.state.entered, "the pinned step holds its locks");
      const s1 = start(W.pa, v, [b]);
      assert.equal(await someoneWaits(), true, "S1 waits");
      held.g.open();
      ok(await l5);
      refused(await s1, 409, "version_not_active");
    }
  }
  // S1 against an Unbind (a raw UPDATE ending the binding), a team archive and a club archive, both orders.
  const peer = new pg.Client({ connectionString: db.url });
  await peer.connect();
  try {
    const writes = {
      unbind: (b) => unbind(b, peer),
      "team archive": (b) => peer.query(`update public.teams set is_active = false where id = $1`, [b.teamId]),
      "club archive": () => peer.query(`update public.clubs set is_active = false where id = $1`, [W.clubC]),
    };
    for (const [what, write] of Object.entries(writes)) {
      for (const order of ["S1 first", "write first"]) {
        const v = await sysVersion();
        const b = await binding(what === "club archive" ? W.clubC : W.clubA);
        try {
          if (order === "S1 first") {
            const held = holdActivation("activation_start");
            const s1 = start(W.pa, v, [b]);
            await until(() => held.state.entered, "S1 holds its locks");
            await peer.query("begin");
            const w = write(b);
            assert.equal(await someoneWaits(), true, `the ${what} waits`);
            held.g.open();
            ok(await s1, 201);
            await w;
            await peer.query("commit");
          } else {
            await peer.query("begin");
            await write(b);
            const s1 = start(W.pa, v, [b]);
            assert.equal(await someoneWaits(), true, `S1 waits for the ${what}`);
            await peer.query("commit");
            const res = await s1;
            if (what === "unbind") refused(res, 409, "binding_not_active");
            else isNotFound(res, `S1 after the ${what}`);
          }
        } finally {
          await peer.query("rollback").catch(() => {});
          await restoreClubC();
        }
      }
    }
    // S2 against a club archive, both orders.
    for (const order of ["S2 first", "archive first"]) {
      const on = ok(await start(W.pa, await sysVersion(), [await binding(W.clubC)]), 201).activations[0];
      try {
        if (order === "S2 first") {
          const held = holdActivation("activation_end");
          const s2 = end(W.pa, on.id);
          await until(() => held.state.entered, "S2 holds its locks");
          await peer.query("begin");
          const w = peer.query(`update public.clubs set is_active = false where id = $1`, [W.clubC]);
          assert.equal(await someoneWaits(), true, "the archive waits");
          held.g.open();
          ok(await s2);
          await w;
          await peer.query("commit");
        } else {
          await peer.query("begin");
          await peer.query(`update public.clubs set is_active = false where id = $1`, [W.clubC]);
          const s2 = end(W.pa, on.id);
          assert.equal(await someoneWaits(), true, "S2 waits for the archive");
          await peer.query("commit");
          isNotFound(await s2, "S2 after the archive");
          assert.equal((await t5(on.id)).ended_at, null);
        }
      } finally {
        await peer.query("rollback").catch(() => {});
        await restoreClubC();
      }
    }
    // S2 behind an importing transaction's FOR SHARE on the row (C49).
    const on = ok(await start(W.pa, await sysVersion(), [await binding(W.clubA)]), 201).activations[0];
    await peer.query("begin");
    await peer.query(`select 1 from training_load.source_metric_mapping_activations where id = $1 for share`, [on.id]);
    const s2 = end(W.caA, on.id);
    assert.equal(await someoneWaits(), true, "S2 waits for the importer");
    await peer.query("commit");
    ok(await s2);
  } finally {
    await peer.query("rollback").catch(() => {});
    await peer.end();
  }
  // A club admin promoted to platform admin while S1 runs: try_again, nothing written.
  {
    const promoted = await clubAdmin(W.clubA);
    const v = await sysVersion();
    const count = await t5Count();
    service.setMappingRightsHoldForTests(async () => {
      service.setMappingRightsHoldForTests(null);
      await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [promoted.id]);
    });
    refused(await start(promoted, v, [await binding(W.clubA)]), 409, "try_again");
    assert.equal(await t5Count(), count);
  }
  assert.ok(!logLines.some((l) => l.includes("40P01")), "no deadlock");
});

test("13. the early checks (defence in depth behind the locked ones): the gate admits the admins' contexts only; a version not of the named mapping, an archived club and an archived team (S1) and another club's activation (S2) are the identical 404 at once while a row the locked step needs is held elsewhere; S3's query keeps the scope, so rows outside it never take a page's place; field_retired is answered before a binding's refusal, and a field retired inside the write is v34's backstop, the same 409", async () => {
  // The gate: only an admin's context passes (a coach's, a team workspace's or a
  // malformed one never does, whatever resolves it).
  for (const ctx of [null, {}, { basis: "team_coach", owner: { scope: "team", clubId: W.clubA } }, { basis: "club_admin", owner: { scope: "system" } },
    { basis: "club_admin", owner: { scope: "team", clubId: W.clubA } }, { basis: "platform_admin", owner: { scope: "team", clubId: W.clubA } }]) {
    assert.equal(activations.mayManageActivations(ctx), false, JSON.stringify(ctx));
  }
  for (const ctx of [{ basis: "platform_admin", owner: { scope: "system" } }, { basis: "platform_admin", owner: { scope: "club", clubId: W.clubA } },
    { basis: "club_admin", owner: { scope: "club", clubId: W.clubA } }]) {
    assert.equal(activations.mayManageActivations(ctx), true, JSON.stringify(ctx));
  }
  const peer = new pg.Client({ connectionString: db.url });
  await peer.connect();
  // `sql` holds a row in another transaction while `fn` runs; the locked step
  // would wait for it (and answer try_again after its lock timeout).
  const holding = async (sql, params, fn) => {
    await peer.query("begin");
    try {
      await peer.query(sql, params);
      await fn();
    } finally {
      await peer.query("rollback");
    }
  };
  const retireRaw = async (client, fieldId) => {
    await client.query("set local session_replication_role = replica");
    await client.query(`update training_load.source_metric_definitions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Raw fixture.' where id = $1`, [fieldId, W.pa.id]);
    await client.query("set local session_replication_role = origin");
  };
  try {
    const before = await t5Count();
    // S1: a version not of the named mapping, while the named mapping's row is held.
    const v = await sysVersion();
    const other = await sysVersion();
    const bA = await binding(W.clubA);
    await holding(`select 1 from training_load.source_metric_mappings where id = $1 for update`, [v.mappingId], async () => {
      isNotFound(await start(W.pa, { ...v, versionId: other.versionId }, [bA]), "a version not of the named mapping");
    });
    // S1: an archived team and an archived club, while the binding's row is held.
    const vT = await sysVersion();
    const bT = await binding(W.clubA);
    await setTeamActive(bT.teamId, false);
    await holding(`select 1 from training_load.source_team_bindings where id = $1 for update`, [bT.bindingId], async () => {
      isNotFound(await start(W.pa, vT, [bT]), "an archived team");
    });
    const vC = await sysVersion();
    const bC = await binding(W.clubC);
    await setClubActive(W.clubC, false);
    try {
      await holding(`select 1 from training_load.source_team_bindings where id = $1 for update`, [bC.bindingId], async () => {
        isNotFound(await start(W.pa, vC, [bC]), "an archived club");
      });
    } finally {
      await restoreClubC();
    }
    assert.equal(await t5Count(), before, "nothing written");
    // S2: another club's activation, while an importing transaction holds it FOR SHARE (C49).
    const onA = ok(await start(W.caA, v, [bA]), 201).activations[0];
    await holding(`select 1 from training_load.source_metric_mapping_activations where id = $1 for share`, [onA.id], async () => {
      isNotFound(await end(W.caB, onA.id), "another club's activation");
    });
    assert.equal((await t5(onA.id)).ended_at, null, "still open");
    // S3: 101 ended activations of club A's own mapping with the lowest ids sit
    // before a system activation on one binding; the platform workspace's page
    // is the system activation, never an empty page without a cursor.
    const cv = await clubVersion(W.caA, W.paA);
    const bP = await binding(W.clubA);
    const sysOn = ok(await start(W.pa, v, [bP]), 201).activations[0];
    const clubOn = ok(await start(W.caA, cv, [bP]), 201).activations[0];
    const copies = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    await k.query("begin");
    try {
      await k.query("set local session_replication_role = replica");
      await k.query(
        `insert into training_load.source_metric_mapping_activations
         select (jsonb_populate_record(null::training_load.source_metric_mapping_activations,
                   to_jsonb(a) || jsonb_build_object('id', c.id, 'ended_at', now(), 'ended_by_user_id', a.activated_by_user_id,
                                                     'ended_basis', a.activated_basis, 'end_reason', 'admin_ended'))).*
           from training_load.source_metric_mapping_activations a cross join unnest($2::uuid[]) as c(id)
          where a.id = $1`,
        [clubOn.id, copies]);
      await k.query("commit");
    } catch (error) {
      await k.query("rollback").catch(() => {});
      throw error;
    }
    try {
      const page = ok(await list(W.pa, { bindingId: bP.bindingId, state: "all" }));
      assert.deepEqual(page.activations.map((a) => a.id), [sysOn.id], "the platform workspace's page");
      assert.equal(page.nextCursor, null);
      const clubPage = ok(await list(W.caA, { bindingId: bP.bindingId, state: "all" }));
      assert.equal(clubPage.activations.length, 100, "club A's first page is full");
      assert.ok(clubPage.nextCursor, "club A's next page");
    } finally {
      await k.query("begin");
      await k.query("set local session_replication_role = replica");
      await k.query(`delete from training_load.source_metric_mapping_activations where id = any($1::uuid[])`, [copies]);
      await k.query("commit");
    }
    // field_retired is a state of the version, answered before a binding's
    // refusal (here activation_exists).
    const vR = await sysVersion();
    const bR = await binding(W.clubA);
    ok(await start(W.pa, vR, [bR]), 201);
    await k.query("begin");
    await retireRaw(k, vR.fieldId);
    await k.query("commit");
    refused(await start(W.pa, vR, [bR]), 409, "field_retired");
    // A field retired inside the write, after S1's own check: v34's backstop
    // refuses the T5 row and the service answers the same 409; nothing is written.
    const vF = await sysVersion();
    const bF = await binding(W.clubA);
    const count = await t5Count();
    activations.setActivationWriteHoldForTests(async (client, where) => { if (where === "activation_start") await retireRaw(client, vF.fieldId); });
    refused(await start(W.pa, vF, [bF]), 409, "field_retired");
    activations.setActivationWriteHoldForTests(null);
    assert.equal(await t5Count(), count, "nothing written");
    assert.equal((await one(k, `select state from training_load.source_metric_definitions where id = $1`, [vF.fieldId])).state, "active", "the raw retire rolled back with it");
  } finally {
    await peer.end().catch(() => {});
  }
});

test("14. no answer and no log line carries a reason, an acting user's id or a database text", async () => {
  const admins = [W.pa, W.pa2, W.pa3, W.paA, W.paB, W.paC, W.caA, W.caA2, W.caB, W.caC, W.caAB];
  for (const text of responses) {
    for (const reason of sentReasons) assert.ok(!text.includes(reason), `an answer carries a reason: ${text.slice(0, 200)}`);
    for (const a of admins) assert.ok(!text.includes(a.id), "an answer carries an acting user's id");
    assert.ok(!/source_metric_mapping_activations:|source_metric_audit:|source metric activation:/.test(text), "an answer carries a database text");
  }
  for (const line of logLines) {
    for (const reason of sentReasons) assert.ok(!line.includes(reason), `a log line carries a reason: ${line.slice(0, 200)}`);
    for (const a of admins) assert.ok(!line.includes(a.id), `a log line carries an acting user's id: ${line.slice(0, 200)}`);
  }
});

// Phase 7i (7i-B1) - a club uses, copies or hides a system variable, and moves
// a team from the system variable to its copy, with migration v53.
// Contract: docs/ai/phase7i-system-variables-club-contract.md (J15), section 10.
// Through the real HTTP stack, on disposable optimove_tests_gpexe_* databases only
// (never OPTIMOVE, never a real GPEXE field or connection): one migrated through
// v52 that rehearses v53 (the md5 preconditions, the preflight, the runner, the
// post-check, every refusal of the rollback, the rollback back to v52's exact
// catalog, and v53 again), and one migrated through v53 for the behaviour. Every
// field, variable, mapping, connection and binding here is a test row of this file
// (a connection's credential parts are random bytes of the right lengths: nothing
// is ever decrypted or sent).
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
import { allowSyntheticTestFields } from "./support/test-extractors.mjs";

allowSyntheticTestFields();

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V53 = "202611031200_training_load_v53_system_variables_club.sql";
const V53_NAME = `migrations_v2/${V53}`;
const V52_NAME = "migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql";
const UP_TO_V52 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V53));
const V53_FILE = path.resolve(ROOT, "migrations_v2", V53);
const V36_FILE = path.resolve(ROOT, "migrations_v2", "202610141000_training_load_v36_metric_variable_requests.sql");
const V48_FILE = path.resolve(ROOT, "migrations_v2", "202610301900_training_load_v48_mapping_activations.sql");
const RUNBOOKS = path.resolve(ROOT, "docs/runbooks");
const ROLLBACK = path.join(RUNBOOKS, "system-variables-club-v53-rollback.sql");
const PREFLIGHT = path.join(RUNBOOKS, "system-variables-club-v53-preflight.sql");
const POSTCHECK = path.join(RUNBOOKS, "system-variables-club-v53-postcheck.sql");
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const T3 = "training_load.source_metric_mappings";
const T4 = "training_load.source_metric_mapping_versions";
const T5 = "training_load.source_metric_mapping_activations";
const T8 = "training_load.source_metric_audit";
const COPIES = "training_load.metric_definition_copies";
const LINKS = "training_load.source_metric_mapping_version_copies";
const HIDES = "training_load.metric_definition_club_hides";
const REQUESTS = "training_load.metric_variable_requests";
const V36_REQUEST_GUARD_MD5 = "ae5bf5e22620546a83cf955b8b1d9a9d";
const V48_T5_GUARD_MD5 = "e47f75d4a7a6c63659a19491db97d678";
const REPLACED = ["metric_variable_requests_insert_guard", "source_metric_activations_insert_guard"];
const HIDDEN_T5 = /^source_metric_mapping_activations: the variable is hidden in the binding's club$/;

let rdb, db, r, k, server, apiBase, service, activations, steps, variables, connections, dbModule, appPool, createSession;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};

async function migrate(url, files, { extra = null } = {}) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v53-migrations-"));
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
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V53), "v53 is a test migration");
  assert.equal(GPEXE_TEST_MIGRATIONS.at(-1), V53, "v53 is the last test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v53rb", migrations: UP_TO_V52 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v53" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  await r.connect();
  await k.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  // The legacy scaffold's user_club_roles lacks the columns the real club-admin
  // revocation route writes and reads (public.user_club_roles in the deployed
  // schema has them); the behaviour database gets them so the route runs as it
  // does in production. The rehearsal database is left as built.
  await k.query(`alter table public.user_club_roles add column if not exists granted_by_user_id uuid,
                   add column if not exists revoked_at timestamptz, add column if not exists revoked_by_user_id uuid,
                   add column if not exists created_at timestamptz not null default now()`);
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.V53_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  activations = await import("../src/sourceMetricActivationService.js");
  steps = await import("../src/sourceMetricActivationSteps.js");
  variables = await import("../src/canonicalVariableAdminService.js");
  connections = await import("../src/sourceConnectionService.js");
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
  service?.setMappingReadFaultForTests(null);
  service?.setMappingRightsHoldForTests(null);
  service?.setMappingWriteHoldForTests(null);
  service?.setMappingBeforeHideLocksHoldForTests(null);
  activations?.setActivationWriteHoldForTests(null);
  steps?.setHideLockHoldForTests(null);
  variables?.setVariableWriteHoldForTests(null);
  connections?.setSourceUnbindHoldForTests(null);
}
afterEach(() => {
  for (const g of openGates.splice(0)) g.open();
  resetSeams();
});

// ---------------------------------------------------------------------------
// helpers (7d's, J10 section 10)
// ---------------------------------------------------------------------------
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const key = () => crypto.randomUUID();

async function api(p, { method = "GET", body, cookie, contentType = "application/json", prefix = PREFIX } = {}) {
  const res = await fetch(`${apiBase}${prefix}${p}`, {
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
// The identical 404 (section 10.2): the status, the body and the caching
// headers, with no Retry-After.
const notFoundShape = (res) => ({ status: res.status, body: res.body, cache: res.headers.get("cache-control"), retryAfter: res.headers.get("retry-after") });

// Every reason sent; the leak test scans every answer and log line for them.
const sentReasons = new Set();
const reasonFor = (label) => { const text = `${label} ${uid()}`; sentReasons.add(text); return text; };
const actPath = (v) => `/mappings/${v.mappingId}/versions/${v.versionId}/activate`;
const disPath = (v) => `/mappings/${v.mappingId}/versions/${v.versionId}/disable`;
const listed = (bindings) => bindings.map((b) => ({ bindingId: b.bindingId ?? b, requirement: b.requirement ?? "required" }));
const activate = (v, cookie, { expected = null, reason, requestKey = key(), starts = null, activationReason } = {}) => {
  if (typeof reason === "string") sentReasons.add(reason);
  const body = { requestKey, expectedActiveVersionId: expected, ...(reason === undefined ? {} : { reason }) };
  if (starts) {
    body.activations = listed(starts);
    body.activationReason = activationReason ?? reasonFor("Starts.");
    sentReasons.add(body.activationReason);
  }
  return post(actPath(v), cookie, body);
};
const disable = (v, cookie, { expectedStatus = "active", reason = reasonFor("Disable."), requestKey = key() } = {}) => post(disPath(v), cookie, { requestKey, expectedStatus, reason });
const startBody = (v, bindings, { reason = reasonFor("Start."), requestKey = key() } = {}) => ({ requestKey, mappingId: v.mappingId, versionId: v.versionId, bindings: listed(bindings), reason });
const start = (who, v, bindings, opts = {}) => post("/activations", who.cookie, startBody(v, bindings, opts));
const endBody = ({ reason = reasonFor("End."), requestKey = key(), expectedState = "open" } = {}) => ({ requestKey, expectedState, reason });
const end = (who, id, opts = {}) => post(`/activations/${id}/end`, who.cookie, endBody(opts));

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
// A club admin never carries a global platform_admin row here (the database
// would derive platform_admin first; section 10.1).
async function clubAdmin(clubId, ws = ["club", clubId]) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await workspace(id, ws[0], ws[1]);
  return { id, cookie: await cookieFor(id) };
}
const newTeam = async (clubId) => (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
async function teamCoach(clubId) {
  const teamId = await newTeam(clubId);
  const id = await user("coach");
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await workspace(id, "team", teamId);
  return { id, teamId, cookie: await cookieFor(id) };
}
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const setClubActive = (clubId, active) => k.query(`update public.clubs set is_active = $2 where id = $1`, [clubId, active]);
const setClubRole = (userId, clubId, active) => k.query(`update public.user_club_roles set is_active = $3 where user_id = $1 and club_id = $2 and role = 'club_admin'`, [userId, clubId, active]);
const setUserActive = (userId, active) => k.query(`update public.users set is_active = $2 where id = $1`, [userId, active]);
const setGlobal = async (userId, active) => {
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',$2)
                 on conflict do nothing`, [userId, active]);
  await k.query(`update public.user_global_roles set is_active = $2 where user_id = $1 and role = 'platform_admin'`, [userId, active]);
};

// A club-owned server3 connection per club (state verified; the credential
// parts are random bytes, never decrypted), and one team binding per call.
const connectionOf = new Map();
let gpexeTeamCounter = 0;
async function connection(clubId) {
  if (!connectionOf.has(clubId)) {
    connectionOf.set(clubId, (await one(k,
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                                credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','club',$1,'server3','7h test','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
      [clubId, W.pa.id, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id);
  }
  return connectionOf.get(clubId);
}
async function binding(clubId, { connectionId = null } = {}) {
  const teamId = await newTeam(clubId);
  gpexeTeamCounter += 1;
  const sourceTeamId = String(960000 + gpexeTeamCounter);
  await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)`, [teamId, sourceTeamId, W.pa.id]);
  const bindingId = (await one(k,
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
     values ($1,$2,'gpexe',$3,$4,$1) returning id`, [teamId, connectionId ?? await connection(clubId), sourceTeamId, W.pa.id])).id;
  return { bindingId, teamId, clubId };
}
// A binding of club X whose connection is team-owned (no club: v48's NULL).
async function teamOwnedBinding(clubId) {
  const teamId = await newTeam(clubId);
  gpexeTeamCounter += 1;
  const sourceTeamId = String(960000 + gpexeTeamCounter);
  const connectionId = (await one(k,
    `insert into training_load.source_credential_connections (source_system, owner_scope, owner_team_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                              credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
     values ('gpexe','team',$1,'server3','7h team test','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
    [teamId, W.pa.id, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id;
  await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)`, [teamId, sourceTeamId, W.pa.id]);
  const bindingId = (await one(k,
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
     values ($1,$2,'gpexe',$3,$4,$1) returning id`, [teamId, connectionId, sourceTeamId, W.pa.id])).id;
  return { bindingId, teamId, clubId };
}
const unbind = (b, client = k) => client.query(
  `update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'Test unbind.' where id = $1`, [b.bindingId, W.pa.id]);

// A canonical variable through the M3-0 API (numeric, both levels).
async function variable(owner) {
  const res = await post("/variables", owner.cookie, { requestKey: key(), label: `Club variable ${uid()}`, unit: "s", levels: ["session", "drill"], dailyAggregationMethod: "sum" });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.variable.id };
}
// A test field of gpexe / rest_v1 whose revision 1 is active and verified.
async function field() {
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'7i test field',$2) returning id`,
    [`v53.test.f${uid()}`, W.pa.id])).id;
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: "number", parameterKind: "none", evidenceRef: COMPAT, unit: "s", unitRef: UNIT_REF, meaning: true, meaningRef: MEANING_REF, state: "active" });
  return { fieldId, revId };
}
// A mapping version of field `f` to `target`, through the real M2 routes; submitted unless `submit` is false.
async function version(f, { owner = W.pa, target, submit = true, conversionNote = null }) {
  let mappingId = (await one(k, `select id from training_load.source_metric_mappings where source_metric_definition_id = $1 and metric_definition_id = $2`, [f.fieldId, target.id]))?.id;
  if (!mappingId) {
    const m = await post("/mappings", owner.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id });
    assert.equal(m.status, 201, m.text);
    mappingId = m.body.mapping.id;
  }
  const v = await post(`/mappings/${mappingId}/versions`, owner.cookie, { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true, ...(conversionNote ? { conversionNote } : {}) });
  assert.equal(v.status, 201, v.text);
  if (submit) assert.equal((await post(`/mappings/${mappingId}/versions/${v.body.version.id}/submit`, owner.cookie, { requestKey: key() })).status, 200);
  return { mappingId, versionId: v.body.version.id, fieldId: f.fieldId, revId: f.revId, target };
}
// A submitted club version of `admin`'s club (a fresh field and club variable).
const clubWaiting = async (admin = W.caA, { f = null, target = null } = {}) =>
  version(f ?? await field(), { owner: admin, target: target ?? await variable(admin) });
// An active club version, activated by `admin` itself (section 10.1).
async function clubActive(admin = W.caA) {
  const v = await clubWaiting(admin);
  ok(await activate(v, admin.cookie));
  return v;
}
// The next version of the same mapping, submitted.
const nextVersion = (v, admin = W.caA) => version({ fieldId: v.fieldId, revId: v.revId }, { owner: admin, target: v.target });
// An active system version (a fresh field and variable), activated in the platform workspace.
async function sysVersion() {
  const v = await version(await field(), { target: await variable(W.pa) });
  ok(await activate(v, W.pa.cookie));
  return v;
}
const auditOf = (sql, params) => rows(k, `select * from ${T8} where ${sql} order by performed_at, id`, params);
const versionRow = (id) => one(k, `select * from ${T4} where id = $1`, [id]);
const statusOf = async (v) => (await versionRow(v.versionId)).status;
const t5 = (id) => one(k, `select * from ${T5} where id = $1`, [id]);
const openOn = (v) => rows(k, `select * from ${T5} where mapping_version_id = $1 and ended_at is null order by id`, [v.versionId]);
const counts = async () => one(k, `select (select count(*)::int from ${T4}) as t4, (select count(*)::int from ${T5}) as t5, (select count(*)::int from ${T8}) as t8,
  (select count(*)::int from ${T4} where status <> 'draft') as moved, (select count(*)::int from ${T5} where ended_at is not null) as ended`);
const keyRow = async (requestKey) => one(k, `select * from ${T8} where request_key = $1`, [requestKey]);

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
const client = async (url = db.url) => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; };

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
const prosrc = async (c, name) => (await one(c, `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = $1`, [name])).prosrc;
const bodies = async (c) => Object.fromEntries(await Promise.all(REPLACED.map(async (n) => [n, await prosrc(c, n)])));
async function blocks(c, file) {
  const text = await fsp.readFile(file, "utf8");
  const out = {};
  for (const part of text.split(/^(?=-- \d+\. )/m).slice(1)) out[Number(part.match(/^-- (\d+)\./)[1])] = (await c.query(part)).rows;
  return out;
}
async function inRolledBack(c, plant, sql) {
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
// A backend waiting on a row - a tuple or a transactionid lock, never an
// advisory or a table lock (J14 section 10.4) - and the tables of the tuple
// locks it holds or waits for; each of `tables` must be among them.
async function rowWait(label, tables = null, c = k, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const w = await one(c, `select pid, wait_event from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
                               and pid <> pg_backend_pid() and cardinality(pg_blocking_pids(pid)) > 0 order by pid limit 1`);
    if (w) {
      const held = (await c.query(
        `select distinct n.nspname || '.' || cl.relname as name from pg_locks l join pg_class cl on cl.oid = l.relation join pg_namespace n on n.oid = cl.relnamespace
          where l.pid = $1 and l.locktype = 'tuple' order by 1`, [w.pid])).rows.map((r) => r.name);
      assert.ok(["tuple", "transactionid"].includes(w.wait_event), `${label}: waits on a row, not on ${w.wait_event}`);
      for (const t of tables || []) assert.ok(held.includes(t), `${label}: waits on a row of ${t} (tuple locks: ${held.join(", ") || "none"})`);
      return { pid: w.pid, waitEvent: w.wait_event, tables: held };
    }
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.fail(`${label}: nobody waits on a lock`);
}
// The pid of a backend waiting on a lock whose query matches `pattern`.
async function waitingOn(pattern, c = k, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await one(c, `select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ~* $1 and pid <> pg_backend_pid() limit 1`, [pattern]);
    if (row) return row.pid;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.fail(`nobody waits on a lock for /${pattern}/`);
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
// Holds the next M2 write named `where` (after its locks and the right,
// before its first write) until the gate opens.
function holdWrite(where) {
  const g = gate();
  const state = { entered: false };
  service.setMappingWriteHoldForTests(async (_client, at) => {
    if (at !== where || state.entered) return;
    state.entered = true;
    await g.promise;
  });
  return { g, state };
}
// Holds the next right re-check (before rightsStillHold's own queries) until the gate opens.
function holdRights() {
  const g = gate();
  const state = { entered: false };
  service.setMappingRightsHoldForTests(async () => {
    if (state.entered) return;
    state.entered = true;
    await g.promise;
  });
  return { g, state };
}
const noDeadlock = () => assert.ok(!logLines.some((l) => /40P01|deadlock detected/i.test(l)), "no 40P01 in the log lines");

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.pa = await platformAdmin();
  W.paA = await platformAdmin(["club", W.clubA]);
  W.paB = await platformAdmin(["club", W.clubB]);
  W.caA = await clubAdmin(W.clubA);
  W.caA2 = await clubAdmin(W.clubA);
  W.caB = await clubAdmin(W.clubB);
  // An admin of two clubs, active in club B's workspace.
  W.caAB = await clubAdmin(W.clubA, ["club", W.clubB]);
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [W.caAB.id, W.clubB]);
  // Club C is archived by the tests that need an archived club.
  W.clubC = await club("Club C");
  W.caC = await clubAdmin(W.clubC);
  // A platform admin who also holds club A's and club B's workspaces.
  W.pa3 = await platformAdmin();
  for (const c of [W.clubA, W.clubB]) await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [W.pa3.id, c]);
  W.coachA = await teamCoach(W.clubA);
  // Club A's admin who is also a coach of a club A team, active in that team's workspace.
  W.caATeam = await clubAdmin(W.clubA);
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [W.caATeam.id, W.coachA.teamId]);
  await workspace(W.caATeam.id, "team", W.coachA.teamId);
  // A platform admin in a team workspace.
  W.paTeam = await platformAdmin();
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [W.paTeam.id, W.coachA.teamId]);
  await workspace(W.paTeam.id, "team", W.coachA.teamId);
  // Club A's admin whose role is revoked (the session stays).
  W.caARevoked = await clubAdmin(W.clubA);
  await setClubRole(W.caARevoked.id, W.clubA, false);
  // A revoked platform admin.
  W.paRevoked = await platformAdmin();
  await setGlobal(W.paRevoked.id, false);
  // An athlete (a user linked to an athlete record), a private coach, a user with no role.
  W.athlete = { id: await user("athlete") };
  await k.query(`insert into public.athletes (user_id, full_name, display_name) values ($1,'Test Athlete','Test Athlete')`, [W.athlete.id]);
  await workspace(W.athlete.id, "athlete", null);
  W.athlete.cookie = await cookieFor(W.athlete.id);
  W.privateCoach = { id: await user("private-coach") };
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [W.privateCoach.id]);
  await workspace(W.privateCoach.id, "private_coach", null);
  W.privateCoach.cookie = await cookieFor(W.privateCoach.id);
  W.plain = { id: await user("no-role") };
  await workspace(W.plain.id, "platform", null);
  W.plain.cookie = await cookieFor(W.plain.id);
  W.bA1 = await binding(W.clubA);
  W.bA2 = await binding(W.clubA);
  W.bB1 = await binding(W.clubB);
}

// ---------------------------------------------------------------------------
// 7i helpers
// ---------------------------------------------------------------------------
const currentVersionOf = async (variableId) => (await one(k, `select current_version_id from training_load.metric_definitions where id = $1`, [variableId])).current_version_id;
// A system variable (the platform workspace, M3-0) with `n` active system
// mapping versions, each of a fresh field, activated by A1.
async function systemVariable({ n = 1, levels = ["session", "drill"], unit = "s" } = {}) {
  const res = await post("/variables", W.pa.cookie, { requestKey: key(), label: `System variable ${uid()}`, unit, levels, dailyAggregationMethod: "sum" });
  assert.equal(res.status, 201, res.text);
  const target = { id: res.body.variable.id };
  const versions = [];
  for (let i = 0; i < n; i += 1) {
    const v = await version(await field(), { target, conversionNote: unit === "s" ? null : "Seconds to the variable's unit." });
    ok(await activate(v, W.pa.cookie));
    versions.push(v);
  }
  return { id: target.id, target, versions, key: res.body.variable.key, label: res.body.variable.label };
}
const copyBody = async (variableId, extra = {}) => ({ requestKey: key(), expectedSourceVersionId: await currentVersionOf(variableId), ...extra });
const copy = async (who, variableId, extra = {}) => post(`/variables/${variableId}/copy`, who.cookie, await copyBody(variableId, extra));
const hide = (who, variableId, requestKey = key()) => post(`/variables/${variableId}/hide`, who.cookie, { requestKey });
const show = (who, variableId, requestKey = key()) => post(`/variables/${variableId}/show`, who.cookie, { requestKey });
const switchBody = (toVersionId, { requestKey = key(), reason = reasonFor("Switch.") } = {}) => ({ requestKey, expectedState: "open", toVersionId, reason });
const switchTo = (who, activationId, toVersionId, opts = {}) => post(`/activations/${activationId}/switch-to-copy`, who.cookie, switchBody(toVersionId, opts));
const getVariable = (who, id) => api(`/variables/${id}`, { cookie: who.cookie });
const listVariables = (who, query = "") => api(`/variables${query}`, { cookie: who.cookie });
// The club drafts a copy made, by its link rows.
const copiedDrafts = (clubVariableId) => rows(k, `select l.club_version_id, l.system_version_id, v.mapping_id, v.status
   from ${LINKS} l join ${T4} v on v.id = l.club_version_id where v.metric_definition_id = $1 order by l.system_version_id`, [clubVariableId]);
// Submit and activate (A1, by `admin`) the club draft linked to system version `sys`.
async function activateCopied(admin, clubVariableId, sys, { starts = null } = {}) {
  const d = (await copiedDrafts(clubVariableId)).find((x) => x.system_version_id === sys.versionId);
  assert.ok(d, "the copy's draft of that system version");
  ok(await post(`/mappings/${d.mapping_id}/versions/${d.club_version_id}/submit`, admin.cookie, { requestKey: key() }));
  ok(await activate({ mappingId: d.mapping_id, versionId: d.club_version_id }, admin.cookie, starts ? { starts } : {}));
  return { mappingId: d.mapping_id, versionId: d.club_version_id };
}
const openActivation = async (v, b) => (await one(k, `select id from ${T5} where mapping_version_id = $1 and source_team_binding_id = $2 and ended_at is null`, [v.versionId, b.bindingId]))?.id;
const hideRow = (clubId, variableId) => one(k, `select * from ${HIDES} where club_id = $1 and metric_definition_id = $2 order by hidden_at desc limit 1`, [clubId, variableId]);
const nothingWritten = async (fn) => {
  const sql = `select (select count(*)::int from training_load.metric_definitions) as d, (select count(*)::int from ${COPIES}) as c,
    (select count(*)::int from ${LINKS}) as l, (select count(*)::int from ${T3}) as t3, (select count(*)::int from ${T4}) as t4,
    (select count(*)::int from ${T8}) as t8, (select count(*)::int from ${REQUESTS}) as rq, (select count(*)::int from ${HIDES}) as h,
    (select count(*)::int from ${T5}) as t5`;
  const before = await one(k, sql);
  const value = await fn();
  assert.deepEqual(await one(k, sql), before, "nothing was written");
  return value;
};
// A raw fixture write must succeed (tx() reports a refusal instead of throwing).
const must = async (pending) => { const res = await pending; assert.equal(res.ok, true, res.error?.message); return res.value; };
// A test field retired or active again (triggers off, as a fixture of a state
// the lifecycle routes build; a disposable database only).
async function setFieldState(fieldId, state) {
  await must(tx(null, async (c) => {
    await c.query("set local session_replication_role = replica");
    await c.query(`update training_load.source_metric_definitions
                      set state = $2::text, retired_by_user_id = case when $2::text = 'retired' then $3::uuid end,
                          retired_at = case when $2::text = 'retired' then now() end, retired_reason = case when $2::text = 'retired' then 'Test retire.' end
                    where id = $1`, [fieldId, state, W.pa.id]);
  }));
}
// A raw change of a system variable's key or label (triggers off): a value the create rules refuse.
async function rawDefinition(id, column, value) {
  await must(tx(null, async (c) => {
    await c.query("set local session_replication_role = replica");
    await c.query(`update training_load.metric_definitions set ${column} = $2 where id = $1`, [id, value]);
  }));
}
// Raw SQL with triggers off (a fixture of a state the routes cannot build; a disposable database only).
const raw = (sql, params = []) => must(tx(null, async (c) => {
  await c.query("set local session_replication_role = replica");
  return (await c.query(sql, params)).rows;
}));

// ---------------------------------------------------------------------------
// 1. Copy (J15 sections 2.2, 4.1 and 5)
// ---------------------------------------------------------------------------
test("1. copy: one transaction writes the club variable (version 1 equal in every semantic fact, the same levels), its copy row, one club mapping and draft per active system version with its link, the unkeyed T8 rows and the variable_copy request record; nothing for a draft, needs-review or disabled system version; a replay answers the saved copy and another body is request_key_reused", async () => {
  const sys = await systemVariable({ n: 2 });
  // A draft, a waiting and a disabled system version of the same variable: none is copied.
  await version(await field(), { target: sys.target, submit: false });
  await version(await field(), { target: sys.target });
  const gone = await version(await field(), { target: sys.target });
  ok(await activate(gone, W.pa.cookie));
  ok(await disable(gone, W.pa.cookie));
  const body = await copyBody(sys.id);
  const res = await post(`/variables/${sys.id}/copy`, W.caA.cookie, body);
  const out = ok(res, 201);
  assert.equal(out.replayed, false);
  const clubId = out.variable.id;
  assert.ok(clubId && clubId !== sys.id);
  assert.equal(out.variable.ownerScope, "club");
  assert.equal(out.variable.key, sys.key, "the key defaults to the system variable's");
  assert.equal(out.variable.label, sys.label);
  const pair = await rows(k, `select d.id, d.owner_scope, d.owner_club_id, d.key, v.version_number, v.unit, v.value_type, v.min_value, v.max_value,
      v.condition_description, v.daily_aggregation_method
    from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id = d.current_version_id
    where d.id = any($1::uuid[]) order by d.owner_scope`, [[clubId, sys.id]]);
  const [club, system] = pair;
  assert.equal(club.owner_club_id, W.clubA);
  assert.equal(club.version_number, 1);
  for (const f of ["unit", "value_type", "min_value", "max_value", "condition_description", "daily_aggregation_method"]) assert.deepEqual(club[f], system[f], f);
  const caps = async (id) => (await rows(k, `select scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 order by 1`, [id])).map((x) => x.scope_level);
  assert.deepEqual(await caps(clubId), await caps(sys.id));
  // The copy row and the request record of this operation.
  const copyRow = await one(k, `select * from ${COPIES} where club_definition_id = $1`, [clubId]);
  assert.deepEqual([copyRow.club_id, copyRow.system_definition_id, copyRow.system_version_id, copyRow.copied_by_user_id, copyRow.basis],
    [W.clubA, sys.id, body.expectedSourceVersionId, W.caA.id, "club_admin"]);
  const request = await one(k, `select * from ${REQUESTS} where request_key = $1`, [body.requestKey]);
  assert.deepEqual([request.operation, request.metric_definition_id, request.owner_club_id, request.operation_id], ["variable_copy", clubId, W.clubA, copyRow.operation_id]);
  // One club mapping and draft per active system version, each linked.
  const drafts = await copiedDrafts(clubId);
  assert.deepEqual(drafts.map((d) => d.system_version_id).sort(), sys.versions.map((v) => v.versionId).sort());
  for (const d of drafts) assert.equal(d.status, "draft");
  for (const d of drafts) {
    const [c, s] = [await versionRow(d.club_version_id), await versionRow(d.system_version_id)];
    for (const f of ["source_metric_definition_id", "source_metric_version_id", "conversion_kind", "scale", "scale_divisor", "offset", "source_unit", "target_unit",
      "parameter_kind", "parameter_fingerprint", "applies_to_session", "applies_to_drill"]) assert.deepEqual(c[f], s[f], f);
    assert.equal(c.owner_key, W.clubA);
    assert.equal(c.version_number, 1);
  }
  // The answer's copiedMappings are exactly the links of this operation, in section 4.1's shape.
  const linked = await rows(k, `select l.club_version_id::text as "versionId", v.mapping_id::text as "mappingId",
      v.source_metric_definition_id::text as "sourceMetricId", l.system_version_id::text as "systemVersionId"
    from ${LINKS} l join training_load.source_metric_mapping_versions v on v.id = l.club_version_id
    where l.operation_id = $1 order by l.system_version_id`, [copyRow.operation_id]);
  assert.equal(linked.length, 2);
  const shape = (m) => ({ versionId: String(m.versionId), mappingId: String(m.mappingId), sourceMetricId: String(m.sourceMetricId), systemVersionId: String(m.systemVersionId) });
  assert.deepEqual(out.copiedMappings.map(shape).sort((a, b) => (a.systemVersionId < b.systemVersionId ? -1 : 1)), linked);
  for (const m of out.copiedMappings) assert.deepEqual(Object.keys(m).sort(), ["mappingId", "sourceMetricId", "systemVersionId", "versionId"]);
  // The T8 rows: mapping_create and mapping_version_create of this operation, unkeyed.
  const t8 = await auditOf(`operation_id = $1`, [copyRow.operation_id]);
  assert.deepEqual(t8.map((x) => x.action).sort(), ["mapping_create", "mapping_create", "mapping_version_create", "mapping_version_create"]);
  for (const x of t8) assert.deepEqual([x.request_key, x.performed_by_user_id, x.basis], [null, W.caA.id, "club_admin"]);
  // A replay: the saved copy, nothing more written.
  const again = await nothingWritten(() => post(`/variables/${sys.id}/copy`, W.caA.cookie, body));
  assert.equal(ok(again).replayed, true);
  assert.equal(again.body.variable.id, clubId);
  // The same key with another body: request_key_reused.
  await nothingWritten(async () => refused(await post(`/variables/${sys.id}/copy`, W.caA.cookie, { ...body, label: `Other ${uid()}` }), 409, "request_key_reused"));
  // A second copy into the same club: already_copied, naming the copy.
  assert.deepEqual(refused(await copy(W.caA2, sys.id), 409, "already_copied").current, { variableId: clubId });
  // The platform admin in club A's workspace copies too (another variable).
  const sys2 = await systemVariable();
  const byPa = ok(await copy(W.paA, sys2.id), 201);
  assert.equal((await one(k, `select basis from ${COPIES} where club_definition_id = $1`, [byPa.variable.id])).basis, "platform_admin");
});

test("2. copy refusals in section 4.1's order, each with nothing written and the key free: copy_source_not_system, source_not_active, source_version_changed, already_copied, key_required, label_required, key_taken, copy_source_unsupported, copy_mapping_not_reproducible, copy_too_large", async () => {
  const freeKey = async (who, variableId, body) => {
    // The key is free: a different, valid request with the same key succeeds or answers its own state.
    const again = await post(`/variables/${variableId}/copy`, who.cookie, body);
    assert.notEqual(again.body.error, "request_key_reused", again.text);
  };
  // Each refusal sent with its own key: nothing written, and no request record holds the key afterwards.
  const refusedFree = async (who, variableId, status, code, extra = {}) => {
    const requestKey = key();
    const out = await nothingWritten(async () => refused(await copy(who, variableId, { requestKey, ...extra }), status, code));
    assert.equal((await one(k, `select count(*)::int as n from ${REQUESTS} where request_key = $1`, [requestKey])).n, 0, `${code}: the key is free`);
    return out;
  };
  // copy_source_not_system: club A's own variable.
  const own = await variable(W.caA);
  await refusedFree(W.caA, own.id, 409, "copy_source_not_system");
  // source_not_active: an archived system variable.
  const archived = await systemVariable({ n: 0 });
  ok(await post(`/variables/${archived.id}/archive`, W.pa.cookie, { requestKey: key(), reason: reasonFor("Archive.") }));
  await refusedFree(W.caA, archived.id, 409, "source_not_active");
  // source_version_changed: another expected version (with the current named).
  const sys = await systemVariable();
  const stale = { requestKey: key(), expectedSourceVersionId: crypto.randomUUID() };
  const changed = await nothingWritten(async () => refused(await post(`/variables/${sys.id}/copy`, W.caA.cookie, stale), 409, "source_version_changed"));
  assert.equal(changed.current.versionId, await currentVersionOf(sys.id));
  assert.equal((await one(k, `select count(*)::int as n from ${REQUESTS} where request_key = $1`, [stale.requestKey])).n, 0, "source_version_changed: the key is free");
  await freeKey(W.caA, sys.id, { ...stale, expectedSourceVersionId: await currentVersionOf(sys.id) });
  // already_copied (the copy above).
  await refusedFree(W.caA, sys.id, 409, "already_copied");
  // key_required / label_required: a system key or label the create rules refuse.
  const odd = await systemVariable({ n: 0 });
  await rawDefinition(odd.id, "key", "Not A Key");
  await refusedFree(W.caA, odd.id, 400, "key_required");
  const oddLabel = await systemVariable({ n: 0 });
  await rawDefinition(oddLabel.id, "label", " padded ");
  await refusedFree(W.caA, oddLabel.id, 400, "label_required");
  ok(await copy(W.caA, oddLabel.id, { label: `Named ${uid()}` }), 201);
  // key_taken: club A already has a variable with that key.
  const sysTaken = await systemVariable({ n: 0 });
  const mine = await post("/variables", W.caA.cookie, { requestKey: key(), key: sysTaken.key, label: `Mine ${uid()}`, unit: "s", levels: ["session"], dailyAggregationMethod: "sum" });
  assert.equal(mine.status, 201, mine.text);
  await refusedFree(W.caA, sysTaken.id, 409, "key_taken");
  ok(await copy(W.caA, sysTaken.id, { key: `other_${uid()}` }), 201);
  // copy_source_unsupported: a day level, no level at all, a value that is not numeric (raw fixtures:
  // variables of the older API, which M3-0's create never makes).
  const dayLevel = await systemVariable({ n: 0 });
  await raw(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, 'day')`, [dayLevel.id]);
  assert.equal((await refusedFree(W.caA, dayLevel.id, 409, "copy_source_unsupported")).current.reason, "day_level");
  const noLevels = await systemVariable({ n: 0 });
  await raw(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1`, [noLevels.id]);
  assert.equal((await refusedFree(W.caA, noLevels.id, 409, "copy_source_unsupported")).current.reason, "no_levels");
  const text = await systemVariable({ n: 0 });
  await raw(`update training_load.metric_definition_versions set value_type = 'text', unit = null where id = $1`, [await currentVersionOf(text.id)]);
  assert.equal((await refusedFree(W.caA, text.id, 409, "copy_source_unsupported")).current.reason, "not_numeric");
  // copy_mapping_not_reproducible: the system mapping's field retired.
  const notRepro = await systemVariable();
  await setFieldState(notRepro.versions[0].fieldId, "retired");
  const nr = await refusedFree(W.caA, notRepro.id, 409, "copy_mapping_not_reproducible");
  assert.equal(nr.current.sourceMetricId, notRepro.versions[0].fieldId);
  // copy_too_large: more than ten active system versions.
  const big = await systemVariable({ n: 11 });
  const tooLarge = await refusedFree(W.caA, big.id, 409, "copy_too_large");
  assert.equal(tooLarge.limit, 10);
});

test("10c. the T5 insert guard on its own: a raw start of a system version on a binding of a club that hides the variable is refused (23514, its fixed text); a raw start waits on the hide lock of a raw hide in flight and, once the hide commits, is refused; a club version is never refused by a hide", async () => {
  const sys = await systemVariable();
  const v = sys.versions[0];
  const b = await binding(W.clubA);
  const rawStart = (c, version, bindingId) => c.query(
    `insert into ${T5} (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, source_team_binding_id, team_id,
                        applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
     select v.id, v.mapping_id, v.source_metric_definition_id, v.metric_definition_id, v.parameter_fingerprint, b.id, b.team_id,
            v.applies_to_session, v.applies_to_drill, 'required', $3, 'club_admin', 'Raw start.'
       from ${T4} v, training_load.source_team_bindings b where v.id = $1 and b.id = $2`, [version.versionId, bindingId, W.caA.id]);
  ok(await hide(W.caA, sys.id));
  refusedWith(await tx(W.caA.id, (c) => rawStart(c, v, b.bindingId)), "23514", HIDDEN_T5);
  ok(await show(W.caA, sys.id));
  // A raw hide in flight holds the hide lock; the raw start waits on it, then sees the hide.
  const h = await client();
  const s = await client();
  try {
    await h.query("begin");
    await h.query(CTX, [W.caA.id]);
    await h.query(`insert into ${HIDES} (club_id, metric_definition_id, hidden_by_user_id, hidden_basis, hide_request_key, hide_request_hash) values ($1,$2,$3,'club_admin',$4,$5)`,
      [W.clubA, sys.id, W.caA.id, key(), "0".repeat(64)]);
    await s.query("begin");
    await s.query(CTX, [W.caA2.id]);
    const starting = s.query(
      `insert into ${T5} (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, source_team_binding_id, team_id,
                          applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
       select v.id, v.mapping_id, v.source_metric_definition_id, v.metric_definition_id, v.parameter_fingerprint, b.id, b.team_id,
              v.applies_to_session, v.applies_to_drill, 'required', $3, 'club_admin', 'Raw start.'
         from ${T4} v, training_load.source_team_bindings b where v.id = $1 and b.id = $2`, [v.versionId, b.bindingId, W.caA2.id]).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    assert.ok(await someoneWaits(), "the raw start waits on the hide lock");
    await h.query("commit");
    const res = await starting;
    await s.query("rollback").catch(() => {});
    refusedWith(res, "23514", HIDDEN_T5);
  } finally {
    await h.end().catch(() => {});
    await s.end().catch(() => {});
  }
  // A club version: no hide applies.
  const copied = ok(await copy(W.caA, sys.id), 201).variable;
  const cv = await activateCopied(W.caA, copied.id, v);
  ok(await start(W.caA, cv, [await binding(W.clubA)]), 201);
});

test("1b. the copy's request hash carries the workspace's club: the same key and body sent from another club's workspace is request_key_reused; the platform admin in two club workspaces copies once into each", async () => {
  const sys = await systemVariable();
  const pa = await platformAdmin(["club", W.clubA]);
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [pa.id, W.clubB]);
  const body = await copyBody(sys.id);
  ok(await post(`/variables/${sys.id}/copy`, pa.cookie, body), 201);
  await workspace(pa.id, "club", W.clubB);
  await nothingWritten(async () => refused(await post(`/variables/${sys.id}/copy`, pa.cookie, body), 409, "request_key_reused"));
  const inB = ok(await post(`/variables/${sys.id}/copy`, pa.cookie, { ...body, requestKey: key() }), 201).variable;
  assert.equal((await one(k, `select club_id from ${COPIES} where club_definition_id = $1`, [inB.id])).club_id, W.clubB);
});

test("1c. a lost COMMIT answer through the copy, the hide, the show and the switch: verified by each request record (the copy's variable_copy request and its operation, the hide row's keys, the switch's T8 row) - 200 verified_after_commit_error (sourceMetrics.js: a create confirmed only after the COMMIT answers 200) and the same key replays; an unverifiable one is 503 outcome_unknown with nothing written, and the same key then writes once", async () => {
  const lost = () => service.setMappingCommitForTests({ fault: (c) => c.query("commit").then(() => { throw Object.assign(new Error("answer lost"), { code: "08006" }); }), timeoutMs: 2_000 });
  const gone = () => service.setMappingCommitForTests({ fault: () => Promise.reject(Object.assign(new Error("socket gone"), { code: "08006" })), timeoutMs: 2_000 });
  const verified = async (send, status) => {
    lost();
    let res;
    try { res = await send(); } finally { service.setMappingCommitForTests(); }
    assert.deepEqual([res.status, res.body.commitConfirmation], [status, "verified_after_commit_error"], res.text);
    return res.body;
  };
  const unknown = async (send) => {
    gone();
    let res;
    try { res = await nothingWritten(() => send()); } finally { service.setMappingCommitForTests(); }
    assert.deepEqual([res.status, res.body.error], [503, "outcome_unknown"], res.text);
    return res.body;
  };
  // The copy.
  const sys = await systemVariable();
  const copyBodyA = await copyBody(sys.id);
  const copied = await verified(() => post(`/variables/${sys.id}/copy`, W.caA.cookie, copyBodyA), 200);
  assert.equal((await rows(k, `select 1 from ${COPIES} where club_definition_id = $1`, [copied.variable.id])).length, 1);
  assert.equal((await copiedDrafts(copied.variable.id)).length, 1, "the copied draft");
  const copyReplay = ok(await post(`/variables/${sys.id}/copy`, W.caA.cookie, copyBodyA));
  assert.deepEqual([copyReplay.replayed, copyReplay.variable.id], [true, copied.variable.id]);
  assert.equal(copyReplay.copiedMappings.length, 1, "the replay names the copied drafts");
  const sys2 = await systemVariable();
  const copyBodyB = await copyBody(sys2.id);
  assert.equal((await unknown(() => post(`/variables/${sys2.id}/copy`, W.caA.cookie, copyBodyB))).requestKey, copyBodyB.requestKey);
  assert.equal(ok(await post(`/variables/${sys2.id}/copy`, W.caA.cookie, copyBodyB), 201).replayed, false, "the same key writes once");
  assert.equal(ok(await post(`/variables/${sys2.id}/copy`, W.caA.cookie, copyBodyB)).replayed, true);
  // The hide and the show.
  const h = await systemVariable();
  const hk = key();
  const hidden = await verified(() => hide(W.caA, h.id, hk), 200);
  assert.deepEqual([hidden.hidden, hidden.variableId], [true, h.id]);
  assert.deepEqual([ok(await hide(W.caA, h.id, hk)).replayed, (await hideRow(W.clubA, h.id)).hide_request_key], [true, hk]);
  const sk = key();
  const shown = await verified(() => show(W.caA, h.id, sk), 200);
  assert.equal(shown.hidden, false);
  assert.deepEqual([ok(await show(W.caA, h.id, sk)).replayed, (await hideRow(W.clubA, h.id)).show_request_key], [true, sk]);
  const h2 = await systemVariable();
  const hk2 = key();
  await unknown(() => hide(W.caA, h2.id, hk2));
  assert.equal(await hideRow(W.clubA, h2.id), undefined, "nothing hidden");
  assert.deepEqual([ok(await hide(W.caA, h2.id, hk2)).replayed, ok(await hide(W.caA, h2.id, hk2)).replayed], [false, true]);
  const sk2 = key();
  await unknown(() => show(W.caA, h2.id, sk2));
  assert.equal((await hideRow(W.clubA, h2.id)).shown_at, null, "still hidden");
  assert.deepEqual([ok(await show(W.caA, h2.id, sk2)).replayed, ok(await show(W.caA, h2.id, sk2)).replayed], [false, true]);
  // A COMMIT whose answer never comes: bounded, the connection dropped (the transaction ends unsent), 503, and the
  // same key then writes once.
  const h3 = await systemVariable();
  const hk3 = key();
  service.setMappingCommitForTests({ fault: () => new Promise(() => {}), timeoutMs: 200 });
  let hung;
  try { hung = await nothingWritten(() => hide(W.caA, h3.id, hk3)); } finally { service.setMappingCommitForTests(); }
  assert.deepEqual([hung.status, hung.body.error], [503, "outcome_unknown"], hung.text);
  assert.equal(await hideRow(W.clubA, h3.id), undefined, "nothing hidden");
  assert.deepEqual([ok(await hide(W.caA, h3.id, hk3)).replayed, ok(await hide(W.caA, h3.id, hk3)).replayed], [false, true]);
  // The switch.
  const sw = await systemVariable();
  const b = await binding(W.clubA);
  ok(await start(W.caA, sw.versions[0], [b]), 201);
  const oldId = await openActivation(sw.versions[0], b);
  const clubVar = ok(await copy(W.caA, sw.id), 201).variable;
  const cv = await activateCopied(W.caA, clubVar.id, sw.versions[0]);
  const body = switchBody(cv.versionId);
  const sent = () => post(`/activations/${oldId}/switch-to-copy`, W.caA.cookie, body);
  await unknown(sent);
  assert.equal((await t5(oldId)).ended_at, null, "the system activation still open");
  const switched = await verified(sent, 200);
  assert.equal(switched.ended.id, oldId);
  assert.equal(ok(await sent()).replayed, true);
});

test("24. architecture: the copy rows and the hides are written only by the variable service, the links (with the copy's T3, T4 and T8 rows) only by the mapping service; nothing in backend/src switches a trigger off", async () => {
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
  assert.deepEqual(writers("metric_definition_copies"), ["canonicalVariableAdminService.js"]);
  assert.deepEqual(writers("metric_definition_club_hides"), ["canonicalVariableAdminService.js"]);
  assert.deepEqual(writers("source_metric_mapping_version_copies"), ["sourceMetricMappingService.js"]);
  assert.deepEqual(files.filter((f) => /disable\s+trigger|session_replication_role/i.test(readFileSync(f, "utf8"))).map((f) => relative(src, f)), []);
});

test("2b. a state answer comes only after the right (security review LOW-1): club A's admin whose role is revoked during the request gets the identical 404, not copy_source_not_system or hide_not_system, for the club's own variable; with the right kept, the 409", async () => {
  const own = await variable(W.caA);
  const base = { status: 404, body: { error: "notFound" }, cache: "no-store", retryAfter: null };
  for (const act of ["copy", "hide"]) {
    const lose = await clubAdmin(W.clubA);
    service.setMappingRightsHoldForTests(async () => {
      await k.query(`update public.user_club_roles set is_active = false where user_id = $1`, [lose.id]);
    });
    try {
      const res = await nothingWritten(() => (act === "copy" ? copy(lose, own.id) : hide(lose, own.id)));
      assert.deepEqual(notFoundShape(res), base, `${act}: the identical 404`);
    } finally {
      service.setMappingRightsHoldForTests(null);
    }
  }
  refused(await copy(W.caA, own.id), 409, "copy_source_not_system");
  refused(await hide(W.caA, own.id), 409, "hide_not_system");
});

// ---------------------------------------------------------------------------
// 3. Hide and Show (J15 sections 2.3 and 4.2)
// ---------------------------------------------------------------------------
test("3. hide and show by each allowed actor; idempotent repeats (a no-op key acts later; a lost no-op, another admin's change, then the same key: the state this admin asked for); a hide key refused for a show and the reverse; variable_in_use with an open system activation on the club's binding; hide_not_system", async () => {
  const sys = await systemVariable();
  for (const who of [W.caA, W.caA2, W.paA]) {
    const h = ok(await hide(who, sys.id));
    assert.deepEqual([h.variableId, h.hidden, h.replayed], [sys.id, true, false]);
    const row = await hideRow(W.clubA, sys.id);
    assert.deepEqual([row.hidden_by_user_id, row.hidden_basis, row.shown_at], [who.id, who === W.paA ? "platform_admin" : "club_admin", null]);
    const s = ok(await show(who, sys.id));
    assert.deepEqual([s.hidden, s.replayed], [false, false]);
    assert.equal((await hideRow(W.clubA, sys.id)).shown_by_user_id, who.id);
  }
  // A no-op: nothing written, the answer says so; the key acts later.
  const noopKey = key();
  const noop = await nothingWritten(() => show(W.caA, sys.id, noopKey));
  assert.deepEqual([ok(noop).hidden, noop.body.idempotent], [false, true]);
  ok(await hide(W.caA2, sys.id));
  const later = ok(await show(W.caA, sys.id, noopKey));
  assert.deepEqual([later.hidden, later.replayed], [false, false], "the no-op key shows now");
  // A replay of a committed act names the state now in force, whoever changed it.
  const hk = key();
  ok(await hide(W.caA, sys.id, hk));
  ok(await show(W.caA2, sys.id));
  const replay = ok(await hide(W.caA, sys.id, hk));
  assert.deepEqual([replay.hidden, replay.replayed], [false, true]);
  // A hide key refused for a show and the reverse (the guards' cross-act check and the request lookup).
  await nothingWritten(async () => refused(await show(W.caA, sys.id, hk), 409, "request_key_reused"));
  const sk = key();
  ok(await hide(W.caA, sys.id));
  ok(await show(W.caA, sys.id, sk));
  await nothingWritten(async () => refused(await hide(W.caA, sys.id, sk), 409, "request_key_reused"));
  // variable_in_use: an open activation of a system version on a club A binding.
  const used = await systemVariable();
  const b = await binding(W.clubA);
  ok(await start(W.caA, used.versions[0], [b]), 201);
  const inUse = await nothingWritten(async () => refused(await hide(W.caA, used.id), 409, "variable_in_use"));
  assert.equal(inUse.current.activationCount, 1);
  // Club B's activation does not count for club A.
  const usedB = await systemVariable();
  ok(await start(W.caB, usedB.versions[0], [await binding(W.clubB)]), 201);
  ok(await hide(W.caA, usedB.id));
  // hide_not_system: club A's own variable.
  const own = await variable(W.caA);
  await nothingWritten(async () => refused(await hide(W.caA, own.id), 409, "hide_not_system"));
});

test("4. a hidden system variable: S1 and A1's listed starts are refused (variable_hidden), the platform workspace's S1 on club A's binding included; club B's admin on club A's binding gets the answer of an unknown binding; another club's start is not affected; Show lifts it", async () => {
  const sys = await systemVariable();
  const v = sys.versions[0];
  ok(await hide(W.caA, sys.id));
  const b = await binding(W.clubA);
  for (const who of [W.caA, W.paA, W.pa]) {
    const res = await nothingWritten(() => start(who, v, [b]));
    assert.deepEqual(refused(res, 409, "variable_hidden").current, { bindingId: b.bindingId });
  }
  // Club B's admin on club A's binding: deep-equal to an unknown binding.
  const foreign = await start(W.caB, v, [b]);
  const unknown = await start(W.caB, v, [crypto.randomUUID()]);
  assert.deepEqual(notFoundShape(foreign), notFoundShape(unknown));
  // Another club is not affected.
  ok(await start(W.caB, v, [await binding(W.clubB)]), 201);
  // A1 with a listed start on club A's binding: a new system version of the same variable.
  const next = await version(await field(), { target: sys.target });
  const a1 = await nothingWritten(() => activate(next, W.pa.cookie, { starts: [b] }));
  assert.deepEqual(refused(a1, 409, "variable_hidden").current, { bindingId: b.bindingId });
  assert.equal(await statusOf(next), "needs_review", "the version stays waiting");
  // Show lifts it.
  ok(await show(W.caA, sys.id));
  ok(await start(W.caA, v, [b]), 201);
});

// ---------------------------------------------------------------------------
// 5. Moving a team to the copy (J15 sections 2.4 and 4.3)
// ---------------------------------------------------------------------------
test("5. switch-to-copy: one transaction ends the team's open system activation (admin_ended) and starts the linked club version on the same binding with the same requirement; the T8 pair of one operation (the end unkeyed, the start keyed); a replay; each refusal in section 4.3's order", async () => {
  const sys = await systemVariable();
  const b = await binding(W.clubA);
  ok(await start(W.caA, sys.versions[0], [{ bindingId: b.bindingId, requirement: "optional" }]), 201);
  const oldId = await openActivation(sys.versions[0], b);
  const clubVar = ok(await copy(W.caA, sys.id), 201).variable;
  // version_not_active: the copy's draft not yet active.
  const draft = (await copiedDrafts(clubVar.id))[0];
  await nothingWritten(async () => refused(await switchTo(W.caA, oldId, draft.club_version_id), 409, "version_not_active"));
  const cv = await activateCopied(W.caA, clubVar.id, sys.versions[0]);
  const body = switchBody(cv.versionId);
  const res = ok(await post(`/activations/${oldId}/switch-to-copy`, W.caA.cookie, body));
  assert.equal(res.replayed, false);
  const ended = await t5(oldId);
  assert.deepEqual([ended.end_reason, ended.ended_by_user_id, ended.ended_basis], ["admin_ended", W.caA.id, "club_admin"]);
  const started = await one(k, `select * from ${T5} where mapping_version_id = $1 and source_team_binding_id = $2 and ended_at is null`, [cv.versionId, b.bindingId]);
  assert.ok(started, "the copy starts on the same binding");
  assert.equal(started.requirement, "optional", "the requirement kept");
  assert.equal(String(ended.ended_at), String(started.activated_at ?? ended.ended_at), "one transaction's time");
  const pair = await auditOf(`operation_id = (select operation_id from ${T8} where request_key = $1)`, [body.requestKey]);
  assert.deepEqual(pair.map((x) => x.action).sort(), ["activation_end", "activation_start"]);
  assert.equal(new Set(pair.map((x) => x.operation_id)).size, 1, "one operation");
  assert.deepEqual(pair.find((x) => x.action === "activation_end").request_key, null);
  assert.equal(pair.find((x) => x.action === "activation_start").request_key, body.requestKey);
  assert.deepEqual([res.ended.id, res.activation.id], [oldId, started.id]);
  const again = await nothingWritten(() => post(`/activations/${oldId}/switch-to-copy`, W.caA.cookie, body));
  assert.deepEqual([ok(again).replayed, again.body.activation.id], [true, started.id]);
  // activation_not_open: the same switch with a new key.
  await nothingWritten(async () => refused(await switchTo(W.caA, oldId, cv.versionId), 409, "activation_not_open"));
});

test("6. switch-to-copy answers: the identical 404 for an unknown activation, an unknown toVersionId, another club's linked version, another club's unlinked one, a system version, the platform workspace and club B's admin; not_a_copy_of_this_version for a club version not linked to this system version; field_retired", async () => {
  const sys = await systemVariable();
  const b = await binding(W.clubA);
  ok(await start(W.caA, sys.versions[0], [b]), 201);
  const oldId = await openActivation(sys.versions[0], b);
  const clubVar = ok(await copy(W.caA, sys.id), 201).variable;
  const cv = await activateCopied(W.caA, clubVar.id, sys.versions[0]);
  // Club B's copy of the same system variable, active, and an unlinked club B version.
  const clubVarB = ok(await copy(W.caB, sys.id), 201).variable;
  const cvB = await activateCopied(W.caB, clubVarB.id, sys.versions[0]);
  const unlinkedB = await clubActive(W.caB);
  const unlinkedA = await clubActive(W.caA);
  const base = notFoundShape(await switchTo(W.caA, crypto.randomUUID(), cv.versionId));
  assert.deepEqual(base, { status: 404, body: { error: "notFound" }, cache: "no-store", retryAfter: null });
  await nothingWritten(async () => {
    for (const [who, act, to, label] of [
      [W.caA, oldId, crypto.randomUUID(), "an unknown toVersionId"],
      [W.caA, oldId, cvB.versionId, "another club's linked version"],
      [W.caA, oldId, unlinkedB.versionId, "another club's unlinked version"],
      [W.caA, oldId, sys.versions[0].versionId, "a system version"],
      [W.pa, oldId, cv.versionId, "the platform workspace"],
      [W.caB, oldId, cv.versionId, "club B's admin"],
      [W.caAB, oldId, cv.versionId, "an admin of A and B in B's workspace"],
    ]) assert.deepEqual(notFoundShape(await switchTo(who, act, to)), base, label);
    refused(await switchTo(W.caA, oldId, unlinkedA.versionId), 409, "not_a_copy_of_this_version");
  });
  // field_retired: the field retired under the activation.
  await setFieldState(sys.versions[0].fieldId, "retired");
  await nothingWritten(async () => refused(await switchTo(W.caA, oldId, cv.versionId), 409, "field_retired"));
  await setFieldState(sys.versions[0].fieldId, "active");
});

test("6b. switch-to-copy refusals combined, in section 4.3's order: an ended activation and a club version not linked to it is not_a_copy_of_this_version; an ended activation and its linked copy still a draft is activation_not_open; an open activation and its linked draft is version_not_active - each with nothing written", async () => {
  const sys = await systemVariable();
  const b = await binding(W.clubA);
  ok(await start(W.caA, sys.versions[0], [b]), 201);
  const oldId = await openActivation(sys.versions[0], b);
  const clubVar = ok(await copy(W.caA, sys.id), 201).variable;
  const draft = (await copiedDrafts(clubVar.id))[0];
  const unlinkedA = await clubActive(W.caA);
  // Open activation + linked draft: version_not_active.
  await nothingWritten(async () => refused(await switchTo(W.caA, oldId, draft.club_version_id), 409, "version_not_active"));
  ok(await end(W.caA, oldId));
  // Ended + not linked: the link is answered first.
  await nothingWritten(async () => refused(await switchTo(W.caA, oldId, unlinkedA.versionId), 409, "not_a_copy_of_this_version"));
  // Ended + linked draft: the activation's state before the version's.
  await nothingWritten(async () => refused(await switchTo(W.caA, oldId, draft.club_version_id), 409, "activation_not_open"));
});

// ---------------------------------------------------------------------------
// 7. Who may do what (J15 section 3; J14 section 10.2's actors)
// ---------------------------------------------------------------------------
test("7. the matrix: copy, hide, show and switch succeed only for club A's admins and the platform admin in A's workspace; everyone else gets the identical 404 (status, body, caching headers), deep-equal to a missing id, another club's variable and a foreign activation, with nothing written", async () => {
  const sys = await systemVariable();
  const b = await binding(W.clubA);
  ok(await start(W.caA, sys.versions[0], [b]), 201);
  const actId = await openActivation(sys.versions[0], b);
  const copied = ok(await copy(W.caA, sys.id), 201).variable;
  const cv = await activateCopied(W.caA, copied.id, sys.versions[0]);
  const target = await systemVariable();
  const clubBVariable = await variable(W.caB);
  const missing = (who, id) => post(`/variables/${id}/copy`, who.cookie, { requestKey: key(), expectedSourceVersionId: crypto.randomUUID() });
  const base = notFoundShape(await missing(W.caA, crypto.randomUUID()));
  assert.deepEqual(base, { status: 404, body: { error: "notFound" }, cache: "no-store", retryAfter: null });
  await setClubActive(W.clubC, false);
  try {
    await nothingWritten(async () => {
      // Club A's own admin on another club's variable, and on a missing one.
      assert.deepEqual(notFoundShape(await missing(W.caA, clubBVariable.id)), base, "another club's variable");
      assert.deepEqual(notFoundShape(await hide(W.caA, clubBVariable.id)), base, "hide another club's variable");
      assert.deepEqual(notFoundShape(await hide(W.caA, crypto.randomUUID())), base, "hide a missing variable");
      assert.deepEqual(notFoundShape(await switchTo(W.caA, crypto.randomUUID(), cv.versionId)), base, "a missing activation");
      for (const [label, who] of [
        ["A's admin in a team workspace", W.caATeam], ["a revoked admin of A", W.caARevoked], ["an archived club's admin", W.caC],
        ["a coach", W.coachA], ["a private coach", W.privateCoach], ["an athlete", W.athlete], ["no role", W.plain],
        ["the platform admin in the platform workspace", W.pa], ["a revoked platform admin", W.paRevoked], ["a platform admin in a team workspace", W.paTeam],
      ]) {
        assert.deepEqual(notFoundShape(await copy(who, target.id)), base, `copy: ${label}`);
        assert.deepEqual(notFoundShape(await hide(who, target.id)), base, `hide: ${label}`);
        assert.deepEqual(notFoundShape(await show(who, target.id)), base, `show: ${label}`);
        assert.deepEqual(notFoundShape(await switchTo(who, actId, cv.versionId)), base, `switch: ${label}`);
        // The gate comes before the body: an invalid body is the same 404, never a 400.
        assert.deepEqual(notFoundShape(await post(`/variables/${target.id}/copy`, who.cookie, { bad: true })), base, `copy, bad body: ${label}`);
        assert.deepEqual(notFoundShape(await post(`/variables/${target.id}/hide`, who.cookie, { bad: true })), base, `hide, bad body: ${label}`);
        assert.deepEqual(notFoundShape(await post(`/variables/${target.id}/show`, who.cookie, { bad: true })), base, `show, bad body: ${label}`);
        assert.deepEqual(notFoundShape(await post(`/activations/${actId}/switch-to-copy`, who.cookie, { bad: true })), base, `switch, bad body: ${label}`);
      }
      for (const [label, who] of [["club B's admin", W.caB], ["an admin of A and B in B's workspace", W.caAB], ["a platform admin in B's workspace", W.paB]]) {
        assert.deepEqual(notFoundShape(await switchTo(who, actId, cv.versionId)), base, `switch: ${label}`);
      }
    });
  } finally {
    await setClubActive(W.clubC, true);
  }
  // The allowed: club A's second admin and the platform admin in A's workspace (hide then show).
  for (const who of [W.caA2, W.paA]) {
    ok(await hide(who, target.id));
    ok(await show(who, target.id));
  }
  // An admin of A and B in B's workspace acts for club B, not for A.
  ok(await hide(W.caAB, target.id));
  assert.equal((await hideRow(W.clubB, target.id))?.shown_at, null);
  assert.equal(await hideRow(W.clubA, target.id).then((x) => x?.shown_at === null), false, "club A's state unchanged");
  ok(await show(W.caAB, target.id));
});

// ---------------------------------------------------------------------------
// 8. The reads (J15 section 4.4)
// ---------------------------------------------------------------------------
test("8. reads: a system row in club A's workspace carries club A's facts and the acts; a team workspace of the club reads only club.hidden and no acts; another club and the platform workspace see nothing of A; ?hidden=exclude|include|only; /mappings and /activations flag targetHiddenInClub; the older definitions read flags hiddenInClub and names ownerScope for the active workspace's club and keeps every row", async () => {
  const sys = await systemVariable();
  const b = await binding(W.clubA);
  ok(await hide(W.caA, sys.id));
  const a = ok(await getVariable(W.caA, sys.id)).variable;
  assert.deepEqual(a.club, { hidden: true, usedByTeams: false, hasDataSource: true, copyId: null });
  assert.deepEqual(a.actions.sort(), ["copy", "show"]);
  const viaPa = ok(await getVariable(W.paA, sys.id)).variable;
  assert.deepEqual([viaPa.club.hidden, viaPa.actions.sort()], [true, ["copy", "show"]]);
  // A team workspace of club A (A's admin who coaches a team there): only the hide.
  const team = ok(await getVariable(W.caATeam, sys.id)).variable;
  assert.deepEqual([team.club, team.actions], [{ hidden: true }, []]);
  // D3, the second case: A's admin who chose a team workspace of A without a team role there. That workspace is not
  // available to them, so the resolver falls back (workspace.js, pickFallbackWorkspace) to club A's workspace and
  // stores it: the read is club A's admin view, as for any admin of A.
  const caNoRole = await clubAdmin(W.clubA, ["team", W.coachA.teamId]);
  const noRole = ok(await getVariable(caNoRole, sys.id)).variable;
  assert.deepEqual([noRole.club, noRole.actions.sort()], [a.club, ["copy", "show"]]);
  assert.deepEqual(await one(k, `select workspace_type, scope_id from public.user_workspace_preferences where user_id = $1`, [caNoRole.id]),
    { workspace_type: "club", scope_id: W.clubA }, "the fallback workspace is stored");
  // Club B and an admin of A and B in B's workspace: club B's facts.
  for (const who of [W.caB, W.caAB]) assert.equal(ok(await getVariable(who, sys.id)).variable.club.hidden, false);
  // The platform workspace: no club block, no club acts.
  const p = ok(await getVariable(W.pa, sys.id)).variable;
  assert.equal(p.club, undefined);
  for (const act of ["use", "copy", "hide", "show"]) assert.ok(!p.actions.includes(act), act);
  // Shown, with a linked team: use, copy, hide.
  ok(await show(W.caA, sys.id));
  assert.deepEqual(ok(await getVariable(W.caA, sys.id)).variable.actions.sort(), ["copy", "hide", "use"]);
  ok(await start(W.caA, sys.versions[0], [b]), 201);
  const used = ok(await getVariable(W.caA, sys.id)).variable;
  assert.deepEqual([used.club.usedByTeams, used.actions.sort()], [true, ["copy", "use"]], "no hide while in use");
  // The list filter.
  const other = await systemVariable();
  ok(await hide(W.caA, other.id));
  const ids = async (q) => {
    const out = [];
    let cursor = null;
    do {
      const res = ok(await listVariables(W.caA, `${q}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
      out.push(...res.variables.map((v) => v.id));
      cursor = res.nextCursor;
    } while (cursor);
    return out;
  };
  const excluded = await ids("?scope=system&state=active");
  assert.ok(excluded.includes(sys.id) && !excluded.includes(other.id), "exclude is the default");
  assert.ok((await ids("?scope=system&state=active&hidden=include")).includes(other.id));
  const only = await ids("?scope=system&state=active&hidden=only");
  assert.ok(only.includes(other.id) && !only.includes(sys.id));
  refused(await listVariables(W.caA, "?hidden=only"), 400, "invalid_query");
  // /mappings and /activations in club A: targetHiddenInClub on system rows.
  const m = ok(await api(`/mappings/${other.versions[0].mappingId}`, { cookie: W.caA.cookie })).mapping;
  assert.equal(m.targetHiddenInClub, true);
  assert.equal(ok(await api(`/mappings/${sys.versions[0].mappingId}`, { cookie: W.caA.cookie })).mapping.targetHiddenInClub, false);
  assert.equal(ok(await api(`/mappings/${other.versions[0].mappingId}`, { cookie: W.caB.cookie })).mapping.targetHiddenInClub, false);
  const acts = ok(await api(`/activations?bindingId=${b.bindingId}`, { cookie: W.caA.cookie })).activations;
  assert.equal(acts.find((x) => x.versionId === sys.versions[0].versionId).targetHiddenInClub, false);
  // The older definitions read: the flag for the active workspace's club, every row kept.
  const older = async (who, label) => {
    const res = await api(`/definitions?search=${encodeURIComponent(label)}&limit=50`, { cookie: who.cookie, prefix: "/api/training-load/metrics" });
    assert.equal(res.status, 200, res.text);
    return res.body.rows.find((x) => x.label === label);
  };
  for (const [who, flag] of [[W.caA, true], [W.caATeam, true], [W.coachA, true], [W.caB, false], [W.caAB, false], [W.pa, false]]) {
    const row = await older(who, other.label);
    assert.ok(row, "the loader keeps the hidden row");
    assert.deepEqual([row.hiddenInClub, row.ownerScope], [flag, "system"]);
  }
});

// ---------------------------------------------------------------------------
// 9. Dashboard template clones (J15 section 4.4, case by case)
// ---------------------------------------------------------------------------
test("9. template resolution: in club A's data workspace a same-key copy and the original are ambiguous until the original is hidden; hidden, the copy resolves; hidden with no club variable of that key, or one the hint's unit, valueType or scopeLevel filter drops, the system variable resolves, never unresolved; a team data workspace resolves the system variable hidden or not; another club unchanged", async () => {
  const widgets = await import("../src/trainingLoadDashboardWidgets.js");
  const resolve = async (hint, ws = ["club", W.clubA]) => {
    const spec = [{ sourceSeriesId: "s", hints: [hint] }];
    return (await widgets.resolveTemplateSeriesBatchForWorkspace(k, spec, { dataWorkspaceType: ws[0], dataWorkspaceScopeId: ws[1], ownerUserId: null })).get("s");
  };
  const teamA = await newTeam(W.clubA);
  // A copy with the system key, the original shown: ambiguous.
  const sys = await systemVariable({ n: 0 });
  const copied = ok(await copy(W.caA, sys.id), 201).variable;
  const both = await resolve(sys.key);
  assert.deepEqual([both.status, [...both.candidateIds].sort()], ["ambiguous", [sys.id, copied.id].sort()], "a same-key copy, the original shown: ambiguous");
  ok(await hide(W.caA, sys.id));
  assert.deepEqual(await resolve(sys.key), { status: "resolved", candidateIds: [copied.id] }, "hidden: the copy resolves");
  assert.deepEqual(await resolve({ key: sys.key, unit: "s", valueType: "numeric", scopeLevel: "session" }), { status: "resolved", candidateIds: [copied.id] });
  // The hint's filters drop the club variable: the hidden system variable stays.
  await raw(`update training_load.metric_definition_versions set unit = 'm' where id = $1`, [await currentVersionOf(copied.id)]);
  assert.deepEqual(await resolve({ key: sys.key, unit: "s" }), { status: "resolved", candidateIds: [sys.id] }, "a unit filter drops the copy");
  await raw(`update training_load.metric_definition_versions set unit = 's' where id = $1`, [await currentVersionOf(copied.id)]);
  await raw(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'session'`, [copied.id]);
  assert.deepEqual(await resolve({ key: sys.key, scopeLevel: "session" }), { status: "resolved", candidateIds: [sys.id] }, "a scopeLevel filter drops the copy");
  // Hidden with no club variable of that key at all.
  const lone = await systemVariable({ n: 0 });
  ok(await hide(W.caA, lone.id));
  assert.deepEqual(await resolve(lone.key), { status: "resolved", candidateIds: [lone.id] }, "never unresolved because of a hide");
  // A team data workspace of club A: the hide does not apply.
  assert.deepEqual(await resolve(lone.key, ["team", teamA]), { status: "resolved", candidateIds: [lone.id] });
  // Another club: unchanged (club B has no copy and no hide).
  assert.deepEqual(await resolve(lone.key, ["club", W.clubB]), { status: "resolved", candidateIds: [lone.id] });
  ok(await show(W.caA, lone.id));
  ok(await show(W.caA, sys.id));
});

// ---------------------------------------------------------------------------
// 10. Direct SQL against v53 (J15 section 10, "Direct SQL")
// ---------------------------------------------------------------------------
// A copy written by hand the way the service writes it (the acting user set by
// tx()), with one thing changed per case; the first guard that fires is the one
// under test.
async function rawCopy(c, o) {
  const clubId = o.clubId ?? W.clubA;
  const by = o.by ?? W.caA.id;
  const basis = o.basis ?? "club_admin";
  const sysVer = await currentVersionOf(o.sys.id);
  const def = (await one(c, `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id, created_by_user_id) values ($1,$2,'club',$3,$4) returning id`,
    [`raw_${uid()}`, `Raw copy ${uid()}`, clubId, by])).id;
  const ver = (await one(c, `insert into training_load.metric_definition_versions
      (metric_definition_id, version_number, unit, value_type, min_value, max_value, condition_description, daily_aggregation_method, created_by_user_id)
    select $1, 1, coalesce($3, unit), value_type, min_value, max_value, condition_description, daily_aggregation_method, $4
      from training_load.metric_definition_versions where id = $2 returning id`, [def, sysVer, o.unit ?? null, by])).id;
  await c.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [ver, def]);
  await c.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level)
                 select $1, scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = $2`, [def, o.sys.id]);
  if (o.extraCap) await c.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, 'day')`, [def]);
  const op = crypto.randomUUID();
  const copyRow = async () => {
    if (o.savepoint === "copy") await c.query("savepoint s1");
    await c.query(`insert into ${COPIES} (club_definition_id, club_id, system_definition_id, system_version_id, copied_by_user_id, basis, operation_id)
                   values ($1,$2,$3,$4,$5,$6,$7)`, [o.clubSide ?? def, clubId, o.sys.id, sysVer, o.rowUser ?? by, basis, op]);
    if (o.savepoint === "copy") await c.query("release savepoint s1");
  };
  if (!o.linkFirst) await copyRow();
  for (const sv of o.mappings ?? []) {
    const mapping = (await one(c, `insert into ${T3} (source_metric_definition_id, source_system, api_family, metric_definition_id, owner_scope, owner_club_id, created_by_user_id)
       select d.id, d.source_system, d.api_family, $2, 'club', $3, $4 from training_load.source_metric_definitions d where d.id = $1 returning id`,
    [sv.fieldId, def, clubId, by])).id;
    const t4 = (await one(c, `insert into ${T4}
         (mapping_id, source_metric_definition_id, metric_definition_id, source_metric_version_id, version_number, metric_definition_version_id,
          conversion_kind, scale, scale_divisor, "offset", source_unit, target_unit, conversion_note, parameter_kind,
          source_parameters, canonical_parameters, parameter_scale, parameter_scale_divisor, parameter_offset, applies_to_session, applies_to_drill, created_by_user_id)
       select $1, s.source_metric_definition_id, $2, coalesce($6::uuid, s.source_metric_version_id), 1, $3,
              s.conversion_kind, s.scale, s.scale_divisor, s."offset", s.source_unit, s.target_unit, s.conversion_note, s.parameter_kind,
              s.source_parameters, s.canonical_parameters, s.parameter_scale, s.parameter_scale_divisor, s.parameter_offset,
              s.applies_to_session, case when $7::boolean then not s.applies_to_drill else s.applies_to_drill end, $4
         from ${T4} s where s.id = $5 returning id`,
    [mapping, def, ver, by, sv.versionId, o.revision ?? null, Boolean(o.flipDrill)])).id;
    if (o.savepoint === "link") await c.query("savepoint s2");
    await c.query(`insert into ${LINKS} (club_version_id, system_version_id, operation_id) values ($1,$2,$3)`, [t4, o.linkTo ?? sv.versionId, o.linkOp ?? op]);
    if (o.savepoint === "link") await c.query("release savepoint s2");
    await c.query(`insert into ${T8} (action, mapping_id, performed_by_user_id, basis, operation_id) values ('mapping_create',$1,$2,$3,$4)`, [mapping, by, basis, op]);
    if (!o.noVersionAudit) {
      await c.query(`insert into ${T8} (action, mapping_id, mapping_version_id, to_status, performed_by_user_id, basis, operation_id)
                     values ('mapping_version_create',$1,$2,'draft',$3,$4,$5)`, [mapping, t4, by, basis, op]);
    }
  }
  if (o.linkFirst) await copyRow();
  if (o.request !== false) {
    await c.query(`insert into ${REQUESTS} (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_definition_id, metric_definition_version_id, operation_id)
                   values ($1,$2,'variable_copy',$3,'club',$4,$5,$6,$7,$8)`, [key(), by, "0".repeat(64), clubId, basis, def, ver, "requestOp" in o ? o.requestOp : op]);
  }
  return { def, ver, op };
}
async function rawHide(c, { clubId = W.clubA, defId, by = W.caA.id, basis = "club_admin", requestKey = key(), shownAt = false, hiddenAt = null, savepoint = false } = {}) {
  if (savepoint) await c.query("savepoint h1");
  const row = await one(c, `insert into ${HIDES} (club_id, metric_definition_id, hidden_by_user_id, hidden_basis, hide_request_key, hide_request_hash, hidden_at
                             ${shownAt ? ", shown_by_user_id, shown_basis, show_request_key, show_request_hash, shown_at" : ""})
                            values ($1,$2,$3,$4,$5,$6, coalesce($7::timestamptz, now()) ${shownAt ? ", $3, $4, gen_random_uuid(), $6, now()" : ""}) returning id`,
  [clubId, defId, by, basis, requestKey, "0".repeat(64), hiddenAt]);
  if (savepoint) await c.query("release savepoint h1");
  return row.id;
}
const rawShow = (c, id, { by = W.caA.id, basis = "club_admin", requestKey = key(), shownAt = null } = {}) => c.query(
  `update ${HIDES} set shown_by_user_id = $2, shown_basis = $3, show_request_key = $4, show_request_hash = $5, shown_at = coalesce($6::timestamptz, now()) where id = $1`,
  [id, by, basis, requestKey, "0".repeat(64), shownAt]);

test("10. direct SQL: every v53 guard refuses with its own code and message - the copy (actor, basis, club side, source, semantics, levels, request at COMMIT, savepoint), the link (draft of this transaction, an active system version, the copy's target, its operation, the pins, identical, its audit row, savepoint), the hide (actor, basis, created open, dated now, system only, in use, one act per key, show facts only, savepoint), append-only, and the request record's operation_id rule; a correct raw copy and hide pass", async () => {
  const C = W.caA.id;
  // The builder is right: a correct raw copy with one mapping, and a raw hide and show, commit.
  const good = await systemVariable();
  await must(tx(C, (c) => rawCopy(c, { sys: good, mappings: [good.versions[0]] })));
  const goodHide = await systemVariable({ n: 0 });
  const hid = await must(tx(C, (c) => rawHide(c, { defId: goodHide.id })));
  await must(tx(C, (c) => rawShow(c, hid)));
  // The copy.
  const fresh = () => systemVariable();
  { const f1 = await fresh(); refusedWith(await tx(null, (c) => rawCopy(c, { sys: f1 })), "42501", /no acting user is set/); }
  { const f2 = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: f2, rowUser: W.caA2.id })), "42501", /^metric variable copy: the row names another user than the acting user$/); }
  { const f3 = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: f3, basis: "platform_admin" })), "42501", /^metric variable copy: the acting user may not copy into this club$/); }
  { const f4 = await fresh(); refusedWith(await tx(W.caB.id, (c) => rawCopy(c, { sys: f4, by: W.caB.id })), "42501", /^metric variable copy: the acting user may not copy into this club$/); }
  { const s = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: s, clubSide: good.id })), "23514", /^metric_definition_copies: the copy must be the club variable written in this transaction$/); }
  { const clubOwn = await variable(W.caA); refusedWith(await tx(C, (c) => rawCopy(c, { sys: { id: clubOwn.id } })), "23514", /^metric_definition_copies: the source must be an active system variable at its current version$/); }
  { const f5 = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: f5, unit: "m" })), "23514", /^metric_definition_copies: version 1 of the copy must equal the system version in every semantic fact$/); }
  { const f6 = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: f6, extraCap: true })), "23514", /^metric_definition_copies: the copy's scope capabilities must equal the system variable's$/); }
  { const f7 = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: f7, request: false })), "23514", /^metric_definition_copies: a copy needs its variable_copy request in the same operation$/); }
  { const f8 = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: f8, savepoint: "copy" })), "23514", /^metric_variable_requests: the request must follow its own operation in the same transaction$/); }
  // (A copy row written in a savepoint is refused first by the request record's guard, which compares the
  // copy's transaction with its own; the copy's deferred savepoint check stays as a second line.)
  // The link.
  { const s = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: s, mappings: [s.versions[0]], linkFirst: true })), "23514", /^source_metric_mapping_version_copies: the club version must target the copy of the system version's variable$/); }
  { const s = await fresh(); const waiting = await version(await field(), { target: s.target });
    refusedWith(await tx(C, (c) => rawCopy(c, { sys: s, mappings: [waiting] })), "23514", /^source_metric_mapping_version_copies: the system version must be an active system version$/); }
  { const s = await fresh(); const other = await systemVariable();
    refusedWith(await tx(C, (c) => rawCopy(c, { sys: s, mappings: [s.versions[0]], linkTo: other.versions[0].versionId })), "23514", /^source_metric_mapping_version_copies: the club version must target the copy of the system version's variable$/); }
  { const s = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: s, mappings: [s.versions[0]], linkOp: crypto.randomUUID() })), "23514", /^source_metric_mapping_version_copies: the link belongs to its copy's operation$/); }
  { const s = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: s, mappings: [s.versions[0]], flipDrill: true })), "23514", /^source_metric_mapping_version_copies: the club version must be identical to the system version$/); }
  { const s = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: s, mappings: [s.versions[0]], noVersionAudit: true })), "23514", /^source_metric_mapping_versions: a version is written with its mapping_version_create audit row$/); }
  // (v35's deferred T4 link fires first at COMMIT; the link's own audit check stays as a second line.)
  { const s = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: s, mappings: [s.versions[0]], savepoint: "link" })), "23514", /^source_metric_mapping_version_copies: a link is written outside a savepoint$/); }
  // The hide.
  const h = await systemVariable({ n: 0 });
  refusedWith(await tx(null, (c) => rawHide(c, { defId: h.id })), "42501", /no acting user is set/);
  refusedWith(await tx(C, (c) => rawHide(c, { defId: h.id, by: W.caA2.id })), "42501", /^metric variable hide: the row names another user than the acting user$/);
  refusedWith(await tx(C, (c) => rawHide(c, { defId: h.id, basis: "platform_admin" })), "42501", /^metric variable hide: the acting user may not hide for this club$/);
  refusedWith(await tx(W.caB.id, (c) => rawHide(c, { defId: h.id, by: W.caB.id })), "42501", /^metric variable hide: the acting user may not hide for this club$/);
  refusedWith(await tx(C, (c) => rawHide(c, { defId: h.id, shownAt: true })), "23514", /^metric_definition_club_hides: a hide is created open$/);
  refusedWith(await tx(C, (c) => rawHide(c, { defId: h.id, hiddenAt: "2020-01-01T00:00:00Z" })), "23514", /^metric_definition_club_hides: a hide is dated by its own transaction$/);
  const clubVar = await variable(W.caA);
  refusedWith(await tx(C, (c) => rawHide(c, { defId: clubVar.id })), "23514", /^metric_definition_club_hides: only a system variable is hidden$/);
  { const used = await systemVariable(); ok(await start(W.caA, used.versions[0], [await binding(W.clubA)]), 201);
    refusedWith(await tx(C, (c) => rawHide(c, { defId: used.id })), "23514", /^metric_definition_club_hides: the variable is switched on for the club's teams$/); }
  refusedWith(await tx(C, (c) => rawHide(c, { defId: h.id, savepoint: true })), "23514", /^metric_definition_club_hides: a hide or a show is written outside a savepoint$/);
  // One act per key: a hide key reused as a show key of the same user, and the reverse.
  const hk = key();
  const open = await must(tx(C, (c) => rawHide(c, { defId: h.id, requestKey: hk })));
  refusedWith(await tx(C, (c) => rawShow(c, open, { requestKey: hk })), "23514", /^metric_definition_club_hides: a request key serves one act only$/);
  const sk = key();
  await must(tx(C, (c) => rawShow(c, open, { requestKey: sk })));
  refusedWith(await tx(C, (c) => rawHide(c, { defId: h.id, requestKey: sk })), "23514", /^metric_definition_club_hides: a request key serves one act only$/);
  // The show: once, only the show facts, by the actor, dated now.
  refusedWith(await tx(C, (c) => rawShow(c, open)), "23514", /^metric_definition_club_hides: a hide is shown again once$/);
  const open2 = await must(tx(C, (c) => rawHide(c, { defId: h.id })));
  refusedWith(await tx(C, (c) => c.query(`update ${HIDES} set hidden_basis = 'platform_admin' where id = $1`, [open2])), "23514", /^metric_definition_club_hides: only the show facts change$/);
  refusedWith(await tx(C, (c) => rawShow(c, open2, { by: W.caA2.id })), "42501", /^metric variable hide: the row names another user than the acting user$/);
  refusedWith(await tx(C, (c) => rawShow(c, open2, { basis: "platform_admin" })), "42501", /^metric variable hide: the acting user may not hide for this club$/);
  refusedWith(await tx(C, (c) => rawShow(c, open2, { shownAt: "2020-01-01T00:00:00Z" })), "23514", /^metric_definition_club_hides: a show is dated by its own transaction$/);
  // Append-only: the copy and the link, and the hide outside its show.
  const copyId = (await one(k, `select club_definition_id from ${COPIES} limit 1`)).club_definition_id;
  const linkId = (await one(k, `select club_version_id from ${LINKS} limit 1`)).club_version_id;
  for (const [sql, params, table] of [
    [`update ${COPIES} set basis = basis where club_definition_id = $1`, [copyId], "metric_definition_copies"],
    [`delete from ${COPIES} where club_definition_id = $1`, [copyId], "metric_definition_copies"],
    [`truncate ${COPIES} cascade`, [], "metric_definition_copies"],
    [`update ${LINKS} set operation_id = operation_id where club_version_id = $1`, [linkId], "source_metric_mapping_version_copies"],
    [`delete from ${LINKS} where club_version_id = $1`, [linkId], "source_metric_mapping_version_copies"],
    [`truncate ${LINKS}`, [], "source_metric_mapping_version_copies"],
    [`delete from ${HIDES} where id = $1`, [open2], "metric_definition_club_hides"],
    [`truncate ${HIDES}`, [], "metric_definition_club_hides"],
  ]) refusedWith(await tx(C, (c) => c.query(sql, params)), "23514", new RegExp(`^${table}: rows are never changed or removed$`));
  // The request record: variable_copy needs an operation_id; no other operation carries one.
  { const f9 = await fresh(); refusedWith(await tx(C, (c) => rawCopy(c, { sys: f9, requestOp: null })), "23514", null); }
  const sysOp = await systemVariable({ n: 0 });
  refusedWith(await tx(W.pa.id, (c) => c.query(`insert into ${REQUESTS} (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_definition_id, metric_definition_version_id, operation_id)
    select $1, $2, 'variable_create', $3, 'system', null, 'platform_admin', d.id, d.current_version_id, gen_random_uuid() from training_load.metric_definitions d where d.id = $4`,
  [key(), W.pa.id, "0".repeat(64), sysOp.id])), "23514", null);
});

test("10b. the one-act key rule holds without the per-user lock: a hide with key K and a show with the same key K of the same user in two raw transactions serialize on the key lock, and the second is refused", async () => {
  const v = await systemVariable({ n: 0 });
  const open = await must(tx(W.caA.id, (c) => rawHide(c, { defId: v.id })));
  const K = key();
  const c1 = await client();
  const c2 = await client();
  try {
    await c1.query("begin");
    await c1.query(CTX, [W.caA.id]);
    // c1 shows the open hide with K (it holds the key lock until it ends).
    await rawShow(c1, open, { requestKey: K });
    await c2.query("begin");
    await c2.query(CTX, [W.caA.id]);
    const second = rawHide(c2, { defId: v.id, requestKey: K }).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    assert.ok(await someoneWaits(), "the second waits on the key lock");
    await c1.query("commit");
    const res = await second;
    await c2.query("rollback").catch(() => {});
    refusedWith(res, "23514", /^metric_definition_club_hides: a request key serves one act only$/);
  } finally {
    await c1.end().catch(() => {});
    await c2.end().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 11. The SQL each write sends, in order (rule of PR #346 in
// .claude/rules/migrations.md: a transaction that takes every lock before its
// first write has a test that records its SQL and asserts that order; the
// Rukovodilac's acceptance of the 7i-B plan: copy, hide, show, switch, S1 with
// the hide lock and A1 with listed starts). Patterns are anchored on the
// services' exact SQL text, so a reworded statement fails rather than passes.
// ---------------------------------------------------------------------------
async function recordSql(fn) {
  const seen = [];
  const wrapped = [];
  const original = appPool.connect;
  appPool.connect = function (callback) {
    if (callback) return original.call(this, callback);
    return original.call(this).then((c) => {
      if (!wrapped.some((w) => w.c === c)) {
        const send = c.query;
        wrapped.push({ c, send });
        c.query = function (...args) {
          const t = typeof args[0] === "string" ? args[0] : args[0]?.text;
          const values = Array.isArray(args[1]) ? args[1] : args[0]?.values;
          if (t) seen.push({ text: t.replace(/\s+/g, " ").trim(), values });
          return send.apply(this, args);
        };
      }
      return c;
    });
  };
  try {
    return { res: await fn(), seen };
  } finally {
    appPool.connect = original;
    for (const { c, send } of wrapped) c.query = send;
  }
}
// The write's own transaction: from the begin before its per-user lock to its COMMIT.
function writeTx(seen) {
  const iLock = seen.findIndex((s) => s.text === "select pg_advisory_xact_lock(hashtextextended($1, 34))");
  assert.ok(iLock > 0, "the write's per-user lock");
  const iBegin = seen.findLastIndex((s, i) => i < iLock && s.text === "begin");
  const iCommit = seen.findIndex((s, i) => i > iLock && s.text === "commit");
  assert.ok(iBegin >= 0 && iCommit > iLock, "one write transaction");
  return seen.slice(iBegin, iCommit + 1);
}
const LOCKING = /\bfor (share|key share|update|no key update)\b|pg_advisory_xact_lock|source_metric_lock_conversions/i;
const listing = (t) => t.map((s, j) => `${j} ${s.text.slice(0, 120)}`).join("\n");
function inOrder(t, patterns, label) {
  let from = 0;
  const at = {};
  let last = "begin";
  for (const [name, re] of patterns) {
    const i = t.findIndex((s, j) => j >= from && re.test(s.text));
    assert.ok(i >= 0, `${label}: ${name} after ${last}\n${listing(t)}`);
    at[name] = i;
    from = i + 1;
    last = name;
  }
  return at;
}
const lockingAfter = (t, i) => t.slice(i + 1).filter((s) => LOCKING.test(s.text)).map((s) => s.text);
const userRowBefore = (t, i) => t.slice(0, i).filter((s) => /\bfor (share|update|no key update) of u\b/i.test(s.text)).map((s) => s.text);
const HIDE_LOCK = /^select pg_advisory_xact_lock\(hashtextextended\('club-variable-hide:' \|\| \$1::uuid::text \|\| ':' \|\| \$2::uuid::text, 0\)\)$/;
const RIGHTS = /for share of u, (g|r)$/;

test("11. SQL order of the copy, the hide and the show: every lock in D's order before the first write (the copy: conversions, T2a, T2b, T3, T4, the system variable, its version, its levels, the rights, the club; the hide and the show: the variable FOR KEY SHARE, the rights, the club, then the hide lock), no users row before the first registry lock, no locking clause after the copy's first write or after the hide lock; the copy takes no hide lock", async () => {
  // A system version with a unit conversion (s -> min), so the conversion lock is in the stream.
  const sys = await systemVariable({ n: 1, unit: "min" });
  const copyTx = writeTx((await recordSql(async () => ok(await copy(W.caA, sys.id), 201))).seen);
  const c = inOrder(copyTx, [
    ["conversions", /^select 1 from training_load\.unit_conversions where state = 'active' and from_unit \|\| chr\(31\) \|\| to_unit = any\(\$1::text\[\]\) order by id for share$/],
    ["T2a", /^select id, state from training_load\.source_metric_definitions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["T2b", /from training_load\.source_metric_definition_versions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["T3", /^select 1 from training_load\.source_metric_mappings where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["T4", /^select 1 from training_load\.source_metric_mapping_versions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["variable", /^select state, current_version_id from training_load\.metric_definitions where id = \$1 for share$/],
    ["version", /^select 1 from training_load\.metric_definition_versions where id = \$1 for share$/],
    ["levels", /metric_definition_scope_capabilities where metric_definition_id = \$1 order by scope_level for share$/],
    ["rights", RIGHTS],
    ["club", /^select 1 from public\.clubs where id = \$1 and coalesce\(is_active, true\) for share$/],
    ["first write", /^insert into training_load\.metric_definitions /],
  ], "copy");
  assert.deepEqual(userRowBefore(copyTx, c.conversions), [], "no users row before the registry locks");
  // The club admin's own right locks the users row before the role row (LO-1, J15 section 10: "a test pins u, r").
  const clubRight = copyTx.filter((s) => /from public\.user_club_roles r join public\.users u on u\.id = r\.user_id where r\.user_id = \$1 and r\.club_id = \$2 and r\.role = 'club_admin'/.test(s.text));
  assert.ok(clubRight.length > 0 && clubRight.every((s) => /for share of u, r$/.test(s.text)), `the club-admin right is u, r: ${clubRight.map((s) => s.text.slice(-24))}`);
  assert.deepEqual(lockingAfter(copyTx, c["first write"]), [], "no locking clause after the first write");
  assert.ok(!copyTx.some((s) => HIDE_LOCK.test(s.text)), "the copy takes no hide lock");
  // The hide and the show.
  const h = await systemVariable({ n: 0 });
  for (const [label, act, write] of [["hide", hide, /^insert into training_load\.metric_definition_club_hides /], ["show", show, /^update training_load\.metric_definition_club_hides set shown_by_user_id/]]) {
    const t = writeTx((await recordSql(async () => ok(await act(W.caA, h.id)))).seen);
    const at = inOrder(t, [
      ["variable", /^select 1 from training_load\.metric_definitions where id = \$1 for key share$/],
      ["rights", RIGHTS],
      ["club", /^select 1 from public\.clubs where id = \$1 and coalesce\(is_active, true\) for share$/],
      ["hide lock", HIDE_LOCK],
      ["first write", write],
    ], label);
    assert.deepEqual(userRowBefore(t, at.variable), [], `${label}: no users row before the variable`);
    assert.deepEqual(lockingAfter(t, at["hide lock"]), [], `${label}: no lock after the hide lock`);
    assert.deepEqual(t[at["hide lock"]].values, [W.clubA, h.id], `${label}: the hide lock of (club, variable)`);
  }
});

test("12. SQL order of S1 with the hide lock, A1 with listed starts and the switch: S1 and A1 take the hide locks after the rights and the clubs, ascending by (club, variable), one statement each, then no lock before the first write; the switch locks T2a, T2b, T3, T4, its T5 row, the binding, the team, the rights and the club before its first end, takes no hide lock, and no lock after its first write", async () => {
  // S1 of a system version on one binding of club A.
  const sys = await systemVariable();
  const b = await binding(W.clubA);
  const s1 = writeTx((await recordSql(async () => ok(await start(W.caA, sys.versions[0], [b]), 201))).seen);
  const a = inOrder(s1, [
    ["T2a", /^select state from training_load\.source_metric_definitions where id = \$1 for share$/],
    ["T2b", /^select 1 from training_load\.source_metric_definition_versions where id = \$1 for share$/],
    ["T3", /^select 1 from training_load\.source_metric_mappings where id = \$1 for share$/],
    ["T4", /^select status from training_load\.source_metric_mapping_versions where id = \$1 and mapping_id = \$2 for share$/],
    ["bindings", /from training_load\.source_team_bindings where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["teams", /from public\.teams where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["rights", RIGHTS],
    ["clubs", /from public\.clubs where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["hide lock", HIDE_LOCK],
    ["first write", /^insert into training_load\.source_metric_mapping_activations /],
  ], "S1");
  assert.deepEqual(userRowBefore(s1, a.T2a), [], "S1: no users row before T2a");
  assert.deepEqual(lockingAfter(s1, a["hide lock"]), [], "S1: no lock after the hide lock");
  // A1 of a system version listing bindings of two clubs: one hide lock per club, ascending.
  const target = await systemVariable({ n: 0 });
  const n1 = await version(await field(), { target: target.target });
  const bA = await binding(W.clubA);
  const bB = await binding(W.clubB);
  const a1 = writeTx((await recordSql(async () => ok(await activate(n1, W.pa.cookie, { starts: [bA, bB] })))).seen);
  const x = inOrder(a1, [
    ["conversions", /^select training_load\.source_metric_lock_conversions\(\$1, \$2, \$3, \$4\)$/],
    ["T2a", /^select 1 from training_load\.source_metric_definitions where id = \$1 for share$/],
    ["T2b", /from training_load\.source_metric_definition_versions where id = \$1 for share$/],
    ["T3", /^select 1 from training_load\.source_metric_mappings where id = \$1 for no key update$/],
    ["T4", /from training_load\.source_metric_mapping_versions where id = any\(\$1::uuid\[\]\) order by id for update$/],
    ["variable", /^select state, current_version_id from training_load\.metric_definitions where id = \$1 for share$/],
    ["bindings", /from training_load\.source_team_bindings where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["teams", /from public\.teams where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["rights", RIGHTS],
    ["clubs", /from public\.clubs where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["hide lock", HIDE_LOCK],
    ["first write", /^update training_load\.source_metric_mapping_versions set status = 'active'/],
  ], "A1");
  assert.deepEqual(userRowBefore(a1, x.conversions), [], "A1: no users row before the conversions");
  assert.deepEqual(lockingAfter(a1, x["first write"] - 1).filter((s) => !HIDE_LOCK.test(s)), [], "A1: nothing but hide locks between the clubs and the first write");
  const hideLocks = a1.filter((s) => HIDE_LOCK.test(s.text)).map((s) => s.values);
  const expected = [[W.clubA, target.id], [W.clubB, target.id]].sort((p, q) => (p[0] < q[0] ? -1 : 1));
  assert.deepEqual(hideLocks, expected, "one hide lock per (club, variable), ascending");
  assert.ok(a1.findIndex((s) => HIDE_LOCK.test(s.text)) > x.clubs && a1.findLastIndex((s) => HIDE_LOCK.test(s.text)) < x["first write"]);
  // A1 replacing N by N+1 while N has an open activation on a club A binding, N+1 listed on it: the first write is
  // then the end of N's row, and the hide lock comes before it, with no other lock between them.
  const rep = await systemVariable();
  const bR = await binding(W.clubA);
  ok(await start(W.caA, rep.versions[0], [bR]), 201);
  const nNext = await version({ fieldId: rep.versions[0].fieldId, revId: rep.versions[0].revId }, { target: rep.target });
  const a1r = writeTx((await recordSql(async () => ok(await activate(nNext, W.pa.cookie, { expected: rep.versions[0].versionId, reason: reasonFor("Replace."), starts: [bR] })))).seen);
  const iClubs = a1r.findIndex((s) => /from public\.clubs where id = any\(\$1::uuid\[\]\) order by id for share$/.test(s.text));
  const iHide = a1r.findIndex((s) => HIDE_LOCK.test(s.text));
  const iEnd = a1r.findIndex((s) => /^update training_load\.source_metric_mapping_activations\b/.test(s.text));
  assert.ok(iClubs >= 0 && iHide > iClubs && iEnd > iHide, `A1 (a replacement): the clubs, then the hide lock, then the first end\n${listing(a1r)}`);
  assert.ok(!a1r.slice(0, iEnd).some((s) => /^(insert|update|delete)\b/i.test(s.text)), "A1 (a replacement): the end is the first write");
  assert.deepEqual(a1r.slice(iHide + 1, iEnd).filter((s) => LOCKING.test(s.text)).map((s) => s.text), [], "A1 (a replacement): no lock between the hide lock and the first end");
  // The switch.
  const sv = await systemVariable();
  const bs = await binding(W.clubA);
  ok(await start(W.caA, sv.versions[0], [bs]), 201);
  const oldId = await openActivation(sv.versions[0], bs);
  const clubVar = ok(await copy(W.caA, sv.id), 201).variable;
  const cv = await activateCopied(W.caA, clubVar.id, sv.versions[0]);
  const sw = writeTx((await recordSql(async () => ok(await switchTo(W.caA, oldId, cv.versionId)))).seen);
  const y = inOrder(sw, [
    ["T2a", /^select id, state from training_load\.source_metric_definitions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["T2b", /^select 1 from training_load\.source_metric_definition_versions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["T3", /^select 1 from training_load\.source_metric_mappings where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["T4", /^select id, status from training_load\.source_metric_mapping_versions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["T5", /^select id, ended_at from training_load\.source_metric_mapping_activations where id = \$1 for no key update$/],
    ["bindings", /from training_load\.source_team_bindings where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["teams", /from public\.teams where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["rights", RIGHTS],
    ["clubs", /from public\.clubs where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["first write", /^update training_load\.source_metric_mapping_activations set ended_at = now\(\)/],
  ], "switch");
  assert.deepEqual(userRowBefore(sw, y.T2a), [], "switch: no users row before T2a");
  assert.deepEqual(lockingAfter(sw, y["first write"]), [], "switch: no lock after the first end");
  assert.ok(!sw.some((s) => HIDE_LOCK.test(s.text)), "the switch takes no hide lock (a club version)");
});

// ---------------------------------------------------------------------------
// 13. Races, route against route, driven deterministically (J15 section 10:
// the services' seams and the waits seen in pg_stat_activity fix the
// interleaving; sleeps are never the proof). No 40P01 anywhere.
// ---------------------------------------------------------------------------
const ORG = "/api/organization";
const revokeClub = (target, clubId) => api(`/users/${target.id}/club-roles/${clubId}/club_admin`, { method: "DELETE", cookie: W.pa.cookie, prefix: ORG });
// A fresh club whose two admins are ordered by user id (low first).
async function clubOfTwo() {
  const clubId = await club("Race club");
  const a = await clubAdmin(clubId);
  const b = await clubAdmin(clubId);
  const [low, high] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
  return { clubId, low, high };
}
// A binding with its connection and source team (for an Unbind through the real route).
async function fullBinding(clubId) {
  const b = await binding(clubId);
  const row = await one(k, `select connection_id, source_team_id from training_load.source_team_bindings where id = $1`, [b.bindingId]);
  return { ...b, connectionId: row.connection_id, sourceTeamId: row.source_team_id };
}
const unbindRoute = (who, b) => post(`/gpexe/connections/${b.connectionId}/bindings/${b.bindingId}/unbind`, who.cookie, {
  requestKey: key(), reason: reasonFor("Unbind."), expected: { teamId: b.teamId, sourceTeamId: b.sourceTeamId },
}, { prefix: "/api/training-load/sources" });
// Holds the activation service at `where` (once) until the gate opens.
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
function holdVariable(where) {
  const g = gate();
  const state = { entered: false };
  variables.setVariableWriteHoldForTests(async (_client, at) => {
    if (at !== where || state.entered) return;
    state.entered = true;
    await g.promise;
  });
  return { g, state };
}
// Bindings of two clubs whose ids sort in the given club order.
async function pairOrdered(firstClub, secondClub) {
  for (;;) {
    const x = await binding(firstClub);
    const y = await binding(secondClub);
    if (x.bindingId < y.bindingId) return [x, y];
  }
}
const advisoryWait = async (timeoutMs = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = (await one(k, `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory' and pid <> pg_backend_pid()`)).n;
    if (n > 0) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
};

test("13. L1: two S1s of one system variable on bindings of two clubs in opposite order, and two A1s with listed starts the same way, route against route: the hide locks are taken ascending by (club, variable), so the second waits for the first's first hide lock and both commit - no 40P01", async () => {
  const from = logLines.length;
  const pa2 = await platformAdmin();
  for (const kind of ["S1", "A1"]) {
    const sys = await systemVariable({ n: kind === "S1" ? 1 : 0 });
    // First request: its bindings sort club A first; second: club B first.
    const [aFirst, bSecond] = await pairOrdered(W.clubA, W.clubB);
    const [bFirst, aSecond] = await pairOrdered(W.clubB, W.clubA);
    const firstClub = [W.clubA, W.clubB].sort()[0];
    // Hold each request after its first hide lock, until its gate opens.
    const gates = [gate(), gate()];
    const entered = [];
    steps.setHideLockHoldForTests(async (client, _pair, index) => {
      if (index !== 0) return;
      const n = entered.length;
      if (n > 1) return;
      entered.push(client);
      await gates[n].promise;
    });
    let first;
    let second;
    if (kind === "S1") {
      first = start(W.pa, sys.versions[0], [aFirst, bSecond]);
      await until(() => entered.length === 1, "the first S1 holds its first hide lock");
      second = start(pa2, sys.versions[0], [bFirst, aSecond]);
    } else {
      const n1 = await version(await field(), { target: sys.target });
      const m1 = await version(await field(), { target: sys.target });
      first = activate(n1, W.pa.cookie, { starts: [aFirst, bSecond] });
      await until(() => entered.length === 1, "the first A1 holds its first hide lock");
      second = activate(m1, pa2.cookie, { starts: [bFirst, aSecond] });
    }
    // The second waits for the first's first hide lock (the lower club), or - under a mutation
    // that drops the ascending order - takes the other one and holds.
    const start2 = Date.now();
    while (!(entered.length === 2 || await advisoryWait(50))) {
      if (Date.now() - start2 > 5000) assert.fail(`${kind}: the second request neither waits nor holds`);
    }
    assert.ok(firstClub, "two clubs");
    gates[0].open();
    gates[1].open();
    const [r1, r2] = await Promise.all([first, second]);
    steps.setHideLockHoldForTests(null);
    assert.ok([200, 201].includes(r1.status), `${kind} first: ${r1.text}`);
    assert.ok([200, 201].includes(r2.status), `${kind} second: ${r2.text}`);
  }
  assert.ok(!logLines.slice(from).some((l) => /40P01|deadlock detected/i.test(l)), "no 40P01");
});

test("14. hide against S1 of the same club and variable, both orders: a hide holding its hide lock makes S1 wait and S1 then answers variable_hidden; an S1 holding its hide lock makes the hide wait and the hide then answers variable_in_use - no 40P01", async () => {
  const from = logLines.length;
  // (a) The hide first.
  const a = await systemVariable();
  const ba = await binding(W.clubA);
  const hh = holdVariable("variable_hide");
  const hiding = hide(W.caA, a.id);
  await until(() => hh.state.entered, "the hide holds its hide lock");
  const starting = start(W.caA2, a.versions[0], [ba]);
  assert.ok(await advisoryWait(), "S1 waits for the hide lock");
  hh.g.open();
  ok(await hiding);
  assert.deepEqual(refused(await starting, 409, "variable_hidden").current, { bindingId: ba.bindingId });
  // (b) S1 first.
  const b = await systemVariable();
  const bb = await binding(W.clubA);
  const hs = holdActivation("activation_start");
  const s1 = start(W.caA, b.versions[0], [bb]);
  await until(() => hs.state.entered, "S1 holds after its hide lock and its checks");
  const hiding2 = hide(W.caA2, b.id);
  assert.ok(await advisoryWait(), "the hide waits for the hide lock");
  hs.g.open();
  ok(await s1, 201);
  refused(await hiding2, 409, "variable_in_use");
  assert.ok(!logLines.slice(from).some((l) => /40P01|deadlock detected/i.test(l)), "no 40P01");
});

test("15. two copies of one system variable by two admins of club A at once: the first held after its checks, the second commits; the first then meets the second's rows at a unique index and answers already_copied naming the second copy; one copy and its drafts are written", async () => {
  const sys = await systemVariable({ n: 2 });
  const hold = holdVariable("variable_copy");
  const first = copy(W.caA, sys.id);
  await until(() => hold.state.entered, "the first copy holds after its checks");
  variables.setVariableWriteHoldForTests(null);
  const made = ok(await copy(W.caA2, sys.id), 201).variable.id;
  hold.g.open();
  assert.deepEqual(refused(await first, 409, "already_copied").current, { variableId: made });
  assert.equal((await one(k, `select count(*)::int as n from ${COPIES} where system_definition_id = $1 and club_id = $2`, [sys.id, W.clubA])).n, 1);
  assert.equal((await copiedDrafts(made)).length, 2);
});

test("15b. the losing copy of 15 whose admin's role is revoked before it names the winner (security review, round 2): the race read checks the right again and answers the identical 404, never the other copy's id", async () => {
  const sys = await systemVariable();
  const { clubId, low, high } = await clubOfTwo();
  const base = notFoundShape(await post(`/variables/${crypto.randomUUID()}/copy`, low.cookie, { requestKey: key(), expectedSourceVersionId: crypto.randomUUID() }));
  const hold = holdVariable("variable_copy");
  const first = copy(low, sys.id);
  await until(() => hold.state.entered, "the first copy holds after its checks");
  variables.setVariableWriteHoldForTests(null);
  const made = ok(await copy(high, sys.id), 201).variable.id;
  // The first copy's own transaction is gone once it meets the winner's rows; its race read then runs on a new
  // connection - the role is revoked right there.
  let revoked = false;
  service.setMappingReadFaultForTests(async () => {
    if (revoked) return;
    revoked = true;
    await setClubRole(low.id, clubId, false);
  });
  hold.g.open();
  let res;
  try { res = await first; } finally { service.setMappingReadFaultForTests(null); }
  assert.ok(revoked, "the race read ran");
  assert.deepEqual(notFoundShape(res), base, "the identical 404");
  assert.ok(!JSON.stringify(res.body).includes(made), "the winner's id is not named");
  assert.equal((await one(k, `select count(*)::int as n from ${COPIES} where system_definition_id = $1 and club_id = $2`, [sys.id, clubId])).n, 1);
});

test("16. copy against A1 of the copied system mapping (D1): A1 holding T3 FOR NO KEY UPDATE makes the copy wait at its T3 lock; the copy reads the active set again and answers try_again, nothing written; a copy holding T3 FOR SHARE makes A1 wait, and A1 commits after it", async () => {
  const sys = await systemVariable();
  const next = await version({ fieldId: sys.versions[0].fieldId, revId: sys.versions[0].revId }, { target: sys.target });
  // (a) A1 first: it replaces version N by N+1 while the copy waits.
  const a1Hold = gate();
  const a1State = { entered: false };
  service.setMappingWriteHoldForTests(async (_c, at) => {
    if (at !== "mapping_version_replace" || a1State.entered) return;
    a1State.entered = true;
    await a1Hold.promise;
  });
  const replacing = activate(next, W.pa.cookie, { expected: sys.versions[0].versionId, reason: reasonFor("Replace.") });
  await until(() => a1State.entered, "A1 holds after its locks");
  const copiesBefore = (await one(k, `select count(*)::int as n from ${COPIES} where system_definition_id = $1`, [sys.id])).n;
  const copying = copy(W.caA, sys.id);
  assert.ok(await someoneWaits(), "the copy waits on T3");
  a1Hold.open();
  ok(await replacing);
  refused(await copying, 409, "try_again");
  assert.equal((await one(k, `select count(*)::int as n from ${COPIES} where system_definition_id = $1`, [sys.id])).n, copiesBefore, "the copy wrote nothing");
  service.setMappingWriteHoldForTests(null);
  // Now it copies the new active version.
  const made = ok(await copy(W.caA, sys.id), 201).variable;
  assert.deepEqual((await copiedDrafts(made.id)).map((d) => d.system_version_id), [next.versionId]);
  // (b) The copy first: A1 waits on T3 behind the copy's FOR SHARE, then commits.
  const sys2 = await systemVariable();
  const next2 = await version({ fieldId: sys2.versions[0].fieldId, revId: sys2.versions[0].revId }, { target: sys2.target });
  const ch = holdVariable("variable_copy");
  const copying2 = copy(W.caA, sys2.id);
  await until(() => ch.state.entered, "the copy holds after its locks");
  const replacing2 = activate(next2, W.pa.cookie, { expected: sys2.versions[0].versionId, reason: reasonFor("Replace.") });
  assert.ok(await someoneWaits(), "A1 waits on T3");
  ch.g.open();
  ok(await copying2, 201);
  ok(await replacing2);
});

test("16b. copy against a new system version, an archive and A2 of the copied system mapping, both orders, route against route: the writer holding the variable FOR UPDATE (or T3 FOR NO KEY UPDATE) makes the copy wait at that row; the copy then reads the state again and answers source_version_changed (naming the new version), source_not_active or try_again with nothing written; a copy holding its locks first makes the writer wait, and both commit - no 40P01", async () => {
  const from = logLines.length;
  const versionBody = async (id, over = {}) => ({ requestKey: key(), expectedCurrentVersionId: await currentVersionOf(id), unit: "s", dailyAggregationMethod: "max", ...over });
  const copiesOf = async (id) => (await one(k, `select count(*)::int as n from ${COPIES} where system_definition_id = $1`, [id])).n;
  // A new system version first: it holds the variable FOR UPDATE while the copy waits at its FOR SHARE.
  const v1 = await systemVariable({ n: 0 });
  let held = holdVariable("variable_version_create");
  const versioning = post(`/variables/${v1.id}/versions`, W.pa.cookie, await versionBody(v1.id));
  await until(() => held.state.entered, "the new version holds the variable");
  const copying = copy(W.caA, v1.id);
  await waitingOn("from training_load\\.metric_definitions where id = \\$1 for share");
  held.g.open();
  const made = ok(await versioning, 201);
  const changed = refused(await copying, 409, "source_version_changed");
  assert.deepEqual(changed.current.versionId, made.variable.currentVersion.id, "it names the new version");
  assert.equal(await copiesOf(v1.id), 0, "the copy wrote nothing");
  // The copy first: the new version waits at the variable's row and commits after it.
  const v2 = await systemVariable({ n: 0 });
  held = holdVariable("variable_copy");
  const copying2 = copy(W.caA, v2.id);
  await until(() => held.state.entered, "the copy holds after its locks");
  const versioning2 = post(`/variables/${v2.id}/versions`, W.pa.cookie, await versionBody(v2.id));
  await waitingOn("from training_load\\.metric_definitions where id = \\$1 for update");
  held.g.open();
  ok(await copying2, 201);
  ok(await versioning2, 201);
  // An archive first: the copy answers source_not_active.
  const v3 = await systemVariable({ n: 0 });
  held = holdVariable("variable_archive");
  const archiving = post(`/variables/${v3.id}/archive`, W.pa.cookie, { requestKey: key(), reason: reasonFor("Archive.") });
  await until(() => held.state.entered, "the archive holds the variable");
  const copying3 = copy(W.caA, v3.id);
  await waitingOn("from training_load\\.metric_definitions where id = \\$1 for share");
  held.g.open();
  ok(await archiving);
  refused(await copying3, 409, "source_not_active");
  assert.equal(await copiesOf(v3.id), 0, "the copy wrote nothing");
  // The copy first: the archive waits and commits after it (the club's copy is its own variable).
  const v4 = await systemVariable({ n: 0 });
  held = holdVariable("variable_copy");
  const copying4 = copy(W.caA, v4.id);
  await until(() => held.state.entered, "the copy holds after its locks");
  const archiving4 = post(`/variables/${v4.id}/archive`, W.pa.cookie, { requestKey: key(), reason: reasonFor("Archive.") });
  await waitingOn("from training_load\\.metric_definitions where id = \\$1 for update");
  held.g.open();
  ok(await copying4, 201);
  ok(await archiving4);
  // A2 first: it holds T3 FOR NO KEY UPDATE; the copy reads the active set again under its T3 lock and answers try_again.
  const v5 = await systemVariable();
  const a2Hold = gate();
  const a2 = { entered: false };
  service.setMappingWriteHoldForTests(async (_c, at) => {
    if (at !== "mapping_version_disable" || a2.entered) return;
    a2.entered = true;
    await a2Hold.promise;
  });
  const disabling = disable(v5.versions[0], W.pa.cookie);
  await until(() => a2.entered, "A2 holds after its locks");
  const copying5 = copy(W.caA, v5.id);
  assert.ok(await someoneWaits(), "the copy waits on T3");
  a2Hold.open();
  ok(await disabling);
  refused(await copying5, 409, "try_again");
  assert.equal(await copiesOf(v5.id), 0, "the copy wrote nothing");
  service.setMappingWriteHoldForTests(null);
  assert.deepEqual(ok(await copy(W.caA, v5.id), 201).copiedMappings, [], "again: nothing active is left to copy");
  // The copy first: A2 waits on T3 behind the copy's FOR SHARE, then commits; the copied draft stays.
  const v6 = await systemVariable();
  held = holdVariable("variable_copy");
  const copying6 = copy(W.caA, v6.id);
  await until(() => held.state.entered, "the copy holds after its locks");
  const disabling6 = disable(v6.versions[0], W.pa.cookie);
  assert.ok(await someoneWaits(), "A2 waits on T3");
  held.g.open();
  const copied6 = ok(await copying6, 201);
  ok(await disabling6);
  assert.deepEqual((await copiedDrafts(copied6.variable.id)).map((d) => d.system_version_id), [v6.versions[0].versionId]);
  assert.ok(!logLines.slice(from).some((l) => /40P01|deadlock detected/i.test(l)), "no 40P01");
});

test("17. switch against S2 on one activation: S2 holding its T5 row makes the switch wait; the switch then answers activation_not_open, nothing written", async () => {
  const sys = await systemVariable();
  const b = await binding(W.clubA);
  ok(await start(W.caA, sys.versions[0], [b]), 201);
  const oldId = await openActivation(sys.versions[0], b);
  const clubVar = ok(await copy(W.caA, sys.id), 201).variable;
  const cv = await activateCopied(W.caA, clubVar.id, sys.versions[0]);
  const held = holdActivation("activation_end");
  const ending = end(W.caA, oldId);
  await until(() => held.state.entered, "S2 holds after its locks");
  activations.setActivationWriteHoldForTests(null);
  const switching = switchTo(W.caA2, oldId, cv.versionId);
  assert.ok(await someoneWaits(), "the switch waits on the T5 row");
  held.g.open();
  ok(await ending);
  refused(await switching, 409, "activation_not_open");
  assert.equal((await one(k, `select count(*)::int as n from ${T5} where mapping_version_id = $1`, [cv.versionId])).n, 0);
});

test("18. a hide, an S1 of the same club and variable by another admin, and the real revocation of the club's admin roles (the hider's id below the starter's): S1 held after its last row lock and before its hide lock; the revocation holds the hider's rows and waits for the starter's; the hide waits for its rights rows; S1 released - no 40P01, S1 commits, the revocation commits, the hide answers the identical 404; the same with a show of an open hide (S1 then answers variable_hidden)", async () => {
  const from = logLines.length;
  for (const act of ["hide", "show"]) {
    const x = await clubOfTwo();
    const sys = await systemVariable();
    const b = await binding(x.clubId);
    const [hider, starter] = [x.low, x.high];
    if (act === "show") ok(await hide(hider, sys.id));
    const hs = holdActivation("activation_start_before_hide");
    const starting = start(starter, sys.versions[0], [b]);
    await until(() => hs.state.entered, "S1 holds before its hide lock");
    const revoking = revokeClub(hider, x.clubId);
    await waitingOn("for update of u, r");
    const acting = act === "hide" ? hide(hider, sys.id) : show(hider, sys.id);
    await waitingOn("for share of u, r");
    hs.g.open();
    const [s1, rv, h] = await Promise.all([starting, revoking, acting]);
    if (act === "hide") ok(s1, 201);
    else refused(s1, 409, "variable_hidden");
    assert.ok([200, 204].includes(rv.status), `the revocation: ${rv.text}`);
    assert.deepEqual(notFoundShape(h), { status: 404, body: { error: "notFound" }, cache: "no-store", retryAfter: null }, `the ${act} lost its right`);
  }
  assert.ok(!logLines.slice(from).some((l) => /40P01|deadlock detected/i.test(l)), "no 40P01");
});

test("19. a switch to the copy, an Unbind of the same binding and the real revocation of the club's admin roles (the Unbind's user below the switcher's): the Unbind held after its binding lock; the switch waits on the binding holding no rights row; the revocation runs; the Unbind released - no 40P01", async () => {
  const from = logLines.length;
  const x = await clubOfTwo();
  const [unbinder, switcher] = [x.low, x.high];
  const sys = await systemVariable();
  const b = await fullBinding(x.clubId);
  ok(await start(switcher, sys.versions[0], [b]), 201);
  const oldId = await openActivation(sys.versions[0], b);
  const clubVar = ok(await copy(switcher, sys.id), 201).variable;
  const cv = await activateCopied(switcher, clubVar.id, sys.versions[0]);
  const ug = gate();
  const us = { entered: false };
  connections.setSourceUnbindHoldForTests(async () => {
    if (us.entered) return;
    us.entered = true;
    await ug.promise;
  });
  const unbinding = unbindRoute(unbinder, b);
  await until(() => us.entered, "the Unbind holds after its binding lock");
  const switching = switchTo(switcher, oldId, cv.versionId);
  await waitingOn("source_team_bindings");
  const revoking = revokeClub(unbinder, x.clubId);
  // The revocation either finishes (nobody holds the admins' rows in the contract order) or waits.
  const settled = { done: false };
  revoking.finally(() => { settled.done = true; });
  const t0 = Date.now();
  while (!settled.done && !(await someoneWaits(k, 50) && (await one(k, `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ~* 'for update of u, r'`)).n > 0)) {
    if (Date.now() - t0 > 5000) break;
  }
  ug.open();
  const [u, s, rv] = await Promise.all([unbinding, switching, revoking]);
  assert.ok([200, 404, 409].includes(u.status), `the Unbind: ${u.text}`);
  assert.ok([200, 404, 409].includes(s.status), `the switch: ${s.text}`);
  assert.ok([200, 204].includes(rv.status), `the revocation: ${rv.text}`);
  assert.ok(!logLines.slice(from).some((l) => /40P01|deadlock detected/i.test(l)), "no 40P01");
});

test("20. a hide holding its hide lock and an A1 of the hidden variable's system mapping waiting for it (holding the variable FOR SHARE): no 40P01, and once the hide's guard has run the hide holds the variable's row only FOR KEY SHARE (pgrowlocks: the row locks actually held, per backend)", async () => {
  const from = logLines.length;
  const sys = await systemVariable({ n: 0 });
  const n1 = await version(await field(), { target: sys.target });
  const b = await binding(W.clubA);
  const hold = gate();
  const atCommit = gate();
  const st = { entered: false, pid: null };
  variables.setVariableWriteHoldForTests(async (client, at) => {
    if (at !== "variable_hide" || st.entered) return;
    st.entered = true;
    await hold.promise;
  });
  // The hide's COMMIT held after its guard ran (every write done, every lock still held).
  service.setMappingCommitForTests({
    fault: async (c) => {
      if (!st.pid) {
        st.pid = (await c.query("select pg_backend_pid() as p")).rows[0].p;
        await atCommit.promise;
      }
      return c.query("commit");
    },
    timeoutMs: 30_000,
  });
  const hiding = hide(W.caA, sys.id);
  await until(() => st.entered, "the hide holds its hide lock");
  const activating = activate(n1, W.pa.cookie, { starts: [b] });
  assert.ok(await advisoryWait(), "A1 waits for the hide lock");
  // The hide goes on: its insert and its guard run while A1 holds the row FOR SHARE (a guard lock that conflicts
  // with FOR SHARE would deadlock here), and it stops before its COMMIT.
  hold.open();
  await until(() => st.pid !== null, "the hide reached its COMMIT");
  await k.query("create extension if not exists pgrowlocks");
  try {
    const held = await rows(k, `select l.modes, l.pids from pgrowlocks('training_load.metric_definitions') l
                                  where l.locked_row = (select ctid from training_load.metric_definitions where id = $1)`, [sys.id]);
    assert.equal(held.length, 1, "the variable's row is locked");
    const byPid = new Map();
    // pgrowlocks names a lone locker "For Key Share" and a multixact member "Key Share": one name for both.
    held[0].pids.forEach((pid, i) => byPid.set(pid, [...(byPid.get(pid) ?? []), held[0].modes[i].replace(/^For /, "")]));
    assert.deepEqual(byPid.get(st.pid), ["Key Share"], `the hide holds the variable's row only FOR KEY SHARE: ${JSON.stringify(held[0])}`);
    const others = [...byPid].filter(([pid]) => pid !== st.pid).flatMap(([, modes]) => modes);
    assert.deepEqual(others, ["Share"], "and the waiting A1 holds it FOR SHARE (the read sees both lockers)");
  } finally {
    await k.query("drop extension if exists pgrowlocks");
    atCommit.open();
  }
  ok(await hiding);
  assert.deepEqual(refused(await activating, 409, "variable_hidden").current, { bindingId: b.bindingId });
  assert.ok(!logLines.slice(from).some((l) => /40P01|deadlock detected/i.test(l)), "no 40P01");
});

test("21. a club-role revocation during a copy (J14 R13's pattern): the revocation holding the copier's rows makes the copy wait at its rights and answer the identical 404 with nothing written; the copy holding its rights first commits and the revocation follows - no 40P01", async () => {
  const from = logLines.length;
  // (a) The revocation first.
  const x = await clubOfTwo();
  const sys = await systemVariable();
  const rights = gate();
  const rs = { entered: false };
  service.setMappingRightsHoldForTests(async () => {
    if (rs.entered) return;
    rs.entered = true;
    await rights.promise;
  });
  const copying = nothingWritten(() => copy(x.low, sys.id));
  await until(() => rs.entered, "the copy holds before its rights");
  service.setMappingRightsHoldForTests(null);
  const rv = await revokeClub(x.low, x.clubId);
  assert.ok([200, 204].includes(rv.status), rv.text);
  rights.open();
  assert.deepEqual(notFoundShape(await copying), { status: 404, body: { error: "notFound" }, cache: "no-store", retryAfter: null });
  // (b) The copy first.
  const y = await clubOfTwo();
  const sys2 = await systemVariable();
  const ch = holdVariable("variable_copy");
  const copying2 = copy(y.low, sys2.id);
  await until(() => ch.state.entered, "the copy holds after its rights");
  const revoking = revokeClub(y.low, y.clubId);
  await waitingOn("for update of u, r");
  ch.g.open();
  const answer = await copying2;
  assert.ok(answer.status === 201 || (answer.status === 404 && answer.body.error === "notFound"), `the copy commits; its answer re-checks the right after the COMMIT (C69): ${answer.text}`);
  assert.equal((await one(k, `select count(*)::int as n from ${COPIES} where system_definition_id = $1 and club_id = $2`, [sys2.id, y.clubId])).n, 1, "the copy committed");
  assert.ok([200, 204].includes((await revoking).status));
  assert.ok(!logLines.slice(from).some((l) => /40P01|deadlock detected/i.test(l)), "no 40P01");
});

// ---------------------------------------------------------------------------
// 22-23. The migration: md5 preconditions, rehearsal on a v52 database
// (J15 sections 7.6 and 10).
// ---------------------------------------------------------------------------
// The body of `name` between its $$ quotes in a migration file, read as LF
// (the method that reproduces v48's rollback constant).
async function bodyInFile(file, name) {
  const text = (await fsp.readFile(file, "utf8")).replace(/\r\n/g, "\n");
  const at = text.search(new RegExp(`create (or replace )?function training_load\\.${name}\\(\\)`));
  assert.ok(at >= 0, `${name} in ${path.basename(file)}`);
  const b0 = text.indexOf("$$", at);
  const b1 = text.indexOf("$$", b0 + 2);
  return text.slice(b0 + 2, b1);
}
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

test("22. md5 preconditions: v36's request guard and v48's T5 guard, computed from the migration files read as LF, equal v53's preconditions, and md5(prosrc) of each on a database migrated through v52 equals them; one byte changed in either body in force makes v53 refuse with nothing applied", async () => {
  assert.equal(md5(await bodyInFile(V36_FILE, "metric_variable_requests_insert_guard")), V36_REQUEST_GUARD_MD5);
  assert.equal(md5(await bodyInFile(V48_FILE, "source_metric_activations_insert_guard")), V48_T5_GUARD_MD5);
  const v53Text = await fsp.readFile(V53_FILE, "utf8");
  assert.ok(v53Text.includes(V36_REQUEST_GUARD_MD5) && v53Text.includes(V48_T5_GUARD_MD5), "v53 checks both");
  assert.equal(md5(await prosrc(r, "metric_variable_requests_insert_guard")), V36_REQUEST_GUARD_MD5);
  assert.equal(md5(await prosrc(r, "source_metric_activations_insert_guard")), V48_T5_GUARD_MD5);
  for (const [name, file] of [["metric_variable_requests_insert_guard", V36_FILE], ["source_metric_activations_insert_guard", V48_FILE]]) {
    const original = await bodyInFile(file, name);
    try {
      await r.query(`create or replace function training_load.${name}() returns trigger as $body$${original.replace("begin\n", "begin \n")}$body$ language plpgsql`);
      assert.notEqual(md5(await prosrc(r, name)), md5(original));
      const logged = logLines.length;
      await assert.rejects(migrate(rdb.url, [...UP_TO_V52, V53]), /SQLSTATE 23514/);
      assert.match(logLines.slice(logged).join("\n"), new RegExp(`v53 refused: the body in force of training_load\\.${name}`), "the migrator reports v53's own refusal");
    } finally {
      await r.query(`create or replace function training_load.${name}() returns trigger as $body$${original}$body$ language plpgsql`);
    }
    assert.equal(md5(await prosrc(r, name)), md5(original), "restored");
  }
  assert.equal((await one(r, `select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V53_NAME])).n, 0, "nothing applied");
});

test("23. rehearsal on v52: the preflight (with planted rows for the copy-refusal count), NOWAIT failing at once under a reader of the request table, the runner, the exact catalog delta, the post-check, every refusal of the rollback, the rollback back to v52's catalog exactly, a failed last statement changing nothing, v53 again, LF endings", async () => {
  const v52 = await catalog(r);
  // The preflight.
  const pre = await blocks(r, PREFLIGHT);
  assert.equal(pre[1][0].pg15_or_later, true);
  assert.deepEqual(pre[2][0], { v52_rows: "1", v52_checksum_ok: true, v53_rows: "0", at_or_after_v53: "0", last_migration: V52_NAME });
  assert.deepEqual(pre[3][0], { request_guard_is_v36: true, t5_guard_is_v48: true });
  assert.deepEqual(pre[4][0], { operation_check_is_v45: true, version_iff_is_v38: true, index_is_v36: true, trigger_is_v38: true });
  assert.deepEqual(pre[5][0], { new_tables: "0", new_functions: "0", operation_id_column: "0", disabled_triggers: "0" });
  assert.deepEqual(pre[6][0], { owns_requests: true, owns_t5: true, owned_functions: "2", may_create: true });
  assert.deepEqual(pre[7][0], { actor_defaults: "0" });
  // Block 9 on planted system variables (rolled back): one text, one day-level, one without levels.
  const text9 = (await fsp.readFile(PREFLIGHT, "utf8")).split(/^(?=-- \d+\. )/m).find((p) => p.startsWith("-- 9."));
  await r.query("begin");
  try {
    await r.query("set local session_replication_role = replica");
    const before = (await r.query(text9)).rows[0];
    const by = (await one(r, `select id from public.users limit 1`))?.id ?? (await one(r, `insert into public.users (email, full_name, display_name) values ($1,'x','x') returning id`, [`p-${uid()}@test.local`])).id;
    const plant = async (valueType, unit, scopes) => {
      const d = (await one(r, `insert into training_load.metric_definitions (key, label, owner_scope, created_by_user_id) values ($1, 'Planted', 'system', $2) returning id`, [`planted_${uid()}`, by])).id;
      const v = (await one(r, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, created_by_user_id) values ($1, 1, $2, $3, $4) returning id`, [d, unit, valueType, by])).id;
      await r.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [v, d]);
      for (const s of scopes) await r.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, $2)`, [d, s]);
    };
    await plant("text", null, ["session"]);
    await plant("numeric", "s", ["day"]);
    await plant("numeric", "s", []);
    const after = (await r.query(text9)).rows[0];
    assert.equal(Number(after.not_numeric) - Number(before.not_numeric), 1);
    assert.equal(Number(after.day_level) - Number(before.day_level), 1);
    assert.equal(Number(after.no_levels) - Number(before.no_levels), 1);
    assert.equal(Number(after.active_system_variables) - Number(before.active_system_variables), 3);
  } finally {
    await r.query("rollback");
  }
  // NOWAIT: a reader of the request table makes the migration fail at once, nothing applied.
  const reader = await client(rdb.url);
  try {
    await reader.query("begin");
    await reader.query("select 1 from training_load.metric_variable_requests limit 1");
    const t0 = Date.now();
    await assert.rejects(migrate(rdb.url, [...UP_TO_V52, V53]), /SQLSTATE 55P03/);
    assert.ok(Date.now() - t0 < 10_000, "it fails at once");
  } finally {
    await reader.query("rollback").catch(() => {});
    await reader.end().catch(() => {});
  }
  assert.deepEqual(await catalog(r), v52, "nothing applied");
  // The runner, and the exact catalog delta.
  await migrate(rdb.url, [...UP_TO_V52, V53]);
  const v53 = await catalog(r);
  const names = (list, f) => new Set(list.map(f));
  const added = (a, b, f) => [...names(b, f)].filter((x) => !names(a, f).has(x)).sort();
  const removed = (a, b, f) => [...names(a, f)].filter((x) => !names(b, f).has(x)).sort();
  assert.deepEqual(added(v52.tables, v53.tables, (t) => `${t.table_schema}.${t.table_name}`),
    ["training_load.metric_definition_club_hides", "training_load.metric_definition_copies", "training_load.source_metric_mapping_version_copies"]);
  assert.deepEqual(removed(v52.tables, v53.tables, (t) => `${t.table_schema}.${t.table_name}`), []);
  assert.deepEqual(added(v52.columns, v53.columns, (c) => `${c.table_name}.${c.column_name}`).filter((x) => x.startsWith("metric_variable_requests.")), ["metric_variable_requests.operation_id"]);
  assert.deepEqual(removed(v52.columns, v53.columns, (c) => `${c.table_name}.${c.column_name}`), []);
  const fnKey = (f) => `${f.proname}`;
  assert.deepEqual(added(v52.functions, v53.functions, fnKey), ["club_variable_rows_append_only", "metric_definition_club_hides_insert_guard",
    "metric_definition_club_hides_update_guard", "metric_definition_club_hides_xact_link", "metric_definition_copies_insert_guard",
    "metric_definition_copies_request_link", "source_metric_mapping_version_copies_audit_link", "source_metric_mapping_version_copies_insert_guard"]);
  const changedFns = v52.functions.filter((f) => { const g = v53.functions.find((x) => x.proname === f.proname && x.nspname === f.nspname && x.args === f.args); return g && g.digest !== f.digest; }).map((f) => f.proname).sort();
  assert.deepEqual(changedFns, ["metric_variable_requests_insert_guard", "source_metric_activations_insert_guard"], "exactly the two replaced bodies");
  const conKey = (c) => `${c.rel}.${c.conname}=${c.def}`;
  assert.deepEqual(removed(v52.constraints, v53.constraints, conKey).filter((x) => !x.includes("metric_definition_copies") && !x.includes("club_hides") && !x.includes("version_copies")).map((x) => x.split("=")[0]),
    ["training_load.metric_variable_requests.metric_variable_requests_operation_check", "training_load.metric_variable_requests.metric_variable_requests_version_iff"]);
  const changedTriggers = v52.triggers.filter((t) => { const u = v53.triggers.find((x) => x.tgname === t.tgname && x.relname === t.relname); return !u || u.def !== t.def || u.tgenabled !== t.tgenabled; }).map((t) => t.tgname);
  assert.deepEqual(changedTriggers, ["metric_variable_requests_insert_guard"], "only the request trigger's WHEN changed");
  const changedIndexes = v52.indexes.filter((i) => { const j = v53.indexes.find((x) => x.indexname === i.indexname); return !j || j.indexdef !== i.indexdef; }).map((i) => i.indexname);
  assert.deepEqual(changedIndexes, ["metric_variable_requests_one_create_per_definition"]);
  assert.deepEqual(v53.migrations.slice(-1), [V53_NAME]);
  // The post-check.
  const post = await blocks(r, POSTCHECK);
  assert.deepEqual(post[1][0], { v53_rows: "1", v53_checksum_ok: true, later_migrations: "0" });
  assert.deepEqual(post[2][0], { replaced_bodies_v53: "2", new_bodies_v53: "8" });
  assert.deepEqual(post[3][0], { operation_check_v53: true, version_iff_v53: true, operation_id_iff_v53: true, index_v53: true, trigger_v53: true });
  assert.deepEqual(post[4][0], { new_tables: "3", new_triggers: "13", deferred_triggers: "3", disabled_triggers: "0", new_indexes: "8" });
  assert.deepEqual(post[5][0], { copies: "0", links: "0", hides: "0", copy_requests: "0" });
  assert.deepEqual(post[6][0], { actor_defaults: "0", session_actor: "" });
  assert.deepEqual(post[7][0], { idle_in_transaction: "0", waiting: "0" });
  // The rollback's refusals, each planted in a transaction that is rolled back.
  const rollbackSql = await fsp.readFile(ROLLBACK, "utf8");
  const any = async () => (await one(r, `select id from public.users limit 1`))?.id ?? crypto.randomUUID();
  const refusal = async (plant, pattern) => {
    const error = await inRolledBack(r, plant, rollbackSql);
    assert.ok(error, `refused: ${pattern}`);
    assert.match(error.message, pattern);
  };
  const replica = (c) => c.query("set local session_replication_role = replica");
  await refusal(async (c) => { await replica(c); await c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', $1, 'test')`, ["0".repeat(64)]); }, /later migrations are applied/);
  await refusal(async (c) => { await replica(c); const u = await any(); const d = crypto.randomUUID();
    await c.query(`insert into training_load.metric_definition_copies (club_definition_id, club_id, system_definition_id, system_version_id, copied_by_user_id, basis, operation_id) values ($1,$1,$2,$2,$3,'club_admin',$1)`, [d, crypto.randomUUID(), u]); }, /a copy exists/);
  await refusal(async (c) => { await replica(c); await c.query(`insert into training_load.source_metric_mapping_version_copies (club_version_id, system_version_id, operation_id) values ($1,$2,$1)`, [crypto.randomUUID(), crypto.randomUUID()]); }, /a copied mapping version link exists/);
  await refusal(async (c) => { await replica(c); const u = await any();
    await c.query(`insert into training_load.metric_definition_club_hides (club_id, metric_definition_id, hidden_by_user_id, hidden_basis, hide_request_key, hide_request_hash) values ($1,$2,$3,'club_admin',$1,$4)`, [crypto.randomUUID(), crypto.randomUUID(), u, "0".repeat(64)]); }, /a hide exists/);
  await refusal(async (c) => { await replica(c); const u = await any();
    await c.query(`insert into training_load.metric_variable_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_definition_id, metric_definition_version_id, operation_id)
                   values ($1,$2,'variable_copy',$3,'club',$1,'club_admin',$1,$1,$1)`, [crypto.randomUUID(), u, "0".repeat(64)]); }, /a variable_copy request exists/);
  await refusal((c) => c.query(`drop function training_load.metric_definition_club_hides_update_guard() cascade`), /a v53 function is missing/);
  await refusal((c) => c.query(`drop trigger metric_definition_copies_no_truncate on training_load.metric_definition_copies`), /a trigger of a v53 table is missing/);
  await refusal((c) => c.query(`alter table training_load.source_metric_mapping_activations disable trigger source_metric_activations_insert_guard`), /a trigger on the request table, T5 or a v53 table is disabled/);
  await refusal((c) => c.query(`create or replace function training_load.source_metric_activations_insert_guard() returns trigger as $$ begin return new; end; $$ language plpgsql`), /a body in force is not v53's/);
  await refusal((c) => c.query(`delete from public.schema_migrations where migration_name = $1`, [V53_NAME]), /v53 is not recorded on this database/);
  const holder = await client(rdb.url);
  try {
    await holder.query("select pg_advisory_lock(822026)");
    const error = await inRolledBack(r, null, rollbackSql);
    assert.match(error?.message ?? "", /the migrator is running/);
  } finally {
    await holder.query("select pg_advisory_unlock(822026)").catch(() => {});
    await holder.end().catch(() => {});
  }
  assert.deepEqual(await catalog(r), v53, "every refusal changed nothing");
  // A restored body that is not v36's (one byte changed in the script) is refused before the COMMIT.
  const marker = "-- v36's request insert guard, byte for byte.";
  const at = rollbackSql.indexOf(marker);
  assert.ok(at > 0, "the rollback restores v36's body");
  const bodyAt = rollbackSql.indexOf("begin\n", at);
  const wrongBody = rollbackSql.slice(0, bodyAt) + "begin \n" + rollbackSql.slice(bodyAt + "begin\n".length);
  await assert.rejects(r.query(wrongBody), /v53 rollback refused: a restored body is not v36's or v48's/);
  await r.query("rollback").catch(() => {});
  assert.deepEqual(await catalog(r), v53, "a wrong restored body changes nothing");
  // A failed last statement changes nothing.
  const failing = rollbackSql.replace(/\ncommit;\s*$/, "\nselect 1 / 0;\ncommit;\n");
  assert.notEqual(failing, rollbackSql);
  await assert.rejects(r.query(failing), /division by zero/);
  await r.query("rollback").catch(() => {});
  assert.deepEqual(await catalog(r), v53, "atomic");
  // The rollback: back to v52's catalog exactly, both bodies by md5.
  await r.query(rollbackSql);
  assert.deepEqual(await catalog(r), v52, "the v52 catalog, exactly");
  assert.equal(md5(await prosrc(r, "metric_variable_requests_insert_guard")), V36_REQUEST_GUARD_MD5);
  assert.equal(md5(await prosrc(r, "source_metric_activations_insert_guard")), V48_T5_GUARD_MD5);
  // v53 again.
  await migrate(rdb.url, [...UP_TO_V52, V53]);
  assert.deepEqual(await catalog(r), v53, "v53 again, the same catalog");
  // LF endings.
  for (const f of [ROLLBACK, PREFLIGHT, POSTCHECK, V53_FILE]) assert.ok(!(await fsp.readFile(f, "utf8")).includes("\r"), `${path.basename(f)} has LF line endings`);
});

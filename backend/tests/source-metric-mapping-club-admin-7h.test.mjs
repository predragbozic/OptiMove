// Phase 7h - a club's admin activates, replaces and disables its club's own
// mapping versions (A1, A2), with migration v52.
// Contract: docs/ai/phase7h-club-admin-mappings-contract.md (J14), section 10.
// Through the real HTTP stack, on disposable optimove_tests_gpexe_* databases only
// (never OPTIMOVE, never a real GPEXE field or connection): one migrated through
// v51 that rehearses v52 (the preflight, the runner, the post-check, every refusal
// of the rollback, the rollback back to v51's exact catalog, and v52 again), and
// one migrated through v52 for the behaviour. Every field, variable, mapping,
// connection and binding here is a test row of this file (a connection's
// credential parts are random bytes of the right lengths: nothing is ever
// decrypted or sent).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const V52 = "202611022200_training_load_v52_club_mapping_transitions.sql";
const V52_NAME = `migrations_v2/${V52}`;
const V51_NAME = "migrations_v2/202611011900_calendar_v51_settings.sql";
const UP_TO_V51 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V52));
const V52_FILE = path.resolve(ROOT, "migrations_v2", V52);
const RUNBOOKS = path.resolve(ROOT, "docs/runbooks");
const ROLLBACK = path.join(RUNBOOKS, "club-mapping-transitions-v52-rollback.sql");
const PREFLIGHT = path.join(RUNBOOKS, "club-mapping-transitions-v52-preflight.sql");
const POSTCHECK = path.join(RUNBOOKS, "club-mapping-transitions-v52-postcheck.sql");
const RIGHTS = path.join(__dirname, "fixtures", "mapping-transition-rights-7h.json");
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const T4 = "training_load.source_metric_mapping_versions";
const T5 = "training_load.source_metric_mapping_activations";
const T8 = "training_load.source_metric_audit";
const REPLACED = ["source_metric_mapping_versions_update_guard", "source_metric_audit_row_ok", "source_metric_activations_update_guard", "source_metric_audit_actor_guard"];
const V34_COMMENT = "v34 (D6, T4): one approved, immutable way to turn one source revision into one canonical version. Created as draft only after the unit is proven; draft -> needs_review -> active -> disabled; only a platform admin activates or disables. parameter_fingerprint is computed by the database.";
const V52_COMMENT = "v34 (D6, T4): one approved, immutable way to turn one source revision into one canonical version. Created as draft only after the unit is proven; draft -> needs_review -> active -> disabled; activated or disabled by a platform admin and, for a club mapping's version, also by its club's active admin (v52, C108, J14). parameter_fingerprint is computed by the database.";
const NOT_PLATFORM_ADMIN = /^source metric mapping: the acting user is not an active platform admin$/;
const NOT_CLUB_ADMIN = /^source metric mapping: the acting user is not an active admin of the mapping's club$/;
const NOT_OWN_BASIS = /^source metric mapping: the basis is not the acting user's own$/;
const MAY_NOT_ACTIVATE = /^source metric mapping: the acting user may not activate this mapping version$/;
const MAY_NOT_DISABLE = /^source metric mapping: the acting user may not disable this mapping version$/;
const ACTOR_T5 = /^source metric activation: the acting user may not write this activation$/;
const ACTOR_T8 = /^source metric activation: the acting user may not write this audit row$/;
const OTHER_CLUB = /^source_metric_mapping_activations: a club version's activation is on another club's binding$/;
const CLUB_ROW_NAMES_CLUB = /^source_metric_audit: a club-admin row names a club mapping$/;

let rdb, db, r, k, server, apiBase, service, activations, lifecycle, dbModule, appPool, createSession;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};

async function migrate(url, files, { extra = null } = {}) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v52-migrations-"));
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
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V52), "v52 is a test migration");
  assert.ok(GPEXE_TEST_MIGRATIONS.indexOf(V52) > 0, "v52 follows v51 (v53, phase 7i-B, comes after it)");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v52rb", migrations: UP_TO_V51 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v52" }),
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
      if (process.env.V52_DEBUG) originalConsole[level](...args);
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
  service?.setMappingTransitionAuditFaultForTests(null);
  activations?.setActivationWriteHoldForTests(null);
  activations?.setActivationAuditFaultForTests(null);
  lifecycle?.setRevisionWriteHoldForTests(null);
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
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'7h test field',$2) returning id`,
    [`v52.test.f${uid()}`, W.pa.id])).id;
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: "number", parameterKind: "none", evidenceRef: COMPAT, unit: "s", unitRef: UNIT_REF, meaning: true, meaningRef: MEANING_REF, state: "active" });
  return { fieldId, revId };
}
// A mapping version of field `f` to `target`, through the real M2 routes; submitted unless `submit` is false.
async function version(f, { owner = W.pa, target, submit = true }) {
  let mappingId = (await one(k, `select id from training_load.source_metric_mappings where source_metric_definition_id = $1 and metric_definition_id = $2`, [f.fieldId, target.id]))?.id;
  if (!mappingId) {
    const m = await post("/mappings", owner.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id });
    assert.equal(m.status, 201, m.text);
    mappingId = m.body.mapping.id;
  }
  const v = await post(`/mappings/${mappingId}/versions`, owner.cookie, { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true });
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
// Raw rows for the rehearsal (triggers off for the plant only, inside a
// transaction that is rolled back): the kinds only 7h can write, and the
// club_admin rows 7d and M2 already write.
// ---------------------------------------------------------------------------
const replica = (c) => c.query("set local session_replication_role = replica");
async function rawT4(c, { status = "active", activatedBasis = null, disabledBasis = null, submittedBasis = "platform_admin" } = {}) {
  const id = crypto.randomUUID();
  const disabled = status === "disabled";
  const activated = status === "active" || Boolean(disabled && activatedBasis);
  const at = new Date().toISOString();
  await c.query(`insert into ${T4} (id, mapping_id, source_metric_definition_id, metric_definition_id, owner_key, source_metric_version_id, version_number,
                   metric_definition_version_id, conversion_kind, scale, scale_divisor, "offset", source_unit, target_unit, parameter_kind, source_parameters, canonical_parameters,
                   parameter_fingerprint, parameter_scale, parameter_scale_divisor, parameter_offset, applies_to_session, applies_to_drill, status,
                   submitted_by_user_id, submitted_at, submitted_basis, activated_by_user_id, activated_at, activated_basis,
                   disabled_by_user_id, disabled_at, disabled_basis, disable_reason, created_by_user_id)
                 values ($1,$1,$1,$1,'system',$1,1,$1,'numeric_linear',1,1,0,'s','s','none','{}','{}','',1,1,0,true,true,$2,
                   $1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$1)`,
  [id, status, at, submittedBasis,
    activated ? id : null, activated ? at : null, activated ? (activatedBasis ?? "platform_admin") : null,
    disabled ? id : null, disabled ? at : null, disabled ? disabledBasis : null, disabled ? "Raw disable." : null]);
  return id;
}
async function rawT5(c, { endedBasis = null, endReason = null } = {}) {
  const id = crypto.randomUUID();
  const ended = endedBasis !== null;
  await c.query(`insert into ${T5} (id, mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, source_team_binding_id, team_id,
                   applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason, ended_at, ended_by_user_id, ended_basis, end_reason)
                 values ($1,$1,$1,$1,$1,'',$1,$1,true,true,'required',$1,'club_admin','Raw start.',$2,$3,$4,$5)`,
  [id, ended ? new Date().toISOString() : null, ended ? id : null, endedBasis, endReason]);
  return id;
}
async function rawT8(c, { action, basis = "club_admin", from = null, to = null, reason = null, activationId = null, mapping = true }) {
  const id = activationId ?? crypto.randomUUID();
  if (["activation_start", "activation_end"].includes(action)) {
    await c.query(`insert into ${T8} (action, mapping_version_id, activation_id, team_id, reason, performed_by_user_id, basis, operation_id)
                   values ($1,$2,$2,$2,$3,$2,$4,$2)`, [action, id, reason, basis]);
  } else if (action === "mapping_create") {
    await c.query(`insert into ${T8} (action, mapping_id, performed_by_user_id, basis, operation_id) values ($1,$2,$2,$3,$2)`, [action, id, basis]);
  } else {
    await c.query(`insert into ${T8} (action, mapping_id, mapping_version_id, from_status, to_status, reason, performed_by_user_id, basis, operation_id)
                   values ($1,$2,$2,$3,$4,$5,$2,$6,$2)`, [action, id, from, to, reason, basis]);
  }
  assert.ok(mapping);
  return id;
}

// ---------------------------------------------------------------------------
// The rehearsal database (through v51).
// ---------------------------------------------------------------------------
test("1. on v51: every expected value of the read-only preflight, each hard assertion flipped by a planted row or a held lock; the rollback refuses without v52", async () => {
  const pre = await blocks(r, PREFLIGHT);
  assert.deepEqual(Object.keys(pre).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(pre[1][0].pg15_or_later, true);
  assert.deepEqual(pre[2][0], { v51_rows: "1", v51_checksum_ok: true, v52_rows: "0", at_or_after_v52: "0", last_migration: V51_NAME });
  assert.deepEqual(pre[3][0], { t4_guard_is_v34: true, row_ok_is_v48: true, actor_guard_is_v48: true, t5_guard_is_v48: true });
  assert.deepEqual(pre[4][0], { activated_check_is_v34: true, disabled_check_is_v34: true, comment_is_v34: true });
  assert.deepEqual(pre[5][0], { disabled_triggers: "0", t4_triggers: "6", t5_triggers: "5", t8_triggers: "7", basis_checks: "2", replaced_functions: "4" });
  assert.deepEqual(pre[6][0], { owns_t4: true, owns_t5: true, owns_t8: true, owned_functions: "4" });
  assert.deepEqual(pre[7][0], { actor_defaults: "0" });
  assert.deepEqual(pre[8][0], { t4_locks: "0", t5_t8_writers: "0", running_checks: "0", running_identity_loads: "0", idle_in_transaction: "0" });
  assert.deepEqual(pre[9][0], { t4_club_transitions: "0", t8_club_transitions: "0", t5_club_version_ends: "0", t8_club_version_end_rows: "0" });
  const flipped = async (plant, block) => {
    await r.query("begin");
    try {
      await plant(r);
      return (await blocks(r, PREFLIGHT))[block][0];
    } finally {
      await r.query("rollback");
    }
  };
  // Block 2: a later migration recorded.
  const b2 = await flipped((c) => c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', $1, 'test')`, ["0".repeat(64)]), 2);
  assert.equal(b2.at_or_after_v52, "1");
  // Block 3: each body replaced.
  const fake = { source_metric_mapping_versions_update_guard: "t4_guard_is_v34", source_metric_activations_update_guard: "t5_guard_is_v48", source_metric_audit_actor_guard: "actor_guard_is_v48" };
  for (const [name, column] of Object.entries(fake)) {
    const b3 = await flipped((c) => c.query(`create or replace function training_load.${name}() returns trigger as $$ begin return new; end; $$ language plpgsql`), 3);
    assert.equal(b3[column], false, name);
  }
  const b3r = await flipped((c) => c.query(`create or replace function training_load.source_metric_audit_row_ok(p_action text, p_targets text, p_from text, p_to text, p_reason text, p_evidence text, p_basis text)
                                              returns boolean language sql immutable as $$ select true $$`), 3);
  assert.equal(b3r.row_ok_is_v48, false);
  // Block 4: a widened CHECK, and another comment.
  const b4 = await flipped(async (c) => {
    await c.query(`alter table ${T4} drop constraint source_metric_mapping_versions_activated_basis_check`);
    await c.query(`alter table ${T4} add constraint source_metric_mapping_versions_activated_basis_check check (activated_basis is null or activated_basis in ('platform_admin', 'club_admin'))`);
    await c.query(`comment on table ${T4} is 'another comment'`);
  }, 4);
  assert.deepEqual(b4, { activated_check_is_v34: false, disabled_check_is_v34: true, comment_is_v34: false });
  // Block 5: a disabled trigger.
  assert.equal((await flipped((c) => c.query(`alter table ${T8} disable trigger source_metric_audit_v43_transition_facts`), 5)).disabled_triggers, "1");
  // Block 9: each kind only 7h can write. Before v52 a CHECK refuses the T4 and
  // T8 kinds even with the triggers off, so the plant drops T4's CHECK and lets
  // v48's row shape admit anything - inside the rolled-back transaction only.
  const b9 = await flipped(async (c) => {
    await replica(c);
    await c.query(`alter table ${T4} drop constraint source_metric_mapping_versions_activated_basis_check`);
    await c.query(`create or replace function training_load.source_metric_audit_row_ok(p_action text, p_targets text, p_from text, p_to text, p_reason text, p_evidence text, p_basis text)
                     returns boolean language sql immutable as $$ select true $$`);
    await rawT4(c, { activatedBasis: "club_admin" });
    await rawT8(c, { action: "mapping_status", from: "needs_review", to: "active" });
    const endedByPlatform = await rawT5(c, { endedBasis: "platform_admin", endReason: "mapping_version_disabled" });
    await rawT5(c, { endedBasis: "club_admin", endReason: "mapping_version_replaced" });
    await rawT8(c, { action: "activation_end", activationId: endedByPlatform });
  }, 9);
  assert.deepEqual(b9, { t4_club_transitions: "1", t8_club_transitions: "1", t5_club_version_ends: "1", t8_club_version_end_rows: "1" });
  // Block 8: a reader holding T4 (v52's NOWAIT fails on it), a writer holding T5, both idle in a transaction.
  const holder = await client(rdb.url);
  try {
    await holder.query("begin");
    await holder.query(`select 1 from ${T4} limit 1`);
    await holder.query(`lock table ${T5} in row exclusive mode`);
    const b8 = (await blocks(r, PREFLIGHT))[8][0];
    assert.deepEqual([b8.t4_locks, b8.t5_t8_writers, b8.idle_in_transaction], ["1", "1", "1"]);
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  assert.match((await inRolledBack(r, null, await fsp.readFile(ROLLBACK, "utf8")))?.message ?? "", /^v52 rollback refused: v52 is not recorded on this database$/);
  W.before51 = await catalog(r);
  W.v51Bodies = await bodies(r);
  assert.equal(W.before51.tables.find((x) => x.table_name === "source_metric_mapping_versions").comment, V34_COMMENT);
});

test("2. a busy T4 fails v52 at once through NOWAIT (well inside the runner's lock_timeout), nothing applied; a v52 whose last statement fails leaves nothing", async () => {
  const holder = await client(rdb.url);
  try {
    await holder.query("begin");
    await holder.query(`select 1 from ${T4} limit 1`);
    const started = Date.now();
    // 55P03: lock_not_available, the answer of NOWAIT (the runner reports the SQLSTATE).
    await assert.rejects(migrate(rdb.url, [...UP_TO_V51, V52]), /SQLSTATE 55P03/);
    assert.ok(Date.now() - started < 10_000, `failed at once (${Date.now() - started} ms)`);
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  assert.deepEqual(await catalog(r), W.before51, "nothing applied");
  const failing = `${await fsp.readFile(V52_FILE, "utf8")}\nselect 1 / 0;\n`;
  await assert.rejects(migrate(rdb.url, UP_TO_V51, { extra: { name: V52, text: failing } }));
  assert.deepEqual(await catalog(r), W.before51, "a failing v52 leaves nothing");
});

test("3. v52 through the runner on v51 - waiting for a writer of T5, then applying with no deadlock - changes exactly T4's two basis CHECKs, four bodies and T4's comment; every expected value of the post-check; the post-check names the file's sha256", async () => {
  const holder = await client(rdb.url);
  let applying;
  try {
    await holder.query("begin");
    await holder.query(`lock table ${T5} in row exclusive mode`);
    applying = migrate(rdb.url, [...UP_TO_V51, V52]);
    assert.equal(await someoneWaits(r), true, "v52 waits for the writer of T5");
    await holder.query("commit");
    await applying;
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  const after = await catalog(r);
  const before = W.before51;
  const t4Table = (x) => x.table_name === "source_metric_mapping_versions";
  assert.deepEqual(after.tables.filter((x) => !t4Table(x)), before.tables.filter((x) => !t4Table(x)), "every other table and comment unchanged");
  assert.equal(after.tables.find(t4Table).comment, V52_COMMENT);
  for (const part of ["columns", "indexes", "triggers"]) assert.deepEqual(after[part], before[part], `${part} unchanged`);
  const conKey = (x) => `${x.rel}.${x.conname}`;
  assert.deepEqual(after.constraints.map(conKey), before.constraints.map(conKey), "no constraint added or removed");
  assert.deepEqual(after.constraints.filter((x) => before.constraints.some((y) => conKey(y) === conKey(x) && y.def !== x.def)).map((x) => [x.conname, x.def, x.convalidated]), [
    ["source_metric_mapping_versions_activated_basis_check", "CHECK (((activated_basis IS NULL) OR (activated_basis = ANY (ARRAY['platform_admin'::text, 'club_admin'::text]))))", true],
    ["source_metric_mapping_versions_disabled_basis_check", "CHECK (((disabled_basis IS NULL) OR (disabled_basis = ANY (ARRAY['platform_admin'::text, 'club_admin'::text]))))", true],
  ]);
  const fnKey = (x) => `${x.nspname}.${x.proname}(${x.args})`;
  assert.deepEqual(after.functions.map(fnKey), before.functions.map(fnKey), "no function added or removed");
  assert.deepEqual(after.functions.filter((x) => !before.functions.some((y) => fnKey(y) === fnKey(x) && y.digest === x.digest)).map((x) => x.proname).sort(), [...REPLACED].sort());
  assert.deepEqual(after.migrations, [...before.migrations, V52_NAME].sort());
  const post = await blocks(r, POSTCHECK);
  assert.deepEqual(Object.keys(post).map(Number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(post[1][0], { v52_rows: "1", v52_checksum_ok: true, later_migrations: "0" });
  assert.deepEqual(post[2][0], { bodies_v52: "4" });
  assert.deepEqual(post[3][0], { activated_check_is_v52: true, disabled_check_is_v52: true, comment_is_v52: true });
  assert.deepEqual(post[4][0], { expected_enabled: "18", triggers_total: "18" });
  assert.deepEqual(post[5][0], { t4_club_transitions: "0", t8_club_transitions: "0", t5_club_version_ends: "0", t8_club_version_end_rows: "0" });
  assert.deepEqual(post[6][0], { table_locks: "0", migrator_lock: "0", idle_in_transaction: "0" });
  const sha = crypto.createHash("sha256").update(await fsp.readFile(V52_FILE)).digest("hex");
  assert.ok((await fsp.readFile(POSTCHECK, "utf8")).includes(sha), "the post-check names the v52 file's sha256");
  // The preflight on v52: blocks 2-4 say it is no longer v51.
  const pre = await blocks(r, PREFLIGHT);
  assert.equal(pre[2][0].v52_rows, "1");
  assert.deepEqual(Object.values(pre[3][0]), [false, false, false, false]);
  assert.deepEqual(Object.values(pre[4][0]), [false, false, false]);
  W.after52 = after;
  W.v52Bodies = await bodies(r);
});

test("4. the rollback refuses, changing nothing: under a later migration, on each row only 7h can write, while a v52 object is missing or a trigger is disabled, while a body in force is not v52's, and while the migrator holds its lock; the club_admin rows 7d and M2 already write never refuse it", async () => {
  const sql = await fsp.readFile(ROLLBACK, "utf8");
  const refuses = async (plant, pattern) => {
    const error = await inRolledBack(r, plant, sql);
    assert.match(error?.message ?? "", pattern);
    assert.deepEqual(await catalog(r), W.after52, `nothing changed (${pattern})`);
  };
  await refuses((c) => c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', $1, 'test')`, ["0".repeat(64)]),
    /^v52 rollback refused: later migrations are applied$/);
  const T4_KIND = /^v52 rollback refused: a mapping version was activated or disabled by a club admin$/;
  await refuses(async (c) => { await replica(c); await rawT4(c, { activatedBasis: "club_admin" }); }, T4_KIND);
  await refuses(async (c) => { await replica(c); await rawT4(c, { status: "disabled", activatedBasis: null, disabledBasis: "club_admin" }); }, T4_KIND);
  const T8_KIND = /^v52 rollback refused: a club admin's activation, disable or replacement audit row exists$/;
  await refuses(async (c) => { await replica(c); await rawT8(c, { action: "mapping_status", from: "needs_review", to: "active" }); }, T8_KIND);
  await refuses(async (c) => { await replica(c); await rawT8(c, { action: "mapping_status", from: "active", to: "disabled", reason: "Raw." }); }, T8_KIND);
  await refuses(async (c) => { await replica(c); await rawT8(c, { action: "mapping_version_replaced", from: "needs_review", to: "active", reason: "Raw." }); }, T8_KIND);
  const T5_KIND = /^v52 rollback refused: an activation was ended by a club admin's replacement or disable$/;
  await refuses(async (c) => { await replica(c); await rawT5(c, { endedBasis: "club_admin", endReason: "mapping_version_replaced" }); }, T5_KIND);
  await refuses(async (c) => { await replica(c); await rawT5(c, { endedBasis: "club_admin", endReason: "mapping_version_disabled" }); }, T5_KIND);
  await refuses(async (c) => {
    await replica(c);
    const id = await rawT5(c, { endedBasis: "platform_admin", endReason: "mapping_version_disabled" });
    await rawT8(c, { action: "activation_end", activationId: id });
  }, /^v52 rollback refused: a club admin's version-driven activation_end audit row exists$/);
  // The club_admin rows 7d and M2 already write: the rollback runs to its end
  // (its COMMIT swapped for a statement that fails, so the plant is rolled back).
  const exempt = sql.replace(/commit;\s*$/, "select 1 / 0;\n");
  assert.notEqual(exempt, sql, "the rollback ends with its COMMIT");
  const passed = await inRolledBack(r, async (c) => {
    await replica(c);
    await rawT4(c, { status: "needs_review", submittedBasis: "club_admin" });
    await rawT8(c, { action: "mapping_create" });
    await rawT8(c, { action: "mapping_version_create", to: "draft" });
    await rawT8(c, { action: "mapping_status", from: "draft", to: "needs_review" });
    await rawT8(c, { action: "activation_start", reason: "Raw start." });
    const id = await rawT5(c, { endedBasis: "club_admin", endReason: "admin_ended" });
    await rawT8(c, { action: "activation_end", activationId: id });
  }, exempt);
  assert.match(passed?.message ?? "", /^division by zero$/, "no refusal on the 7d and M2 rows");
  assert.deepEqual(await catalog(r), W.after52);
  await refuses((c) => c.query(`alter table ${T4} drop constraint source_metric_mapping_versions_disabled_basis_check`), /^v52 rollback refused: a v52 constraint is missing$/);
  await refuses((c) => c.query(`drop function training_load.source_metric_audit_row_ok(text, text, text, text, text, text, text) cascade`),
    /^v52 rollback refused: a v52 constraint is missing; a v52 function is missing; a body in force is not v52's$/);
  await refuses(async (c) => {
    await c.query(`drop trigger source_metric_activations_update_guard on ${T5}`);
    await c.query(`drop function training_load.source_metric_activations_update_guard()`);
  }, /^v52 rollback refused: a v52 function is missing; a trigger of a v52 function is missing; a body in force is not v52's$/);
  await refuses((c) => c.query(`drop trigger source_metric_audit_v35_actor_guard on ${T8}`), /^v52 rollback refused: a trigger of a v52 function is missing$/);
  await refuses((c) => c.query(`alter table ${T4} disable trigger source_metric_mapping_versions_v35_audit_link_update`), /^v52 rollback refused: a trigger on T4, T5 or T8 is disabled$/);
  for (const name of ["source_metric_mapping_versions_update_guard", "source_metric_activations_update_guard", "source_metric_audit_actor_guard"]) {
    await refuses((c) => c.query(`create or replace function training_load.${name}() returns trigger as $$ begin return new; end; $$ language plpgsql`),
      /^v52 rollback refused: a body in force is not v52's$/);
  }
  await refuses((c) => c.query(`create or replace function training_load.source_metric_audit_row_ok(p_action text, p_targets text, p_from text, p_to text, p_reason text, p_evidence text, p_basis text)
                                  returns boolean language sql immutable as $$ select true $$`), /^v52 rollback refused: a body in force is not v52's$/);
  assert.match(await fsp.readFile(path.join(ROOT, "backend", "src", "migrate.js"), "utf8"), /export const MIGRATION_LOCK_KEY = 822026n;/);
  const migrator = await client(rdb.url);
  try {
    await migrator.query("select pg_advisory_lock(822026)");
    await refuses(null, /^v52 rollback refused: the migrator is running$/);
  } finally {
    await migrator.query("select pg_advisory_unlock(822026)").catch(() => {});
    await migrator.end();
  }
});

test("5. the rollback returns v51's catalog exactly (comments included; v34's T4 guard and v48's three bodies byte for byte) and changes no row; v52 then applies again - waiting for a writer of T8 - to the same catalog", async () => {
  const before = await one(r, `select (select count(*)::int from ${T4}) as t4, (select count(*)::int from ${T5}) as t5, (select count(*)::int from ${T8}) as t8`);
  await r.query(await fsp.readFile(ROLLBACK, "utf8"));
  assert.deepEqual(await catalog(r), W.before51, "v51's catalog");
  assert.deepEqual(await bodies(r), W.v51Bodies, "the four bodies byte for byte");
  assert.equal((await one(r, `select obj_description('${T4}'::regclass, 'pg_class') as c`)).c, V34_COMMENT);
  assert.deepEqual(await one(r, `select (select count(*)::int from ${T4}) as t4, (select count(*)::int from ${T5}) as t5, (select count(*)::int from ${T8}) as t8`), before);
  const holder = await client(rdb.url);
  try {
    await holder.query("begin");
    await holder.query(`lock table ${T8} in row exclusive mode`);
    const applying = migrate(rdb.url, [...UP_TO_V51, V52]);
    assert.equal(await someoneWaits(r), true, "v52 waits for the writer of T8");
    await holder.query("commit");
    await applying;
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  assert.deepEqual(await catalog(r), W.after52, "v52 again");
  assert.deepEqual(await bodies(r), W.v52Bodies);
});

test("6. the three runbook SQL files and the migration are bound to LF by .gitattributes (git check-attr eol) and carry no CR", async () => {
  const files = [ROLLBACK, PREFLIGHT, POSTCHECK, V52_FILE].map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
  const out = execFileSync("git", ["check-attr", "eol", "--", ...files], { cwd: ROOT, encoding: "utf8" });
  for (const f of files) assert.match(out, new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: eol: lf$`, "m"), f);
  for (const f of [ROLLBACK, PREFLIGHT, POSTCHECK, V52_FILE]) assert.ok(!(await fsp.readFile(f, "utf8")).includes("\r"), `${path.basename(f)} has LF line endings`);
});

// ---------------------------------------------------------------------------
// The behaviour database (through v52).
// ---------------------------------------------------------------------------
test("7. the shared rights table (R12): for every row the real resolver's context, mayTransitionMappings and the owner filter answer the expected value, and the real A1 route agrees (200 or the identical 404)", async () => {
  const { loadAuthorizationContext } = await import("../src/authz.js");
  const access = await import("../src/sourceMetricAccess.js");
  const table = JSON.parse(await fsp.readFile(RIGHTS, "utf8"));
  assert.ok(table.rows.length >= 10);
  for (const row of table.rows) {
    const id = await user(`rights-${row.workspace}`);
    if (row.roles.platformAdmin) await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
    if (row.roles.clubAdminOfA) await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, W.clubA]);
    if (row.workspace === "platform") await workspace(id, "platform", null);
    else if (row.workspace === "clubA") await workspace(id, "club", W.clubA);
    else {
      await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, W.coachA.teamId]);
      await workspace(id, "team", W.coachA.teamId);
    }
    const authz = await loadAuthorizationContext({ id, role_hint: null });
    const ctx = await service.resolveMappingAdmin({ user: { id }, authz });
    const ownerKey = row.mappingOwner === "system" ? "system" : W.clubA;
    const allowed = Boolean(ctx && service.mayTransitionMappings(ctx) && access.ownerKeyOf(ctx) === ownerKey);
    assert.equal(allowed, row.expected, `resolver: ${row.name}`);
    const v = row.mappingOwner === "system" ? await version(await field(), { target: await variable(W.pa) }) : await clubWaiting(W.caA);
    const res = await activate(v, await cookieFor(id));
    if (row.expected) {
      ok(res);
      assert.equal((await versionRow(v.versionId)).activated_basis, row.roles.platformAdmin ? "platform_admin" : "club_admin", row.name);
    } else {
      isNotFound(res, `route: ${row.name}`);
      assert.equal(await statusOf(v), "needs_review", row.name);
    }
  }
  // The predicate itself, written out in full (J14 section 7): never "any
  // basis", never a club admin on a system scope - contexts the resolver
  // cannot build today, so only this direct check sees a widened predicate.
  const ctxOf = (basis, scope) => ({ userId: W.caA.id, basis, owner: { scope, clubId: scope === "club" ? W.clubA : null } });
  for (const [basis, scope, expected] of [
    ["platform_admin", "system", true], ["platform_admin", "club", true], ["club_admin", "club", true],
    ["club_admin", "system", false], ["team_coach", "club", false], ["team_coach", "system", false], ["athlete", "club", false], [undefined, "club", false],
  ]) assert.equal(service.mayTransitionMappings(ctxOf(basis, scope)), expected, `${basis} / ${scope}`);
  assert.equal(service.mayTransitionMappings(null), false);
  assert.equal(service.mayTransitionMappings({ userId: W.caA.id, basis: "club_admin" }), false);
});

test("8. club A's admin activates, replaces and disables club A's versions (C108): club_admin on T4, T5 and T8; a version-driven end carries the version's disable_reason; club A's second admin replaces or disables what the first admin or a platform admin activated (O4); a platform admin in club A's workspace still writes platform_admin", async () => {
  // A1 plain.
  const v1 = await clubWaiting(W.caA);
  const k1 = key();
  const a1 = ok(await activate(v1, W.caA.cookie, { requestKey: k1 }));
  assert.equal(a1.replayed, false);
  const row1 = await versionRow(v1.versionId);
  assert.deepEqual([row1.status, row1.activated_basis, row1.activated_by_user_id], ["active", "club_admin", W.caA.id]);
  const keyed1 = await keyRow(k1);
  assert.deepEqual([keyed1.action, keyed1.from_status, keyed1.to_status, keyed1.basis, keyed1.performed_by_user_id], ["mapping_status", "needs_review", "active", "club_admin", W.caA.id]);
  assert.equal(ok(await activate(v1, W.caA.cookie, { requestKey: k1 })).replayed, true);
  // A1 with listed starts on club A's bindings.
  const bX = await binding(W.clubA);
  const bY = await binding(W.clubA);
  const v2 = await clubWaiting(W.caA);
  const k2 = key();
  const a2 = ok(await activate(v2, W.caA.cookie, { requestKey: k2, starts: [bX, { bindingId: bY.bindingId, requirement: "optional" }] }));
  assert.equal(a2.activations.length, 2);
  const opened = await openOn(v2);
  assert.deepEqual(opened.map((x) => x.activated_basis), ["club_admin", "club_admin"]);
  assert.equal((await auditOf(`action = 'activation_start' and mapping_version_id = $1 and basis = 'club_admin'`, [v2.versionId])).length, 2);
  // A1's replacement by club A's second admin, keeping one team.
  const v2b = await nextVersion(v2, W.caA2);
  const reason = reasonFor("Club replacement.");
  const k3 = key();
  const rep = ok(await activate(v2b, W.caA2.cookie, { requestKey: k3, expected: v2.versionId, reason, starts: [bX] }));
  assert.deepEqual([rep.replaced, rep.activationsEnded, rep.activations.length], [v2.versionId, 2, 1]);
  const old = await versionRow(v2.versionId);
  assert.deepEqual([old.status, old.disabled_basis, old.disabled_by_user_id, old.disable_reason], ["disabled", "club_admin", W.caA2.id, reason]);
  assert.equal((await versionRow(v2b.versionId)).activated_basis, "club_admin");
  const ends = await rows(k, `select * from ${T5} where mapping_version_id = $1 order by id`, [v2.versionId]);
  assert.deepEqual(ends.map((x) => [x.ended_basis, x.end_reason, x.ended_by_user_id]), ends.map(() => ["club_admin", "mapping_version_replaced", W.caA2.id]));
  const endRows = await auditOf(`action = 'activation_end' and mapping_version_id = $1`, [v2.versionId]);
  assert.deepEqual(endRows.map((x) => [x.basis, x.reason]), endRows.map(() => ["club_admin", reason]));
  assert.equal(endRows.length, 2);
  const replacedRow = await keyRow(k3);
  assert.deepEqual([replacedRow.action, replacedRow.basis], ["mapping_version_replaced", "club_admin"]);
  assert.equal((await auditOf(`action = 'mapping_status' and mapping_version_id = $1 and to_status = 'disabled' and basis = 'club_admin'`, [v2.versionId])).length, 1);
  assert.deepEqual((await openOn(v2b)).map((x) => [x.source_team_binding_id, x.activated_basis]), [[bX.bindingId, "club_admin"]]);
  // A2 by club A's second admin of a version a platform admin activated, with open activations.
  const v3 = await clubWaiting(W.caA);
  ok(await activate(v3, W.paA.cookie, { starts: [await binding(W.clubA)] }));
  assert.equal((await versionRow(v3.versionId)).activated_basis, "platform_admin", "a platform admin in club A's workspace writes platform_admin");
  const dReason = reasonFor("Club disable.");
  const dis = ok(await disable(v3, W.caA2.cookie, { reason: dReason }));
  assert.equal(dis.activationsEnded, 1);
  const v3row = await versionRow(v3.versionId);
  assert.deepEqual([v3row.status, v3row.disabled_basis, v3row.disable_reason], ["disabled", "club_admin", dReason]);
  const v3ends = await rows(k, `select * from ${T5} where mapping_version_id = $1`, [v3.versionId]);
  assert.deepEqual(v3ends.map((x) => [x.ended_basis, x.end_reason]), [["club_admin", "mapping_version_disabled"]]);
  assert.deepEqual((await auditOf(`action = 'activation_end' and mapping_version_id = $1`, [v3.versionId])).map((x) => [x.basis, x.reason]), [["club_admin", dReason]]);
  // A2 of a draft and of a waiting version.
  const draft = await version(await field(), { owner: W.caA, target: await variable(W.caA), submit: false });
  ok(await disable(draft, W.caA.cookie, { expectedStatus: "draft" }));
  const waiting = await clubWaiting(W.caA);
  ok(await disable(waiting, W.caA.cookie, { expectedStatus: "needs_review" }));
  for (const v of [draft, waiting]) assert.deepEqual([await statusOf(v), (await versionRow(v.versionId)).disabled_basis], ["disabled", "club_admin"]);
  // The answers never carry an acting user or a reason.
  for (const body of [a1, a2, rep, dis]) {
    const text = JSON.stringify(body);
    for (const who of [W.caA, W.caA2]) assert.ok(!text.includes(who.id), "no acting user id");
    assert.ok(!text.includes(reason) && !text.includes(dReason), "no reason");
  }
});

test("9. the identical 404 (section 3): club A's admin on a missing id, a system version, club B's version and with a listed club B binding - each the same status, body and headers, nothing written, the key left free; every other actor on club A's version - the identical 404 (401 without a session or for an inactive user)", async () => {
  const own = await clubWaiting(W.caA);
  const sys = await version(await field(), { target: await variable(W.pa) });
  const clubB = await clubWaiting(W.caB);
  const own2 = await clubWaiting(W.caA);
  const freeKey = key();
  // Club C archived: its admin's workspace writes nothing, and its own version is the identical 404.
  await setClubActive(W.clubC, false);
  try {
    const clubC = await clubWaiting(W.caC).catch(() => null);
    assert.equal(clubC, null, "club C's archived workspace writes nothing");
  } finally {
    await setClubActive(W.clubC, true);
    await workspace(W.caC.id, "club", W.clubC);
  }
  const clubCv = await clubWaiting(W.caC);
  await setClubActive(W.clubC, false);
  try {
    isNotFound(await activate(clubCv, W.caC.cookie, { requestKey: freeKey }), "club C archived");
  } finally {
    await setClubActive(W.clubC, true);
    await workspace(W.caC.id, "club", W.clubC);
  }
  const before = await counts();
  const shapes = [
    notFoundShape(await activate({ mappingId: key(), versionId: key() }, W.caA.cookie, { requestKey: freeKey })),
    notFoundShape(await activate(sys, W.caA.cookie, { requestKey: freeKey })),
    notFoundShape(await activate(clubB, W.caA.cookie, { requestKey: freeKey })),
    // A mismatched pair: club A's own mapping with a version of another mapping.
    notFoundShape(await activate({ mappingId: own.mappingId, versionId: sys.versionId }, W.caA.cookie, { requestKey: freeKey })),
    notFoundShape(await activate({ mappingId: own.mappingId, versionId: clubB.versionId }, W.caA.cookie, { requestKey: freeKey })),
    notFoundShape(await activate({ mappingId: own.mappingId, versionId: own2.versionId }, W.caA.cookie, { requestKey: freeKey })),
    notFoundShape(await activate(own, W.caA.cookie, { requestKey: freeKey, starts: [W.bB1] })),
    notFoundShape(await disable(sys, W.caA.cookie, { expectedStatus: "needs_review", requestKey: freeKey })),
    notFoundShape(await disable(clubB, W.caA.cookie, { expectedStatus: "needs_review", requestKey: freeKey })),
  ];
  for (const shape of shapes) assert.deepEqual(shape, shapes[0]);
  assert.deepEqual(shapes[0], { status: 404, body: { error: "notFound" }, cache: "no-store", retryAfter: null });
  // A club version's activation on a binding whose connection is not club-owned.
  isNotFound(await activate(own, W.caA.cookie, { requestKey: freeKey, starts: [await teamOwnedBinding(W.clubA)] }), "a binding with no club");
  assert.deepEqual(await counts(), before, "nothing written");
  assert.equal(await keyRow(freeKey), undefined, "the key is free");
  // Every other actor on club A's waiting version (and its disable).
  await workspace(W.pa3.id, "platform", null);
  const others = [
    ["a platform admin in the platform workspace", W.pa], ["a platform admin in club B's workspace", W.paB], ["club B's admin", W.caB],
    ["an admin of A and B in B's workspace", W.caAB], ["club A's admin in a team workspace", W.caATeam], ["club A's admin with a revoked role", W.caARevoked],
    ["a coach", W.coachA], ["an athlete", W.athlete], ["a private coach", W.privateCoach], ["a user with no role", W.plain],
    ["a platform admin in a team workspace", W.paTeam], ["a revoked platform admin", W.paRevoked],
    ["a user who holds both roles, in the platform workspace", W.pa3],
  ];
  for (const [label, who] of others) {
    assert.deepEqual(notFoundShape(await activate(own, who.cookie, { requestKey: freeKey })), shapes[0], `activate: ${label}`);
    assert.deepEqual(notFoundShape(await disable(own, who.cookie, { expectedStatus: "needs_review", requestKey: freeKey })), shapes[0], `disable: ${label}`);
  }
  assert.equal((await activate(own, null, { requestKey: freeKey })).status, 401, "no session");
  const inactive = await clubAdmin(W.clubA);
  await setUserActive(inactive.id, false);
  assert.equal((await activate(own, inactive.cookie, { requestKey: freeKey })).status, 401, "an inactive user");
  assert.deepEqual(await counts(), before, "nothing written by any of them");
  assert.equal(await keyRow(freeKey), undefined, "the key is still free");
  // The key works for club A's admin afterwards.
  ok(await activate(own, W.caA.cookie, { requestKey: freeKey }));
  assert.equal((await keyRow(freeKey)).basis, "club_admin");
});

test("10. club A's admin on the platform-only routes (unit and meaning, L1-L5, conversions, source instances) gets the identical 404, as before 7h", async () => {
  const f = await field();
  const paths = [
    ["POST", `/fields/${f.fieldId}/revisions/${f.revId}/unit-verification`, { requestKey: key(), unit: "s", evidenceRef: UNIT_REF }],
    ["POST", `/fields/${f.fieldId}/revisions/${f.revId}/meaning-verification`, { requestKey: key(), evidenceRef: MEANING_REF }],
    ["POST", `/fields/${f.fieldId}/revisions`, { requestKey: key() }],
    ["POST", `/fields/${f.fieldId}/revisions/${f.revId}/retire`, { requestKey: key(), expectedState: "active", reason: "x" }],
    ["POST", `/fields/${f.fieldId}/revisions/${f.revId}/activate`, { requestKey: key() }],
    ["POST", `/fields/${f.fieldId}/revisions/${f.revId}/replace`, { requestKey: key() }],
    ["POST", "/conversions", { requestKey: key() }],
    ["POST", `/conversions/${key()}/retire`, { requestKey: key() }],
    ["GET", "/source-instances", undefined],
    ["POST", `/source-instances/${key()}/end`, { requestKey: key() }],
  ];
  for (const [method, p, body] of paths) {
    isNotFound(await api(p, { method, cookie: W.caA.cookie, body }), `${method} ${p}`);
  }
});

test("11. replays: club A's admin replays its own A1, replacement and A2 (200 replayed); the same key from another workspace (the A+B admin in club B's) and after the role was revoked is the identical 404", async () => {
  await workspace(W.caAB.id, "club", W.clubA);
  const kA = key();
  let v;
  try {
    v = await clubWaiting(W.caAB);
    ok(await activate(v, W.caAB.cookie, { requestKey: kA }));
    assert.equal(ok(await activate(v, W.caAB.cookie, { requestKey: kA })).replayed, true);
  } finally {
    await workspace(W.caAB.id, "club", W.clubB);
  }
  isNotFound(await activate(v, W.caAB.cookie, { requestKey: kA }), "a replay from club B's workspace");
  const next = await nextVersion(v, W.caA2);
  const kR = key();
  const rReason = reasonFor("Replace.");
  ok(await activate(next, W.caA2.cookie, { requestKey: kR, expected: v.versionId, reason: rReason }));
  assert.equal(ok(await activate(next, W.caA2.cookie, { requestKey: kR, expected: v.versionId, reason: rReason })).replayed, true);
  const kD = key();
  const dReason = reasonFor("Disable.");
  ok(await disable(next, W.caA2.cookie, { requestKey: kD, reason: dReason }));
  assert.equal(ok(await disable(next, W.caA2.cookie, { requestKey: kD, reason: dReason })).replayed, true);
  await setClubRole(W.caA2.id, W.clubA, false);
  try {
    isNotFound(await disable(next, W.caA2.cookie, { requestKey: kD, reason: dReason }), "a replay after the role was revoked");
    isNotFound(await activate(next, W.caA2.cookie, { requestKey: kR, expected: v.versionId, reason: rReason }), "a replacement's replay after the role was revoked");
  } finally {
    await setClubRole(W.caA2.id, W.clubA, true);
  }
});

// ---------------------------------------------------------------------------
// Direct SQL (section 10.3): each case asserts the SQLSTATE, the fixed text and
// which guard fires first.
// ---------------------------------------------------------------------------
const G1_REPLACED = /^source_metric_audit: a replacement records the disable of the version it replaces in its own operation$/;
const G2_REASON = /^source_metric_audit: a disable row carries its version's disable reason$/;
const okTx = (res) => { assert.equal(res.ok, true, res.error ? `${res.error.code}: ${res.error.message}` : ""); return res.value; };
const activateSql = (c, v, by, basis) => c.query(`update ${T4} set status = 'active', activated_by_user_id = $2, activated_at = clock_timestamp(), activated_basis = $3 where id = $1`, [v.versionId, by, basis]);
const disableSql = (c, v, by, basis, reason = "R") => c.query(`update ${T4} set status = 'disabled', disabled_by_user_id = $2, disabled_at = clock_timestamp(), disabled_basis = $3, disable_reason = $4 where id = $1`, [v.versionId, by, basis, reason]);
const statusRowSql = (c, { action = "mapping_status", v, from, to, reason = null, by, basis, op = crypto.randomUUID() }) => c.query(
  `insert into ${T8} (action, mapping_id, mapping_version_id, from_status, to_status, reason, performed_by_user_id, basis, operation_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [action, v.mappingId, v.versionId, from, to, reason, by, basis, op]);
const endSql = (c, ids, by, basis, endReason) => c.query(`update ${T5} set ended_at = now(), ended_by_user_id = $2, ended_basis = $3, end_reason = $4 where id = any($1::uuid[])`, [ids, by, basis, endReason]);
const endRowSql = (c, a, by, basis, reason, op = crypto.randomUUID()) => c.query(
  `insert into ${T8} (action, mapping_version_id, activation_id, team_id, reason, performed_by_user_id, basis, operation_id) values ('activation_end',$1,$2,$3,$4,$5,$6,$7)`,
  [a.mapping_version_id, a.id, a.team_id, reason, by, basis, op]);
// One open activation of version v on binding b, written with triggers off (a
// fixture of a state the routes cannot build: a disposable database only).
async function plantActivation(v, b) {
  const row = await versionRow(v.versionId);
  await k.query("begin");
  try {
    await k.query("set local session_replication_role = replica");
    const id = (await one(k, `insert into ${T5} (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint,
                                 source_team_binding_id, team_id, applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
                               values ($1,$2,$3,$4,$5,$6,$7,true,true,'required',$8,'platform_admin','Planted.') returning id`,
    [v.versionId, v.mappingId, row.source_metric_definition_id, row.metric_definition_id, row.parameter_fingerprint, b.bindingId, b.teamId, W.pa.id])).id;
    await k.query("commit");
    return t5(id);
  } catch (error) {
    await k.query("rollback").catch(() => {});
    throw error;
  }
}

test("12. direct SQL against v52 (section 10.3): club A's admin activates, disables and replaces club A's version; a wrong basis at each layer; a system version; another club's admin; an archived club, a revoked role, an inactive user, a coach and an athlete; version-driven ends (own club, a system version, club B's); the R3 backstop in the T5 and the T8 guard; v43's G1 and G2 with club_admin rows; the J18 chain in one transaction; a club-role revocation against a club admin's activation, both orders", async () => {
  // 1. Activate, disable and replace, with the T8 rows.
  const v1 = await clubWaiting(W.caA);
  okTx(await tx(W.caA.id, async (c) => { await activateSql(c, v1, W.caA.id, "club_admin"); await statusRowSql(c, { v: v1, from: "needs_review", to: "active", by: W.caA.id, basis: "club_admin" }); }));
  okTx(await tx(W.caA.id, async (c) => { await disableSql(c, v1, W.caA.id, "club_admin", "R1"); await statusRowSql(c, { v: v1, from: "active", to: "disabled", reason: "R1", by: W.caA.id, basis: "club_admin" }); }));
  const n = await clubActive(W.caA);
  const n1 = await nextVersion(n);
  okTx(await tx(W.caA.id, async (c) => {
    const op = crypto.randomUUID();
    await disableSql(c, n, W.caA.id, "club_admin", "Replaced.");
    await activateSql(c, n1, W.caA.id, "club_admin");
    await statusRowSql(c, { v: n, from: "active", to: "disabled", reason: "Replaced.", by: W.caA.id, basis: "club_admin", op });
    await statusRowSql(c, { action: "mapping_version_replaced", v: n1, from: "needs_review", to: "active", reason: "Replaced.", by: W.caA.id, basis: "club_admin", op });
  }));
  assert.deepEqual([await statusOf(v1), await statusOf(n), await statusOf(n1)], ["disabled", "disabled", "active"]);
  // 2. A wrong basis, each at the layer that fires first.
  const w = await clubWaiting(W.caA);
  refusedWith(await tx(W.caA.id, (c) => activateSql(c, w, W.caA.id, "platform_admin")), "42501", NOT_PLATFORM_ADMIN);
  refusedWith(await tx(W.paA.id, (c) => activateSql(c, w, W.paA.id, "club_admin")), "42501", NOT_OWN_BASIS);
  refusedWith(await tx(W.caA.id, async (c) => { await activateSql(c, w, W.caA.id, "club_admin"); await statusRowSql(c, { v: w, from: "needs_review", to: "active", by: W.caA.id, basis: "platform_admin" }); }), "42501", NOT_OWN_BASIS);
  // 3. A system version.
  const sysW = await version(await field(), { target: await variable(W.pa) });
  refusedWith(await tx(W.caA.id, (c) => activateSql(c, sysW, W.caA.id, "club_admin")), "42501", MAY_NOT_ACTIVATE);
  const sysA = await sysVersion();
  refusedWith(await tx(W.caA.id, (c) => disableSql(c, sysA, W.caA.id, "club_admin")), "42501", MAY_NOT_DISABLE);
  refusedWith(await tx(W.caA.id, (c) => statusRowSql(c, { v: sysW, from: "needs_review", to: "active", by: W.caA.id, basis: "club_admin" })), "23514", CLUB_ROW_NAMES_CLUB);
  // 4. Club B's admin on club A's version.
  refusedWith(await tx(W.caB.id, (c) => activateSql(c, w, W.caB.id, "club_admin")), "42501", NOT_CLUB_ADMIN);
  refusedWith(await tx(W.caB.id, (c) => disableSql(c, n1, W.caB.id, "club_admin")), "42501", NOT_CLUB_ADMIN);
  // 5. An archived club, a revoked role, an inactive user, a coach, an athlete.
  const cv = await clubWaiting(W.caC);
  await setClubActive(W.clubC, false);
  try {
    refusedWith(await tx(W.caC.id, (c) => activateSql(c, cv, W.caC.id, "club_admin")), "42501", NOT_CLUB_ADMIN);
  } finally {
    await setClubActive(W.clubC, true);
    await workspace(W.caC.id, "club", W.clubC);
  }
  const inactive = await clubAdmin(W.clubA);
  await setUserActive(inactive.id, false);
  for (const [label, who] of [["a revoked role", W.caARevoked.id], ["an inactive user", inactive.id], ["a coach", W.coachA.id], ["an athlete", W.athlete.id]]) {
    refusedWith(await tx(who, (c) => activateSql(c, w, who, "club_admin")), "42501", NOT_CLUB_ADMIN);
    assert.equal(await statusOf(w), "needs_review", label);
  }
  // 6. Version-driven ends by club A's admin: its own version inside its own disable;
  // a system version's activation; club B's version's activation.
  const own = await clubActive(W.caA);
  const ownStart = ok(await start(W.caA, own, [await binding(W.clubA)]), 201).activations[0];
  okTx(await tx(W.caA.id, async (c) => {
    const op = crypto.randomUUID();
    const a = await t5(ownStart.id);
    await endSql(c, [a.id], W.caA.id, "club_admin", "mapping_version_disabled");
    await disableSql(c, own, W.caA.id, "club_admin", "Own disable.");
    await endRowSql(c, a, W.caA.id, "club_admin", "Own disable.", op);
    await statusRowSql(c, { v: own, from: "active", to: "disabled", reason: "Own disable.", by: W.caA.id, basis: "club_admin", op });
  }));
  assert.deepEqual([(await t5(ownStart.id)).ended_basis, (await t5(ownStart.id)).end_reason], ["club_admin", "mapping_version_disabled"]);
  const sysStart = ok(await start(W.pa, sysA, [await binding(W.clubA)]), 201).activations[0];
  refusedWith(await tx(W.caA.id, (c) => endSql(c, [sysStart.id], W.caA.id, "club_admin", "mapping_version_disabled")), "42501", ACTOR_T5);
  const bVer = await clubActive(W.caB);
  const bStart = ok(await start(W.caB, bVer, [W.bB1]), 201).activations[0];
  refusedWith(await tx(W.caA.id, (c) => endSql(c, [bStart.id], W.caA.id, "club_admin", "mapping_version_disabled")), "42501", ACTOR_T5);
  // 6b. The T8 actor guard on its own (the T5 end written with the guard off, in
  // the same transaction): club A's admin's version-driven activation_end row for
  // a system version's activation and for club B's version's activation - 42501.
  for (const [label, act] of [["a system version", sysStart], ["club B's version", bStart]]) {
    const row = await t5(act.id);
    refusedWith(await tx(W.caA.id, async (c) => {
      await c.query("set local session_replication_role = replica");
      await endSql(c, [row.id], W.caA.id, "club_admin", "mapping_version_disabled");
      await c.query("set local session_replication_role = origin");
      await endRowSql(c, row, W.caA.id, "club_admin", "T8 only.");
    }), "42501", ACTOR_T8);
    assert.equal((await t5(act.id)).ended_at, null, label);
  }
  // 7. The R3 backstop: a club A version's activation on club B's binding, and on a
  // binding whose connection is not club-owned - in the T5 guard and the T8 guard.
  // On a binding with no club, v48's insert guard refuses a club_admin
  // activation row first (its own 23514); the T8 actor guard's backstop is
  // reached there by a row naming another basis, which that branch skips.
  for (const [label, b, rowBasis] of [["club B's binding", await binding(W.clubB), "club_admin"], ["a binding with no club", await teamOwnedBinding(W.clubA), "platform_admin"]]) {
    const v = await clubActive(W.caA);
    const planted = await plantActivation(v, b);
    refusedWith(await tx(W.caA.id, (c) => endSql(c, [planted.id], W.caA.id, "club_admin", "mapping_version_disabled")), "23514", OTHER_CLUB);
    const t8Backstop = (basis) => tx(W.caA.id, async (c) => {
      await c.query("set local session_replication_role = replica");
      await endSql(c, [planted.id], W.caA.id, "club_admin", "mapping_version_disabled");
      await c.query("set local session_replication_role = origin");
      await disableSql(c, v, W.caA.id, "club_admin", "Backstop.");
      await endRowSql(c, planted, W.caA.id, basis, "Backstop.");
    });
    refusedWith(await t8Backstop(rowBasis), "23514", OTHER_CLUB);
    if (rowBasis !== "club_admin") refusedWith(await t8Backstop("club_admin"), "23514", /^source_metric_audit: a club-admin activation row names an activation on a club's binding$/);
    assert.equal((await t5(planted.id)).ended_at, null, label);
    // A platform admin ends it (whatever the club's state).
    okTx(await tx(W.pa.id, async (c) => {
      const op = crypto.randomUUID();
      await endSql(c, [planted.id], W.pa.id, "platform_admin", "mapping_version_disabled");
      await disableSql(c, v, W.pa.id, "platform_admin", "Platform ends it.");
      await endRowSql(c, planted, W.pa.id, "platform_admin", "Platform ends it.", op);
      await statusRowSql(c, { v, from: "active", to: "disabled", reason: "Platform ends it.", by: W.pa.id, basis: "platform_admin", op });
    }));
  }
  // 8. v43's G1 and G2 with club_admin rows (as 7b test 16).
  const g = await clubActive(W.caA);
  const g1 = await nextVersion(g);
  refusedWith(await tx(W.caA.id, async (c) => {
    const lone = g1;
    await disableSql(c, g, W.caA.id, "club_admin", "R");
    await activateSql(c, lone, W.caA.id, "club_admin");
    await statusRowSql(c, { v: g, from: "active", to: "disabled", reason: "R", by: W.caA.id, basis: "club_admin" });
    await statusRowSql(c, { action: "mapping_version_replaced", v: lone, from: "needs_review", to: "active", reason: "R", by: W.caA.id, basis: "club_admin" });
  }), "23514", G1_REPLACED);
  refusedWith(await tx(W.caA.id, async (c) => {
    await disableSql(c, g, W.caA.id, "club_admin", "Stored reason.");
    await statusRowSql(c, { v: g, from: "active", to: "disabled", reason: "Audited reason.", by: W.caA.id, basis: "club_admin" });
  }), "23514", G2_REASON);
  assert.deepEqual([await statusOf(g), await statusOf(g1)], ["active", "needs_review"]);
  // 9. The J18 chain (section 9): T3, T4, submit and activate in one transaction, committed.
  const template = await clubWaiting(W.caA);
  const f2 = await field();
  const chain = okTx(await tx(W.caA.id, async (c) => {
    const m = (await one(c, `insert into training_load.source_metric_mappings (source_metric_definition_id, source_system, api_family, metric_definition_id, owner_scope, owner_club_id, created_by_user_id)
                             select d.id, d.source_system, d.api_family, $2, 'club', $3, $4 from training_load.source_metric_definitions d where d.id = $1 returning id`,
    [f2.fieldId, template.target.id, W.clubA, W.caA.id])).id;
    await c.query(`insert into ${T8} (action, mapping_id, performed_by_user_id, basis, operation_id) values ('mapping_create',$1,$2,'club_admin',$3)`, [m, W.caA.id, crypto.randomUUID()]);
    const vId = (await one(c, `insert into ${T4} (mapping_id, source_metric_definition_id, metric_definition_id, source_metric_version_id, version_number, metric_definition_version_id,
                                  conversion_kind, scale, scale_divisor, "offset", source_unit, target_unit, conversion_note, parameter_kind, source_parameters, canonical_parameters,
                                  parameter_scale, parameter_scale_divisor, parameter_offset, applies_to_session, applies_to_drill, created_by_user_id)
                                select $1, $2, metric_definition_id, $3, 1, metric_definition_version_id, conversion_kind, scale, scale_divisor, "offset", source_unit, target_unit,
                                       conversion_note, parameter_kind, source_parameters, canonical_parameters, parameter_scale, parameter_scale_divisor, parameter_offset,
                                       applies_to_session, applies_to_drill, $4
                                  from ${T4} where id = $5 returning id`, [m, f2.fieldId, f2.revId, W.caA.id, template.versionId])).id;
    const v = { mappingId: m, versionId: vId };
    await statusRowSql(c, { action: "mapping_version_create", v, from: null, to: "draft", by: W.caA.id, basis: "club_admin" });
    await c.query(`update ${T4} set status = 'needs_review', submitted_by_user_id = $2, submitted_at = clock_timestamp(), submitted_basis = 'club_admin' where id = $1`, [vId, W.caA.id]);
    await statusRowSql(c, { v, from: "draft", to: "needs_review", by: W.caA.id, basis: "club_admin" });
    await activateSql(c, v, W.caA.id, "club_admin");
    await statusRowSql(c, { v, from: "needs_review", to: "active", by: W.caA.id, basis: "club_admin" });
    return v;
  }));
  assert.equal(await statusOf(chain), "active", "the J18 chain committed under v35's deferred links and v43's G1 and G2");
  // T4's two basis CHECKs on their own (the guard off, for this statement only):
  // any other text is a check violation, so the guard never masks a widened CHECK.
  const cw = await clubWaiting(W.caA);
  for (const [constraint, sql] of [
    ["source_metric_mapping_versions_activated_basis_check", `update ${T4} set status = 'active', activated_by_user_id = $2, activated_at = clock_timestamp(), activated_basis = 'bogus' where id = $1`],
    ["source_metric_mapping_versions_disabled_basis_check", `update ${T4} set status = 'disabled', disabled_by_user_id = $2, disabled_at = clock_timestamp(), disabled_basis = 'bogus', disable_reason = 'R' where id = $1`],
  ]) {
    const res = await tx(W.caA.id, async (c) => { await c.query("set local session_replication_role = replica"); await c.query(sql, [cw.versionId, W.caA.id]); });
    assert.equal(res.ok, false, constraint);
    assert.deepEqual([res.error.code, res.error.constraint], ["23514", constraint]);
  }
  assert.equal(await statusOf(cw), "needs_review");
  // 10. A club-role revocation against a club admin's T4 activation, both orders (v35 test 9).
  const a = await client();
  const b = await client();
  try {
    // Each pid read before its client sends a statement that waits: a query
    // sent after it would queue behind it on the same client.
    const aPid = (await one(a, `select pg_backend_pid() as pid`)).pid;
    const bPid = (await one(b, `select pg_backend_pid() as pid`)).pid;
    const waits = async (pid) => {
      for (let i = 0; i < 250; i += 1) {
        if ((await one(k, `select count(*)::int as n from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [pid])).n > 0) return true;
        await new Promise((res) => setTimeout(res, 20));
      }
      return false;
    };
    // (a) the write first: the revocation waits for the activation's FOR SHARE.
    const caX = await clubAdmin(W.clubA);
    const vx = await clubWaiting(caX);
    await a.query("begin");
    await a.query(CTX, [caX.id]);
    await activateSql(a, vx, caX.id, "club_admin");
    const revoking = b.query(`update public.user_club_roles set is_active = false where user_id = $1`, [caX.id]);
    assert.equal(await waits(bPid), true, "the revocation waits for the write");
    await statusRowSql(a, { v: vx, from: "needs_review", to: "active", by: caX.id, basis: "club_admin" });
    await a.query("commit");
    await revoking;
    assert.equal(await statusOf(vx), "active");
    // (b) the revocation first: the write waits, then 42501.
    const caY = await clubAdmin(W.clubA);
    const vy = await clubWaiting(caY);
    await b.query("begin");
    await b.query(`update public.user_club_roles set is_active = false where user_id = $1`, [caY.id]);
    const writing = tx(caY.id, (c) => activateSql(c, vy, caY.id, "club_admin"), a);
    assert.equal(await waits(aPid), true, "the write's guard waits for the revocation");
    await b.query("commit");
    refusedWith(await writing, "42501", NOT_CLUB_ADMIN);
    assert.equal(await statusOf(vy), "needs_review");
  } finally {
    await b.query("rollback").catch(() => {});
    await a.end().catch(() => {});
    await b.end().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Races (section 10.4): each with no 40P01 in the log lines, the second
// request by another user, waits on rows (never on an advisory lock).
// ---------------------------------------------------------------------------
// A fresh club with `admins` active admins and one binding (the archive cases
// archive it; the shared world stays as it is).
async function freshClub(admins = 2) {
  const clubId = await club("Club X");
  const list = [];
  for (let i = 0; i < admins; i += 1) list.push(await clubAdmin(clubId));
  return { clubId, admins: list, b: await binding(clubId) };
}
const retireRevision = (f, cookie, { expectedState = "active", reason = reasonFor("Retire.") } = {}) =>
  post(`/fields/${f.fieldId}/revisions/${f.revId}/retire`, cookie, { requestKey: key(), expectedState, reason });
async function peerHolds(sql, params) {
  const peer = await client();
  await peer.query("begin");
  await peer.query(sql, params);
  return peer;
}
async function release(peer, how = "commit") {
  await peer.query(how).catch(() => {});
  await peer.end().catch(() => {});
}

test("13. races: two A1 of one mapping (club A's two admins), a club admin's replacement against a platform admin's A2, a club admin's A2 against another admin's S2 on the same activation, A1 and A2 against the pinned step (both orders), A1 with starts against an Unbind, a team archive and a club archive (both orders), A2 against a club archive (both orders) - no 40P01", async () => {
  // Two A1 of one mapping: the second waits at T3, then active_version_changed.
  const v1 = await clubWaiting(W.caA);
  const v2 = await nextVersion(v1, W.caA2);
  let hold = holdWrite("mapping_version_activate");
  const first = activate(v1, W.caA.cookie);
  await until(() => hold.state.entered, "the first A1 holds");
  const second = activate(v2, W.caA2.cookie);
  await rowWait("the second A1 waits at T3", ["training_load.source_metric_mappings"]);
  hold.g.open();
  ok(await first);
  const lost = refused(await second, 409, "active_version_changed");
  assert.equal(lost.current.activeVersionId, v1.versionId);
  // A club admin's replacement against a platform admin's A2 of the replaced version.
  const n1 = await nextVersion(v1, W.caA);
  hold = holdWrite("mapping_version_replace");
  const replacing = activate(n1, W.caA.cookie, { expected: v1.versionId, reason: reasonFor("Replace.") });
  await until(() => hold.state.entered, "the replacement holds");
  const disabling = disable(v1, W.paA.cookie);
  await rowWait("the A2 waits at T3", ["training_load.source_metric_mappings"]);
  hold.g.open();
  ok(await replacing);
  assert.equal(refused(await disabling, 409, "version_status_changed").current.status, "disabled");
  // A club admin's A2 against another admin's S2 on the same activation.
  const s = await clubActive(W.caA);
  const act = ok(await start(W.caA, s, [await binding(W.clubA)]), 201).activations[0];
  hold = holdWrite("mapping_version_disable");
  const dis = disable(s, W.caA.cookie);
  await until(() => hold.state.entered, "the A2 holds");
  const ending = end(W.caA2, act.id);
  await rowWait("the S2 waits at T3, the mapping row A2 holds", ["training_load.source_metric_mappings"]);
  hold.g.open();
  assert.equal(ok(await dis).activationsEnded, 1);
  refused(await ending, 409, "activation_not_open");
  assert.equal((await t5(act.id)).end_reason, "mapping_version_disabled");
  // A2 against the pinned step: A2 first, then the retirement finds nothing to disable.
  const pf = await field();
  const pv = await version(pf, { owner: W.caA, target: await variable(W.caA) });
  ok(await activate(pv, W.caA.cookie));
  hold = holdWrite("mapping_version_disable");
  const pinnedDisable = disable(pv, W.caA.cookie);
  await until(() => hold.state.entered, "the A2 holds");
  const retiring = retireRevision(pf, W.pa.cookie);
  await rowWait("the pinned step waits at the revision", ["training_load.source_metric_definition_versions"]);
  hold.g.open();
  ok(await pinnedDisable);
  ok(await retiring);
  assert.equal((await versionRow(pv.versionId)).disabled_basis, "club_admin", "the club admin's disable stands");
  // The pinned step first, then A1 of a waiting version of the pinned revision.
  const qf = await field();
  const qv = await version(qf, { owner: W.caA, target: await variable(W.caA) });
  const lc = gate();
  const lcState = { entered: false };
  lifecycle.setRevisionWriteHoldForTests(async () => { if (lcState.entered) return; lcState.entered = true; await lc.promise; });
  const retiringFirst = retireRevision(qf, W.pa.cookie);
  await until(() => lcState.entered, "the pinned step holds");
  const late = activate(qv, W.caA.cookie);
  await rowWait("A1 waits for the pinned step at the revision", ["training_load.source_metric_definition_versions"]);
  lc.open();
  ok(await retiringFirst);
  const lateRes = await late;
  assert.deepEqual([lateRes.status, lateRes.body.error], [409, "version_not_submitted"], lateRes.text);
  assert.equal(await statusOf(qv), "disabled", "the pinned step disabled the waiting version");
  // A1 with starts against an Unbind, a team archive and a club archive.
  for (const kind of ["unbind", "team", "club"]) {
    const x = await freshClub();
    const [adm] = x.admins;
    const xv = await clubWaiting(adm);
    // (a) A1 holds after its right; the peer's change comes then. In D's order
    // (J15 section 5, the lock-order pull request LO-1) A1 has already locked
    // the listed binding and its team FOR SHARE, and the club row with its
    // right, so the Unbind waits on the binding row, the team archive on the
    // team row and the club archive on the club row. A1 commits first and
    // answers 200 - or, for the club archive only, when the archive lands
    // before A1's answer re-checks the right after the COMMIT, the identical
    // 404 (section 3) - and the peer's change lands after it.
    hold = holdWrite("mapping_version_activate");
    const a1 = activate(xv, adm.cookie, { starts: [x.b] });
    await until(() => hold.state.entered, "A1 holds");
    const peer = await client();
    const changing = kind === "unbind" ? unbind(x.b, peer)
      : kind === "team" ? peer.query(`update public.teams set is_active = false where id = $1`, [x.b.teamId])
        : peer.query(`update public.clubs set is_active = false where id = $1`, [x.clubId]);
    const waitsOn = { unbind: "training_load.source_team_bindings", team: "public.teams", club: "public.clubs" }[kind];
    await rowWait(`${kind}: the peer waits for A1's FOR SHARE`, [waitsOn]);
    hold.g.open();
    const res = await a1;
    if (kind === "club") assert.ok([200, 404].includes(res.status), res.text);
    else ok(res);
    await changing;
    await peer.end();
    assert.equal(await statusOf(xv), "active", `${kind}: A1 committed first`);
    assert.equal((await openOn(xv)).length, 1, `${kind}: A1's start committed (neither an Unbind nor an archive ends a T5 row)`);
    if (kind === "club") continue;
    // (b) the peer's change held first: A1 waits at the binding, then refuses.
    const y = await freshClub();
    const yv = await clubWaiting(y.admins[0]);
    const holder = kind === "unbind"
      ? await peerHolds(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'Peer unbind.' where id = $1`, [y.b.bindingId, W.pa.id])
      : await peerHolds(`update public.teams set is_active = false where id = $1`, [y.b.teamId]);
    const waiting = activate(yv, y.admins[0].cookie, { starts: [y.b] });
    await rowWait(`${kind}: A1 waits for the peer`, [kind === "unbind" ? "training_load.source_team_bindings" : "public.teams"]);
    await release(holder);
    const wres = await waiting;
    if (kind === "unbind") refused(wres, 409, "binding_not_active");
    else isNotFound(wres, "team archived first");
    assert.equal(await statusOf(yv), "needs_review");
  }
  // The club archive held first: A1 waits at the club row, then the identical 404.
  const z = await freshClub();
  const zv = await clubWaiting(z.admins[0]);
  const zHolder = await peerHolds(`update public.clubs set is_active = false where id = $1`, [z.clubId]);
  const zA1 = activate(zv, z.admins[0].cookie, { starts: [z.b] });
  await rowWait("A1 waits for the club archive", ["public.clubs"]);
  await release(zHolder);
  isNotFound(await zA1, "club archived first");
  assert.equal(await statusOf(zv), "needs_review");
  // A2 against a club archive, both orders.
  const c1 = await freshClub();
  const c1v = await clubActive(c1.admins[0]);
  hold = holdWrite("mapping_version_disable");
  const c1A2 = disable(c1v, c1.admins[0].cookie);
  await until(() => hold.state.entered, "A2 holds");
  const archiver = await client();
  const archiving = archiver.query(`update public.clubs set is_active = false where id = $1`, [c1.clubId]);
  await rowWait("the archive waits for A2", ["public.clubs"]);
  hold.g.open();
  const c1res = await c1A2;
  assert.ok([200, 404].includes(c1res.status), c1res.text);
  await archiving;
  await archiver.end();
  assert.equal(await statusOf(c1v), "disabled", "A2 committed first");
  const c2 = await freshClub();
  const c2v = await clubActive(c2.admins[0]);
  const c2Holder = await peerHolds(`update public.clubs set is_active = false where id = $1`, [c2.clubId]);
  const c2A2 = disable(c2v, c2.admins[0].cookie);
  await rowWait("A2 waits for the archive", ["public.clubs"]);
  await release(c2Holder);
  isNotFound(await c2A2, "club archived before A2");
  assert.equal(await statusOf(c2v), "active");
  noDeadlock();
});

test("14. the service locks the rights rows before any trigger does (the Nezavisni revizor's note): at the write hold of A1, of A1's replacement and of A2, a peer's FOR UPDATE NOWAIT on the admin's users row and on its user_club_roles row each fails with 55P03", async () => {
  const x = await freshClub();
  const [adm] = x.admins;
  const nowaitFails = async (label) => {
    for (const [what, sql, params] of [
      ["users", `select 1 from public.users where id = $1 for update nowait`, [adm.id]],
      ["user_club_roles", `select 1 from public.user_club_roles where user_id = $1 and club_id = $2 and role = 'club_admin' for update nowait`, [adm.id, x.clubId]],
    ]) {
      const peer = await client();
      try {
        await peer.query("begin");
        await assert.rejects(peer.query(sql, params), (e) => e.code === "55P03", `${label}: ${what} is held`);
      } finally {
        await release(peer, "rollback");
      }
    }
  };
  const v = await clubWaiting(adm);
  let hold = holdWrite("mapping_version_activate");
  let pending = activate(v, adm.cookie);
  await until(() => hold.state.entered, "A1 holds");
  await nowaitFails("A1");
  hold.g.open();
  ok(await pending);
  ok(await start(adm, v, [x.b]), 201);
  const n1 = await nextVersion(v, adm);
  hold = holdWrite("mapping_version_replace");
  pending = activate(n1, adm.cookie, { expected: v.versionId, reason: reasonFor("Replace."), starts: [x.b] });
  await until(() => hold.state.entered, "the replacement holds");
  await nowaitFails("A1's replacement");
  hold.g.open();
  ok(await pending);
  hold = holdWrite("mapping_version_disable");
  pending = disable(n1, adm.cookie);
  await until(() => hold.state.entered, "A2 holds");
  await nowaitFails("A2");
  hold.g.open();
  assert.equal(ok(await pending).activationsEnded, 1);
});

test("15. the rights hold seam (before the right is checked again) for A1, A1's replacement with starts and A2 with open activations: a revoked role, an archived club or a deactivated user is the identical 404 with nothing written and the key free; a promotion is 409 try_again and the retry writes platform_admin", async () => {
  const ops = {
    a1: async (x, adm) => { const v = await clubWaiting(adm); return (opts) => activate(v, adm.cookie, opts); },
    replace: async (x, adm) => {
      const v = await clubActive(adm);
      ok(await start(adm, v, [x.b]), 201);
      const n1 = await nextVersion(v, adm);
      const reason = reasonFor("Replace.");
      return (opts) => activate(n1, adm.cookie, { expected: v.versionId, reason, starts: [x.b], activationReason: reason, ...opts });
    },
    a2: async (x, adm) => { const v = await clubActive(adm); ok(await start(adm, v, [x.b]), 201); return (opts) => disable(v, adm.cookie, opts); },
  };
  const cases = {
    revoked: { during: (x, adm) => setClubRole(adm.id, x.clubId, false), after: (x, adm) => setClubRole(adm.id, x.clubId, true) },
    archived: { during: (x) => setClubActive(x.clubId, false), after: async (x, adm) => { await setClubActive(x.clubId, true); await workspace(adm.id, "club", x.clubId); } },
    deactivated: { during: (x, adm) => setUserActive(adm.id, false), after: (x, adm) => setUserActive(adm.id, true) },
  };
  for (const [opName, make] of Object.entries(ops)) {
    for (const [caseName, c] of Object.entries(cases)) {
      const x = await freshClub();
      const [adm] = x.admins;
      const send = await make(x, adm);
      const before = await counts();
      const k1 = key();
      const hold = holdRights();
      const pending = send({ requestKey: k1 });
      await until(() => hold.state.entered, `${opName}/${caseName}: holds before the right`);
      await c.during(x, adm);
      hold.g.open();
      isNotFound(await pending, `${opName}/${caseName}`);
      assert.deepEqual(await counts(), before, `${opName}/${caseName}: nothing written`);
      assert.equal(await keyRow(k1), undefined, `${opName}/${caseName}: the key is free`);
      await c.after(x, adm);
      service.setMappingRightsHoldForTests(null);
      ok(await send({ requestKey: k1 }));
      assert.equal((await keyRow(k1)).basis, "club_admin", `${opName}/${caseName}: the same key afterwards`);
    }
    // A promotion during the request: try_again; the retry writes platform_admin.
    const x = await freshClub();
    const [adm] = x.admins;
    const send = await make(x, adm);
    const before = await counts();
    const k2 = key();
    const hold = holdRights();
    const pending = send({ requestKey: k2 });
    await until(() => hold.state.entered, `${opName}/promotion`);
    await setGlobal(adm.id, true);
    hold.g.open();
    refused(await pending, 409, "try_again");
    assert.deepEqual(await counts(), before, `${opName}/promotion: nothing written`);
    service.setMappingRightsHoldForTests(null);
    ok(await send({ requestKey: k2 }));
    assert.equal((await keyRow(k2)).basis, "platform_admin", `${opName}/promotion: the retry`);
    await setGlobal(adm.id, false);
  }
});

test("16. the write hold seam (after the right, before the first write): a promotion committed there is the sanitized 500 with nothing written and the key free, and the retry writes platform_admin (R4); a club-role revocation from a peer there waits for the write, the write's rows are committed, its answer is 200 or the identical 404, and a replay after the revocation is the identical 404", async () => {
  for (const at of ["mapping_version_activate", "mapping_version_disable"]) {
    const x = await freshClub();
    const [adm] = x.admins;
    const v = at === "mapping_version_activate" ? await clubWaiting(adm) : await clubActive(adm);
    const send = (opts) => (at === "mapping_version_activate" ? activate(v, adm.cookie, opts) : disable(v, adm.cookie, opts));
    const before = await counts();
    const k1 = key();
    const hold = holdWrite(at);
    const pending = send({ requestKey: k1 });
    await until(() => hold.state.entered, `${at}: holds after the right`);
    await setGlobal(adm.id, true);
    hold.g.open();
    const res = await pending;
    assert.deepEqual([res.status, res.body.error], [500, "internal_error"], res.text);
    assert.ok(!/source_metric|training_load|basis|acting user/i.test(res.text), "sanitized");
    assert.deepEqual(await counts(), before, `${at}: nothing written`);
    assert.equal(await keyRow(k1), undefined, `${at}: the key is free`);
    service.setMappingWriteHoldForTests(null);
    ok(await send({ requestKey: k1 }));
    assert.equal((await keyRow(k1)).basis, "platform_admin");
    await setGlobal(adm.id, false);
  }
  // A club-role revocation from a peer at the write hold.
  const x = await freshClub();
  const [adm] = x.admins;
  const v = await clubWaiting(adm);
  const k2 = key();
  const hold = holdWrite("mapping_version_activate");
  const pending = activate(v, adm.cookie, { requestKey: k2 });
  await until(() => hold.state.entered, "A1 holds");
  const peer = await client();
  const revoking = peer.query(`update public.user_club_roles set is_active = false where user_id = $1 and club_id = $2`, [adm.id, x.clubId]);
  await rowWait("the revocation waits for the write on the role row", ["public.user_club_roles"]);
  hold.g.open();
  const res = await pending;
  assert.ok([200, 404].includes(res.status), res.text);
  if (res.status === 404) assert.deepEqual(res.body, { error: "notFound" });
  await revoking;
  await peer.end();
  assert.deepEqual([await statusOf(v), (await versionRow(v.versionId)).activated_basis], ["active", "club_admin"], "the write's rows are committed");
  isNotFound(await activate(v, adm.cookie, { requestKey: k2 }), "a replay after the revocation");
  noDeadlock();
});

test("17. the real club-admin revocation route against the real write (L1; db review F2), both orders: the revocation queued first on the admin's users row, then A1 released into its right - A1 is the identical 404 with nothing written and the revocation succeeds; A1 holding its right first - the revocation waits, A1's rows commit (200 or the identical 404) and the revocation then succeeds - no 40P01", async () => {
  const revoke = (adm, clubId) => api(`/users/${adm.id}/club-roles/${clubId}/club_admin`, { method: "DELETE", cookie: W.pa.cookie, prefix: "/api/organization" });
  // Order 1: the revocation queued first.
  const x = await freshClub(3);
  const [adm1, adm2] = x.admins;
  const v1 = await clubWaiting(adm1);
  const third = await peerHolds(`select 1 from public.users where id = $1 for update`, [adm1.id]);
  const revoking = revoke(adm1, x.clubId);
  await waitingOn("for update of u, r");
  const rh = holdRights();
  const a1 = activate(v1, adm1.cookie);
  await until(() => rh.state.entered, "A1 holds before its right");
  rh.g.open();
  await waitingOn("for share of u, r");
  await release(third);
  const revoked = await revoking;
  assert.equal(revoked.status, 200, revoked.text);
  isNotFound(await a1, "A1 after the revocation");
  assert.equal(await statusOf(v1), "needs_review", "nothing written");
  // Order 2: A1 holds its right first.
  service.setMappingRightsHoldForTests(null);
  const v2 = await clubWaiting(adm2);
  const wh = holdWrite("mapping_version_activate");
  const a2 = activate(v2, adm2.cookie);
  await until(() => wh.state.entered, "A1 holds after its right");
  const revoking2 = revoke(adm2, x.clubId);
  await waitingOn("for update of u, r");
  wh.g.open();
  const res = await a2;
  assert.ok([200, 404].includes(res.status), res.text);
  assert.deepEqual([await statusOf(v2), (await versionRow(v2.versionId)).activated_basis], ["active", "club_admin"], "A1's rows are committed");
  assert.equal((await revoking2).status, 200);
  assert.equal((await one(k, `select is_active from public.user_club_roles where user_id = $1 and club_id = $2`, [adm2.id, x.clubId])).is_active, false);
  noDeadlock();
});

test("18. submitVersion (R5): a caller whose right is revoked during the request gets the identical 404, never version_not_draft or revision_not_usable", async () => {
  const x = await freshClub();
  const [adm] = x.admins;
  const submit = (v, opts = {}) => post(`/mappings/${v.mappingId}/versions/${v.versionId}/submit`, adm.cookie, { requestKey: key(), ...opts });
  // Already submitted: version_not_draft for a caller with the right.
  const waiting = await clubWaiting(adm);
  refused(await submit(waiting), 409, "version_not_draft");
  // A draft whose revision is retired: revision_not_usable for a caller with the right.
  const f = await field();
  const draft = await version(f, { owner: adm, target: await variable(adm), submit: false });
  ok(await retireRevision(f, W.pa.cookie));
  refused(await submit(draft), 409, "revision_not_usable");
  for (const [label, v] of [["version_not_draft", waiting], ["revision_not_usable", draft]]) {
    const hold = holdRights();
    const pending = submit(v);
    await until(() => hold.state.entered, label);
    await setClubRole(adm.id, x.clubId, false);
    hold.g.open();
    isNotFound(await pending, `${label} with the right revoked`);
    service.setMappingRightsHoldForTests(null);
    await setClubRole(adm.id, x.clubId, true);
  }
});

test("19. the COMMIT through a club admin's replacement with starts and A2 with open activations: a lost answer verified by the key (200 verified_after_commit_error), an unverifiable one (503 outcome_unknown, then the same key answers once), and a definite refusal at COMMIT - split_operation (v43's G1) for the replacement, skip_end (v48's end link) for A2 and the replacement - the sanitized 500 with nothing written and the key free", async () => {
  const setup = async () => {
    const x = await freshClub();
    const [adm] = x.admins;
    const v = await clubActive(adm);
    ok(await start(adm, v, [x.b]), 201);
    const n1 = await nextVersion(v, adm);
    const reason = reasonFor("Replace.");
    const disableReason = reasonFor("Disable.");
    return {
      v, n1, adm,
      replace: (opts) => activate(n1, adm.cookie, { expected: v.versionId, reason, starts: [x.b], activationReason: reason, ...opts }),
      a2: (opts) => disable(v, adm.cookie, { reason: disableReason, ...opts }),
    };
  };
  for (const op of ["replace", "a2"]) {
    // Lost but verified.
    let s = await setup();
    service.setMappingCommitForTests({ fault: (c) => c.query("commit").then(() => { throw new Error("answer lost"); }), timeoutMs: 2_000 });
    let res = await s[op]({});
    service.setMappingCommitForTests();
    assert.deepEqual([res.status, res.body.commitConfirmation], [200, "verified_after_commit_error"], `${op}: ${res.text}`);
    // Lost and not found: 503, then the same key writes once.
    s = await setup();
    const k1 = key();
    service.setMappingCommitForTests({ fault: () => Promise.reject(new Error("socket gone")), timeoutMs: 2_000 });
    res = await s[op]({ requestKey: k1 });
    service.setMappingCommitForTests();
    assert.deepEqual([res.status, res.body.error, res.body.requestKey], [503, "outcome_unknown", k1], `${op}: ${res.text}`);
    ok(await s[op]({ requestKey: k1 }));
    assert.equal(ok(await s[op]({ requestKey: k1 })).replayed, true);
    assert.equal((await auditOf(`request_key = $1`, [k1])).length, 1, `${op}: one request record`);
    // A definite refusal at COMMIT.
    for (const fault of op === "replace" ? ["split_operation", "skip_end"] : ["skip_end"]) {
      s = await setup();
      const before = await counts();
      const k2 = key();
      service.setMappingTransitionAuditFaultForTests(fault);
      res = await s[op]({ requestKey: k2 });
      service.setMappingTransitionAuditFaultForTests(null);
      assert.deepEqual([res.status, res.body.error], [500, "internal_error"], `${op}/${fault}: ${res.text}`);
      assert.deepEqual(await counts(), before, `${op}/${fault}: nothing written`);
      assert.equal(await keyRow(k2), undefined, `${op}/${fault}: the key is free`);
      ok(await s[op]({ requestKey: k2 }));
      assert.equal((await keyRow(k2)).basis, "club_admin");
    }
  }
});

test("20. no answer of the transition routes carries a reason, an acting user's id, a club id, a trigger text or SQL; no log line carries a reason or a trigger text", async () => {
  const ids = Object.values(W).filter((x) => x && typeof x === "object" && x.id).map((x) => x.id);
  const clubs = [W.clubA, W.clubB, W.clubC];
  const transitionAnswers = responses.filter((t) => /"version"|"replaced"|"activationsEnded"|"notFound"|"internal_error"/.test(t));
  assert.ok(transitionAnswers.length > 50, `answers scanned: ${transitionAnswers.length}`);
  for (const text of transitionAnswers) {
    for (const reason of sentReasons) assert.ok(!text.includes(reason), "no reason in an answer");
    for (const id of ids) assert.ok(!text.includes(id), "no acting user's id in an answer");
    for (const c of clubs) assert.ok(!text.includes(c), "no club id in an answer");
    assert.ok(!/source_metric_|training_load\.|insert into|select .* from|SQLSTATE/i.test(text), `no trigger text or SQL: ${text.slice(0, 200)}`);
  }
  // The migration runner's own lines of the rehearsal (tests 1-6) name migration files; they are not the routes' log.
  const appLines = logLines.filter((l) => !l.startsWith("[migrate]"));
  assert.ok(appLines.length > 0, "the routes logged something to scan");
  for (const line of appLines) {
    for (const reason of sentReasons) assert.ok(!line.includes(reason), "no reason in a log line");
    for (const id of ids) assert.ok(!line.includes(id), `no acting user's id in a log line: ${line.slice(0, 200)}`);
    for (const c of clubs) assert.ok(!line.includes(c), `no club id in a log line: ${line.slice(0, 200)}`);
    assert.ok(!/source_metric_|training_load\.|insert into|select .* from|SQLSTATE/i.test(line), `no trigger text or SQL in a log line: ${line.slice(0, 200)}`);
    assert.ok(!/a club version's activation is on another club's binding|the basis is not the acting user's own|may not (activate|disable) this mapping version|acting user/i.test(line), `no trigger text in a log line: ${line.slice(0, 200)}`);
  }
});

test("21. R6 (J14 sections 2.3 and 10.2): club A's admin's A2 and replacement end the open activations of the club's own version on an archived team's binding and on an ended binding - club_admin and the admin on the ended T5 row and its T8 activation_end row, the version's reason, never a refusal; the replacement starts only the active team it lists", async () => {
  // A2 with open activations on an archived team's binding and on an active one.
  const x = await freshClub();
  const [adm] = x.admins;
  const v = await clubActive(adm);
  const other = await binding(x.clubId);
  const acts = ok(await start(adm, v, [x.b, other]), 201).activations;
  await k.query(`update public.teams set is_active = false where id = $1`, [x.b.teamId]);
  const dReason = reasonFor("Disable with an archived team.");
  const dis = ok(await disable(v, adm.cookie, { reason: dReason }));
  assert.equal(dis.activationsEnded, 2);
  const ended = await rows(k, `select * from ${T5} where mapping_version_id = $1 order by id`, [v.versionId]);
  assert.equal(ended.length, 2);
  assert.ok(ended.some((r) => r.source_team_binding_id === x.b.bindingId), "the archived team's activation is among the ended");
  assert.deepEqual(ended.map((r) => [r.ended_basis, r.ended_by_user_id, r.end_reason]), ended.map(() => ["club_admin", adm.id, "mapping_version_disabled"]));
  const dEnds = await auditOf(`action = 'activation_end' and mapping_version_id = $1`, [v.versionId]);
  assert.deepEqual(dEnds.map((r) => [r.basis, r.performed_by_user_id, r.reason]), dEnds.map(() => ["club_admin", adm.id, dReason]));
  assert.deepEqual(dEnds.map((r) => r.activation_id).sort(), acts.map((a) => a.id).sort());
  // A replacement: the archived team's and an ended binding's activations end as replaced; the active team listed moves.
  const y = await freshClub();
  const [yAdm] = y.admins;
  const yv = await clubActive(yAdm);
  const keep = await binding(y.clubId);
  const gone = await binding(y.clubId);
  ok(await start(yAdm, yv, [y.b, keep, gone]), 201);
  await k.query(`update public.teams set is_active = false where id = $1`, [y.b.teamId]);
  await unbind(gone);
  const next = await nextVersion(yv, yAdm);
  const rReason = reasonFor("Replace with an archived team.");
  const rep = ok(await activate(next, yAdm.cookie, { expected: yv.versionId, reason: rReason, starts: [keep] }));
  assert.deepEqual([rep.replaced, rep.activationsEnded, rep.activations.length], [yv.versionId, 3, 1]);
  const yEnded = await rows(k, `select * from ${T5} where mapping_version_id = $1 order by id`, [yv.versionId]);
  assert.deepEqual(yEnded.map((r) => [r.ended_basis, r.ended_by_user_id, r.end_reason]), yEnded.map(() => ["club_admin", yAdm.id, "mapping_version_replaced"]));
  const rEnds = await auditOf(`action = 'activation_end' and mapping_version_id = $1`, [yv.versionId]);
  assert.deepEqual(rEnds.map((r) => [r.basis, r.performed_by_user_id, r.reason]), rEnds.map(() => ["club_admin", yAdm.id, rReason]));
  assert.equal(rEnds.length, 3);
  assert.deepEqual((await openOn(next)).map((r) => [r.source_team_binding_id, r.activated_basis]), [[keep.bindingId, "club_admin"]]);
  // A moved team's ended binding: the binding's club is its connection's, so the club admin's A2 still ends it.
  const z = await freshClub();
  const [zAdm] = z.admins;
  const zv = await clubActive(zAdm);
  const zAct = ok(await start(zAdm, zv, [z.b]), 201).activations[0];
  await unbind(z.b);
  const elsewhere = await club("Club Y");
  await k.query(`update public.teams set club_id = $2 where id = $1`, [z.b.teamId, elsewhere]);
  const zReason = reasonFor("Disable with a moved team.");
  assert.equal(ok(await disable(zv, zAdm.cookie, { reason: zReason })).activationsEnded, 1);
  const zRow = await t5(zAct.id);
  assert.deepEqual([zRow.ended_basis, zRow.ended_by_user_id, zRow.end_reason], ["club_admin", zAdm.id, "mapping_version_disabled"]);
  assert.deepEqual((await auditOf(`action = 'activation_end' and activation_id = $1`, [zAct.id])).map((r) => [r.basis, r.performed_by_user_id, r.reason]), [["club_admin", zAdm.id, zReason]]);
  noDeadlock();
});

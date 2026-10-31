// Phase 7g - ending a held source instance: GET /source-instances, POST
// /source-instances/:connectionId/end, and migration v50.
// Contract: docs/ai/phase7g-source-instance-end-contract.md (J13), section 8.
// Through the real HTTP stack, on disposable optimove_tests_gpexe_* databases only
// (never OPTIMOVE, never a real GPEXE team or connection): one migrated through
// v49 that rehearses v50 (the preflight, the runner, the post-check, every refusal
// of the rollback, the rollback back to v49's exact catalog, and v50 again), and
// one migrated through v50 for the behaviour. Every team, binding, connection and
// instance here is a test row of this file (a credential connection's parts are
// random bytes of the right lengths: nothing is ever decrypted or sent). No code
// writes the T7 keys before M4, so every instance is a raw fixture row.
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
const V50 = "202610311200_training_load_v50_source_instance_end.sql";
const V50_NAME = `migrations_v2/${V50}`;
const V49_NAME = "migrations_v2/202610311000_calendar_v49_events.sql";
const UP_TO_V49 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V50));
const V50_FILE = path.resolve(ROOT, "migrations_v2", V50);
const RUNBOOKS = path.resolve(ROOT, "docs/runbooks");
const ROLLBACK = path.join(RUNBOOKS, "source-instance-end-v50-rollback.sql");
const PREFLIGHT = path.join(RUNBOOKS, "source-instance-end-v50-preflight.sql");
const POSTCHECK = path.join(RUNBOOKS, "source-instance-end-v50-postcheck.sql");
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const TZ = "Europe/Belgrade";
// A distinctive account label of the credential connections: test 13 scans every answer and log line for it.
const ACCOUNT_LABEL = `7g secret account ${crypto.randomBytes(6).toString("hex")}`;
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const LIST_KEYS = ["createdAt", "endedAt", "held", "id", "ownerTeamId", "ownerTeamName", "sourceHostKey", "sourceInstanceKey", "sourceSystem", "state"];
const NO_ACTOR = /^source metric mapping: no acting user is set for this transaction$/;
const MAY_NOT_END = /^metric source connection: the acting user may not end this source instance$/;
const ONLY_TEAM = /^metric_source_connections: only a team's source instance is ended$/;
const FINAL = /^metric_source_connections: an ended source instance is final$/;
const BINDING_ACTIVE = /^metric_source_connections: the owner team still holds an active binding of this source team$/;
const ACTIVATION_OPEN = /^metric_source_connections: an activation of this source team is still open$/;
const END_LINK = /^metric_source_connections: a source instance is ended with its audit row$/;
const AUDIT_FOLLOWS = /^source_metric_audit: the audit row must follow its own source instance end in the same transaction$/;
const AUDIT_ONCE = /^source_metric_audit: the source instance end already has its audit row$/;
const TEAM_LOCK = /^gpexe: a GPEXE check, import or connection change is running for team [0-9a-f-]{36} \(.*\); try again when it has finished$/;

let rdb, db, r, k, server, apiBase, service, instances, dbModule, appPool, createSession;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};

async function migrate(url, files, { extra = null } = {}) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v50-migrations-"));
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
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V50), "v50 is a test migration");
  assert.equal(GPEXE_TEST_MIGRATIONS.at(-1), V50, "v50 is the last test migration");
  assert.equal(`migrations_v2/${UP_TO_V49.at(-1)}`, V49_NAME, "the rehearsal stops at v49");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v50rb", migrations: UP_TO_V49 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v50" }),
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
      if (process.env.V50_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  instances = await import("../src/sourceInstanceEndService.js");
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
  instances?.setInstanceWriteHoldForTests(null);
  instances?.setInstanceSeamsForTests();
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
  responses.push({ path: p, text });
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, headers: res.headers, text };
}
const post = (p, cookie, body, opts = {}) => api(p, { method: "POST", cookie, body, ...opts });
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const refused = (res, status, code) => { assert.deepEqual([res.status, res.body.error], [status, code], res.text); return res.body; };
const isNotFound = (res, label) => { assert.equal(res.status, 404, `${label}: ${res.text}`); assert.deepEqual(res.body, { error: "notFound" }, label); };
const keysOf = (o) => Object.keys(o).sort();

// Every reason sent; test 13 scans every answer and log line for them.
const sentReasons = new Set();
const reasonFor = (label) => { const text = `${label} ${uid()}`; sentReasons.add(text); return text; };
const endBody = (inst, { reason = reasonFor("End the instance."), requestKey = key(), expected = inst.expected } = {}) => ({ requestKey, reason, expected });
const endPath = (inst) => `/source-instances/${inst.connectionId ?? inst}/end`;
const endIt = (who, inst, opts = {}) => post(endPath(inst), who.cookie, endBody(inst, opts));
const list = (who, query = "") => api(`/source-instances${query}`, { cookie: who.cookie });

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
async function teamCoach(clubId) {
  const teamId = await team(clubId);
  const id = await user("coach");
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await workspace(id, "team", teamId);
  return { id, cookie: await cookieFor(id) };
}
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const team = async (clubId) => (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;

// A club-owned server3 credential connection per club (the credential parts
// are random bytes, never decrypted), the club's approved pair of a team, a
// binding of it, and the team's keyed Metrics Core connection (T7) - in that
// order: v24 refuses a team's GPEXE settings while it has an active GPEXE
// Metrics Core connection.
const credentialOf = new Map();
async function credential(clubId) {
  if (!credentialOf.has(clubId)) {
    credentialOf.set(clubId, (await one(k,
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                                credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','club',$1,'server3',$2,'exchanged_token',$3,'verified',$4,$5,$6,7, now()) returning id`,
      [clubId, ACCOUNT_LABEL, W.pa.id, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id);
  }
  return credentialOf.get(clubId);
}
let sourceTeamCounter = 0;
const nextSourceTeam = () => String(960000 + (++sourceTeamCounter));
const settings = (teamId, sourceTeamId) => k.query(
  `insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)`, [teamId, sourceTeamId, W.pa.id]);
async function bind(teamId, sourceTeamId, clubId, client = k) {
  return (await one(client,
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
     values ($1,$2,'gpexe',$3,$4,$1) returning id`, [teamId, await credential(clubId), sourceTeamId, W.pa.id])).id;
}
// An Unbind's effect on the row (v27; sourceConnectionService's unbindTeam writes the same columns).
const unbind = (bindingId, client = k) => client.query(
  `update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'Test unbind.' where id = $1`, [bindingId, W.pa.id]);
async function keyedConnection(teamId, sourceTeamId, { sourceSystem = "gpexe", host = "server3" } = {}) {
  return (await one(k,
    `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id, source_host_key, source_instance_key)
     values ($1,'team',$2,$3,$4) returning id`, [sourceSystem, teamId, host, sourceTeamId])).id;
}
// One held instance of a fresh team of `clubId`: its binding "ended" (the
// instance an end can release), "active", or "none".
async function instance({ binding = "ended", clubId = W.clubA } = {}) {
  const teamId = await team(clubId);
  const sourceTeamId = nextSourceTeam();
  let bindingId = null;
  if (binding !== "none") {
    await settings(teamId, sourceTeamId);
    bindingId = await bind(teamId, sourceTeamId, clubId);
  }
  const connectionId = await keyedConnection(teamId, sourceTeamId);
  if (binding === "ended") await unbind(bindingId);
  return { teamId, sourceTeamId, bindingId, connectionId, clubId, expected: { sourceSystem: "gpexe", sourceHostKey: "server3", sourceInstanceKey: sourceTeamId } };
}
// Fixtures of states no route builds, with triggers off for that one
// transaction (session_replication_role, a disposable database only).
async function raw(fn, client = k) {
  await client.query("begin");
  try {
    await client.query("set local session_replication_role = replica");
    const value = await fn(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}
// An open activation on binding `bindingId` (the other T5 ids random: v48's
// guards and the foreign keys are off for the fixture; v50 and the service read
// only the binding and ended_at).
async function rawActivation(bindingId, teamId) {
  return raw(async (c) => {
    const id = crypto.randomUUID();
    await c.query(`insert into training_load.source_metric_mapping_activations (id, mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint,
                     source_team_binding_id, team_id, applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
                   values ($1,$1,$1,$1,$1,'',$2,$3,true,true,'required',$4,'platform_admin','Raw fixture')`, [id, bindingId, teamId, W.pa.id]);
    return id;
  });
}
const dropRawActivation = (id) => raw((c) => c.query(`delete from training_load.source_metric_mapping_activations where id = $1`, [id]));
// Another team's active binding of the same source team (unreachable for
// GPEXE through v24 and v30, which this fixture switches off: D9's defence in
// depth for a future source).
async function rawForeignBinding(sourceTeamId, clubId = W.clubB) {
  const teamId = await team(clubId);
  const credentialId = await credential(clubId);
  const bindingId = await raw(async (c) => (await one(c,
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id)
     values ($1,$2,'gpexe',$3,$4) returning id`, [teamId, credentialId, sourceTeamId, W.pa.id])).id);
  return { teamId, bindingId };
}
const connectionRow = (id) => one(k, `select * from training_load.metric_source_connections where id = $1`, [id]);
const endRows = (id) => rows(k, `select * from training_load.source_metric_audit where action = 'source_instance_end' and metric_source_connection_id = $1`, [id]);

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
const endSql = (c, id) => c.query(`update training_load.metric_source_connections set state = 'inactive' where id = $1`, [id]);
const auditSql = (c, inst, { by = W.pa.id, basis = "platform_admin", teamId = inst.teamId, evidenceRef = null, requestKey = key() } = {}) => c.query(
  `insert into training_load.source_metric_audit (action, metric_source_connection_id, team_id, from_status, to_status, reason, evidence_ref, performed_by_user_id, basis, operation_id, request_key, request_hash)
   values ('source_instance_end',$1,$2,'active','inactive','A raw end.',$3,$4,$5,$6,$7,$8)`,
  [inst.connectionId, teamId, evidenceRef, by, basis, crypto.randomUUID(), requestKey, "0".repeat(64)]);

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
// Holds the next end after its locks and checks (writeHold) or between its
// bindings and its connection (afterBindings) until the gate opens.
function holdEnd(where = "write") {
  const g = gate();
  const state = { entered: false };
  const hold = async () => {
    if (state.entered) return;
    state.entered = true;
    await g.promise;
  };
  if (where === "write") instances.setInstanceWriteHoldForTests(hold);
  else instances.setInstanceSeamsForTests({ afterBindings: hold });
  return { g, state };
}
async function client(url = db.url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}
const teamLockSql = `select pg_advisory_xact_lock(hashtextextended('gpexe-import-team:' || $1::uuid::text, 21))`;

// Phase 7d's helpers for a real S1 (test 11): a canonical variable, a test
// field whose revision 1 is active and verified, an active system version.
async function variable(owner) {
  const res = await post("/variables", owner.cookie, { requestKey: key(), label: `Instance variable ${uid()}`, unit: "s", levels: ["session", "drill"], dailyAggregationMethod: "sum" });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.variable.id };
}
async function sysVersion() {
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'7g test field',$2) returning id`,
    [`v50.test.f${uid()}`, W.pa.id])).id;
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: "number", parameterKind: "none", evidenceRef: COMPAT, unit: "s", unitRef: UNIT_REF, meaning: true, meaningRef: MEANING_REF, state: "active" });
  const target = await variable(W.pa);
  const m = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: fieldId, metricDefinitionId: target.id });
  assert.equal(m.status, 201, m.text);
  const mappingId = m.body.mapping.id;
  const v = await post(`/mappings/${mappingId}/versions`, W.pa.cookie, { requestKey: key(), sourceRevisionId: revId, appliesToSession: true, appliesToDrill: true });
  assert.equal(v.status, 201, v.text);
  const versionId = v.body.version.id;
  assert.equal((await post(`/mappings/${mappingId}/versions/${versionId}/submit`, W.pa.cookie, { requestKey: key() })).status, 200);
  ok(await post(`/mappings/${mappingId}/versions/${versionId}/activate`, W.pa.cookie, { requestKey: key(), expectedActiveVersionId: null }));
  return { mappingId, versionId };
}
const startS1 = (v, bindingId, who = W.pa) => post("/activations", who.cookie, {
  requestKey: key(), mappingId: v.mappingId, versionId: v.versionId, bindings: [{ bindingId, requirement: "required" }], reason: reasonFor("Start."),
});

// The training_load tables an end must leave byte-identical (all but the two it writes).
async function otherTables() {
  const names = (await rows(k, `select table_name from information_schema.tables where table_schema = 'training_load' and table_type = 'BASE TABLE'
                                 and table_name not in ('metric_source_connections', 'source_metric_audit') order by 1`)).map((x) => x.table_name);
  const out = {};
  for (const name of names) out[name] = (await one(k, `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d from training_load.${name} t`)).d;
  return out;
}

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.pa = await platformAdmin();
  W.pa2 = await platformAdmin();
  W.paA = await platformAdmin(["club", W.clubA]);
  W.caA = await clubAdmin(W.clubA);
  W.coachA = await teamCoach(W.clubA);
  W.plain = { id: await user("no-role") };
  await workspace(W.plain.id, "platform", null);
  W.plain.cookie = await cookieFor(W.plain.id);
}

// ---------------------------------------------------------------------------
// The rehearsal database (through v49).
// ---------------------------------------------------------------------------
test("1. on v49: every expected value of the read-only preflight (block 4 counts a source_instance_end row and a keyed inactive connection and is then not safe to merge); the rollback refuses without v50", async () => {
  const pre = await blocks(r, PREFLIGHT);
  assert.deepEqual(Object.keys(pre).map(Number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(pre[1][0].pg15_or_later, true);
  assert.deepEqual(pre[2][0], { v48_rows: "1", v48_checksum_ok: true, v49_rows: "1", v49_checksum_ok: true, v50_rows: "0", at_or_after_v50: "0", last_migration: V49_NAME });
  assert.deepEqual(pre[3][0], { revision_guard_is_v48: true, row_ok_is_v48: true, actor_guard_is_v48: true });
  assert.deepEqual(pre[4][0], { instance_end_rows: "0", inactive_keyed: "0", keyed_connections: "0", safe_to_merge: true });
  assert.deepEqual(pre[5][0], { v50_functions: "0", v50_triggers: "0", v50_index: "0" });
  assert.deepEqual(pre[6][0], { schema_create: true, owns_connections: true, owns_audit: true, disabled_triggers: "0" });
  assert.deepEqual(pre[7][0], { actor_defaults: "0" });
  assert.deepEqual(pre[8][0], { table_writers: "0", idle_in_transaction: "0" });
  // Block 4 counts what it must stop on (rows planted with triggers off, rolled back).
  await r.query("begin");
  try {
    await r.query("set local session_replication_role = replica");
    const id = crypto.randomUUID();
    await r.query(`insert into training_load.metric_source_connections (id, source_system, owner_scope, owner_team_id, source_host_key, source_instance_key, state)
                   values ($1,'gpexe','team',$1,'server3','1','inactive')`, [id]);
    const planted = await blocks(r, PREFLIGHT);
    assert.deepEqual(planted[4][0], { instance_end_rows: "0", inactive_keyed: "1", keyed_connections: "1", safe_to_merge: false });
    await r.query(`update training_load.metric_source_connections set state = 'active' where id = $1`, [id]);
    await r.query(`insert into training_load.source_metric_audit (action, metric_source_connection_id, from_status, to_status, reason, performed_by_user_id, basis, operation_id)
                   values ('source_instance_end',$1,'active','inactive','x',$1,'platform_admin',$1)`, [id]);
    assert.deepEqual((await blocks(r, PREFLIGHT))[4][0], { instance_end_rows: "1", inactive_keyed: "0", keyed_connections: "1", safe_to_merge: false });
  } finally {
    await r.query("rollback");
  }
  assert.match((await inRolledBack(r, null, ROLLBACK))?.message ?? "", /^v50 rollback refused: v50 is not recorded on this database$/);
  W.before49 = await catalog(r);
  W.v48Body = await prosrc(r, "source_metric_audit_revision_guard");
  assert.equal(crypto.createHash("md5").update(W.v48Body).digest("hex"), "921db06f6f2833eb57c062fb61e82e25", "v48's body is in force on v49");
});

test("2. v50 refuses, changing nothing, when the body in force of the T8 revision guard is not v48's (its md5 check runs before any change)", async () => {
  const error = await inRolledBack(r, (c) => c.query(`create or replace function training_load.source_metric_audit_revision_guard() returns trigger as $$ begin return new; end; $$ language plpgsql`), V50_FILE);
  assert.equal(error?.code, "23514", error?.message);
  assert.match(error.message, /^v50 refused: the body in force of training_load\.source_metric_audit_revision_guard is not v48's$/);
  assert.deepEqual(await catalog(r), W.before49, "nothing changed");
});

test("3. v50 through the runner on v49: a FOR SHARE reader of the connections never blocks it; an open INSERT makes it wait, and it then applies with no deadlock; it adds exactly its two functions, two triggers and one index and replaces only the revision guard's body (v48's plus the new branch); every expected value of the post-check", async () => {
  const reader = await client(rdb.url);
  const writer = await client(rdb.url);
  let applying;
  try {
    const clubId = (await one(r, `insert into public.clubs (name) values ('v50 club') returning id`)).id;
    const teamId = (await one(r, `insert into public.teams (club_id, name) values ($1,'v50 team') returning id`, [clubId])).id;
    await reader.query("begin");
    await reader.query(`select 1 from training_load.metric_source_connections for share`);
    await writer.query("begin");
    await writer.query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1)`, [teamId]);
    applying = migrate(rdb.url, [...UP_TO_V49, V50]);
    assert.equal(await someoneWaits(r), true, "v50 waits for the open INSERT");
    await writer.query("rollback");
    await applying;
    assert.equal((await one(r, `select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V50_NAME])).n, 1, "applied while the FOR SHARE reader still holds its lock");
    await reader.query("commit");
    await r.query(`delete from public.teams where id = $1`, [teamId]);
    await r.query(`delete from public.clubs where id = $1`, [clubId]);
  } finally {
    await writer.query("rollback").catch(() => {});
    await reader.query("rollback").catch(() => {});
    await writer.end();
    await reader.end();
  }
  const after = await catalog(r);
  const before = W.before49;
  assert.deepEqual(after.tables, before.tables, "tables and their comments unchanged");
  assert.deepEqual(after.columns, before.columns, "columns unchanged");
  const conKey = (x) => `${x.rel}.${x.conname}`;
  assert.deepEqual(after.constraints.filter((x) => !before.constraints.some((y) => conKey(y) === conKey(x))).map((x) => [x.rel, x.conname, x.contype, x.convalidated]), [
    ["training_load.metric_source_connections", "metric_source_connections_v50_audit_link_end", "t", true],
  ]);
  assert.deepEqual(after.constraints.filter((x) => x.conname !== "metric_source_connections_v50_audit_link_end"), before.constraints, "every other constraint unchanged");
  assert.deepEqual(after.indexes.filter((x) => !before.indexes.some((y) => y.indexname === x.indexname)).map((x) => [x.tablename, x.indexname]), [
    ["source_metric_audit", "source_metric_audit_v50_instance_end_once"]]);
  assert.match(after.indexes.find((x) => x.indexname === "source_metric_audit_v50_instance_end_once").indexdef,
    /^CREATE UNIQUE INDEX source_metric_audit_v50_instance_end_once ON training_load\.source_metric_audit USING btree \(metric_source_connection_id\) WHERE \(action = 'source_instance_end'::text\)$/);
  assert.deepEqual(after.indexes.filter((x) => x.indexname !== "source_metric_audit_v50_instance_end_once"), before.indexes);
  const fnKey = (x) => `${x.nspname}.${x.proname}(${x.args})`;
  const newFunctions = after.functions.filter((x) => !before.functions.some((y) => fnKey(y) === fnKey(x)));
  assert.deepEqual(newFunctions.map((x) => x.proname).sort(), ["metric_source_connections_end_link", "metric_source_connections_state_guard"]);
  const changed = after.functions.filter((x) => !newFunctions.includes(x) && !before.functions.some((y) => fnKey(y) === fnKey(x) && y.digest === x.digest && y.comment === x.comment));
  assert.deepEqual(changed.map((x) => x.proname), ["source_metric_audit_revision_guard"]);
  const trigKey = (x) => `${x.relname}.${x.tgname}`;
  const newTriggers = after.triggers.filter((x) => !before.triggers.some((y) => trigKey(y) === trigKey(x)));
  assert.deepEqual(newTriggers.map((x) => [x.relname, x.tgname, x.tgenabled]).sort(), [
    ["metric_source_connections", "metric_source_connections_v50_audit_link_end", "O"], ["metric_source_connections", "metric_source_connections_v50_state_guard", "O"]]);
  assert.match(newTriggers.find((x) => x.tgname === "metric_source_connections_v50_state_guard").def,
    /BEFORE UPDATE OF state ON training_load\.metric_source_connections FOR EACH ROW WHEN \(\(\(old\.state\)::text IS DISTINCT FROM \(new\.state\)::text\)\) EXECUTE FUNCTION training_load\.metric_source_connections_state_guard\(\)$/);
  assert.match(newTriggers.find((x) => x.tgname === "metric_source_connections_v50_audit_link_end").def,
    /AFTER UPDATE ON training_load\.metric_source_connections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN \(\(\(old\.state\)::text IS DISTINCT FROM \(new\.state\)::text\)\) EXECUTE FUNCTION training_load\.metric_source_connections_end_link\(\)$/);
  assert.deepEqual(after.triggers.filter((x) => !newTriggers.includes(x)), before.triggers, "every other trigger unchanged");
  assert.deepEqual(after.migrations, [...before.migrations, V50_NAME].sort());
  // v48's revision guard plus the source_instance_end branch, nothing else.
  const v50Body = await prosrc(r, "source_metric_audit_revision_guard");
  const branchStart = v50Body.indexOf("  if new.action = 'source_instance_end' then");
  const branchEnd = v50Body.indexOf("  if new.action not in ('source_metric_unit_verified', 'source_metric_meaning_verified') then");
  assert.ok(branchStart > 0 && branchEnd > branchStart);
  assert.equal(v50Body.slice(0, branchStart) + v50Body.slice(branchEnd), W.v48Body, "v48's body byte for byte around the new branch");
  const post = await blocks(r, POSTCHECK);
  assert.deepEqual(Object.keys(post).map(Number), [1, 2, 3, 4, 5]);
  assert.deepEqual(post[1][0], { v50_rows: "1", v50_checksum_ok: true, later_migrations: "0" });
  assert.deepEqual(post[2][0], { bodies_v50: "3" });
  assert.deepEqual(post[3][0], { guard_ok: true, link_ok: true });
  assert.deepEqual(post[4][0], { index_ok: true });
  assert.deepEqual(post[5][0], { instance_end_rows: "0", inactive_keyed: "0" });
  const sha = crypto.createHash("sha256").update(await fsp.readFile(V50_FILE)).digest("hex");
  assert.ok((await fsp.readFile(POSTCHECK, "utf8")).includes(sha), "the post-check names the v50 file's sha256");
  W.after50 = after;
});

test("4. the rollback refuses, changing nothing: under a later migration, once a source_instance_end row or a keyed inactive connection exists, while a v50 object is missing or a v50 trigger is disabled, while a body in force is not v50's, and while the migrator holds its lock; the four files have LF line endings", async () => {
  const refuses = async (plant, pattern) => {
    const error = await inRolledBack(r, plant, ROLLBACK);
    assert.match(error?.message ?? "", pattern);
    assert.deepEqual(await catalog(r), W.after50, `nothing changed (${pattern})`);
  };
  const replica = async (c, sql, params) => { await c.query("set local session_replication_role = replica"); await c.query(sql, params); };
  await refuses((c) => c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', $1, 'test')`, ["0".repeat(64)]),
    /^v50 rollback refused: later migrations are applied$/);
  const id = crypto.randomUUID();
  await refuses((c) => replica(c, `insert into training_load.source_metric_audit (action, metric_source_connection_id, from_status, to_status, reason, performed_by_user_id, basis, operation_id)
                                    values ('source_instance_end',$1,'active','inactive','x',$1,'platform_admin',$1)`, [id]),
  /^v50 rollback refused: a source_instance_end audit row exists$/);
  await refuses((c) => replica(c, `insert into training_load.metric_source_connections (id, source_system, owner_scope, owner_team_id, source_host_key, source_instance_key, state)
                                    values ($1,'gpexe','team',$1,'server3','1','inactive')`, [id]),
  /^v50 rollback refused: a keyed inactive connection exists$/);
  await refuses((c) => c.query(`alter table training_load.metric_source_connections disable trigger metric_source_connections_v50_state_guard`),
    /^v50 rollback refused: a v50 trigger is disabled$/);
  await refuses(async (c) => {
    await c.query(`drop trigger metric_source_connections_v50_audit_link_end on training_load.metric_source_connections`);
    await c.query(`drop function training_load.metric_source_connections_end_link()`);
  }, /^v50 rollback refused: a v50 function is missing; a v50 trigger is missing; a body in force is not v50's$/);
  await refuses((c) => c.query(`drop trigger metric_source_connections_v50_state_guard on training_load.metric_source_connections`),
    /^v50 rollback refused: a v50 trigger is missing$/);
  await refuses((c) => c.query(`drop index training_load.source_metric_audit_v50_instance_end_once`), /^v50 rollback refused: the v50 index is missing$/);
  for (const name of ["source_metric_audit_revision_guard", "metric_source_connections_state_guard", "metric_source_connections_end_link"]) {
    await refuses((c) => c.query(`create or replace function training_load.${name}() returns trigger as $$ begin return new; end; $$ language plpgsql`),
      /^v50 rollback refused: a body in force is not v50's$/);
  }
  assert.match(await fsp.readFile(path.join(ROOT, "backend", "src", "migrate.js"), "utf8"), /export const MIGRATION_LOCK_KEY = 822026n;/);
  const migrator = await client(rdb.url);
  try {
    await migrator.query("select pg_advisory_lock(822026)");
    await refuses(null, /^v50 rollback refused: the migrator is running$/);
  } finally {
    await migrator.query("select pg_advisory_unlock(822026)").catch(() => {});
    await migrator.end();
  }
  for (const file of [ROLLBACK, PREFLIGHT, POSTCHECK, V50_FILE]) {
    assert.ok(!(await fsp.readFile(file, "utf8")).includes("\r"), `${path.basename(file)} has LF line endings`);
  }
});

test("5. the rollback returns v49's catalog exactly (comments included; v48's body of the revision guard byte for byte) and changes no row; v50 then applies again to the same catalog; a v50 whose last statement fails leaves nothing", async () => {
  const before = (await one(r, `select count(*)::int as n from training_load.source_metric_audit`)).n;
  await r.query(await fsp.readFile(ROLLBACK, "utf8"));
  assert.deepEqual(await catalog(r), W.before49, "v49's catalog");
  assert.equal(await prosrc(r, "source_metric_audit_revision_guard"), W.v48Body);
  assert.equal((await one(r, `select count(*)::int as n from training_load.source_metric_audit`)).n, before);
  const failing = `${await fsp.readFile(V50_FILE, "utf8")}\nselect 1 / 0;\n`;
  await assert.rejects(migrate(rdb.url, UP_TO_V49, { extra: { name: V50, text: failing } }));
  assert.deepEqual(await catalog(r), W.before49, "a failing v50 leaves nothing");
  await migrate(rdb.url, [...UP_TO_V49, V50]);
  assert.deepEqual(await catalog(r), W.after50, "v50 again");
});

// ---------------------------------------------------------------------------
// The behaviour database (through v50).
// ---------------------------------------------------------------------------
test("6. the database guard, in direct SQL: no actor, a club admin, a keyless or club-owned connection, keys or an owner change in the ending statement, an active binding of the owner team, an open activation on its ended binding, a held team lock, a missing audit row at COMMIT - each refused; an ended instance is final; `set state = state` passes; an INSERT is untouched", async () => {
  const pa = W.pa.id;
  // The importer's INSERT (keyless, no actor) is untouched.
  const freshTeam = await team(W.clubA);
  const keyless = (await one(k, `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1) returning id`, [freshTeam])).id;
  const inst = await instance();
  refusedWith(await tx(null, (c) => endSql(c, inst.connectionId)), "42501", NO_ACTOR);
  refusedWith(await tx(W.caA.id, (c) => endSql(c, inst.connectionId)), "42501", MAY_NOT_END);
  refusedWith(await tx(W.plain.id, (c) => endSql(c, inst.connectionId)), "42501", MAY_NOT_END);
  refusedWith(await tx(pa, (c) => endSql(c, keyless)), "23514", ONLY_TEAM);
  const clubKeyed = (await one(k, `insert into training_load.metric_source_connections (source_system, owner_scope, owner_club_id, source_host_key, source_instance_key)
                                    values ('gpexe','club',$1,'server3',$2) returning id`, [W.clubA, nextSourceTeam()])).id;
  refusedWith(await tx(pa, (c) => endSql(c, clubKeyed)), "23514", ONLY_TEAM);
  refusedWith(await tx(pa, (c) => c.query(`update training_load.metric_source_connections set source_host_key = 'server3', source_instance_key = $2, state = 'inactive' where id = $1`, [keyless, nextSourceTeam()])),
    "23514", ONLY_TEAM);
  refusedWith(await tx(pa, (c) => c.query(`update training_load.metric_source_connections set owner_team_id = $2, state = 'inactive' where id = $1`, [inst.connectionId, freshTeam])),
    "23514", ONLY_TEAM);
  // `set state = state` is no state change: no guard, no link, no actor needed.
  assert.equal((await tx(null, (c) => c.query(`update training_load.metric_source_connections set state = state where id = $1`, [inst.connectionId]))).ok, true);
  // An active binding of the owner team; then an open activation on its ended binding (C58).
  const bound = await instance({ binding: "active" });
  refusedWith(await tx(pa, async (c) => { await endSql(c, bound.connectionId); await auditSql(c, bound); }), "23514", BINDING_ACTIVE);
  await unbind(bound.bindingId);
  const activationId = await rawActivation(bound.bindingId, bound.teamId);
  refusedWith(await tx(pa, async (c) => { await endSql(c, bound.connectionId); await auditSql(c, bound); }), "23514", ACTIVATION_OPEN);
  await dropRawActivation(activationId);
  // Another session holds the owner team's import lock: the guard's own try-lock refuses (a raw writer).
  const holder = await client();
  try {
    await holder.query("begin");
    await holder.query(teamLockSql, [inst.teamId]);
    refusedWith(await tx(pa, async (c) => { await endSql(c, inst.connectionId); await auditSql(c, inst); }), "P0001", TEAM_LOCK);
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  // No audit row: the deferred link refuses at COMMIT.
  refusedWith(await tx(pa, (c) => endSql(c, inst.connectionId)), "23514", END_LINK);
  assert.equal((await connectionRow(inst.connectionId)).state, "active", "nothing written");
  // The end with its audit row; then the instance is final, whoever asks.
  assert.equal((await tx(pa, async (c) => { await endSql(c, inst.connectionId); await auditSql(c, inst); })).ok, true);
  assert.equal((await connectionRow(inst.connectionId)).state, "inactive");
  for (const actor of [pa, null]) {
    refusedWith(await tx(actor, (c) => c.query(`update training_load.metric_source_connections set state = 'active' where id = $1`, [inst.connectionId])), "23514", FINAL);
  }
  // Both ends of `bound` (no binding, no activation now) and of a fresh one stay possible for the T8 tests.
  W.ended6 = inst;
});

test("7. the T8 branch, in direct SQL: the audit row follows its own end in the same transaction (never an earlier end, never a savepoint's), once, by the acting platform admin, naming the owner team, with a reason and no evidence; the once-index makes it physical", async () => {
  const pa = W.pa.id;
  // An end ended in an earlier transaction gets no new row.
  refusedWith(await tx(pa, (c) => auditSql(c, W.ended6, { requestKey: key() })), "23514", AUDIT_FOLLOWS);
  // A row without an end in this transaction; a row written in this transaction without an end (`set state = state`).
  const inst = await instance();
  refusedWith(await tx(pa, (c) => auditSql(c, inst)), "23514", AUDIT_FOLLOWS);
  refusedWith(await tx(pa, async (c) => { await c.query(`update training_load.metric_source_connections set state = state where id = $1`, [inst.connectionId]); await auditSql(c, inst); }), "23514", AUDIT_FOLLOWS);
  // The end inside a savepoint (its row carries the subtransaction's id).
  refusedWith(await tx(pa, async (c) => { await c.query("savepoint s"); await endSql(c, inst.connectionId); await c.query("release savepoint s"); await auditSql(c, inst); }), "23514", AUDIT_FOLLOWS);
  // Another team, no team, evidence.
  refusedWith(await tx(pa, async (c) => { await endSql(c, inst.connectionId); await auditSql(c, inst, { teamId: await team(W.clubA) }); }), "23514", AUDIT_FOLLOWS);
  refusedWith(await tx(pa, async (c) => { await endSql(c, inst.connectionId); await auditSql(c, inst, { teamId: null }); }), "23514", AUDIT_FOLLOWS);
  refusedWith(await tx(pa, async (c) => { await endSql(c, inst.connectionId); await auditSql(c, inst, { evidenceRef: COMPAT }); }), "23514", AUDIT_FOLLOWS);
  // Another user than the acting one, or another basis.
  refusedWith(await tx(pa, async (c) => { await endSql(c, inst.connectionId); await auditSql(c, inst, { by: W.pa2.id }); }), "42501");
  // Another basis: v48's insert guard refuses a club-admin row that names no club mapping first.
  refusedWith(await tx(pa, async (c) => { await endSql(c, inst.connectionId); await auditSql(c, inst, { basis: "club_admin" }); }), "23514", /^source_metric_audit: a club-admin row names a club mapping$/);
  // A club admin who sets the actor and writes the row alone: v48's actor guard or the branch refuses.
  const byClubAdmin = await tx(W.caA.id, (c) => auditSql(c, inst, { by: W.caA.id }));
  refusedWith(byClubAdmin, "42501");
  // Twice in one transaction: the branch refuses the second.
  refusedWith(await tx(pa, async (c) => { await endSql(c, inst.connectionId); await auditSql(c, inst); await auditSql(c, inst); }), "23514", AUDIT_ONCE);
  assert.equal((await connectionRow(inst.connectionId)).state, "active", "nothing written");
  assert.equal((await endRows(inst.connectionId)).length, 0);
  // The index itself (the branch off for the proof).
  await k.query("begin");
  try {
    await k.query("set local session_replication_role = replica");
    await auditSql(k, inst);
    await assert.rejects(auditSql(k, inst), (e) => e.code === "23505" && e.constraint === "source_metric_audit_v50_instance_end_once");
  } finally {
    await k.query("rollback");
  }
  // The legitimate end passes the branch.
  assert.equal((await tx(pa, async (c) => { await endSql(c, inst.connectionId); await auditSql(c, inst); })).ok, true);
  assert.equal((await endRows(inst.connectionId)).length, 1);
});

test("8. the audience: 401 without a session; the identical 404 before the query or the body for a club admin, a platform admin in a club workspace, a coach and a user with no role; for the platform admin 415, a non-object body 400, a malformed or unknown id the identical 404, and every wrong body shape 400 - nothing written", async () => {
  const inst = await instance();
  assert.equal((await api("/source-instances")).status, 401);
  assert.equal((await post(endPath(inst), null, endBody(inst))).status, 401);
  for (const who of [W.caA, W.paA, W.coachA, W.plain]) {
    isNotFound(await list(who), "list");
    isNotFound(await list(who, "?state=bogus&toString=1"), "list with a bad query");
    isNotFound(await post(endPath(inst), who.cookie, "not json", { contentType: "text/plain" }), "before 415");
    isNotFound(await post(endPath(inst), who.cookie, []), "before 400");
    isNotFound(await endIt(who, inst), "the end");
  }
  assert.equal((await post(endPath(inst), W.pa.cookie, "x", { contentType: "text/plain" })).status, 415);
  refused(await post(endPath(inst), W.pa.cookie, []), 400, "invalid_body");
  isNotFound(await post("/source-instances/not-a-uuid/end", W.pa.cookie, endBody(inst)), "a malformed id");
  isNotFound(await endIt(W.pa, crypto.randomUUID(), { expected: inst.expected }), "an unknown id");
  const good = endBody(inst);
  for (const [label, body] of [
    ["an extra field", { ...good, state: "inactive" }],
    ["no requestKey", { reason: good.reason, expected: good.expected }],
    ["no reason", { requestKey: good.requestKey, expected: good.expected }],
    ["no expected", { requestKey: good.requestKey, reason: good.reason }],
    ["a bad requestKey", { ...good, requestKey: "x" }],
    ["an empty reason", { ...good, reason: "" }],
    ["a padded reason", { ...good, reason: " End. " }],
    ["a long reason", { ...good, reason: "x".repeat(501) }],
    ["a two-line reason", { ...good, reason: "End.\nNow." }],
    ["expected as an array", { ...good, expected: [] }],
    ["expected null", { ...good, expected: null }],
    ["expected with an extra key", { ...good, expected: { ...good.expected, state: "active" } }],
    ["expected missing a key", { ...good, expected: { sourceSystem: "gpexe", sourceHostKey: "server3" } }],
    ["a bad source system", { ...good, expected: { ...good.expected, sourceSystem: "GPEXE" } }],
    ["a bad host", { ...good, expected: { ...good.expected, sourceHostKey: "Server 3" } }],
    ["a bad instance key", { ...good, expected: { ...good.expected, sourceInstanceKey: "a b" } }],
    ["a numeric instance key", { ...good, expected: { ...good.expected, sourceInstanceKey: 960001 } }],
  ]) refused(await post(endPath(inst), W.pa.cookie, body), 400, "invalid_body", label);
  assert.equal((await connectionRow(inst.connectionId)).state, "active", "nothing written");
  assert.equal((await endRows(inst.connectionId)).length, 0);
});

test("9. the refusals of the end, in J13's order, each with exactly its `current` keys: instance_not_held (a keyless or club-owned connection), instance_mismatch, instance_binding_active, instance_in_use (an open activation on the owner team's ended binding), instance_already_ended - nothing written by any; a keyless connection that becomes an instance before the re-read answers try_again; a binding on another host names neither the instance nor its use", async () => {
  const keyless = (await one(k, `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1) returning id`, [await team(W.clubA)])).id;
  const clubKeyed = (await one(k, `insert into training_load.metric_source_connections (source_system, owner_scope, owner_club_id, source_host_key, source_instance_key)
                                    values ('gpexe','club',$1,'server3',$2) returning id`, [W.clubA, nextSourceTeam()])).id;
  for (const id of [keyless, clubKeyed]) {
    const body = refused(await endIt(W.pa, id, { expected: { sourceSystem: "gpexe", sourceHostKey: "server3", sourceInstanceKey: "1" } }), 409, "instance_not_held");
    assert.deepEqual(body.current, { id });
    assert.equal((await connectionRow(id)).state, "active");
  }
  // Keyless at the plain read, an instance by the re-read after the right (T7 keys written meanwhile): try_again.
  const keyedLater = (await one(k, `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1) returning id`, [await team(W.clubA)])).id;
  const laterKey = nextSourceTeam();
  let held = false;
  service.setMappingRightsHoldForTests(async () => {
    if (held) return;
    held = true;
    await k.query(`update training_load.metric_source_connections set source_host_key = 'server3', source_instance_key = $2 where id = $1`, [keyedLater, laterKey]);
  });
  refused(await endIt(W.pa, keyedLater, { expected: { sourceSystem: "gpexe", sourceHostKey: "server3", sourceInstanceKey: laterKey } }), 409, "try_again");
  service.setMappingRightsHoldForTests(null);
  assert.equal((await connectionRow(keyedLater)).state, "active");
  const inst = await instance({ binding: "active" });
  const activationId = await rawActivation(inst.bindingId, inst.teamId);
  // A stale screen comes first; the row as listed.
  for (const wrong of [{ sourceSystem: "other" }, { sourceHostKey: "e03" }, { sourceInstanceKey: "1" }]) {
    const body = refused(await endIt(W.pa, inst, { expected: { ...inst.expected, ...wrong } }), 409, "instance_mismatch");
    assert.deepEqual(keysOf(body.current), LIST_KEYS);
    assert.deepEqual([body.current.id, body.current.state, body.current.ownerTeamId, body.current.held, body.current.endedAt], [inst.connectionId, "active", inst.teamId, false, null]);
  }
  // The active binding before the open activation.
  let body = refused(await endIt(W.pa, inst), 409, "instance_binding_active");
  assert.deepEqual(body.current, { bindingId: inst.bindingId, teamId: inst.teamId });
  await unbind(inst.bindingId);
  body = refused(await endIt(W.pa, inst), 409, "instance_in_use");
  assert.deepEqual(body.current, { activationId, bindingId: inst.bindingId });
  // Several open activations: the lowest id is named.
  const second = await rawActivation(inst.bindingId, inst.teamId);
  body = refused(await endIt(W.pa, inst), 409, "instance_in_use");
  assert.equal(body.current.activationId, [activationId, second].sort()[0]);
  await dropRawActivation(activationId);
  await dropRawActivation(second);
  assert.equal((await connectionRow(inst.connectionId)).state, "active", "nothing written");
  assert.equal((await endRows(inst.connectionId)).length, 0);
  // The end; then a mismatch still comes before instance_already_ended.
  ok(await endIt(W.pa, inst));
  refused(await endIt(W.pa, inst, { expected: { ...inst.expected, sourceInstanceKey: "1" } }), 409, "instance_mismatch");
  body = refused(await endIt(W.pa, inst), 409, "instance_already_ended");
  assert.deepEqual(keysOf(body.current), LIST_KEYS);
  assert.deepEqual([body.current.state, body.current.held], ["inactive", false]);
  assert.ok(body.current.endedAt);
  assert.equal((await endRows(inst.connectionId)).length, 1, "one audit row");
  // An active binding of the owner team to the same source team id on ANOTHER host (another source instance), with an
  // open activation on it, names neither this instance nor its use: the end passes, in the route and in the guard.
  const other = await instance();
  const e03 = await raw(async (c) => (await one(c,
    `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state)
     values ('gpexe','club',$1,'e03',$2,'exchanged_token',$3,'not_connected') returning id`, [W.clubA, ACCOUNT_LABEL, W.pa.id])).id);
  const e03Binding = await raw(async (c) => (await one(c,
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe',$3,$4) returning id`,
    [other.teamId, e03, other.sourceTeamId, W.pa.id])).id);
  await rawActivation(e03Binding, other.teamId);
  assert.equal(ok(await endIt(W.pa, other)).instance.state, "inactive");
});

test("10. the end: 200 { instance, replayed } with the row as listed; only the connection's state and its audit row change - every other training_load table byte-identical, an event of the instance still pointing to it; the replay, request_key_reused, a lost COMMIT verified, an unknown outcome repeated with the same key written once, and a missing audit row refused at COMMIT as a sanitized 500 with the key still free", async () => {
  const inst = await instance();
  const eventId = (await one(k, `insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_team_id, source_connection_id, source_external_id, event_timezone_snapshot)
                                  values ('7g event','2026-10-01','2026-10-01T10:00:00Z','session','team',$1,$2,'team_session:7001',$3) returning id`, [inst.teamId, inst.connectionId, TZ])).id;
  const tables = await otherTables();
  const before = await connectionRow(inst.connectionId);
  const body = endBody(inst);
  const res = ok(await post(endPath(inst), W.pa.cookie, body));
  assert.deepEqual(keysOf(res), ["instance", "replayed"]);
  assert.equal(res.replayed, false);
  assert.deepEqual(keysOf(res.instance), LIST_KEYS);
  assert.deepEqual([res.instance.id, res.instance.state, res.instance.sourceSystem, res.instance.sourceHostKey, res.instance.sourceInstanceKey, res.instance.ownerTeamId, res.instance.held],
    [inst.connectionId, "inactive", "gpexe", "server3", inst.sourceTeamId, inst.teamId, false]);
  assert.ok(res.instance.endedAt && res.instance.createdAt && res.instance.ownerTeamName);
  const afterRow = await connectionRow(inst.connectionId);
  assert.deepEqual({ ...afterRow, state: "active" }, before, "only the state changed");
  assert.equal(afterRow.state, "inactive");
  assert.deepEqual(await otherTables(), tables, "every other training_load table byte-identical");
  assert.equal((await one(k, `select source_connection_id from training_load.metric_events where id = $1`, [eventId])).source_connection_id, inst.connectionId);
  const [audit] = await endRows(inst.connectionId);
  assert.deepEqual([audit.team_id, audit.from_status, audit.to_status, audit.reason, audit.evidence_ref, audit.performed_by_user_id, audit.basis, audit.request_key],
    [inst.teamId, "active", "inactive", body.reason, null, W.pa.id, "platform_admin", body.requestKey]);
  // The replay; the same key for another request.
  const replay = ok(await post(endPath(inst), W.pa.cookie, body));
  assert.deepEqual([replay.replayed, replay.instance], [true, res.instance]);
  refused(await post(endPath(inst), W.pa.cookie, { ...body, reason: reasonFor("Another reason.") }), 409, "request_key_reused");
  refused(await post(endPath(inst), W.pa.cookie, { ...body, expected: { ...body.expected, sourceInstanceKey: "1" } }), 409, "request_key_reused");
  // A replay after the right is gone: the identical 404.
  const lostRight = await instance();
  const b2 = endBody(lostRight);
  ok(await post(endPath(lostRight), W.pa2.cookie, b2));
  await k.query(`update public.user_global_roles set is_active = false where user_id = $1`, [W.pa2.id]);
  try {
    isNotFound(await post(endPath(lostRight), W.pa2.cookie, b2), "a replay without the right");
  } finally {
    await k.query(`update public.user_global_roles set is_active = true where user_id = $1`, [W.pa2.id]);
  }
  // The COMMIT.
  const lost = await instance();
  service.setMappingCommitForTests({ fault: (c) => c.query("commit").then(() => { throw new Error("answer lost"); }), timeoutMs: 2_000 });
  const lostRes = await endIt(W.pa, lost);
  service.setMappingCommitForTests();
  assert.deepEqual([lostRes.status, lostRes.body.commitConfirmation, lostRes.body.replayed, lostRes.body.instance?.state], [200, "verified_after_commit_error", false, "inactive"]);
  const unknown = await instance();
  const unknownBody = endBody(unknown);
  service.setMappingCommitForTests({ fault: () => Promise.reject(new Error("socket gone")), timeoutMs: 2_000 });
  const unknownRes = await post(endPath(unknown), W.pa.cookie, unknownBody);
  service.setMappingCommitForTests();
  assert.deepEqual([unknownRes.status, unknownRes.body.error, unknownRes.body.requestKey], [503, "outcome_unknown", unknownBody.requestKey]);
  ok(await post(endPath(unknown), W.pa.cookie, unknownBody));
  assert.equal(ok(await post(endPath(unknown), W.pa.cookie, unknownBody)).replayed, true);
  assert.equal((await endRows(unknown.connectionId)).length, 1, "written once");
  // No audit row: v50's deferred link refuses the COMMIT; nothing written, the key free.
  const linkless = await instance();
  const linkBody = endBody(linkless);
  instances.setInstanceSeamsForTests({ skipAudit: true });
  refused(await post(endPath(linkless), W.pa.cookie, linkBody), 500, "internal_error");
  instances.setInstanceSeamsForTests();
  assert.equal((await connectionRow(linkless.connectionId)).state, "active", "nothing written");
  assert.equal(ok(await post(endPath(linkless), W.pa.cookie, linkBody)).replayed, false, "the key was free");
});

test("11. concurrency: the owner team's import lock held by a bind, an Unbind or a check answers try_again from the try-lock; a bind that committed first answers instance_binding_active; an owner changed between the plain read and the lock answers try_again; while the end holds the lock a raw bind is refused by v24's lock; a FOR SHARE holder of the connection makes the end wait (bounded: try_again) or finish after it; a T6-shaped FOR SHARE of the binding and then the connection never waits on the end's bindings and leads to no deadlock; S1 on the owner team's ended binding during the end does not wait", async () => {
  // A check or import running for the owner team (the team key held).
  const inst = await instance();
  const holder = await client();
  try {
    await holder.query("begin");
    await holder.query(teamLockSql, [inst.teamId]);
    const res = refused(await endIt(W.pa, inst), 409, "try_again");
    assert.equal(res.current, undefined);
    assert.equal((await connectionRow(inst.connectionId)).state, "active");
    await holder.query("rollback");
    // A bind of the owner team to the same source team in flight (its trigger holds the key).
    await holder.query("begin");
    const rebound = await bind(inst.teamId, inst.sourceTeamId, W.clubA, holder);
    refused(await endIt(W.pa, inst), 409, "try_again");
    await holder.query("commit");
    // The bind committed first: instance_binding_active.
    assert.deepEqual(refused(await endIt(W.pa, inst), 409, "instance_binding_active").current, { bindingId: rebound, teamId: inst.teamId });
    // An Unbind in flight: try_again; after it, the end.
    await holder.query("begin");
    await unbind(rebound, holder);
    refused(await endIt(W.pa, inst), 409, "try_again");
    await holder.query("commit");
    // The end holds the lock: a raw bind of the owner team is refused by the binding trigger's try-lock.
    const { g, state } = holdEnd("write");
    const ending = endIt(W.pa, inst);
    await until(() => state.entered, "the end holds its locks");
    await holder.query("begin");
    await assert.rejects(bind(inst.teamId, inst.sourceTeamId, W.clubA, holder), (e) => e.code === "P0001" && TEAM_LOCK.test(e.message));
    await holder.query("rollback");
    g.open();
    assert.equal(ok(await ending).instance.state, "inactive");
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  // A FOR SHARE holder of the connection (an import in flight, C57): bounded, then after it.
  const shared = await instance();
  const reader = await client();
  try {
    await reader.query("begin");
    await reader.query(`select 1 from training_load.metric_source_connections where id = $1 for share`, [shared.connectionId]);
    refused(await endIt(W.pa, shared), 409, "try_again");
    const waiting = endIt(W.pa, shared);
    assert.equal(await someoneWaits(k), true, "the end waits for the reader");
    await reader.query("commit");
    assert.equal(ok(await waiting).instance.state, "inactive");
  } finally {
    await reader.query("rollback").catch(() => {});
    await reader.end();
  }
  // The owner changed between the plain read and the lock (v11 allows it on a connection no fact uses): try_again, nothing written.
  const moved = await instance();
  const newOwner = await team(W.clubA);
  instances.setInstanceSeamsForTests({ afterBindings: async () => {
    await k.query(`update training_load.metric_source_connections set owner_team_id = $2 where id = $1`, [moved.connectionId, newOwner]);
  } });
  refused(await endIt(W.pa, moved), 409, "try_again");
  instances.setInstanceSeamsForTests();
  assert.deepEqual([(await connectionRow(moved.connectionId)).state, (await endRows(moved.connectionId)).length], ["active", 0]);
  // A T6-shaped writer (binding FOR SHARE, then the connection FOR SHARE) while the end sits between its bindings and its connection.
  const t6 = await instance();
  const writer = await client();
  try {
    const { g, state } = holdEnd("bindings");
    const ending = endIt(W.pa, t6);
    await until(() => state.entered, "the end holds the bindings");
    await writer.query("begin");
    await writer.query(`select 1 from training_load.source_team_bindings where id = $1 for share`, [t6.bindingId]);
    assert.equal(await someoneWaits(k, 300), false, "the binding FOR SHARE does not wait on the end");
    await writer.query(`select 1 from training_load.metric_source_connections where id = $1 for share`, [t6.connectionId]);
    g.open();
    assert.equal(await someoneWaits(k), true, "the end now waits for the connection");
    await writer.query("commit");
    assert.equal(ok(await ending).instance.state, "inactive");
  } finally {
    await writer.query("rollback").catch(() => {});
    await writer.end();
  }
  // S1 on the owner team's ended binding while the end holds every lock: refused at once, no wait
  // (another platform admin: the same user's second write would wait on the per-user lock).
  const v = await sysVersion();
  const s1 = await instance();
  const { g, state } = holdEnd("write");
  const ending = endIt(W.pa, s1);
  await until(() => state.entered, "the end holds its locks");
  const started = Date.now();
  refused(await startS1(v, s1.bindingId, W.pa2), 409, "binding_not_active");
  assert.ok(Date.now() - started < 1_500, "S1 did not wait");
  g.open();
  assert.equal(ok(await ending).instance.state, "inactive");
  // A real S1 on the active binding, then an Unbind (C58): the open activation keeps the instance in use until S2 ends it.
  const used = await instance({ binding: "active" });
  const act = ok(await startS1(v, used.bindingId), 201).activations[0];
  refused(await endIt(W.pa, used), 409, "instance_binding_active");
  await unbind(used.bindingId);
  assert.deepEqual(refused(await endIt(W.pa, used), 409, "instance_in_use").current, { activationId: act.id, bindingId: used.bindingId });
  ok(await post(`/activations/${act.id}/end`, W.pa.cookie, { requestKey: key(), expectedState: "open", reason: reasonFor("End the activation.") }));
  assert.equal(ok(await endIt(W.pa, used)).instance.state, "inactive");
  assert.equal(logLines.filter((l) => /40P01/.test(l)).length, 0, "no deadlock");
});

test("12. the list: only team-owned connections that hold an instance, active by default, inactive or all on request, by sourceSystem; held true only for an active instance another team's active binding names (the same system, host and source team); endedAt from the audit row; pages of 100 by an opaque cursor; every bad query 400", async () => {
  const pageOf = async (query) => ok(await list(W.pa, query));
  const all = async (query = "?state=all") => {
    const out = [];
    let cursor = null;
    do {
      const page = await pageOf(`${query}${cursor ? `&cursor=${cursor}` : ""}`);
      for (const row of page.instances) assert.deepEqual(keysOf(row), LIST_KEYS);
      out.push(...page.instances);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  };
  const everything = await all();
  const ids = everything.map((x) => x.id);
  assert.deepEqual(ids, [...ids].sort(), "by id");
  const keyedTeam = await rows(k, `select id from training_load.metric_source_connections where owner_scope = 'team' and source_host_key is not null order by id`);
  assert.deepEqual(ids, keyedTeam.map((x) => x.id), "every team-owned keyed connection and nothing else");
  const active = await all("?state=active");
  assert.deepEqual(active, everything.filter((x) => x.state === "active"));
  assert.deepEqual(await all("?state=inactive"), everything.filter((x) => x.state === "inactive"));
  assert.deepEqual((await all("?sourceSystem=gpexe&state=all")).map((x) => x.id), ids);
  assert.deepEqual((await pageOf("?sourceSystem=unknown_system")).instances, []);
  assert.deepEqual(keysOf(await pageOf("")), ["instances", "nextCursor"]);
  // held: another team's active binding of the same source team; false for the owner team's own, for another host, and for an ended instance.
  const heldInst = await instance();
  const foreign = await rawForeignBinding(heldInst.sourceTeamId);
  const ownActive = await instance({ binding: "active" });
  const otherHost = await instance();
  const otherHostTeam = await team(W.clubB);
  const otherHostConnection = await raw(async (c) => (await one(c,
    `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state)
     values ('gpexe','club',$1,'e03',$2,'exchanged_token',$3,'not_connected') returning id`, [W.clubB, ACCOUNT_LABEL, W.pa.id])).id);
  await raw((c) => c.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe',$3,$4)`,
    [otherHostTeam, otherHostConnection, otherHost.sourceTeamId, W.pa.id]));
  const byId = async () => new Map((await all()).map((x) => [x.id, x]));
  let now = await byId();
  assert.deepEqual([now.get(heldInst.connectionId).held, now.get(ownActive.connectionId).held, now.get(otherHost.connectionId).held], [true, false, false]);
  ok(await endIt(W.pa, heldInst));
  now = await byId();
  assert.deepEqual([now.get(heldInst.connectionId).held, now.get(heldInst.connectionId).state], [false, "inactive"]);
  const [audit] = await endRows(heldInst.connectionId);
  assert.equal(new Date(now.get(heldInst.connectionId).endedAt).getTime(), new Date(audit.performed_at).getTime());
  assert.equal(now.get(ownActive.connectionId).endedAt, null);
  // Pages of 100: 101 instances of one source system.
  const pageTeam = await team(W.clubA);
  for (let i = 0; i < 101; i += 1) await keyedConnection(pageTeam, `p${i}`, { sourceSystem: "pagetest" });
  const first = await pageOf("?sourceSystem=pagetest");
  assert.equal(first.instances.length, 100);
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);
  const second = await pageOf(`?sourceSystem=pagetest&cursor=${first.nextCursor}`);
  assert.deepEqual([second.instances.length, second.nextCursor], [1, null]);
  assert.ok(second.instances[0].id > first.instances[99].id);
  // Every bad query.
  const foreignCursor = Buffer.from(JSON.stringify({ v: 1, k: "conversions", i: crypto.randomUUID() })).toString("base64url");
  const upperCursor = Buffer.from(JSON.stringify({ v: 1, k: "source_instances", i: crypto.randomUUID().toUpperCase() })).toString("base64url");
  for (const query of ["?state=bogus", "?state=", "?state=active&state=all", "?sourceSystem=GPEXE", "?sourceSystem=", "?toString=1", "?constructor=x", "?state[]=active",
    "?other=1", "?cursor=", "?cursor=***", `?cursor=${foreignCursor}`, `?cursor=${upperCursor}`, `?cursor=${first.nextCursor}&cursor=${first.nextCursor}`]) {
    refused(await list(W.pa, query), 400, "invalid_query");
  }
});

test("13. no answer carries a reason, an acting user, a credential part, an account label or a database text, and no log line a reason or a database text", async () => {
  // One more answer of each kind for the scan.
  const inst = await instance();
  ok(await endIt(W.pa, inst));
  ok(await list(W.pa, "?state=all"));
  const credentials = await rows(k, `select credential_ciphertext, credential_nonce, credential_auth_tag from training_load.source_credential_connections where credential_ciphertext is not null`);
  assert.ok(credentials.length > 0);
  const secrets = [ACCOUNT_LABEL];
  for (const c of credentials) {
    for (const part of [c.credential_ciphertext, c.credential_nonce, c.credential_auth_tag]) secrets.push(part.toString("hex"), part.toString("base64"));
  }
  const forbidden = [...sentReasons, ...secrets, "metric_source_connections:", "metric source connection:", "source_metric_audit:", "source instance:", "gpexe: a GPEXE check", "migrations_v2/"];
  const ours = responses.filter((x) => x.path.startsWith("/source-instances"));
  assert.ok(ours.length > 50, "the scan covers the answers of both routes");
  for (const { text } of responses) {
    for (const value of forbidden) assert.ok(!text.includes(value), `an answer carries ${value.slice(0, 40)}`);
  }
  // The answers of this phase's routes: no acting user, no key version, no reason or label field.
  for (const { text } of ours) {
    for (const value of [W.pa.id, W.pa2.id, "credential", "accountLabel", "account_label", "keyVersion", "requestHash", "request_hash", "performed"]) {
      assert.ok(!text.includes(value), `an answer of 7g carries ${value}`);
    }
    assert.ok(!/"reason"|"label"/.test(text), "no reason or label field");
  }
  for (const line of logLines) {
    for (const value of [...sentReasons, ...secrets, "metric_source_connections:", "metric source connection:", "source_metric_audit:", "source instance:"]) {
      assert.ok(!line.includes(value), `a log line carries ${value.slice(0, 40)}`);
    }
  }
});

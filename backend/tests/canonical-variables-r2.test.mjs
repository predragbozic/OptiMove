// R2 - renaming, archiving and restoring a canonical variable, with a team coach
// for club variables (backend/src/canonicalVariableAdminService.js, the routes
// POST /api/training-load/sources/metrics/variables/:id/rename|archive|restore and
// the team-workspace reads), and migration v38 (the widened request record, the
// change record written by the database, the basis, the key freeze). Through the
// real HTTP stack, on disposable optimove_tests_gpexe_* databases only (never
// OPTIMOVE): one migrated through v37 that rehearses v38's apply / rollback /
// re-apply, one migrated through v38 for the behaviour. Contract:
// docs/ai/gpexe-metric-variable-mapping-discovery.md, decision C99 and section J3b.
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
import { execFileSync } from "node:child_process";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { writeRevision } from "./support/source-revisions.mjs";
import { createDisposableDatabase } from "./support/disposable-db.mjs";
import { allowSyntheticTestFields } from "./support/test-extractors.mjs";

allowSyntheticTestFields();

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V38 = "202610271000_training_load_v38_metric_variable_changes.sql";
const V38_NAME = `migrations_v2/${V38}`;
const UP_TO_V37 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V38));
const MIGRATION_PATH = path.resolve(ROOT, "migrations_v2", V38);
const ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/metric-variable-changes-v38-rollback.sql");
const V37_ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/source-metric-revision-guards-v37-rollback.sql");
const V36_ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/metric-variable-requests-v36-rollback.sql");
const V35_ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/source-metric-mapping-v35-rollback.sql");
const PREFLIGHT_PATH = path.resolve(ROOT, "docs/runbooks/metric-variable-changes-v38-preflight.sql");
const POSTCHECK_PATH = path.resolve(ROOT, "docs/runbooks/metric-variable-changes-v38-postcheck.sql");
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const ch = (cp) => String.fromCodePoint(cp);
const NO_ACTOR = /no acting user is set for this transaction/;
const OTHER_USER = /^metric variable request: the row names another user than the acting user$/;
const MAY_NOT = /^metric variable request: the acting user may not write this owner scope$/;
const BASIS = /^metric variable request: the basis is not the acting user's own$/;
const FOLLOW = /^metric_variable_requests: the request must follow its own change in the same transaction$/;
const MISMATCH = /^metric_variable_requests: the change does not match the operation$/;
const TEXT_RULE = /^metric_variable_requests: a new label, short label or description is not bounded text$/;
const COACH_PINNED = /^metric_variable_requests: a team coach does not rename a pinned variable$/;
const COACH_RESTORE = /^metric_variable_requests: a team coach restores only a coach's archive$/;
const CHANGE_ONLY = /^metric_variable_changes: a change row is written only by the definition's own change$/;
const CHANGE_USER = /^metric_variable_changes: the row names another user than the acting user$/;
const REQUEST_LINK = /^metric_variable_changes: a change is written with its own request row$/;
const CHANGES_APPEND = /^metric_variable_changes: change records are append-only$/;
const REQUESTS_APPEND = /^metric_variable_requests: request records are append-only$/;
const KEY_FROZEN = /^metric_definitions: the key of a canonical variable never changes$/;
const PIN_GUARD = /^metric_definitions: an active mapping version pins the current version; disable it first$/;
const REDUCED = ["actions", "description", "editable", "icon", "id", "key", "label", "labelsToken", "ownerScope", "shortLabel", "state", "truncated"];

let rdb, db, r, k, k2, server, apiBase, service, variables, appPool, createSession;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};
const openGates = [];

async function applyV38(url) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v38-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of UP_TO_V37) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    await fsp.copyFile(MIGRATION_PATH, path.join(dir, V38));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

before(async () => {
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V38), "v38 is a test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v38rb", migrations: UP_TO_V37 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "r2" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  k2 = new pg.Client({ connectionString: db.url });
  await r.connect();
  await k.connect();
  await k2.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  assert.ok((await k.query(`select 1 from public.schema_migrations where migration_name = $1`, [V38_NAME])).rowCount === 1, "the behaviour database carries v38");
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.R2_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  variables = await import("../src/canonicalVariableAdminService.js");
  const dbModule = await import("../src/db.js");
  ({ createSession } = await import("../src/auth.js"));
  appPool = dbModule.pool;
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await world();
});

function resetSeams() {
  for (const g of openGates.splice(0)) g.open();
  service?.setMappingCommitForTests();
  service?.setMappingRightsHoldForTests(null);
  service?.setMappingRereadFaultForTests(null);
  variables?.setVariableWriteHoldForTests(null);
}
after(async () => {
  resetSeams();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) {
    let timer;
    await Promise.race([appPool.end(), new Promise((res) => { timer = setTimeout(res, 5_000); })]);
    clearTimeout(timer);
  }
  for (const c of [r, k, k2]) await c?.end().catch(() => {});
  await rdb?.drop();
  await db?.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});
afterEach(resetSeams);

// ---------------------------------------------------------------------------
// helpers
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const key = () => crypto.randomUUID();
const tokenOf = (label, shortLabel, description, state) => crypto.createHash("sha256").update(JSON.stringify([label, shortLabel, description, state]), "utf8").digest("hex");

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
const post = (p, cookie, body, opts = {}) => api(p, { method: "POST", cookie, body, ...opts });
const rename = (who, id, body) => post(`/variables/${id}/rename`, who.cookie, { requestKey: key(), ...body });
const archive = (who, id, body = {}) => post(`/variables/${id}/archive`, who.cookie, { requestKey: key(), reason: "No longer used", ...body });
const restore = (who, id, body = {}) => post(`/variables/${id}/restore`, who.cookie, { requestKey: key(), ...body });
async function view(who, id) {
  const res = await api(`/variables/${id}`, { cookie: who.cookie });
  assert.equal(res.status, 200, res.text);
  return res.body.variable;
}
async function created(cookie, over = {}) {
  const res = await post("/variables", cookie, { requestKey: key(), label: `Total distance ${uid()}`, unit: "m", levels: ["session", "drill"], dailyAggregationMethod: "sum", ...over });
  assert.equal(res.status, 201, res.text);
  return res.body.variable;
}
const ok200 = (res) => { assert.equal(res.status, 200, res.text); return res.body; };

async function user(label, { active = true } = {}) {
  return (await one(k, `insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,$3) returning id`, [`${label}-${uid()}@test.local`, label, active])).id;
}
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const team = async (clubId) => (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
async function person(label, { platform = false, clubAdminOf = [], coachOf = [], roleActive = true, ws }) {
  const id = await user(label);
  if (platform) await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  for (const c of clubAdminOf) await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, c]);
  for (const t of coachOf) await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',$3)`, [id, t, roleActive]);
  if (ws) await workspace(id, ws[0], ws[1]);
  return { id, cookie: await cookieFor(id) };
}

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
function refusedWith(res, code, pattern) {
  assert.equal(res.ok, false, `expected a refusal (${pattern})`);
  assert.equal(res.error.code, code, res.error.message);
  if (pattern) assert.match(res.error.message, pattern);
  return res.error;
}
const okTx = (res) => { assert.equal(res.ok, true, res.error ? `${res.error.code}: ${res.error.message}` : ""); return res.value; };
// A raw label or state change written as a fixture, with v38's change trigger
// off (and decision 9's guard too when asked), in one transaction.
async function rawDefinitionUpdate(sql, params, { pinGuardOff = false } = {}) {
  const triggers = ["metric_definitions_v38_record_change", ...(pinGuardOff ? ["metric_definitions_source_metric_guard"] : [])];
  await k.query("begin");
  try {
    for (const t of triggers) await k.query(`alter table training_load.metric_definitions disable trigger ${t}`);
    await k.query(sql, params);
    for (const t of triggers) await k.query(`alter table training_load.metric_definitions enable trigger ${t}`);
    await k.query("commit");
  } catch (error) {
    await k.query("rollback").catch(() => {});
    throw error;
  }
}
// A legitimate raw R2 write (what the service writes), inside a tx: the UPDATE,
// then the request naming the change row the trigger wrote.
async function rawChange(c, { defId, by, operation, set, basis, scope = "club", clubId = null, teamId = null, changeId, reason = null }) {
  await c.query(`update training_load.metric_definitions set ${set} where id = $1`, [defId]);
  const change = changeId ?? (await one(c, `select id from training_load.metric_variable_changes where metric_definition_id = $1 and xact_id = pg_current_xact_id()`, [defId]))?.id ?? null;
  await c.query(
    `insert into training_load.metric_variable_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, basis_team_id, metric_definition_id, metric_variable_change_id, reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [key(), by, operation, "0".repeat(64), scope, clubId, basis, teamId, defId, change, reason],
  );
  return change;
}

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  const g = { promise, open };
  openGates.push(g);
  return g;
}
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
async function until(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}
const someoneWaits = () => until(async () => (await one(k, `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`)).n > 0);

async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    tables: await rows(c, `select table_schema, table_name from information_schema.tables where table_schema in ${S} order by 1, 2`),
    columns: await rows(c, `select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ${S} order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, c.contype, c.condeferrable, c.condeferred, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    indexes: await rows(c, `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ${S} order by 1, 2, 3`),
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled, t.tgdeferrable, t.tginitdeferred from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
// The read-only runbook blocks: each statement's one row, merged.
async function runbook(c, file) {
  const text = (await fsp.readFile(file, "utf8")).split("\n").filter((line) => !line.startsWith("--")).join("\n");
  const out = {};
  for (const statement of text.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) Object.assign(out, (await c.query(statement)).rows[0]);
  return out;
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

// A mapping version of a variable in needs_review (activate() makes it active
// and so pins the variable's current version). The revision is written through
// the lifecycle's database path (v39; backend/tests/support/source-revisions.mjs),
// as the M3-0 suite does.
async function preparedMapping(variable, adminCookie) {
  const def = await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Test field',$2) returning id`, [`r2.test.f${uid()}`, W.pa.id]);
  const rev = { id: await writeRevision(k, {
    fieldId: def.id, by: W.pa.id, evidenceRef: COMPAT, unit: "m", unitRef: COMPAT, meaning: true, meaningRef: COMPAT,
  }) };
  const mapping = await post("/mappings", adminCookie, { requestKey: key(), sourceMetricId: def.id, metricDefinitionId: variable.id });
  assert.equal(mapping.status, 201, mapping.text);
  const mv = await post(`/mappings/${mapping.body.mapping.id}/versions`, adminCookie, { requestKey: key(), sourceRevisionId: rev.id, appliesToSession: true, appliesToDrill: false });
  assert.equal(mv.status, 201, mv.text);
  assert.equal((await post(`/mappings/${mapping.body.mapping.id}/versions/${mv.body.version.id}/submit`, adminCookie, { requestKey: key() })).status, 200);
  return { mappingId: mapping.body.mapping.id, versionId: mv.body.version.id };
}
async function activateIn(c, m) {
  await c.query(`update training_load.source_metric_mapping_versions set status = 'active', activated_by_user_id = $2, activated_at = now(), activated_basis = 'platform_admin' where id = $1`, [m.versionId, W.pa.id]);
  await c.query(`insert into training_load.source_metric_audit (action, mapping_id, mapping_version_id, from_status, to_status, performed_by_user_id, basis, operation_id) values ('mapping_status',$1,$2,'needs_review','active',$3,'platform_admin',$4)`,
    [m.mappingId, m.versionId, W.pa.id, crypto.randomUUID()]);
}
async function pinned(variable, adminCookie) {
  const m = await preparedMapping(variable, adminCookie);
  okTx(await tx(W.pa.id, (c) => activateIn(c, m)));
  return m;
}
const changesOf = (defId) => rows(k, `select c.*, r.operation, r.basis, r.basis_team_id, r.reason, r.requested_by_user_id from training_load.metric_variable_changes c left join training_load.metric_variable_requests r on r.metric_variable_change_id = c.id where c.metric_definition_id = $1 order by c.seq`, [defId]);
const defRow = (defId) => one(k, `select key, label, short_label, description, state, owner_scope, owner_club_id from training_load.metric_definitions where id = $1`, [defId]);

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.clubC = await club("Club C");
  W.teamA1 = await team(W.clubA);
  W.teamA2 = await team(W.clubA);
  W.teamB1 = await team(W.clubB);
  W.teamC = await team(W.clubC);
  W.teamNoClub = await team(null);
  W.teamArch = await team(W.clubA);
  W.pa = await person("platform-admin", { platform: true, ws: ["platform", null] });
  W.pa2 = await person("platform-admin-2", { platform: true, ws: ["platform", null] });
  W.paA = await person("platform-admin-a", { platform: true, clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.caA = await person("club-admin-a", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.caA2 = await person("club-admin-a2", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.caB = await person("club-admin-b", { clubAdminOf: [W.clubB], ws: ["club", W.clubB] });
  W.coachA1 = await person("coach-a1", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  W.coachA1b = await person("coach-a1b", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  W.coachA2 = await person("coach-a2", { coachOf: [W.teamA2], ws: ["team", W.teamA2] });
  W.coachB1 = await person("coach-b1", { coachOf: [W.teamB1], ws: ["team", W.teamB1] });
  W.coachC = await person("coach-c", { coachOf: [W.teamC], ws: ["team", W.teamC] });
  W.coachNoClub = await person("coach-noclub", { coachOf: [W.teamNoClub], ws: ["team", W.teamNoClub] });
  W.coachArch = await person("coach-archteam", { coachOf: [W.teamArch], ws: ["team", W.teamArch] });
  W.coachRevoked = await person("coach-revoked", { coachOf: [W.teamA1], roleActive: false, ws: ["team", W.teamA1] });
  W.caCoachA1 = await person("club-admin-coach", { clubAdminOf: [W.clubA], coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  W.paCoachA1 = await person("platform-admin-coach", { platform: true, coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  const athleteId = await user("athlete");
  await k.query(`insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active) values ($1,$1,'Athlete','Only','Athlete Only','Athlete Only',$2,true)`, [`r2${uid()}`, athleteId]);
  await workspace(athleteId, "athlete", null);
  W.athlete = { id: athleteId, cookie: await cookieFor(athleteId) };
  W.privateCoach = await person("private-coach", { platform: true, ws: ["private_coach", null] });
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [W.privateCoach.id]);
  await k.query(`update public.clubs set is_active = false where id = $1`, [W.clubC]);
  await k.query(`update public.teams set is_active = false where id = $1`, [W.teamArch]);
  W.sysVar = await created(W.pa.cookie);
  W.clubVarB = await created(W.caB.cookie);
}

// ---------------------------------------------------------------------------
test("1. migration v38 on v37: one table, four request columns (the version nullable), the widened checks under v36's names, seven functions and eight triggers (v36's guard gated by operation), nothing else changed; the rollback refuses without v38, under a later migration, with a trigger missing or disabled, and once a change row exists; it returns the identical v37 catalog and v38 applies again identically; the v37, v36 and v35 rollbacks refuse while v38 is recorded", async () => {
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v38 rollback refused: v38 is not recorded/);
  // The read-only preflight on v37 (no media migration in the test set, so the
  // last migration here is v37; production's is the media one).
  const pre = await runbook(r, PREFLIGHT_PATH);
  assert.deepEqual(
    [pre.pg13_or_later, pre.v37_rows, pre.v37_checksum_ok, pre.v36_checksum_ok, pre.v35_checksum_ok, pre.v38_rows, pre.at_or_after_v38, pre.functions_needed,
      pre.definition_triggers_enabled, pre.request_triggers_enabled, pre.disabled_triggers, pre.v38_table, pre.v38_columns, pre.v38_functions, pre.v38_triggers,
      pre.v38_indexes, pre.schema_create, pre.owns_definitions, pre.owns_requests, pre.references_users, pre.references_clubs, pre.references_teams,
      pre.rows_outside_v36, pre.rows_without_version, pre.rows_with_other_basis, pre.actor_defaults, pre.conflicting_locks],
    [true, "1", true, true, true, "0", "0", "4", "2", "3", "0", 0, "0", "0", "0", 0, true, true, true, true, true, true, "0", "0", "0", "0", "0"],
  );
  const before37 = await catalog(r);
  await applyV38(rdb.url);
  // The read-only post-check: its checksum is the file's, every object in place.
  const post38 = await runbook(r, POSTCHECK_PATH);
  assert.deepEqual(
    [post38.v38_rows, post38.v38_checksum_ok, post38.later_rows, post38.last_migration, post38.v37_rows, post38.v37_checksum_ok, post38.changes_table,
      post38.new_request_columns, post38.version_nullable, post38.v38_functions, post38.missing_functions, post38.v38_triggers, post38.v38_triggers_enabled,
      post38.deferred_links, post38.v36_guard_gated, post38.r2_guard_gated, post38.missing_triggers, post38.v38_indexes, post38.v38_indexes_valid,
      post38.v36_names, post38.v38_names, post38.operation_widened, post38.basis_widened, post38.change_rows, post38.r2_request_rows, post38.coach_rows,
      post38.actor_defaults],
    ["1", true, "0", V38_NAME, "1", true, 1, "3", "YES", "7", [], "8", "8", "1", true, true, [], "6", "6", "13", "9", true, true, "0", "0", "0", "0"],
  );
  const after38 = await catalog(r);
  assert.ok(after38.migrations.includes(V38_NAME));
  const added = (list, base, keyOf) => list.filter((x) => !base.some((y) => keyOf(y) === keyOf(x)));
  const changed = (list, base, keyOf) => list.filter((x) => base.some((y) => keyOf(y) === keyOf(x) && JSON.stringify(y) !== JSON.stringify(x)));
  assert.deepEqual(added(after38.tables, before37.tables, (x) => x.table_name).map((x) => x.table_name), ["metric_variable_changes"]);
  const colKey = (x) => `${x.table_name}.${x.column_name}`;
  assert.deepEqual(added(after38.columns, before37.columns, colKey).filter((x) => x.table_name === "metric_variable_requests").map((x) => x.column_name).sort(),
    ["basis_team_id", "metric_variable_change_id", "reason"]);
  assert.deepEqual(changed(after38.columns, before37.columns, colKey).map((x) => [colKey(x), x.is_nullable]), [["metric_variable_requests.metric_definition_version_id", "YES"]]);
  assert.deepEqual(before37.columns.filter((x) => x.table_name !== "metric_variable_requests"),
    after38.columns.filter((x) => !["metric_variable_requests", "metric_variable_changes"].includes(x.table_name)), "no other column changed");
  const conKey = (x) => `${x.rel}.${x.conname}`;
  assert.deepEqual(added(after38.constraints, before37.constraints, conKey).filter((x) => x.rel.endsWith("metric_variable_requests")).map((x) => x.conname).sort(), [
    "metric_variable_requests_archive_reason", "metric_variable_requests_basis_team_id_fkey", "metric_variable_requests_change_iff", "metric_variable_requests_metric_variable_change_id_fkey",
    "metric_variable_requests_one_per_change", "metric_variable_requests_reason_check", "metric_variable_requests_team_coach_shape",
    "metric_variable_requests_team_iff", "metric_variable_requests_version_iff",
  ]);
  assert.deepEqual(changed(after38.constraints, before37.constraints, conKey).map((x) => x.conname).sort(),
    ["metric_variable_requests_basis_check", "metric_variable_requests_operation_check"], "only the two widened checks change, under their v36 names");
  assert.deepEqual(before37.constraints.filter((x) => !x.rel.endsWith("metric_variable_requests")),
    after38.constraints.filter((x) => !x.rel.endsWith("metric_variable_requests") && !x.rel.endsWith("metric_variable_changes")), "no other constraint changed");
  assert.deepEqual(added(after38.indexes, before37.indexes, (x) => x.indexname).map((x) => x.indexname).sort(), [
    "metric_variable_changes_definition_idx", "metric_variable_changes_one_seq", "metric_variable_changes_pkey", "metric_variable_changes_user_idx",
    "metric_variable_requests_basis_team_idx", "metric_variable_requests_one_per_change",
  ]);
  assert.deepEqual(changed(after38.indexes, before37.indexes, (x) => x.indexname), [], "no index changed");
  assert.deepEqual(added(after38.functions, before37.functions, (x) => x.proname).map((x) => x.proname).sort(), [
    "metric_definitions_key_freeze", "metric_definitions_record_change", "metric_variable_change_basis", "metric_variable_changes_append_only",
    "metric_variable_changes_insert_guard", "metric_variable_changes_request_link", "metric_variable_requests_change_guard",
  ]);
  assert.deepEqual(changed(after38.functions, before37.functions, (x) => `${x.proname}(${x.args})`), [], "no existing function changed (v35's and v36's included)");
  const trgKey = (x) => `${x.relname}.${x.tgname}`;
  const newTriggers = added(after38.triggers, before37.triggers, trgKey);
  assert.deepEqual(newTriggers.map(trgKey).sort(), [
    "metric_definitions.metric_definitions_v38_key_freeze", "metric_definitions.metric_definitions_v38_record_change",
    "metric_variable_changes.metric_variable_changes_insert_guard", "metric_variable_changes.metric_variable_changes_no_truncate",
    "metric_variable_changes.metric_variable_changes_no_update_delete", "metric_variable_changes.metric_variable_changes_request_link",
    "metric_variable_requests.metric_variable_requests_change_guard",
  ]);
  for (const t of after38.triggers.filter((x) => ["metric_variable_changes", "metric_variable_requests"].includes(x.relname) || x.tgname.startsWith("metric_definitions_v38_"))) {
    assert.equal(t.tgenabled, "O", t.tgname);
  }
  const link = after38.triggers.find((x) => x.tgname === "metric_variable_changes_request_link");
  assert.deepEqual([link.tgdeferrable, link.tginitdeferred], [true, true]);
  const gated = changed(after38.triggers, before37.triggers, trgKey);
  assert.deepEqual(gated.map(trgKey), ["metric_variable_requests.metric_variable_requests_insert_guard"]);
  assert.match(gated[0].def, /WHEN \(\(new\.operation = ANY \(ARRAY\['variable_create'::text, 'variable_version_create'::text\]\)\)\) EXECUTE FUNCTION training_load\.metric_variable_requests_insert_guard\(\)$/);
  // v38 depends on v35's and v36's functions and on v37's being recorded before it.
  for (const [file, name] of [[V37_ROLLBACK_PATH, "v37"], [V36_ROLLBACK_PATH, "v36"], [V35_ROLLBACK_PATH, "v35"]]) {
    assert.match((await runScript(r, file))?.message ?? "", new RegExp(`^${name} rollback refused: .*later migrations are applied`), name);
  }
  // Refusals, each changing nothing.
  await r.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/202610271001_training_load_v39_test_only.sql', $1, 'test')`, ["0".repeat(64)]);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v38 rollback refused: later migrations are applied$/);
  await r.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/202610271001_training_load_v39_test_only.sql'`);
  for (const [rel, trigger] of [["metric_definitions", "metric_definitions_v38_record_change"], ["metric_variable_requests", "metric_variable_requests_change_guard"], ["metric_variable_changes", "metric_variable_changes_request_link"]]) {
    await r.query(`alter table training_load.${rel} disable trigger ${trigger}`);
    assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v38 rollback refused: a v38 trigger is disabled$/, trigger);
    await r.query(`alter table training_load.${rel} enable trigger ${trigger}`);
  }
  assert.deepEqual(await catalog(r), after38, "every refusal changed nothing");
  // The rehearsal: rollback -> the identical v37 catalog -> re-apply -> identical.
  assert.equal(await runScript(r, ROLLBACK_PATH), null);
  assert.deepEqual(await catalog(r), before37, "the rollback returns the v37 catalog exactly");
  await applyV38(rdb.url);
  assert.deepEqual(await catalog(r), after38, "v38 applies again identically");
  // Once a change row exists the rollback refuses (a legitimate rename, raw).
  const pa = (await one(r, `insert into public.users (email, full_name, display_name, is_active) values ($1,'pa','pa',true) returning id`, [`v38rb-${uid()}@test.local`])).id;
  await r.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [pa]);
  const def = (await one(r, `insert into training_load.metric_definitions (key, label, owner_scope) values ($1,'Raw','system') returning id`, [`raw_${uid()}`])).id;
  okTx(await tx(pa, (c) => rawChange(c, { defId: def, by: pa, operation: "variable_rename", set: "label = 'Renamed'", basis: "platform_admin", scope: "system" }), r));
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v38 rollback refused: change records exist$/);
});

test("2. who may do what: the platform admin on a system variable, the club's admin and a coach of an active team of the club (in that team's workspace) on a club variable rename, archive and restore with 200; a coach never writes a system variable; another club's coach, a team without a club, an archived team or club, a revoked role, an athlete and a private-coaching workspace get the byte-identical 404 on every variable route; a coach gets the same 404 on every admin-only route", async () => {
  const sys = await created(W.pa.cookie);
  const clubVar = await created(W.caA.cookie);
  const s1 = ok200(await rename(W.pa, sys.id, { labelsToken: sys.labelsToken, label: "System renamed" }));
  assert.equal(s1.variable.label, "System renamed");
  ok200(await archive(W.pa, sys.id));
  ok200(await restore(W.pa, sys.id));
  const c1 = ok200(await rename(W.caA, clubVar.id, { labelsToken: clubVar.labelsToken, label: "Club renamed" }));
  const c2 = ok200(await rename(W.coachA1, clubVar.id, { labelsToken: c1.variable.labelsToken, shortLabel: "CR" }));
  assert.deepEqual(Object.keys(c2.variable).sort(), REDUCED, "a coach's answer is the reduced view");
  ok200(await archive(W.coachA1, clubVar.id));
  ok200(await restore(W.coachA1, clubVar.id));
  ok200(await archive(W.paA, clubVar.id));
  ok200(await restore(W.paA, clubVar.id));
  // A coach reads the system variable as a reference but never writes it.
  const sysForCoach = await view(W.coachA1, sys.id);
  assert.deepEqual([sysForCoach.editable, sysForCoach.actions], [false, []]);
  const missing = await rename(W.coachA1, crypto.randomUUID(), { labelsToken: sysForCoach.labelsToken, label: "x" });
  assert.deepEqual([missing.status, missing.text], [404, '{"error":"notFound"}']);
  for (const res of [
    await rename(W.coachA1, sys.id, { labelsToken: sysForCoach.labelsToken, label: "Nope" }), await archive(W.coachA1, sys.id), await restore(W.coachA1, sys.id),
    await rename(W.caA, sys.id, { labelsToken: sysForCoach.labelsToken, label: "Nope" }),
  ]) assert.deepEqual([res.status, res.text], [404, missing.text]);
  // Everyone outside the audience: the same bytes on every variable route
  // (club B's coach reads club B's list, never club A's variable).
  assert.equal((await api("/variables", { cookie: W.coachB1.cookie })).status, 200);
  for (const who of [W.coachB1, W.coachNoClub, W.coachArch, W.coachC, W.coachRevoked, W.athlete, W.privateCoach]) {
    for (const p of [...(who === W.coachB1 ? [] : ["/variables", `/variables/${sys.id}`]), `/variables/${clubVar.id}`]) {
      const res = await api(p, { cookie: who.cookie });
      assert.deepEqual([res.status, res.text, res.headers.get("cache-control")], [404, missing.text, "no-store"], `${p}`);
    }
    for (const res of [await rename(who, clubVar.id, { labelsToken: c2.variable.labelsToken, label: "x" }), await archive(who, clubVar.id), await restore(who, clubVar.id)]) {
      assert.deepEqual([res.status, res.text], [404, missing.text]);
    }
  }
  assert.equal((await defRow(clubVar.id)).label, "Club renamed", "nothing written by a refused caller");
  // Another club's variable for a coach of club A: 404 (read and write).
  assert.deepEqual([(await api(`/variables/${W.clubVarB.id}`, { cookie: W.coachA1.cookie })).status, (await archive(W.coachA1, W.clubVarB.id)).text], [404, missing.text]);
  // A coach on the admin-only routes and on M2: the identical 404.
  for (const p of ["/variables/key-suggestion?label=Total%20distance", "/fields", "/targets", "/conversions", "/mappings"]) {
    assert.deepEqual([(await api(p, { cookie: W.coachA1.cookie })).text], [missing.text], p);
  }
  for (const [p, body] of [["/variables", { requestKey: key() }], [`/variables/${clubVar.id}/versions`, { requestKey: key() }], ["/mappings", { requestKey: key() }]]) {
    assert.deepEqual([(await post(p, W.coachA1.cookie, body)).text], [missing.text], p);
  }
  // No session: 401.
  assert.equal((await post(`/variables/${clubVar.id}/rename`, null, { requestKey: key() })).status, 401);
  // The resolver reads the team, club, role and user from the database, not
  // from the request's authorization snapshot: a role or a user deactivated
  // after the snapshot was loaded admits nothing.
  const { loadAuthorizationContext } = await import("../src/authz.js");
  const stale = await person("coach-stale", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  const staleUser = await one(k, `select * from public.users where id = $1`, [stale.id]);
  const req = { user: staleUser, authz: await loadAuthorizationContext(staleUser) };
  const live = await variables.resolveVariableEditor(req);
  assert.deepEqual([live.basis, live.teamId, live.owner], ["team_coach", W.teamA1, { scope: "club", clubId: W.clubA }]);
  await k.query(`update public.user_team_roles set is_active = false where user_id = $1`, [stale.id]);
  assert.equal(await variables.resolveVariableEditor(req), null, "a role revoked after the snapshot");
  await k.query(`update public.user_team_roles set is_active = true where user_id = $1`, [stale.id]);
  await k.query(`update public.users set is_active = false where id = $1`, [stale.id]);
  assert.equal(await variables.resolveVariableEditor(req), null, "a user deactivated after the snapshot");
  // The admin-only operations refuse a team workspace's context themselves too.
  const coachUser = await one(k, `select * from public.users where id = $1`, [W.coachA1.id]);
  const coachCtx = await variables.resolveVariableEditor({ user: coachUser, authz: await loadAuthorizationContext(coachUser) });
  for (const call of [
    () => variables.createVariable({ ctx: coachCtx, body: {} }),
    () => variables.createVariableVersion({ ctx: coachCtx, variableId: clubVar.id, body: {} }),
    () => variables.suggestKey({ ctx: coachCtx, query: { label: "x" } }),
  ]) await assert.rejects(call, (error) => error.status === 404);
});

test("3. the order of the answers: no right before the body (404 even for a bad body); 415 for a non-JSON body; 400 for a JSON body that is not an object; the identical 404 for a malformed id; 400 for an object of the wrong shape; a right lost during the request is 404, never a 409 that carries data", async () => {
  const v = await created(W.caA.cookie);
  const p = `/variables/${v.id}/rename`;
  // (A body that is not JSON at all is refused by the application's JSON
  // parser before any route - the same for every route, unchanged by R2.)
  assert.deepEqual([(await post(p, W.athlete.cookie, [1, 2])).text], ['{"error":"notFound"}']);
  assert.deepEqual([(await post(p, W.athlete.cookie, "x", { contentType: "text/plain" })).text], ['{"error":"notFound"}']);
  // Another club's coach has the route in its workspace: the body comes first,
  // the variable (step 6) after it.
  assert.deepEqual([(await post(p, W.coachB1.cookie, [1, 2])).body.error], ["invalid_body"]);
  assert.deepEqual([(await rename(W.coachB1, v.id, { labelsToken: v.labelsToken, label: "x" })).text], ['{"error":"notFound"}']);
  assert.deepEqual([(await post(p, W.coachA1.cookie, "x", { contentType: "text/plain" })).status], [415]);
  assert.deepEqual([(await post(p, W.coachA1.cookie, [1, 2])).status, (await post(p, W.coachA1.cookie, [1, 2])).body.error], [400, "invalid_body"]);
  assert.deepEqual([(await post("/variables/not-a-uuid/rename", W.coachA1.cookie, { requestKey: key() })).text], ['{"error":"notFound"}']);
  for (const [route, body] of [["rename", {}], ["rename", { requestKey: key(), labelsToken: v.labelsToken }], ["archive", { requestKey: key() }], ["restore", { requestKey: key(), extra: 1 }]]) {
    const res = await post(`/variables/${v.id}/${route}`, W.coachA1.cookie, body);
    assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], `${route} ${JSON.stringify(body)}`);
  }
  // The rights are checked again under FOR SHARE, before every 409: a stale
  // token (variable_changed carries the current view) answers 404 once the
  // coach's role is revoked during the request.
  const coach = await person("coach-revoked-mid", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  service.setMappingRightsHoldForTests(async () => {
    await k.query(`update public.user_team_roles set is_active = false where user_id = $1`, [coach.id]);
  });
  const lost = await rename(coach, v.id, { labelsToken: "0".repeat(64), label: "Stale" });
  service.setMappingRightsHoldForTests(null);
  assert.deepEqual([lost.status, lost.text], [404, '{"error":"notFound"}']);
  assert.equal((await changesOf(v.id)).length, 0, "nothing written");
  // The team, or the club, archived during the request: the same 404.
  const teamX = await team(W.clubA);
  const coachX = await person("coach-team-archived-mid", { coachOf: [teamX], ws: ["team", teamX] });
  service.setMappingRightsHoldForTests(async () => { await k.query(`update public.teams set is_active = false where id = $1`, [teamX]); });
  assert.deepEqual([(await archive(coachX, v.id)).text], ['{"error":"notFound"}']);
  const clubY = await club("Club Y");
  const teamY = await team(clubY);
  const adminY = await person("club-admin-y", { clubAdminOf: [clubY], ws: ["club", clubY] });
  const coachY = await person("coach-club-archived-mid", { coachOf: [teamY], ws: ["team", teamY] });
  const varY = await created(adminY.cookie);
  service.setMappingRightsHoldForTests(async () => { await k.query(`update public.clubs set is_active = false where id = $1`, [clubY]); });
  assert.deepEqual([(await archive(coachY, varY.id)).text], ['{"error":"notFound"}']);
  service.setMappingRightsHoldForTests(null);
  assert.deepEqual([(await changesOf(v.id)).length, (await changesOf(varY.id)).length], [0, 0], "nothing written");
});

test("4. reads: a team workspace reads the reduced view (Q7) on the list, the detail, every write answer, a replay, a verified lost COMMIT and variable_changed - never the versions, levels, mapping readiness or times; the admins keep their view and gain actions and labelsToken; actions follow the caller and the state; a coach's detail takes no cursor", async () => {
  const v = await created(W.caA.cookie);
  const list = ok200(await api("/variables", { cookie: W.coachA1.cookie }));
  assert.ok(list.variables.length > 0);
  for (const item of list.variables) assert.deepEqual(Object.keys(item).sort(), REDUCED);
  const sysList = ok200(await api("/variables?scope=system", { cookie: W.coachA1.cookie }));
  assert.ok(sysList.variables.some((x) => x.id === W.sysVar.id));
  for (const item of sysList.variables) assert.deepEqual([Object.keys(item).sort(), item.editable, item.actions], [REDUCED, false, []]);
  const detail = ok200(await api(`/variables/${v.id}`, { cookie: W.coachA1.cookie }));
  // The detail also carries the variable's domains and categories (phase 12b, J6 C6).
  assert.deepEqual([Object.keys(detail).sort(), Object.keys(detail.variable).sort(), detail.nextCursor], [["nextCursor", "variable"], [...REDUCED, "classification"].sort(), null]);
  assert.deepEqual(detail.variable.classification, { categories: [], domains: [], truncated: false });
  assert.deepEqual([detail.variable.editable, detail.variable.actions, detail.variable.labelsToken], [true, ["rename", "archive", "icon"], tokenOf(v.label, null, null, "active")]);
  assert.deepEqual([(await api(`/variables/${v.id}?cursor=abc`, { cookie: W.coachA1.cookie })).body.error], ["invalid_query"]);
  // The reduced view's icon (PR-1): a key of the library, and null for any
  // other stored value - a URL, an alias, an unknown key - on the list and the
  // detail alike (icon_url written by hand, as the older API could).
  const coachIcon = async () => {
    const listed = ok200(await api("/variables", { cookie: W.coachA1.cookie })).variables.find((x) => x.id === v.id);
    return [listed.icon, ok200(await api(`/variables/${v.id}`, { cookie: W.coachA1.cookie })).variable.icon];
  };
  for (const [stored, icon] of [["/assets/x.svg", null], ["icon:dumbbell", null], ["icon:gone", null], ["icon:run", "run"], [null, null]]) {
    await rawDefinitionUpdate(`update training_load.metric_definitions set icon_url = $2 where id = $1`, [v.id, stored]);
    assert.deepEqual(await coachIcon(), [icon, icon], String(stored));
  }
  // The admins: their view, with actions (newVersion only outside a team workspace) and the token.
  const admin = await view(W.caA, v.id);
  assert.deepEqual([admin.actions, admin.labelsToken, Array.isArray(admin.versions)], [["rename", "archive", "newVersion", "icon"], detail.variable.labelsToken, true]);
  assert.deepEqual((await view(W.caCoachA1, v.id)).actions, ["rename", "archive", "icon"], "an admin in a team workspace reads the team view");
  // A write answer, a replay and a verified lost COMMIT: the reduced view.
  const body = { requestKey: key(), labelsToken: detail.variable.labelsToken, description: "Read in metres" };
  const first = ok200(await post(`/variables/${v.id}/rename`, W.coachA1.cookie, body));
  const replay = ok200(await post(`/variables/${v.id}/rename`, W.coachA1.cookie, body));
  assert.deepEqual([Object.keys(first.variable).sort(), Object.keys(replay.variable).sort(), replay.replayed], [REDUCED, REDUCED, true]);
  service.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw new Error("lost"); }) });
  const verified = ok200(await archive(W.coachA1, v.id));
  service.setMappingCommitForTests();
  assert.deepEqual([verified.commitConfirmation, Object.keys(verified.variable).sort(), verified.variable.state], ["verified_after_commit_error", REDUCED, "archived"]);
  assert.deepEqual(verified.variable.actions, ["restore"], "a coach's own archive: the coach may restore it");
  // variable_changed carries the current reduced view and its token.
  ok200(await restore(W.coachA1, v.id));
  const stale = await rename(W.caA, v.id, { labelsToken: detail.variable.labelsToken, label: "Stale" });
  assert.deepEqual([stale.status, stale.body.error, Object.keys(stale.body.current).sort()], [409, "variable_changed", REDUCED]);
  assert.equal(stale.body.current.labelsToken, tokenOf(v.label, null, "Read in metres", "active"));
  // Actions after an admin's archive: the admin may restore, the coach may not.
  ok200(await archive(W.caA, v.id));
  assert.deepEqual([(await view(W.caA, v.id)).actions, (await view(W.coachA1, v.id)).actions], [["restore"], []]);
});

test("5. rename: the change row records old and new values from the database; a field left out stays, null clears the short label or description; the 409s in their order (archived, a stale token, unchanged, a coach on a pinned variable); a value the output cuts or one on several lines is renamed through the token; the body is checked", async () => {
  const v = await created(W.caA.cookie, { shortLabel: "TD", description: "Total" });
  const res = ok200(await rename(W.coachA1, v.id, { labelsToken: v.labelsToken, label: "Distance", shortLabel: null }));
  assert.deepEqual([res.variable.label, res.variable.shortLabel, res.variable.description], ["Distance", null, "Total"]);
  const [change] = await changesOf(v.id);
  assert.deepEqual(
    [change.kind, change.old_label, change.new_label, change.old_short_label, change.new_short_label, change.old_description, change.new_description, change.old_state, change.new_state],
    ["rename", v.label, "Distance", "TD", null, "Total", "Total", "active", "active"],
  );
  assert.deepEqual([change.operation, change.basis, change.basis_team_id, change.requested_by_user_id, change.changed_by_user_id, change.reason],
    ["variable_rename", "team_coach", W.teamA1, W.coachA1.id, W.coachA1.id, null]);
  const token = res.variable.labelsToken;
  // 409 order: archived beats a stale token; a stale token beats unchanged; unchanged beats a coach's pin refusal.
  assert.deepEqual([(await rename(W.coachA1, v.id, { labelsToken: token, label: "Distance" })).body.error], ["rename_unchanged"]);
  assert.deepEqual([(await rename(W.coachA1, v.id, { labelsToken: "f".repeat(64), label: "Distance" })).body.error], ["variable_changed"]);
  ok200(await archive(W.caA, v.id));
  assert.deepEqual([(await rename(W.caA, v.id, { labelsToken: "f".repeat(64), label: "X" })).body.error], ["variable_not_active"]);
  ok200(await restore(W.caA, v.id));
  // Q4: a pinned variable is renamed only by an admin.
  const p = await created(W.caA.cookie, { levels: ["session"] });
  await pinned(p, W.caA.cookie);
  const pv = await view(W.coachA1, p.id);
  assert.deepEqual(pv.actions, ["icon"], "a coach may neither rename nor archive a pinned variable; its icon, yes (J3b.11)");
  assert.deepEqual([(await rename(W.coachA1, p.id, { labelsToken: pv.labelsToken, label: p.label })).body.error], ["rename_unchanged"]);
  const coachPinned = await rename(W.coachA1, p.id, { labelsToken: pv.labelsToken, label: "Pinned rename" });
  assert.deepEqual([coachPinned.status, coachPinned.body.error], [409, "variable_pinned"]);
  assert.equal((await view(W.caA, p.id)).actions.join(), "rename,icon", "an admin may rename a pinned variable, not archive it");
  ok200(await rename(W.caA, p.id, { labelsToken: pv.labelsToken, label: "Pinned rename" }));
  // A legacy value longer than the output bound, and one on several lines: renamed through the token.
  const longLabel = "L".repeat(120);
  await rawDefinitionUpdate(`update training_load.metric_definitions set label = $2, description = $3 where id = $1`, [v.id, longLabel, "line one\nline two"]);
  const cut = await view(W.coachA1, v.id);
  assert.deepEqual([cut.truncated, cut.label.length, cut.labelsToken], [true, 80, tokenOf(longLabel, null, "line one\nline two", "active")]);
  const legacy = ok200(await rename(W.coachA1, v.id, { labelsToken: cut.labelsToken, description: "One line" }));
  assert.deepEqual([(await defRow(v.id)).label, legacy.variable.description], [longLabel, "One line"], "the long label it left is exempt");
  // The body.
  const t = legacy.variable.labelsToken;
  for (const bad of [{ labelsToken: t }, { labelsToken: t, label: null }, { labelsToken: t, label: "x".repeat(81) }, { labelsToken: t, shortLabel: "x".repeat(21) },
    { labelsToken: t, description: "x".repeat(501) }, { labelsToken: t, label: ` lead` }, { labelsToken: t, label: `bidi${ch(0x202e)}` }, { labelsToken: "short", label: "x" },
    { labelsToken: t, label: "x", key: "k" }, { labelsToken: t, label: "x", state: "archived" }, { labelsToken: t, label: "x", ownerScope: "system" }]) {
    const res = await rename(W.caA, v.id, bad);
    assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], JSON.stringify(bad));
  }
});

test("6. archive: a reason is required (Q3); the change row and the request carry it; an archived variable is variable_not_active; a pinned variable is variable_pinned for everyone (decision 9); restore: variable_active; a pinned archived variable is variable_pinned", async () => {
  const v = await created(W.caA.cookie);
  assert.deepEqual([(await post(`/variables/${v.id}/archive`, W.caA.cookie, { requestKey: key() })).body.error], ["invalid_body"]);
  assert.deepEqual([(await archive(W.caA, v.id, { reason: "" })).body.error], ["invalid_body"]);
  assert.deepEqual([(await restore(W.caA, v.id)).body.error], ["variable_active"]);
  const res = ok200(await archive(W.coachA1, v.id, { reason: "Replaced by the drill variable" }));
  assert.equal(res.variable.state, "archived");
  const [change] = await changesOf(v.id);
  assert.deepEqual([change.kind, change.old_state, change.new_state, change.old_label, change.new_label, change.reason], ["archive", "active", "archived", v.label, v.label, "Replaced by the drill variable"]);
  assert.deepEqual([(await archive(W.caA, v.id)).body.error], ["variable_not_active"]);
  ok200(await restore(W.caA, v.id, { reason: "Needed again" }));
  assert.equal((await changesOf(v.id))[1].reason, "Needed again");
  const p = await created(W.caA.cookie, { levels: ["session"] });
  await pinned(p, W.caA.cookie);
  for (const who of [W.caA, W.coachA1, W.paA]) assert.deepEqual([(await archive(who, p.id)).body.error], ["variable_pinned"]);
  // A pinned archived row (not reachable today: an activation needs an active definition).
  await rawDefinitionUpdate(`update training_load.metric_definitions set state = 'archived' where id = $1`, [p.id], { pinGuardOff: true });
  assert.deepEqual([(await restore(W.caA, p.id)).body.error], ["variable_pinned"]);
  assert.equal(variables.classifyVariableError(Object.assign(new Error("metric_definitions: an active mapping version pins the current version; disable it first"), { code: "23514" }))?.code, "variable_pinned");
});

test("7. Q8: a coach restores only what a coach archived - the deciding row is the most recent change (the largest seq); an admin's archive, a legacy archive without a change row and archive by a coach then restore and archive by an admin all refuse a coach (restore_by_admin) and admit an admin", async () => {
  const v = await created(W.caA.cookie);
  ok200(await archive(W.caA, v.id));
  assert.deepEqual([(await restore(W.coachA1, v.id)).body.error], ["restore_by_admin"]);
  ok200(await restore(W.caA, v.id));
  ok200(await archive(W.coachA2, v.id));
  ok200(await restore(W.coachA1, v.id), "a coach of another team of the club restores a coach's archive");
  ok200(await archive(W.coachA1, v.id));
  ok200(await restore(W.caA, v.id));
  ok200(await archive(W.caA, v.id));
  assert.deepEqual([(await restore(W.coachA1, v.id)).body.error], ["restore_by_admin"]);
  // A legacy archive (no change row): an admin's.
  const legacy = await created(W.caA.cookie);
  await rawDefinitionUpdate(`update training_load.metric_definitions set state = 'archived' where id = $1`, [legacy.id]);
  assert.deepEqual([(await restore(W.coachA1, legacy.id)).body.error], ["restore_by_admin"]);
  ok200(await restore(W.caA, legacy.id));
  // A coach's archive, a restore, then a legacy archive: still no coach's.
  ok200(await archive(W.coachA1, legacy.id));
  ok200(await restore(W.coachA1, legacy.id));
  await rawDefinitionUpdate(`update training_load.metric_definitions set state = 'archived' where id = $1`, [legacy.id]);
  assert.deepEqual([(await restore(W.coachA1, legacy.id)).body.error], ["restore_by_admin"]);
});

test("8. the ordering rule: an admin's transaction that began first but archives last holds the most recent archive (the larger seq, though its transaction id is smaller), so a coach's restore answers restore_by_admin", async () => {
  const v = await created(W.caA.cookie);
  await k2.query("begin");
  await k2.query(CTX, [W.caA.id]);
  const adminXact = (await one(k2, `select pg_current_xact_id()::text as x`)).x;
  ok200(await archive(W.coachA1, v.id));
  ok200(await restore(W.coachA1b, v.id));
  await rawChange(k2, { defId: v.id, by: W.caA.id, operation: "variable_archive", set: "state = 'archived'", basis: "club_admin", clubId: W.clubA, reason: "Admin" });
  await k2.query("commit");
  const changes = await changesOf(v.id);
  assert.deepEqual(changes.map((c) => [c.kind, c.basis]), [["archive", "team_coach"], ["restore", "team_coach"], ["archive", "club_admin"]]);
  assert.ok(BigInt(changes[2].xact_id) < BigInt(changes[0].xact_id), "the admin's transaction began first");
  assert.ok(BigInt(changes[2].seq) > BigInt(changes[1].seq), "but its change has the larger seq");
  assert.equal(String(changes[2].xact_id), adminXact);
  assert.deepEqual([(await restore(W.coachA1, v.id)).body.error], ["restore_by_admin"]);
});

test("9. concurrent writes: an archive against a mapping activation in both orders (archive first: the activation is refused; activation first: variable_pinned), and against a value entry in both orders (the entry after the archive is refused; the archive after the entry leaves it stored)", async () => {
  // Archive first: held under the definition lock; the activation waits, then is refused.
  const a = await created(W.caA.cookie, { levels: ["session"] });
  const ma = await preparedMapping(a, W.caA.cookie);
  const hold = holdFirst("variable_archive");
  const archiving = archive(W.caA, a.id);
  assert.ok(await until(() => hold.state.held));
  const activating = tx(W.pa.id, (c) => activateIn(c, ma), k2);
  assert.ok(await someoneWaits(), "the activation waits for the definition");
  hold.g.open();
  ok200(await archiving);
  refusedWith(await activating, "23514", /^source_metric_mapping_versions: the canonical definition must be active with the pinned version current$/);
  // Activation first: the archive waits for the definition, then sees the pin.
  const b = await created(W.caA.cookie, { levels: ["session"] });
  const mb = await preparedMapping(b, W.caA.cookie);
  await k2.query("begin");
  await k2.query(CTX, [W.pa.id]);
  await activateIn(k2, mb);
  const archivingB = archive(W.caA, b.id);
  assert.ok(await someoneWaits(), "the archive waits for the activation");
  await k2.query("commit");
  const pinnedB = await archivingB;
  assert.deepEqual([pinnedB.status, pinnedB.body.error], [409, "variable_pinned"]);
  // A value entry through the older Metrics API (the club admin, a club athlete).
  const athleteUser = await user("athlete-in-a");
  const athleteId = (await one(k, `insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,'Athlete A','Athlete A','UTC') returning id`, [athleteUser])).id;
  await k.query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, W.clubA]);
  const entry = (v, value) => post("/events", W.caA.cookie, {
    requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
    participants: [{ athleteId, timezone: "UTC", values: [{ metricDefinitionId: v.id, metricDefinitionVersionId: v.currentVersion.id, value }] }],
  }, { base: "/api/training-load/metrics" });
  // The archive after an entry: a real entry, paused after it took the
  // definition FOR SHARE (another session holds metric_events, which it writes
  // next); the archive waits for the entry's COMMIT, and the value stays.
  const c = await created(W.caA.cookie, { levels: ["session"] });
  await k2.query("begin");
  await k2.query("lock table training_load.metric_events in share mode");
  const order = [];
  const entering = entry(c, 300).then((res) => { order.push("entry"); return res; });
  assert.ok(await until(async () => (await one(k, `select count(*)::int as n from pg_locks l join pg_class t on t.oid = l.relation where t.relname = 'metric_events' and not l.granted`)).n > 0), "the entry waits on metric_events");
  const archivingC = archive(W.caA, c.id).then((res) => { order.push("archive"); return res; });
  assert.ok(await until(async () => (await one(k, `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).n >= 2), "the archive waits for the entry's share lock");
  await k2.query("commit");
  const [entered, archivedC] = await Promise.all([entering, archivingC]);
  assert.equal(entered.status, 201, entered.text);
  ok200(archivedC);
  assert.deepEqual(order, ["entry", "archive"], "the archive waited for the entry");
  assert.equal((await one(k, `select count(*)::int as n from training_load.metric_values where metric_definition_id = $1`, [c.id])).n, 1, "the entry stays");
  // The entry after the archive is refused, nothing written; one entered before stays.
  const d = await created(W.caA.cookie, { levels: ["session"] });
  const stored = await entry(d, 100);
  assert.equal(stored.status, 201, stored.text);
  ok200(await archive(W.caA, d.id));
  const refused = await entry(d, 200);
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.body.error, /is archived and cannot accept new values/);
  assert.equal((await one(k, `select count(*)::int as n from training_load.metric_values where metric_definition_id = $1`, [d.id])).n, 1, "the entry made before the archive stays");
});

test("10. the basis is the strongest the database derives: a coach only writes team_coach with its team; a club admin who coaches the team writes club_admin (and may rename a pinned variable and restore an admin's archive in the team workspace); a platform admin who coaches it writes platform_admin; a stronger role granted during the request is try_again", async () => {
  const v = await created(W.caA.cookie);
  ok200(await rename(W.coachA1, v.id, { labelsToken: v.labelsToken, label: "By coach" }));
  ok200(await archive(W.caCoachA1, v.id));
  ok200(await restore(W.caCoachA1, v.id));
  ok200(await archive(W.paCoachA1, v.id));
  const changes = await changesOf(v.id);
  assert.deepEqual(changes.map((c) => [c.basis, c.basis_team_id]), [["team_coach", W.teamA1], ["club_admin", null], ["club_admin", null], ["platform_admin", null]]);
  ok200(await restore(W.paCoachA1, v.id));
  const p = await created(W.caA.cookie, { levels: ["session"] });
  await pinned(p, W.caA.cookie);
  ok200(await rename(W.caCoachA1, p.id, { labelsToken: (await view(W.caCoachA1, p.id)).labelsToken, label: "Admin in team workspace" }));
  // A coach promoted to the club's admin during the request: try_again, nothing written.
  const coach = await person("coach-promoted", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  const before = (await changesOf(v.id)).length;
  service.setMappingRightsHoldForTests(async () => {
    await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [coach.id, W.clubA]);
  });
  const promoted = await archive(coach, v.id);
  service.setMappingRightsHoldForTests(null);
  assert.deepEqual([promoted.status, promoted.body.error, promoted.headers.get("retry-after")], [409, "try_again", "5"]);
  assert.equal((await changesOf(v.id)).length, before);
  // ... and one made a platform admin during the request: the same.
  const coach2 = await person("coach-promoted-platform", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  service.setMappingRightsHoldForTests(async () => {
    await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [coach2.id]);
  });
  const promotedPlatform = await archive(coach2, v.id);
  service.setMappingRightsHoldForTests(null);
  assert.deepEqual([promotedPlatform.status, promotedPlatform.body.error], [409, "try_again"]);
  assert.equal((await changesOf(v.id)).length, before);
  // ... and one made the club's admin after the rights were checked, before
  // the request row: the database derives the stronger basis, the request is
  // refused there and answered try_again (never a 500), nothing written.
  const coach3 = await person("coach-promoted-late", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  variables.setVariableWriteHoldForTests(async (_client, at) => {
    if (at === "variable_archive") await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [coach3.id, W.clubA]);
  });
  const late = await archive(coach3, v.id);
  variables.setVariableWriteHoldForTests(null);
  assert.deepEqual([late.status, late.body.error, late.headers.get("retry-after")], [409, "try_again", "5"]);
  assert.equal((await changesOf(v.id)).length, before);
});

test("11. idempotency and outcome through the real routes: a replay (also a coach's) answers the current state and writes nothing; after the role is revoked it is 404; a key reused for another operation or body is request_key_reused; two identical requests at once write once; a lost answer after a real COMMIT is verified; after a real rollback it is 503 outcome_unknown with exactly error, message and requestKey and the same key then writes once; a read that fails after the COMMIT keeps 200 with readError; a change without its request is refused at COMMIT (a sanitized 500, nothing written); a held definition is try_again", async () => {
  const v = await created(W.caA.cookie);
  const coach = await person("coach-replay", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  const body = { requestKey: key(), labelsToken: v.labelsToken, label: "Replayed" };
  ok200(await post(`/variables/${v.id}/rename`, coach.cookie, body));
  const replay = ok200(await post(`/variables/${v.id}/rename`, coach.cookie, body));
  assert.equal(replay.replayed, true);
  assert.equal((await changesOf(v.id)).length, 1);
  assert.deepEqual([(await post(`/variables/${v.id}/archive`, coach.cookie, { requestKey: body.requestKey, reason: "x" })).body.error], ["request_key_reused"]);
  assert.deepEqual([(await post(`/variables/${v.id}/rename`, coach.cookie, { ...body, label: "Other" })).body.error], ["request_key_reused"]);
  // The replay checks the right again itself: lost during the replay (after the
  // resolver admitted the coach), it is the identical 404.
  service.setMappingRightsHoldForTests(async () => {
    await k.query(`update public.user_team_roles set is_active = false where user_id = $1`, [coach.id]);
  });
  const lostReplay = await post(`/variables/${v.id}/rename`, coach.cookie, body);
  service.setMappingRightsHoldForTests(null);
  assert.deepEqual([lostReplay.status, lostReplay.text], [404, '{"error":"notFound"}']);
  assert.deepEqual([(await post(`/variables/${v.id}/rename`, coach.cookie, body)).text], ['{"error":"notFound"}']);
  // Two identical requests at once: one write, one replay.
  const twin = { requestKey: key(), reason: "Twice" };
  const [x, y] = await Promise.all([post(`/variables/${v.id}/archive`, W.coachA1.cookie, twin), post(`/variables/${v.id}/archive`, W.coachA1.cookie, twin)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 200]);
  assert.deepEqual([x.body.replayed, y.body.replayed].sort(), [false, true]);
  assert.equal((await changesOf(v.id)).length, 2);
  // A lost answer after a real COMMIT, and after a real rollback.
  service.setMappingCommitForTests({ fault: (client) => client.query("rollback").then(() => { throw new Error("lost"); }) });
  const lostKey = key();
  const unknown = await post(`/variables/${v.id}/restore`, W.coachA1.cookie, { requestKey: lostKey });
  service.setMappingCommitForTests();
  assert.deepEqual([unknown.status, Object.keys(unknown.body).sort(), unknown.body.requestKey], [503, ["error", "message", "requestKey"], lostKey]);
  assert.equal((await changesOf(v.id)).length, 2, "nothing written");
  ok200(await post(`/variables/${v.id}/restore`, W.coachA1.cookie, { requestKey: lostKey }));
  assert.equal((await changesOf(v.id)).length, 3, "the same key then writes once");
  // A read that fails after the COMMIT.
  service.setMappingRereadFaultForTests(async () => { throw new Error("read broke"); });
  const readError = ok200(await archive(W.caA, v.id));
  service.setMappingRereadFaultForTests(null);
  assert.deepEqual([readError.readError, readError.variableId, readError.variable], [true, v.id, undefined]);
  // A change without its request row: refused at COMMIT, the whole write rolled back.
  const other = await created(W.caA.cookie);
  const otherBefore = await defRow(other.id);
  variables.setVariableWriteHoldForTests(async (client, at) => {
    if (at === "variable_restore") await client.query(`update training_load.metric_definitions set label = 'Sneaked' where id = $1`, [other.id]);
  });
  const sneaked = await restore(W.caA, v.id);
  variables.setVariableWriteHoldForTests(null);
  assert.deepEqual([sneaked.status, sneaked.text], [500, '{"error":"internal_error","message":"Something went wrong."}']);
  assert.deepEqual([(await defRow(other.id)).label, (await defRow(v.id)).state], [otherBefore.label, "archived"], "nothing written");
  // A held definition: try_again with Retry-After.
  await k2.query("begin");
  await k2.query(`select 1 from training_load.metric_definitions where id = $1 for update`, [v.id]);
  const busy = await restore(W.caA, v.id);
  await k2.query("rollback");
  assert.deepEqual([busy.status, busy.body.error, busy.headers.get("retry-after")], [409, "try_again", "5"]);
});

test("12. the database guards: no acting user is 42501; the basis is the derived one (a coach's club_admin, an admin's team_coach, team_coach on a system variable); a change without its request row is refused at COMMIT even after an earlier request for the definition; a request without its change, naming another transaction's change, another owner, definition or user; a direct change row; a savepoint; a rename's kind and text; Q4 and Q8 for team_coach; two changes in one transaction", async () => {
  const v = await created(W.caA.cookie);
  const sys = await created(W.pa.cookie);
  const set = (label) => `label = '${label}'`;
  refusedWith(await tx(null, (c) => c.query(`update training_load.metric_definitions set label = 'x' where id = $1`, [v.id])), "42501", NO_ACTOR);
  // The legitimate raw path a coach takes, then each forgery.
  okTx(await tx(W.coachA1.id, (c) => rawChange(c, { defId: v.id, by: W.coachA1.id, operation: "variable_rename", set: set("Raw coach"), basis: "team_coach", clubId: W.clubA, teamId: W.teamA1 })));
  refusedWith(await tx(W.coachA1.id, (c) => rawChange(c, { defId: v.id, by: W.coachA1.id, operation: "variable_rename", set: set("x1"), basis: "club_admin", clubId: W.clubA })), "42501", MAY_NOT);
  refusedWith(await tx(W.caCoachA1.id, (c) => rawChange(c, { defId: v.id, by: W.caCoachA1.id, operation: "variable_rename", set: set("x2"), basis: "team_coach", clubId: W.clubA, teamId: W.teamA1 })), "42501", BASIS);
  refusedWith(await tx(W.coachA1.id, (c) => rawChange(c, { defId: sys.id, by: W.coachA1.id, operation: "variable_rename", set: set("x3"), basis: "team_coach", scope: "system", teamId: W.teamA1 })), "42501", MAY_NOT);
  refusedWith(await tx(W.coachB1.id, (c) => rawChange(c, { defId: v.id, by: W.coachB1.id, operation: "variable_rename", set: set("x4"), basis: "team_coach", clubId: W.clubA, teamId: W.teamB1 })), "42501", MAY_NOT);
  // An archived team, a revoked role, and a team of an archived club: no basis.
  refusedWith(await tx(W.coachArch.id, (c) => rawChange(c, { defId: v.id, by: W.coachArch.id, operation: "variable_rename", set: set("x4a"), basis: "team_coach", clubId: W.clubA, teamId: W.teamArch })), "42501", MAY_NOT);
  refusedWith(await tx(W.coachRevoked.id, (c) => rawChange(c, { defId: v.id, by: W.coachRevoked.id, operation: "variable_rename", set: set("x4b"), basis: "team_coach", clubId: W.clubA, teamId: W.teamA1 })), "42501", MAY_NOT);
  const clubCVar = (await one(k, `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id) values ($1,'Club C variable','club',$2) returning id`, [`c_${uid()}`, W.clubC])).id;
  refusedWith(await tx(W.coachC.id, (c) => rawChange(c, { defId: clubCVar, by: W.coachC.id, operation: "variable_rename", set: set("x4c"), basis: "team_coach", clubId: W.clubC, teamId: W.teamC })), "42501", MAY_NOT);
  refusedWith(await tx(W.coachA1.id, (c) => rawChange(c, { defId: v.id, by: W.coachA2.id, operation: "variable_rename", set: set("x5"), basis: "team_coach", clubId: W.clubA, teamId: W.teamA1 })), "42501", OTHER_USER);
  // At COMMIT: a change without its own request, even after an earlier request for the definition.
  refusedWith(await tx(W.caA.id, (c) => c.query(`update training_load.metric_definitions set label = 'No request' where id = $1`, [v.id])), "23514", REQUEST_LINK);
  assert.equal((await defRow(v.id)).label, "Raw coach");
  // A request naming another transaction's change, or none.
  const earlier = (await changesOf(v.id)).at(-1).id;
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { defId: v.id, by: W.caA.id, operation: "variable_rename", set: "description = 'd'", basis: "club_admin", clubId: W.clubA, changeId: earlier })), "23514", FOLLOW);
  refusedWith(await tx(W.caA.id, (c) => c.query(
    `insert into training_load.metric_variable_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_definition_id, metric_variable_change_id) values ($1,$2,'variable_rename',$3,'club',$4,'club_admin',$5,$6)`,
    [key(), W.caA.id, "0".repeat(64), W.clubA, v.id, earlier])), "23514", FOLLOW);
  refusedWith(await tx(W.caA.id, async (c) => {
    await c.query(`update training_load.metric_definitions set description = 'n' where id = $1`, [v.id]);
    await c.query(`insert into training_load.metric_variable_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_definition_id) values ($1,$2,'variable_rename',$3,'club',$4,'club_admin',$5)`, [key(), W.caA.id, "0".repeat(64), W.clubA, v.id]);
  }), "23514");
  // Another owner, another definition.
  refusedWith(await tx(W.paA.id, (c) => rawChange(c, { defId: v.id, by: W.paA.id, operation: "variable_rename", set: set("x6"), basis: "platform_admin", scope: "system" })), "23514", FOLLOW);
  const v2 = await created(W.caA.cookie);
  refusedWith(await tx(W.caA.id, async (c) => {
    await c.query(`update training_load.metric_definitions set label = 'other' where id = $1`, [v2.id]);
    const change = (await one(c, `select id from training_load.metric_variable_changes where metric_definition_id = $1 and xact_id = pg_current_xact_id()`, [v2.id])).id;
    await rawChange(c, { defId: v.id, by: W.caA.id, operation: "variable_rename", set: set("x7"), basis: "club_admin", clubId: W.clubA, changeId: change });
  }), "23514", FOLLOW);
  // Two definitions with the same new names in one transaction, the request
  // naming the other definition's change: refused at the insert, not only by
  // the link at COMMIT.
  const twin1 = await created(W.caA.cookie);
  const twin2 = await created(W.caA.cookie);
  refusedWith(await tx(W.caA.id, async (c) => {
    await c.query(`update training_load.metric_definitions set label = 'Same name' where id = $1`, [twin2.id]);
    const other = (await one(c, `select id from training_load.metric_variable_changes where metric_definition_id = $1 and xact_id = pg_current_xact_id()`, [twin2.id])).id;
    await rawChange(c, { defId: twin1.id, by: W.caA.id, operation: "variable_rename", set: set("Same name"), basis: "club_admin", clubId: W.clubA, changeId: other });
  }), "23514", FOLLOW);
  // A direct change row, after the definition was written in this transaction.
  refusedWith(await tx(W.caA.id, async (c) => {
    await c.query(`update training_load.metric_definitions set label = 'direct' where id = $1`, [v.id]);
    await c.query(`insert into training_load.metric_variable_changes (metric_definition_id, owner_scope, owner_club_id, kind, old_label, new_label, old_state, new_state, changed_by_user_id, xact_id) values ($1,'club',$2,'rename','a','b','active','active',$3,pg_current_xact_id())`, [v.id, W.clubA, W.caA.id]);
  }), "23514", CHANGE_ONLY);
  // A savepoint: the definition and its change carry the subtransaction's id.
  refusedWith(await tx(W.caA.id, async (c) => {
    await c.query("savepoint s");
    await c.query(`update training_load.metric_definitions set label = 'in savepoint' where id = $1`, [v.id]);
  }), "23514", CHANGE_ONLY);
  // The kind must match the operation; an archive keeps the labels; the text rule.
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { defId: v.id, by: W.caA.id, operation: "variable_archive", set: set("kind"), basis: "club_admin", clubId: W.clubA })), "23514", MISMATCH);
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { defId: v.id, by: W.caA.id, operation: "variable_archive", set: "state = 'archived', label = 'both'", basis: "club_admin", clubId: W.clubA, reason: "r" })), "23514", MISMATCH);
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { defId: v.id, by: W.caA.id, operation: "variable_rename", set: "state = 'archived'", basis: "club_admin", clubId: W.clubA })), "23514", MISMATCH);
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { defId: v.id, by: W.caA.id, operation: "variable_restore", set: set("restore?"), basis: "club_admin", clubId: W.clubA })), "23514", MISMATCH);
  refusedWith(await tx(W.coachA1.id, (c) => rawChange(c, { defId: v.id, by: W.coachA1.id, operation: "variable_rename", set: `description = '${"d".repeat(501)}'`, basis: "team_coach", clubId: W.clubA, teamId: W.teamA1 })), "23514", TEXT_RULE);
  refusedWith(await tx(W.coachA1.id, (c) => rawChange(c, { defId: v.id, by: W.coachA1.id, operation: "variable_rename", set: `label = 'bidi${ch(0x202e)}'`, basis: "team_coach", clubId: W.clubA, teamId: W.teamA1 })), "23514", TEXT_RULE);
  refusedWith(await tx(W.coachA1.id, (c) => rawChange(c, { defId: v.id, by: W.coachA1.id, operation: "variable_rename", set: `short_label = '${"s".repeat(21)}'`, basis: "team_coach", clubId: W.clubA, teamId: W.teamA1 })), "23514", TEXT_RULE);
  // Two changes of one definition in one transaction (the request names the
  // latest, whose new values are the definition's: only the count refuses).
  refusedWith(await tx(W.caA.id, async (c) => {
    await c.query(`update training_load.metric_definitions set label = 'one' where id = $1`, [v.id]);
    await c.query(`update training_load.metric_definitions set description = 'two' where id = $1`, [v.id]);
    await rawChange(c, { defId: v.id, by: W.caA.id, operation: "variable_rename", set: "updated_at = now()", basis: "club_admin", clubId: W.clubA,
      changeId: (await one(c, `select id from training_load.metric_variable_changes where metric_definition_id = $1 and xact_id = pg_current_xact_id() order by seq desc limit 1`, [v.id])).id });
  }), "23514", FOLLOW);
  // The definition changed again with the change trigger off: the request's
  // change no longer holds the definition's values.
  refusedWith(await tx(W.caA.id, async (c) => {
    await c.query(`update training_load.metric_definitions set label = 'recorded' where id = $1`, [v.id]);
    const change = (await one(c, `select id from training_load.metric_variable_changes where metric_definition_id = $1 and xact_id = pg_current_xact_id()`, [v.id])).id;
    await c.query(`alter table training_load.metric_definitions disable trigger metric_definitions_v38_record_change`);
    await c.query(`update training_load.metric_definitions set label = 'unrecorded' where id = $1`, [v.id]);
    await c.query(`alter table training_load.metric_definitions enable trigger metric_definitions_v38_record_change`);
    await rawChange(c, { defId: v.id, by: W.caA.id, operation: "variable_rename", set: "updated_at = now()", basis: "club_admin", clubId: W.clubA, changeId: change });
  }), "23514", FOLLOW);
  // A change row forged from another trigger of the transaction (depth 2): the
  // documented limit admits it only with this transaction, the acting user, a
  // definition this transaction wrote and the definition's owner - and then
  // the COMMIT still refuses it without its request row.
  await k.query(`create table if not exists public.r2_forge (x int)`);
  await k.query(`create or replace function public.r2_forge_insert() returns trigger as $f$
    declare v jsonb := current_setting('r2.forge')::jsonb;
    begin
      insert into training_load.metric_variable_changes (metric_definition_id, owner_scope, owner_club_id, kind, old_label, new_label, old_state, new_state, changed_by_user_id, xact_id)
      values ((v->>'def')::uuid, v->>'scope', (v->>'club')::uuid, 'rename', 'a', 'b', 'active', 'active', (v->>'user')::uuid, coalesce((v->>'xact')::xid8, pg_current_xact_id()));
      return null;
    end $f$ language plpgsql`);
  await k.query(`drop trigger if exists r2_forge on public.r2_forge`);
  await k.query(`create trigger r2_forge after insert on public.r2_forge for each row execute function public.r2_forge_insert()`);
  const forge = (values, { write = true } = {}) => tx(W.caA.id, async (c) => {
    if (write) await c.query(`update training_load.metric_definitions set updated_at = now() where id = $1`, [v.id]);
    await c.query(`select set_config('r2.forge', $1, true)`, [JSON.stringify({ def: v.id, scope: "club", club: W.clubA, user: W.caA.id, ...values })]);
    await c.query(`insert into public.r2_forge values (1)`);
  });
  refusedWith(await forge({}), "23514", REQUEST_LINK);
  refusedWith(await forge({ xact: "1" }), "23514", CHANGE_ONLY);
  refusedWith(await forge({ user: W.caA2.id }), "42501", CHANGE_USER);
  refusedWith(await forge({ scope: "system", club: null }), "23514", CHANGE_ONLY);
  refusedWith(await forge({}, { write: false }), "23514", CHANGE_ONLY);
  // Q4 and Q8 for team_coach, in the database.
  const p = await created(W.caA.cookie, { levels: ["session"] });
  await pinned(p, W.caA.cookie);
  refusedWith(await tx(W.coachA1.id, (c) => rawChange(c, { defId: p.id, by: W.coachA1.id, operation: "variable_rename", set: set("pinned"), basis: "team_coach", clubId: W.clubA, teamId: W.teamA1 })), "23514", COACH_PINNED);
  okTx(await tx(W.caA.id, (c) => rawChange(c, { defId: p.id, by: W.caA.id, operation: "variable_rename", set: set("pinned by admin"), basis: "club_admin", clubId: W.clubA })));
  const q8 = await created(W.caA.cookie);
  ok200(await archive(W.caA, q8.id));
  refusedWith(await tx(W.coachA1.id, (c) => rawChange(c, { defId: q8.id, by: W.coachA1.id, operation: "variable_restore", set: "state = 'active'", basis: "team_coach", clubId: W.clubA, teamId: W.teamA1 })), "23514", COACH_RESTORE);
  const legacy = await created(W.caA.cookie);
  await rawDefinitionUpdate(`update training_load.metric_definitions set state = 'archived' where id = $1`, [legacy.id]);
  refusedWith(await tx(W.coachA1.id, (c) => rawChange(c, { defId: legacy.id, by: W.coachA1.id, operation: "variable_restore", set: "state = 'active'", basis: "team_coach", clubId: W.clubA, teamId: W.teamA1 })), "23514", COACH_RESTORE);
  // A coach's archive and restore, then a legacy archive: the most recent change
  // is the restore, so the archive now in force is no coach's.
  const later = await created(W.caA.cookie);
  ok200(await archive(W.coachA1, later.id));
  ok200(await restore(W.coachA1, later.id));
  await rawDefinitionUpdate(`update training_load.metric_definitions set state = 'archived' where id = $1`, [later.id]);
  refusedWith(await tx(W.coachA1.id, (c) => rawChange(c, { defId: later.id, by: W.coachA1.id, operation: "variable_restore", set: "state = 'active'", basis: "team_coach", clubId: W.clubA, teamId: W.teamA1 })), "23514", COACH_RESTORE);
  okTx(await tx(W.caA.id, (c) => rawChange(c, { defId: later.id, by: W.caA.id, operation: "variable_restore", set: "state = 'active'", basis: "club_admin", clubId: W.clubA })));
  // Q3 in the database: an archive's request carries its reason.
  const noReason = refusedWith(await tx(W.caA.id, (c) => rawChange(c, { defId: v.id, by: W.caA.id, operation: "variable_archive", set: "state = 'archived'", basis: "club_admin", clubId: W.clubA, reason: null })), "23514");
  assert.equal(noReason.constraint, "metric_variable_requests_archive_reason");
  // The shape checks of the request table.
  refusedWith(await tx(W.pa.id, (c) => c.query(
    `insert into training_load.metric_variable_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, basis, metric_definition_id, metric_definition_version_id, reason) values ($1,$2,'variable_version_create',$3,'system','platform_admin',$4,$5,'why')`,
    [key(), W.pa.id, "0".repeat(64), sys.id, sys.currentVersion.id])), "23514");
});

test("13. the key of a system or club variable never changes (OLD or NEW canonical; v34's owner messages keep winning); a team definition's key still can; both new tables are append-only; the older API keeps refusing a canonical variable (C98)", async () => {
  const v = await created(W.caA.cookie);
  for (const actor of [null, W.caA.id]) {
    refusedWith(await tx(actor, (c) => c.query(`update training_load.metric_definitions set key = 'renamed_key' where id = $1`, [v.id])), "23514", KEY_FROZEN);
  }
  const teamDef = (await one(k, `insert into training_load.metric_definitions (key, label, owner_scope, owner_team_id) values ($1,'Team def','team',$2) returning id`, [`team_${uid()}`, W.teamA1])).id;
  okTx(await tx(null, (c) => c.query(`update training_load.metric_definitions set key = $2 where id = $1`, [teamDef, `team_${uid()}`])));
  // A team definition's names change without an acting user (the older API's
  // and the GPEXE writer's rows); a canonical row's unchanged names write nothing.
  okTx(await tx(null, (c) => c.query(`update training_load.metric_definitions set label = 'Team def renamed', state = 'archived' where id = $1`, [teamDef])));
  okTx(await tx(null, (c) => c.query(`update training_load.metric_definitions set label = label, state = state, updated_at = now() where id = $1`, [v.id])));
  assert.equal((await changesOf(v.id)).length, 0);
  // OLD canonical, NEW a team row: the key is still frozen.
  refusedWith(await tx(null, (c) => c.query(`update training_load.metric_definitions set key = 'moved_key', owner_scope = 'team', owner_team_id = $2, owner_club_id = null where id = $1`, [v.id, W.teamA1])), "23514", KEY_FROZEN);
  refusedWith(await tx(null, (c) => c.query(`update training_load.metric_definitions set key = $2, owner_scope = 'club', owner_club_id = $3, owner_team_id = null where id = $1`, [teamDef, `club_${uid()}`, W.clubA])), "23514", KEY_FROZEN);
  // v34's owner guard fires first for a mapped definition (its message wins).
  const mapped = await created(W.caA.cookie, { levels: ["session"] });
  await preparedMapping(mapped, W.caA.cookie);
  refusedWith(await tx(null, (c) => c.query(`update training_load.metric_definitions set key = 'k', owner_scope = 'system', owner_club_id = null where id = $1`, [mapped.id])), "23514", /^metric_definitions: a canonical definition named by a mapping keeps its owner$/);
  // Append-only.
  ok200(await archive(W.caA, v.id));
  for (const sql of [`update training_load.metric_variable_changes set new_label = 'x'`, `delete from training_load.metric_variable_changes`, `truncate training_load.metric_variable_changes cascade`]) {
    refusedWith(await tx(W.caA.id, (c) => c.query(sql)), "23514", CHANGES_APPEND);
  }
  for (const sql of [`update training_load.metric_variable_requests set reason = 'x'`, `delete from training_load.metric_variable_requests`]) {
    refusedWith(await tx(W.caA.id, (c) => c.query(sql)), "23514", REQUESTS_APPEND);
  }
  // The older catalog API: C98 unchanged.
  const older = await post(`/definitions/${v.id}/archive`, W.caA.cookie, {}, { base: "/api/training-load/metrics" });
  assert.deepEqual([older.status, older.body.code], [409, "canonical_variable_read_only"]);
});

test("14. no answer and no log line carries SQL, a trigger's or the database's text, a body's label, a reason or an acting user's id", async () => {
  const secretLabel = `Secret label ${uid()}`;
  const secretReason = `Secret reason ${uid()}`;
  const v = await created(W.caA.cookie);
  ok200(await rename(W.coachA1, v.id, { labelsToken: v.labelsToken, label: secretLabel }));
  await archive(W.coachA1, v.id, { reason: secretReason });
  const everything = [...responses, ...logLines].join("\n");
  for (const forbidden of [/select |insert into|update training_load/i, /metric_variable_requests:|metric_variable_changes:|metric_definitions:/, /acting user/]) {
    assert.doesNotMatch(everything, forbidden);
  }
  for (const id of [W.coachA1.id, W.caA.id, W.pa.id]) assert.ok(!everything.includes(id), "no acting user's id");
  assert.ok(!logLines.join("\n").includes(secretLabel) && !logLines.join("\n").includes(secretReason), "no body text in the logs");
  assert.ok(!responses.some((t) => t.includes(secretReason)), "a reason is never answered");
});

test("15. v38 reads back the same after pg_dump and pg_restore (what gpexe-backup-verify compares): every trigger, constraint and function v38 adds or gates", async () => {
  const target = await createDisposableDatabase({ prefix: "gpexe", label: "r2rt", baseDatabaseUrl: ORIGINAL_DATABASE_URL });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-r2-roundtrip-"));
  const restored = new pg.Client({ connectionString: target.url });
  try {
    assert.match(target.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
    const u = new URL(db.url);
    const conn = ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username)];
    const env = { PATH: process.env.PATH, PGPASSWORD: decodeURIComponent(u.password) };
    const file = path.join(dir, "r2.dump");
    execFileSync("pg_dump", [...conn, "-d", db.name, "-Fc", "-f", file], { env, stdio: "pipe" });
    execFileSync("pg_restore", [...conn, "--no-owner", "--no-privileges", "-d", target.name, file], { env, stdio: "pipe" });
    await restored.connect();
    const objects = async (c) => ({
      triggers: await rows(c, `select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'training_load' and not t.tgisinternal
         and (c.relname in ('metric_variable_changes', 'metric_variable_requests') or t.tgname like 'metric_definitions_v38_%') order by 1, 2`),
      constraints: await rows(c, `select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid in ('training_load.metric_variable_changes'::regclass, 'training_load.metric_variable_requests'::regclass) order by 1, 2`),
      functions: await rows(c, `select p.proname, md5(pg_get_functiondef(p.oid)) as digest from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'training_load' and p.proname in ('metric_variable_change_basis', 'metric_variable_changes_insert_guard', 'metric_definitions_record_change',
          'metric_definitions_key_freeze', 'metric_variable_requests_change_guard', 'metric_variable_changes_request_link', 'metric_variable_changes_append_only',
          'metric_variable_requests_insert_guard') order by 1`),
    });
    const source = await objects(k);
    assert.deepEqual([source.triggers.length, source.functions.length], [10, 8], "v38's seven triggers and v36's three (its guard gated); v38's seven functions and v36's guard");
    assert.deepEqual(await objects(restored), source);
  } finally {
    await restored.end().catch(() => {});
    await target.drop();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("16. an archive changes no history: a dashboard series bound to a variable before its archive keeps reading the variable's values", async () => {
  const v = await created(W.caA.cookie, { levels: ["session"] });
  const athleteUser = await user("athlete-dash");
  const athleteId = (await one(k, `insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,'Athlete D','Athlete D','UTC') returning id`, [athleteUser])).id;
  await k.query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, W.clubA]);
  const entered = await post("/events", W.caA.cookie, {
    requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
    participants: [{ athleteId, timezone: "UTC", values: [{ metricDefinitionId: v.id, metricDefinitionVersionId: v.currentVersion.id, value: 4200 }] }],
  }, { base: "/api/training-load/metrics" });
  assert.equal(entered.status, 201, entered.text);
  const D = "/api/training-load/dashboards";
  const dashboard = (await post("", W.caA.cookie, { name: `R2 dash ${uid()}` }, { base: D })).body.dashboard;
  const widget = await post(`/${dashboard.id}/widgets`, W.caA.cookie, { expectedDashboardRevision: dashboard.revision, widgetType: "table", title: "W", widgetOrder: 1, x: 0, y: 0, width: 6, height: 4, mobileOrder: 1 }, { base: D });
  assert.ok(widget.status < 400, widget.text);
  const series = await post(`/${dashboard.id}/widgets/${widget.body.widgetId}/series`, W.caA.cookie, { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId: v.id, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" }, { base: D });
  assert.ok(series.status < 400, series.text);
  const read = async () => {
    const res = await post(`/${dashboard.id}/query`, W.caA.cookie, { dateFrom: "2026-09-08", dateTo: "2026-09-08" }, { base: D });
    assert.equal(res.status, 200, res.text);
    return Number(res.body.widgets.find((w) => w.widgetId === widget.body.widgetId).series[0].data.current[0].value);
  };
  assert.equal(await read(), 4200);
  ok200(await archive(W.coachA1, v.id));
  assert.equal(await read(), 4200, "the bound series keeps reading after the archive");
});

test("17. Q10: every character group Q10 adds, and a text of blanks only, is refused on create (label, short label, description, unit, the key suggestion), on a rename that changes a value (inside the write, after the rights: nothing written), and in an archive's or a restore's reason; a rename that sends a stored legacy value unchanged is exempt, as in v38's request guard", async () => {
  const SAMPLES = [0x034f, 0x115f, 0x17b5, 0x180f, 0x2065, 0x2800, 0x3164, 0xfe0f, 0xffa0, 0xfffb, 0x1bca3, 0x1d17a, 0xe0041, 0xe0100];
  const BLANKS_ONLY = [ch(0x3000), `${ch(0xa0)}${ch(0x2003)}`];
  const createBody = (over) => ({ requestKey: key(), label: `Total ${uid()}`, unit: "m", levels: ["session"], dailyAggregationMethod: "sum", ...over });
  for (const cp of SAMPLES) {
    for (const over of [{ label: `Bad ${ch(cp)} name` }, { shortLabel: `S${ch(cp)}` }, { description: `D ${ch(cp)}` }]) {
      const res = await post("/variables", W.caA.cookie, createBody(over));
      assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], `${cp.toString(16)} ${Object.keys(over)}`);
    }
    const unit = await post("/variables", W.caA.cookie, createBody({ unit: `m${ch(cp)}` }));
    assert.deepEqual([unit.status, unit.body.error], [400, "invalid_unit"], `unit ${cp.toString(16)}`);
    const suggestion = await api(`/variables/key-suggestion?label=${encodeURIComponent(`Bad ${ch(cp)} name`)}`, { cookie: W.caA.cookie });
    assert.deepEqual([suggestion.status, suggestion.body.error], [400, "invalid_query"], `key suggestion ${cp.toString(16)}`);
  }
  for (const blank of BLANKS_ONLY) {
    const res = await post("/variables", W.caA.cookie, createBody({ label: blank }));
    assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], "a label of blanks only");
  }
  for (const edge of [`Total distance${ch(0x3000)}`, `${ch(0xa0)}Total distance`]) {
    const res = await post("/variables", W.caA.cookie, createBody({ label: edge }));
    assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], "a label that starts or ends with a blank");
  }

  const v = await created(W.caA.cookie, { description: "Total" });
  const r2Requests = async () => (await one(k, `select count(*)::int as n from training_load.metric_variable_requests where metric_definition_id = $1 and operation <> 'variable_create'`, [v.id])).n;
  for (const who of [W.coachA1, W.caA]) {
    const fresh = await view(who, v.id);
    for (const cp of SAMPLES) {
      for (const body of [{ label: `Bad ${ch(cp)} name` }, { shortLabel: `S${ch(cp)}` }, { description: `D ${ch(cp)}` }]) {
        const res = await rename(who, v.id, { labelsToken: fresh.labelsToken, ...body });
        assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], `rename ${cp.toString(16)} ${Object.keys(body)}`);
      }
      const reason = await archive(who, v.id, { reason: `Gone ${ch(cp)}` });
      assert.deepEqual([reason.status, reason.body.error], [400, "invalid_body"], `archive reason ${cp.toString(16)}`);
    }
    for (const blank of [...BLANKS_ONLY, `Total${ch(0x2003)}`]) {
      assert.deepEqual([(await rename(who, v.id, { labelsToken: fresh.labelsToken, label: blank })).body.error], ["invalid_body"], "a rename to blanks only or to a trailing blank");
      assert.deepEqual([(await archive(who, v.id, { reason: blank })).body.error], ["invalid_body"], "a reason of blanks only");
    }
  }
  assert.deepEqual([(await changesOf(v.id)).length, await r2Requests()], [0, 0], "no refused rename or archive wrote a change or a request");
  // The text rule applies inside the write, after the 409s (J3b.2 step 8): a caller without the right gets the
  // identical 404, a reused key request_key_reused, a stale token variable_changed - never the 400.
  const outsider = await rename(W.coachB1, v.id, { labelsToken: "f".repeat(64), label: `Bad ${ch(0x3164)} name` });
  assert.deepEqual([outsider.status, outsider.body.error], [404, "notFound"]);
  const usedKey = key();
  const first = ok200(await post(`/variables/${v.id}/rename`, W.coachA1.cookie, { requestKey: usedKey, labelsToken: (await view(W.coachA1, v.id)).labelsToken, description: "Total again" }));
  const reused = await post(`/variables/${v.id}/rename`, W.coachA1.cookie, { requestKey: usedKey, labelsToken: first.variable.labelsToken, label: `Bad ${ch(0x3164)} name` });
  assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"]);
  const stale = await rename(W.coachA1, v.id, { labelsToken: "f".repeat(64), label: `Bad ${ch(0x3164)} name` });
  assert.deepEqual([stale.status, stale.body.error], [409, "variable_changed"]);

  ok200(await archive(W.coachA1, v.id, { reason: "Paused" }));
  for (const cp of SAMPLES) {
    const res = await restore(W.coachA1, v.id, { reason: `Back ${ch(cp)}` });
    assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], `restore reason ${cp.toString(16)}`);
  }
  ok200(await restore(W.coachA1, v.id, { reason: "Back" }));

  // A legacy label stored before Q10 with a character Q10 adds: sent unchanged it
  // is exempt, and the other field's rename goes through; alone it is
  // rename_unchanged; changed to another such value it is refused.
  const legacyLabel = `Legacy ${ch(0x3164)} name`;
  await rawDefinitionUpdate(`update training_load.metric_definitions set label = $2 where id = $1`, [v.id, legacyLabel]);
  const lv = await view(W.coachA1, v.id);
  const same = ok200(await rename(W.coachA1, v.id, { labelsToken: lv.labelsToken, label: legacyLabel, description: "New description" }));
  assert.deepEqual([(await defRow(v.id)).label, same.variable.description], [legacyLabel, "New description"]);
  const renamed = (await changesOf(v.id)).filter((c) => c.kind === "rename").at(-1);
  assert.deepEqual([renamed.old_label, renamed.new_label, renamed.new_description], [legacyLabel, legacyLabel, "New description"]);
  assert.deepEqual([(await rename(W.coachA1, v.id, { labelsToken: same.variable.labelsToken, label: legacyLabel })).body.error], ["rename_unchanged"]);
  const other = await rename(W.coachA1, v.id, { labelsToken: same.variable.labelsToken, label: `Other ${ch(0x3164)}` });
  assert.deepEqual([other.status, other.body.error], [400, "invalid_body"]);
});

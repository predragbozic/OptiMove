// PR-1b (I1) - changing the icon of a canonical variable
// (backend/src/canonicalVariableAdminService.js changeVariableIcon, the route
// POST /api/training-load/sources/metrics/variables/:id/icon) and migration v44
// (the icon in v38's change record, the kind 'icon', the operation
// 'variable_icon'). Through the real HTTP stack, on disposable
// optimove_tests_gpexe_* databases only (never OPTIMOVE): one migrated through
// v43 that rehearses v44's preflight / apply / post-check / rollback /
// re-apply, one migrated through v44 for the behaviour. Contract:
// docs/ai/gpexe-metric-variable-mapping-discovery.md, section J3b.11.
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

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V44 = "202610301200_training_load_v44_metric_variable_icon.sql";
const V44_NAME = `migrations_v2/${V44}`;
const V43_NAME = "migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql";
const UP_TO_V43 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V44));
const MIGRATION_PATH = path.resolve(ROOT, "migrations_v2", V44);
const ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/metric-variable-icon-v44-rollback.sql");
const V43_ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/source-metric-mapping-transitions-v43-rollback.sql");
const PREFLIGHT_PATH = path.resolve(ROOT, "docs/runbooks/metric-variable-icon-v44-preflight.sql");
const POSTCHECK_PATH = path.resolve(ROOT, "docs/runbooks/metric-variable-icon-v44-postcheck.sql");
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const NO_ACTOR = /no acting user is set for this transaction/;
const MAY_NOT = /^metric variable request: the acting user may not write this owner scope$/;
const FOLLOW = /^metric_variable_requests: the request must follow its own change in the same transaction$/;
const MISMATCH = /^metric_variable_requests: the change does not match the operation$/;
const COACH_PINNED = /^metric_variable_requests: a team coach does not rename a pinned variable$/;
const REQUEST_LINK = /^metric_variable_changes: a change is written with its own request row$/;
const CHANGES_APPEND = /^metric_variable_changes: change records are append-only$/;
const KIND_SHAPE = "metric_variable_changes_kind_shape";
const REDUCED = ["actions", "description", "editable", "icon", "id", "key", "label", "labelsToken", "ownerScope", "shortLabel", "state", "truncated"];
const ICON_FUNCTIONS = ["metric_definitions_record_change", "metric_variable_requests_change_guard"];
const ICON_TRIGGERS = ["metric_definitions_v38_record_change", "metric_variable_requests_change_guard"];
const ICON_CHECKS = ["metric_variable_changes_kind_check", "metric_variable_changes_kind_shape", "metric_variable_requests_change_iff",
  "metric_variable_requests_operation_check", "metric_variable_requests_team_coach_shape"];

let rdb, db, r, r2, k, k2, server, apiBase, service, variables, appPool, createSession, ICON_KEYS;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};
const openGates = [];

// v43's files and v44, through the real runner (its checksum and lock rules).
async function applyV44(url) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v44-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of UP_TO_V43) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    await fsp.copyFile(MIGRATION_PATH, path.join(dir, V44));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

before(async () => {
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V44), "v44 is a test migration");
  assert.equal(UP_TO_V43.at(-1), V43_NAME.slice("migrations_v2/".length), "v44 follows v43 in the test set");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v44rb", migrations: UP_TO_V43 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "icon1b" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  r2 = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  k2 = new pg.Client({ connectionString: db.url });
  for (const c of [r, r2, k, k2]) await c.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  assert.equal((await k.query(`select 1 from public.schema_migrations where migration_name = $1`, [V44_NAME])).rowCount, 1, "the behaviour database carries v44");
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.ICON_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  variables = await import("../src/canonicalVariableAdminService.js");
  ({ ICON_KEYS } = await import("../src/iconKeys.js"));
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
  for (const c of [r, r2, k, k2]) await c?.end().catch(() => {});
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
const setIcon = (who, id, expectedIconKey, iconKey, extra = {}) =>
  post(`/variables/${id}/icon`, who?.cookie ?? null, { requestKey: key(), expectedIconKey, iconKey, ...extra });
const rename = (who, id, body) => post(`/variables/${id}/rename`, who.cookie, { requestKey: key(), ...body });
const archive = (who, id) => post(`/variables/${id}/archive`, who.cookie, { requestKey: key(), reason: "No longer used" });
const restore = (who, id) => post(`/variables/${id}/restore`, who.cookie, { requestKey: key() });
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
  if (pattern instanceof RegExp) assert.match(res.error.message, pattern);
  else if (typeof pattern === "string") assert.equal(res.error.constraint, pattern, res.error.message);
  return res.error;
}
const okTx = (res) => { assert.equal(res.ok, true, res.error ? `${res.error.code}: ${res.error.message}` : ""); return res.value; };
// A stored icon_url planted as a fixture (what the older API could write),
// with every trigger of the transaction off.
async function plantIcon(defId, stored) {
  await k.query("begin");
  try {
    await k.query("set local session_replication_role = replica");
    await k.query(`update training_load.metric_definitions set icon_url = $2 where id = $1`, [defId, stored]);
    await k.query("commit");
  } catch (error) {
    await k.query("rollback").catch(() => {});
    throw error;
  }
}
// A raw R2 write inside a tx (what the service writes): the UPDATE, then the
// request naming the change row the trigger wrote.
async function rawChange(c, { defId, by, operation, set, basis, scope = "club", clubId = null, teamId = null, reason = null }) {
  await c.query(`update training_load.metric_definitions set ${set} where id = $1`, [defId]);
  const change = (await one(c, `select id from training_load.metric_variable_changes where metric_definition_id = $1 and xact_id = pg_current_xact_id() order by seq desc limit 1`, [defId]))?.id ?? null;
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
async function until(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}

async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    tables: await rows(c, `select table_schema, table_name from information_schema.tables where table_schema in ${S} order by 1, 2`),
    columns: await rows(c, `select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ${S} order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, c.contype, c.condeferrable, c.condeferred, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    indexes: await rows(c, `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ${S} order by 1, 2, 3`),
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled, t.tgdeferrable, t.tginitdeferred, obj_description(t.oid, 'pg_trigger') as comment from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest, obj_description(p.oid, 'pg_proc') as comment from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
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
// The rollback run after `plant` wrote, all of it in one transaction that is
// rolled back: what the script refused with (or null when it did not refuse,
// in which case its COMMIT committed everything - never used that way here).
async function rollbackAfter(plant) {
  const sql = await fsp.readFile(ROLLBACK_PATH, "utf8");
  await r.query("begin");
  let error = null;
  try {
    await plant(r);
    await r.query(sql);
  } catch (e) {
    error = e;
  }
  await r.query("rollback").catch(() => {});
  return error;
}

// A mapping version of a variable, made active (it pins the variable's current
// version), as the R2 suite does.
async function pinned(variable, adminCookie) {
  const def = await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Test field',$2) returning id`, [`icon.test.f${uid()}`, W.pa.id]);
  const rev = { id: await writeRevision(k, { fieldId: def.id, by: W.pa.id, evidenceRef: COMPAT, unit: "m", unitRef: COMPAT, meaning: true, meaningRef: COMPAT }) };
  const mapping = await post("/mappings", adminCookie, { requestKey: key(), sourceMetricId: def.id, metricDefinitionId: variable.id });
  assert.equal(mapping.status, 201, mapping.text);
  const mv = await post(`/mappings/${mapping.body.mapping.id}/versions`, adminCookie, { requestKey: key(), sourceRevisionId: rev.id, appliesToSession: true, appliesToDrill: false });
  assert.equal(mv.status, 201, mv.text);
  assert.equal((await post(`/mappings/${mapping.body.mapping.id}/versions/${mv.body.version.id}/submit`, adminCookie, { requestKey: key() })).status, 200);
  okTx(await tx(W.pa.id, async (c) => {
    await c.query(`update training_load.source_metric_mapping_versions set status = 'active', activated_by_user_id = $2, activated_at = now(), activated_basis = 'platform_admin' where id = $1`, [mv.body.version.id, W.pa.id]);
    await c.query(`insert into training_load.source_metric_audit (action, mapping_id, mapping_version_id, from_status, to_status, performed_by_user_id, basis, operation_id) values ('mapping_status',$1,$2,'needs_review','active',$3,'platform_admin',$4)`,
      [mapping.body.mapping.id, mv.body.version.id, W.pa.id, crypto.randomUUID()]);
  }));
}
const changesOf = (defId) => rows(k, `select c.*, r.operation, r.basis, r.basis_team_id, r.reason, r.requested_by_user_id from training_load.metric_variable_changes c left join training_load.metric_variable_requests r on r.metric_variable_change_id = c.id where c.metric_definition_id = $1 order by c.seq`, [defId]);
const defRow = (defId) => one(k, `select label, short_label, description, state, icon_url from training_load.metric_definitions where id = $1`, [defId]);

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.clubC = await club("Club C");
  W.teamA1 = await team(W.clubA);
  W.teamB1 = await team(W.clubB);
  W.teamC = await team(W.clubC);
  W.teamNoClub = await team(null);
  W.teamArch = await team(W.clubA);
  W.pa = await person("platform-admin", { platform: true, ws: ["platform", null] });
  W.paA = await person("platform-admin-a", { platform: true, clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.caA = await person("club-admin-a", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.caB = await person("club-admin-b", { clubAdminOf: [W.clubB], ws: ["club", W.clubB] });
  W.coachA1 = await person("coach-a1", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  W.coachB1 = await person("coach-b1", { coachOf: [W.teamB1], ws: ["team", W.teamB1] });
  W.coachC = await person("coach-c", { coachOf: [W.teamC], ws: ["team", W.teamC] });
  W.coachNoClub = await person("coach-noclub", { coachOf: [W.teamNoClub], ws: ["team", W.teamNoClub] });
  W.coachArch = await person("coach-archteam", { coachOf: [W.teamArch], ws: ["team", W.teamArch] });
  W.coachRevoked = await person("coach-revoked", { coachOf: [W.teamA1], roleActive: false, ws: ["team", W.teamA1] });
  const athleteId = await user("athlete");
  await k.query(`insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active) values ($1,$1,'Athlete','Only','Athlete Only','Athlete Only',$2,true)`, [`i1${uid()}`, athleteId]);
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
test("1. migration v44 on v43: the read-only preflight; through the real runner two columns, five checks (v38's names), two functions and two triggers change and nothing else; the read-only post-check; the rollback refuses without v44, under a later migration, while the migrator runs, with an icon change or a variable_icon request, a column missing or a trigger disabled; it returns the identical v43 catalog (comments included) and v44 applies again identically; v43's rollback refuses while v44 is recorded", async () => {
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v44 rollback refused: v44 is not recorded/);
  const pre = await runbook(r, PREFLIGHT_PATH);
  assert.deepEqual(
    [pre.pg15_or_later, pre.v43_rows, pre.v43_checksum_ok, pre.v38_checksum_ok, pre.v44_rows, pre.at_or_after_v44, pre.last_migration,
      pre.record_body_v38, pre.guard_body_v38, pre.v38_triggers_enabled, pre.v38_checks, pre.disabled_triggers, pre.v44_columns, pre.icon_in_checks,
      pre.owns_definitions, pre.owns_changes, pre.owns_requests, pre.rows_outside_v38, pre.actor_defaults, pre.conflicting_locks, pre.idle_in_transaction],
    [true, "1", true, true, "0", "0", V43_NAME, true, true, "2", "5", "0", "0", "0", true, true, true, "0", "0", "0", "0"],
  );
  const before43 = await catalog(r);
  await applyV44(rdb.url);
  const post44 = await runbook(r, POSTCHECK_PATH);
  assert.deepEqual(
    [post44.v44_rows, post44.v44_checksum_ok, post44.later_rows, post44.last_migration, post44.icon_columns, post44.icon_columns_text_nullable,
      post44.record_body_v44, post44.guard_body_v44, post44.comments, post44.triggers_enabled, post44.record_on_icon, post44.guard_on_icon,
      post44.checks_with_icon, post44.change_rows, post44.request_rows, post44.icon_changes, post44.icon_requests, post44.unpaired_icon_rows, post44.actor_defaults],
    ["1", true, "0", V44_NAME, "2", "2", true, true, "2", "2", true, true, "5", pre.change_rows, pre.request_rows, "0", "0", "0", "0"],
  );
  const after44 = await catalog(r);
  const added = (list, base, keyOf) => list.filter((x) => !base.some((y) => keyOf(y) === keyOf(x)));
  const removed = (list, base, keyOf) => added(base, list, keyOf);
  const changed = (list, base, keyOf) => list.filter((x) => base.some((y) => keyOf(y) === keyOf(x) && JSON.stringify(y) !== JSON.stringify(x)));
  const keys = {
    tables: (x) => `${x.table_schema}.${x.table_name}`, columns: (x) => `${x.table_schema}.${x.table_name}.${x.column_name}`,
    constraints: (x) => `${x.rel}.${x.conname}`, indexes: (x) => x.indexname, triggers: (x) => `${x.relname}.${x.tgname}`, functions: (x) => `${x.proname}(${x.args})`,
  };
  const diff = Object.fromEntries(Object.entries(keys).map(([part, keyOf]) => [part, {
    added: added(after44[part], before43[part], keyOf).map(keyOf).sort(),
    removed: removed(after44[part], before43[part], keyOf).map(keyOf).sort(),
    changed: changed(after44[part], before43[part], keyOf).map(keyOf).sort(),
  }]));
  assert.deepEqual(diff, {
    tables: { added: [], removed: [], changed: [] },
    columns: { added: ["training_load.metric_variable_changes.new_icon_url", "training_load.metric_variable_changes.old_icon_url"], removed: [], changed: [] },
    constraints: { added: [], removed: [], changed: ICON_CHECKS.map((n) => `training_load.${n.startsWith("metric_variable_changes") ? "metric_variable_changes" : "metric_variable_requests"}.${n}`).sort() },
    indexes: { added: [], removed: [], changed: [] },
    triggers: { added: [], removed: [], changed: ["metric_definitions.metric_definitions_v38_record_change", "metric_variable_requests.metric_variable_requests_change_guard"] },
    functions: { added: [], removed: [], changed: ICON_FUNCTIONS.map((n) => `${n}()`) },
  });
  assert.deepEqual(after44.migrations, [...before43.migrations, V44_NAME].sort());
  for (const f of after44.functions.filter((x) => ICON_FUNCTIONS.includes(x.proname))) assert.match(f.comment, /^v44 \(J3b\.11\): /);
  // The rollback's refusals, each in a transaction that is rolled back.
  const refusal = (e) => e?.message ?? "";
  assert.match(refusal(await rollbackAfter((c) => c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', $1, 'test')`, ["0".repeat(64)]))),
    /^v44 rollback refused: later migrations are applied$/);
  const plantChange = async (c) => {
    await c.query("set local session_replication_role = replica");
    await c.query(`insert into training_load.metric_variable_changes (metric_definition_id, owner_scope, kind, old_label, new_label, old_state, new_state, old_icon_url, new_icon_url, changed_by_user_id, xact_id)
      values ($1,'system','icon','x','x','active','active',null,'icon:run',$2,pg_current_xact_id())`, [crypto.randomUUID(), crypto.randomUUID()]);
    await c.query("set local session_replication_role = origin");
  };
  assert.match(refusal(await rollbackAfter(plantChange)), /^v44 rollback refused: an icon change is recorded$/);
  const plantRequest = async (c) => {
    await c.query("set local session_replication_role = replica");
    await c.query(`insert into training_load.metric_variable_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, basis, metric_definition_id, metric_variable_change_id)
      values ($1,$2,'variable_icon',$3,'system','platform_admin',$4,$5)`, [key(), crypto.randomUUID(), "0".repeat(64), crypto.randomUUID(), crypto.randomUUID()]);
    await c.query("set local session_replication_role = origin");
  };
  assert.match(refusal(await rollbackAfter(plantRequest)), /^v44 rollback refused: an icon change is recorded$/);
  assert.match(refusal(await rollbackAfter((c) => c.query(`alter table training_load.metric_variable_changes drop column new_icon_url`))),
    /^v44 rollback refused: a v44 column is missing$/);
  for (const [table, trigger] of [["metric_definitions", ICON_TRIGGERS[0]], ["metric_variable_requests", ICON_TRIGGERS[1]]]) {
    assert.match(refusal(await rollbackAfter((c) => c.query(`alter table training_load.${table} disable trigger ${trigger}`))),
      /^v44 rollback refused: a v44 trigger is disabled$/, trigger);
  }
  await r2.query("select pg_advisory_lock(822026)");
  try {
    assert.match(refusal(await runScript(r, ROLLBACK_PATH)), /^v44 rollback refused: the migrator is running$/);
  } finally {
    await r2.query("select pg_advisory_unlock(822026)");
  }
  assert.deepEqual(await catalog(r), after44, "every refusal changed nothing");
  // v43's rollback refuses while v44 is recorded.
  assert.match(refusal(await runScript(r, V43_ROLLBACK_PATH)), /^v43 rollback refused: .*later migration/);
  // The rollback, then v43's catalog exactly; the preflight reads as before; v44 again.
  assert.equal(await runScript(r, ROLLBACK_PATH), null);
  assert.deepEqual(await catalog(r), before43, "the identical v43 catalog, comments included");
  assert.deepEqual(await runbook(r, PREFLIGHT_PATH), pre);
  await applyV44(rdb.url);
  assert.deepEqual(await catalog(r), after44, "v44 applies again identically");
});

test("2. who may change an icon: the platform admin on a system variable and (in the club's workspace) on a club variable, the club's admin and a coach of an active team of the club on a club variable, each with its basis; a coach never on a system variable; another club, a team without a club, an archived team or club, a revoked role, an athlete, a private-coaching workspace and a missing variable get the byte-identical 404; 401 without a session", async () => {
  const clubVar = await created(W.caA.cookie);
  const [a, b, c, d] = ICON_KEYS;
  ok200(await setIcon(W.pa, W.sysVar.id, W.sysVar.icon, a));
  ok200(await setIcon(W.caA, clubVar.id, null, a));
  const coach = ok200(await setIcon(W.coachA1, clubVar.id, a, b));
  assert.deepEqual([Object.keys(coach.variable).sort(), coach.variable.icon], [REDUCED, b], "a coach's answer is the reduced view");
  ok200(await setIcon(W.paA, clubVar.id, b, c));
  assert.deepEqual((await changesOf(clubVar.id)).map((x) => [x.kind, x.operation, x.basis, x.basis_team_id, x.requested_by_user_id, x.old_icon_url, x.new_icon_url]), [
    ["icon", "variable_icon", "club_admin", null, W.caA.id, null, `icon:${a}`],
    ["icon", "variable_icon", "team_coach", W.teamA1, W.coachA1.id, `icon:${a}`, `icon:${b}`],
    ["icon", "variable_icon", "platform_admin", null, W.paA.id, `icon:${b}`, `icon:${c}`],
  ]);
  assert.deepEqual((await changesOf(W.sysVar.id)).map((x) => [x.kind, x.basis, x.owner_scope]), [["icon", "platform_admin", "system"]]);
  // Everyone outside the audience: the same bytes.
  const missing = await setIcon(W.caA, crypto.randomUUID(), null, a);
  assert.deepEqual([missing.status, missing.text, missing.headers.get("cache-control")], [404, '{"error":"notFound"}', "no-store"]);
  const malformed = await setIcon(W.caA, "not-a-uuid", null, a);
  assert.deepEqual([malformed.status, malformed.text], [404, missing.text]);
  for (const res of [await setIcon(W.coachA1, W.sysVar.id, a, d), await setIcon(W.caA, W.sysVar.id, a, d), await setIcon(W.caA, W.clubVarB.id, null, d)]) {
    assert.deepEqual([res.status, res.text], [404, missing.text]);
  }
  for (const who of [W.coachB1, W.caB, W.coachNoClub, W.coachArch, W.coachC, W.coachRevoked, W.athlete, W.privateCoach]) {
    const res = await setIcon(who, clubVar.id, c, d);
    assert.deepEqual([res.status, res.text, res.headers.get("cache-control")], [404, missing.text, "no-store"]);
  }
  assert.equal((await defRow(clubVar.id)).icon_url, `icon:${c}`, "nothing written by a refused caller");
  assert.equal((await defRow(W.sysVar.id)).icon_url, `icon:${a}`);
  const anonymous = await setIcon(null, clubVar.id, c, d);
  assert.equal(anonymous.status, 401);
  // actions: icon for every basis that may write the variable, only while active.
  assert.deepEqual([(await view(W.caA, clubVar.id)).actions, (await view(W.coachA1, clubVar.id)).actions, (await view(W.coachA1, W.sysVar.id)).actions],
    [["rename", "archive", "newVersion", "icon"], ["rename", "archive", "icon"], []]);
  ok200(await archive(W.caA, clubVar.id));
  assert.deepEqual([(await view(W.caA, clubVar.id)).actions, (await view(W.coachA1, clubVar.id)).actions], [["restore"], []]);
});

test("3. the order of the answers: no right before the body (404 even for a bad body); another club's coach, who has the route in its workspace, gets the body's 400 first and the variable's 404 after it; 415 for a non-JSON body; 400 for a JSON body that is not an object; 400 invalid_body for a missing or extra field, a bad requestKey, and a key outside the library in iconKey or expectedIconKey (a stored-value form, an unknown key, a wrong type); nothing written", async () => {
  const v = await created(W.caA.cookie);
  const [a] = ICON_KEYS;
  for (const body of [{ nonsense: true }, [1, 2]]) {
    const bad = await post(`/variables/${v.id}/icon`, W.athlete.cookie, body);
    assert.deepEqual([bad.status, bad.text], [404, '{"error":"notFound"}']);
  }
  assert.deepEqual([(await post(`/variables/${v.id}/icon`, W.coachB1.cookie, { nonsense: true })).body.error], ["invalid_body"]);
  assert.deepEqual([(await setIcon(W.coachB1, v.id, null, a)).text], ['{"error":"notFound"}']);
  const textBody = await api(`/variables/${v.id}/icon`, { method: "POST", cookie: W.caA.cookie, body: "icon=run", contentType: "text/plain" });
  assert.equal(textBody.status, 415);
  const arrayBody = await post(`/variables/${v.id}/icon`, W.caA.cookie, [1, 2]);
  assert.equal(arrayBody.status, 400);
  const base = { requestKey: key(), expectedIconKey: null, iconKey: a };
  const cases = [
    {}, { requestKey: key(), iconKey: a }, { requestKey: key(), expectedIconKey: null }, { ...base, extra: 1 }, { ...base, requestKey: "abc" },
    { ...base, requestKey: key(), iconKey: `icon:${a}` }, { ...base, requestKey: key(), iconKey: "no-such-icon" }, { ...base, requestKey: key(), iconKey: "" },
    { ...base, requestKey: key(), iconKey: 5 }, { ...base, requestKey: key(), iconKey: a.toUpperCase() }, { ...base, requestKey: key(), expectedIconKey: "/assets/x.svg" },
    { ...base, requestKey: key(), expectedIconKey: ["run"] },
  ];
  for (const body of cases) {
    const res = await post(`/variables/${v.id}/icon`, W.caA.cookie, body);
    assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], JSON.stringify(body));
  }
  assert.deepEqual([(await defRow(v.id)).icon_url, (await changesOf(v.id)).length], [null, 0]);
});

test("4. the change: the answer and every read carry the new icon; the change row records the old and new stored values from the database and keeps the names, state and labelsToken; variable_changed (with the current variable) for a stale expectedIconKey; icon_unchanged; No icon (null); a stored value that is not a library key reads as no icon and is replaced; variable_not_active after an archive; a rename, an archive and a restore keep the icon in their change rows", async () => {
  const [a, b] = ICON_KEYS;
  const v = await created(W.caA.cookie);
  const first = ok200(await setIcon(W.caA, v.id, null, a));
  assert.deepEqual([first.replayed, first.variable.icon, first.variable.labelsToken, first.variable.label], [false, a, v.labelsToken, v.label]);
  const listed = (await api("/variables", { cookie: W.caA.cookie })).body.variables.find((x) => x.id === v.id);
  assert.deepEqual([listed.icon, (await view(W.caA, v.id)).icon, (await view(W.coachA1, v.id)).icon], [a, a, a]);
  const [row] = await changesOf(v.id);
  assert.deepEqual(
    [row.kind, row.old_icon_url, row.new_icon_url, row.old_label, row.new_label, row.old_short_label, row.new_short_label, row.old_description, row.new_description, row.old_state, row.new_state, row.reason],
    ["icon", null, `icon:${a}`, v.label, v.label, null, null, null, null, "active", "active", null],
  );
  // A stale expectation, the same icon.
  const stale = await setIcon(W.caA, v.id, null, b);
  assert.deepEqual([stale.status, stale.body.error, stale.body.current.icon, stale.body.current.id], [409, "variable_changed", a, v.id]);
  const same = await setIcon(W.caA, v.id, a, a);
  assert.deepEqual([same.status, same.body.error], [409, "icon_unchanged"]);
  // No icon.
  assert.equal(ok200(await setIcon(W.coachA1, v.id, a, null)).variable.icon, null);
  assert.deepEqual([(await defRow(v.id)).icon_url, (await changesOf(v.id)).at(-1).new_icon_url], [null, null]);
  assert.deepEqual([(await setIcon(W.caA, v.id, null, null)).body.error], ["icon_unchanged"]);
  // A stored value that is not a library key: read as null, replaced by a key or by null.
  for (const [stored, next] of [["/assets/legacy.svg", b], ["icon:no-such-icon", null]]) {
    await plantIcon(v.id, stored);
    assert.equal((await view(W.caA, v.id)).icon, null);
    assert.equal(ok200(await setIcon(W.caA, v.id, null, next)).variable.icon, next);
    const last = (await changesOf(v.id)).at(-1);
    assert.deepEqual([last.kind, last.old_icon_url, last.new_icon_url], ["icon", stored, next === null ? null : `icon:${next}`]);
  }
  // A rename, an archive and a restore keep the icon.
  ok200(await setIcon(W.caA, v.id, null, a));
  const before = (await changesOf(v.id)).length;
  const token = (await view(W.caA, v.id)).labelsToken;
  ok200(await rename(W.caA, v.id, { labelsToken: token, label: `Renamed ${uid()}` }));
  ok200(await archive(W.caA, v.id));
  const archived = await setIcon(W.caA, v.id, a, b);
  assert.deepEqual([archived.status, archived.body.error], [409, "variable_not_active"]);
  ok200(await restore(W.caA, v.id));
  const kept = (await changesOf(v.id)).slice(before);
  assert.deepEqual(kept.map((x) => [x.kind, x.old_icon_url, x.new_icon_url]), [["rename", `icon:${a}`, `icon:${a}`], ["archive", `icon:${a}`, `icon:${a}`], ["restore", `icon:${a}`, `icon:${a}`]]);
});

test("5. a pinned variable (Q2): its icon changes for a coach and an admin (display only), while the coach's rename stays variable_pinned and its archive stays refused for everyone (decision 9)", async () => {
  const [a, b] = ICON_KEYS;
  const p = await created(W.caA.cookie, { levels: ["session"] });
  await pinned(p, W.caA.cookie);
  assert.deepEqual([(await view(W.coachA1, p.id)).actions, (await view(W.caA, p.id)).actions], [["icon"], ["rename", "icon"]]);
  ok200(await setIcon(W.coachA1, p.id, null, a));
  ok200(await setIcon(W.caA, p.id, a, b));
  const coachRename = await rename(W.coachA1, p.id, { labelsToken: p.labelsToken, label: "Nope" });
  assert.deepEqual([coachRename.status, coachRename.body.error], [409, "variable_pinned"]);
  assert.deepEqual([(await archive(W.caA, p.id)).body.error], ["variable_pinned"]);
  assert.deepEqual((await changesOf(p.id)).map((x) => [x.kind, x.basis]), [["icon", "team_coach"], ["icon", "club_admin"]]);
});

test("6. idempotency and outcome: a replay answers the current state and writes nothing; the same key with another body or for another operation is request_key_reused; two identical requests at once write once; a lost answer after a real COMMIT is verified; after a real rollback it is 503 outcome_unknown and the same key then writes once; a read that fails after the COMMIT keeps 200 with readError; a right lost during the write is the identical 404 with nothing written; a held definition is try_again", async () => {
  const [a, b, c] = ICON_KEYS;
  const v = await created(W.caA.cookie);
  const body = { requestKey: key(), expectedIconKey: null, iconKey: a };
  ok200(await post(`/variables/${v.id}/icon`, W.coachA1.cookie, body));
  const replay = ok200(await post(`/variables/${v.id}/icon`, W.coachA1.cookie, body));
  assert.deepEqual([replay.replayed, replay.variable.icon, (await changesOf(v.id)).length], [true, a, 1]);
  assert.deepEqual([(await post(`/variables/${v.id}/icon`, W.coachA1.cookie, { ...body, iconKey: b })).body.error], ["request_key_reused"]);
  assert.deepEqual([(await post(`/variables/${v.id}/archive`, W.coachA1.cookie, { requestKey: body.requestKey, reason: "x" })).body.error], ["request_key_reused"]);
  // Two identical requests at once.
  const twin = { requestKey: key(), expectedIconKey: a, iconKey: b };
  const [x, y] = await Promise.all([post(`/variables/${v.id}/icon`, W.caA.cookie, twin), post(`/variables/${v.id}/icon`, W.caA.cookie, twin)]);
  assert.deepEqual([[x.status, y.status], [x.body.replayed, y.body.replayed].sort()], [[200, 200], [false, true]]);
  assert.equal((await changesOf(v.id)).length, 2);
  // A lost answer after a real COMMIT.
  service.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw new Error("lost"); }) });
  const verified = ok200(await setIcon(W.coachA1, v.id, b, c));
  service.setMappingCommitForTests();
  assert.deepEqual([verified.commitConfirmation, verified.variable.icon, Object.keys(verified.variable).sort()], ["verified_after_commit_error", c, REDUCED]);
  // After a real rollback.
  service.setMappingCommitForTests({ fault: (client) => client.query("rollback").then(() => { throw new Error("lost"); }) });
  const lostKey = key();
  const unknown = await post(`/variables/${v.id}/icon`, W.caA.cookie, { requestKey: lostKey, expectedIconKey: c, iconKey: a });
  service.setMappingCommitForTests();
  assert.deepEqual([unknown.status, Object.keys(unknown.body).sort(), unknown.body.requestKey], [503, ["error", "message", "requestKey"], lostKey]);
  assert.equal((await changesOf(v.id)).length, 3, "nothing written");
  ok200(await post(`/variables/${v.id}/icon`, W.caA.cookie, { requestKey: lostKey, expectedIconKey: c, iconKey: a }));
  assert.equal((await changesOf(v.id)).length, 4, "the same key then writes once");
  // A read that fails after the COMMIT.
  service.setMappingRereadFaultForTests(async () => { throw new Error("read broke"); });
  const readError = ok200(await setIcon(W.caA, v.id, a, b));
  service.setMappingRereadFaultForTests(null);
  assert.deepEqual([readError.readError, readError.variableId, readError.variable], [true, v.id, undefined]);
  // A right lost during the write: revoked after the resolver admitted the
  // coach, right before the write checks it again under FOR SHARE.
  const coach = await person("coach-lost", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  let revoked = false;
  service.setMappingRightsHoldForTests(async () => {
    if (revoked) return;
    revoked = true;
    await k.query(`update public.user_team_roles set is_active = false where user_id = $1`, [coach.id]);
  });
  const lost = await setIcon(coach, v.id, b, c);
  service.setMappingRightsHoldForTests(null);
  assert.deepEqual([lost.status, lost.text], [404, '{"error":"notFound"}']);
  assert.deepEqual([(await defRow(v.id)).icon_url, (await changesOf(v.id)).length], [`icon:${b}`, 5], "nothing written");
  // A held definition.
  await k2.query("begin");
  await k2.query(`select 1 from training_load.metric_definitions where id = $1 for update`, [v.id]);
  const busy = await setIcon(W.caA, v.id, b, c);
  await k2.query("rollback");
  assert.deepEqual([busy.status, busy.body.error, busy.headers.get("retry-after")], [409, "try_again", "5"]);
});

test("7. the database guards, by direct SQL: an icon UPDATE without an acting user is 42501; with one but no request row it is refused at COMMIT; a rename, an archive or a restore with an icon change in the same UPDATE, an icon change of an archived variable and a stored value that is not null or a library key's shape are refused by the kind's shape; the operation must match the kind both ways; an icon request carries no reason; a coach's basis on a system variable; two changes in one transaction; an icon changed again with the trigger off; a coach's icon change of a pinned variable is admitted, its rename is not; a team definition's icon changes without an actor; the change rows stay append-only", async () => {
  const [a, b] = ICON_KEYS;
  const v = await created(W.caA.cookie);
  const iconSet = (value) => (value === null ? "icon_url = null" : `icon_url = '${value}'`);
  refusedWith(await tx(null, (c) => c.query(`update training_load.metric_definitions set icon_url = $2 where id = $1`, [v.id, `icon:${a}`])), "42501", NO_ACTOR);
  refusedWith(await tx(W.caA.id, (c) => c.query(`update training_load.metric_definitions set icon_url = $2 where id = $1`, [v.id, `icon:${a}`])), "23514", REQUEST_LINK);
  const clubAdmin = { defId: v.id, by: W.caA.id, basis: "club_admin", clubId: W.clubA };
  for (const set of [`label = 'both', ${iconSet(`icon:${a}`)}`, `description = 'both', ${iconSet(`icon:${a}`)}`, `state = 'archived', ${iconSet(`icon:${a}`)}`,
    iconSet("/assets/x.svg"), iconSet("icon:Run"), iconSet("icon:"), iconSet("icon:run--x"), `icon_url = 'icon:${a} '`]) {
    refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "variable_icon", set })), "23514", KIND_SHAPE);
  }
  // The legitimate raw write, and the kind matching the operation.
  okTx(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "variable_icon", set: iconSet(`icon:${a}`) })));
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "variable_rename", set: iconSet(`icon:${b}`) })), "23514", MISMATCH);
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "variable_icon", set: "label = 'renamed by icon'" })), "23514", MISMATCH);
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "variable_icon", set: iconSet(`icon:${b}`), reason: "why" })), "23514", "metric_variable_requests_reason_check");
  refusedWith(await tx(W.coachA1.id, (c) => rawChange(c, { defId: W.sysVar.id, by: W.coachA1.id, operation: "variable_icon", set: iconSet(`icon:${b}`), basis: "team_coach", scope: "system", teamId: W.teamA1 })), "42501", MAY_NOT);
  refusedWith(await tx(W.caA.id, async (c) => {
    await c.query(`update training_load.metric_definitions set ${iconSet(`icon:${b}`)} where id = $1`, [v.id]);
    await rawChange(c, { ...clubAdmin, operation: "variable_icon", set: iconSet(null) });
  }), "23514", FOLLOW);
  // The icon changed again with the change trigger off: the request's change
  // no longer holds the definition's icon.
  refusedWith(await tx(W.caA.id, async (c) => {
    await c.query(`update training_load.metric_definitions set ${iconSet(`icon:${b}`)} where id = $1`, [v.id]);
    const change = (await one(c, `select id from training_load.metric_variable_changes where metric_definition_id = $1 and xact_id = pg_current_xact_id()`, [v.id])).id;
    await c.query(`alter table training_load.metric_definitions disable trigger metric_definitions_v38_record_change`);
    await c.query(`update training_load.metric_definitions set ${iconSet(null)} where id = $1`, [v.id]);
    await c.query(`alter table training_load.metric_definitions enable trigger metric_definitions_v38_record_change`);
    await c.query(
      `insert into training_load.metric_variable_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_definition_id, metric_variable_change_id)
       values ($1,$2,'variable_icon',$3,'club',$4,'club_admin',$5,$6)`, [key(), W.caA.id, "0".repeat(64), W.clubA, v.id, change]);
  }), "23514", FOLLOW);
  // An archived variable's icon (its state stays archived).
  ok200(await archive(W.caA, v.id));
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "variable_icon", set: iconSet(`icon:${b}`) })), "23514", KIND_SHAPE);
  // A pinned variable: a coach's icon is admitted, a coach's rename is not.
  const p = await created(W.caA.cookie, { levels: ["session"] });
  await pinned(p, W.caA.cookie);
  const coach = { defId: p.id, by: W.coachA1.id, basis: "team_coach", clubId: W.clubA, teamId: W.teamA1 };
  okTx(await tx(W.coachA1.id, (c) => rawChange(c, { ...coach, operation: "variable_icon", set: iconSet(`icon:${b}`) })));
  refusedWith(await tx(W.coachA1.id, (c) => rawChange(c, { ...coach, operation: "variable_rename", set: "label = 'pinned'" })), "23514", COACH_PINNED);
  // A team definition: no trigger, no change row.
  const teamDef = (await one(k, `insert into training_load.metric_definitions (key, label, owner_scope, owner_team_id) values ($1,'Team def','team',$2) returning id`, [`team_${uid()}`, W.teamA1])).id;
  okTx(await tx(null, (c) => c.query(`update training_load.metric_definitions set icon_url = '/x.svg' where id = $1`, [teamDef])));
  assert.equal((await changesOf(teamDef)).length, 0);
  // Append-only, the icon columns included.
  for (const sql of [`update training_load.metric_variable_changes set new_icon_url = null where kind = 'icon'`, `delete from training_load.metric_variable_changes where kind = 'icon'`]) {
    refusedWith(await tx(W.caA.id, (c) => c.query(sql)), "23514", CHANGES_APPEND);
  }
  assert.deepEqual((await changesOf(v.id)).map((x) => [x.kind, x.new_icon_url]), [["icon", `icon:${a}`], ["archive", `icon:${a}`]]);
});

test("8. no answer and no log line carries SQL, a trigger's or the database's text, a stored icon value or an acting user's id", async () => {
  const v = await created(W.caA.cookie);
  const [a] = ICON_KEYS;
  await plantIcon(v.id, "/assets/private-legacy-name.svg");
  ok200(await setIcon(W.coachA1, v.id, null, a));
  await setIcon(W.coachA1, v.id, null, a);
  // A database refusal through the route: a change without its request row.
  variables.setVariableWriteHoldForTests(async (client, at) => {
    if (at === "variable_icon") await client.query(`update training_load.metric_definitions set label = 'Sneaked' where id = $1`, [W.sysVar.id]);
  });
  const sneaked = await setIcon(W.pa, W.sysVar.id, (await view(W.pa, W.sysVar.id)).icon, ICON_KEYS[3]);
  variables.setVariableWriteHoldForTests(null);
  assert.deepEqual([sneaked.status, sneaked.text], [500, '{"error":"internal_error","message":"Something went wrong."}']);
  const everything = [...responses, ...logLines].join("\n");
  for (const forbidden of [/select |insert into|update training_load/i, /metric_variable_requests:|metric_variable_changes:|metric_definitions:/, /acting user/, /private-legacy-name/, /kind_shape/]) {
    assert.doesNotMatch(everything, forbidden);
  }
  for (const id of [W.coachA1.id, W.caA.id, W.pa.id]) assert.ok(!everything.includes(id), "no acting user's id");
});

test("9. v44 reads back the same after pg_dump and pg_restore (what gpexe-backup-verify compares): the two triggers, the checks of both record tables and the two functions", async () => {
  const target = await createDisposableDatabase({ prefix: "gpexe", label: "i1rt", baseDatabaseUrl: ORIGINAL_DATABASE_URL });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-i1-roundtrip-"));
  const restored = new pg.Client({ connectionString: target.url });
  try {
    assert.match(target.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
    const u = new URL(db.url);
    const conn = ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username)];
    const env = { PATH: process.env.PATH, PGPASSWORD: decodeURIComponent(u.password) };
    const file = path.join(dir, "i1.dump");
    execFileSync("pg_dump", [...conn, "-d", db.name, "-Fc", "-f", file], { env, stdio: "pipe" });
    execFileSync("pg_restore", [...conn, "--no-owner", "--no-privileges", "-d", target.name, file], { env, stdio: "pipe" });
    await restored.connect();
    const objects = async (c) => ({
      triggers: await rows(c, `select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'training_load' and not t.tgisinternal and t.tgname = any($1) order by 1, 2`, [ICON_TRIGGERS]),
      constraints: await rows(c, `select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid in ('training_load.metric_variable_changes'::regclass, 'training_load.metric_variable_requests'::regclass) order by 1, 2`),
      functions: await rows(c, `select p.proname, md5(pg_get_functiondef(p.oid)) as digest, obj_description(p.oid, 'pg_proc') as comment from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = any($1) order by 1`, [ICON_FUNCTIONS]),
      columns: await rows(c, `select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'training_load'
        and table_name = 'metric_variable_changes' and column_name like '%icon%' order by 1`),
    });
    const source = await objects(k);
    assert.deepEqual([source.triggers.length, source.functions.length, source.columns.length], [2, 2, 2]);
    assert.deepEqual(await objects(restored), source);
  } finally {
    await restored.end().catch(() => {});
    await target.drop();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

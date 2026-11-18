// Calculated variables, step 1 (J21; the Rukovodilac's decisions 1-10 of 2026-11-18): migration v77 and the definition API
// (backend/src/canonicalVariableAdminService.js: POST /variables and POST /variables/:id/versions take a calculation; the reads
// return it). Through the real HTTP stack, on disposable optimove_tests_gpexe_* databases only (never OPTIMOVE): one migrated
// through v76 that rehearses v77's preflight / apply / post-check / rollback / re-apply, one migrated through v77 for the
// behaviour. Nothing computes a value in step 1; the value guard is tested on raw rows, as the writer of the next PR will write them.
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
const V77 = "202611181000_training_load_v77_calculated_variables.sql";
const V77_NAME = `migrations_v2/${V77}`;
const UP_TO_PREV = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V77));
const MIGRATION_PATH = path.resolve(ROOT, "migrations_v2", V77);
const ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/calculated-variables-v77-rollback.sql");
const PREFLIGHT_PATH = path.resolve(ROOT, "docs/runbooks/calculated-variables-v77-preflight.sql");
const POSTCHECK_PATH = path.resolve(ROOT, "docs/runbooks/calculated-variables-v77-postcheck.sql");
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";

let rdb, db, r, k, server, apiBase, appPool;
const W = {};
const logLines = [];
const originalConsole = {};

async function applyV77(url) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v77-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of UP_TO_PREV) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    await fsp.copyFile(MIGRATION_PATH, path.join(dir, V77));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

before(async () => {
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V77), "v77 is a test migration");
  assert.equal(GPEXE_TEST_MIGRATIONS.at(-1), V77, "v77 is the last test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v77rb", migrations: UP_TO_PREV }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "calc77" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  for (const c of [r, k]) await c.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  assert.equal((await k.query(`select 1 from public.schema_migrations where migration_name = $1`, [V77_NAME])).rowCount, 1, "the behaviour database carries v77");
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.CALC_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  const dbModule = await import("../src/db.js");
  const { createSession } = await import("../src/auth.js");
  W.createSession = createSession;
  appPool = dbModule.pool;
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await world();
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) {
    let timer;
    await Promise.race([appPool.end(), new Promise((res) => { timer = setTimeout(res, 5_000); })]);
    clearTimeout(timer);
  }
  for (const c of [r, k]) await c?.end().catch(() => {});
  await rdb?.drop();
  await db?.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});
afterEach(() => {});

// ---------------------------------------------------------------------------
// helpers
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const key = () => crypto.randomUUID();

async function api(p, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${PREFIX}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const post = (p, who, body) => api(p, { method: "POST", cookie: who.cookie, body });
const get = (p, who) => api(p, { cookie: who.cookie });

async function user(label) {
  return (await one(k, `insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,true) returning id`, [`${label}-${uid()}@test.local`, label])).id;
}
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const team = async (clubId) => (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
async function person(label, { platform = false, clubAdminOf = [], coachOf = [], ws }) {
  const id = await user(label);
  if (platform) await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  for (const c of clubAdminOf) await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, c]);
  for (const t of coachOf) await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, t]);
  if (ws) await workspace(id, ws[0], ws[1]);
  return { id, cookie: `optimove_session=${await W.createSession(id)}` };
}

async function variable(who, over = {}) {
  const res = await post("/variables", who, {
    requestKey: key(), label: `Zone distance ${uid()}`, unit: "m", levels: ["session", "drill"], dailyAggregationMethod: "sum", ...over,
  });
  assert.equal(res.status, 201, res.text);
  return res.body.variable;
}
const sum = (...inputs) => ({ kind: "sum", inputs: inputs.map((v) => v.id ?? v) });
async function calculated(who, inputs, over = {}) {
  return post("/variables", who, {
    requestKey: key(), label: `HMLD ${uid()}`, unit: "m", levels: ["session", "drill"], dailyAggregationMethod: "sum",
    calculation: sum(...inputs), ...over,
  });
}
const counts = async () => one(k, `select (select count(*)::int from training_load.metric_definitions) as defs,
  (select count(*)::int from training_load.metric_definition_versions) as versions,
  (select count(*)::int from training_load.metric_variable_requests) as requests`);
function refused(res, status, code) {
  assert.equal(res.status, status, res.text);
  assert.equal(res.body.error, code, res.text);
}
async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    columns: await rows(c, `select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ${S} order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
async function runbook(c, file) {
  const text = (await fsp.readFile(file, "utf8")).split("\n").filter((line) => !line.startsWith("--")).join("\n");
  const out = [];
  for (const statement of text.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) out.push(...(await c.query(statement)).rows);
  return out;
}
const allOk = (blocks) => {
  for (const row of blocks) for (const [col, v] of Object.entries(row)) if (typeof v === "boolean") assert.equal(v, true, `${col} in ${JSON.stringify(row)}`);
};

// A raw value fixture: an event of a team, a participant, an api_import occasion; values written by the caller.
async function occasion(teamId) {
  const ath = (await one(k, `insert into public.athletes (full_name, display_name, device_timezone) values ($1,$1,'Europe/Sarajevo') returning id`, [`Athlete ${uid()}`])).id;
  const ev = (await one(k, `insert into training_load.metric_events (occurred_date, scope_level, owner_scope, owner_team_id) values ('2026-11-10','session','team',$1) returning id`, [teamId])).id;
  const part = (await one(k, `insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Sarajevo') returning id`, [ev, ath])).id;
  return (await one(k, `insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'api_import') returning id`, [part])).id;
}
const versionOf = async (defId) => (await one(k, `select current_version_id as v from training_load.metric_definitions where id = $1`, [defId])).v;
async function value(c, occ, def, n, extra = {}) {
  const cols = ["occasion_id", "metric_definition_id", "metric_definition_version_id", "value_numeric", ...Object.keys(extra)];
  const vals = [occ, def, await versionOf(def), n, ...Object.values(extra)];
  return (await one(c, `insert into training_load.metric_values (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, vals)).id;
}
async function attempt(fn) {
  await k.query("begin");
  try {
    const out = await fn(k);
    await k.query("rollback");
    return { ok: true, out };
  } catch (error) {
    await k.query("rollback").catch(() => {});
    return { ok: false, error };
  }
}
function dbRefused(res, pattern) {
  assert.equal(res.ok, false, `expected a refusal: ${pattern}`);
  assert.equal(res.error.code, "23514", res.error.message);
  assert.match(res.error.message, pattern);
}

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.teamA = await team(W.clubA);
  W.pa = await person("platform-admin", { platform: true, ws: ["platform", null] });
  W.pa2 = await person("platform-admin-2", { platform: true, ws: ["platform", null] });
  W.caA = await person("club-admin-a", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.caB = await person("club-admin-b", { clubAdminOf: [W.clubB], ws: ["club", W.clubB] });
  W.coachA = await person("coach-a", { coachOf: [W.teamA], ws: ["team", W.teamA] });
  // Three power zone distances (system), as HMLD's inputs.
  W.z3 = await variable(W.pa, { label: `Power zone 3 distance ${uid()}` });
  W.z4 = await variable(W.pa, { label: `Power zone 4 distance ${uid()}` });
  W.z5 = await variable(W.pa, { label: `Power zone 5 distance ${uid()}` });
}

// ---------------------------------------------------------------------------
test("1. v77 on a database through v76: the preflight passes, it applies, the post-check passes, the rollback restores the catalog exactly and refuses once a calculated variable exists, and it applies again", async () => {
  allOk(await runbook(r, PREFLIGHT_PATH));
  const before = await catalog(r);
  await applyV77(rdb.url);
  allOk(await runbook(r, POSTCHECK_PATH));
  assert.equal((await one(r, `select count(*)::int n from public.schema_migrations where migration_name = $1`, [V77_NAME])).n, 1);
  await r.query(await fsp.readFile(ROLLBACK_PATH, "utf8"));
  assert.deepEqual(await catalog(r), before, "the rollback restores the catalog before v77 exactly");
  allOk(await runbook(r, PREFLIGHT_PATH));
  await applyV77(rdb.url);
  allOk(await runbook(r, POSTCHECK_PATH));
  // A calculated version: the rollback refuses and changes nothing.
  const defs = [];
  for (let i = 0; i < 3; i += 1) {
    const d = (await one(r, `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id) values ($1,$1,'club',$2) returning id`,
      [`calc_rb_${i}_${uid()}`, (await one(r, `insert into public.clubs (name) values ($1) returning id`, [`Club ${uid()}`])).id])).id;
    defs.push(d);
  }
  const clubId = (await one(r, `select owner_club_id from training_load.metric_definitions where id = $1`, [defs[0]])).owner_club_id;
  await r.query(`update training_load.metric_definitions set owner_club_id = $1 where id = any($2::uuid[])`, [clubId, defs]);
  for (const d of defs) await r.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'session')`, [d]);
  for (const d of defs.slice(0, 2)) {
    const v = (await one(r, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1,1,'m','numeric') returning id`, [d])).id;
    await r.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [v, d]);
  }
  await r.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, calculation) values ($1,1,'m','numeric',$2)`,
    [defs[2], JSON.stringify({ kind: "sum", inputs: defs.slice(0, 2) })]);
  const atRefusal = await catalog(r);
  await assert.rejects(r.query(await fsp.readFile(ROLLBACK_PATH, "utf8")), /v77 rollback refused: a calculated variable exists/);
  await r.query("rollback").catch(() => {});
  assert.deepEqual(await catalog(r), atRefusal, "the refused rollback changed nothing");
});

test("2. a platform admin creates a calculated system variable (HMLD = zone 3 + 4 + 5): one definition, version 1 with the calculation, its levels, one request; the read names the inputs in order; it is no mapping target", async () => {
  const before = await counts();
  const res = await calculated(W.pa, [W.z3, W.z4, W.z5], { label: "HMLD" + uid() });
  assert.equal(res.status, 201, res.text);
  const v = res.body.variable;
  assert.deepEqual(v.currentVersion.calculation, { kind: "sum", inputs: [W.z3, W.z4, W.z5].map((x) => ({ id: x.id, key: x.key, label: x.label })) });
  assert.deepEqual(v.levels, ["session", "drill"]);
  assert.deepEqual(v.mappingTarget, { ready: false, notReadyCode: "canonical_calculated" });
  const after = await counts();
  assert.deepEqual(after, { defs: before.defs + 1, versions: before.versions + 1, requests: before.requests + 1 });
  const stored = await one(k, `select v.calculation from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id = d.current_version_id where d.id = $1`, [v.id]);
  assert.deepEqual(stored.calculation, { kind: "sum", inputs: [W.z3.id, W.z4.id, W.z5.id] });
  const read = await get(`/variables/${v.id}`, W.pa);
  assert.equal(read.status, 200, read.text);
  assert.deepEqual(read.body.variable.versions[0].calculation, v.currentVersion.calculation);
  assert.equal(read.body.variable.versions[0].current, true);
  const list = await get("/variables", W.pa);
  assert.deepEqual(list.body.variables.find((x) => x.id === v.id).currentVersion.calculation, v.currentVersion.calculation);
  assert.equal(list.body.variables.find((x) => x.id === W.z3.id).currentVersion.calculation, null, "an ordinary variable reads calculation: null");
  const targets = await get("/targets", W.pa);
  const t = targets.body.targets.find((x) => x.id === v.id);
  assert.equal(t.versionReady, false);
  assert.equal(t.notReadyCode, "canonical_calculated");
  W.hmld = v;
});

test("3. the same request key replays the answer (no second row); the same key with another body is request_key_reused", async () => {
  const requestKey = key();
  const body = { requestKey, label: `Replay ${uid()}`, unit: "m", levels: ["session"], dailyAggregationMethod: "sum", calculation: sum(W.z3, W.z4) };
  const first = await post("/variables", W.pa, body);
  assert.equal(first.status, 201, first.text);
  const before = await counts();
  const again = await post("/variables", W.pa, body);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.variable.id, first.body.variable.id);
  assert.deepEqual(await counts(), before);
  refused(await post("/variables", W.pa, { ...body, calculation: sum(W.z4, W.z3) }), 409, "request_key_reused");
});

test("4. the body: 1 or 11 inputs, a repeated input, a non-id, another kind or key, bounds or a condition with a calculation are 400 invalid_body, nothing written", async () => {
  const before = await counts();
  const ids = Array.from({ length: 11 }, () => crypto.randomUUID());
  for (const calculation of [
    { kind: "sum", inputs: [W.z3.id] },
    { kind: "sum", inputs: ids },
    { kind: "sum", inputs: [W.z3.id, W.z3.id.toUpperCase()] },
    { kind: "sum", inputs: [W.z3.id, "zone4"] },
    { kind: "ratio", inputs: [W.z3.id, W.z4.id] },
    { kind: "sum", inputs: [W.z3.id, W.z4.id], weights: [1, 1] },
    [W.z3.id, W.z4.id],
    "sum",
  ]) refused(await calculated(W.pa, [], { calculation }), 400, "invalid_body");
  refused(await calculated(W.pa, [W.z3, W.z4], { minValue: "0" }), 400, "invalid_body");
  refused(await calculated(W.pa, [W.z3, W.z4], { maxValue: "100000" }), 400, "invalid_body");
  refused(await calculated(W.pa, [W.z3, W.z4], { condition: { kind: "zone", operator: ">=", value: "5", unit: "m/s" } }), 400, "invalid_body");
  assert.deepEqual(await counts(), before);
});

test("5. every input is checked under its lock: unknown, another club's (read exactly like unknown), archived, calculated, another unit, a missing level; a system variable never takes a club input; nothing written", async () => {
  const clubB = await variable(W.caB, { label: `B zone ${uid()}` });
  const archived = await variable(W.pa, { label: `Old zone ${uid()}` });
  assert.equal((await post(`/variables/${archived.id}/archive`, W.pa, { requestKey: key(), reason: "Not used" })).status, 200);
  const km = await variable(W.pa, { label: `Km zone ${uid()}`, unit: "km" });
  const sessionOnly = await variable(W.pa, { label: `Session zone ${uid()}`, levels: ["session"] });
  const clubA = await variable(W.caA, { label: `A zone ${uid()}` });
  const before = await counts();
  const unknown = await calculated(W.caA, [W.z3, crypto.randomUUID()]);
  refused(unknown, 409, "calculation_input_unavailable");
  const foreign = await calculated(W.caA, [W.z3, clubB]);
  refused(foreign, 409, "calculation_input_unavailable");
  assert.deepEqual(foreign.body, unknown.body, "another club's variable reads exactly like a missing one");
  refused(await calculated(W.pa, [W.z3, archived]), 409, "calculation_input_unavailable");
  refused(await calculated(W.pa, [W.z3, clubA]), 409, "calculation_input_unavailable");
  refused(await calculated(W.pa, [W.z3, W.hmld]), 409, "calculation_input_calculated");
  refused(await calculated(W.pa, [W.z3, km]), 409, "calculation_unit_mismatch");
  refused(await calculated(W.pa, [W.z3, sessionOnly]), 409, "calculation_level_mismatch");
  assert.equal((await calculated(W.pa, [W.z3, sessionOnly], { levels: ["session"] })).status, 201, "the session level alone is in both");
  const after = await counts();
  assert.deepEqual(after, { defs: before.defs + 1, versions: before.versions + 1, requests: before.requests + 1 });
});

test("6. a club admin's calculated variable takes its own club's and system variables; a team coach never creates one", async () => {
  const own = await variable(W.caA, { label: `A own zone ${uid()}` });
  const res = await calculated(W.caA, [own, W.z4]);
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.variable.ownerScope, "club");
  assert.deepEqual(res.body.variable.currentVersion.calculation.inputs.map((i) => i.id), [own.id, W.z4.id]);
  W.clubCalc = res.body.variable;
  const coach = await calculated(W.coachA, [own, W.z4]);
  assert.equal(coach.status, 404, coach.text);
  const reduced = await get(`/variables/${W.clubCalc.id}`, W.coachA);
  assert.equal(reduced.status, 200, reduced.text);
  assert.equal(reduced.body.variable.calculated, true, "the reduced view says calculated, never the inputs");
  assert.equal(JSON.stringify(reduced.body).includes(own.id), false);
});

test("7. a new version: a calculated variable changes its inputs (kept as a calculation); kind changes, an unchanged sum and an input's unit change are refused; any other change of an input is fine", async () => {
  const v = W.hmld;
  const newInputs = await post(`/variables/${v.id}/versions`, W.pa, {
    requestKey: key(), expectedCurrentVersionId: v.currentVersion.id, unit: "m", dailyAggregationMethod: "sum", calculation: sum(W.z4, W.z5),
  });
  assert.equal(newInputs.status, 201, newInputs.text);
  assert.equal(newInputs.body.version.versionNumber, 2);
  assert.deepEqual(newInputs.body.version.calculation.inputs.map((i) => i.id), [W.z4.id, W.z5.id]);
  const current = newInputs.body.version.id;
  refused(await post(`/variables/${v.id}/versions`, W.pa, { requestKey: key(), expectedCurrentVersionId: current, unit: "m", dailyAggregationMethod: "avg" }), 409, "calculation_kind_fixed");
  refused(await post(`/variables/${v.id}/versions`, W.pa, { requestKey: key(), expectedCurrentVersionId: current, unit: "m", dailyAggregationMethod: "sum", calculation: sum(W.z4, W.z5) }), 409, "version_unchanged");
  refused(await post(`/variables/${W.z3.id}/versions`, W.pa, { requestKey: key(), expectedCurrentVersionId: W.z3.currentVersion.id, unit: "m", dailyAggregationMethod: "sum", calculation: sum(W.z4, W.z5) }), 409, "calculation_kind_fixed");
  // z4 is an input of HMLD's current version: its unit stays.
  refused(await post(`/variables/${W.z4.id}/versions`, W.pa, { requestKey: key(), expectedCurrentVersionId: W.z4.currentVersion.id, unit: "km", dailyAggregationMethod: "sum" }), 409, "variable_used_by_calculation");
  const agg = await post(`/variables/${W.z4.id}/versions`, W.pa, { requestKey: key(), expectedCurrentVersionId: W.z4.currentVersion.id, unit: "m", dailyAggregationMethod: "max" });
  assert.equal(agg.status, 201, agg.text);
  W.hmldVersion = current;
  // An input that leaves a calculation's current version may change its unit again.
  const q1 = await variable(W.pa, { label: `Q1 ${uid()}` });
  const q2 = await variable(W.pa, { label: `Q2 ${uid()}` });
  const c = (await calculated(W.pa, [q1, q2])).body.variable;
  refused(await post(`/variables/${q1.id}/versions`, W.pa, { requestKey: key(), expectedCurrentVersionId: q1.currentVersion.id, unit: "km", dailyAggregationMethod: "sum" }), 409, "variable_used_by_calculation");
  assert.equal((await post(`/variables/${c.id}/versions`, W.pa, { requestKey: key(), expectedCurrentVersionId: c.currentVersion.id, unit: "m", dailyAggregationMethod: "sum", calculation: sum(q2, W.z4) })).status, 201);
  const q1km = await post(`/variables/${q1.id}/versions`, W.pa, { requestKey: key(), expectedCurrentVersionId: q1.currentVersion.id, unit: "km", dailyAggregationMethod: "sum" });
  assert.equal(q1km.status, 201, q1km.text);
});

test("8. no mapping targets a calculated variable: the API refuses a version with canonical_calculated (nothing written) and the database refuses a raw one", async () => {
  const def = await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Test field',$2) returning id`, [`calc.test.f${uid()}`, W.pa.id]);
  const rev = await writeRevision(k, { fieldId: def.id, by: W.pa.id, evidenceRef: COMPAT, unit: "m", unitRef: COMPAT, meaning: true, meaningRef: COMPAT });
  const mapping = await post("/mappings", W.pa, { requestKey: key(), sourceMetricId: def.id, metricDefinitionId: W.hmld.id });
  assert.equal(mapping.status, 201, mapping.text);
  const before = await one(k, `select count(*)::int n from training_load.source_metric_mapping_versions`);
  refused(await post(`/mappings/${mapping.body.mapping.id}/versions`, W.pa, { requestKey: key(), sourceRevisionId: rev, appliesToSession: true, appliesToDrill: false }), 409, "canonical_calculated");
  assert.deepEqual(await one(k, `select count(*)::int n from training_load.source_metric_mapping_versions`), before);
  // The database itself (the guard runs before the other v34 version checks need anything else).
  const raw = await attempt((c) => c.query(
    `insert into training_load.source_metric_mapping_versions (mapping_id, version_number, source_metric_definition_id, metric_definition_id, source_metric_version_id, metric_definition_version_id)
     values ($1, 1, $2, $3, $4, $5)`, [mapping.body.mapping.id, def.id, W.hmld.id, rev, W.hmldVersion]));
  assert.equal(raw.ok, false);
  assert.equal(raw.error.code, "23514", raw.error.message);
  assert.match(raw.error.message, /a calculated variable is never the target of a mapping/);
});

test("9. the database guards of a version and of the levels: a variable never changes kind, a calculated version has no bounds or condition, levels follow the inputs both ways", async () => {
  const { hmld } = W;
  const calc = JSON.stringify({ kind: "sum", inputs: [W.z4.id, W.z5.id] });
  dbRefused(await attempt((c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1, 9, 'm', 'numeric')`, [hmld.id])),
    /calculated from its first version or never/);
  dbRefused(await attempt((c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, calculation) values ($1, 9, 'm', 'numeric', $2)`, [W.z5.id, calc])),
    /calculated from its first version or never/);
  dbRefused(await attempt((c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, calculation, max_value) values ($1, 9, 'm', 'numeric', $2, 100)`, [hmld.id, calc])),
    /no bounds and no condition/);
  dbRefused(await attempt((c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, calculation) values ($1, 9, 'm', 'numeric', $2)`,
    [hmld.id, JSON.stringify({ kind: "sum", inputs: [W.z4.id, hmld.id] })])), /not its own input/);
  const km = await variable(W.pa, { label: `Km input ${uid()}`, unit: "km" });
  dbRefused(await attempt((c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, calculation) values ($1, 9, 'm', 'numeric', $2)`,
    [hmld.id, JSON.stringify({ kind: "sum", inputs: [W.z4.id, km.id] })])), /numeric with the calculated variable's unit/);
  dbRefused(await attempt((c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1, 9, 'km', 'numeric')`, [W.z5.id])),
    /uses this variable; its unit and type stay/);
  dbRefused(await attempt((c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, calculation) values ($1, 9, 'm', 'numeric', $2)`,
    [hmld.id, JSON.stringify({ kind: "sum", inputs: [W.z4.id, crypto.randomUUID()] })])), /active variable of the same owner/);
  const shape = await attempt((c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, calculation) values ($1, 9, 'm', 'numeric', '{"kind":"sum","inputs":[]}')`, [hmld.id]));
  assert.equal(shape.ok, false);
  assert.equal(shape.error.constraint, "metric_definition_versions_calculation_shape");
  dbRefused(await attempt((c) => c.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, 'day')`, [hmld.id])),
    /only a level all its inputs have/);
  dbRefused(await attempt((c) => c.query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'component'`, [W.z5.id])),
    /uses this level of this variable/);
  const zUnused = await variable(W.pa, { label: `Unused zone ${uid()}` });
  const dropped = await attempt((c) => c.query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'component'`, [zUnused.id]));
  assert.equal(dropped.ok, true, dropped.error?.message);
});

test("10. the value guard: a calculated value is exactly the sum of one non-derived value per input on its own occasion; zero is a value; anything else is refused", async () => {
  const occ = await occasion(W.teamA);
  const hv = W.hmldVersion;
  const ok = await attempt(async (c) => {
    const a = await value(c, occ, W.z4.id, 120.5);
    const b = await value(c, occ, W.z5.id, 0);
    const derived = (ids, n) => value(c, occ, W.hmld.id, n, {
      is_derived: true, aggregation_role: "derived_rollup", coverage: "complete", computed_by_ref: JSON.stringify({ formulaVersionId: hv, inputValueIds: ids }),
    });
    await derived([a, b], 120.5);
    return (await one(c, `select count(*)::int n from training_load.metric_values where occasion_id = $1`, [occ])).n;
  });
  assert.equal(ok.ok, true, ok.error?.message);
  assert.equal(ok.out, 3, "zero is a value: both inputs and the sum");
  const bad = async (fn, pattern) => dbRefused(await attempt(async (c) => {
    const a = await value(c, occ, W.z4.id, 100);
    const b = await value(c, occ, W.z5.id, 20);
    return fn(c, a, b);
  }), pattern);
  const ref = (ids) => JSON.stringify({ formulaVersionId: hv, inputValueIds: ids });
  const calc = (extra) => ({ is_derived: true, aggregation_role: "derived_rollup", coverage: "complete", ...extra });
  await bad((c, a, b) => value(c, occ, W.hmld.id, 121, calc({ computed_by_ref: ref([a, b]) })), /exactly the sum/);
  await bad((c, a) => value(c, occ, W.hmld.id, 100, calc({ computed_by_ref: ref([a]) })), /one input value per input/);
  await bad((c, a) => value(c, occ, W.hmld.id, 200, calc({ computed_by_ref: ref([a, a]) })), /one input value per input/);
  await bad((c, a, b) => value(c, occ, W.hmld.id, 120, calc({ coverage: "partial", computed_by_ref: ref([a, b]) })), /written only as its calculation/);
  await bad((c, a, b) => value(c, occ, W.hmld.id, 120, calc({ computed_by_ref: JSON.stringify({ formulaVersionId: hv, inputValueIds: [a, b], note: 1 }) })), /written only as its calculation/);
  await bad((c, a, b) => value(c, occ, W.hmld.id, 120, calc({ computed_by_ref: JSON.stringify({ formulaVersionId: W.hmld.currentVersion.id, inputValueIds: [a, b] }) })), /./);
  await bad((c) => value(c, occ, W.hmld.id, 120), /written only as its calculation/);
  // An input value of another occasion (another athlete) is never an input.
  const other = await occasion(W.teamA);
  dbRefused(await attempt(async (c) => {
    const a = await value(c, occ, W.z4.id, 100);
    const b = await value(c, other, W.z5.id, 20);
    return value(c, occ, W.hmld.id, 120, calc({ computed_by_ref: ref([a, b]) }));
  }), /on its own occasion/);
  // A formula reference on an ordinary value.
  dbRefused(await attempt(async (c) => {
    const a = await value(c, occ, W.z4.id, 100);
    return value(c, occ, W.z5.id, 100, calc({ computed_by_ref: JSON.stringify({ formulaVersionId: hv, inputValueIds: [a] }) }));
  }), /names a calculated version/);
});

test("11. the estimate and board readers never offer a calculated variable; the older catalog keeps writing team variables unchanged", async () => {
  const { copyUnsupportedReason } = await import("../src/canonicalVariableAdminService.js");
  assert.equal(copyUnsupportedReason({ calculated: true, value_type: "numeric", unit_present: true, unit_is_token: true, scopes: ["session"] }), "calculated");
  const list = await get("/variables?scope=system", W.caA);
  assert.equal(list.status, 200, list.text);
  const sys = list.body.variables.find((x) => x.id === W.hmld.id);
  assert.ok(sys, "the club reads the calculated system variable");
  assert.equal(sys.actions.includes("copy"), false, "a calculated system variable is not copied in step 1");
  assert.equal(logLines.some((l) => /stack|at \w+ \(/.test(l) && /calculation/.test(l)), false, "no stack trace logged");
});

test("12. a race: a new version of an input that changes its unit waits for a calculation being created over it, then is refused; nothing mixes units", async () => {
  const variables = await import("../src/canonicalVariableAdminService.js");
  const p1 = await variable(W.pa, { label: `Race 1 ${uid()}` });
  const p2 = await variable(W.pa, { label: `Race 2 ${uid()}` });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reached;
  const atHold = new Promise((resolve) => { reached = resolve; });
  variables.setVariableWriteHoldForTests(async (_client, point) => {
    if (point === "variable_create") { reached(); await held; }
  });
  try {
    const creating = calculated(W.pa, [p1, p2]);
    await atHold; // the calculation holds p1 and p2 FOR SHARE
    variables.setVariableWriteHoldForTests(null);
    // Another platform admin (one user's writes are serialized by its own advisory lock, which would prove nothing).
    const changing = post(`/variables/${p1.id}/versions`, W.pa2, { requestKey: key(), expectedCurrentVersionId: p1.currentVersion.id, unit: "km", dailyAggregationMethod: "sum" });
    // The unit change waits on p1's row lock while the calculation is open.
    let waited = false;
    for (let i = 0; i < 50 && !waited; i += 1) {
      waited = (await one(k, `select count(*)::int n from pg_locks l join pg_stat_activity a on a.pid = l.pid
                                where not l.granted and l.locktype in ('tuple', 'transactionid') and a.datname = current_database()`)).n > 0;
      if (!waited) await new Promise((res) => setTimeout(res, 20));
    }
    assert.equal(waited, true, "the unit change waits for the calculation's lock");
    release();
    assert.equal((await creating).status, 201);
    refused(await changing, 409, "variable_used_by_calculation");
  } finally {
    release();
    variables.setVariableWriteHoldForTests(null);
  }
  const units = await rows(k, `select v.unit from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id = d.current_version_id where d.id = any($1::uuid[])`, [[p1.id, p2.id]]);
  assert.deepEqual(units.map((u) => u.unit), ["m", "m"]);
});

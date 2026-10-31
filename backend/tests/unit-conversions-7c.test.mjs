// Phase 7c - maintaining the unit conversions (POST /conversions, POST
// /conversions/:conversionId/retire and the paged GET /conversions under
// /api/training-load/sources/metrics) and migration v47, their database actor
// guard. Contract: docs/ai/phase7c-unit-conversions-contract.md (J9), section 8.
// Through the real HTTP stack, on disposable optimove_tests_gpexe_* databases
// only (never OPTIMOVE): one migrated through v46 that rehearses v47 (the
// preflight, the runner while a reader holds a row, the post-check, every
// refusal of the rollback, the rollback back to v46's exact catalog, v47 again,
// and the atomicity of a failing migration), and one migrated through v47 for
// the behaviour. Every conversion, field, variable and mapping here is a test
// row of this file, except the v34 seed row this file retires once (test 4).
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
import { createConversion, createConversionStatements } from "./support/unit-conversions.mjs";
import { allowSyntheticTestFields } from "./support/test-extractors.mjs";

allowSyntheticTestFields();

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V47 = "202610301700_training_load_v47_unit_conversion_guards.sql";
const V47_NAME = `migrations_v2/${V47}`;
const V46_NAME = "migrations_v2/202610301300_training_load_v46_classification_icons.sql";
const UP_TO_V46 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V47));
const V47_FILE = path.resolve(ROOT, "migrations_v2", V47);
const RUNBOOKS = path.resolve(ROOT, "docs/runbooks");
const ROLLBACK = path.join(RUNBOOKS, "unit-conversion-guards-v47-rollback.sql");
const PREFLIGHT = path.join(RUNBOOKS, "unit-conversion-guards-v47-preflight.sql");
const POSTCHECK = path.join(RUNBOOKS, "unit-conversion-guards-v47-postcheck.sql");
const PREFIX = "/api/training-load/sources/metrics";
const EVIDENCE = "docs/ai/test-evidence.md#a-conversion";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const V47_ACTOR = /^unit conversion: the acting user may not write this conversion$/;
const V47_TIME = /^unit conversion: a retirement carries the time of its own transaction$/;
const V47_AUDIT_FOLLOWS = /^source_metric_audit: the audit row must follow its own conversion change in the same transaction$/;
const V47_AUDIT_ONCE = /^source_metric_audit: the conversion change already has its audit row$/;
const V47_CREATE_LINK = /^unit_conversions: a conversion is written with its unit_conversion_create audit row$/;
const V47_RETIRE_LINK = /^unit_conversions: a retirement is written with its unit_conversion_retire audit row$/;

let rdb, db, r, k, server, apiBase, service, conversions, dbModule, appPool, createSession;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};

async function migrate(url, files, { extra = null } = {}) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v47-migrations-"));
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
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V47), "v47 is a test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v47rb", migrations: UP_TO_V46 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v47" }),
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
      if (process.env.V47_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  conversions = await import("../src/unitConversionService.js");
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
  conversions?.setConversionWriteHoldForTests(null);
  conversions?.setConversionSeamsForTests();
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
// Every reason sent through retire(); test 16 scans every answer and log line for them.
const sentReasons = new Set();
let unitSeq = 0;
const pair = () => { unitSeq += 1; return { fromUnit: `cf${unitSeq}x${uid()}`, toUnit: `ct${unitSeq}x${uid()}` }; };
const createBody = (over = {}) => ({ requestKey: key(), ...pair(), scale: "2", scaleDivisor: "1", offset: "0", evidenceRef: EVIDENCE, ...over });
const create = (cookie, body = createBody()) => post("/conversions", cookie, body);
const retire = (id, cookie, { reason = `Wrong factor ${uid()}.`, requestKey = key(), expectedState = "active" } = {}) => {
  if (typeof reason === "string") sentReasons.add(reason);
  return post(`/conversions/${id}/retire`, cookie, { requestKey, expectedState, reason });
};
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const refused = (res, status, code) => { assert.deepEqual([res.status, res.body.error], [status, code], res.text); return res.body; };
const isNotFound = (res, label) => { assert.equal(res.status, 404, `${label}: ${res.text}`); assert.deepEqual(res.body, { error: "notFound" }, label); };
const conversionRow = (id) => one(k, `select *, trim_scale(scale)::text as scale_t, trim_scale(scale_divisor)::text as divisor_t, trim_scale("offset")::text as offset_t from training_load.unit_conversions where id = $1`, [id]);
const auditOf = (id) => rows(k, `select * from training_load.source_metric_audit where unit_conversion_id = $1 order by performed_at, id`, [id]);
const auditCount = async () => (await one(k, `select count(*)::int as n from training_load.source_metric_audit where action in ('unit_conversion_create', 'unit_conversion_retire')`)).n;
const conversionCount = async () => (await one(k, `select count(*)::int as n from training_load.unit_conversions`)).n;

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
  const teamId = (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
  const id = await user("coach");
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await workspace(id, "team", teamId);
  return { id, cookie: await cookieFor(id) };
}
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const revokePlatform = (id) => k.query(`update public.user_global_roles set is_active = false where user_id = $1`, [id]);
const restorePlatform = (id) => k.query(`update public.user_global_roles set is_active = true where user_id = $1`, [id]);

// A canonical variable through the M3-0 API (numeric, both levels).
async function variable(owner, over = {}) {
  const res = await post("/variables", owner.cookie, { requestKey: key(), label: `Conversion variable ${uid()}`, unit: "s", levels: ["session", "drill"], dailyAggregationMethod: "sum", ...over });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.variable.id };
}
// A test field of gpexe / rest_v1 whose revision 1 is active and verified with `unit`.
async function field(unit) {
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'7c test field',$2) returning id`,
    [`v47.test.f${uid()}`, W.pa.id])).id;
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, evidenceRef: COMPAT, unit, unitRef: UNIT_REF, meaning: true, meaningRef: MEANING_REF, state: "active" });
  return { fieldId, revId };
}
// A mapping version of field `f` to `target` through the real M2 routes, submitted.
async function version(f, target, { submit = true } = {}) {
  const m = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id });
  assert.equal(m.status, 201, m.text);
  const v = await post(`/mappings/${m.body.mapping.id}/versions`, W.pa.cookie, { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true, conversionNote: "Test conversion." });
  assert.equal(v.status, 201, v.text);
  if (submit) assert.equal((await post(`/mappings/${m.body.mapping.id}/versions/${v.body.version.id}/submit`, W.pa.cookie, { requestKey: key() })).status, 200);
  return { mappingId: m.body.mapping.id, versionId: v.body.version.id };
}
const activate = (v) => post(`/mappings/${v.mappingId}/versions/${v.versionId}/activate`, W.pa.cookie, { requestKey: key(), expectedActiveVersionId: null });
const draftOf = (f, target, mappingId) => post(`/mappings/${mappingId}/versions`, W.pa.cookie, { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true, conversionNote: "Test conversion." });

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
const insertRow = (c, { from = `sq${uid()}`, to = `sr${uid()}`, scale = "2", divisor = "1", by, seed = null } = {}) => c.query(
  `insert into training_load.unit_conversions (from_unit, to_unit, scale, scale_divisor, "offset", evidence_ref, created_by_user_id, seed_migration)
   values ($1, $2, $3::numeric, $4::numeric, 0, $5, $6, $7) returning id`, [from, to, scale, divisor, EVIDENCE, by ?? null, seed]).then((x) => x.rows[0].id);
const auditRow = (c, { action, id, by, from = null, to, reason = null, evidence = null }) => c.query(
  `insert into training_load.source_metric_audit (action, unit_conversion_id, from_status, to_status, reason, evidence_ref, performed_by_user_id, basis, operation_id)
   values ($1, $2, $3, $4, $5, $6, $7, 'platform_admin', $8)`, [action, id, from, to, reason, evidence, by, crypto.randomUUID()]);
const retireRow = (c, id, by, { at = "now()" } = {}) => c.query(
  `update training_load.unit_conversions set state = 'retired', retired_by_user_id = $2, retired_at = ${at}, retired_reason = 'Direct SQL retirement' where id = $1`, [id, by]);

async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    tables: await rows(c, `select table_schema, table_name from information_schema.tables where table_schema in ${S} order by 1, 2`),
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
async function someoneWaits(client = k, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await one(client, `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`)).n > 0) return true;
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
// Holds the next conversion write named `where` (unit_conversion_create /
// _retire) after its locks and checks until the gate opens; `fail` makes the
// held write throw when released (its transaction rolls back).
function holdConversion(where, { fail = false } = {}) {
  const g = gate();
  const state = { entered: false };
  conversions.setConversionWriteHoldForTests(async (_client, at) => {
    if (at !== where || state.entered) return;
    state.entered = true;
    await g.promise;
    if (fail) throw new Error("released to fail");
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

async function world() {
  W.clubA = await club("Club A");
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
// The rehearsal database (through v46).
// ---------------------------------------------------------------------------
// Factor pairs inside and outside D5's normal form: the JavaScript rule, v47's
// function (test 5) and the preflight's block 4 (test 1) must agree on each.
const NORMAL_FORM_PAIRS = [["3.6", "1"], ["0.001", "1"], ["1", "60"], ["1", "3.6"], ["1", "4"], ["1", "0.25"], ["1", "2"], ["1", "1"], ["2", "2"], ["36", "10"],
  ["2", "120"], ["1", "7"], ["1", "0.3"], ["1", "12.5"], ["1", "1.5"], ["1", "0.125"], ["7", "1"], ["1", "1024"], ["1", "3000"], ["0.5", "1"]];

test("1. on v46: every expected value of the read-only preflight; its block 4 counts a planted row the new rules refuse (and judges every pair of test 5 as the JavaScript rule does), and v47 itself then refuses, changing nothing; the rollback refuses without v47", async () => {
  const pre = await blocks(r, PREFLIGHT);
  assert.deepEqual(Object.keys(pre).map(Number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(pre[1][0].pg15_or_later, true);
  assert.deepEqual(pre[2][0], { v46_rows: "1", v46_checksum_ok: true, v39_rows: "1", v39_checksum_ok: true, v47_rows: "0", at_or_after_v47: "0", last_migration: V46_NAME });
  assert.deepEqual(pre[3][0], { revision_guard_is_v39: true, v47_functions: "0", v47_triggers: "0", v47_constraints: "0", v47_index: "0" });
  assert.deepEqual(pre[4][0], { refused_rows: "0", safe_to_merge: true, rows_total: "4", seed_rows: "4", api_rows: "0", retired_rows: "0" });
  W.pre4 = pre[4][0];
  assert.deepEqual(pre[5][0], { conversion_audit_rows: "0" });
  assert.deepEqual(pre[6][0], { schema_create: true, owns_conversions: true, owns_audit: true, disabled_triggers: "0" });
  assert.deepEqual(pre[7][0], { actor_defaults: "0" });
  assert.deepEqual(pre[8][0], { table_locks: "0", idle_in_transaction: "0" });
  // Block 4 and v47's own fail-closed check count the rows the new rules refuse:
  // (1, 4) - v34 takes it (scale = 1) - and a unit with a space (rows planted
  // with triggers off, rolled back).
  const v47Text = await fsp.readFile(V47_FILE, "utf8");
  for (const [plant, refusal] of [
    [{ from: "pa", to: "pb", scale: "1", divisor: "4" }, /^v47 refused: rows the new rules refuse exist \(a factor pair is not in the normal form\)$/],
    [{ from: "p a", to: "pb", scale: "2", divisor: "1" }, /^v47 refused: rows the new rules refuse exist \(a unit is not a unit token\)$/],
  ]) {
    await r.query("begin");
    try {
      await r.query("set local session_replication_role = replica");
      await r.query(`insert into training_load.unit_conversions (from_unit, to_unit, scale, scale_divisor, "offset", evidence_ref, created_by_user_id)
                     values ($1, $2, $3::numeric, $4::numeric, 0, $5, gen_random_uuid())`, [plant.from, plant.to, plant.scale, plant.divisor, EVIDENCE]);
      const b4 = (await blocks(r, PREFLIGHT))[4][0];
      assert.deepEqual([b4.refused_rows, b4.safe_to_merge], ["1", false], JSON.stringify(plant));
      await r.query("savepoint s");
      await assert.rejects(r.query(v47Text), (e) => e.code === "23514" && refusal.test(e.message));
      await r.query("rollback to savepoint s");
    } finally {
      await r.query("rollback");
    }
  }
  // Block 4's inline rule judges every pair as isNormalFormPair does (one
  // planted row at a time, rolled back). v34's CHECK (scale = 1 or divisor = 1)
  // already keeps the other pairs out of the table, so only those are planted.
  const plantable = NORMAL_FORM_PAIRS.filter(([scale, divisor]) => Number(scale) === 1 || Number(divisor) === 1);
  assert.ok(plantable.some(([s, d]) => service.isNormalFormPair(s, d)) && plantable.some(([s, d]) => !service.isNormalFormPair(s, d)));
  for (const [scale, divisor] of plantable) {
    await r.query("begin");
    try {
      await r.query("set local session_replication_role = replica");
      await r.query(`insert into training_load.unit_conversions (from_unit, to_unit, scale, scale_divisor, "offset", evidence_ref, created_by_user_id)
                     values ('pa', 'pb', $1::numeric, $2::numeric, 0, $3, gen_random_uuid())`, [scale, divisor, EVIDENCE]);
      const b4 = (await blocks(r, PREFLIGHT))[4][0];
      const normal = service.isNormalFormPair(scale, divisor);
      assert.deepEqual([b4.refused_rows, b4.safe_to_merge], [normal ? "0" : "1", normal], `block 4 on (${scale}, ${divisor})`);
    } finally {
      await r.query("rollback");
    }
  }
  assert.match((await inRolledBack(r, null, ROLLBACK))?.message ?? "", /^v47 rollback refused: v47 is not recorded on this database$/);
  W.before46 = await catalog(r);
});

test("2. v47 through the runner on v46 - waiting for a reader that holds a conversion row FOR SHARE, then applying with no deadlock - adds exactly its four functions, three triggers, two CHECKs and one index and replaces the audit guard's body; every expected value of the post-check", async () => {
  const holder = new pg.Client({ connectionString: rdb.url });
  await holder.connect();
  let applying;
  try {
    await holder.query("begin");
    await holder.query(`select id from training_load.unit_conversions where from_unit = 's' and to_unit = 'min' for share`);
    applying = migrate(rdb.url, [...UP_TO_V46, V47]);
    assert.equal(await someoneWaits(r), true, "v47 waits for the reader's FOR SHARE");
    await holder.query("commit");
    await applying;
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  const after = await catalog(r);
  const before = W.before46;
  for (const part of ["tables", "columns"]) assert.deepEqual(after[part], before[part], `${part} unchanged`);
  const conKey = (x) => `${x.rel}.${x.conname}`;
  assert.deepEqual(after.constraints.filter((x) => !before.constraints.some((y) => conKey(y) === conKey(x))).map((x) => [x.rel, x.conname, x.contype, x.convalidated]).sort(), [
    ["training_load.unit_conversions", "unit_conversions_factors_normal_form", "c", true],
    ["training_load.unit_conversions", "unit_conversions_units_are_tokens", "c", true],
    ["training_load.unit_conversions", "unit_conversions_v47_audit_link_insert", "t", true],
    ["training_load.unit_conversions", "unit_conversions_v47_audit_link_retire", "t", true],
  ]);
  assert.deepEqual(after.constraints.filter((x) => before.constraints.some((y) => conKey(y) === conKey(x))), before.constraints, "every other constraint unchanged");
  assert.deepEqual(after.indexes.filter((x) => !before.indexes.some((y) => y.indexname === x.indexname)).map((x) => x.indexname), ["source_metric_audit_v47_conversion_once"]);
  assert.deepEqual(after.indexes.filter((x) => x.indexname !== "source_metric_audit_v47_conversion_once"), before.indexes);
  const fnKey = (x) => `${x.nspname}.${x.proname}(${x.args})`;
  const newFunctions = after.functions.filter((x) => !before.functions.some((y) => fnKey(y) === fnKey(x)));
  assert.deepEqual(newFunctions.map((x) => x.proname).sort(), ["source_metric_factor_pair_normal", "unit_conversions_actor_guard", "unit_conversions_create_link", "unit_conversions_retire_link"]);
  const changed = after.functions.filter((x) => !newFunctions.includes(x) && !before.functions.some((y) => fnKey(y) === fnKey(x) && y.digest === x.digest));
  assert.deepEqual(changed.map((x) => x.proname), ["source_metric_audit_revision_guard"], "only the audit guard's body changed");
  const trigKey = (x) => `${x.relname}.${x.tgname}`;
  const newTriggers = after.triggers.filter((x) => !before.triggers.some((y) => trigKey(y) === trigKey(x)));
  assert.deepEqual(newTriggers.map((x) => [x.relname, x.tgname, x.tgenabled]).sort(), [
    ["unit_conversions", "unit_conversions_v47_actor_guard", "O"], ["unit_conversions", "unit_conversions_v47_audit_link_insert", "O"], ["unit_conversions", "unit_conversions_v47_audit_link_retire", "O"]]);
  assert.deepEqual(after.triggers.filter((x) => !newTriggers.includes(x)), before.triggers, "every other trigger unchanged");
  assert.deepEqual(after.migrations, [...before.migrations, V47_NAME].sort());
  // v39's body plus the conversion branch, nothing else: v47's body with the
  // branch cut out is v39's, byte for byte.
  const prosrc = async (c) => (await one(c, `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = 'source_metric_audit_revision_guard'`)).prosrc;
  const v47Body = await prosrc(r);
  const branchStart = v47Body.indexOf("  if new.action in ('unit_conversion_create', 'unit_conversion_retire') then");
  const branchEnd = v47Body.indexOf("  if new.action not in ('source_metric_unit_verified', 'source_metric_meaning_verified') then");
  assert.ok(branchStart > 0 && branchEnd > branchStart);
  W.v39Body = v47Body.slice(0, branchStart) + v47Body.slice(branchEnd);
  const post = await blocks(r, POSTCHECK);
  assert.deepEqual(Object.keys(post).map(Number), [1, 2, 3, 4, 5]);
  assert.deepEqual(post[1][0], { v47_rows: "1", v47_checksum_ok: true, later_rows: "0", last_migration: V47_NAME, v46_rows: "1" });
  assert.deepEqual(post[2][0], { revision_guard_is_v47: true, factor_pair_normal_is_v47: true, actor_guard_is_v47: true, create_link_is_v47: true, retire_link_is_v47: true });
  assert.deepEqual(post[3], [
    { tgname: "unit_conversions_v47_actor_guard", tgtype: 23, tgdeferrable: false, tginitdeferred: false, tgenabled: "O", calls_v47_function: true, has_when: false },
    { tgname: "unit_conversions_v47_audit_link_insert", tgtype: 5, tgdeferrable: true, tginitdeferred: true, tgenabled: "O", calls_v47_function: true, has_when: true },
    { tgname: "unit_conversions_v47_audit_link_retire", tgtype: 17, tgdeferrable: true, tginitdeferred: true, tgenabled: "O", calls_v47_function: true, has_when: true },
  ]);
  assert.deepEqual(post[4][0], { index_valid: true, checks_validated: "2" });
  assert.deepEqual(post[5][0], { rows_total: W.pre4.rows_total, seed_rows: W.pre4.seed_rows, api_rows: "0", retired_rows: "0", conversion_audit_rows: "0" });
  const sha = crypto.createHash("sha256").update(await fsp.readFile(V47_FILE)).digest("hex");
  assert.ok((await fsp.readFile(POSTCHECK, "utf8")).includes(sha), "the post-check names the v47 file's sha256");
  W.after47 = after;
});

test("3. the rollback refuses, changing nothing: under a later migration, once a conversion was created through the API or retired, once a conversion audit row exists, while a v47 object is missing or a v47 trigger is disabled, while the audit guard in force is not v47's, and while the migrator holds its lock", async () => {
  const refuses = async (plant, pattern) => {
    const error = await inRolledBack(r, plant, ROLLBACK);
    assert.match(error?.message ?? "", pattern);
    assert.deepEqual(await catalog(r), W.after47, `nothing changed (${pattern})`);
  };
  const actor = (await one(r, `insert into public.users (email) values ($1) returning id`, [`v47-rb-${uid()}@test.local`])).id;
  await r.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [actor]);
  const asActor = async (c) => c.query(CTX, [actor]);
  await refuses((c) => c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', $1, 'test')`, ["0".repeat(64)]),
    /^v47 rollback refused: later migrations are applied$/);
  await refuses(async (c) => {
    await asActor(c);
    await createConversionStatements(c, { from: "rba", to: "rbb", scale: "2", by: actor });
  }, /^v47 rollback refused: a conversion was created through the API; a unit conversion audit row exists$/);
  await refuses(async (c) => {
    await c.query("set local session_replication_role = replica");
    await c.query(`update training_load.unit_conversions set state = 'retired', retired_by_user_id = $1, retired_at = now(), retired_reason = 'x' where from_unit = 's' and to_unit = 'min'`, [actor]);
  }, /^v47 rollback refused: a conversion is retired$/);
  await refuses(async (c) => {
    await c.query("set local session_replication_role = replica");
    await c.query(`insert into training_load.source_metric_audit (action, unit_conversion_id, to_status, evidence_ref, performed_by_user_id, basis, operation_id)
                   select 'unit_conversion_create', id, 'active', evidence_ref, $1, 'platform_admin', gen_random_uuid() from training_load.unit_conversions limit 1`, [actor]);
  }, /^v47 rollback refused: a unit conversion audit row exists$/);
  await refuses((c) => c.query(`alter table training_load.unit_conversions disable trigger unit_conversions_v47_actor_guard`),
    /^v47 rollback refused: a v47 trigger is disabled$/);
  await refuses(async (c) => {
    await c.query(`drop trigger unit_conversions_v47_audit_link_retire on training_load.unit_conversions`);
    await c.query(`drop function training_load.unit_conversions_retire_link()`);
  }, /^v47 rollback refused: a v47 function is missing; a v47 trigger is missing$/);
  await refuses((c) => c.query(`alter table training_load.unit_conversions drop constraint unit_conversions_units_are_tokens`),
    /^v47 rollback refused: a v47 constraint is missing$/);
  await refuses((c) => c.query(`drop index training_load.source_metric_audit_v47_conversion_once`),
    /^v47 rollback refused: the v47 index is missing$/);
  await refuses((c) => c.query(`create or replace function training_load.source_metric_audit_revision_guard() returns trigger as $$ begin return new; end; $$ language plpgsql`),
    /^v47 rollback refused: the audit guard in force is not v47's$/);
  assert.match(await fsp.readFile(path.join(ROOT, "backend", "src", "migrate.js"), "utf8"), /export const MIGRATION_LOCK_KEY = 822026n;/);
  const migrator = new pg.Client({ connectionString: rdb.url });
  await migrator.connect();
  try {
    await migrator.query("select pg_advisory_lock(822026)");
    await refuses(null, /^v47 rollback refused: the migrator is running$/);
  } finally {
    await migrator.query("select pg_advisory_unlock(822026)").catch(() => {});
    await migrator.end();
  }
  for (const file of [ROLLBACK, PREFLIGHT, POSTCHECK, V47_FILE]) {
    assert.ok(!(await fsp.readFile(file, "utf8")).includes("\r"), `${path.basename(file)} has LF line endings`);
  }
});

test("4. the rollback returns v46's catalog exactly (comments included; v39's body of the audit guard byte for byte) and changes no row; v47 then applies again to the same catalog; a v47 whose last statement fails leaves nothing", async () => {
  const before = (await one(r, `select count(*)::int as n from training_load.unit_conversions`)).n;
  await r.query(await fsp.readFile(ROLLBACK, "utf8"));
  assert.deepEqual(await catalog(r), W.before46, "v46's catalog");
  assert.equal((await one(r, `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = 'source_metric_audit_revision_guard'`)).prosrc, W.v39Body);
  assert.equal((await one(r, `select count(*)::int as n from training_load.unit_conversions`)).n, before);
  // Atomicity: v47 with a failing statement at its end, through the runner.
  const failing = `${await fsp.readFile(V47_FILE, "utf8")}\nselect 1 / 0;\n`;
  await assert.rejects(migrate(rdb.url, UP_TO_V46, { extra: { name: V47, text: failing } }));
  assert.deepEqual(await catalog(r), W.before46, "a failing v47 leaves nothing");
  await migrate(rdb.url, [...UP_TO_V46, V47]);
  assert.deepEqual(await catalog(r), W.after47, "v47 again");
});

test("5. the JavaScript normal form (isNormalFormPair) and v47's source_metric_factor_pair_normal agree, pair by pair", async () => {
  for (const [s, d] of NORMAL_FORM_PAIRS) {
    const sql = (await one(k, `select training_load.source_metric_factor_pair_normal($1::numeric, $2::numeric) as n`, [s, d])).n;
    assert.equal(sql, service.isNormalFormPair(s, d), `(${s}, ${d})`);
  }
});

// ---------------------------------------------------------------------------
// The behaviour database (through v47).
// ---------------------------------------------------------------------------
test("6. the audience: 401 without a session and for an inactive user; the identical 404 before the body for a platform admin in a club workspace, a club admin, a coach and a user with no role, on both writes; a platform admin then meets 415, 400 for a non-object body, and the 404 for a malformed or an unknown id", async () => {
  for (const p of ["/conversions", `/conversions/${crypto.randomUUID()}/retire`]) {
    assert.equal((await post(p, null, {})).status, 401);
    const inactive = await user("inactive");
    const cookie = await cookieFor(inactive);
    await k.query(`update public.users set is_active = false where id = $1`, [inactive]);
    assert.equal((await post(p, cookie, {})).status, 401, "an inactive user has no session");
    for (const who of [W.paA, W.caA, W.coachA, W.plain]) {
      isNotFound(await post(p, who.cookie, "not json", { contentType: "text/plain" }), `${p} before 415`);
      isNotFound(await post(p, who.cookie, []), `${p} before 400`);
      isNotFound(await post(p, who.cookie, createBody()), p);
    }
    refused(await post(p, W.pa.cookie, "not json", { contentType: "text/plain" }), 415, "jsonRequired");
    refused(await post(p, W.pa.cookie, []), 400, "invalid_body");
  }
  isNotFound(await retire("not-a-uuid", W.pa.cookie), "a malformed id");
  isNotFound(await retire(crypto.randomUUID(), W.pa.cookie), "an unknown id");
  // The services ask the gate too.
  for (const who of [W.paA, W.caA]) {
    const ctx = { userId: who.id, basis: who === W.paA ? "platform_admin" : "club_admin", owner: { scope: "club", clubId: W.clubA } };
    await assert.rejects(conversions.createConversion({ ctx, body: createBody() }), (e) => e.status === 404);
    await assert.rejects(conversions.retireConversion({ ctx, conversionId: crypto.randomUUID(), body: {} }), (e) => e.status === 404);
  }
  assert.equal(await auditCount(), 0, "nothing written");
});

test("7. create: 201 with the conversion (exact decimal text, seeded false; no acting user); the row names the acting user as creator and the T8 row carries the evidence, the key and no reason", async () => {
  const body = createBody({ scale: "3.60", scaleDivisor: "1", offset: "-1.50" });
  const res = ok(await create(W.pa.cookie, body), 201);
  assert.deepEqual(Object.keys(res).sort(), ["conversion", "replayed"]);
  assert.equal(res.replayed, false);
  const c = res.conversion;
  assert.deepEqual(Object.keys(c).sort(), ["createdAt", "evidenceRef", "fromUnit", "id", "offset", "retiredAt", "scale", "scaleDivisor", "seeded", "state", "toUnit"]);
  assert.deepEqual([c.fromUnit, c.toUnit, c.scale, c.scaleDivisor, c.offset, c.evidenceRef, c.state, c.seeded, c.retiredAt],
    [body.fromUnit, body.toUnit, "3.6", "1", "-1.5", EVIDENCE, "active", false, null]);
  const row = await conversionRow(c.id);
  assert.deepEqual([row.created_by_user_id, row.seed_migration, row.scale_t, row.offset_t], [W.pa.id, null, "3.6", "-1.5"]);
  const audit = await auditOf(c.id);
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].action, audit[0].from_status, audit[0].to_status, audit[0].reason, audit[0].evidence_ref, audit[0].performed_by_user_id, audit[0].basis, audit[0].request_key],
    ["unit_conversion_create", null, "active", null, EVIDENCE, W.pa.id, "platform_admin", body.requestKey]);
  W.created = c;
  W.createdKey = body.requestKey;
});

test("8. create refuses every malformed body with its 400 before the write and writes nothing: JSON numbers, NaN, an exponent, a '+', a leading zero, 41 characters, a signed zero in any field, a non-positive factor, a pair outside the normal form, equal units, a unit that is not a token, a bad evidenceRef, an unknown or a missing key; no sentence repeats the value sent", async () => {
  const before = await conversionCount();
  // Each body carries the key of test 7's create: a check made only inside the
  // write would meet that request record first (request_key_reused), so each
  // 400 below shows its check runs before the write.
  const cases = [
    [{ scale: 3.6 }, "invalid_body"], [{ scaleDivisor: 1 }, "invalid_body"], [{ offset: 0 }, "invalid_body"],
    [{ scale: "NaN" }, "invalid_body"], [{ scale: "1e3" }, "invalid_body"], [{ scale: "+2" }, "invalid_body"], [{ scale: "02" }, "invalid_body"],
    [{ scale: `1.${"0".repeat(38)}1` }, "invalid_body"], [{ offset: "Infinity" }, "invalid_body"], [{ scale: "2." }, "invalid_body"], [{ scale: ".5" }, "invalid_body"],
    [{ scale: "-0" }, "invalid_body"], [{ scaleDivisor: "-0.00" }, "invalid_body"], [{ offset: "-0" }, "invalid_body"], [{ offset: "-0.000" }, "invalid_body"],
    [{ scale: "0" }, "invalid_body"], [{ scale: "-2" }, "invalid_body"], [{ scaleDivisor: "0" }, "invalid_body"], [{ scaleDivisor: "-1" }, "invalid_body"],
    [{ scale: "36", scaleDivisor: "10" }, "conversion_not_normal_form"], [{ scale: "2", scaleDivisor: "120" }, "conversion_not_normal_form"],
    [{ scale: "1", scaleDivisor: "4" }, "conversion_not_normal_form"], [{ scale: "1", scaleDivisor: "0.25" }, "conversion_not_normal_form"],
    [{ fromUnit: "same", toUnit: "same" }, "invalid_body"], [{ fromUnit: "a b" }, "invalid_unit"], [{ toUnit: "x|y" }, "invalid_unit"], [{ fromUnit: "" }, "invalid_unit"],
    [{ toUnit: "u".repeat(31) }, "invalid_unit"], [{ fromUnit: 7 }, "invalid_unit"],
    [{ evidenceRef: "not-a-ref" }, "invalid_evidence_ref"], [{ evidenceRef: "docs/ai/x.md" }, "invalid_evidence_ref"],
    [{ extra: "x" }, "invalid_body"], [{ requestKey: "not-a-uuid" }, "invalid_body"],
  ];
  for (const [over, code] of cases) {
    const body = createBody({ requestKey: W.createdKey, ...over });
    const res = await create(W.pa.cookie, body);
    refused(res, 400, code);
    for (const v of Object.values(over)) if (typeof v === "string" && v.length > 2) assert.ok(!res.body.message.includes(v), `the sentence does not repeat ${JSON.stringify(v)}`);
  }
  const missing = createBody({ requestKey: W.createdKey });
  delete missing.offset;
  refused(await create(W.pa.cookie, missing), 400, "invalid_body");
  // 40 characters are taken.
  ok(await create(W.pa.cookie, createBody({ scale: `1.${"0".repeat(37)}1` })), 201);
  assert.equal(await conversionCount(), before + 1);
});

test("9. create: conversion_exists with the active row as current from the locked pre-read, and without current from the unique index when the pre-read is skipped (a concurrent create); nothing written either way", async () => {
  const before = await conversionCount();
  const exists = refused(await create(W.pa.cookie, createBody({ fromUnit: W.created.fromUnit, toUnit: W.created.toUnit })), 409, "conversion_exists");
  assert.deepEqual(exists.current, { ...W.created });
  conversions.setConversionSeamsForTests({ skipPreRead: true });
  const raced = refused(await create(W.pa.cookie, createBody({ fromUnit: W.created.fromUnit, toUnit: W.created.toUnit })), 409, "conversion_exists");
  assert.equal(raced.current, undefined, "no current on the index's 23505");
  conversions.setConversionSeamsForTests();
  assert.equal(await conversionCount(), before);
  // The reverse pair is a row of its own (Q2).
  ok(await create(W.pa.cookie, createBody({ fromUnit: W.created.toUnit, toUnit: W.created.fromUnit, scale: "1", scaleDivisor: "3.6" })), 201);
});

test("10. retire: 200 with the row retired (the retirer the acting user, at the transaction's time); its T8 row carries the reason, active -> retired and no evidence; a second retirement is conversion_not_active with current; the reason is never answered; a seed row is retired like any other (seeded true, no file name); a bad expectedState or reason is 400", async () => {
  const c = ok(await create(W.pa.cookie), 201).conversion;
  const reason = `Wrong factor ${uid()}.`;
  const requestKey = key();
  const res = ok(await retire(c.id, W.pa.cookie, { reason, requestKey }));
  assert.equal(res.replayed, false);
  assert.deepEqual([res.conversion.id, res.conversion.state], [c.id, "retired"]);
  assert.ok(res.conversion.retiredAt);
  const row = await conversionRow(c.id);
  assert.deepEqual([row.state, row.retired_by_user_id, row.retired_reason], ["retired", W.pa.id, reason]);
  const audit = (await auditOf(c.id)).find((a) => a.action === "unit_conversion_retire");
  assert.deepEqual([audit.from_status, audit.to_status, audit.reason, audit.evidence_ref, audit.performed_by_user_id, audit.request_key],
    ["active", "retired", reason, null, W.pa.id, requestKey]);
  assert.equal(new Date(audit.performed_at).getTime(), new Date(row.retired_at).getTime(), "one transaction time");
  const again = refused(await retire(c.id, W.pa.cookie), 409, "conversion_not_active");
  assert.deepEqual([again.current.id, again.current.state], [c.id, "retired"]);
  for (const text of [JSON.stringify(res), JSON.stringify(again)]) assert.ok(!text.includes(reason), "the reason is never answered");
  for (const [body, label] of [[{ expectedState: "retired" }, "expectedState"], [{ expectedState: undefined }, "missing expectedState"], [{ reason: " padded" }, "a blank edge"],
    [{ reason: "two\nlines" }, "a line break"], [{ reason: "x".repeat(501) }, "501 characters"], [{ reason: "" }, "empty"]]) {
    const other = ok(await create(W.pa.cookie), 201).conversion;
    refused(await post(`/conversions/${other.id}/retire`, W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "Fine.", ...body }), 400, "invalid_body");
    assert.equal((await conversionRow(other.id)).state, "active", label);
  }
  // A seed row (v34): retired like any other, and created again by the API.
  const seed = await one(k, `select id from training_load.unit_conversions where from_unit = 'm' and to_unit = 'km' and state = 'active'`);
  const retiredSeed = ok(await retire(seed.id, W.pa.cookie));
  assert.deepEqual([retiredSeed.conversion.seeded, retiredSeed.conversion.state], [true, "retired"]);
  assert.ok(!JSON.stringify(retiredSeed).includes("migrations_v2"), "no seed marker's file name");
  ok(await create(W.pa.cookie, createBody({ fromUnit: "m", toUnit: "km", scale: "0.001", evidenceRef: "docs/ai/gpexe-metric-variable-mapping-discovery.md#d5-unit-conversion-seed" })), 201);
});

test("11. replay and keys: the same key and body replays the same conversion (create and retire, 200 replayed); another body (an offset, an evidenceRef) or another operation on the key is request_key_reused; '3.60' and '3.6' are one request", async () => {
  const body = createBody({ scale: "3.6" });
  const first = ok(await create(W.pa.cookie, body), 201);
  const replay = ok(await create(W.pa.cookie, { ...body, scale: "3.60" }));
  assert.deepEqual([replay.replayed, replay.conversion.id], [true, first.conversion.id]);
  refused(await create(W.pa.cookie, { ...body, offset: "1" }), 409, "request_key_reused");
  refused(await create(W.pa.cookie, { ...body, evidenceRef: "docs/ai/test-evidence.md#another-conversion" }), 409, "request_key_reused");
  refused(await retire(first.conversion.id, W.pa.cookie, { requestKey: body.requestKey }), 409, "request_key_reused");
  const reason = "Replay reason.";
  const rk = key();
  ok(await retire(first.conversion.id, W.pa.cookie, { reason, requestKey: rk }));
  const retireReplay = ok(await retire(first.conversion.id, W.pa.cookie, { reason, requestKey: rk }));
  assert.deepEqual([retireReplay.replayed, retireReplay.conversion.state], [true, "retired"]);
  refused(await retire(first.conversion.id, W.pa.cookie, { reason: "Another reason.", requestKey: rk }), 409, "request_key_reused");
  assert.equal((await auditOf(first.conversion.id)).length, 2, "one create row and one retire row");
});

test("12. the COMMIT through the real route: an answer lost but verified is 200 verified_after_commit_error (never 201); one lost and not found is 503 outcome_unknown with the key, and the same key then writes once; a COMMIT refused by v47's deferred link (no audit row) writes nothing and leaves the key free", async () => {
  service.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw new Error("answer lost"); }), timeoutMs: 2_000 });
  const lost = await create(W.pa.cookie);
  service.setMappingCommitForTests();
  assert.deepEqual([lost.status, lost.body.commitConfirmation, lost.body.replayed], [200, "verified_after_commit_error", false]);
  assert.equal((await conversionRow(lost.body.conversion.id)).state, "active");
  const body = createBody();
  service.setMappingCommitForTests({ fault: () => Promise.reject(new Error("socket gone")), timeoutMs: 2_000 });
  const unknown = await create(W.pa.cookie, body);
  service.setMappingCommitForTests();
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.requestKey], [503, "outcome_unknown", body.requestKey]);
  ok(await create(W.pa.cookie, body), 201);
  ok(await create(W.pa.cookie, body));
  assert.equal((await one(k, `select count(*)::int as n from training_load.unit_conversions where from_unit = $1`, [body.fromUnit])).n, 1, "written once");
  // The deferred link refuses a create without its audit row at COMMIT.
  const before = await conversionCount();
  const noAudit = createBody();
  conversions.setConversionSeamsForTests({ skipAudit: true });
  const refusedCommit = await create(W.pa.cookie, noAudit);
  conversions.setConversionSeamsForTests();
  refused(refusedCommit, 500, "internal_error");
  assert.equal(await conversionCount(), before, "nothing written");
  ok(await create(W.pa.cookie, noAudit), 201);
  // And a retirement without its audit row.
  const c = ok(await create(W.pa.cookie), 201).conversion;
  conversions.setConversionSeamsForTests({ skipAudit: true });
  refused(await retire(c.id, W.pa.cookie), 500, "internal_error");
  conversions.setConversionSeamsForTests();
  assert.equal((await conversionRow(c.id)).state, "active", "nothing written");
});

test("13. rights: lost during the write - the identical 404, nothing written, the key free; lost before a replay - the 404; lost after the create's locked pre-read found a row - the 404, never current", async () => {
  const pa = await platformAdmin();
  const body = createBody();
  service.setMappingRightsHoldForTests(async () => { await revokePlatform(pa.id); });
  isNotFound(await create(pa.cookie, body), "lost during the create");
  service.setMappingRightsHoldForTests(null);
  await restorePlatform(pa.id);
  assert.equal((await one(k, `select count(*)::int as n from training_load.unit_conversions where from_unit = $1`, [body.fromUnit])).n, 0);
  const created = ok(await create(pa.cookie, body), 201);
  await revokePlatform(pa.id);
  isNotFound(await create(pa.cookie, body), "lost before the replay");
  await restorePlatform(pa.id);
  service.setMappingRightsHoldForTests(async () => { await revokePlatform(pa.id); });
  const exists = await create(pa.cookie, createBody({ fromUnit: body.fromUnit, toUnit: body.toUnit }));
  service.setMappingRightsHoldForTests(null);
  await restorePlatform(pa.id);
  isNotFound(exists, "lost after the pre-read");
  service.setMappingRightsHoldForTests(async () => { await revokePlatform(pa.id); });
  isNotFound(await retire(created.conversion.id, pa.cookie), "lost during the retirement");
  service.setMappingRightsHoldForTests(null);
  await restorePlatform(pa.id);
  assert.equal((await conversionRow(created.conversion.id)).state, "active");
});

test("14. direct SQL against v47: without the actor, with another user, with a club admin, a retirement at another time, without the audit row at COMMIT, a second or a mismatched audit row, a write inside a savepoint, a non-token unit and (1, 4) - each refused; v34's immutability and DELETE refusal hold", async () => {
  const pa = W.pa.id;
  const pa2 = W.pa2.id;
  // Without the actor setting.
  refusedWith(await tx(null, (c) => insertRow(c, { by: pa })), "42501");
  // Another user named.
  refusedWith(await tx(pa2, (c) => insertRow(c, { by: pa })), "42501", V47_ACTOR);
  // A club admin, as actor and creator: v34's guard refuses first (its creator
  // must be an active platform admin), so v47's basis check of an INSERT is a
  // second line no write reaches while v34's holds.
  refusedWith(await tx(W.caA.id, (c) => insertRow(c, { by: W.caA.id })), "42501", /^source metric mapping: the acting user is not an active platform admin$/);
  // A seed marker outside its seeding migration (v34's seed window).
  refusedWith(await tx(pa, (c) => insertRow(c, { seed: "migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql" })), "42501");
  // The create without its audit row: refused at COMMIT.
  refusedWith(await tx(pa, (c) => insertRow(c, { by: pa })), "23514", V47_CREATE_LINK);
  // A good create.
  const id = okTx(await tx(pa, async (c) => {
    const x = await insertRow(c, { by: pa });
    await auditRow(c, { action: "unit_conversion_create", id: x, by: pa, to: "active", evidence: EVIDENCE });
    return x;
  }));
  // A second create row, a stray reason, another evidence, a row of another transaction.
  refusedWith(await tx(pa, (c) => auditRow(c, { action: "unit_conversion_create", id, by: pa, to: "active", evidence: EVIDENCE })), "23514", V47_AUDIT_FOLLOWS);
  refusedWith(await tx(pa, async (c) => {
    const x = await insertRow(c, { by: pa });
    await auditRow(c, { action: "unit_conversion_create", id: x, by: pa, to: "active", evidence: EVIDENCE, reason: "stray" });
  }), "23514", V47_AUDIT_FOLLOWS);
  refusedWith(await tx(pa, async (c) => {
    const x = await insertRow(c, { by: pa });
    await auditRow(c, { action: "unit_conversion_create", id: x, by: pa, to: "active", evidence: "docs/ai/other.md#x" });
  }), "23514", V47_AUDIT_FOLLOWS);
  refusedWith(await tx(pa, async (c) => {
    const x = await insertRow(c, { by: pa });
    await auditRow(c, { action: "unit_conversion_create", id: x, by: pa, to: "active", evidence: EVIDENCE });
    await auditRow(c, { action: "unit_conversion_create", id: x, by: pa, to: "active", evidence: EVIDENCE });
  }), "23514", V47_AUDIT_ONCE);
  // The audit row by another user than the actor (v35 first) and with a club basis.
  refusedWith(await tx(pa, async (c) => {
    const x = await insertRow(c, { by: pa });
    await auditRow(c, { action: "unit_conversion_create", id: x, by: pa2, to: "active", evidence: EVIDENCE });
  }), "42501");
  // A write inside a savepoint: its xmin is the subtransaction's.
  refusedWith(await tx(pa, async (c) => {
    await c.query("savepoint s");
    const x = await insertRow(c, { by: pa });
    await c.query("release savepoint s");
    await auditRow(c, { action: "unit_conversion_create", id: x, by: pa, to: "active", evidence: EVIDENCE });
  }), "23514", V47_AUDIT_FOLLOWS);
  // Retirements: another user, another time, without the audit row, a stray evidence.
  refusedWith(await tx(pa, (c) => retireRow(c, id, pa2)), "42501", V47_ACTOR);
  // A club admin retiring as the acting user (v34 checks no retirer: v47's basis does).
  refusedWith(await tx(W.caA.id, (c) => retireRow(c, id, W.caA.id)), "42501", V47_ACTOR);
  refusedWith(await tx(pa, (c) => retireRow(c, id, pa, { at: "now() - interval '1 second'" })), "23514", V47_TIME);
  refusedWith(await tx(pa, (c) => retireRow(c, id, pa, { at: "clock_timestamp()" })), "23514", V47_TIME);
  refusedWith(await tx(pa, (c) => retireRow(c, id, pa)), "23514", V47_RETIRE_LINK);
  refusedWith(await tx(pa, async (c) => {
    await retireRow(c, id, pa);
    await auditRow(c, { action: "unit_conversion_retire", id, by: pa, from: "active", to: "retired", reason: "Direct SQL retirement", evidence: EVIDENCE });
  }), "23514", V47_AUDIT_FOLLOWS);
  refusedWith(await tx(pa, async (c) => {
    await retireRow(c, id, pa);
    await auditRow(c, { action: "unit_conversion_retire", id, by: pa, from: "active", to: "retired", reason: "Another reason" });
  }), "23514", V47_AUDIT_FOLLOWS);
  okTx(await tx(pa, async (c) => {
    await retireRow(c, id, pa);
    await auditRow(c, { action: "unit_conversion_retire", id, by: pa, from: "active", to: "retired", reason: "Direct SQL retirement" });
  }));
  // The once-index, under the guard: a second create row with every trigger off.
  await k.query("begin");
  try {
    await k.query("set local session_replication_role = replica");
    await assert.rejects(auditRow(k, { action: "unit_conversion_create", id, by: pa, to: "active", evidence: EVIDENCE }),
      (e) => e.code === "23505" && e.constraint === "source_metric_audit_v47_conversion_once");
  } finally {
    await k.query("rollback");
  }
  // The two CHECKs.
  const tokens = refusedWith(await tx(pa, (c) => insertRow(c, { from: "a b", by: pa })), "23514");
  assert.equal(tokens.constraint, "unit_conversions_units_are_tokens");
  const normal = refusedWith(await tx(pa, (c) => insertRow(c, { scale: "1", divisor: "4", by: pa })), "23514");
  assert.equal(normal.constraint, "unit_conversions_factors_normal_form");
  // v34: immutable, never deleted.
  refusedWith(await tx(pa, (c) => c.query(`update training_load.unit_conversions set scale = 3 where id = $1`, [W.created.id])), "23514", /immutable/);
  refusedWith(await tx(pa, (c) => c.query(`delete from training_load.unit_conversions where id = $1`, [W.created.id])), "23514", /never deleted/);
});

test("15. concurrency: a retirement waits for an activation's FOR SHARE and the activated version keeps its factors; an activation waits for a retirement and then finds no active row; two creates of one pair - one 201, one conversion_exists; a create waits for a retirement in flight - 201 when it commits, conversion_exists with current when it rolls back; no 40P01", async () => {
  const minVar = await variable(W.pa, { unit: "tmin" });
  const sMin = ok(await create(W.pa.cookie, createBody({ fromUnit: "ts", toUnit: "tmin", scale: "1", scaleDivisor: "60" })), 201).conversion;
  // The retirement waits for the activation.
  const v = await version(await field("ts"), minVar);
  const held = holdM2("mapping_version_activate");
  const act = activate(v);
  await until(() => held.state.entered, "the activation holds the conversion FOR SHARE");
  const retiring = retire(sMin.id, W.pa2.cookie);
  assert.equal(await someoneWaits(), true, "the retirement waits");
  held.g.open();
  ok(await act);
  ok(await retiring);
  const active = await one(k, `select status, trim_scale(scale)::text as scale, trim_scale(scale_divisor)::text as divisor from training_load.source_metric_mapping_versions where id = $1`, [v.versionId]);
  assert.deepEqual(active, { status: "active", scale: "1", divisor: "60" }, "the active version keeps its own factors");
  // The activation waits for the retirement, then finds no active row.
  const sMin2 = ok(await create(W.pa.cookie, createBody({ fromUnit: "ts", toUnit: "tmin", scale: "1", scaleDivisor: "60" })), 201).conversion;
  const minVar2 = await variable(W.pa, { unit: "tmin" });
  const v2 = await version(await field("ts"), minVar2);
  const heldRetire = holdConversion("unit_conversion_retire");
  const retiring2 = retire(sMin2.id, W.pa2.cookie);
  await until(() => heldRetire.state.entered, "the retirement holds the row");
  const act2 = activate(v2);
  assert.equal(await someoneWaits(), true, "the activation waits");
  heldRetire.g.open();
  ok(await retiring2);
  refused(await act2, 409, "conversion_unavailable");
  assert.equal((await one(k, `select status from training_load.source_metric_mapping_versions where id = $1`, [v2.versionId])).status, "needs_review", "the version was not activated");
  // Two creates of one pair.
  const p = pair();
  const heldCreate = holdConversion("unit_conversion_create");
  const first = create(W.pa.cookie, createBody(p));
  await until(() => heldCreate.state.entered, "the first create is held before its insert");
  const second = await create(W.pa2.cookie, createBody(p));
  heldCreate.g.open();
  const results = [await first, second].map((x) => [x.status, x.body.error ?? null]).sort();
  assert.deepEqual(results, [[201, null], [409, "conversion_exists"]]);
  // A create waits for a retirement in flight: committed - 201.
  for (const [fail, expected] of [[false, 201], [true, 409]]) {
    const q2 = pair();
    const old = ok(await create(W.pa.cookie, createBody(q2)), 201).conversion;
    const h = holdConversion("unit_conversion_retire", { fail });
    const ret = retire(old.id, W.pa2.cookie);
    await until(() => h.state.entered, "the retirement holds the row");
    const making = create(W.pa.cookie, createBody({ ...q2, scale: "3" }));
    assert.equal(await someoneWaits(), true, "the create's pre-read waits");
    h.g.open();
    const retRes = await ret;
    const res = await making;
    assert.equal(res.status, expected, res.text);
    if (fail) {
      refused(retRes, 500, "internal_error");
      assert.equal(res.body.error, "conversion_exists");
      assert.equal(res.body.current.id, old.id, "the row the retirement left active");
    } else {
      ok(retRes);
    }
  }
  assert.ok(!logLines.some((l) => l.includes("40P01")), "no deadlock");
});

test("16. consequences of a retirement: a draft of the pair is conversion_unavailable; a submitted version made with the retired factors activates again once an identical conversion is created, and never after a correction with other factors", async () => {
  const target = await variable(W.pa, { unit: "tq2" });
  const conv = ok(await create(W.pa.cookie, createBody({ fromUnit: "tq1", toUnit: "tq2", scale: "2" })), 201).conversion;
  const f = await field("tq1");
  const v = await version(f, target);
  ok(await retire(conv.id, W.pa.cookie));
  refused(await draftOf(f, target, v.mappingId), 409, "conversion_unavailable");
  refused(await activate(v), 409, "conversion_unavailable");
  const identical = ok(await create(W.pa.cookie, createBody({ fromUnit: "tq1", toUnit: "tq2", scale: "2.0" })), 201).conversion;
  ok(await activate(v));
  // A correction with other factors: an old submitted version cannot activate.
  const target2 = await variable(W.pa, { unit: "tq2" });
  const v2 = await version(await field("tq1"), target2);
  ok(await retire(identical.id, W.pa.cookie));
  ok(await create(W.pa.cookie, createBody({ fromUnit: "tq1", toUnit: "tq2", scale: "3" })), 201);
  refused(await activate(v2), 409, "conversion_unavailable");
});

test("17. GET /conversions answers in pages of 100 with an opaque, stable cursor: the active rows in byte order of the units, then the id; seeded on every row; a bad cursor or an unknown parameter is 400 invalid_query; every M2 reader reads it", async () => {
  for (let i = 0; i < 101; i += 1) await createConversion(k, { from: `zp${String(i).padStart(3, "0")}`, to: "zq", scale: "2", evidenceRef: EVIDENCE, by: W.pa.id });
  const all = (await rows(k, `select id, seed_migration is not null as seeded from training_load.unit_conversions where state = 'active' order by from_unit collate "C", to_unit collate "C", id`));
  const seen = [];
  const sizes = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = ok(await api(`/conversions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { cookie: W.caA.cookie }));
    sizes.push(res.conversions.length);
    for (const c of res.conversions) assert.deepEqual(Object.keys(c).sort(), ["evidenceRef", "fromUnit", "id", "offset", "scale", "scaleDivisor", "seeded", "toUnit"]);
    seen.push(...res.conversions.map((c) => c.id));
    if (res.nextCursor) {
      assert.match(res.nextCursor, /^[A-Za-z0-9_-]+$/, "opaque base64url");
      const again = ok(await api(`/conversions?cursor=${encodeURIComponent(res.nextCursor)}`, { cookie: W.pa.cookie }));
      assert.ok(again.conversions.length > 0, "the cursor is usable by another reader");
    }
    cursor = res.nextCursor;
    pages += 1;
  } while (cursor);
  assert.deepEqual(seen, all.map((x) => x.id), "every active row once, in order");
  // Exactly full pages of 100 and one last page with the rest (section 8, item 11).
  assert.ok(all.length > 100);
  assert.equal(pages, Math.ceil(all.length / 100));
  assert.deepEqual(sizes, [...Array(pages - 1).fill(100), all.length - 100 * (pages - 1)]);
  const first = ok(await api("/conversions", { cookie: W.pa.cookie }));
  assert.equal(first.conversions.length, 100);
  assert.deepEqual(first.conversions.filter((c) => c.seeded).length > 0, true, "the seed rows say seeded");
  for (const bad of ["?cursor=nope!", `?cursor=${Buffer.from(JSON.stringify({ v: 1, k: "conversions", i: crypto.randomUUID() })).toString("base64url")}`,
    `?cursor=${Buffer.from(JSON.stringify({ v: 1, k: "mappings", i: crypto.randomUUID() })).toString("base64url")}`, "?limit=5"]) {
    refused(await api(`/conversions${bad}`, { cookie: W.pa.cookie }), 400, "invalid_query");
  }
  for (const who of [W.paA, W.caA]) ok(await api("/conversions", { cookie: who.cookie }));
  isNotFound(await api("/conversions", { cookie: W.coachA.cookie }), "a coach");
});

test("18. no answer and no log line carries a retirement reason, an acting user's id, a seed marker's file name or a database text", async () => {
  const userIds = [W.pa.id, W.pa2.id, W.paA.id, W.caA.id];
  for (const text of responses) {
    for (const reason of sentReasons) assert.ok(!text.includes(reason), "no reason in an answer");
    for (const id of userIds) assert.ok(!text.includes(id), "no acting user's id");
    assert.ok(!/migrations_v2\/|violates|unit_conversions:|source_metric_audit:|syntax error/i.test(text), `no database text: ${text.slice(0, 160)}`);
  }
  for (const line of logLines) for (const reason of sentReasons) assert.ok(!line.includes(reason), "no reason in a log line");
});

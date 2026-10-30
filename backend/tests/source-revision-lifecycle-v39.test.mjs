// Phase 4 - the source-field revision lifecycle (backend/src/sourceRevisionLifecycleService.js,
// routes L1-L5 under /api/training-load/sources/metrics/fields) with migration v39, its database
// guards, and migration v40, Q10 part B (the database twins of the text rules). Through the real
// HTTP stack, on disposable optimove_tests_gpexe_* databases only (never OPTIMOVE, never a real
// GPEXE field): one migrated through v38 that rehearses v39 and v40 (apply / rollback / re-apply,
// the fail-closed block, the preflight and post-check scripts), one migrated through v40 for the
// behaviour. Every revision changed here belongs to a test field of this file; the nine seeded
// rest_v1 fields are never touched.
// Contract: docs/ai/v39-revision-lifecycle-contract.md (J5), decision C100.
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
import { boundedText, unitTokenOk } from "../src/metricTextRules.js";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { verifyRevisionRow, writeRevision } from "./support/source-revisions.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V39 = "202610271100_training_load_v39_source_metric_revision_lifecycle.sql";
const V40 = "202610271200_training_load_v40_source_metric_text_rules.sql";
const V39_NAME = `migrations_v2/${V39}`;
const V40_NAME = `migrations_v2/${V40}`;
const UP_TO_V38 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V39));
const RUNBOOKS = path.resolve(ROOT, "docs/runbooks");
const V39_ROLLBACK = path.join(RUNBOOKS, "source-metric-revision-lifecycle-v39-rollback.sql");
const V39_PREFLIGHT = path.join(RUNBOOKS, "source-metric-revision-lifecycle-v39-preflight.sql");
const V39_POSTCHECK = path.join(RUNBOOKS, "source-metric-revision-lifecycle-v39-postcheck.sql");
const V40_ROLLBACK = path.join(RUNBOOKS, "source-metric-text-rules-v40-rollback.sql");
const V40_PREFLIGHT = path.join(RUNBOOKS, "source-metric-text-rules-v40-preflight.sql");
const V40_POSTCHECK = path.join(RUNBOOKS, "source-metric-text-rules-v40-postcheck.sql");
const V37_ROLLBACK = path.join(RUNBOOKS, "source-metric-revision-guards-v37-rollback.sql");
const V38_ROLLBACK = path.join(RUNBOOKS, "metric-variable-changes-v38-rollback.sql");
const V34_FILE = path.resolve(ROOT, "migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql");
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const PINNED_REASON = "Source revision retired.";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const ch = (cp) => String.fromCodePoint(cp);
const NO_ACTOR = /no acting user is set for this transaction/;
const MAY_NOT_CHANGE = /^source metric revision: the acting user may not change a source revision$/;
const REVISION_OTHER_USER = /^source metric revision: the row names another user than the acting user$/;
const SEED_WITH_ACTOR = /^source metric revision: a seed marker is written only by a seeding migration, without an acting user$/;
const SEED_WINDOW = /^source metric mapping: a seed marker is accepted only from the seeding migration$/;
const ONLY_STATE = /^source_metric_definition_versions: a state change writes only the state and its own facts$/;
const NO_CREATE_ROW = /^source_metric_definition_versions: a revision is written with its source_metric_revision_create audit row$/;
const NO_STATE_ROW = /^source_metric_definition_versions: a state change is written with its source_metric_revision_activate or _retire audit row$/;
const FOLLOW = /^source_metric_audit: the audit row must follow its own revision change in the same transaction$/;
const ONCE = /^source_metric_audit: the revision change already has its audit row$/;
const AUDIT_MAY_NOT = /^source metric revision: the acting user may not write this audit row$/;

let rdb, db, r, k, server, apiBase, service, fieldsService, lifecycle, dbModule, appPool, createSession;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};

async function migrate(url, files) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v39-migrations-"));
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
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V39) && GPEXE_TEST_MIGRATIONS.includes(V40), "v39 and v40 are test migrations");
  assert.equal(GPEXE_TEST_MIGRATIONS.indexOf(V40), GPEXE_TEST_MIGRATIONS.indexOf(V39) + 1, "v40 right after v39");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v39rb", migrations: UP_TO_V38 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v39" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  await r.connect();
  await k.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  assert.ok((await k.query(`select 1 from public.schema_migrations where migration_name = $1`, [V40_NAME])).rowCount === 1, "the behaviour database carries v40");
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.V39_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  fieldsService = await import("../src/sourceFieldVerificationService.js");
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
  service?.setMappingRereadFaultForTests(null);
  service?.setMappingWriteHoldForTests(null);
  fieldsService?.setFieldWriteHoldForTests(null);
  lifecycle?.setRevisionWriteHoldForTests(null);
  lifecycle?.setRevisionSkipAuditRowForTests(null);
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
const post = (p, cookie, body) => api(p, { method: "POST", cookie, body });
const createPath = (f) => `/fields/${f.fieldId}/revisions`;
const retirePath = (f, revId) => `/fields/${f.fieldId}/revisions/${revId}/retire`;
const activatePath = (f, revId) => `/fields/${f.fieldId}/revisions/${revId}/activate`;
const replacePath = (f, revId) => `/fields/${f.fieldId}/revisions/${revId}/replace`;
const createBody = (over = {}) => ({ requestKey: key(), valueShape: "number", parameterKind: "none", supportsSession: true, supportsDrill: true, ...over });

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
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const team = async (clubId) => (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;

// A canonical variable of Metrics Core (as the M2 suite writes it), numeric, unit s.
async function canonical({ scope = "system", clubId = null, unit = "s" } = {}) {
  const id = (await one(k, `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id, state) values ($1,'v39 test variable',$2,$3,'active') returning id`, [`v39_${uid()}`, scope, clubId])).id;
  const versionId = (await one(k, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1,1,$2,'numeric') returning id`, [id, unit])).id;
  await k.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [versionId, id]);
  for (const s of ["session", "component"]) await k.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,$2)`, [id, s]);
  return { id, versionId };
}

// A test field of gpexe / rest_v1 with revision 1 (through the lifecycle's database path).
async function field({ state = "active", status = "observed", unit = null, meaning = false, kind = "none" } = {}) {
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Test field',$2) returning id`,
    [`v39.test.f${uid()}`, W.pa.id])).id;
  const shape = kind === "zone_bounds" ? "zone_distance" : kind === "event_threshold" ? "event_count" : "number";
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: shape, parameterKind: kind, evidenceStatus: status, evidenceRef: COMPAT, unit, unitRef: UNIT_REF, meaning, meaningRef: MEANING_REF, state });
  return { fieldId, revId };
}
// A further revision of the field (number n) through the lifecycle's database path.
const revisionOf = (f, n, over = {}) => writeRevision(k, { fieldId: f.fieldId, by: W.pa.id, revisionNumber: n, evidenceRef: COMPAT, unitRef: UNIT_REF, meaningRef: MEANING_REF, state: "draft", ...over });
const revisionRow = (id) => one(k, `select * from training_load.source_metric_definition_versions where id = $1`, [id]);
const versionRow = (id) => one(k, `select * from training_load.source_metric_mapping_versions where id = $1`, [id]);
const auditOf = (sql, params) => rows(k, `select * from training_load.source_metric_audit where ${sql} order by performed_at, id`, params);

// A submitted (needs_review) or draft mapping version pinned to `revId` of field `f`,
// through the real M2 routes: a system mapping by a platform admin, a club mapping by
// the club's admin in its workspace.
async function pinnedVersion(f, revId, { owner = W.pa, variable = W.sysVar, submit = true } = {}) {
  let mapping = (await one(k, `select id from training_load.source_metric_mappings where source_metric_definition_id = $1 and metric_definition_id = $2`, [f.fieldId, variable.id]))?.id;
  if (!mapping) {
    const m = await post("/mappings", owner.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: variable.id });
    assert.equal(m.status, 201, m.text);
    mapping = m.body.mapping.id;
  }
  const v = await post(`/mappings/${mapping}/versions`, owner.cookie, { requestKey: key(), sourceRevisionId: revId, appliesToSession: true, appliesToDrill: true });
  assert.equal(v.status, 201, v.text);
  if (submit) assert.equal((await post(`/mappings/${mapping}/versions/${v.body.version.id}/submit`, owner.cookie, { requestKey: key() })).status, 200);
  return { mappingId: mapping, versionId: v.body.version.id };
}

// One transaction on `client` with the acting user set the way the service sets it
// (no actor: none set). Committed when fn succeeds; a refusal is returned.
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
// The raw lifecycle writes, as the service writes them (for the database tests).
const insertDraft = (c, { fieldId, n, by }) => c.query(
  `insert into training_load.source_metric_definition_versions (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill, evidence_status, created_by_user_id)
   values ($1,$2,'number','none',true,true,'unproven',$3) returning id`, [fieldId, n, by]).then((x) => x.rows[0].id);
const activateRaw = (c, { revId, by }) => c.query(`update training_load.source_metric_definition_versions set state = 'active', activated_by_user_id = $2, activated_at = now() where id = $1`, [revId, by]);
const retireRaw = (c, { revId, by, reason = "Test retirement" }) => c.query(`update training_load.source_metric_definition_versions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = $3 where id = $1`, [revId, by, reason]);
const lifecycleRow = (c, { action, fieldId, revId, by, from = null, to = null, reason = null, ref = null, basis = "platform_admin" }) => c.query(
  `insert into training_load.source_metric_audit (action, source_metric_definition_id, source_metric_version_id, from_status, to_status, reason, evidence_ref, performed_by_user_id, basis, operation_id)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [action, fieldId, revId, from, to, reason, ref, by, basis, crypto.randomUUID()]);

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
const added = (list, base, keyOf) => list.filter((x) => !base.some((y) => keyOf(y) === keyOf(x)));
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
// The numbered read-only blocks of a preflight or post-check script, each run on
// its own, with all its rows.
async function blocks(c, file) {
  const text = await fsp.readFile(file, "utf8");
  const out = {};
  for (const part of text.split(/^(?=-- \d+\. )/m).slice(1)) out[Number(part.match(/^-- (\d+)\./)[1])] = (await c.query(part)).rows;
  return out;
}
const textFunctions = (c) => rows(c, `select p.proname, p.oid::text as oid, md5(p.prosrc) as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                      where n.nspname = 'training_load' and p.proname in ('source_metric_text_ok', 'source_metric_unit_token_ok') order by 1`);
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
// Holds a lifecycle write after its locks and checks until the returned gate opens.
function holdLifecycle() {
  const g = gate();
  const state = { entered: false };
  lifecycle.setRevisionWriteHoldForTests(async () => { state.entered = true; await g.promise; });
  return { g, state };
}

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.teamA = await team(W.clubA);
  W.pa = await platformAdmin();
  W.pa2 = await platformAdmin();
  W.paA = await platformAdmin(["club", W.clubA]);
  W.caA = await clubAdmin(W.clubA);
  W.caB = await clubAdmin(W.clubB);
  W.paRevoked = await platformAdmin();
  await k.query(`update public.user_global_roles set is_active = false where user_id = $1`, [W.paRevoked.id]);
  const coachId = await user("coach");
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coachId, W.teamA]);
  await workspace(coachId, "team", W.teamA);
  W.coach = { id: coachId, cookie: await cookieFor(coachId) };
  const plainId = await user("no-role");
  W.plain = { id: plainId, cookie: await cookieFor(plainId) };
  W.sysVar = await canonical();
  W.clubAVar = await canonical({ scope: "club", clubId: W.clubA });
  W.clubBVar = await canonical({ scope: "club", clubId: W.clubB });
  W.seedBefore = await rows(k, `select * from training_load.source_metric_definition_versions where seed_migration like 'migrations_v2/202610121000%' order by id`);
}

// ---------------------------------------------------------------------------
// The rehearsal database (through v38): the preflights, v39, the fail-closed v40, the rollbacks.
// ---------------------------------------------------------------------------
test("1. the preflights on v38: every expected value of both read-only scripts (v39 and v40), the v40 refused-row counts all 0 with the inline rule copy", async () => {
  const pre39 = await blocks(r, V39_PREFLIGHT);
  assert.deepEqual(Object.keys(pre39).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(pre39[1][0].pg13_or_later, true);
  assert.deepEqual([pre39[2][0].v38_rows, pre39[2][0].v38_checksum_ok, pre39[2][0].v37_checksum_ok, pre39[2][0].v36_checksum_ok, pre39[2][0].v35_checksum_ok, pre39[2][0].v39_rows, pre39[2][0].at_or_after_v39, pre39[2][0].last_migration],
    ["1", true, true, true, true, "0", "0", "migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql"]);
  assert.deepEqual([pre39[3][0].v35_functions_needed, pre39[3][0].v37_functions, pre39[3][0].v37_triggers, pre39[3][0].revision_triggers_enabled, pre39[3][0].audit_triggers_enabled, pre39[3][0].disabled_triggers],
    ["3", "2", "3", "4", "5", "0"]);
  assert.deepEqual([pre39[4][0].v39_functions, pre39[4][0].v39_triggers, pre39[4][0].v39_indexes], ["0", "0", 0]);
  assert.deepEqual([pre39[5][0].schema_create, pre39[5][0].owns_revisions, pre39[5][0].owns_audit, pre39[5][0].owns_v37_functions], [true, true, true, true]);
  assert.deepEqual([pre39[6][0].fields, pre39[6][0].revisions, pre39[6][0].seeded_unproven, pre39[6][0].lifecycle_revisions, pre39[6][0].verification_rows, pre39[6][0].lifecycle_rows],
    ["9", "9", "9", "0", "0", "0"]);
  assert.deepEqual([pre39[7][0].versions_active, pre39[7][0].activations_open], ["0", "0"]);
  assert.equal(pre39[8][0].actor_defaults, "0");
  assert.deepEqual([pre39[9][0].conflicting_locks, pre39[9][0].idle_in_transaction], ["0", "0"]);
  const pre40 = await blocks(r, V40_PREFLIGHT);
  assert.deepEqual(Object.keys(pre40).map(Number), [1, 2, 3, 4, 5]);
  assert.deepEqual([pre40[1][0].pg13_or_later, pre40[1][0].utf8], [true, true]);
  assert.deepEqual([pre40[2][0].v39_rows, pre40[2][0].v40_rows, pre40[2][0].at_or_after_v39, pre40[2][0].last_migration],
    ["0", "0", "0", "migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql"]);
  assert.deepEqual([pre40[3][0].text_ok_is_v34, pre40[3][0].unit_token_is_v34, pre40[3][0].owns_functions], [true, true, true]);
  assert.equal(pre40[4].length, 21, "every column of the fail-closed block");
  assert.ok(pre40[4].every((x) => x.refused === "0"), JSON.stringify(pre40[4]));
  assert.deepEqual(Object.values(pre40[5][0]), ["0", "0", "0", "0", "0"]);
});

// One row per listed column whose text v34 accepts and v40 refuses: U+034F (the
// combining grapheme joiner) is in neither of v34's lists and in both of v40's.
const CGJ = ch(0x34f);
async function plantRefusedRows(c) {
  const ids = { by: crypto.randomUUID() };
  await c.query("begin");
  try {
    await c.query("set local session_replication_role = replica");
    const x = (s) => `x${CGJ}${s}`;
    ids.fieldId = (await one(c, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, state, retired_by_user_id, retired_at, retired_reason, created_by_user_id)
                                 values ('gpexe','rest_v1',$1,$2,'retired',$3,now(),$4,$3) returning id`, [`v40.bad.f${uid()}`, x("label"), ids.by, x("reason")])).id;
    ids.revId = (await one(c, `insert into training_load.source_metric_definition_versions (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill,
                                 expected_source_unit, unit_note, source_unit, expected_source_bound_unit, source_bound_unit, unit_verified_by_user_id, unit_verified_at, unit_evidence_ref,
                                 evidence_status, evidence_ref, state, retired_by_user_id, retired_at, retired_reason, created_by_user_id)
                               values ($1,1,'zone_distance','zone_bounds',true,true,$2,$3,$2,$2,$2,$4,now(),$5,'observed',$5,'retired',$4,now(),$3,$4) returning id`,
      [ids.fieldId, x("u"), x("note"), ids.by, COMPAT])).id;
    ids.convId = (await one(c, `insert into training_load.unit_conversions (from_unit, to_unit, scale, scale_divisor, "offset", state, retired_by_user_id, retired_at, retired_reason, evidence_ref, created_by_user_id)
                                values ($1,$2,1,1,0,'retired',$3,now(),$4,$5,$3) returning id`, [x("a"), x("b"), ids.by, x("reason"), COMPAT])).id;
    const params = (unit) => JSON.stringify({ operator: "between", lower: 1, upper: 2, unit });
    ids.versionId = (await one(c, `insert into training_load.source_metric_mapping_versions (mapping_id, source_metric_definition_id, metric_definition_id, owner_key, source_metric_version_id, version_number,
                                    metric_definition_version_id, conversion_kind, scale, scale_divisor, "offset", source_unit, target_unit, conversion_note, parameter_kind, source_parameters, canonical_parameters,
                                    parameter_fingerprint, parameter_scale, parameter_scale_divisor, parameter_offset, applies_to_session, applies_to_drill, status, disabled_by_user_id, disabled_at, disabled_basis,
                                    disable_reason, created_by_user_id)
                                  values ($1,$2,$1,'system',$3,1,$1,'numeric_linear',1,1,0,$4,$4,$5,'zone_bounds',$6::jsonb,$6::jsonb,$7,1,1,0,true,true,'disabled',$8,now(),'platform_admin',$5,$8) returning id`,
      [crypto.randomUUID(), ids.fieldId, ids.revId, x("u"), x("note"), params(x("u")), `v1:${"0".repeat(64)}`, ids.by])).id;
    await c.query(`insert into training_load.source_metric_mapping_activations (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, source_team_binding_id, team_id,
                     applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
                   values ($1,$2,$3,$2,$4,$2,$2,true,true,'required',$5,'platform_admin',$6)`, [ids.versionId, crypto.randomUUID(), ids.fieldId, `v1:${"0".repeat(64)}`, ids.by, x("reason")]);
    await c.query(`insert into training_load.metric_value_source_provenance (metric_value_id, activation_id, mapping_version_id, source_team_binding_id, mapping_id, source_metric_version_id, metric_source_connection_id, source_unit, source_value_numeric)
                   values ($1,$1,$2,$1,$1,$3,$1,$4,1)`, [crypto.randomUUID(), ids.versionId, ids.revId, x("u")]);
    await c.query(`insert into training_load.source_metric_audit (action, mapping_id, mapping_version_id, from_status, to_status, reason, performed_by_user_id, basis, operation_id)
                   values ('mapping_status',$1,$2,'needs_review','disabled',$3,$4,'platform_admin',$1)`, [crypto.randomUUID(), ids.versionId, x("reason"), ids.by]);
    await c.query(`insert into training_load.metric_variable_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, basis, metric_definition_id, metric_variable_change_id, reason)
                   values ($1,$2,'variable_archive',$3,'system','platform_admin',$1,$1,$4)`, [crypto.randomUUID(), ids.by, "0".repeat(64), x("reason")]);
    await c.query("commit");
    return ids;
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  }
}
async function removePlantedRows(c, ids) {
  await c.query("begin");
  await c.query("set local session_replication_role = replica");
  await c.query(`delete from training_load.metric_variable_requests where requested_by_user_id = $1`, [ids.by]);
  await c.query(`delete from training_load.source_metric_audit where performed_by_user_id = $1`, [ids.by]);
  await c.query(`delete from training_load.metric_value_source_provenance where mapping_version_id = $1`, [ids.versionId]);
  await c.query(`delete from training_load.source_metric_mapping_activations where mapping_version_id = $1`, [ids.versionId]);
  await c.query(`delete from training_load.source_metric_mapping_versions where id = $1`, [ids.versionId]);
  await c.query(`delete from training_load.unit_conversions where id = $1`, [ids.convId]);
  await c.query(`delete from training_load.source_metric_definition_versions where id = $1`, [ids.revId]);
  await c.query(`delete from training_load.source_metric_definitions where id = $1`, [ids.fieldId]);
  await c.query("commit");
}

test("2. v40 fails closed: on a copy that holds a row of every listed column the new rule refuses, the v40 preflight counts each column and the migration's block refuses - v40 rolls back, v39 stays applied and the catalog is v39's (the text functions still v34's); without those rows v40 applies", async () => {
  const before38 = await catalog(r);
  const planted = await plantRefusedRows(r);
  const pre40 = await blocks(r, V40_PREFLIGHT);
  assert.equal(pre40[4].length, 21);
  for (const x of pre40[4]) assert.ok(Number(x.refused) >= 1, `the inline copy counts ${x.col}`);
  let failure = null;
  try { await migrate(rdb.url, [...UP_TO_V38, V39, V40]); } catch (error) { failure = error; }
  assert.ok(failure, "the runner stopped");
  const cause = failure.cause ?? failure;
  assert.equal(cause.code, "23514");
  assert.match(cause.message, /^v40 refused: rows the new text rule refuses exist \(/);
  for (const x of pre40[4]) assert.ok(cause.message.includes(`${x.col} `), `the block names ${x.col}`);
  assert.ok(!cause.message.includes(CGJ) && !cause.message.includes(planted.fieldId), "no value or id in the message");
  const after39 = await catalog(r);
  assert.ok(after39.migrations.includes(V39_NAME) && !after39.migrations.includes(V40_NAME), "v39 recorded, v40 not");
  const fns = await textFunctions(r);
  assert.ok((await rows(r, `select 1 from pg_proc where proname = 'source_metric_text_ok' and position('btrim' in prosrc) > 0`)).length === 1, "text_ok still v34's");
  W.rb = { before38, after39, textFunctions39: fns };
  await removePlantedRows(r, planted);
  await migrate(rdb.url, [...UP_TO_V38, V39, V40]);
  assert.ok((await catalog(r)).migrations.includes(V40_NAME));
});

test("3. migration v39 on v38: one function added and v37's two guard functions replaced, two deferred T2b constraint triggers and one unique T8 index, nothing else; the rollback refuses without v39, under a later migration (v40 first), with a v39 trigger missing or disabled, without its index or function, and once the lifecycle wrote a revision; it returns the identical v38 catalog (v37's bodies verbatim) and v39 applies again identically; v40 rolls back to the identical v39 catalog with the same function OIDs, and its rollback runs after the lifecycle wrote", async () => {
  const { before38, after39 } = W.rb;
  // v40 is applied (test 2): its catalog against v39's.
  const after40 = await catalog(r);
  assert.deepEqual({ ...after40, functions: undefined, migrations: undefined }, { ...after39, functions: undefined, migrations: undefined }, "v40 changes no table, column, constraint, index or trigger");
  const changed40 = after40.functions.filter((x) => after39.functions.find((y) => y.proname === x.proname && y.args === x.args)?.digest !== x.digest).map((x) => x.proname).sort();
  assert.deepEqual(changed40, ["source_metric_text_ok", "source_metric_unit_token_ok"]);
  const fns40 = await textFunctions(r);
  assert.deepEqual(fns40.map((x) => x.oid), W.rb.textFunctions39.map((x) => x.oid), "the same OIDs: every CHECK stays attached");
  // v39 against v38.
  assert.deepEqual(after39.tables, before38.tables, "no table");
  assert.deepEqual(after39.columns, before38.columns, "no column");
  assert.deepEqual(added(after39.constraints, before38.constraints, (x) => `${x.rel}.${x.conname}`).map((x) => [x.conname, x.contype]).sort(),
    [["source_metric_revisions_v39_audit_link_insert", "t"], ["source_metric_revisions_v39_audit_link_state", "t"]]);
  assert.deepEqual(before38.constraints, after39.constraints.filter((x) => !x.conname.includes("_v39_")), "no existing constraint changed");
  assert.deepEqual(added(after39.indexes, before38.indexes, (x) => x.indexname).map((x) => x.indexname), ["source_metric_audit_v39_revision_once"]);
  assert.match(after39.indexes.find((x) => x.indexname === "source_metric_audit_v39_revision_once").indexdef, /^CREATE UNIQUE INDEX/);
  assert.deepEqual(before38.indexes, after39.indexes.filter((x) => x.indexname !== "source_metric_audit_v39_revision_once"));
  const newTriggers = added(after39.triggers, before38.triggers, (x) => `${x.relname}.${x.tgname}`);
  assert.deepEqual(newTriggers.map((x) => x.tgname).sort(), ["source_metric_revisions_v39_audit_link_insert", "source_metric_revisions_v39_audit_link_state"]);
  for (const t of newTriggers) assert.match(t.def, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(newTriggers.find((x) => x.tgname.endsWith("_insert")).def, /AFTER INSERT .* WHEN \(\(new\.seed_migration IS NULL\)\)/);
  assert.match(newTriggers.find((x) => x.tgname.endsWith("_state")).def, /AFTER UPDATE .* WHEN \(\(old\.state IS DISTINCT FROM new\.state\)\)/);
  assert.deepEqual(before38.triggers, after39.triggers.filter((x) => !x.tgname.includes("_v39_")), "no existing trigger changed");
  assert.deepEqual(added(after39.functions, before38.functions, (x) => `${x.proname}(${x.args})`).map((x) => x.proname), ["source_metric_revisions_lifecycle_link"]);
  const changed39 = after39.functions.filter((x) => before38.functions.find((y) => y.proname === x.proname && y.args === x.args && y.digest !== x.digest)).map((x) => x.proname).sort();
  assert.deepEqual(changed39, ["source_metric_audit_revision_guard", "source_metric_revisions_actor_guard"]);
  // The v39 rollback refuses under v40; the v37 and v38 rollbacks refuse while v39 is recorded.
  assert.match((await runScript(r, V39_ROLLBACK))?.message ?? "", /^v39 rollback refused: later migrations are applied/);
  assert.match((await runScript(r, V37_ROLLBACK))?.message ?? "", /^v37 rollback refused: .*later migrations are applied/);
  assert.match((await runScript(r, V38_ROLLBACK))?.message ?? "", /refused/);
  // v40's rollback: refused under a later migration and without v40; back to v39's catalog, v40 again.
  await r.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209901010000_test_later.sql', $1, 'test')`, ["0".repeat(64)]);
  assert.match((await runScript(r, V40_ROLLBACK))?.message ?? "", /^v40 rollback refused: later migrations are applied/);
  await r.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/209901010000_test_later.sql'`);
  assert.equal(await runScript(r, V40_ROLLBACK), null);
  assert.deepEqual(await catalog(r), after39, "the v40 rollback returns the identical v39 catalog");
  assert.deepEqual((await textFunctions(r)).map((x) => x.oid), W.rb.textFunctions39.map((x) => x.oid), "still the same OIDs");
  assert.match((await runScript(r, V40_ROLLBACK))?.message ?? "", /^v40 rollback refused: v40 is not recorded/);
  await migrate(rdb.url, [...UP_TO_V38, V39, V40]);
  assert.deepEqual(await catalog(r), after40, "v40 applies again identically");
  // v40 back, then each v39 refusal changes nothing.
  assert.equal(await runScript(r, V40_ROLLBACK), null);
  for (const [setup, undo, reason] of [
    [`alter table training_load.source_metric_definition_versions disable trigger source_metric_revisions_v39_audit_link_state`,
      `alter table training_load.source_metric_definition_versions enable trigger source_metric_revisions_v39_audit_link_state`, /a v39 trigger is disabled/],
    [`alter trigger source_metric_revisions_v39_audit_link_insert on training_load.source_metric_definition_versions rename to v39_renamed`,
      `alter trigger v39_renamed on training_load.source_metric_definition_versions rename to source_metric_revisions_v39_audit_link_insert`, /the v39 triggers are not all present/],
    [`alter index training_load.source_metric_audit_v39_revision_once rename to v39_renamed_idx`,
      `alter index training_load.v39_renamed_idx rename to source_metric_audit_v39_revision_once`, /the v39 index is not present/],
    [`alter function training_load.source_metric_revisions_lifecycle_link() rename to v39_renamed_fn`,
      `alter function training_load.v39_renamed_fn() rename to source_metric_revisions_lifecycle_link`, /the v39 function is not present/],
  ]) {
    await r.query(setup);
    assert.match((await runScript(r, V39_ROLLBACK))?.message ?? "", reason);
    await r.query(undo);
  }
  assert.deepEqual(await catalog(r), after39, "every refusal changed nothing");
  // A clean rollback: the identical v38 catalog (v37's bodies verbatim); then v39 and v40 again.
  assert.equal(await runScript(r, V39_ROLLBACK), null);
  assert.deepEqual(await catalog(r), before38, "the rollback returns the identical v38 catalog");
  assert.match((await runScript(r, V39_ROLLBACK))?.message ?? "", /^v39 rollback refused: v39 is not recorded/);
  await migrate(rdb.url, [...UP_TO_V38, V39, V40]);
  assert.deepEqual(await catalog(r), after40, "v39 and v40 apply again identically");
  // Once the lifecycle wrote a revision: v40's rollback still runs, v39's refuses.
  const by = (await one(r, `insert into public.users (email, full_name, display_name, is_active) values ($1,'pa','pa',true) returning id`, [`v39rb-${uid()}@test.local`])).id;
  await r.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [by]);
  const fieldId = (await one(r, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Test field',$2) returning id`, [`v39rb.f${uid()}`, by])).id;
  await writeRevision(r, { fieldId, by, evidenceRef: COMPAT, state: "draft" });
  assert.equal(await runScript(r, V40_ROLLBACK), null, "v40's rollback runs after the lifecycle wrote");
  const withRevision = await catalog(r);
  assert.match((await runScript(r, V39_ROLLBACK))?.message ?? "", /^v39 rollback refused: revisions were written by the lifecycle/);
  assert.deepEqual(await catalog(r), withRevision, "the refusal changed nothing");
  await migrate(rdb.url, [...UP_TO_V38, V39, V40]);
  // The post-checks on the deployed state.
  const post39 = await blocks(r, V39_POSTCHECK);
  assert.deepEqual([post39[1][0].v39_rows, post39[1][0].v39_checksum_ok, post39[1][0].later_rows, post39[1][0].last_migration, post39[1][0].v38_rows, post39[1][0].v38_checksum_ok],
    ["1", true, "1", V40_NAME, "1", true]);
  assert.deepEqual([post39[2][0].actor_guard_is_v39, post39[2][0].audit_guard_is_v39, post39[2][0].lifecycle_link], [true, true, "1"]);
  assert.deepEqual([post39[3][0].v39_triggers, post39[3][0].v39_triggers_enabled, post39[3][0].v39_deferred_links, post39[3][0].missing_triggers, post39[3][0].v37_triggers_enabled], ["2", "2", "2", [], "3"]);
  assert.deepEqual([post39[4][0].v39_indexes, post39[4][0].v39_indexes_valid, post39[4][0].v39_unique_once], ["1", "1", "1"]);
  assert.deepEqual([post39[5][0].revision_triggers, post39[5][0].audit_triggers, post39[5][0].disabled_triggers], ["6", "5", "0"]);
  assert.deepEqual([post39[6][0].revisions, post39[6][0].seeded_unproven, post39[6][0].lifecycle_revisions, post39[6][0].lifecycle_rows], ["10", "9", "1", "1"], "the rehearsal's one lifecycle revision");
  assert.deepEqual([post39[7][0].actor_defaults, post39[7][0].no_session_actor], ["0", true]);
  const post40 = await blocks(r, V40_POSTCHECK);
  assert.deepEqual([post40[1][0].v40_rows, post40[1][0].v40_checksum_ok, post40[1][0].later_rows, post40[1][0].last_migration, post40[1][0].v39_rows], ["1", true, "0", V40_NAME, "1"]);
  assert.deepEqual([post40[2][0].text_ok_is_v40, post40[2][0].unit_token_is_v40, post40[2][0].sql_immutable, post40[2][0].text_ok_args, post40[2][0].unit_token_args],
    [true, true, "2", "v text, max_len integer", "v text"]);
  assert.deepEqual([post40[3][0].checks, post40[3][0].checks_validated], ["21", "21"]);
  assert.equal(post40[4].length, 21);
  assert.ok(post40[4].every((x) => x.refused === "0"));
  // The block of v40 and the preflight name the same 21 columns as every CHECK that calls the functions.
  const checkTables = (await rows(r, `select c.conrelid::regclass::text as rel, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace
                                       where n.nspname = 'training_load' and c.contype = 'c' and pg_get_constraintdef(c.oid) ~ '(source_metric_text_ok|source_metric_unit_token_ok|source_metric_parameters_shape_ok)\\('`));
  assert.equal(checkTables.length, 21);
  const migrationText = await fsp.readFile(path.resolve(ROOT, "migrations_v2", V40), "utf8");
  const blockColumns = [...migrationText.matchAll(/^      \('([a-z_]+\.[a-z_]+)',$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(blockColumns, post40[4].map((x) => x.col).sort(), "the migration's block and the scripts name the same columns");
});

// ---------------------------------------------------------------------------
// Parity (J5.4): the SQL functions, the preflight's inline copy and metricTextRules.js.
// ---------------------------------------------------------------------------
async function inlineRules() {
  const text = await fsp.readFile(V40_PREFLIGHT, "utf8");
  const rule = (name) => {
    const found = [...text.matchAll(new RegExp(`^    '(.*)'::text as ${name},?$`, "gm"))].map((m) => m[1]);
    assert.ok(found.length === 2 && found[0] === found[1], `two identical copies of ${name}`);
    assert.ok([...found[0]].every((c) => c.codePointAt(0) < 128), `${name} is ASCII`);
    return found[0];
  };
  return { edge: rule("edge"), text: rule("text_forbidden"), unit: rule("unit_forbidden") };
}

test("4. parity: on every code point U+0001-U+10FFFF but the surrogates - alone, inside a text, at its start and at its end - the v40 SQL functions, the preflight's inline copy and backend/src/metricTextRules.js agree; so do both lengths at the limit, counted in code points", async () => {
  const rule = await inlineRules();
  const sql = `select i::int as i, training_load.source_metric_text_ok(s, 10) as t, training_load.source_metric_unit_token_ok(s) as u,
                      (char_length(s) between 1 and 10 and s !~ $2 and s !~ $3) as ti,
                      (char_length(s) between 1 and 30 and s !~ $4) as ui
                 from unnest($1::text[]) with ordinality as x(s, i)`;
  const mismatches = [];
  const BATCH = 8192;
  let checked = 0;
  for (let start = 1; start <= 0x10ffff; start += BATCH) {
    const strings = [];
    for (let cp = start; cp < Math.min(start + BATCH, 0x110000); cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = ch(cp);
      strings.push(c, `a${c}a`, `${c}a`, `a${c}`);
    }
    if (strings.length === 0) continue;
    const result = (await k.query(sql, [strings, rule.edge, rule.text, rule.unit])).rows;
    for (const row of result) {
      const s = strings[row.i - 1];
      const t = boundedText(s, 10);
      const u = unitTokenOk(s);
      if (row.t !== t || row.ti !== t || row.u !== u || row.ui !== u) mismatches.push([s.codePointAt(s.startsWith("a") && s.length > 1 ? 1 : 0).toString(16), row, t, u]);
    }
    checked += strings.length;
  }
  assert.equal(checked, 4 * (0x10ffff - 0x800), "every code point but the surrogates, four ways");
  assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} mismatches`);
  // The lengths at the limit, in code points (an astral character counts once).
  const smile = ch(0x1f600);
  for (const [s, max] of [[smile.repeat(10), 10], [smile.repeat(11), 10], ["a".repeat(80), 80], ["a".repeat(81), 80], [smile.repeat(500), 500], [smile.repeat(501), 500]]) {
    const row = await one(k, `select training_load.source_metric_text_ok($1, $2) as t, (char_length($1) between 1 and $2 and $1 !~ $3 and $1 !~ $4) as ti`, [s, max, rule.edge, rule.text]);
    assert.deepEqual([row.t, row.ti], [boundedText(s, max), boundedText(s, max)], `${[...s].length} of ${max}`);
  }
  for (const s of [smile.repeat(30), smile.repeat(31), "m".repeat(30), "m".repeat(31), ""]) {
    const row = await one(k, `select training_load.source_metric_unit_token_ok($1) as u, (char_length($1) between 1 and 30 and $1 !~ $2) as ui`, [s, rule.unit]);
    assert.deepEqual([row.u, row.ui], [unitTokenOk(s), unitTokenOk(s)], `${[...s].length} characters`);
  }
  // What part B adds (O6): an emoji with a variation selector, blank-edged text, the
  // characters C53 left out - refused by the database whoever writes it.
  for (const s of [`${ch(0x2764)}${ch(0xfe0f)}`, `Label${ch(0xa0)}`, `${ch(0x3000)}Label`, `La${ch(0x34f)}bel`, `La${ch(0xe0041)}bel`, `La${ch(0x2065)}bel`]) {
    assert.equal((await one(k, `select training_load.source_metric_text_ok($1, 80) as t`, [s])).t, false, JSON.stringify(s));
  }
  assert.equal((await one(k, `select training_load.source_metric_unit_token_ok($1) as u`, [`m${ch(0x3164)}`])).u, false);
});

// ---------------------------------------------------------------------------
// The database guards of v39 (the behaviour database).
// ---------------------------------------------------------------------------
test("5. the v39 database guards: a revision INSERT, an activation and a retirement need an acting user who is an active platform admin and the row naming that user (42501, in the T2b guard itself); a state change writes only its own facts; at COMMIT every INSERT and every state change has its lifecycle audit row; a lifecycle audit row follows its own change (this transaction, its user, its transition, its reason), once - physically too; a savepoint fails closed", async () => {
  const f = await field();
  // INSERT: the acting user.
  refusedWith(await tx(null, (c) => insertDraft(c, { fieldId: f.fieldId, n: 2, by: W.pa.id })), "42501", NO_ACTOR);
  refusedWith(await tx(W.caA.id, (c) => insertDraft(c, { fieldId: f.fieldId, n: 2, by: W.caA.id })), "42501", MAY_NOT_CHANGE);
  refusedWith(await tx(W.paRevoked.id, (c) => insertDraft(c, { fieldId: f.fieldId, n: 2, by: W.paRevoked.id })), "42501", MAY_NOT_CHANGE);
  refusedWith(await tx(W.pa.id, (c) => insertDraft(c, { fieldId: f.fieldId, n: 2, by: W.pa2.id })), "42501", REVISION_OTHER_USER);
  refusedWith(await tx(W.pa.id, (c) => insertDraft(c, { fieldId: f.fieldId, n: 2, by: W.pa.id })), "23514", NO_CREATE_ROW);
  const draftId = okTx(await tx(W.pa.id, async (c) => {
    const id = await insertDraft(c, { fieldId: f.fieldId, n: 2, by: W.pa.id });
    await lifecycleRow(c, { action: "source_metric_revision_create", fieldId: f.fieldId, revId: id, by: W.pa.id, to: "draft" });
    return id;
  }));
  // The create row: its own revision, its user, no reason, no foreign reference; once.
  refusedWith(await tx(W.pa.id, (c) => lifecycleRow(c, { action: "source_metric_revision_create", fieldId: f.fieldId, revId: draftId, by: W.pa.id, to: "draft" })), "23514", FOLLOW);
  for (const [extra, pattern] of [[{ reason: "x" }, FOLLOW], [{ ref: UNIT_REF }, FOLLOW]]) {
    const g = await field();
    refusedWith(await tx(W.pa.id, async (c) => {
      const id = await insertDraft(c, { fieldId: g.fieldId, n: 2, by: W.pa.id });
      await lifecycleRow(c, { action: "source_metric_revision_create", fieldId: g.fieldId, revId: id, by: W.pa.id, to: "draft", ...extra });
    }), "23514", pattern);
  }
  // Activation and retirement: the acting user, in the T2b guard itself (a field
  // with a draft only, so v34's own "another revision is active" never comes first).
  const draft = { fieldId: f.fieldId, revId: draftId };
  const lone = await field({ state: "draft" });
  // A session that is no active platform admin, naming a platform admin (v34 passes
  // the named activator and checks no retirer): the v39 guard's own refusal.
  for (const who of [W.caA.id, W.paRevoked.id]) {
    refusedWith(await tx(who, (c) => activateRaw(c, { revId: lone.revId, by: W.pa.id })), "42501", MAY_NOT_CHANGE);
    refusedWith(await tx(who, (c) => retireRaw(c, { revId: f.revId, by: W.pa.id })), "42501", MAY_NOT_CHANGE);
    refusedWith(await tx(who, (c) => retireRaw(c, { revId: f.revId, by: who })), "42501", MAY_NOT_CHANGE);
  }
  // Naming itself as the activator, v34's own identity check refuses first.
  refusedWith(await tx(W.caA.id, (c) => activateRaw(c, { revId: lone.revId, by: W.caA.id })), "42501", /not an active platform admin/);
  refusedWith(await tx(W.pa.id, (c) => retireRaw(c, { revId: f.revId, by: W.pa2.id })), "42501", REVISION_OTHER_USER);
  refusedWith(await tx(W.pa.id, (c) => activateRaw(c, { revId: lone.revId, by: W.pa2.id })), "42501", REVISION_OTHER_USER);
  refusedWith(await tx(null, (c) => retireRaw(c, { revId: f.revId, by: W.pa.id })), "42501", NO_ACTOR);
  // A state change writes only its own facts (v34 alone would let the status rise with it).
  const unproven = await field({ state: "draft", status: "unproven" });
  refusedWith(await tx(W.pa.id, (c) => c.query(`update training_load.source_metric_definition_versions set state = 'active', activated_by_user_id = $2, activated_at = now(), evidence_status = 'documented', evidence_ref = $3 where id = $1`,
    [unproven.revId, W.pa.id, COMPAT])), "23514", ONLY_STATE);
  // At COMMIT: a state change without its row.
  refusedWith(await tx(W.pa.id, (c) => retireRaw(c, { revId: f.revId, by: W.pa.id })), "23514", NO_STATE_ROW);
  refusedWith(await tx(W.pa.id, (c) => activateRaw(c, { revId: unproven.revId, by: W.pa.id })), "23514", NO_STATE_ROW);
  // The retire row: its reason, its from_status, no reference; the activate row: its own activation.
  for (const extra of [{ reason: "Another reason" }, { from: "draft" }, { ref: COMPAT }]) {
    refusedWith(await tx(W.pa.id, async (c) => {
      await retireRaw(c, { revId: f.revId, by: W.pa.id, reason: "Test retirement" });
      await lifecycleRow(c, { action: "source_metric_revision_retire", fieldId: f.fieldId, revId: f.revId, by: W.pa.id, from: "active", to: "retired", reason: "Test retirement", ...extra });
    }), "23514", FOLLOW);
  }
  refusedWith(await tx(W.pa.id, (c) => lifecycleRow(c, { action: "source_metric_revision_activate", fieldId: draft.fieldId, revId: draftId, by: W.pa.id, from: "draft", to: "active" })), "23514", FOLLOW);
  refusedWith(await tx(W.pa.id, async (c) => {
    await activateRaw(c, { revId: unproven.revId, by: W.pa.id });
    await lifecycleRow(c, { action: "source_metric_revision_activate", fieldId: unproven.fieldId, revId: unproven.revId, by: W.pa.id, from: "draft", to: "active", ref: COMPAT });
  }), "23514", FOLLOW);
  // Its user: an acting user switched inside the transaction.
  refusedWith(await tx(W.pa.id, async (c) => {
    await activateRaw(c, { revId: unproven.revId, by: W.pa.id });
    await c.query(CTX, [W.pa2.id]);
    await lifecycleRow(c, { action: "source_metric_revision_activate", fieldId: unproven.fieldId, revId: unproven.revId, by: W.pa2.id, from: "draft", to: "active" });
  }), "23514", FOLLOW);
  // The basis of a revision row is a platform admin's (v34's audit guard refuses another first).
  refusedWith(await tx(W.pa.id, async (c) => {
    await activateRaw(c, { revId: unproven.revId, by: W.pa.id });
    await lifecycleRow(c, { action: "source_metric_revision_activate", fieldId: unproven.fieldId, revId: unproven.revId, by: W.pa.id, from: "draft", to: "active", basis: "club_admin" });
  }), "23514", /^source_metric_audit: a club-admin row names a club mapping$/);
  // A savepoint fails closed.
  refusedWith(await tx(W.pa.id, async (c) => {
    await c.query("savepoint s");
    await activateRaw(c, { revId: unproven.revId, by: W.pa.id });
    await c.query("release savepoint s");
    await lifecycleRow(c, { action: "source_metric_revision_activate", fieldId: unproven.fieldId, revId: unproven.revId, by: W.pa.id, from: "draft", to: "active" });
  }), "23514", FOLLOW);
  // Once: a second row in the same transaction; with the guard off, the unique index.
  refusedWith(await tx(W.pa.id, async (c) => {
    await activateRaw(c, { revId: unproven.revId, by: W.pa.id });
    await lifecycleRow(c, { action: "source_metric_revision_activate", fieldId: unproven.fieldId, revId: unproven.revId, by: W.pa.id, from: "draft", to: "active" });
    await lifecycleRow(c, { action: "source_metric_revision_activate", fieldId: unproven.fieldId, revId: unproven.revId, by: W.pa.id, from: "draft", to: "active" });
  }), "23514", ONCE);
  refusedWith(await tx(W.pa.id, async (c) => {
    await activateRaw(c, { revId: unproven.revId, by: W.pa.id });
    await lifecycleRow(c, { action: "source_metric_revision_activate", fieldId: unproven.fieldId, revId: unproven.revId, by: W.pa.id, from: "draft", to: "active" });
    await c.query(`alter table training_load.source_metric_audit disable trigger source_metric_audit_v37_revision_guard`);
    await lifecycleRow(c, { action: "source_metric_revision_activate", fieldId: unproven.fieldId, revId: unproven.revId, by: W.pa.id, from: "draft", to: "active" });
  }), "23505", /source_metric_audit_v39_revision_once/);
  // The legitimate writes.
  okTx(await tx(W.pa.id, async (c) => {
    await activateRaw(c, { revId: unproven.revId, by: W.pa.id });
    await lifecycleRow(c, { action: "source_metric_revision_activate", fieldId: unproven.fieldId, revId: unproven.revId, by: W.pa.id, from: "draft", to: "active" });
  }));
  okTx(await tx(W.pa.id, async (c) => {
    await retireRaw(c, { revId: unproven.revId, by: W.pa.id, reason: "Test retirement" });
    await lifecycleRow(c, { action: "source_metric_revision_retire", fieldId: unproven.fieldId, revId: unproven.revId, by: W.pa.id, from: "active", to: "retired", reason: "Test retirement" });
  }));
  assert.deepEqual([(await revisionRow(unproven.revId)).state, (await revisionRow(unproven.revId)).evidence_status], ["retired", "unproven"]);
  // v37's verification chain is unchanged under v39 (M2b's own suite covers it).
  refusedWith(await tx(W.pa.id, (c) => c.query(`insert into training_load.source_metric_audit (action, source_metric_definition_id, performed_by_user_id, basis, operation_id, from_status, to_status) values ('source_metric_create',$1,$2,'platform_admin',$3,null,'active')`,
    [f.fieldId, W.pa.id, crypto.randomUUID()])), "23514", /^source_metric_audit: no writer of this action exists yet$/);
  refusedWith(await tx(W.caA.id, (c) => lifecycleRow(c, { action: "source_metric_revision_retire", fieldId: f.fieldId, revId: f.revId, by: W.caA.id, from: "active", to: "retired", reason: "x" })), "42501");
  void AUDIT_MAY_NOT;
});

test("6. the seed exception (O9): inside a seed window a seed marker's active revision without a creator commits with no audit row; a marker with a creator is the v39 guard's own refusal (42501, not v34's CHECK); outside a window a marker with an acting user, a marker without one, and neither marker nor actor are each 42501; the nine seeded revisions are unchanged", async () => {
  const marker = "migrations_v2/209912312359_test_seed_window.sql";
  const v34 = await fsp.readFile(V34_FILE, "utf8");
  const original = v34.match(/create function training_load\.source_metric_require_seed_window\(p_marker text\) returns void as \$\$\n[\s\S]*?\n\$\$ language plpgsql;/)[0]
    .replace("create function", "create or replace function");
  const seedInsert = (c, { fieldId, creator }) => c.query(
    `insert into training_load.source_metric_definition_versions (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill,
       evidence_status, evidence_ref, state, activated_at, seed_migration, created_by_user_id)
     values ($1,1,'number','none',true,true,'observed',$2,'active',now(),$3,$4) returning id`, [fieldId, COMPAT, marker, creator]);
  const newField = async () => (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Seed test',$2) returning id`,
    [`v39.seed.f${uid()}`, W.pa.id])).id;
  // Outside a window.
  const outside = await newField();
  refusedWith(await tx(W.pa.id, (c) => seedInsert(c, { fieldId: outside, creator: null })), "42501", SEED_WINDOW);
  refusedWith(await tx(null, (c) => seedInsert(c, { fieldId: outside, creator: null })), "42501", SEED_WINDOW);
  refusedWith(await tx(W.pa.id, (c) => seedInsert(c, { fieldId: outside, creator: W.pa.id })), "42501", SEED_WINDOW);
  refusedWith(await tx(null, (c) => c.query(`insert into training_load.source_metric_definition_versions (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill, evidence_status)
                                               values ($1,1,'number','none',true,true,'unproven')`, [outside])), "42501", NO_ACTOR);
  // Inside a simulated window (a test-only replacement of the window function, restored after).
  await k.query(`create or replace function training_load.source_metric_require_seed_window(p_marker text) returns void as $$
    begin
      if p_marker is distinct from '${marker}' or exists (select 1 from public.schema_migrations where migration_name = p_marker) then
        raise exception 'source metric mapping: a seed marker is accepted only from the seeding migration' using errcode = '42501';
      end if;
    end;
    $$ language plpgsql`);
  try {
    const inside = await newField();
    refusedWith(await tx(W.pa.id, (c) => seedInsert(c, { fieldId: inside, creator: W.pa.id })), "42501", SEED_WITH_ACTOR);
    const seeded = okTx(await tx(null, (c) => seedInsert(c, { fieldId: inside, creator: null }))).rows[0].id;
    const row = await revisionRow(seeded);
    assert.deepEqual([row.state, row.seed_migration, row.created_by_user_id, row.activated_by_user_id], ["active", marker, null, null]);
    assert.equal((await auditOf(`source_metric_version_id = $1`, [seeded])).length, 0, "a seed writes no audit row");
  } finally {
    await k.query(original);
  }
  assert.deepEqual(await rows(k, `select * from training_load.source_metric_definition_versions where seed_migration like 'migrations_v2/202610121000%' order by id`), W.seedBefore, "the nine seeded revisions unchanged");
});

// ---------------------------------------------------------------------------
// Access and the body (J5.2, J5.5).
// ---------------------------------------------------------------------------
test("7. who may call L1-L5: no session is 401; a club admin, a platform admin in a club workspace, a coach and a user without a role get the identical 404 - with valid JSON, a non-JSON body and a malformed id - before the body is looked at; for the platform admin in the platform workspace a non-JSON body is 415, a non-object 400, a malformed or unknown id the identical 404; nothing is written", async () => {
  const f = await field();
  const auditBefore = (await one(k, `select count(*)::int as n from training_load.source_metric_audit`)).n;
  const revisionsBefore = (await one(k, `select count(*)::int as n from training_load.source_metric_definition_versions`)).n;
  const paths = (fid, rid) => [
    [`/fields/${fid}/revisions`, createBody()],
    [`/fields/${fid}/revisions/${rid}/retire`, { requestKey: key(), expectedState: "active", reason: "Test retirement" }],
    [`/fields/${fid}/revisions/${rid}/activate`, { requestKey: key() }],
    [`/fields/${fid}/revisions/${rid}/replace`, { requestKey: key(), reason: "Test retirement", expectedActiveRevisionId: rid }],
  ];
  for (const [p, body] of paths(f.fieldId, f.revId)) assert.equal((await post(p, null, body)).status, 401, p);
  for (const who of [W.caA, W.paA, W.coach, W.plain]) {
    for (const [p, body] of [...paths(f.fieldId, f.revId), ...paths("not-a-uuid", "nope")]) {
      for (const sent of [body, "not json"]) {
        const res = await api(p, { method: "POST", cookie: who.cookie, body: sent, contentType: typeof sent === "string" ? "text/plain" : "application/json" });
        assert.deepEqual([res.status, res.body, res.headers.get("cache-control")], [404, { error: "notFound" }, "no-store"], `${p} ${typeof sent}`);
      }
    }
  }
  for (const [p] of paths(f.fieldId, f.revId)) {
    assert.equal((await api(p, { method: "POST", cookie: W.pa.cookie, body: "not json", contentType: "text/plain" })).status, 415, p);
    const arr = await post(p, W.pa.cookie, []);
    assert.deepEqual([arr.status, arr.body.error], [400, "invalid_body"], p);
  }
  for (const [p, body] of [...paths("not-a-uuid", f.revId), ...paths(f.fieldId, "nope").slice(1), ...paths(crypto.randomUUID(), f.revId), ...paths(f.fieldId, crypto.randomUUID()).slice(1)]) {
    assert.deepEqual([(await post(p, W.pa.cookie, body)).status], [404], p);
  }
  const other = await field();
  assert.equal((await post(retirePath(f, other.revId), W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "x" })).status, 404, "a revision of another field");
  assert.equal((await one(k, `select count(*)::int as n from training_load.source_metric_audit`)).n, auditBefore + 2, "only the second fixture's rows");
  assert.equal((await one(k, `select count(*)::int as n from training_load.source_metric_definition_versions`)).n, revisionsBefore + 1);
});

test("8. L1 creates R+1 as a draft (201): the next number, the body's contract, unproven by default or documented / observed with a reference, the acting user as creator, one keyed audit row; a replay answers the same revision, the same key with another body is request_key_reused; the body is checked (invalid_body, invalid_unit, invalid_evidence_ref, the JavaScript and database rules agreeing); 409 draft_exists, field_not_active and revision_limit", async () => {
  const f = await field();
  const k1 = key();
  const body = createBody({ requestKey: k1, valueShape: "zone_distance", parameterKind: "zone_bounds", supportsDrill: false, expectedSourceUnit: "m", expectedSourceBoundUnit: "m/s", unitNote: "Unit note.", evidenceStatus: "documented", evidenceRef: COMPAT });
  const res = await post(createPath(f), W.pa.cookie, body);
  assert.equal(res.status, 201, res.text);
  const rev = res.body.revision;
  assert.deepEqual([rev.fieldId, rev.revisionNumber, rev.state, rev.valueShape, rev.parameterKind, rev.supportsSession, rev.supportsDrill, rev.expectedSourceUnit, rev.expectedSourceBoundUnit, rev.evidenceStatus, rev.evidenceRef, rev.sourceUnit],
    [f.fieldId, 2, "draft", "zone_distance", "zone_bounds", true, false, "m", "m/s", "documented", COMPAT, null]);
  const row = await revisionRow(rev.id);
  assert.deepEqual([row.created_by_user_id, row.unit_note, row.seed_migration], [W.pa.id, "Unit note.", null]);
  const audit = await auditOf(`source_metric_version_id = $1`, [rev.id]);
  assert.deepEqual(audit.map((a) => [a.action, a.from_status, a.to_status, a.reason, a.evidence_ref, a.performed_by_user_id, a.basis, a.request_key]),
    [["source_metric_revision_create", null, "draft", null, COMPAT, W.pa.id, "platform_admin", k1]]);
  assert.ok(!res.text.includes(W.pa.id), "no actor id");
  const replay = await post(createPath(f), W.pa.cookie, body);
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.revision.id], [200, true, rev.id]);
  assert.equal((await post(createPath(f), W.pa.cookie, { ...body, unitNote: "Another note." })).body.error, "request_key_reused");
  // A draft exists.
  const dup = await post(createPath(f), W.pa.cookie, createBody());
  assert.deepEqual([dup.status, dup.body.error, dup.body.current], [409, "draft_exists", { draftRevisionId: rev.id }]);
  // The body.
  const g = await field();
  for (const [over, code] of [
    [{ unknown: 1 }, "invalid_body"], [{ state: "active" }, "invalid_body"], [{ revisionNumber: 7 }, "invalid_body"], [{ createdByUserId: W.pa.id }, "invalid_body"],
    [{ evidenceStatus: "verified", evidenceRef: COMPAT }, "invalid_body"], [{ valueShape: "text" }, "invalid_body"], [{ parameterKind: "zone_bounds" }, "invalid_body"],
    [{ valueShape: "zone_distance" }, "invalid_body"], [{ supportsSession: false, supportsDrill: false }, "invalid_body"], [{ supportsSession: "yes" }, "invalid_body"],
    [{ expectedSourceUnit: "m s" }, "invalid_unit"], [{ expectedSourceUnit: `m${ch(0x3164)}` }, "invalid_unit"], [{ expectedSourceBoundUnit: "m" }, "invalid_body"],
    [{ unitNote: `Note${ch(0xa0)}` }, "invalid_body"], [{ unitNote: `No${ch(0x200b)}te` }, "invalid_body"], [{ evidenceRef: COMPAT }, "invalid_body"],
    [{ evidenceStatus: "observed" }, "invalid_evidence_ref"], [{ evidenceStatus: "observed", evidenceRef: "https://x#y" }, "invalid_evidence_ref"],
    [{ requestKey: "nope" }, "invalid_body"],
  ]) {
    const bad = await post(createPath(g), W.pa.cookie, createBody(over));
    assert.deepEqual([bad.status, bad.body.error], [400, code], JSON.stringify(over));
  }
  {
    const { requestKey, ...noKey } = createBody();
    void requestKey;
    assert.equal((await post(createPath(g), W.pa.cookie, noKey)).body.error, "invalid_body");
  }
  assert.equal((await one(k, `select count(*)::int as n from training_load.source_metric_definition_versions where source_metric_definition_id = $1`, [g.fieldId])).n, 1, "nothing written");
  // A retired field.
  const h = await field({ state: "retired" });
  await k.query(`update training_load.source_metric_definitions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Test retirement' where id = $1`, [h.fieldId, W.pa.id]);
  assert.deepEqual([(await post(createPath(h), W.pa.cookie, createBody())).body.error], ["field_not_active"]);
  // R7: twenty revisions are the reads' cap.
  const full = await field({ state: "retired" });
  for (let n = 2; n <= 19; n += 1) await revisionOf(full, n, { state: "retired" });
  await revisionOf(full, 20, { state: "active" });
  const limit = await post(createPath(full), W.pa.cookie, createBody());
  assert.deepEqual([limit.status, limit.body.error, limit.body.limit], [409, "revision_limit", 20]);
  assert.equal((await api(`/fields/${full.fieldId}`, { cookie: W.pa.cookie })).status, 200, "the field still reads");
});

test("9. L3 activates a draft while the field has no active revision (200, its keyed audit row); revision_active_exists, revision_not_draft; after L5 an unverified draft may be activated even after a verified revision (O3)", async () => {
  const f = await field({ unit: "s", meaning: true });
  assert.equal((await revisionRow(f.revId)).evidence_status, "verified");
  const draft = await revisionOf(f, 2);
  const busy = await post(activatePath(f, draft), W.pa.cookie, { requestKey: key() });
  assert.deepEqual([busy.status, busy.body.error, busy.body.current], [409, "revision_active_exists", { activeRevisionId: f.revId }]);
  const notDraft = await post(activatePath(f, f.revId), W.pa.cookie, { requestKey: key() });
  assert.deepEqual([notDraft.status, notDraft.body.error, notDraft.body.current], [409, "revision_not_draft", { state: "active" }]);
  const stop = await post(retirePath(f, f.revId), W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "The proof turned out wrong." });
  assert.equal(stop.status, 200, stop.text);
  assert.deepEqual([stop.body.revision.state, stop.body.disabledVersions], ["retired", { system: 0, club: 0 }]);
  const k3 = key();
  const on = await post(activatePath(f, draft), W.pa.cookie, { requestKey: k3 });
  assert.equal(on.status, 200, on.text);
  assert.deepEqual([on.body.revision.id, on.body.revision.state, on.body.revision.evidenceStatus, on.body.replaced, on.body.disabledVersions], [draft, "active", "observed", undefined, undefined]);
  assert.deepEqual((await auditOf(`request_key = $1`, [k3])).map((a) => [a.action, a.from_status, a.to_status, a.source_metric_version_id]), [["source_metric_revision_activate", "draft", "active", draft]]);
  assert.equal((await revisionRow(draft)).activated_by_user_id, W.pa.id);
  const retiredAgain = await post(activatePath(f, f.revId), W.pa.cookie, { requestKey: key() });
  assert.deepEqual([retiredAgain.body.error, retiredAgain.body.current], ["revision_not_draft", { state: "retired" }]);
  // The retired revision keeps its reason (no answer carries it).
  assert.equal((await revisionRow(f.revId)).retired_reason, "The proof turned out wrong.");
  assert.ok(!stop.text.includes("turned out wrong"));
});

test("10. L4 replaces the active R by the draft R+1 in one transaction (200): R retired with the reason, R+1 active, one keyed audit row (activate) and the retire row under the same operation; versions created on R+1 are untouched; revision_changed, revision_not_active, revision_not_draft; O2: a verified R only by a verified R+1; a key of L3 is request_key_reused on L4, a replay answers the same", async () => {
  const f = await field({ unit: "s" });
  const r2 = await revisionOf(f, 2, { unit: "s" });
  const onR2 = await pinnedVersion(f, r2, { submit: false });
  const stale = await post(replacePath(f, r2), W.pa.cookie, { requestKey: key(), reason: "Corrected contract.", expectedActiveRevisionId: r2 });
  assert.deepEqual([stale.status, stale.body.error, stale.body.current], [409, "revision_changed", { activeRevisionId: f.revId }]);
  const notDraft = await post(replacePath(f, f.revId), W.pa.cookie, { requestKey: key(), reason: "x", expectedActiveRevisionId: f.revId });
  assert.deepEqual([notDraft.body.error, notDraft.body.current], ["revision_not_draft", { state: "active" }]);
  assert.equal((await post(replacePath(f, r2), W.pa.cookie, { requestKey: key(), reason: `x${ch(0x34f)}`, expectedActiveRevisionId: f.revId })).body.error, "invalid_body");
  assert.equal((await post(replacePath(f, r2), W.pa.cookie, { requestKey: key(), reason: "x", expectedActiveRevisionId: "nope" })).body.error, "invalid_body");
  const k4 = key();
  const body = { requestKey: k4, reason: "Corrected contract.", expectedActiveRevisionId: f.revId };
  const res = await post(replacePath(f, r2), W.pa.cookie, body);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.body.revision.id, res.body.revision.state, res.body.replaced.id, res.body.replaced.state, res.body.disabledVersions], [r2, "active", f.revId, "retired", { system: 0, club: 0 }]);
  const old = await revisionRow(f.revId);
  assert.deepEqual([old.retired_reason, old.retired_by_user_id], ["Corrected contract.", W.pa.id]);
  const operation = (await auditOf(`request_key = $1`, [k4]))[0];
  assert.deepEqual((await auditOf(`operation_id = $1`, [operation.operation_id])).map((a) => [a.action, a.source_metric_version_id, a.from_status, a.to_status, a.reason, a.request_key === null]).sort(),
    [["source_metric_revision_activate", r2, "draft", "active", null, false], ["source_metric_revision_retire", f.revId, "active", "retired", "Corrected contract.", true]]);
  assert.equal((await versionRow(onR2.versionId)).status, "draft", "a version on R+1 is untouched");
  const replay = await post(replacePath(f, r2), W.pa.cookie, body);
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.revision.id, replay.body.replaced.id], [200, true, r2, f.revId]);
  assert.equal((await post(replacePath(f, r2), W.pa.cookie, { ...body, reason: "Other." })).body.error, "request_key_reused");
  // No active revision: L5 then L4.
  const g = await field();
  const g2 = await revisionOf(g, 2);
  assert.equal((await post(retirePath(g, g.revId), W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "Stopped." })).status, 200);
  const none = await post(replacePath(g, g2), W.pa.cookie, { requestKey: key(), reason: "x", expectedActiveRevisionId: g.revId });
  assert.deepEqual([none.status, none.body.error], [409, "revision_not_active"]);
  // A key of L3 on L4 (both write a source_metric_revision_activate row).
  const kL3 = key();
  assert.equal((await post(activatePath(g, g2), W.pa.cookie, { requestKey: kL3 })).status, 200);
  const g3 = await revisionOf(g, 3);
  assert.equal((await post(replacePath(g, g3), W.pa.cookie, { requestKey: kL3, reason: "x", expectedActiveRevisionId: g2 })).body.error, "request_key_reused");
  // O2.
  const v = await field({ unit: "s", meaning: true });
  const vNext = await revisionOf(v, 2, { unit: "s" });
  const o2 = await post(replacePath(v, vNext), W.pa.cookie, { requestKey: key(), reason: "x", expectedActiveRevisionId: v.revId });
  assert.deepEqual([o2.status, o2.body.error], [409, "successor_not_verified"]);
  await verifyRevisionRow(k, { fieldId: v.fieldId, revisionId: vNext, by: W.pa.id, meaning: true, meaningRef: MEANING_REF });
  assert.equal((await post(replacePath(v, vNext), W.pa.cookie, { requestKey: key(), reason: "x", expectedActiveRevisionId: v.revId })).status, 200);
  // The seeds are observed, so any R+1 may replace one (not done here: the nine seeded fields are never touched).
});

test("11. the pinned step (L2, L4, L5; O4, O7): every needs_review version pinned to the retired revision - a club's included - is disabled by the acting platform admin with the fixed reason and one mapping_status row each, counted by owner scope; a pinned draft stays a draft and can no longer be submitted; after an L4 with one disabled version there is one keyed audit row and three rows of its operation; an archived club's version is 409 club_archived naming only that club; from phase 7b (J8 Q5, Q7) an active pinned version is disabled too, its row from active; from phase 7d (J10, O5) its open activation is ended first, with the fixed reason", async () => {
  // L5 with a system and a club version submitted, and a club draft.
  const f = await field({ unit: "s" });
  const sys = await pinnedVersion(f, f.revId);
  const clubV = await pinnedVersion(f, f.revId, { owner: W.caA, variable: W.clubAVar });
  const clubDraft = await pinnedVersion(f, f.revId, { owner: W.caA, variable: W.clubAVar, submit: false });
  const k5 = key();
  const res = await post(retirePath(f, f.revId), W.pa.cookie, { requestKey: k5, expectedState: "active", reason: "Stopped: wrong proof." });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.disabledVersions, { system: 1, club: 1 });
  for (const v of [sys, clubV]) {
    const row = await versionRow(v.versionId);
    assert.deepEqual([row.status, row.disable_reason, row.disabled_by_user_id, row.disabled_basis], ["disabled", PINNED_REASON, W.pa.id, "platform_admin"]);
  }
  assert.equal((await versionRow(clubDraft.versionId)).status, "draft");
  const op = (await auditOf(`request_key = $1`, [k5]))[0];
  const opRows = await auditOf(`operation_id = $1`, [op.operation_id]);
  assert.deepEqual(opRows.map((a) => [a.action, a.from_status, a.to_status, a.reason, a.basis, a.request_key === null]).sort(),
    [["mapping_status", "needs_review", "disabled", PINNED_REASON, "platform_admin", true], ["mapping_status", "needs_review", "disabled", PINNED_REASON, "platform_admin", true],
      ["source_metric_revision_retire", "active", "retired", "Stopped: wrong proof.", "platform_admin", false]]);
  for (const id of [sys.mappingId, clubV.mappingId, sys.versionId, clubV.versionId, W.clubA]) assert.ok(!res.text.includes(id), "counts only");
  const late = await post(`/mappings/${clubDraft.mappingId}/versions/${clubDraft.versionId}/submit`, W.caA.cookie, { requestKey: key() });
  assert.deepEqual([late.status, late.body.error], [409, "revision_not_usable"]);
  // L2 on a draft revision with a submitted version.
  const g = await field({ state: "draft", unit: "s" });
  const gv = await pinnedVersion(g, g.revId);
  const l2 = await post(retirePath(g, g.revId), W.pa.cookie, { requestKey: key(), expectedState: "draft", reason: "Abandoned draft." });
  assert.deepEqual([l2.status, l2.body.revision.state, l2.body.disabledVersions], [200, "retired", { system: 1, club: 0 }]);
  assert.equal((await versionRow(gv.versionId)).status, "disabled");
  assert.equal((await auditOf(`source_metric_version_id = $1 and action = 'source_metric_revision_retire'`, [g.revId]))[0].from_status, "draft");
  // L4 with one disabled version: one keyed row, three rows of the operation.
  const h = await field({ unit: "s" });
  const h2 = await revisionOf(h, 2, { unit: "s" });
  await pinnedVersion(h, h.revId);
  const k4 = key();
  const l4 = await post(replacePath(h, h2), W.pa.cookie, { requestKey: k4, reason: "Corrected.", expectedActiveRevisionId: h.revId });
  assert.deepEqual([l4.status, l4.body.disabledVersions], [200, { system: 1, club: 0 }]);
  const keyed = await auditOf(`request_key = $1`, [k4]);
  assert.equal(keyed.length, 1);
  assert.equal((await auditOf(`operation_id = $1`, [keyed[0].operation_id])).length, 3);
  // An archived club (O7(ii)(a)).
  const a = await field({ unit: "s" });
  const bv = await pinnedVersion(a, a.revId, { owner: W.caB, variable: W.clubBVar });
  const sv = await pinnedVersion(a, a.revId);
  await k.query(`update public.clubs set is_active = false where id = $1`, [W.clubB]);
  try {
    const refused = await post(retirePath(a, a.revId), W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "x" });
    assert.deepEqual([refused.status, refused.body.error, refused.body.clubIds], [409, "club_archived", [W.clubB]]);
    for (const id of [bv.mappingId, bv.versionId, sv.versionId]) assert.ok(!refused.text.includes(id));
    assert.deepEqual([(await revisionRow(a.revId)).state, (await versionRow(bv.versionId)).status, (await versionRow(sv.versionId)).status], ["active", "needs_review", "needs_review"], "nothing written");
  } finally {
    await k.query(`update public.clubs set is_active = true where id = $1`, [W.clubB]);
  }
  assert.deepEqual((await post(retirePath(a, a.revId), W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "x" })).body.disabledVersions, { system: 1, club: 1 });
  // An active pinned version (written here directly, as phase 7b's A1 would)
  // and an open activation, which cannot exist before phase 7d (a disposable
  // database, triggers off for these statements only).
  const asPhase7 = async (sql, params) => {
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
  };
  const b = await field({ unit: "s" });
  const bvA = await pinnedVersion(b, b.revId);
  await asPhase7(`update training_load.source_metric_mapping_versions set status = 'active', activated_by_user_id = $2, activated_at = now(), activated_basis = 'platform_admin' where id = $1`, [bvA.versionId, W.pa.id]);
  const kActive = key();
  const active = await post(retirePath(b, b.revId), W.pa.cookie, { requestKey: kActive, expectedState: "active", reason: "x" });
  assert.deepEqual([active.status, active.body.revision?.state, active.body.disabledVersions], [200, "retired", { system: 1, club: 0 }], active.text);
  const disabledActive = await versionRow(bvA.versionId);
  assert.deepEqual([disabledActive.status, disabledActive.disable_reason, disabledActive.disabled_by_user_id], ["disabled", PINNED_REASON, W.pa.id]);
  const activeOp = (await auditOf(`request_key = $1`, [kActive]))[0].operation_id;
  assert.deepEqual((await auditOf(`operation_id = $1 and action = 'mapping_status'`, [activeOp])).map((a) => [a.mapping_version_id, a.from_status, a.to_status, a.reason]),
    [[bvA.versionId, "active", "disabled", PINNED_REASON]], "the row carries the version's real from_status");
  assert.ok(!active.text.includes(bvA.versionId) && !active.text.includes(bvA.mappingId), "counts only");
  const c = await field({ unit: "s" });
  const cv = await pinnedVersion(c, c.revId);
  // A raw open activation (a real team, a binding id that names no binding):
  // the pinned step ends it first, with the fixed reason, then retires.
  const binding = crypto.randomUUID();
  const fp = (await versionRow(cv.versionId)).parameter_fingerprint;
  const activationId = (await asPhase7(`insert into training_load.source_metric_mapping_activations (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, source_team_binding_id, team_id,
                     applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
                   values ($1,$2,$3,$4,$5,$6,$7,true,true,'required',$8,'platform_admin','Phase 7 simulation') returning id`,
    [cv.versionId, cv.mappingId, c.fieldId, W.sysVar.id, fp, binding, W.teamA, W.pa.id])).rows[0].id;
  const open = await post(retirePath(c, c.revId), W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "x" });
  assert.equal(open.status, 200, open.text);
  assert.equal((await revisionRow(c.revId)).state, "retired");
  const ended = await one(k, `select end_reason, ended_basis, ended_by_user_id from training_load.source_metric_mapping_activations where id = $1`, [activationId]);
  assert.deepEqual([ended.end_reason, ended.ended_basis, ended.ended_by_user_id], ["mapping_version_disabled", "platform_admin", W.pa.id]);
  assert.equal((await one(k, `select reason from training_load.source_metric_audit where action = 'activation_end' and activation_id = $1`, [activationId])).reason, PINNED_REASON);
});

test("12. the COMMIT of L4 through the real route: a refusal at COMMIT by a deferred v39 link is definite (500, nothing written, the key free); a lost COMMIT answer is verified by the request key on another connection (verified_after_commit_error); an unverifiable one is 503 outcome_unknown and the same key then replays the committed answer", async () => {
  // A seam leaves out the retire row: the activate row is written, the deferred link refuses R's retirement.
  const f = await field({ unit: "s" });
  const f2 = await revisionOf(f, 2, { unit: "s" });
  const pinned = await pinnedVersion(f, f.revId);
  lifecycle.setRevisionSkipAuditRowForTests("source_metric_revision_retire");
  const kRef = key();
  const refused = await post(replacePath(f, f2), W.pa.cookie, { requestKey: kRef, reason: "Corrected.", expectedActiveRevisionId: f.revId });
  lifecycle.setRevisionSkipAuditRowForTests(null);
  assert.deepEqual([refused.status, refused.body.error], [500, "internal_error"]);
  assert.deepEqual([(await revisionRow(f.revId)).state, (await revisionRow(f2)).state, (await versionRow(pinned.versionId)).status], ["active", "draft", "needs_review"], "nothing written");
  assert.equal((await auditOf(`request_key = $1`, [kRef])).length, 0);
  assert.ok(logLines.some((l) => l.includes("internal_error") && l.includes("23514")), "logged by its code");
  assert.ok(!logLines.some((l) => /a state change is written with its/.test(l)), "never the trigger's text");
  const ok = await post(replacePath(f, f2), W.pa.cookie, { requestKey: kRef, reason: "Corrected.", expectedActiveRevisionId: f.revId });
  assert.equal(ok.status, 200, "the same key is free after a definite refusal");
  // A lost COMMIT answer, verified.
  const g = await field({ unit: "s" });
  const g2 = await revisionOf(g, 2, { unit: "s" });
  service.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw new Error("answer lost"); }), timeoutMs: 2_000 });
  const kLost = key();
  const lost = await post(replacePath(g, g2), W.pa.cookie, { requestKey: kLost, reason: "Corrected.", expectedActiveRevisionId: g.revId });
  service.setMappingCommitForTests();
  assert.deepEqual([lost.status, lost.body.commitConfirmation, lost.body.revision?.id, lost.body.replaced?.id], [200, "verified_after_commit_error", g2, g.revId]);
  // A lost and unverifiable one.
  const h = await field({ unit: "s" });
  const h2 = await revisionOf(h, 2, { unit: "s" });
  service.setMappingCommitForTests({
    fault: (client) => client.query("commit").then(() => { throw new Error("answer lost"); }), timeoutMs: 2_000,
    checkFault: () => { throw new Error("no connection"); },
  });
  const kUnknown = key();
  const unknown = await post(replacePath(h, h2), W.pa.cookie, { requestKey: kUnknown, reason: "Corrected.", expectedActiveRevisionId: h.revId });
  service.setMappingCommitForTests();
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.requestKey], [503, "outcome_unknown", kUnknown]);
  const again = await post(replacePath(h, h2), W.pa.cookie, { requestKey: kUnknown, reason: "Corrected.", expectedActiveRevisionId: h.revId });
  assert.deepEqual([again.status, again.body.replayed, again.body.revision.state, again.body.replaced.state], [200, true, "active", "retired"]);
});

// The concurrency helpers: a lifecycle write held after its locks while another
// writer starts, or another writer held while the lifecycle starts.
async function heldLifecycle(start, during) {
  const { g, state } = holdLifecycle();
  const running = start();
  await until(() => state.entered, "the lifecycle write holds its locks");
  const other = during();
  assert.ok(await someoneWaits(), "the other writer waits for the lifecycle's locks");
  g.open();
  lifecycle.setRevisionWriteHoldForTests(null);
  return [await running, await other];
}
async function heldOther(setHold, startOther, lifecycleCall) {
  const g = gate();
  let entered = false;
  setHold(async () => { entered = true; await g.promise; });
  const other = startOther();
  await until(() => entered, "the other write holds its locks");
  const running = lifecycleCall();
  assert.ok(await someoneWaits(), "the lifecycle waits");
  g.open();
  setHold(null);
  return [await running, await other];
}
const m2Hold = (fn) => service.setMappingWriteHoldForTests(fn);
const m2bHold = (fn) => fieldsService.setFieldWriteHoldForTests(fn);
const replaceCall = (f, next) => () => post(replacePath(f, next), W.pa.cookie, { requestKey: key(), reason: "Corrected.", expectedActiveRevisionId: f.revId });
const mapping = async (f) => (await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: W.sysVar.id })).body.mapping.id;
const createOn = (mappingId, revId) => () => post(`/mappings/${mappingId}/versions`, W.pa.cookie, { requestKey: key(), sourceRevisionId: revId, appliesToSession: true, appliesToDrill: true });
test("13. concurrency, both orders (J5.5): L4 against an M2 version create on R and on R+1, an M2 submit on R and an M2b act on R and R+1; L5 against an M2 create on the retired revision; L5 against a club archive; L1 against L1 - the M2 side answers 409 revision_not_usable, never a 500", async () => {
  // L4 first, then an M2 create on R (retired meanwhile) and on R+1 (active meanwhile).
  {
    const f = await field({ unit: "s" });
    const n = await revisionOf(f, 2, { unit: "s" });
    const m = await mapping(f);
    const [l4, onR] = await heldLifecycle(replaceCall(f, n), createOn(m, f.revId));
    assert.equal(l4.status, 200);
    assert.deepEqual([onR.status, onR.body.error], [409, "revision_not_usable"]);
    const f2 = await field({ unit: "s" });
    const n2 = await revisionOf(f2, 2, { unit: "s" });
    const m2 = await mapping(f2);
    const [l4b, onNext] = await heldLifecycle(replaceCall(f2, n2), createOn(m2, n2));
    assert.deepEqual([l4b.status, onNext.status], [200, 201]);
  }
  // An M2 create on R first, then L4: the new draft stays a draft, L4 succeeds.
  {
    const f = await field({ unit: "s" });
    const n = await revisionOf(f, 2, { unit: "s" });
    const m = await mapping(f);
    const [l4, created] = await heldOther(m2Hold, createOn(m, f.revId), replaceCall(f, n));
    assert.deepEqual([created.status, l4.status, l4.body.disabledVersions], [201, 200, { system: 0, club: 0 }]);
    assert.equal((await versionRow(created.body.version.id)).status, "draft");
  }
  // L4 against an M2 submit on R, both orders.
  {
    const f = await field({ unit: "s" });
    const n = await revisionOf(f, 2, { unit: "s" });
    const v = await pinnedVersion(f, f.revId, { submit: false });
    const submit = () => post(`/mappings/${v.mappingId}/versions/${v.versionId}/submit`, W.pa.cookie, { requestKey: key() });
    const [l4, late] = await heldLifecycle(replaceCall(f, n), submit);
    assert.deepEqual([l4.status, late.status, late.body.error], [200, 409, "revision_not_usable"]);
    const g = await field({ unit: "s" });
    const gn = await revisionOf(g, 2, { unit: "s" });
    const gv = await pinnedVersion(g, g.revId, { submit: false });
    const submitG = () => post(`/mappings/${gv.mappingId}/versions/${gv.versionId}/submit`, W.pa.cookie, { requestKey: key() });
    const [l4b, early] = await heldOther(m2Hold, submitG, replaceCall(g, gn));
    assert.deepEqual([early.status, l4b.status, l4b.body.disabledVersions], [200, 200, { system: 1, club: 0 }]);
    assert.equal((await versionRow(gv.versionId)).status, "disabled");
  }
  // L4 against an M2b act on R and on R+1, both orders.
  {
    const f = await field();
    const n = await revisionOf(f, 2);
    const unitAct = (revId) => () => post(`/fields/${f.fieldId}/revisions/${revId}/unit-verification`, W.pa.cookie, { requestKey: key(), sourceUnit: "s", evidenceRef: UNIT_REF });
    const [l4, onR] = await heldLifecycle(replaceCall(f, n), unitAct(f.revId));
    assert.deepEqual([l4.status, onR.status, onR.body.error], [200, 409, "revision_retired"]);
    const g = await field();
    const gn = await revisionOf(g, 2);
    const unitActG = (revId) => () => post(`/fields/${g.fieldId}/revisions/${revId}/unit-verification`, W.pa.cookie, { requestKey: key(), sourceUnit: "s", evidenceRef: UNIT_REF });
    const [l4b, onNext] = await heldOther(m2bHold, unitActG(gn), replaceCall(g, gn));
    assert.deepEqual([onNext.status, l4b.status], [201, 200]);
    const h = await field();
    const hn = await revisionOf(h, 2);
    const unitActH = () => post(`/fields/${h.fieldId}/revisions/${hn}/unit-verification`, W.pa.cookie, { requestKey: key(), sourceUnit: "s", evidenceRef: UNIT_REF });
    const [l4c, afterL4] = await heldLifecycle(replaceCall(h, hn), unitActH);
    assert.deepEqual([l4c.status, afterL4.status], [200, 201], "an act on R+1 waits and then lands on the active revision");
  }
  // L5 against an M2 create on the revision it retires.
  {
    const f = await field({ unit: "s" });
    const m = await mapping(f);
    const [l5, onR] = await heldLifecycle(() => post(retirePath(f, f.revId), W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "Stopped." }), createOn(m, f.revId));
    assert.deepEqual([l5.status, onR.status, onR.body.error], [200, 409, "revision_not_usable"]);
  }
  // L5 against a club archive, both orders.
  {
    const clubX = await club("Club X");
    const caX = await clubAdmin(clubX);
    const varX = await canonical({ scope: "club", clubId: clubX });
    const f = await field({ unit: "s" });
    const v = await pinnedVersion(f, f.revId, { owner: caX, variable: varX });
    const archive = () => k.query(`update public.clubs set is_active = false where id = $1`, [clubX]);
    const archiving = new pg.Client({ connectionString: db.url });
    await archiving.connect();
    try {
      // L5 holds the club FOR SHARE: the archive waits, the version is disabled.
      const { g, state } = holdLifecycle();
      const l5 = post(retirePath(f, f.revId), W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "Stopped." });
      await until(() => state.entered, "L5 holds its locks");
      const archived = archiving.query(`update public.clubs set is_active = false where id = $1`, [clubX]);
      assert.ok(await someoneWaits(), "the archive waits for L5");
      g.open();
      lifecycle.setRevisionWriteHoldForTests(null);
      assert.deepEqual([(await l5).status, (await versionRow(v.versionId)).status], [200, "disabled"]);
      await archived;
      await archiving.query(`update public.clubs set is_active = true where id = $1`, [clubX]);
      // The archive first (its transaction open): L5 waits on the club and then answers club_archived.
      const g2 = await field({ unit: "s" });
      const v2 = await pinnedVersion(g2, g2.revId, { owner: caX, variable: varX });
      await archiving.query("begin");
      await archiving.query(`update public.clubs set is_active = false where id = $1`, [clubX]);
      const waiting = post(retirePath(g2, g2.revId), W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "Stopped." });
      assert.ok(await someoneWaits(), "L5 waits for the archive");
      await archiving.query("commit");
      const refused = await waiting;
      assert.deepEqual([refused.status, refused.body.error, refused.body.clubIds], [409, "club_archived", [clubX]]);
      assert.equal((await versionRow(v2.versionId)).status, "needs_review");
    } finally {
      await archiving.query("rollback").catch(() => {});
      await archiving.end().catch(() => {});
      void archive;
    }
  }
  // L1 against L1: the second waits and answers draft_exists.
  {
    const f = await field();
    const [first, second] = await heldLifecycle(() => post(createPath(f), W.pa.cookie, createBody()), () => post(createPath(f), W.pa2.cookie, createBody()));
    assert.deepEqual([first.status, second.status, second.body.error], [201, 409, "draft_exists"]);
  }
});

test("14. nothing of the nine seeded fields changed; no response carries an acting user's id, the database's or a trigger's text; the log names codes only", async () => {
  assert.deepEqual(await rows(k, `select * from training_load.source_metric_definition_versions where seed_migration like 'migrations_v2/202610121000%' order by id`), W.seedBefore);
  assert.equal(W.seedBefore.length, 9);
  for (const s of W.seedBefore) assert.deepEqual([s.state, s.evidence_status, s.source_unit, s.unit_verified_at, s.meaning_verified_at], ["active", "observed", null, null, null]);
  const userIds = [W.pa.id, W.pa2.id, W.paA.id, W.caA.id, W.caB.id];
  for (const text of responses) {
    assert.ok(!/source_metric_(mapping|audit|definition)|violates|syntax error|relation "/i.test(text), `no database text: ${text.slice(0, 160)}`);
    for (const id of userIds) assert.ok(!text.includes(id), "no acting user's id");
  }
  assert.ok(!logLines.some((l) => /source_metric_definition_versions:|source_metric_audit:/.test(l)), "no trigger text in the log");
});

test("15. the right is checked again under FOR SHARE after the registry locks (J5.2, step 4): a platform admin whose role is revoked while L1, L2, L3, L4 or L5 runs gets the identical 404 and nothing is written", async () => {
  for (const route of ["create", "retire-draft", "activate", "replace", "retire-active"]) {
    const pa = await platformAdmin();
    const f = await field({ state: route === "activate" ? "draft" : "active" });
    const next = route === "replace" || route === "retire-draft" ? await revisionOf(f, 2) : null;
    const auditBefore = (await one(k, `select count(*)::int as n from training_load.source_metric_audit`)).n;
    const revisionsBefore = await rows(k, `select id, state from training_load.source_metric_definition_versions where source_metric_definition_id = $1 order by id`, [f.fieldId]);
    let revoked = false;
    service.setMappingRightsHoldForTests(async () => {
      if (revoked) return;
      revoked = true;
      await k.query(`update public.user_global_roles set is_active = false where user_id = $1`, [pa.id]);
    });
    const call = {
      create: () => post(createPath(f), pa.cookie, createBody()),
      "retire-draft": () => post(retirePath(f, next), pa.cookie, { requestKey: key(), expectedState: "draft", reason: "Abandoned." }),
      activate: () => post(activatePath(f, f.revId), pa.cookie, { requestKey: key() }),
      replace: () => post(replacePath(f, next), pa.cookie, { requestKey: key(), reason: "Corrected.", expectedActiveRevisionId: f.revId }),
      "retire-active": () => post(retirePath(f, f.revId), pa.cookie, { requestKey: key(), expectedState: "active", reason: "Stopped." }),
    }[route];
    const res = await call();
    service.setMappingRightsHoldForTests(null);
    assert.ok(revoked, `${route}: the right was checked again`);
    assert.deepEqual([res.status, res.body], [404, { error: "notFound" }], route);
    assert.deepEqual(await rows(k, `select id, state from training_load.source_metric_definition_versions where source_metric_definition_id = $1 order by id`, [f.fieldId]), revisionsBefore, `${route}: nothing written`);
    assert.equal((await one(k, `select count(*)::int as n from training_load.source_metric_audit`)).n, auditBefore, `${route}: no audit row`);
  }
});

test("16. concurrency, the rest of J5.5's list in both orders: an M2 create on R+1 before L4; an M2b act that completes R's proof before L4 (O2 then sees R verified); L2 against an M2 create and an M2 submit on the draft it retires; L5 against an M2 submit and an M2 create first; L4 against a club archive - the M2 side answers 409 revision_not_usable, never a 500", async () => {
  // An M2 create on R+1 first, then L4: the version stays a draft on the now active R+1.
  {
    const f = await field({ unit: "s" });
    const n = await revisionOf(f, 2, { unit: "s" });
    const m = await mapping(f);
    const [l4, created] = await heldOther(m2Hold, createOn(m, n), replaceCall(f, n));
    assert.deepEqual([created.status, l4.status], [201, 200]);
    assert.equal((await versionRow(created.body.version.id)).status, "draft");
  }
  // An M2b act completing R's proof first, then L4 with an unverified R+1: O2 refuses.
  {
    const f = await field({ unit: "s" });
    const n = await revisionOf(f, 2);
    const meaning = () => post(`/fields/${f.fieldId}/revisions/${f.revId}/meaning-verification`, W.pa.cookie, { requestKey: key(), evidenceRef: MEANING_REF });
    const [l4, act] = await heldOther(m2bHold, meaning, replaceCall(f, n));
    assert.deepEqual([act.status, act.body.revision?.evidenceStatus, l4.status, l4.body.error], [201, "verified", 409, "successor_not_verified"]);
    assert.deepEqual([(await revisionRow(f.revId)).state, (await revisionRow(n)).state], ["active", "draft"], "nothing written by L4");
  }
  // L2 first, then an M2 create on the retired draft.
  {
    const f = await field({ unit: "s" });
    const d = await revisionOf(f, 2, { unit: "s" });
    const m = await mapping(f);
    const [l2, onD] = await heldLifecycle(() => post(retirePath(f, d), W.pa.cookie, { requestKey: key(), expectedState: "draft", reason: "Abandoned." }), createOn(m, d));
    assert.deepEqual([l2.status, onD.status, onD.body.error], [200, 409, "revision_not_usable"]);
  }
  // An M2 submit on the draft revision first, then L2: the submitted version is disabled.
  {
    const f = await field({ unit: "s" });
    const d = await revisionOf(f, 2, { unit: "s" });
    const v = await pinnedVersion(f, d, { submit: false });
    const submit = () => post(`/mappings/${v.mappingId}/versions/${v.versionId}/submit`, W.pa.cookie, { requestKey: key() });
    const [l2, submitted] = await heldOther(m2Hold, submit, () => post(retirePath(f, d), W.pa.cookie, { requestKey: key(), expectedState: "draft", reason: "Abandoned." }));
    assert.deepEqual([submitted.status, l2.status, l2.body.disabledVersions], [200, 200, { system: 1, club: 0 }]);
    assert.equal((await versionRow(v.versionId)).status, "disabled");
  }
  // L2 first, then an M2 submit on the retired draft.
  {
    const f = await field({ unit: "s" });
    const d = await revisionOf(f, 2, { unit: "s" });
    const v = await pinnedVersion(f, d, { submit: false });
    const submit = () => post(`/mappings/${v.mappingId}/versions/${v.versionId}/submit`, W.pa.cookie, { requestKey: key() });
    const [l2, late] = await heldLifecycle(() => post(retirePath(f, d), W.pa.cookie, { requestKey: key(), expectedState: "draft", reason: "Abandoned." }), submit);
    assert.deepEqual([l2.status, late.status, late.body.error], [200, 409, "revision_not_usable"]);
  }
  // L5 first, then an M2 submit on R; an M2 create on R first, then L5.
  {
    const f = await field({ unit: "s" });
    const v = await pinnedVersion(f, f.revId, { submit: false });
    const submit = () => post(`/mappings/${v.mappingId}/versions/${v.versionId}/submit`, W.pa.cookie, { requestKey: key() });
    const [l5, late] = await heldLifecycle(() => post(retirePath(f, f.revId), W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "Stopped." }), submit);
    assert.deepEqual([l5.status, late.status, late.body.error], [200, 409, "revision_not_usable"]);
    const g = await field({ unit: "s" });
    const m = await mapping(g);
    const [l5b, created] = await heldOther(m2Hold, createOn(m, g.revId), () => post(retirePath(g, g.revId), W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "Stopped." }));
    assert.deepEqual([created.status, l5b.status, l5b.body.disabledVersions], [201, 200, { system: 0, club: 0 }]);
    assert.equal((await versionRow(created.body.version.id)).status, "draft");
  }
  // L4 against a club archive, both orders.
  {
    const clubY = await club("Club Y");
    const caY = await clubAdmin(clubY);
    const varY = await canonical({ scope: "club", clubId: clubY });
    const archiving = new pg.Client({ connectionString: db.url });
    await archiving.connect();
    try {
      const f = await field({ unit: "s" });
      const n = await revisionOf(f, 2, { unit: "s" });
      const v = await pinnedVersion(f, f.revId, { owner: caY, variable: varY });
      const [l4, archived] = await heldLifecycle(replaceCall(f, n), () => archiving.query(`update public.clubs set is_active = false where id = $1`, [clubY]));
      assert.deepEqual([l4.status, l4.body.disabledVersions, archived.rowCount], [200, { system: 0, club: 1 }, 1]);
      assert.equal((await versionRow(v.versionId)).status, "disabled");
      await archiving.query(`update public.clubs set is_active = true where id = $1`, [clubY]);
      const g = await field({ unit: "s" });
      const gn = await revisionOf(g, 2, { unit: "s" });
      const gv = await pinnedVersion(g, g.revId, { owner: caY, variable: varY });
      await archiving.query("begin");
      await archiving.query(`update public.clubs set is_active = false where id = $1`, [clubY]);
      const waiting = replaceCall(g, gn)();
      assert.ok(await someoneWaits(), "L4 waits for the archive");
      await archiving.query("commit");
      const refused = await waiting;
      assert.deepEqual([refused.status, refused.body.error, refused.body.clubIds], [409, "club_archived", [clubY]]);
      assert.deepEqual([(await revisionRow(g.revId)).state, (await revisionRow(gn)).state, (await versionRow(gv.versionId)).status], ["active", "draft", "needs_review"]);
    } finally {
      await archiving.query("rollback").catch(() => {});
      await archiving.end().catch(() => {});
    }
  }
});

test("17. the pinned step for L2 and L4 with a club's version: L4 disables a system and a club version (counted by scope, the fixed reason on each); L2 with an archived club's submitted version is 409 club_archived naming only that club, and succeeds once the club is restored", async () => {
  const f = await field({ unit: "s" });
  const n = await revisionOf(f, 2, { unit: "s" });
  const sys = await pinnedVersion(f, f.revId);
  const clubV = await pinnedVersion(f, f.revId, { owner: W.caA, variable: W.clubAVar });
  const l4 = await post(replacePath(f, n), W.pa.cookie, { requestKey: key(), reason: "Corrected.", expectedActiveRevisionId: f.revId });
  assert.deepEqual([l4.status, l4.body.disabledVersions], [200, { system: 1, club: 1 }]);
  for (const v of [sys, clubV]) assert.deepEqual([(await versionRow(v.versionId)).status, (await versionRow(v.versionId)).disable_reason], ["disabled", PINNED_REASON]);
  const g = await field({ unit: "s" });
  const d = await revisionOf(g, 2, { unit: "s" });
  const bv = await pinnedVersion(g, d, { owner: W.caB, variable: W.clubBVar });
  await k.query(`update public.clubs set is_active = false where id = $1`, [W.clubB]);
  try {
    const refused = await post(retirePath(g, d), W.pa.cookie, { requestKey: key(), expectedState: "draft", reason: "Abandoned." });
    assert.deepEqual([refused.status, refused.body.error, refused.body.clubIds], [409, "club_archived", [W.clubB]]);
    for (const id of [bv.mappingId, bv.versionId]) assert.ok(!refused.text.includes(id));
    assert.deepEqual([(await revisionRow(d)).state, (await versionRow(bv.versionId)).status], ["draft", "needs_review"]);
  } finally {
    await k.query(`update public.clubs set is_active = true where id = $1`, [W.clubB]);
  }
  const l2 = await post(retirePath(g, d), W.pa.cookie, { requestKey: key(), expectedState: "draft", reason: "Abandoned." });
  assert.deepEqual([l2.status, l2.body.disabledVersions], [200, { system: 0, club: 1 }]);
});

test("18. the 23505 mapping by constraint name: a second draft of a field is source_metric_revisions_one_draft -> 409 draft_exists, a revision number taken is source_metric_revisions_number_key -> 409 try_again; through the route, two L1 on a field with no revision at all (nothing to lock) end with one draft and a try_again with Retry-After 5, never a 500", async () => {
  const bare = async () => (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Bare field',$2) returning id`,
    [`v39.bare.f${uid()}`, W.pa.id])).id;
  const f1 = await bare();
  await writeRevision(k, { fieldId: f1, by: W.pa.id, revisionNumber: 1, evidenceRef: COMPAT, state: "draft" });
  const draftErr = await writeRevision(k, { fieldId: f1, by: W.pa.id, revisionNumber: 2, evidenceRef: COMPAT, state: "draft" }).then(() => null, (e) => e);
  assert.deepEqual([draftErr?.code, draftErr?.constraint], ["23505", "source_metric_revisions_one_draft"]);
  assert.deepEqual([lifecycle.classifyRevisionError(draftErr)?.status, lifecycle.classifyRevisionError(draftErr)?.code], [409, "draft_exists"]);
  const f2 = await bare();
  await writeRevision(k, { fieldId: f2, by: W.pa.id, revisionNumber: 1, evidenceRef: COMPAT, state: "retired" });
  const numberErr = await writeRevision(k, { fieldId: f2, by: W.pa.id, revisionNumber: 1, evidenceRef: COMPAT, state: "draft" }).then(() => null, (e) => e);
  assert.deepEqual([numberErr?.code, numberErr?.constraint], ["23505", "source_metric_revisions_number_key"]);
  assert.deepEqual([lifecycle.classifyRevisionError(numberErr)?.status, lifecycle.classifyRevisionError(numberErr)?.code], [409, "try_again"]);
  // Through the route: the first L1 is held after its checks, the second commits, the first then hits the unique index.
  const f3 = { fieldId: await bare() };
  const g = gate();
  let calls = 0;
  let entered = false;
  lifecycle.setRevisionWriteHoldForTests(async () => {
    calls += 1;
    if (calls === 1) { entered = true; await g.promise; }
  });
  const first = post(createPath(f3), W.pa.cookie, createBody());
  await until(() => entered, "the first L1 holds");
  const second = await post(createPath(f3), W.pa2.cookie, createBody());
  g.open();
  const late = await first;
  lifecycle.setRevisionWriteHoldForTests(null);
  assert.equal(second.status, 201, second.text);
  assert.deepEqual([late.status, late.body.error, late.headers.get("retry-after")], [409, "try_again", "5"]);
  assert.equal((await one(k, `select count(*)::int as n from training_load.source_metric_definition_versions where source_metric_definition_id = $1`, [f3.fieldId])).n, 1);
  const again = await post(createPath(f3), W.pa.cookie, createBody());
  assert.deepEqual([again.status, again.body.error], [409, "draft_exists"]);
});

test("19. L2 and L5 name the state the caller saw (expectedState): a draft activated meanwhile is not retired by a stale L2 (409 revision_state_changed naming the state, nothing written, its pinned version untouched), nor an active-only field by an L5 meant for a draft; expectedState is required and only draft or active; it is in the request hash; a retired revision stays revision_retired", async () => {
  const f = await field({ unit: "s" });
  const r2 = await revisionOf(f, 2, { unit: "s" });
  const onR2 = await pinnedVersion(f, r2);
  assert.equal((await versionRow(onR2.versionId)).status, "needs_review");
  // Another admin replaces R by R+1 while this caller still sees R+1 as a draft.
  assert.equal((await post(replacePath(f, r2), W.pa.cookie, { requestKey: key(), reason: "Corrected contract.", expectedActiveRevisionId: f.revId })).status, 200);
  const staleKey = key();
  const stale = await post(retirePath(f, r2), W.pa.cookie, { requestKey: staleKey, expectedState: "draft", reason: "Abandoned draft." });
  assert.deepEqual([stale.status, stale.body.error, stale.body.current], [409, "revision_state_changed", { state: "active" }]);
  assert.deepEqual([(await revisionRow(r2)).state, (await versionRow(onR2.versionId)).status], ["active", "needs_review"], "nothing written");
  assert.equal((await auditOf(`request_key = $1`, [staleKey])).length, 0);
  // The other direction: an L5 meant for an active revision on a draft.
  const g = await field({ state: "draft", unit: "s" });
  const wrong = await post(retirePath(g, g.revId), W.pa.cookie, { requestKey: key(), expectedState: "active", reason: "Stopped." });
  assert.deepEqual([wrong.status, wrong.body.error, wrong.body.current], [409, "revision_state_changed", { state: "draft" }]);
  assert.equal((await revisionRow(g.revId)).state, "draft");
  // The body.
  for (const body of [{ requestKey: key(), reason: "x" }, { requestKey: key(), reason: "x", expectedState: "retired" }, { requestKey: key(), reason: "x", expectedState: "DRAFT" }, { requestKey: key(), reason: "x", expectedState: null }]) {
    const res = await post(retirePath(f, r2), W.pa.cookie, body);
    assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], JSON.stringify(body));
  }
  // The hash covers expectedState; the retirement itself.
  const k5 = key();
  const done = await post(retirePath(f, r2), W.pa.cookie, { requestKey: k5, expectedState: "active", reason: "Stopped." });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual([done.body.revision.state, done.body.disabledVersions], ["retired", { system: 1, club: 0 }]);
  assert.equal((await post(retirePath(f, r2), W.pa.cookie, { requestKey: k5, expectedState: "draft", reason: "Stopped." })).body.error, "request_key_reused");
  assert.equal((await post(retirePath(f, r2), W.pa.cookie, { requestKey: k5, expectedState: "active", reason: "Stopped." })).body.replayed, true);
  const again = await post(retirePath(f, r2), W.pa.cookie, { requestKey: key(), expectedState: "draft", reason: "Stopped." });
  assert.deepEqual([again.status, again.body.error], [409, "revision_retired"]);
});

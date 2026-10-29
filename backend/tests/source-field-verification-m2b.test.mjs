// M2b - the source-field evidence confirmation (backend/src/sourceFieldVerificationService.js,
// routes under /api/training-load/sources/metrics/fields) and migration v37, its database
// guards. Through the real HTTP stack, on disposable optimove_tests_gpexe_* databases only
// (never OPTIMOVE, never a real GPEXE field): one migrated through v36 that rehearses v37's
// apply / rollback / re-apply, one migrated through v37 for the behaviour. Every confirmed
// field is a test field of this file; the nine seeded rest_v1 fields are never touched.
// Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, decisions C89-C97 and
// section J4.
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
const V37 = "202610151000_training_load_v37_source_metric_revision_guards.sql";
const V37_NAME = `migrations_v2/${V37}`;
const UP_TO_V36 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V37));
const MIGRATION_PATH = path.resolve(ROOT, "migrations_v2", V37);
const ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/source-metric-revision-guards-v37-rollback.sql");
const V36_ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/metric-variable-requests-v36-rollback.sql");
const V35_ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/source-metric-mapping-v35-rollback.sql");
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const V37_REVISION_TRIGGERS = ["source_metric_revisions_v37_actor_guard", "source_metric_revisions_v37_audit_link"];
const NO_ACTOR = /no acting user is set for this transaction/;
// v39 (the revision lifecycle) on the behaviour database: a revision INSERT or a state
// change without its lifecycle audit row is refused at COMMIT; a lifecycle audit row
// that does not follow its own change is refused at once.
const NO_CREATE_ROW = /^source_metric_definition_versions: a revision is written with its source_metric_revision_create audit row$/;
const NO_STATE_ROW = /^source_metric_definition_versions: a state change is written with its source_metric_revision_activate or _retire audit row$/;
const LIFECYCLE_FOLLOW = /^source_metric_audit: the audit row must follow its own revision change in the same transaction$/;
const ONE_ACT = /^source_metric_definition_versions: a revision is changed only by one unit or meaning verification$/;
const OTHER_USER = /^source metric verification: the row names another user than the acting user$/;
const MAY_NOT = /^source metric verification: the acting user may not verify a source metric$/;
const ZONE = /^source_metric_definition_versions: a zone takes the operator between or >=$/;
const EVENT_OP = /^source_metric_definition_versions: an event threshold takes a one-sided operator$/;
const FIRST_REF = /^source_metric_definition_versions: the first evidence reference is the completing act's own$/;
const FOLLOW = /^source_metric_audit: the audit row must follow its own verification in the same transaction$/;
const ONCE = /^source_metric_audit: the verification already has its audit row$/;
const NO_WRITER = /^source_metric_audit: no writer of this action exists yet$/;
const LINK_UNIT = /^source_metric_definition_versions: a unit verification is written with its source_metric_unit_verified audit row$/;
const LINK_MEANING = /^source_metric_definition_versions: a meaning verification is written with its source_metric_meaning_verified audit row$/;

let rdb, db, r, k, server, apiBase, service, fieldsService, dbModule, appPool, createSession;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};

async function applyV37(url) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v37-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of UP_TO_V36) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    await fsp.copyFile(MIGRATION_PATH, path.join(dir, V37));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

before(async () => {
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V37), "v37 is a test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v37rb", migrations: UP_TO_V36 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "m2b" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  await r.connect();
  await k.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  assert.ok((await k.query(`select 1 from public.schema_migrations where migration_name = $1`, [V37_NAME])).rowCount === 1, "the behaviour database carries v37");
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.M2B_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  fieldsService = await import("../src/sourceFieldVerificationService.js");
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
  service?.setMappingCommitForTests();
  service?.setMappingRightsHoldForTests(null);
  service?.setMappingRereadFaultForTests(null);
  fieldsService?.setFieldWriteHoldForTests(null);
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

afterEach(() => {
  for (const g of openGates.splice(0)) g.open();
  service.setMappingCommitForTests();
  service.setMappingRightsHoldForTests(null);
  service.setMappingRereadFaultForTests(null);
  service.setMappingWriteHoldForTests(null);
  fieldsService.setFieldWriteHoldForTests(null);
});

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
const post = (p, cookie, body) => api(p, { method: "POST", cookie, body });
const unitPath = (f) => `/fields/${f.fieldId}/revisions/${f.revId}/unit-verification`;
const meaningPath = (f) => `/fields/${f.fieldId}/revisions/${f.revId}/meaning-verification`;
const unitBody = (over = {}) => ({ requestKey: key(), sourceUnit: "s", evidenceRef: UNIT_REF, ...over });
const meaningBody = (over = {}) => ({ requestKey: key(), evidenceRef: MEANING_REF, ...over });

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
async function clubAdmin(clubId, { roleActive = true } = {}) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',$3)`, [id, clubId, roleActive]);
  await workspace(id, "club", clubId);
  return { id, cookie: await cookieFor(id) };
}
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const team = async (clubId) => (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;

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

// A test source field of gpexe / rest_v1 with revision 1, written through the
// revision lifecycle's database path (v39; backend/tests/support/source-revisions.mjs):
// the acting user set, each write with its audit row, every guard on.
async function fixture({ kind = "none", state = "active", status = "observed" } = {}) {
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Test field',$2) returning id`,
    [`m2b.test.f${uid()}`, W.pa.id])).id;
  const shape = kind === "zone_bounds" ? "zone_distance" : kind === "event_threshold" ? "event_count" : "number";
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: shape, parameterKind: kind, evidenceStatus: status, evidenceRef: COMPAT, state });
  return { fieldId, revId };
}
// The same field on the v37 rehearsal database, which stops at v37 and so has no
// revision lifecycle: written with v37's two T2b triggers off for these statements
// only, in one transaction (v34's own guard stays on).
async function fixtureOnV37(c, by) {
  const fieldId = (await one(c, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Test field',$2) returning id`,
    [`m2b.test.f${uid()}`, by])).id;
  await c.query("begin");
  try {
    for (const t of V37_REVISION_TRIGGERS) await c.query(`alter table training_load.source_metric_definition_versions disable trigger ${t}`);
    const revId = (await one(c, `insert into training_load.source_metric_definition_versions (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill, evidence_status, evidence_ref, created_by_user_id)
                                 values ($1,1,'number','none',true,true,'observed',$2,$3) returning id`, [fieldId, COMPAT, by])).id;
    await c.query(`update training_load.source_metric_definition_versions set state = 'active', activated_by_user_id = $2, activated_at = now() where id = $1`, [revId, by]);
    for (const t of V37_REVISION_TRIGGERS) await c.query(`alter table training_load.source_metric_definition_versions enable trigger ${t}`);
    await c.query("commit");
    return { fieldId, revId };
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  }
}
// The raw writes of an act, as the service writes them (for the database tests).
const unitAct = (c, { revId, by, unit = "s", boundUnit = null, ref = UNIT_REF, status = null }) => c.query(
  `update training_load.source_metric_definition_versions
      set source_unit = $2, source_bound_unit = $3, unit_verified_by_user_id = $4, unit_verified_at = now(), unit_evidence_ref = $5,
          evidence_status = coalesce($6, evidence_status)
    where id = $1`, [revId, unit, boundUnit, by, ref, status]);
const meaningAct = (c, { revId, by, operator = null, ref = MEANING_REF, status = null }) => c.query(
  `update training_load.source_metric_definition_versions
      set bound_operator = $2, meaning_verified_by_user_id = $3, meaning_verified_at = now(), meaning_evidence_ref = $4,
          evidence_status = coalesce($5, evidence_status)
    where id = $1`, [revId, operator, by, ref, status]);
const auditRow = (c, { action, f, by, ref }) => c.query(
  `insert into training_load.source_metric_audit (action, source_metric_definition_id, source_metric_version_id, evidence_ref, performed_by_user_id, basis, operation_id)
   values ($1,$2,$3,$4,$5,'platform_admin',$6)`, [action, f.fieldId, f.revId, ref, by, crypto.randomUUID()]);
const revisionRow = (f) => one(k, `select * from training_load.source_metric_definition_versions where id = $1`, [f.revId]);
// The verification audit rows of a revision (its lifecycle rows are the fixture's own).
const auditCount = (f) => one(k, `select count(*)::int as n from training_load.source_metric_audit where source_metric_version_id = $1 and action in ('source_metric_unit_verified', 'source_metric_meaning_verified')`, [f.revId]).then((x) => x.n);

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

async function world() {
  W.clubA = await club("Club A");
  W.clubC = await club("Club C");
  W.teamA = await team(W.clubA);
  W.pa = await platformAdmin();
  W.pa2 = await platformAdmin();
  W.paA = await platformAdmin(["club", W.clubA]);
  W.caA = await clubAdmin(W.clubA);
  W.caRevoked = await clubAdmin(W.clubA, { roleActive: false });
  W.caC = await clubAdmin(W.clubC);
  await k.query(`update public.clubs set is_active = false where id = $1`, [W.clubC]);
  W.paRevoked = await platformAdmin();
  await k.query(`update public.user_global_roles set is_active = false where user_id = $1`, [W.paRevoked.id]);
  const coachId = await user("coach");
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coachId, W.teamA]);
  await workspace(coachId, "team", W.teamA);
  W.coach = { id: coachId, cookie: await cookieFor(coachId) };
  const athleteId = await user("athlete");
  await k.query(`insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active) values ($1,$1,'Athlete','Only','Athlete Only','Athlete Only',$2,true)`, [`m2b${uid()}`, athleteId]);
  await workspace(athleteId, "athlete", null);
  W.athlete = { id: athleteId, cookie: await cookieFor(athleteId) };
  W.paTeam = await platformAdmin();
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [W.paTeam.id, W.teamA]);
  await workspace(W.paTeam.id, "team", W.teamA);
  W.seedBefore = await rows(k, `select * from training_load.source_metric_definition_versions where seed_migration like 'migrations_v2/202610121000%' order by id`);
}

// ---------------------------------------------------------------------------
test("1. migration v37 on v36: three functions, two T2b triggers (one deferred), one T8 trigger and two indexes (one unique), nothing else changed; the rollback refuses without v37, under a later migration, with a trigger missing or disabled, without an index and once a verification exists; it returns the identical v36 catalog and v37 applies again identically; the v36 and v35 rollbacks refuse while v37 is recorded", async () => {
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v37 rollback refused: v37 is not recorded/);
  const before36 = await catalog(r);
  await applyV37(rdb.url);
  const after37 = await catalog(r);
  assert.ok(after37.migrations.includes(V37_NAME));
  const added = (list, base, keyOf) => list.filter((x) => !base.some((y) => keyOf(y) === keyOf(x)));
  assert.deepEqual(after37.tables, before36.tables, "no table");
  assert.deepEqual(after37.columns, before36.columns, "no column");
  // The deferred constraint trigger is a constraint row of its own (contype t).
  assert.deepEqual(added(after37.constraints, before36.constraints, (x) => `${x.rel}.${x.conname}`).map((x) => [x.conname, x.contype]), [["source_metric_revisions_v37_audit_link", "t"]]);
  assert.deepEqual(before36.constraints, after37.constraints.filter((x) => x.conname !== "source_metric_revisions_v37_audit_link"), "no existing constraint changed");
  const V37_INDEXES = ["source_metric_audit_v37_revision_idx", "source_metric_audit_v37_verification_once"];
  assert.deepEqual(added(after37.indexes, before36.indexes, (x) => x.indexname).map((x) => x.indexname).sort(), V37_INDEXES);
  assert.match(after37.indexes.find((x) => x.indexname === "source_metric_audit_v37_verification_once").indexdef, /^CREATE UNIQUE INDEX/);
  assert.deepEqual(before36.indexes, after37.indexes.filter((x) => !V37_INDEXES.includes(x.indexname)));
  assert.deepEqual(added(after37.functions, before36.functions, (x) => x.proname).map((x) => x.proname).sort(),
    ["source_metric_audit_revision_guard", "source_metric_revisions_actor_guard", "source_metric_revisions_audit_link"]);
  assert.deepEqual(before36.functions, after37.functions.filter((x) => !["source_metric_audit_revision_guard", "source_metric_revisions_actor_guard", "source_metric_revisions_audit_link"].includes(x.proname)), "no existing function changed (v34, v35 and v36 included)");
  const newTriggers = added(after37.triggers, before36.triggers, (x) => `${x.relname}.${x.tgname}`);
  assert.deepEqual(newTriggers.map((x) => `${x.relname}.${x.tgname}`).sort(), [
    "source_metric_audit.source_metric_audit_v37_revision_guard",
    "source_metric_definition_versions.source_metric_revisions_v37_actor_guard",
    "source_metric_definition_versions.source_metric_revisions_v37_audit_link",
  ]);
  for (const t of newTriggers) assert.equal(t.tgenabled, "O");
  assert.match(newTriggers.find((x) => x.tgname === "source_metric_revisions_v37_audit_link").def, /DEFERRABLE INITIALLY DEFERRED/);
  assert.deepEqual(before36.triggers, after37.triggers.filter((x) => !x.tgname.includes("_v37_")), "no existing trigger changed");
  // The v36 and v35 rollbacks refuse while v37 is recorded.
  assert.match((await runScript(r, V36_ROLLBACK_PATH))?.message ?? "", /^v36 rollback refused: later migrations are applied/);
  assert.match((await runScript(r, V35_ROLLBACK_PATH))?.message ?? "", /^v35 rollback refused: later migrations are applied/);
  // Refusals of the v37 rollback, each changing nothing.
  await r.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/202610151001_training_load_v38_test_only.sql', $1, 'test')`, ["0".repeat(64)]);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v37 rollback refused: later migrations are applied/);
  await r.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/202610151001_training_load_v38_test_only.sql'`);
  await r.query(`alter table training_load.source_metric_audit disable trigger source_metric_audit_v37_revision_guard`);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v37 rollback refused: a v37 trigger is disabled/);
  await r.query(`alter table training_load.source_metric_audit enable trigger source_metric_audit_v37_revision_guard`);
  await r.query(`alter trigger source_metric_revisions_v37_actor_guard on training_load.source_metric_definition_versions rename to v37_renamed`);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v37 rollback refused: the v37 triggers are not all present/);
  await r.query(`alter trigger v37_renamed on training_load.source_metric_definition_versions rename to source_metric_revisions_v37_actor_guard`);
  for (const index of V37_INDEXES) {
    await r.query(`alter index training_load.${index} rename to v37_renamed_idx`);
    assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v37 rollback refused: the v37 indexes are not all present/);
    await r.query(`alter index training_load.v37_renamed_idx rename to ${index}`);
  }
  assert.deepEqual(await catalog(r), after37, "every refusal changed nothing");
  // A clean rollback, then v37 again.
  assert.equal(await runScript(r, ROLLBACK_PATH), null);
  assert.deepEqual(await catalog(r), before36, "the rollback returns the identical v36 catalog");
  await applyV37(rdb.url);
  assert.deepEqual(await catalog(r), after37, "v37 applies again identically");
  // Once a verification exists the rollback refuses (C96).
  const by = (await one(r, `insert into public.users (email, full_name, display_name, is_active) values ($1,'pa','pa',true) returning id`, [`v37rb-${uid()}@test.local`])).id;
  await r.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [by]);
  const f = await fixtureOnV37(r, by);
  okTx(await tx(by, async (c) => {
    await unitAct(c, { revId: f.revId, by });
    await auditRow(c, { action: "source_metric_unit_verified", f, by, ref: UNIT_REF });
  }, r));
  const withAct = await catalog(r);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v37 rollback refused: source metric verifications exist/);
  assert.deepEqual(await catalog(r), withAct, "the refusal changed nothing");
});

test("2. the database guards: a T2b revision INSERT or a state change without its lifecycle audit row is refused at COMMIT (v39), and no status or other column changes outside the two acts or together with one (23514); an act without the acting user, in another user's name, by a non-platform-admin or a revoked one is 42501; both acts in one update and a zone's meaning act with an operator other than between or >= are 23514; at COMMIT an act needs its audit row; an audit row must follow its own act (this transaction, its verifier, its reference), once; an action without a built chain is refused; a savepoint and an earlier transaction's setting fail closed; an event threshold's meaning is one-sided; the first evidence_ref is the completing act's own; one verification row per act, physically", async () => {
  const f = await fixture();
  const draft = await fixture({ state: "draft" });
  // No new revision and no state change without its lifecycle audit row (v39; the
  // lifecycle itself is tested in source-revision-lifecycle-v39.test.mjs).
  refusedWith(await tx(W.pa.id, (c) => c.query(`insert into training_load.source_metric_definition_versions (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill, evidence_status, created_by_user_id) values ($1,2,'number','none',true,true,'unproven',$2)`, [f.fieldId, W.pa.id])), "23514", NO_CREATE_ROW);
  refusedWith(await tx(W.pa.id, (c) => c.query(`update training_load.source_metric_definition_versions set state = 'active', activated_by_user_id = $2, activated_at = now() where id = $1`, [draft.revId, W.pa.id])), "23514", NO_STATE_ROW);
  refusedWith(await tx(W.pa.id, (c) => c.query(`update training_load.source_metric_definition_versions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'x' where id = $1`, [f.revId, W.pa.id])), "23514", NO_STATE_ROW);
  // No other update - with or without an acting user.
  refusedWith(await tx(null, (c) => c.query(`update training_load.source_metric_definition_versions set state = state where id = $1`, [f.revId])), "23514", ONE_ACT);
  // Both acts in one update.
  refusedWith(await tx(W.pa.id, (c) => c.query(
    `update training_load.source_metric_definition_versions set source_unit = 's', unit_verified_by_user_id = $2, unit_verified_at = now(), unit_evidence_ref = $3,
            meaning_verified_by_user_id = $2, meaning_verified_at = now(), meaning_evidence_ref = $3, evidence_status = 'verified' where id = $1`, [f.revId, W.pa.id, UNIT_REF])), "23514", ONE_ACT);
  // An act together with a state change (v34's own guard refuses it before v37's), or with a status
  // that is not verified (C90, C92).
  refusedWith(await tx(W.pa.id, (c) => c.query(
    `update training_load.source_metric_definition_versions set source_unit = 's', unit_verified_by_user_id = $2, unit_verified_at = now(), unit_evidence_ref = $3,
            state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Test retirement' where id = $1`, [f.revId, W.pa.id, UNIT_REF])), "23514", /^source_metric_definition_versions: a verification is its own act, apart from a state change$/);
  const unproven = await fixture({ status: "unproven" });
  refusedWith(await tx(W.pa.id, (c) => c.query(
    `update training_load.source_metric_definition_versions set source_unit = 's', unit_verified_by_user_id = $2, unit_verified_at = now(), unit_evidence_ref = $3,
            evidence_status = 'observed', evidence_ref = $3 where id = $1`, [unproven.revId, W.pa.id, UNIT_REF])), "23514", ONE_ACT);
  // The acting user.
  refusedWith(await tx(null, (c) => unitAct(c, { revId: f.revId, by: W.pa.id })), "42501", NO_ACTOR);
  refusedWith(await tx(W.pa.id, (c) => unitAct(c, { revId: f.revId, by: W.pa2.id })), "42501", OTHER_USER);
  // A session that is no active platform admin, naming a platform admin (v34 passes the named user).
  refusedWith(await tx(W.caA.id, (c) => unitAct(c, { revId: f.revId, by: W.pa.id })), "42501", MAY_NOT);
  refusedWith(await tx(W.paRevoked.id, (c) => unitAct(c, { revId: f.revId, by: W.pa.id })), "42501", MAY_NOT);
  refusedWith(await tx(W.caA.id, (c) => meaningAct(c, { revId: f.revId, by: W.pa.id })), "42501", MAY_NOT);
  // Naming itself, v34's own identity check refuses first.
  refusedWith(await tx(W.caA.id, (c) => unitAct(c, { revId: f.revId, by: W.caA.id })), "42501", /not an active platform admin/);
  refusedWith(await tx(W.pa.id, (c) => meaningAct(c, { revId: f.revId, by: W.pa2.id })), "42501", OTHER_USER);
  const lastXid = okTx(await tx(null, async (c) => (await one(c, `select pg_current_xact_id()::text as x`)).x));
  await k.query(`select set_config('optimove.source_metric_actor', $1, false)`, [`${W.pa.id}:${lastXid}`]);
  refusedWith(await tx(null, (c) => unitAct(c, { revId: f.revId, by: W.pa.id })), "42501", NO_ACTOR);
  await k.query(`reset optimove.source_metric_actor`);
  // A zone's meaning act takes between or >= only (v42, C103); no operator is refused too.
  const zone = await fixture({ kind: "zone_bounds" });
  for (const operator of [">", "<=", "<", null]) refusedWith(await tx(W.pa.id, (c) => meaningAct(c, { revId: zone.revId, by: W.pa.id, operator })), "23514", ZONE);
  // An event threshold's meaning takes a one-sided operator only.
  const ev = await fixture({ kind: "event_threshold" });
  refusedWith(await tx(W.pa.id, (c) => meaningAct(c, { revId: ev.revId, by: W.pa.id, operator: "between" })), "23514", EVENT_OP);
  // At COMMIT: an act without its audit row rolls the whole transaction back.
  refusedWith(await tx(W.pa.id, (c) => unitAct(c, { revId: f.revId, by: W.pa.id })), "23514", LINK_UNIT);
  refusedWith(await tx(W.pa.id, (c) => meaningAct(c, { revId: f.revId, by: W.pa.id })), "23514", LINK_MEANING);
  assert.equal((await revisionRow(f)).unit_verified_at, null, "nothing written");
  // The audit row must follow its own act.
  refusedWith(await tx(W.pa.id, async (c) => {
    await unitAct(c, { revId: f.revId, by: W.pa.id, ref: UNIT_REF });
    await auditRow(c, { action: "source_metric_unit_verified", f, by: W.pa.id, ref: COMPAT });
  }), "23514", FOLLOW);
  refusedWith(await tx(W.pa.id, (c) => auditRow(c, { action: "source_metric_unit_verified", f, by: W.pa.id, ref: UNIT_REF })), "23514", FOLLOW);
  refusedWith(await tx(W.pa.id, async (c) => {
    await unitAct(c, { revId: f.revId, by: W.pa.id });
    await auditRow(c, { action: "source_metric_meaning_verified", f, by: W.pa.id, ref: UNIT_REF });
  }), "23514", FOLLOW);
  refusedWith(await tx(W.pa.id, async (c) => {
    await unitAct(c, { revId: f.revId, by: W.pa.id });
    await auditRow(c, { action: "source_metric_unit_verified", f, by: W.pa.id, ref: UNIT_REF });
    await auditRow(c, { action: "source_metric_unit_verified", f, by: W.pa.id, ref: UNIT_REF });
  }), "23514", ONCE);
  // Its verifier and its reference: an acting user switched inside the transaction, or another reference.
  refusedWith(await tx(W.pa.id, async (c) => {
    await unitAct(c, { revId: f.revId, by: W.pa.id });
    await c.query(CTX, [W.pa2.id]);
    await auditRow(c, { action: "source_metric_unit_verified", f, by: W.pa2.id, ref: UNIT_REF });
  }), "23514", FOLLOW);
  refusedWith(await tx(W.pa.id, async (c) => {
    await meaningAct(c, { revId: f.revId, by: W.pa.id });
    await c.query(CTX, [W.pa2.id]);
    await auditRow(c, { action: "source_metric_meaning_verified", f, by: W.pa2.id, ref: MEANING_REF });
  }), "23514", FOLLOW);
  refusedWith(await tx(W.pa.id, async (c) => {
    await meaningAct(c, { revId: f.revId, by: W.pa.id, ref: MEANING_REF });
    await auditRow(c, { action: "source_metric_meaning_verified", f, by: W.pa.id, ref: COMPAT });
  }), "23514", FOLLOW);
  // A savepoint fails closed (the revision carries the subtransaction's id).
  refusedWith(await tx(W.pa.id, async (c) => {
    await c.query("savepoint s");
    await unitAct(c, { revId: f.revId, by: W.pa.id });
    await c.query("release savepoint s");
    await auditRow(c, { action: "source_metric_unit_verified", f, by: W.pa.id, ref: UNIT_REF });
  }), "23514", FOLLOW);
  // The legitimate act and its audit row.
  okTx(await tx(W.pa.id, async (c) => {
    await unitAct(c, { revId: f.revId, by: W.pa.id });
    await auditRow(c, { action: "source_metric_unit_verified", f, by: W.pa.id, ref: UNIT_REF });
  }));
  // The status only to verified, only by the completing act (v34 CHECK + v37).
  refusedWith(await tx(W.pa.id, async (c) => {
    await meaningAct(c, { revId: f.revId, by: W.pa.id, status: "observed" });
    await auditRow(c, { action: "source_metric_meaning_verified", f, by: W.pa.id, ref: MEANING_REF });
  }), "23514", /verified_iff_proven|violates check constraint/);
  okTx(await tx(W.pa.id, async (c) => {
    await meaningAct(c, { revId: f.revId, by: W.pa.id, status: "verified" });
    await auditRow(c, { action: "source_metric_meaning_verified", f, by: W.pa.id, ref: MEANING_REF });
  }));
  assert.equal((await revisionRow(f)).evidence_status, "verified");
  // "Once" is physical too: with the guard off, the unique index refuses a second verification row.
  refusedWith(await tx(W.pa.id, async (c) => {
    await c.query(`alter table training_load.source_metric_audit disable trigger source_metric_audit_v37_revision_guard`);
    await auditRow(c, { action: "source_metric_unit_verified", f, by: W.pa.id, ref: UNIT_REF });
  }), "23505", /source_metric_audit_v37_verification_once/);
  // The first evidence_ref of an unproven revision is the completing act's own reference (C92).
  const late = await fixture({ status: "unproven" });
  okTx(await tx(W.pa.id, async (c) => {
    await meaningAct(c, { revId: late.revId, by: W.pa.id });
    await auditRow(c, { action: "source_metric_meaning_verified", f: late, by: W.pa.id, ref: MEANING_REF });
  }));
  const completing = (ref) => tx(W.pa.id, async (c) => {
    await c.query(
      `update training_load.source_metric_definition_versions set source_unit = 's', unit_verified_by_user_id = $2, unit_verified_at = now(), unit_evidence_ref = $3,
              evidence_status = 'verified', evidence_ref = $4 where id = $1`, [late.revId, W.pa.id, UNIT_REF, ref]);
    await auditRow(c, { action: "source_metric_unit_verified", f: late, by: W.pa.id, ref: UNIT_REF });
  });
  refusedWith(await completing(COMPAT), "23514", FIRST_REF);
  okTx(await completing(UNIT_REF));
  assert.deepEqual([(await revisionRow(late)).evidence_status, (await revisionRow(late)).evidence_ref], ["verified", UNIT_REF]);
  // An action whose chain is not built is refused, even by a platform admin.
  const conv = (await one(k, `select id from training_load.unit_conversions limit 1`)).id;
  refusedWith(await tx(W.pa.id, (c) => c.query(`insert into training_load.source_metric_audit (action, source_metric_definition_id, performed_by_user_id, basis, operation_id, from_status, to_status) values ('source_metric_create',$1,$2,'platform_admin',$3,null,'active')`, [f.fieldId, W.pa.id, crypto.randomUUID()])), "23514", NO_WRITER);
  // A lifecycle row has its chain since v39: without its own change it is refused.
  refusedWith(await tx(W.pa.id, (c) => c.query(`insert into training_load.source_metric_audit (action, source_metric_definition_id, source_metric_version_id, performed_by_user_id, basis, operation_id, from_status, to_status) values ('source_metric_revision_activate',$1,$2,$3,'platform_admin',$4,'draft','active')`, [draft.fieldId, draft.revId, W.pa.id, crypto.randomUUID()])), "23514", LIFECYCLE_FOLLOW);
  refusedWith(await tx(W.pa.id, (c) => c.query(`insert into training_load.source_metric_audit (action, unit_conversion_id, evidence_ref, performed_by_user_id, basis, operation_id, from_status, to_status) values ('unit_conversion_create',$1,$2,$3,'platform_admin',$4,null,'active')`, [conv, COMPAT, W.pa.id, crypto.randomUUID()])), "23514", NO_WRITER);
});

test("3. who may call: no session is 401; a coach, an athlete, a platform admin in a team workspace, a revoked club role, an archived club and a revoked platform admin get the same 404 on every field route; a club admin and a platform admin in a club workspace read the field (as /fields) but get the same 404 on both acts, before the body is looked at; an unknown field, a malformed id and a revision of another field are the same 404; a zone's meaning act never tells such a caller that the zone exists", async () => {
  const f = await fixture();
  const other = await fixture();
  for (const p of [`/fields/${f.fieldId}`]) assert.equal((await api(p)).status, 401);
  for (const p of [unitPath(f), meaningPath(f)]) assert.equal((await post(p, null, unitBody())).status, 401);
  for (const who of [W.coach, W.athlete, W.paTeam, W.caRevoked, W.caC, W.paRevoked]) {
    const read = await api(`/fields/${f.fieldId}`, { cookie: who.cookie });
    assert.deepEqual([read.status, read.body], [404, { error: "notFound" }]);
    assert.equal(read.headers.get("cache-control"), "no-store");
    for (const p of [unitPath(f), meaningPath(f)]) assert.deepEqual((await post(p, who.cookie, unitBody())).body, { error: "notFound" });
  }
  for (const who of [W.caA, W.paA]) {
    const read = await api(`/fields/${f.fieldId}`, { cookie: who.cookie });
    assert.equal(read.status, 200, read.text);
    assert.equal(read.body.field.id, f.fieldId);
    for (const p of [unitPath(f), meaningPath(f)]) {
      assert.deepEqual((await post(p, who.cookie, unitBody())).body, { error: "notFound" });
      const notJson = await api(p, { method: "POST", cookie: who.cookie, body: "x=1", contentType: "application/x-www-form-urlencoded" });
      assert.deepEqual([notJson.status, notJson.body], [404, { error: "notFound" }], "no 415 for a caller who may not verify");
    }
  }
  for (const p of [`/fields/${crypto.randomUUID()}`, "/fields/not-a-uuid"]) assert.deepEqual((await api(p, { cookie: W.pa.cookie })).body, { error: "notFound" });
  for (const p of [
    `/fields/${f.fieldId}/revisions/${other.revId}/unit-verification`, `/fields/${crypto.randomUUID()}/revisions/${f.revId}/unit-verification`,
    `/fields/not-a-uuid/revisions/${f.revId}/meaning-verification`, `/fields/${f.fieldId}/revisions/not-a-uuid/unit-verification`,
  ]) assert.deepEqual((await post(p, W.pa.cookie, unitBody())).body, { error: "notFound" }, p);
  assert.equal((await auditCount(f)) + (await auditCount(other)), 0, "nothing written");
  const pa = await api(`/fields/${f.fieldId}`, { cookie: W.pa.cookie });
  assert.equal(pa.status, 200);
  assert.equal((await api(`/fields/${f.fieldId}?x=1`, { cookie: W.pa.cookie })).body.error, "invalid_query");
  // A zone never tells a caller who may not verify that it exists: the identical 404, never its 400.
  const zone = await fixture({ kind: "zone_bounds" });
  for (const who of [W.coach, W.athlete, W.paTeam, W.caRevoked, W.caC, W.paRevoked, W.caA, W.paA]) {
    const res = await post(meaningPath(zone), who.cookie, meaningBody({ boundOperator: "==" }));
    assert.deepEqual([res.status, res.body], [404, { error: "notFound" }]);
  }
  assert.equal((await post(meaningPath(zone), W.pa.cookie, meaningBody({ boundOperator: "==" }))).body.error, "invalid_operator");
});

test("4. the body: a JSON object only; an unknown or a server-derived field (actor, basis, status, time, state) is invalid_body; the requestKey is a UUID; the unit is a token (invalid_unit, the JavaScript rule agreeing with the database's); the evidence reference is a docs/ path with one anchor (invalid_evidence_ref, agreeing with the database's); the operator is one of the closed set, and one-sided for an event threshold; a bound unit exactly for a bound, an operator exactly for an event threshold; nothing is written", async () => {
  const f = await fixture();
  const ev = await fixture({ kind: "event_threshold" });
  const bad = async (p, body, code) => {
    const res = await post(p, W.pa.cookie, body);
    assert.deepEqual([res.status, res.body.error], [400, code], `${JSON.stringify(body)}: ${res.text}`);
  };
  for (const field of ["verifiedByUserId", "basis", "evidenceStatus", "unitVerifiedAt", "state", "boundOperator", "extra"]) await bad(unitPath(f), unitBody({ [field]: "x" }), "invalid_body");
  for (const field of ["verifiedByUserId", "basis", "evidenceStatus", "sourceUnit", "extra"]) await bad(meaningPath(f), meaningBody({ [field]: "x" }), "invalid_body");
  for (const missing of ["requestKey", "sourceUnit", "evidenceRef"]) {
    const body = unitBody();
    delete body[missing];
    await bad(unitPath(f), body, "invalid_body");
  }
  await bad(unitPath(f), unitBody({ requestKey: "not-a-uuid" }), "invalid_body");
  for (const unit of ["", "m s", "a|b", "a=b", "x".repeat(31), `m${String.fromCodePoint(0xa0)}`, `m${String.fromCodePoint(0x200b)}`, `m${String.fromCodePoint(0x3164)}`, String.fromCodePoint(0x2800), `km${String.fromCodePoint(0xe0020)}`, 5]) await bad(unitPath(f), unitBody({ sourceUnit: unit }), "invalid_unit");
  await bad(unitPath(ev), unitBody({ sourceUnit: "count", sourceBoundUnit: "m s" }), "invalid_unit");
  const badRefs = ["https://example.com/a#b", "docs/a.md", "docs/a.md#", "/docs/a.md#x", "docs/../a.md#x", "docs//a.md#x", "src/a.md#x", "docs/a b.md#x", "docs/a.md#x#y", `docs/${"a".repeat(296)}#x`, 7];
  for (const ref of badRefs) await bad(unitPath(f), unitBody({ evidenceRef: ref }), "invalid_evidence_ref");
  for (const ref of badRefs) await bad(meaningPath(f), meaningBody({ evidenceRef: ref }), "invalid_evidence_ref");
  for (const op of ["==", "BETWEEN", "", 3, "between"]) await bad(meaningPath(ev), meaningBody({ boundOperator: op }), "invalid_operator");
  // A malformed operator is invalid_operator before whether the revision takes one at all.
  for (const op of ["==", 3]) await bad(meaningPath(f), meaningBody({ boundOperator: op }), "invalid_operator");
  await bad(unitPath(ev), unitBody({ sourceUnit: "count" }), "bound_unit_required");
  await bad(unitPath(f), unitBody({ sourceBoundUnit: "m/s" }), "bound_unit_not_allowed");
  await bad(meaningPath(ev), meaningBody(), "operator_required");
  await bad(meaningPath(f), meaningBody({ boundOperator: ">=" }), "operator_not_allowed");
  const notJson = await api(unitPath(f), { method: "POST", cookie: W.pa.cookie, body: "x=1", contentType: "application/x-www-form-urlencoded" });
  assert.deepEqual([notJson.status, notJson.body.error], [415, "jsonRequired"]);
  assert.equal((await auditCount(f)) + (await auditCount(ev)), 0, "nothing written");
  assert.equal((await revisionRow(f)).unit_verified_at, null);
  // The JavaScript twins agree with the database functions.
  const refs = [UNIT_REF, MEANING_REF, COMPAT, "docs/a#b", "docs/a.b.c/d_e-f.md#Anchor_1", ...badRefs.filter((x) => typeof x === "string"), `docs/${"a".repeat(293)}#x`, `docs/${"a".repeat(294)}#x`];
  assert.equal(fieldsService.evidenceRefOk(`docs/${"a".repeat(293)}#x`), true, "300 characters pass");
  for (const ref of refs) {
    const dbOk = (await one(k, `select training_load.source_metric_evidence_ref_ok($1) as ok`, [ref])).ok === true;
    assert.equal(fieldsService.evidenceRefOk(ref), dbOk, `evidenceRef parity: ${ref}`);
  }
});

test("5. the two acts on a field without a bound: the unit act (201) writes the unit, the time and the reference with the acting user and one audit row, the status unchanged; the meaning act (201) completes the proof and the server raises the status to verified; the field detail shows both acts with their references; no answer names the verifier", async () => {
  const f = await fixture();
  const u = await post(unitPath(f), W.pa.cookie, unitBody({ sourceUnit: "s" }));
  assert.equal(u.status, 201, u.text);
  assert.deepEqual([u.body.replayed, u.body.revision.id, u.body.revision.fieldId, u.body.revision.sourceUnit, u.body.revision.unitEvidenceRef, u.body.revision.evidenceStatus],
    [false, f.revId, f.fieldId, "s", UNIT_REF, "observed"]);
  assert.ok(u.body.revision.unitVerifiedAt);
  const row = await revisionRow(f);
  assert.deepEqual([row.unit_verified_by_user_id, row.source_unit, row.unit_evidence_ref, row.meaning_verified_at], [W.pa.id, "s", UNIT_REF, null]);
  const a1 = await one(k, `select * from training_load.source_metric_audit where source_metric_version_id = $1 and action = 'source_metric_unit_verified'`, [f.revId]);
  assert.deepEqual([a1.performed_by_user_id, a1.basis, a1.evidence_ref, a1.source_metric_definition_id, a1.request_hash.length], [W.pa.id, "platform_admin", UNIT_REF, f.fieldId, 64]);
  const m = await post(meaningPath(f), W.pa.cookie, meaningBody());
  assert.equal(m.status, 201, m.text);
  assert.deepEqual([m.body.revision.evidenceStatus, m.body.revision.meaningEvidenceRef, m.body.revision.boundOperator], ["verified", MEANING_REF, null]);
  assert.equal((await revisionRow(f)).meaning_verified_by_user_id, W.pa.id);
  assert.equal(await auditCount(f), 2);
  const detail = await api(`/fields/${f.fieldId}`, { cookie: W.caA.cookie });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.verifications.map((v) => [v.revisionId, v.act, v.evidenceRef]), [[f.revId, "unit", UNIT_REF], [f.revId, "meaning", MEANING_REF]]);
  assert.equal(detail.body.field.revisions[0].evidenceStatus, "verified");
  for (const text of [u.text, m.text, detail.text]) assert.ok(!text.includes(W.pa.id), "no answer names the verifier");
  // The other order: meaning first, then the unit completes the proof.
  const g = await fixture();
  assert.equal((await post(meaningPath(g), W.pa.cookie, meaningBody())).body.revision.evidenceStatus, "observed");
  assert.equal((await post(unitPath(g), W.pa.cookie, unitBody({ sourceUnit: "m" }))).body.revision.evidenceStatus, "verified");
  // /fields shows the same facts.
  const list = await api(`/fields?sourceSystem=gpexe&apiFamily=rest_v1`, { cookie: W.pa.cookie });
  const listed = list.body.fields.find((x) => x.id === g.fieldId);
  assert.deepEqual([listed.revisions[0].sourceUnit, listed.revisions[0].evidenceStatus], ["m", "verified"]);
});

test("6. an event threshold: the unit act needs the bound unit with it; the meaning act needs the operator with it; neither alone verifies the revision; after both the revision is verified with the proven bound unit and operator", async () => {
  const ev = await fixture({ kind: "event_threshold" });
  const u = await post(unitPath(ev), W.pa.cookie, unitBody({ sourceUnit: "count", sourceBoundUnit: "m/s2" }));
  assert.equal(u.status, 201, u.text);
  assert.deepEqual([u.body.revision.sourceUnit, u.body.revision.sourceBoundUnit, u.body.revision.evidenceStatus], ["count", "m/s2", "observed"]);
  const m = await post(meaningPath(ev), W.pa.cookie, meaningBody({ boundOperator: ">=" }));
  assert.equal(m.status, 201, m.text);
  assert.deepEqual([m.body.revision.boundOperator, m.body.revision.evidenceStatus], [">=", "verified"]);
  // Meaning first: the operator with it, no status until the unit (with its bound unit) is proven.
  const dec = await fixture({ kind: "event_threshold" });
  assert.deepEqual((await post(meaningPath(dec), W.pa.cookie, meaningBody({ boundOperator: "<=" }))).body.revision.evidenceStatus, "observed");
  assert.equal((await post(unitPath(dec), W.pa.cookie, unitBody({ sourceUnit: "count" }))).body.error, "bound_unit_required");
  assert.equal((await post(unitPath(dec), W.pa.cookie, unitBody({ sourceUnit: "count", sourceBoundUnit: "m/s2" }))).body.revision.evidenceStatus, "verified");
});

test("7. a zone (v42, C102, C103; C89 lifted): the unit act with its bound unit passes with a valid reference; the meaning act needs the operator of the zone's shape - between or >= (400 operator_required without one, 400 invalid_operator for >, <=, < and any other value, each with the zone's text, nothing written); after both acts the zone is verified with its operator", async () => {
  const zone = await fixture({ kind: "zone_bounds" });
  assert.equal((await post(unitPath(zone), W.pa.cookie, unitBody({ sourceUnit: "m", evidenceRef: "not a ref" }))).body.error, "invalid_evidence_ref");
  const u = await post(unitPath(zone), W.pa.cookie, unitBody({ sourceUnit: "m", sourceBoundUnit: "W/kg" }));
  assert.equal(u.status, 201, u.text);
  assert.deepEqual([u.body.revision.sourceUnit, u.body.revision.sourceBoundUnit, u.body.revision.evidenceStatus], ["m", "W/kg", "observed"]);
  for (const [body, code] of [[meaningBody(), "operator_required"], [meaningBody({ boundOperator: ">" }), "invalid_operator"],
    [meaningBody({ boundOperator: "<=" }), "invalid_operator"], [meaningBody({ boundOperator: "<" }), "invalid_operator"],
    [meaningBody({ boundOperator: "==" }), "invalid_operator"], [meaningBody({ boundOperator: 3 }), "invalid_operator"],
    [meaningBody({ boundOperator: "between", evidenceRef: "not a ref" }), "invalid_evidence_ref"]]) {
    const res = await post(meaningPath(zone), W.pa.cookie, body);
    assert.deepEqual([res.status, res.body.error], [400, code], res.text);
    if (code !== "invalid_evidence_ref") assert.match(res.body.message, /zone/, "the zone's own text");
  }
  let row = await revisionRow(zone);
  assert.deepEqual([row.meaning_verified_at, row.bound_operator, row.evidence_status], [null, null, "observed"]);
  assert.equal(await auditCount(zone), 1, "only the unit act");
  const m = await post(meaningPath(zone), W.pa.cookie, meaningBody({ boundOperator: "between" }));
  assert.equal(m.status, 201, m.text);
  assert.deepEqual([m.body.revision.boundOperator, m.body.revision.evidenceStatus], ["between", "verified"]);
  row = await revisionRow(zone);
  assert.deepEqual([row.bound_operator, row.meaning_verified_by_user_id, row.evidence_status], ["between", W.pa.id, "verified"]);
  assert.equal(await auditCount(zone), 2, "one audit row per act");
  // Meaning first, with >=: no status until the unit (with its bound unit) is proven.
  const zone2 = await fixture({ kind: "zone_bounds" });
  const m2 = await post(meaningPath(zone2), W.pa.cookie, meaningBody({ boundOperator: ">=" }));
  assert.deepEqual([m2.status, m2.body.revision.boundOperator, m2.body.revision.evidenceStatus], [201, ">=", "observed"]);
  assert.equal((await post(unitPath(zone2), W.pa.cookie, unitBody({ sourceUnit: "m", sourceBoundUnit: "m/s" }))).body.revision.evidenceStatus, "verified");
});

test("8. state: a second act of the same kind is 409 *_already_verified with the current proof (a correction is a new revision); a retired revision is 409 revision_retired; a draft revision takes both acts; an unproven revision rises straight to verified with the completing act's reference", async () => {
  const f = await fixture();
  assert.equal((await post(unitPath(f), W.pa.cookie, unitBody({ sourceUnit: "s" }))).status, 201);
  const again = await post(unitPath(f), W.pa2.cookie, unitBody({ sourceUnit: "min" }));
  assert.deepEqual([again.status, again.body.error, again.body.current?.sourceUnit, again.body.current?.unitEvidenceRef], [409, "unit_already_verified", "s", UNIT_REF]);
  assert.equal((await post(meaningPath(f), W.pa.cookie, meaningBody())).status, 201);
  const meaningAgain = await post(meaningPath(f), W.pa.cookie, meaningBody({ evidenceRef: COMPAT }));
  assert.deepEqual([meaningAgain.status, meaningAgain.body.error, meaningAgain.body.current?.meaningEvidenceRef], [409, "meaning_already_verified", MEANING_REF]);
  const retired = await fixture({ state: "retired" });
  for (const [p, body] of [[unitPath(retired), unitBody()], [meaningPath(retired), meaningBody()]]) {
    assert.deepEqual((await post(p, W.pa.cookie, body)).body.error, "revision_retired");
  }
  const draft = await fixture({ state: "draft", status: "unproven" });
  const du = await post(unitPath(draft), W.pa.cookie, unitBody({ sourceUnit: "s" }));
  assert.deepEqual([du.status, du.body.revision.evidenceStatus, du.body.revision.evidenceRef], [201, "unproven", null]);
  const dm = await post(meaningPath(draft), W.pa.cookie, meaningBody());
  assert.deepEqual([dm.status, dm.body.revision.evidenceStatus, dm.body.revision.evidenceRef, dm.body.revision.state], [201, "verified", MEANING_REF, "draft"]);
  // The other order: the unit completes the proof and its reference becomes the first evidence_ref.
  const late = await fixture({ status: "unproven" });
  const lm = await post(meaningPath(late), W.pa.cookie, meaningBody());
  assert.deepEqual([lm.status, lm.body.revision.evidenceStatus, lm.body.revision.evidenceRef], [201, "unproven", null]);
  const lu = await post(unitPath(late), W.pa.cookie, unitBody({ sourceUnit: "s" }));
  assert.deepEqual([lu.status, lu.body.revision.evidenceStatus, lu.body.revision.evidenceRef], [201, "verified", UNIT_REF]);
});

test("9. idempotency: the same key and body replays the current state (200, replayed, no second audit row); the same key with another body or another act is request_key_reused; a key of an M2 write is request_key_reused here; a replay checks the right again - from a club workspace or after the role is revoked it is the identical 404", async () => {
  const f = await fixture();
  const body = unitBody({ sourceUnit: "s" });
  const first = await post(unitPath(f), W.pa.cookie, body);
  assert.equal(first.status, 201);
  const replay = await post(unitPath(f), W.pa.cookie, body);
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.revision.sourceUnit], [200, true, "s"]);
  assert.equal(await auditCount(f), 1);
  assert.deepEqual((await post(unitPath(f), W.pa.cookie, { ...body, sourceUnit: "min" })).body.error, "request_key_reused");
  assert.deepEqual((await post(meaningPath(f), W.pa.cookie, { requestKey: body.requestKey, evidenceRef: MEANING_REF })).body.error, "request_key_reused");
  // The meaning act's key is bound to its body too.
  const mk = key();
  assert.equal((await post(meaningPath(f), W.pa.cookie, meaningBody({ requestKey: mk }))).status, 201);
  assert.deepEqual((await post(meaningPath(f), W.pa.cookie, meaningBody({ requestKey: mk, evidenceRef: COMPAT }))).body.error, "request_key_reused");
  // A key the M2 API used for a mapping.
  const variable = await post("/variables", W.pa.cookie, { requestKey: key(), label: `Time ${uid()}`, unit: "s", levels: ["session"], dailyAggregationMethod: "sum" });
  assert.equal(variable.status, 201, variable.text);
  const mappingKey = key();
  assert.equal((await post("/mappings", W.pa.cookie, { requestKey: mappingKey, sourceMetricId: f.fieldId, metricDefinitionId: variable.body.variable.id })).status, 201);
  const g = await fixture();
  assert.deepEqual((await post(unitPath(g), W.pa.cookie, unitBody({ requestKey: mappingKey }))).body.error, "request_key_reused");
  // The replay and the right.
  const mover = await platformAdmin();
  const mb = unitBody({ sourceUnit: "m" });
  assert.equal((await post(unitPath(g), mover.cookie, mb)).status, 201);
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [mover.id, W.clubA]);
  await workspace(mover.id, "club", W.clubA);
  assert.deepEqual((await post(unitPath(g), mover.cookie, mb)).body, { error: "notFound" }, "a club workspace never replays a verification");
  await workspace(mover.id, "platform", null);
  assert.equal((await post(unitPath(g), mover.cookie, mb)).status, 200);
  await k.query(`update public.user_global_roles set is_active = false where user_id = $1`, [mover.id]);
  assert.deepEqual((await post(unitPath(g), mover.cookie, mb)).body, { error: "notFound" });
});

test("10. concurrency: two platform admins confirming the same unit serialize on the revision - one 201, the other 409 unit_already_verified with the winner's proof; the same user's same key twice at once writes once and the second replays", async () => {
  const f = await fixture();
  const g = gate();
  let held = false;
  fieldsService.setFieldWriteHoldForTests(async () => { if (held) return; held = true; await g.promise; });
  const firstP = post(unitPath(f), W.pa.cookie, unitBody({ sourceUnit: "s" }));
  await until(() => held, "the first act holds the revision");
  const secondP = post(unitPath(f), W.pa2.cookie, unitBody({ sourceUnit: "min" }));
  assert.ok(await someoneWaits(), "the second act waits on the revision's lock");
  g.open();
  const [first, second] = await Promise.all([firstP, secondP]);
  assert.equal(first.status, 201, first.text);
  assert.deepEqual([second.status, second.body.error, second.body.current?.sourceUnit], [409, "unit_already_verified", "s"]);
  assert.equal(await auditCount(f), 1);
  // The same key twice at once.
  const h = await fixture();
  const g2 = gate();
  let held2 = false;
  fieldsService.setFieldWriteHoldForTests(async () => { if (held2) return; held2 = true; await g2.promise; });
  const body = unitBody({ sourceUnit: "s" });
  const aP = post(unitPath(h), W.pa.cookie, body);
  await until(() => held2, "the first request holds its write");
  const bP = post(unitPath(h), W.pa.cookie, body);
  assert.ok(await someoneWaits(), "the second request waits on the user's lock");
  g2.open();
  const [a, b] = await Promise.all([aP, bP]);
  assert.deepEqual([a.status, b.status, b.body.replayed], [201, 200, true]);
  assert.equal(await auditCount(h), 1);
});

test("11. the COMMIT: a lost answer after a real COMMIT is verified by the request record (200, verified_after_commit_error, written once); after a real rollback it is 503 outcome_unknown and the same key then writes once; a deadlock is try_again with Retry-After; a read that fails after the COMMIT keeps 201 with readError and the ids", async () => {
  const dbError = ({ severity, code, routine }) => {
    const e = new pg.DatabaseError("injected COMMIT answer", 0, "error");
    e.severity = severity;
    e.code = code;
    if (routine) e.routine = routine;
    return e;
  };
  const f = await fixture();
  service.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw dbError({ severity: "FATAL", code: "57P01", routine: "ProcessInterrupts" }); }), timeoutMs: 2_000 });
  const okRes = await post(unitPath(f), W.pa.cookie, unitBody());
  service.setMappingCommitForTests();
  assert.deepEqual([okRes.status, okRes.body.commitConfirmation, okRes.body.revision?.sourceUnit], [200, "verified_after_commit_error", "s"]);
  assert.equal(await auditCount(f), 1);
  const g = await fixture();
  const rolled = unitBody();
  service.setMappingCommitForTests({ fault: (client) => client.query("rollback").then(() => { throw dbError({ severity: "FATAL", code: "57P01", routine: "ProcessInterrupts" }); }), timeoutMs: 2_000 });
  const unknown = await post(unitPath(g), W.pa.cookie, rolled);
  service.setMappingCommitForTests();
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.requestKey], [503, "outcome_unknown", rolled.requestKey]);
  assert.equal(await auditCount(g), 0);
  assert.equal((await post(unitPath(g), W.pa.cookie, rolled)).status, 201);
  assert.equal(await auditCount(g), 1);
  const h = await fixture();
  service.setMappingCommitForTests({ fault: (client) => client.query("rollback").then(() => { throw dbError({ severity: "ERROR", code: "40P01", routine: "DeadLockReport" }); }), timeoutMs: 2_000 });
  const dl = await post(meaningPath(h), W.pa.cookie, meaningBody());
  service.setMappingCommitForTests();
  assert.deepEqual([dl.status, dl.body.error, dl.headers.get("retry-after")], [409, "try_again", "5"]);
  assert.equal(await auditCount(h), 0);
  service.setMappingRereadFaultForTests(async () => { throw new Error("injected read failure"); });
  const re = await post(meaningPath(h), W.pa.cookie, meaningBody());
  service.setMappingRereadFaultForTests(null);
  assert.deepEqual([re.status, re.body.readError, re.body.fieldId, re.body.revisionId, re.body.revision], [201, true, h.fieldId, h.revId, undefined]);
});

test("12. with M2: a mapping version of a field whose unit is not proven is 409 unit_not_proven; after the unit act the same version is created (201); an event threshold needs its meaning with its operator first (parameters_not_proven)", async () => {
  const f = await fixture();
  const variable = await post("/variables", W.pa.cookie, { requestKey: key(), label: `Total time ${uid()}`, unit: "s", levels: ["session", "drill"], dailyAggregationMethod: "sum" });
  assert.equal(variable.status, 201, variable.text);
  const mapping = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: variable.body.variable.id });
  assert.equal(mapping.status, 201, mapping.text);
  const versionBody = () => ({ requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true });
  assert.deepEqual((await post(`/mappings/${mapping.body.mapping.id}/versions`, W.pa.cookie, versionBody())).body.error, "unit_not_proven");
  assert.equal((await post(unitPath(f), W.pa.cookie, unitBody({ sourceUnit: "s" }))).status, 201);
  const created = await post(`/mappings/${mapping.body.mapping.id}/versions`, W.pa.cookie, versionBody());
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.version.sourceUnit, "s");
  const ev = await fixture({ kind: "event_threshold" });
  const evMapping = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: ev.fieldId, metricDefinitionId: variable.body.variable.id });
  assert.equal((await post(unitPath(ev), W.pa.cookie, unitBody({ sourceUnit: "count", sourceBoundUnit: "m/s2" }))).status, 201);
  assert.deepEqual((await post(`/mappings/${evMapping.body.mapping.id}/versions`, W.pa.cookie, { requestKey: key(), sourceRevisionId: ev.revId, appliesToSession: true, appliesToDrill: true, sourceParameters: { thresholdValue: "2.5", durationSeconds: "0.3" } })).body.error, "parameters_not_proven");
});

test("13. the right is checked again under FOR SHARE inside the write: a platform admin whose role is revoked after the request began gets the identical 404 and nothing is written - the unit act and the meaning act alike", async () => {
  const lose = await platformAdmin();
  const f = await fixture();
  for (const [p, body] of [[unitPath(f), unitBody()], [meaningPath(f), meaningBody()]]) {
    service.setMappingRightsHoldForTests(async () => {
      await k.query(`update public.user_global_roles set is_active = false where user_id = $1`, [lose.id]);
    });
    const res = await post(p, lose.cookie, body);
    service.setMappingRightsHoldForTests(null);
    assert.deepEqual([res.status, res.body], [404, { error: "notFound" }]);
    await k.query(`update public.user_global_roles set is_active = true where user_id = $1`, [lose.id]);
  }
  const row = await revisionRow(f);
  assert.deepEqual([row.unit_verified_at, row.meaning_verified_at, await auditCount(f)], [null, null, 0], "nothing written");
});

test("14. an act and an M2 version create on the same revision serialize without a deadlock, in both orders: a version create holding the revision FOR SHARE makes the meaning act wait, then both succeed; a meaning act holding the revision FOR UPDATE makes the version create wait, then both succeed (the facts it compares under its lock are unchanged by a meaning act on a field without a bound)", async () => {
  const variable = await post("/variables", W.pa.cookie, { requestKey: key(), label: `Race ${uid()}`, unit: "s", levels: ["session"], dailyAggregationMethod: "sum" });
  assert.equal(variable.status, 201, variable.text);
  const ready = async () => {
    const f = await fixture();
    assert.equal((await post(unitPath(f), W.pa.cookie, unitBody({ sourceUnit: "s" }))).status, 201);
    const mapping = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: variable.body.variable.id });
    assert.equal(mapping.status, 201, mapping.text);
    return { f, versionsPath: `/mappings/${mapping.body.mapping.id}/versions`, versionBody: { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: false } };
  };
  // The version create first: it holds the revision FOR SHARE; the act (another user) waits on FOR UPDATE.
  const a = await ready();
  const g1 = gate();
  let held1 = false;
  service.setMappingWriteHoldForTests(async (_client, op) => { if (op !== "mapping_version_create" || held1) return; held1 = true; await g1.promise; });
  const versionP = post(a.versionsPath, W.pa.cookie, a.versionBody);
  await until(() => held1, "the version create holds the revision");
  const actP = post(meaningPath(a.f), W.pa2.cookie, meaningBody());
  assert.ok(await someoneWaits(), "the act waits on the revision's lock");
  g1.open();
  const [version, act] = await Promise.all([versionP, actP]);
  assert.deepEqual([version.status, act.status, act.body.revision?.evidenceStatus], [201, 201, "verified"], `${version.text} ${act.text}`);
  service.setMappingWriteHoldForTests(null);
  // The act first: it holds the revision FOR UPDATE; the version create (another user) waits on FOR SHARE.
  const b = await ready();
  const g2 = gate();
  let held2 = false;
  fieldsService.setFieldWriteHoldForTests(async () => { if (held2) return; held2 = true; await g2.promise; });
  const act2P = post(meaningPath(b.f), W.pa2.cookie, meaningBody());
  await until(() => held2, "the act holds the revision");
  const version2P = post(b.versionsPath, W.pa.cookie, b.versionBody);
  assert.ok(await someoneWaits(), "the version create waits on the revision's lock");
  g2.open();
  const [act2, version2] = await Promise.all([act2P, version2P]);
  assert.deepEqual([act2.status, version2.status], [201, 201], `${act2.text} ${version2.text}`);
  assert.equal((await one(k, `select count(*)::int as n from training_load.source_metric_audit where source_metric_version_id = $1 and action in ('source_metric_unit_verified', 'source_metric_meaning_verified')`, [b.f.revId])).n, 2, "the unit act and the meaning act, once each");
});

test("15. the acting user is set from the session and left on no pool client; no answer or log line carries SQL, a trigger's text or an acting user's id; the nine seeded rest_v1 revisions are untouched by this whole file", async () => {
  const f = await fixture();
  await post(unitPath(f), W.pa.cookie, unitBody());
  assert.equal((await revisionRow(f)).unit_verified_by_user_id, W.pa.id);
  const clients = [];
  try {
    for (let i = 0; i < Math.max(1, appPool.totalCount); i += 1) clients.push(await appPool.connect());
    for (const c of clients) assert.equal((await c.query(`select current_setting('optimove.source_metric_actor', true) as v`)).rows[0].v ?? "", "", "no setting left on a pool client");
  } finally {
    for (const c of clients) c.release();
  }
  for (const text of responses) {
    for (const needle of ["source_metric_definition_versions", "training_load.", "violates", "SQLSTATE", "source metric verification:", "source_metric_audit:", "duplicate key"]) {
      assert.ok(!text.includes(needle), `an answer carries ${needle}: ${text.slice(0, 200)}`);
    }
  }
  for (const l of logLines) for (const id of [W.pa.id, W.pa2.id]) assert.ok(!l.includes(id), "no log line carries an acting user's id");
  const seedAfter = await rows(k, `select * from training_load.source_metric_definition_versions where seed_migration like 'migrations_v2/202610121000%' order by id`);
  assert.equal(seedAfter.length, 9);
  assert.deepEqual(seedAfter, W.seedBefore, "the seeded revisions are untouched");
  for (const s of seedAfter) assert.deepEqual([s.source_unit, s.unit_verified_at, s.meaning_verified_at, s.evidence_status], [null, null, null, "observed"]);
});

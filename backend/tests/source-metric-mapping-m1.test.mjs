// v34 - M1, the schema foundation of the source-to-canonical metric mapping
// (docs/ai/gpexe-metric-variable-mapping-discovery.md, sections C-E, J/M1),
// on disposable optimove_tests_gpexe_* databases only (never OPTIMOVE): one
// database for the migration, its rollback and every rollback refusal, one for
// the behaviour of every table, trigger and constraint.
//
// M1_V34_SQL_PATH / M1_V34_ROLLBACK_PATH exist only for the mutation runner:
// they let it apply a mutated copy of the migration or the rollback without
// touching the files in the repository.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";
import { SOURCE_HOSTS } from "../src/sourceHosts.js";
import { undoImportedSession } from "../scripts/gpexe-undo-imported-session.mjs";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V34 = "202610121000_training_load_v34_source_metric_mapping.sql";
const V34_NAME = `migrations_v2/${V34}`;
const UP_TO_V33 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V34));
const MIGRATION_PATH = process.env.M1_V34_SQL_PATH || path.resolve(ROOT, "migrations_v2", V34);
const ROLLBACK_PATH = process.env.M1_V34_ROLLBACK_PATH || path.resolve(ROOT, "docs/runbooks/source-metric-mapping-v34-rollback.sql");
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const D5 = "docs/ai/gpexe-metric-variable-mapping-discovery.md#d5-unit-conversion-seed";
const T = (name) => `training_load.${name}`;

let rdb, mdb, r, k;
const triggerMessages = new Set();

async function applyV34(url) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-m1-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of UP_TO_V33) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    await fsp.copyFile(MIGRATION_PATH, path.join(dir, V34));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

before(async () => {
  // The M1 databases stop at v34 (applied by this suite); v35 and its actor
  // guards are proven by source-metric-mapping-v35.test.mjs.
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V34), "v34 is a test migration");
  [rdb, mdb] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "m1rb", migrations: UP_TO_V33 }),
    createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "m1", migrations: UP_TO_V33 }),
  ]);
  for (const d of [rdb, mdb]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: mdb.url });
  await r.connect();
  await k.connect();
  assert.equal((await r.query("select current_database() as db")).rows[0].db, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as db")).rows[0].db, mdb.name, "SAFETY");
  await applyV34(mdb.url);
});

// The application modules (the db.js pool, the Metrics Core catalog writers,
// the source-connection service) bound to the behaviour database: db.js reads
// DATABASE_URL once, when it is first imported, so the variable points at the
// disposable database only around that import and is then restored (an unset
// variable stays unset, never the string "undefined"). The pool is ended in
// after().
let appPool = null;
async function appModules() {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = mdb.url;
  try {
    const [db, catalog, sources] = await Promise.all([
      import("../src/db.js"), import("../src/trainingLoadMetricsCatalog.js"), import("../src/sourceConnectionService.js"),
    ]);
    appPool = db.pool;
    assert.equal((await appPool.query("select current_database() as db")).rows[0].db, mdb.name, "SAFETY: the application modules talk to the disposable database");
    return { catalog, sources };
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
}

after(async () => {
  await appPool?.end().catch(() => {});
  await r?.end().catch(() => {});
  await k?.end().catch(() => {});
  await rdb?.drop();
  await mdb?.drop();
});

// ---------------------------------------------------------------------------
// helpers
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];

async function ins(c, table, obj) {
  const keys = Object.keys(obj);
  const sql = `insert into ${T(table)} (${keys.map((x) => `"${x}"`).join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`;
  return (await c.query(sql, keys.map((x) => obj[x]))).rows[0];
}

async function refused(fn, { code, constraint, message } = {}) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, `expected a refusal (${message ?? constraint ?? code})`);
  if (code) assert.equal(err.code, code, `${err.code}: ${err.message}`);
  if (constraint) assert.equal(err.constraint, constraint, `${err.constraint}: ${err.message}`);
  if (message) assert.match(err.message, message);
  if (!err.constraint && (err.code === "23514" || err.code === "42501")) triggerMessages.add(err.message);
  return err;
}

// Runs fn inside a transaction that is always rolled back (used with a
// trigger disabled for that transaction only - DDL is transactional).
async function inRolledBackTx(c, fn) {
  await c.query("begin");
  try { return await fn(); } finally { await c.query("rollback"); }
}

// Deterministic interleaving: `first` runs in an open transaction of one
// client, `second` in another client and must wait for a lock of the first
// (seen in pg_stat_activity, bounded at 5 s); then the first transaction
// commits and the second's outcome is returned. A second operation that does
// not wait (a lock removed) fails the assertion.
async function waitsForLock(pid, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await one(k, `select wait_event_type from pg_stat_activity where pid = $1`, [pid]);
    if (row?.wait_event_type === "Lock") return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}
async function interleave(first, second) {
  const a = new pg.Client({ connectionString: mdb.url });
  const b = new pg.Client({ connectionString: mdb.url });
  await a.connect();
  await b.connect();
  try {
    const bPid = (await one(b, `select pg_backend_pid() as pid`)).pid;
    await a.query("begin");
    await first(a);
    let settled = false;
    const outcome = second(b).then((value) => ({ value }), (error) => ({ error })).finally(() => { settled = true; });
    assert.equal(await waitsForLock(bPid), true, "the second operation waits for the first one's lock");
    assert.equal(settled, false);
    await a.query("commit");
    return await outcome;
  } finally {
    await a.end().catch(() => {});
    await b.end().catch(() => {});
  }
}
function expectRefusedOutcome(outcome, pattern) {
  assert.ok(outcome.error, `the waiting operation is refused (${pattern})`);
  assert.equal(outcome.error.code, "23514", outcome.error.message);
  assert.match(outcome.error.message, pattern);
  triggerMessages.add(outcome.error.message);
}

async function world(c) {
  const user = async (label, { admin = false, roleActive = true, active = true } = {}) => {
    const id = (await one(c, `insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,$3) returning id`, [`${label}-${uid()}@test.local`, label, active])).id;
    if (admin) await c.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',$2)`, [id, roleActive]);
    return id;
  };
  const club = async (name) => (await one(c, `insert into public.clubs (name) values ($1) returning id`, [name])).id;
  const clubAdmin = async (clubId, label) => {
    const id = await user(label);
    await c.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
    return id;
  };
  const w = {
    pa: await user("platform-admin", { admin: true }),
    nobody: await user("nobody"),
    revoked: await user("revoked-admin", { admin: true, roleActive: false }),
    inactive: await user("inactive-admin", { admin: true, active: false }),
    clubA: await club("Club A"),
    clubB: await club("Club B"),
    clubC: await club("Club C"),
  };
  w.adminA = await clubAdmin(w.clubA, "admin-a");
  w.adminB = await clubAdmin(w.clubB, "admin-b");
  w.adminC = await clubAdmin(w.clubC, "admin-c");
  await c.query(`update public.clubs set is_active = false where id = $1`, [w.clubC]);
  w.athlete = (await one(c, `insert into public.athletes (full_name, display_name, device_timezone) values ('A1','A1','Europe/Sarajevo') returning id`)).id;
  return w;
}

let nextSourceTeam = 2001;
async function newTeam(c, clubId) {
  return (await one(c, `insert into public.teams (club_id, name) values ($1, $2) returning id`, [clubId, `Team ${uid()}`])).id;
}
// A team with its approved pair and an active binding (v27 / v30), on a
// club- or team-owned connection of the given host.
async function bindTeam(c, w, clubId, { teamOwned = false, hostKey = "server3" } = {}) {
  const teamId = await newTeam(c, clubId);
  const sourceTeam = String(nextSourceTeam++);
  await c.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)`, [teamId, sourceTeam, w.pa]);
  const conn = await ins(c, "source_credential_connections", {
    source_system: "gpexe", owner_scope: teamOwned ? "team" : "club", owner_club_id: teamOwned ? null : clubId, owner_team_id: teamOwned ? teamId : null,
    host_key: hostKey, account_label: "L", credential_kind: "exchanged_token", created_by_user_id: w.pa,
  });
  const b = await ins(c, "source_team_bindings", { team_id: teamId, connection_id: conn.id, source_system: "gpexe", source_team_id: sourceTeam, bound_by_user_id: w.pa, legacy_gpexe_settings_team_id: teamId });
  return { teamId, clubId, sourceTeam, connectionId: conn.id, bindingId: b.id, hostKey };
}

async function canonical(c, { scope = "system", clubId = null, teamId = null, unit = "min", valueType = "numeric", cd = null, caps = ["session", "component"], state = "active" } = {}) {
  const id = (await one(c, `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id, owner_team_id, state) values ($1,'M1 test variable',$2,$3,$4,$5) returning id`, [`m1_${uid()}`, scope, clubId, teamId, state])).id;
  const versionId = (await one(c, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, condition_description) values ($1,1,$2,$3,$4) returning id`, [id, unit, valueType, cd])).id;
  await c.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [versionId, id]);
  for (const s of caps) await c.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,$2)`, [id, s]);
  return { id, versionId, unit };
}

async function verifyUnit(c, revId, unit, boundUnit, by) {
  await c.query(`update training_load.source_metric_definition_versions set source_unit = $2, source_bound_unit = $3, unit_verified_by_user_id = $4, unit_verified_at = now(), unit_evidence_ref = $5 where id = $1`, [revId, unit, boundUnit, by, COMPAT]);
}
async function verifyMeaning(c, revId, operator, by) {
  await c.query(`update training_load.source_metric_definition_versions set bound_operator = $2, meaning_verified_by_user_id = $3, meaning_verified_at = now(), meaning_evidence_ref = $4, evidence_status = 'verified' where id = $1`, [revId, operator, by, COMPAT]);
}
async function activateRevision(c, revId, by) {
  await c.query(`update training_load.source_metric_definition_versions set state = 'active', activated_by_user_id = $2, activated_at = now() where id = $1`, [revId, by]);
}

// A source field of gpexe / rest_v1 with revision 1, verified and active.
async function field(c, w, { kind = "none", unit = "s", boundUnit = null, operator = null, session = true, drill = true, verify = true, activate = true } = {}) {
  const def = await ins(c, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.f${uid()}`, source_label: "Test field", created_by_user_id: w.pa });
  const shape = kind === "zone_bounds" ? "zone_distance" : kind === "event_threshold" ? "event_count" : "number";
  const rev = await ins(c, "source_metric_definition_versions", {
    source_metric_definition_id: def.id, revision_number: 1, value_shape: shape, parameter_kind: kind, supports_session: session, supports_drill: drill,
    evidence_status: "observed", evidence_ref: COMPAT, created_by_user_id: w.pa,
  });
  if (verify) {
    await verifyUnit(c, rev.id, unit, boundUnit, w.pa);
    await verifyMeaning(c, rev.id, operator, w.pa);
  }
  if (activate) await activateRevision(c, rev.id, w.pa);
  return { defId: def.id, revId: rev.id, unit, boundUnit, operator, key: def.source_metric_key };
}

async function mapping(c, w, f, md, { scope = "system", clubId = null, by = w.pa } = {}) {
  const m = await ins(c, "source_metric_mappings", { source_metric_definition_id: f.defId, source_system: "gpexe", api_family: "rest_v1", metric_definition_id: md.id, owner_scope: scope, owner_club_id: clubId, created_by_user_id: by });
  return { id: m.id, f, md, ownerKey: m.owner_key };
}

let versionNumber = 1;
function versionRow(w, m, over = {}) {
  return {
    mapping_id: m.id, source_metric_definition_id: m.f.defId, metric_definition_id: m.md.id, source_metric_version_id: m.f.revId,
    version_number: versionNumber++, metric_definition_version_id: m.md.versionId, conversion_kind: "numeric_linear",
    scale: "1", scale_divisor: "1", offset: "0", source_unit: m.f.unit, target_unit: m.md.unit, conversion_note: null,
    parameter_kind: "none", source_parameters: {}, canonical_parameters: {}, parameter_scale: "1", parameter_scale_divisor: "1", parameter_offset: "0",
    applies_to_session: true, applies_to_drill: true, created_by_user_id: w.pa, ...over,
  };
}
const version = (c, w, m, over = {}) => ins(c, "source_metric_mapping_versions", versionRow(w, m, over));
async function submit(c, verId, by, basis = "platform_admin") {
  await c.query(`update training_load.source_metric_mapping_versions set status = 'needs_review', submitted_by_user_id = $2, submitted_at = now(), submitted_basis = $3 where id = $1`, [verId, by, basis]);
}
async function activateVersion(c, verId, by) {
  await c.query(`update training_load.source_metric_mapping_versions set status = 'active', activated_by_user_id = $2, activated_at = now(), activated_basis = 'platform_admin' where id = $1`, [verId, by]);
}
async function disableVersion(c, verId, by) {
  await c.query(`update training_load.source_metric_mapping_versions set status = 'disabled', disabled_by_user_id = $2, disabled_at = now(), disabled_basis = 'platform_admin', disable_reason = 'Replaced in a test' where id = $1`, [verId, by]);
}
async function activeVersion(c, w, m, over = {}) {
  const v = await version(c, w, m, over);
  await submit(c, v.id, w.pa);
  await activateVersion(c, v.id, w.pa);
  return one(c, `select * from training_load.source_metric_mapping_versions where id = $1`, [v.id]);
}

async function activationRow(c, w, verId, bind, over = {}) {
  const v = await one(c, `select * from training_load.source_metric_mapping_versions where id = $1`, [verId]);
  return {
    mapping_version_id: v.id, mapping_id: v.mapping_id, source_metric_definition_id: v.source_metric_definition_id, metric_definition_id: v.metric_definition_id,
    parameter_fingerprint: v.parameter_fingerprint, source_team_binding_id: bind.bindingId, team_id: bind.teamId,
    applies_to_session: v.applies_to_session, applies_to_drill: v.applies_to_drill, requirement: "optional",
    activated_by_user_id: w.pa, activated_basis: "platform_admin", reason: "Pilot activation", ...over,
  };
}
const activation = async (c, w, verId, bind, over = {}) => ins(c, "source_metric_mapping_activations", await activationRow(c, w, verId, bind, over));
async function endActivation(c, actId, by, reason = "admin_ended") {
  await c.query(`update training_load.source_metric_mapping_activations set ended_at = now(), ended_by_user_id = $2, ended_basis = 'platform_admin', end_reason = $3 where id = $1`, [actId, by, reason]);
}

// The Metrics Core side of an import: a team-owned v11 connection with its
// source instance (T7), and one value through event -> participant -> identity -> occasion.
async function metricConnection(c, teamId, { hostKey = "server3", instance } = {}) {
  return (await ins(c, "metric_source_connections", { source_system: "gpexe", owner_scope: "team", owner_team_id: teamId, source_host_key: instance === null ? null : hostKey, source_instance_key: instance ?? null })).id;
}
async function valueRow(c, w, { teamId, mscId, md, value, unit = md.unit, scopeLevel = "session", drill = false }) {
  const ext = uid();
  const ev = await ins(c, "metric_events", { occurred_date: "2026-10-05", scope_level: scopeLevel, owner_scope: "team", owner_team_id: teamId, source_connection_id: mscId, source_external_id: `team_session:${ext}`, created_by_user_id: w.pa });
  const part = await ins(c, "metric_event_participants", { event_id: ev.id, athlete_id: w.athlete, athlete_timezone_snapshot: "Europe/Sarajevo" });
  const segment = drill ? (await ins(c, "metric_event_segments", { event_id: ev.id, label: "Drill 1", segment_order: 0 })).id : null;
  const ident = await ins(c, "metric_source_identities", { source_connection_id: mscId, source_external_id: `athlete_session:${ext}:${drill ? "drill:0" : "full"}` });
  const occ = await ins(c, "metric_measurement_occasions", { event_participant_id: part.id, segment_id: segment, entry_method: "api_import", source_identity_id: ident.id, recorded_by_user_id: w.pa });
  const val = await ins(c, "metric_values", { occasion_id: occ.id, metric_definition_id: md.id, metric_definition_version_id: md.versionId, value_numeric: value, unit_at_capture: unit });
  return { eventId: ev.id, valueId: val.id };
}
function provenanceRow(valueId, act, ver, { mscId, sourceValue, sourceUnit = ver.source_unit } = {}) {
  return {
    metric_value_id: valueId, activation_id: act.id, mapping_version_id: ver.id, source_team_binding_id: act.source_team_binding_id,
    mapping_id: ver.mapping_id, source_metric_version_id: ver.source_metric_version_id, metric_source_connection_id: mscId,
    source_unit: sourceUnit, source_value_numeric: sourceValue,
  };
}

function fingerprintJs(kind, params) {
  if (kind === "none") return "";
  const keys = Object.keys(params).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const text = kind + keys.map((key) => `|${key}=${params[key] === null ? "null" : String(params[key])}`).join("");
  return `v1:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    tables: await rows(c, `select table_schema, table_name from information_schema.tables where table_schema in ${S} order by 1, 2`),
    columns: await rows(c, `select table_schema, table_name, column_name, data_type, is_nullable, column_default, is_generated, generation_expression from information_schema.columns where table_schema in ${S} order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    indexes: await rows(c, `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ${S} order by 1, 2, 3`),
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
    comments: await rows(c, `select c.relname, a.attnum > 0 as is_column, coalesce(a.attname, '') as attname, d.description from pg_description d join pg_class c on c.oid = d.objoid join pg_namespace n on n.oid = c.relnamespace left join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid and d.objsubid > 0 where d.classoid = 'pg_class'::regclass and n.nspname = 'training_load' order by 1, 3`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
async function contentDigest(c, tables) {
  const out = {};
  for (const t of tables) out[t] = (await one(c, `select count(*)::int as n, md5(coalesce(string_agg(x::text, ',' order by x::text), '')) as d from ${t} x`)).d;
  return out;
}
const M1_TABLES = ["source_metric_definitions", "source_metric_definition_versions", "source_metric_mappings", "unit_conversions", "source_metric_mapping_versions", "source_metric_mapping_activations", "metric_value_source_provenance", "source_metric_audit"];

async function runRollback(c) {
  const sql = await fsp.readFile(ROLLBACK_PATH, "utf8");
  try {
    await c.query(sql);
    return null;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    return e;
  }
}

const SEED_FIELDS = [
  ["athlete_session.total_time", "TIME", "number", "none", "s", null],
  ["athlete_session.total_distance", "TotDist", "number", "none", "m", null],
  ["athlete_session.max_v", "SPEEDmax", "number", "none", "m/s", null],
  ["more.complementary_data.power.distance", "Power zone distance", "zone_distance", "zone_bounds", "m", "W/kg"],
  ["more.complementary_data.speed.distance", "Speed zone distance", "zone_distance", "zone_bounds", "m", "m/s"],
  ["more.events.acceleration_events_count", "Acceleration events", "event_count", "event_threshold", "count", null],
  ["more.events.deceleration_events_count", "Deceleration events", "event_count", "event_threshold", "count", null],
  ["details.players.tot_burst_events", "Burst events", "unit_value_object", "none", "count", null],
  ["details.players.tot_brake_events", "Brake events", "unit_value_object", "none", "count", null],
];
const HYPOTHESIS = "Expected unit is a hypothesis from the e03 pilot; not proven on server3.";

async function assertSeed(c) {
  const defs = await rows(c, `select source_system, api_family, source_metric_key, source_label, state, created_by_user_id, seed_migration, retired_at from training_load.source_metric_definitions order by source_metric_key`);
  assert.deepEqual(defs, SEED_FIELDS.map(([key, label]) => ({ source_system: "gpexe", api_family: "rest_v1", source_metric_key: key, source_label: label, state: "active", created_by_user_id: null, seed_migration: V34_NAME, retired_at: null })).sort((a, b) => (a.source_metric_key < b.source_metric_key ? -1 : 1)));
  const revs = await rows(c, `select d.source_metric_key as key, v.revision_number, v.value_shape, v.parameter_kind, v.supports_session, v.supports_drill, v.expected_source_unit, v.expected_source_bound_unit, v.unit_note, v.source_unit, v.source_bound_unit, v.bound_operator, v.unit_verified_at, v.meaning_verified_at, v.evidence_status, v.evidence_ref, v.state, v.activated_by_user_id, (v.activated_at is not null) as activated, v.created_by_user_id, v.seed_migration from training_load.source_metric_definition_versions v join training_load.source_metric_definitions d on d.id = v.source_metric_definition_id order by 1`);
  assert.equal(revs.length, 9);
  for (const rv of revs) {
    const [, , shape, kind, unit, bound] = SEED_FIELDS.find(([key]) => key === rv.key);
    assert.deepEqual(rv, {
      key: rv.key, revision_number: 1, value_shape: shape, parameter_kind: kind, supports_session: true, supports_drill: true,
      expected_source_unit: unit, expected_source_bound_unit: bound,
      unit_note: rv.key.startsWith("details.") ? `${HYPOTHESIS} The observed unit "number" is a shape; the meaning is unconfirmed.` : HYPOTHESIS,
      source_unit: null, source_bound_unit: null, bound_operator: null, unit_verified_at: null, meaning_verified_at: null,
      evidence_status: "observed", evidence_ref: COMPAT, state: "active", activated_by_user_id: null, activated: true, created_by_user_id: null, seed_migration: V34_NAME,
    }, rv.key);
    assert.notEqual(rv.evidence_status, "verified", "a seeded revision is never verified");
  }
  const conv = await rows(c, `select from_unit, to_unit, scale::text as scale, scale_divisor::text as div, "offset"::text as off, state, evidence_ref, created_by_user_id, seed_migration from training_load.unit_conversions order by from_unit, to_unit`);
  assert.deepEqual(conv, [
    { from_unit: "km/h", to_unit: "m/s", scale: "1", div: "3.6", off: "0", state: "active", evidence_ref: D5, created_by_user_id: null, seed_migration: V34_NAME },
    { from_unit: "m", to_unit: "km", scale: "0.001", div: "1", off: "0", state: "active", evidence_ref: D5, created_by_user_id: null, seed_migration: V34_NAME },
    { from_unit: "m/s", to_unit: "km/h", scale: "3.6", div: "1", off: "0", state: "active", evidence_ref: D5, created_by_user_id: null, seed_migration: V34_NAME },
    { from_unit: "s", to_unit: "min", scale: "1", div: "60", off: "0", state: "active", evidence_ref: D5, created_by_user_id: null, seed_migration: V34_NAME },
  ]);
  for (const t of ["source_metric_mappings", "source_metric_mapping_versions", "source_metric_mapping_activations", "metric_value_source_provenance", "source_metric_audit"]) {
    assert.equal((await one(c, `select count(*)::int as n from ${T(t)}`)).n, 0, `no ${t} row after the migration`);
  }
}

// ---------------------------------------------------------------------------
test("1. migration v34 on v33: the tables, columns, named constraints, indexes, triggers and functions; api_family equals sourceHosts.js; the D12 seed exactly with no mapping, version, activation, provenance, audit row or canonical definition; the server is PostgreSQL 13 or later; the rollback returns the identical v33 catalog and data; v34 applies again identically", async (t) => {
  const version = Number((await one(r, `select current_setting('server_version_num') as v`)).v);
  t.diagnostic(`disposable server_version_num=${version}`);
  assert.ok(version >= 130000, "scale() and trim_scale() need PostgreSQL 13 or later");
  assert.equal((await one(r, `select current_setting('server_encoding') as e`)).e, "UTF8");

  const before33 = await catalog(r);
  const dataBefore = await contentDigest(r, ["training_load.source_host_catalog", "training_load.metric_source_connections", "training_load.source_team_bindings", "training_load.metric_definitions"]);
  const definitionsBefore = (await one(r, `select count(*)::int as n from training_load.metric_definitions`)).n;
  const notYet = await runRollback(r);
  assert.match(notYet?.message ?? "", /^v34 rollback refused: v34 is not recorded/, "the rollback refuses a database without v34");
  await applyV34(rdb.url);
  const after34 = await catalog(r);
  assert.ok(after34.migrations.includes(V34_NAME));
  assert.equal((await one(r, `select count(*)::int as n from training_load.metric_definitions`)).n, definitionsBefore, "the migration creates no canonical definition");

  for (const table of M1_TABLES) assert.ok(after34.tables.some((x) => x.table_schema === "training_load" && x.table_name === table), table);
  const cons = new Set(after34.constraints.map((x) => x.conname));
  for (const name of [
    "source_host_catalog_api_family_check", "source_metric_definitions_identity_key", "source_metric_definitions_family_anchor", "source_metric_definitions_actor_or_seed",
    "source_metric_revisions_verified_iff_proven", "source_metric_revisions_evidence_ref_iff_proven", "source_metric_revisions_operator_with_meaning",
    "source_metric_revisions_proven_bound_unit", "source_metric_revisions_definition_anchor", "source_metric_mappings_owner_anchor", "source_metric_mappings_version_anchor",
    "source_metric_mappings_family_anchor", "source_metric_mappings_source_fk", "unit_conversions_factors_normal", "unit_conversions_factors_finite",
    "source_metric_mapping_versions_owner_fk", "source_metric_mapping_versions_mapping_fk", "source_metric_mapping_versions_revision_fk",
    "source_metric_mapping_versions_canonical_version_fk", "source_metric_mapping_versions_fingerprint_shape", "source_metric_mapping_versions_activation_anchor",
    "source_metric_mapping_versions_provenance_mapping_anchor", "source_metric_mapping_versions_provenance_revision_anchor", "source_metric_mapping_versions_status_facts",
    "source_team_bindings_id_team_key", "source_metric_activations_version_fk", "source_metric_activations_binding_fk", "source_metric_activations_provenance_anchor",
    "metric_value_provenance_activation_fk", "metric_value_provenance_mapping_fk", "metric_value_provenance_revision_fk", "metric_value_provenance_value_fk",
    "metric_source_connections_source_instance_together", "source_metric_audit_action_shape", "source_metric_audit_request_pair", "source_metric_audit_revision_fk", "source_metric_audit_version_fk",
  ]) assert.ok(cons.has(name), `constraint ${name}`);
  const idx = new Set(after34.indexes.map((x) => x.indexname));
  for (const name of ["source_metric_revisions_one_active", "source_metric_revisions_one_draft", "unit_conversions_one_active_pair", "source_metric_mapping_versions_one_active_per_mapping",
    "source_metric_mapping_versions_one_active_target_per_owner", "source_metric_activations_one_open_per_field", "source_metric_activations_one_open_session_target",
    "source_metric_activations_one_open_drill_target", "metric_source_connections_one_active_instance", "source_metric_audit_one_request_per_key", "source_metric_audit_one_request_per_operation"]) {
    assert.ok(idx.has(name), `index ${name}`);
  }
  assert.match(after34.indexes.find((x) => x.indexname === "source_metric_mapping_versions_one_active_target_per_owner").indexdef, /\(source_metric_definition_id, parameter_fingerprint, owner_key\) WHERE \(status = 'active'::text\)/);
  assert.match(after34.indexes.find((x) => x.indexname === "metric_source_connections_one_active_instance").indexdef, /WHERE \(\(state\)::text = 'active'::text\)/);
  const trg = new Set(after34.triggers.map((x) => x.tgname));
  for (const name of ["source_host_catalog_api_family_immutable", "source_metric_definitions_guard", "source_metric_revisions_guard", "source_metric_mappings_guard", "unit_conversions_guard",
    "source_metric_mapping_versions_insert_guard", "source_metric_mapping_versions_update_guard", "metric_definitions_source_metric_guard", "metric_definitions_source_metric_owner_guard", "metric_definition_scope_capabilities_source_metric_guard",
    "source_metric_activations_insert_guard", "source_metric_activations_update_guard", "metric_value_provenance_insert_guard", "metric_value_source_provenance_append_only",
    "metric_source_connections_instance_write_once", "source_metric_audit_insert_guard", "source_metric_audit_append_only"]) assert.ok(trg.has(name), `trigger ${name}`);
  for (const table of M1_TABLES) assert.ok(after34.triggers.some((x) => x.relname === table && /BEFORE TRUNCATE/.test(x.def)), `TRUNCATE guard on ${table}`);
  // The generated, never-NULL owner key and the T4 copy (D4 / D6).
  const ownerKey = after34.columns.find((x) => x.table_name === "source_metric_mappings" && x.column_name === "owner_key");
  assert.deepEqual([ownerKey.is_nullable, ownerKey.is_generated], ["NO", "ALWAYS"]);
  assert.match(ownerKey.generation_expression, /COALESCE\(\(owner_club_id\)::text, 'system'::text\)/);
  assert.equal(after34.columns.find((x) => x.table_name === "source_metric_mapping_versions" && x.column_name === "owner_key").is_nullable, "NO");
  // D1: the column agrees with the code's catalog.
  const families = await rows(r, `select source_system, host_key, api_family from training_load.source_host_catalog order by 1, 2`);
  assert.deepEqual(families.map((x) => [x.source_system, x.host_key, x.api_family]), Object.entries(SOURCE_HOSTS).flatMap(([s, hosts]) => Object.entries(hosts).map(([h, p]) => [s, h, p.apiFamily])).sort());
  await assertSeed(r);
  // Every M1 function writes nothing to Metrics Core's definitions (C46).
  const defs = await rows(r, `select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.prokind = 'f'`);
  const m1Functions = defs.filter((x) => !before33.functions.some((b) => b.proname === x.proname));
  assert.ok(m1Functions.length >= 25, `the M1 functions are found (${m1Functions.length})`);
  for (const fn of m1Functions) assert.doesNotMatch(fn.def, /(insert\s+into|update|delete\s+from)\s+training_load\.metric_definitions\b/i, `${fn.proname} writes no canonical definition`);
  assert.doesNotMatch(fs.readFileSync(MIGRATION_PATH, "utf8"), /insert\s+into\s+training_load\.metric_definitions\b/i, "the seed creates no canonical definition");

  // Rollback: the identical v33 catalog and data, then v34 again.
  assert.equal(await runRollback(r), null, "a clean M1 database rolls back");
  const rolledBack = await catalog(r);
  for (const key of Object.keys(before33)) assert.deepEqual(rolledBack[key], before33[key], `the rollback leaves exactly the v33 ${key}`);
  assert.deepEqual(await contentDigest(r, ["training_load.source_host_catalog", "training_load.metric_source_connections", "training_load.source_team_bindings", "training_load.metric_definitions"]), dataBefore, "and every row as it was");
  await applyV34(rdb.url);
  const again = await catalog(r);
  for (const key of Object.keys(after34)) assert.deepEqual(again[key], after34[key], `v34 applies again with the same ${key}`);
  await assertSeed(r);
});

test("2. the rollback refuses, dropping nothing, on a later migration, a foreign key into an M1 table, a source instance, a changed conversion, revision or definition seed, and any mapping, version, activation, provenance or audit row; each reason is named", async () => {
  const w = await world(r);
  const expectRefusal = async (reason) => {
    const counts = Object.fromEntries(await Promise.all(M1_TABLES.map(async (t) => [t, (await one(r, `select count(*)::int as n from ${T(t)}`)).n])));
    const err = await runRollback(r);
    assert.ok(err, `refused: ${reason}`);
    assert.match(err.message, /^v34 rollback refused: /);
    assert.ok(err.message.includes(reason), `the refusal names "${reason}": ${err.message}`);
    for (const t of M1_TABLES) assert.equal((await one(r, `select count(*)::int as n from ${T(t)}`)).n, counts[t], `${t} untouched`);
    assert.ok((await rows(r, `select 1 from public.schema_migrations where migration_name = $1`, [V34_NAME])).length === 1, "v34 stays recorded");
    assert.ok((await one(r, `select api_family from training_load.source_host_catalog where host_key = 'server3'`)).api_family === "rest_v1");
  };
  await r.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/202610121001_training_load_v35_test_only.sql', $1, 'test')`, ["0".repeat(64)]);
  await expectRefusal("later migrations are applied");
  await r.query(`create table public.m1_test_external_ref (x uuid references training_load.source_metric_definitions(id))`);
  await expectRefusal("other tables reference the M1 tables");
  const teamId = await newTeam(r, w.clubA);
  await metricConnection(r, teamId, { instance: "991" });
  await expectRefusal("carry a source instance");
  await r.query(`update training_load.unit_conversions set state = 'retired', retired_by_user_id = $1, retired_at = now(), retired_reason = 'Test retirement' where from_unit = 'm' and to_unit = 'km'`, [w.pa]);
  await expectRefusal("the unit conversions are not exactly the v34 seed");
  const seedRev = (await one(r, `select v.id from training_load.source_metric_definition_versions v join training_load.source_metric_definitions d on d.id = v.source_metric_definition_id where d.source_metric_key = 'athlete_session.total_time'`)).id;
  await verifyUnit(r, seedRev, "s", null, w.pa);
  await expectRefusal("the source metric revisions are not exactly the v34 seed");
  await r.query(`update training_load.source_metric_definitions set source_label = 'TIME (renamed)' where source_metric_key = 'athlete_session.total_time'`);
  await expectRefusal("the source metric definitions are not exactly the v34 seed");
  const f = await field(r, w, { unit: "s" });
  const md = await canonical(r, { unit: "min" });
  const m = await mapping(r, w, f, md);
  await expectRefusal("source metric mapping(s) exist");
  const v = await activeVersion(r, w, m, { scale: "1", scale_divisor: "60", conversion_note: "Seconds to minutes" });
  await expectRefusal("mapping version(s) exist");
  const bind = await bindTeam(r, w, w.clubA);
  const act = await activation(r, w, v.id, bind);
  await expectRefusal("activation(s) exist");
  const msc = await metricConnection(r, bind.teamId, { instance: bind.sourceTeam });
  const val = await valueRow(r, w, { teamId: bind.teamId, mscId: msc, md, value: "2" });
  await ins(r, "metric_value_source_provenance", provenanceRow(val.valueId, act, v, { mscId: msc, sourceValue: "120" }));
  await expectRefusal("provenance row(s) exist");
  await ins(r, "source_metric_audit", { action: "mapping_create", mapping_id: m.id, performed_by_user_id: w.pa, basis: "platform_admin", operation_id: crypto.randomUUID() });
  await expectRefusal("audit row(s) exist");
});

test("3. seed evidence references name an existing document and a real anchor; the key and the label of a source field are separate (the label edits, the identity does not); the evidence_ref shape refuses every other form", async () => {
  const anchorsOf = (md) => {
    const set = new Set();
    for (const m of md.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) set.add(m[1]);
    for (const line of md.split(/\r?\n/)) {
      const h = /^#{1,6}\s+(.*)$/.exec(line);
      if (h) set.add(h[1].trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-"));
    }
    return set;
  };
  const refs = (await rows(k, `select evidence_ref as ref from training_load.source_metric_definition_versions where seed_migration is not null union select evidence_ref from training_load.unit_conversions where seed_migration is not null`)).map((x) => x.ref);
  assert.deepEqual([...new Set(refs)].sort(), [D5, COMPAT].sort());
  for (const ref of new Set(refs)) {
    const [file, anchor] = ref.split("#");
    const text = fs.readFileSync(path.resolve(ROOT, file), "utf8");
    assert.ok(anchorsOf(text).has(anchor), `${file} has the anchor #${anchor}`);
  }
  // Identity and label never mix.
  for (const [key, label] of SEED_FIELDS) assert.notEqual(key, label);
  const row = await one(k, `select id, source_metric_key from training_load.source_metric_definitions where source_metric_key = 'athlete_session.max_v'`);
  await k.query(`update training_load.source_metric_definitions set source_label = 'SPEEDmax (GPEXE)' where id = $1`, [row.id]);
  await k.query(`update training_load.source_metric_definitions set source_label = 'SPEEDmax' where id = $1`, [row.id]);
  await refused(() => k.query(`update training_load.source_metric_definitions set source_metric_key = 'athlete_session.max_speed' where id = $1`, [row.id]), { code: "23514", message: /identity of a source metric is immutable/ });
  const someone = (await one(k, `insert into public.users (email) values ($1) returning id`, [`m1-${uid()}@test.local`])).id;
  await refused(() => k.query(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1','athlete_session.max_v','Other label',$1)`, [someone]), { code: "23505", constraint: "source_metric_definitions_identity_key" });
  // The evidence reference shape (C40).
  const ok = async (v) => (await one(k, `select training_load.source_metric_evidence_ref_ok($1) as ok`, [v])).ok;
  for (const good of [COMPAT, D5, "docs/a#b", "docs/runbooks/x.v2.md#section_1-a"]) assert.equal(await ok(good), true, good);
  for (const bad of ["", "docs", "docs/x.md", "docs/x.md#", "#anchor", "/docs/x.md#a", "docs//x.md#a", "docs/./x.md#a", "docs/../x.md#a", "docs/x.md#a#b", "src/x.md#a",
    "https://example.invalid/docs/x.md#a", "docs/x y.md#a", "docs/x.md#a b", "docs/x:y.md#a", "docs/x.md#a\n", `docs/${"a".repeat(300)}.md#a`, "docs/x.md#ä"]) {
    assert.equal(await ok(bad), false, JSON.stringify(bad));
  }
});

test("4. bounded single-line text (C41) and unit tokens: trimmed, 1..N characters, no C0 / DEL / C1 control character or line separator; an empty string is never a value; a token has no whitespace, | or =", async () => {
  const text = async (v, n = 500) => (await one(k, `select training_load.source_metric_text_ok($1, $2) as ok`, [v, n])).ok;
  for (const good of ["Pilot activation", "a", "Zone ≥25 W/kg", "x".repeat(500)]) assert.equal(await text(good), true, good);
  for (const bad of [null, "", " leading", "trailing ", "two\nlines", "tab\there", "cr\rhere", "del\u007f", "c1\u0085", "ls\u2028x", "ps\u2029x", "x".repeat(501)]) {
    assert.equal(await text(bad), false, JSON.stringify(bad));
  }
  // C53: exactly the listed format characters (each range's ends) are refused in free text.
  for (const cp of [0x00ad, 0x061c, 0x180e, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x206f, 0xfeff]) {
    assert.equal(await text(`a${String.fromCodePoint(cp)}b`), false, `U+${cp.toString(16).toUpperCase()} is refused in free text`);
  }
  for (const cp of [0x00a0, 0x2065, 0x2070, 0x00e9]) assert.equal(await text(`a${String.fromCodePoint(cp)}b`), true, `U+${cp.toString(16).toUpperCase()} is not on the C53 list`);
  assert.equal(await text("x".repeat(81), 80), false);
  const token = async (v) => (await one(k, `select training_load.source_metric_unit_token_ok($1) as ok`, [v])).ok;
  for (const good of ["s", "m/s", "km/h", "W/kg", "m/s²", "count"]) assert.equal(await token(good), true, good);
  for (const bad of [null, "", "m s", "m|s", "m=s", "m\ts", "a\u2028b", "m\u00a0s", "m\u200bs", "m\u202es", "m\u2066s", "m\ufeffs", "m\u3000s", "m\u00ads", "m\u061cs", "m\u180es", "x".repeat(31)]) assert.equal(await token(bad), false, JSON.stringify(bad));
  const w = await world(k);
  await refused(() => ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.${uid()}`, source_label: " padded", created_by_user_id: w.pa }), { code: "23514", constraint: "source_metric_definitions_label_check" });
  await refused(() => ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.${uid()}`, source_label: "", created_by_user_id: w.pa }), { code: "23514", constraint: "source_metric_definitions_label_check" });
  await refused(() => ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.${uid()}`, source_label: "two\nlines", created_by_user_id: w.pa }), { code: "23514", constraint: "source_metric_definitions_label_check" });
  await refused(() => ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: "Not.A.Key", source_label: "x", created_by_user_id: w.pa }), { code: "23514", constraint: "source_metric_definitions_key_format" });
  await refused(() => ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "graphql", source_metric_key: `m1.test.${uid()}`, source_label: "x", created_by_user_id: w.pa }), { code: "23514", constraint: "source_metric_definitions_api_family_check" });
  await refused(() => ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.${uid()}`, source_label: "x" }), { code: "23514", constraint: "source_metric_definitions_actor_or_seed" });
  // A seed marker after the migration is refused by the trigger (42501, test 18); the CHECKs behind it hold on their own.
  await refused(() => ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.${uid()}`, source_label: "x", created_by_user_id: w.pa, seed_migration: V34_NAME }), { code: "42501", message: /seed marker/ });
  await inRolledBackTx(k, async () => {
    await k.query(`alter table training_load.source_metric_definitions disable trigger source_metric_definitions_guard`);
    await k.query("savepoint s");
    await refused(() => ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.${uid()}`, source_label: "x", created_by_user_id: w.pa, seed_migration: V34_NAME }), { code: "23514", constraint: "source_metric_definitions_actor_or_seed" });
    await k.query("rollback to savepoint s");
    await refused(() => ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.${uid()}`, source_label: "x", seed_migration: "202610121000_v34.sql" }), { code: "23514", constraint: "source_metric_definitions_seed_migration_format" });
  });
});

let W; // the main database's world
test("5. T2a: created active, never deleted or truncated, identity immutable; retirement refused while a revision is draft or active or an activation is open (the T5 check reached with the T2b guard switched off for one transaction)", async () => {
  W = await world(k);
  const w = W;
  await refused(() => ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.${uid()}`, source_label: "x", created_by_user_id: w.pa, state: "retired", retired_by_user_id: w.pa, retired_at: new Date(), retired_reason: "x" }), { code: "23514", message: /created active/ });
  const f = await field(k, w, { unit: "s" });
  await refused(() => k.query(`delete from training_load.source_metric_definitions where id = $1`, [f.defId]), { code: "23514", message: /never deleted/ });
  await refused(() => k.query(`truncate training_load.source_metric_definitions cascade`));
  assert.equal((await one(k, `select count(*)::int as n from training_load.source_metric_definitions where id = $1`, [f.defId])).n, 1);
  const retire = (id) => k.query(`update training_load.source_metric_definitions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'No longer offered' where id = $1`, [id, w.pa]);
  await refused(() => retire(f.defId), { code: "23514", message: /draft or active revision/ });
  const draftOnly = await field(k, w, { unit: "s", activate: false });
  await refused(() => retire(draftOnly.defId), { code: "23514", message: /draft or active revision/ });
  // An open activation (the chain normally keeps the revision active).
  const md = await canonical(k, { unit: "min" });
  const m = await mapping(k, w, f, md);
  const v = await activeVersion(k, w, m, { scale: "1", scale_divisor: "60", conversion_note: "Seconds to minutes" });
  const bind = await bindTeam(k, w, w.clubA);
  await activation(k, w, v.id, bind);
  await inRolledBackTx(k, async () => {
    await k.query(`alter table training_load.source_metric_definition_versions disable trigger source_metric_revisions_guard`);
    await k.query(`update training_load.source_metric_definition_versions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Test only' where id = $1`, [f.revId, w.pa]);
    await refused(() => retire(f.defId), { code: "23514", message: /open activation/ });
  });
  // A field with only retired revisions retires; a retired field takes no revision and stays retired.
  const lone = await field(k, w, { unit: "s", verify: false, activate: false });
  await k.query(`update training_load.source_metric_definition_versions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Never used' where id = $1`, [lone.revId, w.pa]);
  await retire(lone.defId);
  await refused(() => ins(k, "source_metric_definition_versions", { source_metric_definition_id: lone.defId, revision_number: 2, value_shape: "number", parameter_kind: "none", supports_session: true, supports_drill: true, evidence_status: "unproven", created_by_user_id: w.pa }), { code: "23514", message: /only for an active source metric/ });
  await refused(() => k.query(`update training_load.source_metric_definitions set state = 'active', retired_by_user_id = null, retired_at = null, retired_reason = null where id = $1`, [lone.defId]), { code: "23514", message: /stays retired/ });
  await k.query(`update training_load.source_metric_definitions set source_label = 'Still a label' where id = $1`, [lone.defId]);
});

test("6. T2b: created as draft without proof (active only by the seed); proof written once by its own act and only by an active platform admin (42501); evidence only rises and its reference is written once; contract columns immutable; one active and one draft per field; a threshold or zone revision needs a proven bound unit and its operator with the meaning; retired is final and refused under a submitted or active version", async () => {
  const w = W;
  const def = await ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.rev${uid()}`, source_label: "Rev test", created_by_user_id: w.pa });
  const base = { source_metric_definition_id: def.id, value_shape: "number", parameter_kind: "none", supports_session: true, supports_drill: false, evidence_status: "unproven", created_by_user_id: w.pa };
  await refused(() => ins(k, "source_metric_definition_versions", { ...base, revision_number: 1, state: "active", activated_by_user_id: w.pa, activated_at: new Date() }), { code: "23514", message: /created as draft/ });
  await refused(() => ins(k, "source_metric_definition_versions", { ...base, revision_number: 1, evidence_status: "observed", evidence_ref: COMPAT, source_unit: "s", unit_verified_by_user_id: w.pa, unit_verified_at: new Date(), unit_evidence_ref: COMPAT }), { code: "23514", message: /without proof/ });
  await refused(() => ins(k, "source_metric_definition_versions", { ...base, revision_number: 1, evidence_status: "unproven", evidence_ref: COMPAT }), { code: "23514", constraint: "source_metric_revisions_evidence_ref_iff_proven" });
  await refused(() => ins(k, "source_metric_definition_versions", { ...base, revision_number: 1, value_shape: "zone_distance" }), { code: "23514", constraint: "source_metric_revisions_shape_kind" });
  await refused(() => ins(k, "source_metric_definition_versions", { ...base, revision_number: 1, supports_session: false }), { code: "23514", constraint: "source_metric_revisions_levels_check" });
  const rev = await ins(k, "source_metric_definition_versions", { ...base, revision_number: 1 });
  await refused(() => ins(k, "source_metric_definition_versions", { ...base, revision_number: 2 }), { code: "23505", constraint: "source_metric_revisions_one_draft" });
  // Evidence rises once with its reference; it never falls and the reference is never rewritten.
  await k.query(`update training_load.source_metric_definition_versions set evidence_status = 'documented', evidence_ref = $2 where id = $1`, [rev.id, COMPAT]);
  await refused(() => k.query(`update training_load.source_metric_definition_versions set evidence_status = 'unproven', evidence_ref = null where id = $1`, [rev.id]), { code: "23514", message: /only rises/ });
  await refused(() => k.query(`update training_load.source_metric_definition_versions set evidence_ref = $2 where id = $1`, [rev.id, D5]), { code: "23514", message: /written once/ });
  await k.query(`update training_load.source_metric_definition_versions set evidence_status = 'observed' where id = $1`, [rev.id]);
  // Contract columns are immutable (C42).
  for (const [col, val] of [["value_shape", "numeric_text"], ["supports_drill", true], ["expected_source_unit", "ms"], ["unit_note", "Changed"], ["revision_number", 7]]) {
    await refused(() => k.query(`update training_load.source_metric_definition_versions set ${col} = $2 where id = $1`, [rev.id, val]), { code: "23514", message: /contract of a revision is immutable/ });
  }
  // Unit proof: only an active platform admin, once.
  for (const actor of [w.nobody, w.revoked, w.inactive, w.adminA]) {
    await refused(() => verifyUnit(k, rev.id, "s", null, actor), { code: "42501", message: /not an active platform admin/ });
  }
  await verifyUnit(k, rev.id, "s", null, w.pa);
  await refused(() => k.query(`update training_load.source_metric_definition_versions set source_unit = 'ms' where id = $1`, [rev.id]), { code: "23514", message: /unit proof is written once/ });
  await refused(() => k.query(`update training_load.source_metric_definition_versions set source_unit = null, unit_verified_by_user_id = null, unit_verified_at = null, unit_evidence_ref = null where id = $1`, [rev.id]), { code: "23514", message: /unit proof is written once/ });
  await refused(() => k.query(`update training_load.source_metric_definition_versions set evidence_status = 'verified' where id = $1`, [rev.id]), { code: "23514", constraint: "source_metric_revisions_verified_iff_proven" });
  for (const actor of [w.nobody, w.revoked]) await refused(() => verifyMeaning(k, rev.id, null, actor), { code: "42501" });
  await verifyMeaning(k, rev.id, null, w.pa);
  await refused(() => k.query(`update training_load.source_metric_definition_versions set meaning_evidence_ref = $2 where id = $1`, [rev.id, D5]), { code: "23514", message: /meaning proof is written once/ });
  // A verification is its own act; activation by an active platform admin only.
  for (const actor of [w.nobody, w.revoked, w.inactive]) await refused(() => activateRevision(k, rev.id, actor), { code: "42501" });
  await activateRevision(k, rev.id, w.pa);
  const rev2 = await ins(k, "source_metric_definition_versions", { ...base, revision_number: 2 });
  await verifyUnit(k, rev2.id, "s", null, w.pa);
  await refused(() => k.query(`update training_load.source_metric_definition_versions set state = 'active', activated_by_user_id = $2, activated_at = now(), meaning_verified_by_user_id = $2, meaning_verified_at = now(), meaning_evidence_ref = $3, evidence_status = 'verified', evidence_ref = $3 where id = $1`, [rev2.id, w.pa, COMPAT]), { code: "23514" });
  await refused(() => activateRevision(k, rev2.id, w.pa), { code: "23514", message: /another revision of this source metric is active/ });
  // A threshold revision: proven value unit needs a proven bound unit, the operator comes with the meaning (C43, C38).
  const tdef = await ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.thr${uid()}`, source_label: "Threshold test", created_by_user_id: w.pa });
  const trev = await ins(k, "source_metric_definition_versions", { ...base, source_metric_definition_id: tdef.id, revision_number: 1, value_shape: "event_count", parameter_kind: "event_threshold", expected_source_unit: "count", evidence_status: "observed", evidence_ref: COMPAT });
  await refused(() => verifyUnit(k, trev.id, "count", null, w.pa), { code: "23514", constraint: "source_metric_revisions_proven_bound_unit" });
  await verifyUnit(k, trev.id, "count", "m/s²", w.pa);
  await refused(() => verifyMeaning(k, trev.id, null, w.pa), { code: "23514", constraint: "source_metric_revisions_operator_with_meaning" });
  await refused(() => k.query(`update training_load.source_metric_definition_versions set bound_operator = '<=' where id = $1`, [trev.id]), { code: "23514", constraint: "source_metric_revisions_operator_with_meaning" });
  await verifyMeaning(k, trev.id, "<=", w.pa);
  await refused(() => k.query(`update training_load.source_metric_definition_versions set bound_operator = '<' where id = $1`, [trev.id]), { code: "23514", message: /meaning proof is written once/ });
  const zdef = await ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.zone${uid()}`, source_label: "Zone test", created_by_user_id: w.pa });
  const zrev = await ins(k, "source_metric_definition_versions", { ...base, source_metric_definition_id: zdef.id, revision_number: 1, value_shape: "zone_distance", parameter_kind: "zone_bounds" });
  await refused(() => verifyUnit(k, zrev.id, "m", null, w.pa), { code: "23514", constraint: "source_metric_revisions_proven_bound_unit" });
  await refused(() => ins(k, "source_metric_definition_versions", { ...base, revision_number: 9, bound_operator: ">=" }), { code: "23514" });
  // Retirement: refused under a submitted version; final once done.
  const md = await canonical(k, { unit: "s" });
  const f = { defId: def.id, revId: rev.id, unit: "s" };
  const m = await mapping(k, w, f, md);
  const v = await version(k, w, m, { applies_to_drill: false });
  await submit(k, v.id, w.pa);
  const retireRev = (id) => k.query(`update training_load.source_metric_definition_versions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Corrected by a new revision' where id = $1`, [id, w.pa]);
  await refused(() => retireRev(rev.id), { code: "23514", message: /submitted or active mapping version/ });
  await disableVersion(k, v.id, w.pa);
  await retireRev(rev.id);
  await refused(() => k.query(`update training_load.source_metric_definition_versions set retired_reason = 'Other reason' where id = $1`, [rev.id]), { code: "23514", message: /retired revision is immutable/ });
  await refused(() => k.query(`update training_load.source_metric_definition_versions set state = 'active' where id = $1`, [rev.id]), { code: "23514", message: /retired revision is immutable/ });
  await refused(() => k.query(`delete from training_load.source_metric_definition_versions where id = $1`, [rev2.id]), { code: "23514", message: /never deleted/ });
});

test("7. T3: a system mapping targets an active system definition, a club mapping an active definition of the same club; owner_key is generated ('system' or the club id); the identity is immutable and never deleted", async () => {
  const w = W;
  const f = await field(k, w, { unit: "s" });
  const sys = await canonical(k, { unit: "min" });
  const clubA = await canonical(k, { scope: "club", clubId: w.clubA, unit: "min" });
  const clubB = await canonical(k, { scope: "club", clubId: w.clubB, unit: "min" });
  const teamMd = await canonical(k, { scope: "team", teamId: await newTeam(k, w.clubA), unit: "min" });
  const archived = await canonical(k, { unit: "min", state: "archived" });
  const ms = await mapping(k, w, f, sys);
  assert.equal(ms.ownerKey, "system");
  const mc = await mapping(k, w, f, clubA, { scope: "club", clubId: w.clubA, by: w.adminA });
  assert.equal(mc.ownerKey, w.clubA);
  await refused(() => mapping(k, w, f, clubB, { scope: "system" }), { code: "23514", message: /system mapping targets a system definition/ });
  await refused(() => mapping(k, w, f, clubB, { scope: "club", clubId: w.clubA }), { code: "23514", message: /same club/ });
  await refused(() => mapping(k, w, f, sys), { code: "23505", constraint: "source_metric_mappings_pair_key" });
  await refused(async () => mapping(k, w, f, await canonical(k, { unit: "min" }), { scope: "club", clubId: w.clubA }), { code: "23514", message: /same club/ });
  await refused(() => mapping(k, w, f, teamMd), { code: "23514", message: /system mapping targets a system definition/ });
  await refused(() => mapping(k, w, f, archived), { code: "23514", message: /must be active/ });
  await refused(async () => ins(k, "source_metric_mappings", { source_metric_definition_id: f.defId, source_system: "gpexe", api_family: "api", metric_definition_id: (await canonical(k)).id, owner_scope: "system", created_by_user_id: w.pa }), { code: "23503", constraint: "source_metric_mappings_source_fk" });
  await refused(async () => ins(k, "source_metric_mappings", { source_metric_definition_id: f.defId, source_system: "gpexe", api_family: "rest_v1", metric_definition_id: (await canonical(k)).id, owner_scope: "system", owner_club_id: w.clubA, created_by_user_id: w.pa }), { code: "23514", constraint: "source_metric_mappings_owner_check" });
  await refused(() => k.query(`update training_load.source_metric_mappings set owner_club_id = $2, owner_scope = 'club' where id = $1`, [ms.id, w.clubA]), { code: "23514", message: /identity is immutable/ });
  await refused(() => k.query(`delete from training_load.source_metric_mappings where id = $1`, [ms.id]), { code: "23514", message: /never deleted/ });
});

test("8. unit_conversions: normal form, finite factors, divisor > 0, different units; created by an active platform admin only (42501); one active row per pair; immutable but for its retirement; never deleted", async () => {
  const w = W;
  const row = (o) => ({ from_unit: `u${uid()}`, to_unit: "v", scale: "2", scale_divisor: "1", offset: "0", evidence_ref: D5, created_by_user_id: w.pa, ...o });
  await refused(() => ins(k, "unit_conversions", row({ scale: "2", scale_divisor: "2" })), { code: "23514", constraint: "unit_conversions_factors_normal" });
  await refused(() => ins(k, "unit_conversions", row({ scale: "0" })), { code: "23514", constraint: "unit_conversions_scale_positive" });
  await refused(() => ins(k, "unit_conversions", row({ scale: "-2" })), { code: "23514", constraint: "unit_conversions_scale_positive" });
  await ins(k, "unit_conversions", row({ scale: "1", offset: "-273.15" }));
  await refused(() => ins(k, "unit_conversions", row({ scale: "1", scale_divisor: "0" })), { code: "23514", constraint: "unit_conversions_divisor_positive" });
  await refused(() => ins(k, "unit_conversions", row({ scale: "1", scale_divisor: "-3" })), { code: "23514", constraint: "unit_conversions_divisor_positive" });
  for (const [col, bad] of [["scale", "NaN"], ["scale", "Infinity"], ["scale_divisor", "NaN"], ["scale_divisor", "Infinity"], ["offset", "-Infinity"], ["offset", "NaN"]]) {
    await refused(() => ins(k, "unit_conversions", row({ scale: "1", scale_divisor: "1", [col]: bad })), { code: "23514", constraint: "unit_conversions_factors_finite" });
  }
  await refused(() => ins(k, "unit_conversions", row({ from_unit: "v" })), { code: "23514", constraint: "unit_conversions_units_differ" });
  await refused(() => ins(k, "unit_conversions", row({ evidence_ref: "https://example.invalid/a#b" })), { code: "23514", constraint: "unit_conversions_evidence_ref_check" });
  for (const actor of [w.nobody, w.revoked, w.inactive, w.adminA]) await refused(() => ins(k, "unit_conversions", row({ created_by_user_id: actor })), { code: "42501" });
  await refused(() => ins(k, "unit_conversions", row({ created_by_user_id: null })), { code: "23514", constraint: "unit_conversions_actor_or_seed" });
  const c1 = await ins(k, "unit_conversions", row({ from_unit: "rpm", to_unit: "rps", scale: "1", scale_divisor: "60" }));
  await refused(() => ins(k, "unit_conversions", row({ from_unit: "rpm", to_unit: "rps", scale: "1", scale_divisor: "60" })), { code: "23505", constraint: "unit_conversions_one_active_pair" });
  await refused(() => k.query(`update training_load.unit_conversions set scale_divisor = 61 where id = $1`, [c1.id]), { code: "23514", message: /only change is its retirement/ });
  await refused(() => k.query(`delete from training_load.unit_conversions where id = $1`, [c1.id]), { code: "23514", message: /never deleted/ });
  await refused(() => ins(k, "unit_conversions", row({ state: "retired", retired_by_user_id: w.pa, retired_at: new Date(), retired_reason: "x" })), { code: "23514", message: /created active/ });
  await k.query(`update training_load.unit_conversions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Wrong divisor' where id = $1`, [c1.id, w.pa]);
  await refused(() => k.query(`update training_load.unit_conversions set retired_reason = 'Changed' where id = $1`, [c1.id]), { code: "23514" });
  await ins(k, "unit_conversions", row({ from_unit: "rpm", to_unit: "rps", scale: "1", scale_divisor: "60" }));
});

let FP; // a shared fixture for tests 9-16
test("9. T4 insert: only as draft, only on a proven unit, owner key copied and checked by the FK for club and system rows alike (never NULL); the conversion is (1, 1, 0) for equal units or the active unit_conversions row; the canonical version numeric with a unit; levels inside the revision and the definition", async () => {
  const w = W;
  const f = await field(k, w, { unit: "s" });
  const md = await canonical(k, { unit: "min" });
  const m = await mapping(k, w, f, md);
  const clubMd = await canonical(k, { scope: "club", clubId: w.clubA, unit: "min" });
  const mc = await mapping(k, w, f, clubMd, { scope: "club", clubId: w.clubA });
  const minutes = { scale: "1", scale_divisor: "60", conversion_note: "Seconds to minutes" };
  // Only as draft, even with every fact of a later state present (D6).
  await refused(() => version(k, w, m, { ...minutes, status: "needs_review", submitted_by_user_id: w.pa, submitted_at: new Date(), submitted_basis: "platform_admin" }), { code: "23514", message: /created as draft/ });
  await refused(() => version(k, w, m, { ...minutes, status: "active", submitted_by_user_id: w.pa, submitted_at: new Date(), submitted_basis: "platform_admin", activated_by_user_id: w.pa, activated_at: new Date(), activated_basis: "platform_admin" }), { code: "23514", message: /created as draft/ });
  // Owner key: filled from T3, a different supplied value refused...
  const v = await version(k, w, m, minutes);
  assert.equal(v.owner_key, "system");
  assert.equal((await version(k, w, mc, minutes)).owner_key, w.clubA);
  await refused(() => version(k, w, m, { ...minutes, owner_key: w.clubA }), { code: "23514", message: /owner key must be the mapping's own/ });
  await refused(() => version(k, w, mc, { ...minutes, owner_key: "system" }), { code: "23514", message: /owner key must be the mapping's own/ });
  // ...and the composite FK checks every row, system rows included, with the trigger off.
  for (const [mm, bad] of [[m, w.clubA], [mc, "system"], [m, "fake-owner"]]) {
    await inRolledBackTx(k, async () => {
      await k.query(`alter table training_load.source_metric_mapping_versions disable trigger source_metric_mapping_versions_insert_guard`);
      await refused(() => version(k, w, mm, { ...minutes, owner_key: bad, parameter_fingerprint: "" }), { code: "23503", constraint: "source_metric_mapping_versions_owner_fk" });
    });
  }
  await inRolledBackTx(k, async () => {
    await k.query(`alter table training_load.source_metric_mapping_versions disable trigger source_metric_mapping_versions_insert_guard`);
    await refused(() => version(k, w, m, { ...minutes, owner_key: null, parameter_fingerprint: "" }), { code: "23502" });
  });
  // A proven unit only.
  const unproven = await field(k, w, { unit: "s", verify: false, activate: false });
  const mu = await mapping(k, w, unproven, await canonical(k, { unit: "min" }));
  await refused(() => version(k, w, mu, { ...minutes, source_unit: "s" }), { code: "23514", message: /proven unit/ });
  await refused(() => version(k, w, m, { ...minutes, source_unit: "ms" }), { code: "23514", message: /source unit must be the revision's proven unit/ });
  // Conversions.
  await refused(() => version(k, w, m), { code: "23514", message: /conversion must equal the active unit conversion/ });
  await refused(() => version(k, w, m, { scale: "1", scale_divisor: "61", conversion_note: "Wrong" }), { code: "23514", message: /conversion must equal the active unit conversion/ });
  await refused(() => version(k, w, m, { scale: "1", scale_divisor: "60" }), { code: "23514", constraint: "source_metric_mapping_versions_note_when_units_differ" });
  const same = await mapping(k, w, f, await canonical(k, { unit: "s" }));
  await version(k, w, same);
  await refused(() => version(k, w, same, { scale: "2" }), { code: "23514", message: /equal units take the identity conversion/ });
  await refused(() => version(k, w, same, { offset: "1" }), { code: "23514", message: /equal units take the identity conversion/ });
  const noRow = await mapping(k, w, f, await canonical(k, { unit: "h" }));
  await refused(() => version(k, w, noRow, { scale: "1", scale_divisor: "3600", conversion_note: "Seconds to hours" }), { code: "23514", message: /active unit conversion/ });
  // The DB boundary of the normal form and finiteness (trigger off).
  for (const over of [{ scale: "2", scale_divisor: "2" }, { scale: "NaN" }, { scale_divisor: "Infinity" }, { offset: "NaN" }, { parameter_scale: "Infinity" }, { parameter_scale: "3", parameter_scale_divisor: "3" }, { scale: "-1" }, { parameter_scale: "-3.6" }]) {
    await inRolledBackTx(k, async () => {
      await k.query(`alter table training_load.source_metric_mapping_versions disable trigger source_metric_mapping_versions_insert_guard`);
      await refused(() => version(k, w, m, { ...minutes, owner_key: "system", parameter_fingerprint: "", ...over }), { code: "23514" });
    });
  }
  // C54: a negative factor is never a unit conversion (the CHECK, with the trigger off).
  await inRolledBackTx(k, async () => {
    await k.query(`alter table training_load.source_metric_mapping_versions disable trigger source_metric_mapping_versions_insert_guard`);
    await refused(() => version(k, w, m, { ...minutes, owner_key: "system", parameter_fingerprint: "", scale: "-1", scale_divisor: "1" }), { code: "23514", constraint: "source_metric_mapping_versions_scale_positive" });
  });
  await inRolledBackTx(k, async () => {
    await k.query(`alter table training_load.source_metric_mapping_versions disable trigger source_metric_mapping_versions_insert_guard`);
    await refused(() => version(k, w, m, {
      ...minutes, owner_key: "system", parameter_kind: "zone_bounds", parameter_fingerprint: `v1:${"0".repeat(64)}`,
      source_parameters: { operator: ">=", lower: 7, upper: null, unit: "m/s" }, canonical_parameters: { operator: ">=", lower: -25.2, upper: null, unit: "km/h" },
      parameter_scale: "-3.6", parameter_scale_divisor: "1",
    }), { code: "23514", constraint: "source_metric_mapping_versions_parameter_scale_positive" });
  });
  // The canonical version: numeric with a unit of 1-30 characters.
  const unitless = await mapping(k, w, f, await canonical(k, { unit: null }));
  await refused(() => version(k, w, unitless, { target_unit: "min", ...minutes }), { code: "23514", message: /canonical_unit_missing/ });
  const textMd = await mapping(k, w, f, await canonical(k, { unit: "min", valueType: "text" }));
  await refused(() => version(k, w, textMd, minutes), { code: "23514", message: /not numeric/ });
  await refused(() => version(k, w, m, { ...minutes, target_unit: "h" }), { code: "23514", message: /target unit must be the canonical version's unit/ });
  // C56: a canonical version whose unit is not a unit token is never a mapping
  // target; Metrics Core keeps the version unchanged.
  for (const bad of ["km h", "m\ts", "m|s", "a=b", "m\u00a0s", "m\u00ads", "m\u200bs", "m\u202es", "m\u2066s", "m\ufeffs"]) {
    const badMd = await canonical(k, { unit: bad });
    const badMapping = await mapping(k, w, f, badMd);
    await refused(() => version(k, w, badMapping, { ...minutes, target_unit: bad }), { code: "23514", message: /canonical_unit_not_a_token/ });
    assert.equal((await one(k, `select unit from training_load.metric_definition_versions where id = $1`, [badMd.versionId])).unit, bad, "the Metrics Core version is unchanged");
  }
  // The checked copy is a unit token by its own CHECK (trigger off).
  await inRolledBackTx(k, async () => {
    await k.query(`alter table training_load.source_metric_mapping_versions disable trigger source_metric_mapping_versions_insert_guard`);
    await refused(() => version(k, w, m, { ...minutes, owner_key: "system", parameter_fingerprint: "", target_unit: "km h" }), { code: "23514", constraint: "source_metric_mapping_versions_target_unit_token" });
  });
  // Levels.
  const sessionOnly = await field(k, w, { unit: "s", drill: false });
  const ms2 = await mapping(k, w, sessionOnly, await canonical(k, { unit: "min" }));
  await refused(() => version(k, w, ms2, minutes), { code: "23514", message: /outside the revision's levels/ });
  await version(k, w, ms2, { ...minutes, applies_to_drill: false });
  const noComponent = await mapping(k, w, f, await canonical(k, { unit: "min", caps: ["session"] }));
  await refused(() => version(k, w, noComponent, minutes), { code: "23514", message: /drill level is not a scope/ });
  FP = { f, md, m, v, mc, clubMd, minutes };
});

test("10. the parameter fingerprint (C32): computed by the database from the source parameters, equal to an independent computation, the same for 25 and 25.0 and for any key order, different for a different bound, never the caller's; the shape refuses an extra key, a text number, a bad operator and a bad unit; zone and threshold equivalence with multiplications only", async () => {
  const w = W;
  const speed = await field(k, w, { kind: "zone_bounds", unit: "m", boundUnit: "m/s", operator: ">=" });
  const sprint = await canonical(k, { unit: "m", cd: { operator: ">=", value: 25.2, unit: "km/h" } });
  const m = await mapping(k, w, speed, sprint);
  const zone = { parameter_kind: "zone_bounds", source_parameters: { operator: ">=", lower: 7, upper: null, unit: "m/s" }, canonical_parameters: { operator: ">=", lower: 25.2, upper: null, unit: "km/h" }, parameter_scale: "3.6", parameter_scale_divisor: "1", parameter_offset: "0" };
  const v1 = await version(k, w, m, zone);
  assert.equal(v1.parameter_fingerprint, fingerprintJs("zone_bounds", { operator: ">=", lower: 7, upper: null, unit: "m/s" }));
  assert.equal(v1.parameter_fingerprint, `v1:${crypto.createHash("sha256").update("zone_bounds|lower=7|operator=>=|unit=m/s|upper=null", "utf8").digest("hex")}`);
  const v2 = await version(k, w, m, { ...zone, source_parameters: `{"unit": "m/s", "upper": null, "lower": 7.000, "operator": ">="}` });
  assert.equal(v2.parameter_fingerprint, v1.parameter_fingerprint, "25 and 25.0, any key order");
  const forged = await version(k, w, m, { ...zone, parameter_fingerprint: `v1:${"0".repeat(64)}` });
  assert.equal(forged.parameter_fingerprint, v1.parameter_fingerprint, "never the caller's value");
  const plain = await version(k, w, FP.m, { ...FP.minutes, parameter_fingerprint: "v1:abc" });
  assert.equal(plain.parameter_fingerprint, "", "'' without parameters");
  // A different bound is a different fingerprint (one field, several zones).
  const sprint8 = await canonical(k, { unit: "m", cd: { operator: ">=", value: 28.8, unit: "km/h" } });
  const v8 = await version(k, w, await mapping(k, w, speed, sprint8), { ...zone, source_parameters: { operator: ">=", lower: 8, upper: null, unit: "m/s" }, canonical_parameters: { operator: ">=", lower: 28.8, upper: null, unit: "km/h" } });
  assert.notEqual(v8.parameter_fingerprint, v1.parameter_fingerprint);
  assert.equal(v8.parameter_fingerprint, fingerprintJs("zone_bounds", { operator: ">=", lower: 8, upper: null, unit: "m/s" }));
  // Shapes.
  for (const bad of [
    { ...zone.source_parameters, extra: 1 }, { ...zone.source_parameters, lower: "7" }, { ...zone.source_parameters, operator: "=>" },
    { ...zone.source_parameters, unit: "m s" }, { ...zone.source_parameters, unit: "m|s" }, { ...zone.source_parameters, unit: "m=s" }, { operator: ">=", lower: 7, unit: "m/s" },
    { ...zone.source_parameters, operator: "between" },
  ]) await refused(() => version(k, w, m, { ...zone, source_parameters: bad }), { code: "23514", message: /contract shape/ });
  // Equivalence and operator.
  await refused(() => version(k, w, m, { ...zone, source_parameters: { ...zone.source_parameters, lower: 7.1 } }), { code: "23514", message: /not equivalent/ });
  await refused(() => version(k, w, m, { ...zone, canonical_parameters: { ...zone.canonical_parameters, lower: 25.3 } }), { code: "23514", message: /equal the canonical condition description/ });
  await refused(() => version(k, w, m, { ...zone, source_parameters: { ...zone.source_parameters, operator: ">" }, canonical_parameters: { ...zone.canonical_parameters, operator: ">" } }), { code: "23514", message: /proven operator/ });
  await refused(() => version(k, w, m, { ...zone, parameter_scale: "1" }), { code: "23514", message: /not equivalent|bound conversion/ });
  await refused(() => version(k, w, m, { ...zone, parameter_scale: "36", parameter_offset: "0", parameter_scale_divisor: "1", source_parameters: { ...zone.source_parameters, lower: 0.7 } }), { code: "23514", message: /bound conversion must equal/ });
  const wrongCd = await mapping(k, w, speed, await canonical(k, { unit: "m", cd: { operator: ">=", value: 25.2, unit: "km/h", relative_to: "body_mass" } }));
  await refused(() => version(k, w, wrongCd, zone), { code: "23514", message: /no supported shape/ });
  // A closed power zone with equal bound units (identity) and a deceleration threshold (negative value, '<=').
  const power = await field(k, w, { kind: "zone_bounds", unit: "m", boundUnit: "W/kg", operator: "between" });
  const pz = await version(k, w, await mapping(k, w, power, await canonical(k, { unit: "m", cd: { operator: "between", min: 25, max: 60, unit: "W/kg" } })), {
    parameter_kind: "zone_bounds", source_parameters: { operator: "between", lower: 25, upper: 60, unit: "W/kg" }, canonical_parameters: { operator: "between", lower: 25, upper: 60, unit: "W/kg" },
  });
  assert.equal(pz.parameter_fingerprint, fingerprintJs("zone_bounds", { operator: "between", lower: 25, upper: 60, unit: "W/kg" }));
  const decel = await field(k, w, { kind: "event_threshold", unit: "count", boundUnit: "m/s²", operator: "<=" });
  const thr = { parameter_kind: "event_threshold", source_parameters: { operator: "<=", threshold_value: -2.5, duration_seconds: 0.3, unit: "m/s²" }, canonical_parameters: { operator: "<=", value: -2.5, duration_seconds: 0.3, unit: "m/s²" } };
  const dm = await mapping(k, w, decel, await canonical(k, { unit: "count", cd: { operator: "<=", value: -2.5, duration_seconds: 0.3, unit: "m/s²" } }));
  const dv = await version(k, w, dm, thr);
  assert.equal(dv.parameter_fingerprint, fingerprintJs("event_threshold", thr.source_parameters));
  await refused(() => version(k, w, dm, { ...thr, source_parameters: { ...thr.source_parameters, duration_seconds: 0.5 } }), { code: "23514", message: /not equivalent/ });
  await refused(() => version(k, w, dm, { ...thr, source_parameters: { ...thr.source_parameters, unit: "m/s2" } }), { code: "23514", message: /proven bound unit/ });
  FP.speed = { f: speed, m, md: sprint, zone };
});

test("11. T4 transitions: submitted by a platform admin or the mapping club's active admin, activated and disabled by an active platform admin only (42501); activation needs an active verified revision and the pinned version current, re-checks the levels under a lock; one active version per mapping; the active target is unique per owner (system and a club coexist); only the status changes; nothing leaves disabled; never deleted", async () => {
  const w = W;
  const { f, m, mc, minutes } = FP;
  // Club admin submission rules.
  const cv = await version(k, w, mc, minutes);
  await refused(() => submit(k, cv.id, w.adminB, "club_admin"), { code: "42501" });
  await refused(() => submit(k, cv.id, w.adminA, "platform_admin"), { code: "42501" });
  await submit(k, cv.id, w.adminA, "club_admin");
  const sysDraft = await version(k, w, m, minutes);
  await refused(() => submit(k, sysDraft.id, w.adminA, "club_admin"), { code: "42501" });
  const mdC = await canonical(k, { scope: "club", clubId: w.clubC, unit: "min" });
  const mC = await mapping(k, w, f, mdC, { scope: "club", clubId: w.clubC });
  const vC = await version(k, w, mC, minutes);
  await refused(() => submit(k, vC.id, w.adminC, "club_admin"), { code: "42501" }, "an archived club");
  for (const actor of [w.nobody, w.revoked, w.inactive]) await refused(() => submit(k, sysDraft.id, actor), { code: "42501" });
  await submit(k, sysDraft.id, w.pa);
  // Activation actors.
  for (const actor of [w.nobody, w.revoked, w.inactive, w.adminA]) await refused(() => activateVersion(k, sysDraft.id, actor), { code: "42501" });
  await refused(() => k.query(`update training_load.source_metric_mapping_versions set status = 'active', activated_by_user_id = $2, activated_at = now(), activated_basis = 'club_admin' where id = $1`, [cv.id, w.pa]), { code: "23514", constraint: "source_metric_mapping_versions_activated_basis_check" });
  await activateVersion(k, sysDraft.id, w.pa);
  await activateVersion(k, cv.id, w.pa);
  // Per owner: a system and a club version of the same field and parameters are both active...
  const owners = await rows(k, `select owner_key from training_load.source_metric_mapping_versions where status = 'active' and source_metric_definition_id = $1 order by 1`, [f.defId]);
  assert.deepEqual(owners.map((x) => x.owner_key).sort(), ["system", w.clubA].sort());
  // ...a second system target of the same field and parameters is not.
  const other = await mapping(k, w, f, await canonical(k, { unit: "min" }));
  const ov = await version(k, w, other, minutes);
  await submit(k, ov.id, w.pa);
  await refused(() => activateVersion(k, ov.id, w.pa), { code: "23505", constraint: "source_metric_mapping_versions_one_active_target_per_owner" });
  // A club B mapping of the same pair is its own owner.
  const mdB = await canonical(k, { scope: "club", clubId: w.clubB, unit: "min" });
  const bv = await activeVersion(k, w, await mapping(k, w, f, mdB, { scope: "club", clubId: w.clubB }), minutes);
  assert.equal(bv.owner_key, w.clubB);
  // One active version per mapping.
  const second = await version(k, w, m, minutes);
  await submit(k, second.id, w.pa);
  await refused(() => activateVersion(k, second.id, w.pa), { code: "23505", constraint: "source_metric_mapping_versions_one_active_per_mapping" });
  // Activation needs the pinned canonical version current, an active verified revision, and the levels (locked) still there.
  const mdOld = await canonical(k, { unit: "min" });
  const mOld = await mapping(k, w, f, mdOld);
  const pinned = await version(k, w, mOld, minutes);
  await submit(k, pinned.id, w.pa);
  const newer = (await one(k, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1, 2, 'min', 'numeric') returning id`, [mdOld.id])).id;
  await k.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [newer, mdOld.id]);
  await refused(() => activateVersion(k, pinned.id, w.pa), { code: "23514", message: /pinned version current/ });
  const halfProven = await field(k, w, { unit: "s", verify: false, activate: false });
  await verifyUnit(k, halfProven.revId, "s", null, w.pa);
  const hv = await version(k, w, await mapping(k, w, halfProven, await canonical(k, { unit: "min" })), minutes);
  await submit(k, hv.id, w.pa);
  await refused(() => activateVersion(k, hv.id, w.pa), { code: "23514", message: /active and verified/ });
  const levelMd = await canonical(k, { unit: "min" });
  const lv = await version(k, w, await mapping(k, w, f, levelMd), minutes);
  await k.query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'component'`, [levelMd.id]);
  await submit(k, lv.id, w.pa);
  await refused(() => activateVersion(k, lv.id, w.pa), { code: "23514", message: /drill level is not a scope/ });
  // A transition writes only its own facts: disabling adds no submission or activation that never happened.
  const forged = await version(k, w, m, minutes);
  const disableWith = (id, extra, params) => k.query(`update training_load.source_metric_mapping_versions set status = 'disabled', disabled_by_user_id = $2, disabled_at = now(), disabled_basis = 'platform_admin', disable_reason = 'Never used', ${extra} where id = $1`, [id, w.pa, ...params]);
  await refused(() => disableWith(forged.id, `submitted_by_user_id = $3, submitted_at = now(), submitted_basis = 'club_admin'`, [w.adminA]), { code: "23514", message: /written by their transition/ });
  await submit(k, forged.id, w.pa);
  await refused(() => disableWith(forged.id, `activated_by_user_id = $3, activated_at = now(), activated_basis = 'platform_admin'`, [w.pa]), { code: "23514", message: /written by their transition/ });
  await disableVersion(k, forged.id, w.pa);
  // Only the status changes; facts are written once; nothing leaves disabled; never deleted.
  await refused(() => k.query(`update training_load.source_metric_mapping_versions set scale_divisor = 61 where id = $1`, [sysDraft.id]), { code: "23514", message: /only the status/ });
  await refused(() => k.query(`update training_load.source_metric_mapping_versions set conversion_note = 'Other' where id = $1`, [sysDraft.id]), { code: "23514", message: /only the status/ });
  await refused(() => k.query(`update training_load.source_metric_mapping_versions set submitted_at = now() - interval '1 day' where id = $1`, [sysDraft.id]), { code: "23514", message: /written once/ });
  await refused(() => k.query(`update training_load.source_metric_mapping_versions set status = 'draft', submitted_by_user_id = null, submitted_at = null, submitted_basis = null where id = $1`, [second.id]), { code: "23514" });
  for (const actor of [w.nobody, w.revoked]) await refused(() => disableVersion(k, second.id, actor), { code: "42501" });
  await disableVersion(k, second.id, w.pa);
  await refused(() => k.query(`update training_load.source_metric_mapping_versions set status = 'active' where id = $1`, [second.id]), { code: "23514" });
  await refused(() => k.query(`delete from training_load.source_metric_mapping_versions where id = $1`, [second.id]), { code: "23514", message: /never deleted/ });
  FP.sysVersion = await one(k, `select * from training_load.source_metric_mapping_versions where id = $1`, [sysDraft.id]);
  FP.clubVersion = await one(k, `select * from training_load.source_metric_mapping_versions where id = $1`, [cv.id]);
});

test("12. decision 9 and section E: a canonical definition whose current version an active mapping version pins is neither re-pointed nor archived, and a level an active version applies to is not removed - until the version is disabled", async () => {
  const w = W;
  const { minutes } = FP;
  const g = await field(k, w, { unit: "s" });
  const md = await canonical(k, { unit: "min" });
  const v = await activeVersion(k, w, await mapping(k, w, g, md), minutes);
  const newer = (await one(k, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1, 2, 'min', 'numeric') returning id`, [md.id])).id;
  await refused(() => k.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [newer, md.id]), { code: "23514", message: /pins the current version/ });
  await refused(() => k.query(`update training_load.metric_definitions set state = 'archived' where id = $1`, [md.id]), { code: "23514", message: /pins the current version/ });
  await k.query(`update training_load.metric_definitions set label = 'Renamed is fine' where id = $1`, [md.id]);
  await refused(() => k.query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'session'`, [md.id]), { code: "23514", message: /applies to this level/ });
  await refused(() => k.query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'component'`, [md.id]), { code: "23514", message: /applies to this level/ });
  await refused(() => k.query(`update training_load.metric_definition_scope_capabilities set scope_level = 'day' where metric_definition_id = $1 and scope_level = 'session'`, [md.id]), { code: "23514", message: /applies to this level/ });
  await disableVersion(k, v.id, w.pa);
  await k.query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'component'`, [md.id]);
  await k.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [newer, md.id]);
});

test("13. T5: open only, on an active version with its own levels and an active binding of the field's source and API family; a club mapping only on a connection of that club, never a team-owned one; a system mapping on a team-owned connection only for its team; activated and ended by an active platform admin (42501); one open row per field and parameters and per canonical target and scope on a binding; ended rows immutable; never deleted; two concurrent activations leave one", async () => {
  const w = W;
  const { sysVersion, clubVersion, minutes, f } = FP;
  const bindA = await bindTeam(k, w, w.clubA);
  const bindB = await bindTeam(k, w, w.clubB);
  const bindTeamOwned = await bindTeam(k, w, w.clubA, { teamOwned: true });
  const bindE03 = await bindTeam(k, w, w.clubA, { hostKey: "e03" });
  await refused(async () => ins(k, "source_metric_mapping_activations", await activationRow(k, w, sysVersion.id, bindA, { ended_at: new Date(), ended_by_user_id: w.pa, ended_basis: "platform_admin", end_reason: "admin_ended" })), { code: "23514", message: /created open/ });
  await refused(async () => ins(k, "source_metric_mapping_activations", await activationRow(k, w, sysVersion.id, bindA, { applies_to_drill: false })), { code: "23514", message: /levels must be the mapping version's/ });
  await refused(async () => ins(k, "source_metric_mapping_activations", await activationRow(k, w, sysVersion.id, bindA, { requirement: null })), { code: "23502" });
  for (const actor of [w.nobody, w.revoked, w.inactive, w.adminA]) await refused(() => activation(k, w, sysVersion.id, bindA, { activated_by_user_id: actor }), { code: "42501" });
  await refused(() => activation(k, w, sysVersion.id, bindE03), { code: "23514", message: /API family/ });
  await refused(() => activation(k, w, clubVersion.id, bindB), { code: "23514", message: /connection owned by that club/ });
  await refused(() => activation(k, w, clubVersion.id, bindTeamOwned), { code: "23514", message: /connection owned by that club/ });
  const draftVersion = await version(k, w, FP.m, minutes);
  await refused(() => activation(k, w, draftVersion.id, bindA), { code: "23514", message: /only an active mapping version/ });
  const sysOnTeamOwned = await activation(k, w, sysVersion.id, bindTeamOwned);
  const sysOnA = await activation(k, w, sysVersion.id, bindA);
  // The platform admin's choice: a club mapping of the same field and parameters is refused on the same binding.
  await refused(() => activation(k, w, clubVersion.id, bindA), { code: "23505", constraint: "source_metric_activations_one_open_per_field" });
  // On one binding and scope a canonical variable has one activated source.
  const g = await field(k, w, { unit: "s" });
  const sameTarget = await activeVersion(k, w, await mapping(k, w, g, FP.md), minutes);
  await refused(() => activation(k, w, sameTarget.id, bindA), { code: "23505", constraint: "source_metric_activations_one_open_session_target" });
  const drillOnly = await field(k, w, { unit: "s" });
  const dv = await activeVersion(k, w, await mapping(k, w, drillOnly, FP.md), { ...minutes, applies_to_session: false });
  await refused(() => activation(k, w, dv.id, bindA), { code: "23505", constraint: "source_metric_activations_one_open_drill_target" });
  // An ended binding takes no activation.
  const ended = await bindTeam(k, w, w.clubA);
  await k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'Test' where id = $1`, [ended.bindingId, w.pa]);
  await refused(() => activation(k, w, sysVersion.id, ended), { code: "23514", message: /binding is not active/ });
  // A version with an open activation is not disabled.
  await refused(() => disableVersion(k, sysVersion.id, w.pa), { code: "23514", message: /open activation/ });
  // Ending: by an active platform admin, once; nothing else changes; never deleted.
  for (const actor of [w.nobody, w.revoked, w.inactive]) await refused(() => endActivation(k, sysOnTeamOwned.id, actor), { code: "42501" });
  await refused(() => k.query(`update training_load.source_metric_mapping_activations set requirement = 'required' where id = $1`, [sysOnTeamOwned.id]), { code: "23514", message: /only the end/ });
  await refused(() => k.query(`update training_load.source_metric_mapping_activations set ended_at = now(), ended_by_user_id = $2, ended_basis = 'platform_admin', end_reason = 'binding_ended' where id = $1`, [sysOnTeamOwned.id, w.pa]), { code: "23514", constraint: "source_metric_activations_end_reason_check" });
  await endActivation(k, sysOnTeamOwned.id, w.pa);
  await refused(() => k.query(`update training_load.source_metric_mapping_activations set end_reason = 'mapping_version_disabled' where id = $1`, [sysOnTeamOwned.id]), { code: "23514", message: /ended activation is immutable/ });
  await refused(() => k.query(`delete from training_load.source_metric_mapping_activations where id = $1`, [sysOnTeamOwned.id]), { code: "23514", message: /never deleted/ });
  // A team-owned connection hosts the system mapping for its own team again (one open row per field).
  await activation(k, w, sysVersion.id, bindTeamOwned);
  // Two concurrent activations of the same field on one binding: one wins, the other is the unique violation.
  const bindC = await bindTeam(k, w, w.clubA);
  const race = await interleave((a) => activation(a, w, sysVersion.id, bindC), (b) => activation(b, w, sysVersion.id, bindC));
  assert.ok(race.error, "the second concurrent activation is refused");
  assert.equal(race.error.code, "23505");
  assert.equal(race.error.constraint, "source_metric_activations_one_open_per_field");
  assert.equal((await one(k, `select count(*)::int as n from training_load.source_metric_mapping_activations where source_team_binding_id = $1 and ended_at is null`, [bindC.bindingId])).n, 1);
  FP.bindA = bindA;
  FP.actA = sysOnA;
  assert.ok(f);
});

test("14. T6: a fact is accepted only through an open activation, with the value of the pinned canonical version and target unit, the revision's source unit, the Metrics Core instance of the binding and the value's own occasion; the value is the source value converted at 9 decimals, half away from zero (exact, both neighbours, ties on both signs); append-only and not truncated; an ending and a fact never interleave", async () => {
  const w = W;
  const { sysVersion: ver, actA: act, bindA, md } = FP;
  const msc = await metricConnection(k, bindA.teamId, { instance: bindA.sourceTeam });
  const add = async (value, sourceValue, over = {}) => {
    const v = await valueRow(k, w, { teamId: bindA.teamId, mscId: over.valueMsc ?? msc, md: over.md ?? md, value, unit: over.unit });
    return ins(k, "metric_value_source_provenance", { ...provenanceRow(v.valueId, over.act ?? act, over.ver ?? ver, { mscId: over.msc ?? msc, sourceValue, sourceUnit: over.sourceUnit }) });
  };
  const p = await add("2", "120");
  assert.equal(p.source_unit, "s");
  await add("1.666666667", "100");
  await refused(() => add("1.666666666", "100"), { code: "23514", message: /converted at the storage scale/ });
  await refused(() => add("1.666666668", "100"), { code: "23514", message: /converted at the storage scale/ });
  await refused(() => add("1.6666666667", "100"), { code: "23514", message: /converted at the storage scale/ });
  await refused(() => add("2.000000001", "120"), { code: "23514", message: /converted at the storage scale/ });
  await add("2.000000000000", "120");
  // Ties at the 9th decimal: m -> km (0.001, 1, 0), 0.0000005 m = 0.0000000005 km exactly.
  const dist = await field(k, w, { unit: "m" });
  const kmMd = await canonical(k, { unit: "km" });
  const kmVer = await activeVersion(k, w, await mapping(k, w, dist, kmMd), { scale: "0.001", scale_divisor: "1", conversion_note: "Metres to kilometres" });
  const kmAct = await activation(k, w, kmVer.id, bindA);
  const km = { md: kmMd, ver: kmVer, act: kmAct };
  await add("0.000000001", "0.0000005", km);
  await refused(() => add("0", "0.0000005", km), { code: "23514", message: /storage scale/ });
  await add("-0.000000001", "-0.0000005", km);
  await refused(() => add("0", "-0.0000005", km), { code: "23514", message: /storage scale/ });
  await add("0.001", "1", km);
  // Consistency of the whole chain.
  await refused(() => add("2", "120", { unit: "h" }), { code: "23514", message: /target unit/ });
  await refused(() => add("2", "120", { sourceUnit: "ms" }), { code: "23514", message: /source unit must be the revision's proven unit/ });
  await refused(() => add("0.12", "120", { md: kmMd }), { code: "23514", message: /pinned canonical version/ });
  const otherInstance = await metricConnection(k, (await bindTeam(k, w, w.clubA)).teamId, { instance: "77777" });
  await refused(() => add("2", "120", { msc: otherInstance }), { code: "23514", message: /source instance must be the binding's/ });
  const noInstance = await metricConnection(k, (await bindTeam(k, w, w.clubA)).teamId, { instance: null });
  await refused(() => add("2", "120", { msc: noInstance }), { code: "23514", message: /source instance must be the binding's/ });
  await k.query(`update training_load.metric_source_connections set state = 'inactive' where id = $1`, [msc]);
  const msc2 = await metricConnection(k, bindA.teamId, { instance: bindA.sourceTeam });
  await refused(() => add("2", "120", { msc: msc2 }), { code: "23514", message: /same source instance/ });
  await k.query(`update training_load.metric_source_connections set state = 'inactive' where id = $1`, [msc2]);
  await k.query(`update training_load.metric_source_connections set state = 'active' where id = $1`, [msc]);
  await refused(() => add("2", "120", { ver: { ...ver, mapping_id: kmVer.mapping_id } }), { code: "23514", message: /mapping version's mapping and revision/ });
  await refused(() => add("2", "120", { act: kmAct }), { code: "23514", message: /activation does not match/ });
  // Append-only.
  await refused(() => k.query(`update training_load.metric_value_source_provenance set source_value_numeric = 121 where metric_value_id = $1`, [p.metric_value_id]), { code: "23514", message: /append-only; UPDATE refused/ });
  await refused(() => k.query(`delete from training_load.metric_value_source_provenance where metric_value_id = $1`, [p.metric_value_id]), { code: "23514", message: /append-only; DELETE refused/ });
  await refused(() => k.query(`truncate training_load.metric_value_source_provenance`), { code: "23514", message: /TRUNCATE refused/ });
  // C49: never through an ended activation, and never interleaved with the ending (both orders).
  // (1) the fact first: the ending waits for it (the activation is held FOR SHARE), then lands.
  const v1 = await valueRow(k, w, { teamId: bindA.teamId, mscId: msc, md: kmMd, value: "0.002" });
  const ending = await interleave(
    (a) => ins(a, "metric_value_source_provenance", provenanceRow(v1.valueId, kmAct, kmVer, { mscId: msc, sourceValue: "2" })),
    (b) => endActivation(b, kmAct.id, w.pa),
  );
  assert.ok(!ending.error, String(ending.error?.message));
  assert.equal((await one(k, `select count(*)::int as n from training_load.metric_value_source_provenance where metric_value_id = $1`, [v1.valueId])).n, 1);
  // (2) the ending first: the fact waits, then is refused.
  const act2 = await activation(k, w, kmVer.id, bindA);
  const v2 = await valueRow(k, w, { teamId: bindA.teamId, mscId: msc, md: kmMd, value: "0.003" });
  expectRefusedOutcome(await interleave(
    (a) => endActivation(a, act2.id, w.pa),
    (b) => ins(b, "metric_value_source_provenance", provenanceRow(v2.valueId, act2, kmVer, { mscId: msc, sourceValue: "3" })),
  ), /ended activation/);
  const late = await one(k, `select count(*)::int as n from training_load.metric_value_source_provenance p join training_load.source_metric_mapping_activations s on s.id = p.activation_id where s.ended_at is not null and p.recorded_at > s.ended_at`);
  assert.equal(late.n, 0, "no fact was recorded after its activation ended");
  FP.msc = msc;
  FP.km = km;
});

test("15. T7: the source instance of a Metrics Core connection is null together, in format, written once, and unique among active instances only (an ended instance and a new one may share it)", async () => {
  const w = W;
  const teamA = await newTeam(k, w.clubA);
  const teamB = await newTeam(k, w.clubB);
  await refused(() => ins(k, "metric_source_connections", { source_system: "gpexe", owner_scope: "team", owner_team_id: teamA, source_host_key: "server3" }), { code: "23514", constraint: "metric_source_connections_source_instance_together" });
  await refused(() => ins(k, "metric_source_connections", { source_system: "gpexe", owner_scope: "team", owner_team_id: teamA, source_host_key: "Server 3", source_instance_key: "1" }), { code: "23514", constraint: "metric_source_connections_source_host_key_format" });
  await refused(() => ins(k, "metric_source_connections", { source_system: "gpexe", owner_scope: "team", owner_team_id: teamA, source_host_key: "server3", source_instance_key: "a b" }), { code: "23514", constraint: "metric_source_connections_source_instance_key_format" });
  const first = await metricConnection(k, teamA, { instance: null });
  await k.query(`update training_load.metric_source_connections set source_host_key = 'server3', source_instance_key = '5555' where id = $1`, [first]);
  await refused(() => k.query(`update training_load.metric_source_connections set source_instance_key = '5556' where id = $1`, [first]), { code: "23514", message: /written once/ });
  await refused(() => k.query(`update training_load.metric_source_connections set source_host_key = null, source_instance_key = null where id = $1`, [first]), { code: "23514", message: /written once/ });
  await refused(() => metricConnection(k, teamB, { instance: "5555" }), { code: "23505", constraint: "metric_source_connections_one_active_instance" });
  await k.query(`update training_load.metric_source_connections set state = 'inactive' where id = $1`, [first]);
  await metricConnection(k, teamB, { instance: "5555" });
});

test("16. T8: one shape per action - its target columns, its from / to status, its reason or evidence where the contract needs them, a club admin only for a mapping, a version and a submission; request key and hash together, one request per key and per operation; an activation row names its own version and team; append-only", async () => {
  const w = W;
  const { f, m, sysVersion: ver, actA: act, bindA, msc } = FP;
  const conv = (await one(k, `select id from training_load.unit_conversions where from_unit = 's' and to_unit = 'min'`)).id;
  const targets = { sd: { source_metric_definition_id: f.defId }, sv: { source_metric_version_id: f.revId }, m: { mapping_id: m.id }, v: { mapping_version_id: ver.id }, a: { activation_id: act.id }, c: { unit_conversion_id: conv }, x: { metric_source_connection_id: msc }, t: { team_id: bindA.teamId } };
  const pick = (...names) => Object.assign({}, ...names.map((n) => targets[n]));
  const shapes = [
    ["source_metric_create", pick("sd"), null, "active", {}],
    ["source_metric_retire", pick("sd"), "active", "retired", { reason: true }],
    ["source_metric_revision_create", pick("sd", "sv"), null, "draft", {}],
    ["source_metric_unit_verified", pick("sd", "sv"), null, null, { evidence: true }],
    ["source_metric_meaning_verified", pick("sd", "sv"), null, null, { evidence: true }],
    ["source_metric_revision_activate", pick("sd", "sv"), "draft", "active", {}],
    ["source_metric_revision_retire", pick("sd", "sv"), "active", "retired", { reason: true }],
    ["mapping_create", pick("m"), null, null, { club: true }],
    ["mapping_version_create", pick("m", "v"), null, "draft", { club: true }],
    ["mapping_status", pick("m", "v"), "draft", "needs_review", { club: true }],
    ["mapping_status", pick("m", "v"), "needs_review", "active", {}],
    ["mapping_status", pick("m", "v"), "active", "disabled", { reason: true }],
    ["mapping_version_replaced", pick("m", "v"), "needs_review", "active", { reason: true }],
    ["activation_start", pick("v", "a", "t"), null, null, { reason: true }],
    ["activation_end", pick("v", "a", "t"), null, null, {}],
    ["unit_conversion_create", pick("c"), null, "active", { evidence: true }],
    ["unit_conversion_retire", pick("c"), "active", "retired", { reason: true }],
    ["source_instance_end", pick("x"), "active", "inactive", { reason: true }],
  ];
  const audit = (action, tg, from, to, extra = {}) => ins(k, "source_metric_audit", { action, ...tg, from_status: from, to_status: to, performed_by_user_id: w.pa, basis: "platform_admin", operation_id: crypto.randomUUID(), ...extra });
  const shapeErr = { code: "23514", constraint: "source_metric_audit_action_shape" };
  for (const [action, tg, from, to, need] of shapes) {
    const full = { ...(need.reason ? { reason: "Explained by the administrator" } : {}), ...(need.evidence ? { evidence_ref: COMPAT } : {}) };
    await audit(action, tg, from, to, full);
    // The club-admin basis: only for a club mapping (C45) and only where the action allows it.
    const asClub = { ...full, performed_by_user_id: w.adminA, basis: "club_admin" };
    const clubTg = { ...tg, ...(tg.mapping_id ? { mapping_id: FP.mc.id } : {}), ...(tg.mapping_id && tg.mapping_version_id ? { mapping_version_id: FP.clubVersion.id } : {}) };
    const notClubMapping = { code: "23514", message: /club-admin row names a club mapping/ };
    if (need.club) {
      await audit(action, clubTg, from, to, asClub);
      await refused(() => audit(action, tg, from, to, asClub), notClubMapping);
    } else {
      await refused(() => audit(action, clubTg, from, to, asClub), tg.mapping_id ? shapeErr : notClubMapping);
    }
    if (need.reason) await refused(() => audit(action, tg, from, to, { ...full, reason: null }), shapeErr);
    if (need.evidence) await refused(() => audit(action, tg, from, to, { ...full, evidence_ref: null }), shapeErr);
    // Without its first target (the activation's own consistency trigger answers first for an activation row).
    const missing = { ...tg };
    delete missing[Object.keys(tg)[0]];
    await refused(() => audit(action, missing, from, to, full), tg.activation_id ? { code: "23514" } : shapeErr);
    const extraTarget = Object.keys(targets).find((n) => !(Object.keys(targets[n])[0] in tg) && n !== "t");
    await refused(() => audit(action, { ...tg, ...targets[extraTarget] }, from, to, full), { code: "23514" });
    await refused(() => audit(action, tg, from === null ? "draft" : null, to, full), shapeErr);
  }
  await refused(() => audit("mapping_status", pick("m", "v"), "disabled", "active", { reason: "x" }), shapeErr);
  await refused(() => audit("source_metric_create", {}, null, "active"), shapeErr);
  await refused(() => audit("source_metric_create", pick("sd"), null, "deleted"), { code: "23514" });
  await refused(() => audit("not_an_action", pick("sd"), null, null), { code: "23514", constraint: "source_metric_audit_action_check" });
  await audit("source_instance_end", pick("x", "t"), "active", "inactive", { reason: "The team moved" });
  // An activation row names its own version and team.
  await refused(async () => audit("activation_end", { ...pick("v", "a"), team_id: await newTeam(k, w.clubA) }, null, null), { code: "23514", message: /its own mapping version and team/ });
  // The request record.
  const key = crypto.randomUUID();
  const hash = "a".repeat(64);
  const op = crypto.randomUUID();
  await audit("mapping_create", pick("m"), null, null, { operation_id: op, request_key: key, request_hash: hash });
  await audit("mapping_version_create", pick("m", "v"), null, "draft", { operation_id: op });
  await refused(() => audit("mapping_create", pick("m"), null, null, { request_key: key, request_hash: hash }), { code: "23505", constraint: "source_metric_audit_one_request_per_key" });
  await refused(() => audit("mapping_create", pick("m"), null, null, { operation_id: op, request_key: crypto.randomUUID(), request_hash: hash }), { code: "23505", constraint: "source_metric_audit_one_request_per_operation" });
  await refused(() => audit("mapping_create", pick("m"), null, null, { request_key: crypto.randomUUID() }), { code: "23514", constraint: "source_metric_audit_request_pair" });
  await refused(() => audit("mapping_create", pick("m"), null, null, { request_key: crypto.randomUUID(), request_hash: "A".repeat(64) }), { code: "23514", constraint: "source_metric_audit_request_hash_format" });
  await refused(() => audit("mapping_create", pick("m"), null, null, { reason: "two\nlines" }), { code: "23514", constraint: "source_metric_audit_reason_check" });
  const row = await audit("mapping_create", pick("m"), null, null);
  await refused(() => k.query(`update training_load.source_metric_audit set reason = 'x' where id = $1`, [row.id]), { code: "23514", message: /append-only; UPDATE refused/ });
  await refused(() => k.query(`delete from training_load.source_metric_audit where id = $1`, [row.id]), { code: "23514", message: /append-only; DELETE refused/ });
  await refused(() => k.query(`truncate training_load.source_metric_audit`), { code: "23514", message: /TRUNCATE refused/ });
  assert.ok(act && ver);
});

test("17. the disposable undo removes a value's provenance first, in the same transaction, and switches the provenance trigger on again before the commit", async () => {
  const w = W;
  const { msc, km, bindA } = FP;
  // Every earlier activation of this version on bindA was ended by test 14.
  const act = await activation(k, w, km.ver.id, bindA);
  const v = await valueRow(k, w, { teamId: bindA.teamId, mscId: msc, md: km.md, value: "0.004" });
  await ins(k, "metric_value_source_provenance", provenanceRow(v.valueId, act, km.ver, { mscId: msc, sourceValue: "4" }));
  const client = new pg.Client({ connectionString: mdb.url });
  await client.connect();
  let log;
  try {
    log = await undoImportedSession(client, { eventId: v.eventId }, { performedByUserId: w.pa, reason: "M1 undo of one test session", apply: true });
  } finally {
    await client.end();
  }
  assert.equal(log.removed.metric_value_source_provenance, 1);
  assert.equal(log.removed.metric_values, 1);
  assert.equal((await one(k, `select count(*)::int as n from training_load.metric_value_source_provenance where metric_value_id = $1`, [v.valueId])).n, 0);
  assert.equal((await one(k, `select tgenabled from pg_trigger where tgname = 'metric_value_source_provenance_append_only'`)).tgenabled, "O");
  await refused(() => k.query(`delete from training_load.metric_value_source_provenance`), { code: "23514", message: /append-only/ });
});

test("18. a seed marker is accepted only inside the seeding migration (42501 afterwards, on T2a, T2b and unit_conversions); a new catalog host row needs its API family, exactly as the v27 runbook now says", async () => {
  const w = W;
  const seedWindow = { code: "42501", message: /seed marker is accepted only from the seeding migration/ };
  for (const marker of [V34_NAME, "migrations_v2/209912312359_training_load_future_seed.sql"]) {
    await refused(() => ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.seed${uid()}`, source_label: "Seeded later", seed_migration: marker }), seedWindow);
    await refused(() => ins(k, "unit_conversions", { from_unit: `u${uid()}`, to_unit: "v", scale: "2", scale_divisor: "1", offset: "0", evidence_ref: D5, seed_migration: marker }), seedWindow);
  }
  const def = await ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.seedrev${uid()}`, source_label: "Seed rev", created_by_user_id: w.pa });
  for (const state of ["active", "draft"]) {
    await refused(() => ins(k, "source_metric_definition_versions", {
      source_metric_definition_id: def.id, revision_number: 1, value_shape: "number", parameter_kind: "none", supports_session: true, supports_drill: true,
      evidence_status: "observed", evidence_ref: COMPAT, state, activated_at: state === "active" ? new Date() : null, seed_migration: V34_NAME,
    }), seedWindow);
  }
  // The catalog: the v27 runbook's insert shape with api_family works; without it the database refuses.
  const runbook = fs.readFileSync(path.resolve(ROOT, "docs/runbooks/source-connections-v27.md"), "utf8");
  const step3 = /3\. One data-only migration: `insert into training_load\.source_host_catalog \(([^)]*)\)/.exec(runbook.replace(/\r?\n\s*/g, " "));
  assert.ok(step3, "the runbook's step 3 names its insert");
  assert.deepEqual(step3[1].split(",").map((x) => x.trim()), ["source_system", "host_key", "label", "note", "api_family"]);
  await k.query(`insert into training_load.source_host_catalog (source_system, host_key, label, note, api_family) values ('gpexe', 'e97', 'GPEXE e97 (test only)', 'test-only row', 'api')`);
  await refused(() => k.query(`insert into training_load.source_host_catalog (source_system, host_key, label, note) values ('gpexe', 'e96', 'GPEXE e96 (test only)', 'test-only row')`), { code: "23502" });
  await refused(() => k.query(`update training_load.source_host_catalog set api_family = 'rest_v1' where host_key = 'e97'`), { code: "23514", message: /API family of a host key is immutable/ });
});

test("19. the existing Metrics Core catalog writers work beside the v34 guards: a new semantic version, an archive and a level removal succeed with no active mapping version and are refused (23514, nothing changed) while one pins the definition", async () => {
  const w = W;
  const { catalog } = await appModules();
  {
    const req ={ user: { id: w.pa }, authz: { platformRoles: ["platform_admin"], clubRoles: [], teamRoles: [], managedTeamIds: [] } };
    // (a) Nothing pins these definitions.
    const free1 = await canonical(k, { unit: "min" });
    const v = await catalog.createDefinitionVersion(req, free1.id, { valueType: "numeric", unit: "min", reason: "New semantics" });
    assert.ok(v.row?.id, JSON.stringify(v));
    assert.equal((await one(k, `select current_version_id from training_load.metric_definitions where id = $1`, [free1.id])).current_version_id, v.row.id);
    const free2 = await canonical(k, { unit: "min" });
    assert.equal((await catalog.setDefinitionScopeCapabilities(req, free2.id, ["session"])).row.scope_capabilities.join(","), "session");
    assert.equal((await catalog.archiveDefinition(req, free2.id)).row.state, "archived");
    // (b) An active mapping version pins the current version and applies to both levels.
    const g = await field(k, w, { unit: "s" });
    const pinned = await canonical(k, { unit: "min" });
    await activeVersion(k, w, await mapping(k, w, g, pinned), FP.minutes);
    const before = await one(k, `select current_version_id, state from training_load.metric_definitions where id = $1`, [pinned.id]);
    const versionRows = async () => (await one(k, `select count(*)::int as n from training_load.metric_definition_versions where metric_definition_id = $1`, [pinned.id])).n;
    const versionsBefore = await versionRows();
    for (const write of [
      () => catalog.createDefinitionVersion(req, pinned.id, { valueType: "numeric", unit: "min" }),
      () => catalog.archiveDefinition(req, pinned.id),
      () => catalog.setDefinitionScopeCapabilities(req, pinned.id, ["session"]),
    ]) {
      const err = await write().then(() => null, (e) => e);
      assert.ok(err, "the catalog write is refused");
      assert.equal(err.code, "23514", err.message);
      triggerMessages.add(err.message);
    }
    assert.deepEqual(await one(k, `select current_version_id, state from training_load.metric_definitions where id = $1`, [pinned.id]), before, "nothing changed");
    assert.equal((await one(k, `select count(*)::int as n from training_load.metric_definition_scope_capabilities where metric_definition_id = $1`, [pinned.id])).n, 2);
    assert.equal(await versionRows(), versionsBefore, "the refused re-version leaves no version row behind");
  }
});

test("20. the serialization the lock order promises, both orders, with the second operation proven to wait: T5 insert vs version disable, version activation vs canonical repoint and vs a level removal, revision retirement vs version submission, field retirement vs revision insert", async () => {
  const w = W;
  const { minutes } = FP;
  const draftOf = async () => {
    const f = await field(k, w, { unit: "s" });
    const md = await canonical(k, { unit: "min" });
    return { f, md, v: await version(k, w, await mapping(k, w, f, md), minutes) };
  };
  // T5 insert vs disable.
  const t1 = await draftOf();
  await submit(k, t1.v.id, w.pa);
  await activateVersion(k, t1.v.id, w.pa);
  const bind1 = await bindTeam(k, w, w.clubA);
  expectRefusedOutcome(await interleave((a) => activation(a, w, t1.v.id, bind1), (b) => disableVersion(b, t1.v.id, w.pa)), /open activation/);
  const t2 = await draftOf();
  await submit(k, t2.v.id, w.pa);
  await activateVersion(k, t2.v.id, w.pa);
  const bind2 = await bindTeam(k, w, w.clubA);
  const row2 = await activationRow(k, w, t2.v.id, bind2);
  expectRefusedOutcome(await interleave((a) => disableVersion(a, t2.v.id, w.pa), (b) => ins(b, "source_metric_mapping_activations", row2)), /only an active mapping version/);
  // Activation vs canonical repoint.
  const newVersion = async (md) => (await one(k, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1, 2, 'min', 'numeric') returning id`, [md.id])).id;
  const repoint = (c, md, vid) => c.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [vid, md.id]);
  const t3 = await draftOf();
  await submit(k, t3.v.id, w.pa);
  const v3 = await newVersion(t3.md);
  expectRefusedOutcome(await interleave((a) => activateVersion(a, t3.v.id, w.pa), (b) => repoint(b, t3.md, v3)), /pins the current version/);
  const t4 = await draftOf();
  await submit(k, t4.v.id, w.pa);
  const v4 = await newVersion(t4.md);
  expectRefusedOutcome(await interleave((a) => repoint(a, t4.md, v4), (b) => activateVersion(b, t4.v.id, w.pa)), /pinned version current/);
  // Activation vs a level removal.
  const dropDrill = (c, md) => c.query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'component'`, [md.id]);
  const t5 = await draftOf();
  await submit(k, t5.v.id, w.pa);
  expectRefusedOutcome(await interleave((a) => activateVersion(a, t5.v.id, w.pa), (b) => dropDrill(b, t5.md)), /applies to this level/);
  const t6 = await draftOf();
  await submit(k, t6.v.id, w.pa);
  expectRefusedOutcome(await interleave((a) => dropDrill(a, t6.md), (b) => activateVersion(b, t6.v.id, w.pa)), /drill level is not a scope/);
  // Revision retirement vs version submission.
  const retireRev = (c, revId) => c.query(`update training_load.source_metric_definition_versions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Corrected' where id = $1`, [revId, w.pa]);
  const t7 = await draftOf();
  expectRefusedOutcome(await interleave((a) => submit(a, t7.v.id, w.pa), (b) => retireRev(b, t7.f.revId)), /submitted or active mapping version/);
  const t8 = await draftOf();
  expectRefusedOutcome(await interleave((a) => retireRev(a, t8.f.revId), (b) => submit(b, t8.v.id, w.pa)), /source revision is retired/);
  // Field retirement vs revision insert.
  const bareField = async () => ins(k, "source_metric_definitions", { source_system: "gpexe", api_family: "rest_v1", source_metric_key: `m1.test.bare${uid()}`, source_label: "Bare field", created_by_user_id: w.pa });
  const revRow = (defId) => ({ source_metric_definition_id: defId, revision_number: 1, value_shape: "number", parameter_kind: "none", supports_session: true, supports_drill: true, evidence_status: "unproven", created_by_user_id: w.pa });
  const retireDef = (c, defId) => c.query(`update training_load.source_metric_definitions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'No longer offered' where id = $1`, [defId, w.pa]);
  const d1 = await bareField();
  expectRefusedOutcome(await interleave((a) => ins(a, "source_metric_definition_versions", revRow(d1.id)), (b) => retireDef(b, d1.id)), /draft or active revision/);
  const d2 = await bareField();
  expectRefusedOutcome(await interleave((a) => retireDef(a, d2.id), (b) => ins(b, "source_metric_definition_versions", revRow(d2.id))), /only for an active source metric/);
});

test("21. C51: a canonical definition named by a mapping keeps its owner; an owner change and a mapping insert serialize on the definition row in both orders", async () => {
  const w = W;
  const reown = (c, md, clubId) => c.query(`update training_load.metric_definitions set owner_club_id = $2 where id = $1`, [md.id, clubId]);
  const f = await field(k, w, { unit: "s" });
  const md = await canonical(k, { scope: "club", clubId: w.clubA, unit: "min" });
  await reown(k, md, w.clubB);
  await reown(k, md, w.clubA);
  await mapping(k, w, f, md, { scope: "club", clubId: w.clubA });
  await refused(() => reown(k, md, w.clubB), { code: "23514", message: /keeps its owner/ });
  await refused(() => k.query(`update training_load.metric_definitions set owner_scope = 'system', owner_club_id = null where id = $1`, [md.id]), { code: "23514", message: /keeps its owner/ });
  await k.query(`update training_load.metric_definitions set label = 'Renamed, same owner' where id = $1`, [md.id]);
  // The mapping first: the owner change waits for it, then is refused.
  const fa = await field(k, w, { unit: "s" });
  const mda = await canonical(k, { scope: "club", clubId: w.clubA, unit: "min" });
  expectRefusedOutcome(await interleave((a) => mapping(a, w, fa, mda, { scope: "club", clubId: w.clubA }), (b) => reown(b, mda, w.clubB)), /keeps its owner/);
  // The owner change first: the mapping waits for it, then reads the new owner and is refused.
  const fb = await field(k, w, { unit: "s" });
  const mdb2 = await canonical(k, { scope: "club", clubId: w.clubA, unit: "min" });
  expectRefusedOutcome(await interleave((a) => reown(a, mdb2, w.clubB), (b) => mapping(b, w, fb, mdb2, { scope: "club", clubId: w.clubA })), /same club/);
});

test("22. C52: an activation locks and checks again the active unit conversion of its value pair and of its bound pair; a retired one fails it, a new active row with the same factors passes, equal units stay the identity, an active version is not changed by a later retirement; activation and retirement serialize in both orders", async () => {
  const w = W;
  const conv = (from, to, scale, div = "1") => ins(k, "unit_conversions", { from_unit: from, to_unit: to, scale, scale_divisor: div, offset: "0", evidence_ref: D5, created_by_user_id: w.pa });
  const retireConv = (c, id) => c.query(`update training_load.unit_conversions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Wrong factor' where id = $1`, [id, w.pa]);
  const valueDraft = async () => {
    const from = `ft${uid()}`;
    const to = `yd${uid()}`;
    const row = await conv(from, to, "1", "3");
    const f = await field(k, w, { unit: from });
    const md = await canonical(k, { unit: to });
    const v = await version(k, w, await mapping(k, w, f, md), { scale: "1", scale_divisor: "3", conversion_note: "Feet to yards" });
    await submit(k, v.id, w.pa);
    return { from, to, row, v };
  };
  const status = async (id) => (await one(k, `select status from training_load.source_metric_mapping_versions where id = $1`, [id])).status;
  // The value pair.
  const d1 = await valueDraft();
  await retireConv(k, d1.row.id);
  await refused(() => activateVersion(k, d1.v.id, w.pa), { code: "23514", message: /conversion must equal the active unit conversion/ });
  const replacement = await conv(d1.from, d1.to, "1", "3");
  await activateVersion(k, d1.v.id, w.pa);
  await retireConv(k, replacement.id);
  assert.equal(await status(d1.v.id), "active", "a later retirement changes no active version");
  // The bound pair.
  const b1 = `bu${uid()}`;
  const b2 = `bv${uid()}`;
  const boundRow = await conv(b1, b2, "2");
  const zf = await field(k, w, { kind: "zone_bounds", unit: "m", boundUnit: b1, operator: ">=" });
  const zmd = await canonical(k, { unit: "m", cd: { operator: ">=", value: 14, unit: b2 } });
  const zv = await version(k, w, await mapping(k, w, zf, zmd), {
    parameter_kind: "zone_bounds", source_parameters: { operator: ">=", lower: 7, upper: null, unit: b1 }, canonical_parameters: { operator: ">=", lower: 14, upper: null, unit: b2 }, parameter_scale: "2",
  });
  await submit(k, zv.id, w.pa);
  await retireConv(k, boundRow.id);
  await refused(() => activateVersion(k, zv.id, w.pa), { code: "23514", message: /bound conversion must equal the active unit conversion/ });
  // Equal units: the identity, no row needed.
  const same = await field(k, w, { unit: "s" });
  await activeVersion(k, w, await mapping(k, w, same, await canonical(k, { unit: "s" })));
  // The activation first: the retirement waits, then lands; the version stays active.
  const d3 = await valueDraft();
  const retiredAfter = await interleave((a) => activateVersion(a, d3.v.id, w.pa), (b) => retireConv(b, d3.row.id));
  assert.ok(!retiredAfter.error, String(retiredAfter.error?.message));
  assert.equal(await status(d3.v.id), "active");
  // The retirement first: the activation waits, then finds no active row.
  const d4 = await valueDraft();
  expectRefusedOutcome(await interleave((a) => retireConv(a, d4.row.id), (b) => activateVersion(b, d4.v.id, w.pa)), /conversion must equal the active unit conversion/);
  assert.equal(await status(d4.v.id), "needs_review");
});

test("23. C55: a new fact needs an open activation, an active binding and an active Metrics Core instance of one chain, a value of the binding's team at a level the activation covers; an ending of the binding or of the instance serializes with a new fact in both orders and never changes an existing fact; the real Unbind waits for a fact in flight only up to its row lock_timeout and answers try_again (C58)", async () => {
  const w = W;
  const { minutes } = FP;
  const setup = async ({ session = true, drill = true, caps } = {}) => {
    const f = await field(k, w, { unit: "s" });
    const md = await canonical(k, { unit: "min", ...(caps ? { caps } : {}) });
    const ver = await activeVersion(k, w, await mapping(k, w, f, md), { ...minutes, applies_to_session: session, applies_to_drill: drill });
    const bind = await bindTeam(k, w, w.clubA);
    const act = await activation(k, w, ver.id, bind);
    const msc = await metricConnection(k, bind.teamId, { instance: bind.sourceTeam });
    return { md, ver, bind, act, msc };
  };
  const value = (s, extra = {}) => valueRow(k, w, { teamId: s.bind.teamId, mscId: s.msc, md: s.md, value: "2", ...extra });
  const fact = (c, s, valueId) => ins(c, "metric_value_source_provenance", provenanceRow(valueId, s.act, s.ver, { mscId: s.msc, sourceValue: "120" }));
  const endBinding = (c, s) => c.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'Test ending' where id = $1`, [s.bind.bindingId, w.pa]);
  const endInstance = (c, s) => c.query(`update training_load.metric_source_connections set state = 'inactive' where id = $1`, [s.msc]);
  const factCount = async (valueId) => (await one(k, `select count(*)::int as n from training_load.metric_value_source_provenance where metric_value_id = $1`, [valueId])).n;
  // Levels: a session value and a drill value each only where the activation
  // covers it; a day-level value never. Metrics Core takes a drill
  // (component) value only under a confirmed activity component link, a chain
  // M1 does not build: a drill value is inserted in a transaction that is
  // always rolled back, without that one Metrics Core check, every v34
  // trigger still in force.
  const drillTx = (fn) => inRolledBackTx(k, async () => {
    await k.query(`alter table training_load.metric_values disable trigger metric_values_check_scope_capability`);
    return fn();
  });
  const levelRefusal = { code: "23514", message: /level is not one the activation covers/ };
  const both = await setup({ caps: ["session", "component", "day"] });
  await fact(k, both, (await value(both)).valueId);
  await drillTx(async () => fact(k, both, (await value(both, { drill: true })).valueId));
  const dayValue = (await value(both, { scopeLevel: "day" })).valueId;
  await refused(() => fact(k, both, dayValue), levelRefusal);
  const sessionOnly = await setup({ drill: false });
  await fact(k, sessionOnly, (await value(sessionOnly)).valueId);
  await drillTx(async () => {
    const drillValue = (await value(sessionOnly, { drill: true })).valueId;
    await refused(() => fact(k, sessionOnly, drillValue), levelRefusal);
  });
  const drillOnly = await setup({ session: false });
  const sessionValue = (await value(drillOnly)).valueId;
  await refused(() => fact(k, drillOnly, sessionValue), levelRefusal);
  await drillTx(async () => fact(k, drillOnly, (await value(drillOnly, { drill: true })).valueId));
  // The value's event belongs to the binding's team.
  const otherTeam = await newTeam(k, w.clubA);
  const foreign = await valueRow(k, w, { teamId: otherTeam, mscId: await metricConnection(k, otherTeam, { instance: null }), md: both.md, value: "2" });
  await refused(() => fact(k, both, foreign.valueId), { code: "23514", message: /binding's team/ });
  // An ended binding and an inactive instance take no new fact.
  const eb = await setup();
  const ebValue = await value(eb);
  await endBinding(k, eb);
  await refused(() => fact(k, eb, ebValue.valueId), { code: "23514", message: /ended binding/ });
  const ei = await setup();
  const eiValue = await value(ei);
  await endInstance(k, ei);
  await refused(() => fact(k, ei, eiValue.valueId), { code: "23514", message: /inactive source instance/ });
  // The binding's ending vs a new fact, both orders.
  const ba = await setup();
  const baValue = await value(ba);
  const baEnding = await interleave((a) => fact(a, ba, baValue.valueId), (b) => endBinding(b, ba));
  assert.ok(!baEnding.error, String(baEnding.error?.message));
  assert.equal(await factCount(baValue.valueId), 1, "the fact written first stays after the ending");
  const bb = await setup();
  const bbValue = await value(bb);
  expectRefusedOutcome(await interleave((a) => endBinding(a, bb), (b) => fact(b, bb, bbValue.valueId)), /ended binding/);
  // The instance's ending vs a new fact, both orders.
  const ia = await setup();
  const iaValue = await value(ia);
  const iaEnding = await interleave((a) => fact(a, ia, iaValue.valueId), (b) => endInstance(b, ia));
  assert.ok(!iaEnding.error, String(iaEnding.error?.message));
  assert.equal(await factCount(iaValue.valueId), 1, "the fact written first stays after the ending");
  const ib = await setup();
  const ibValue = await value(ib);
  expectRefusedOutcome(await interleave((a) => endInstance(a, ib), (b) => fact(b, ib, ibValue.valueId)), /inactive source instance/);
  // C58: the real Unbind (backend/src/sourceConnectionService.js, unchanged)
  // against a fact already in flight. Its wait on the binding row is bounded
  // by the existing row lock_timeout and answers try_again with nothing
  // changed; once the fact has committed, the same request ends the binding,
  // the fact stays, and a later fact through the ended binding is refused.
  const { sources } = await appModules();
  const ctx = { userId: w.pa, basis: "platform_admin", workspace: { type: "platform" } };
  const ub = await setup();
  const ubValue = await value(ub);
  const requestKey = crypto.randomUUID();
  const unbind = () => sources.unbindTeam({
    ctx, sourceSystem: "gpexe", id: ub.bind.connectionId, bindingId: ub.bind.bindingId,
    body: { requestKey, reason: "Test ending", expected: { teamId: ub.bind.teamId, sourceTeamId: ub.bind.sourceTeam } },
  });
  const holder = new pg.Client({ connectionString: mdb.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await fact(holder, ub, ubValue.valueId);
    const started = Date.now();
    const busy = await unbind().then(() => null, (e) => e);
    const waited = Date.now() - started;
    assert.equal(busy?.code, "try_again", String(busy?.message));
    assert.ok(waited >= sources.ROW_LOCK_TIMEOUT_MS - 250 && waited < sources.ROW_LOCK_TIMEOUT_MS + 8_000, `a bounded wait (${waited} ms)`);
    assert.equal((await one(k, `select state from training_load.source_team_bindings where id = $1`, [ub.bind.bindingId])).state, "active", "nothing changed");
    await holder.query("commit");
  } finally {
    await holder.end().catch(() => {});
  }
  const done = await unbind();
  assert.equal(done.binding.state, "ended");
  assert.equal(await factCount(ubValue.valueId), 1, "the fact written first stays");
  const late = await value(ub);
  await refused(() => fact(k, ub, late.valueId), { code: "23514", message: /ended binding/ });
});

test("24. every trigger refusal seen in this file is a fixed message of the migration: no id, no value, no source answer", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const templates = [...sql.matchAll(/raise exception '((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
  assert.ok(templates.length > 40, `the migration's messages are read (${templates.length})`);
  const patterns = templates.map((tpl) => new RegExp(`^${tpl.split("%").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[A-Za-z_]+")}$`));
  assert.ok(triggerMessages.size > 30, `refusals were collected (${triggerMessages.size})`);
  for (const message of triggerMessages) {
    assert.ok(patterns.some((p) => p.test(message)), `a fixed message: ${message}`);
    assert.doesNotMatch(message, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "no id");
  }
});

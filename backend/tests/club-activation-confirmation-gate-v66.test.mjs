// J18, slice 18-3 - migration v66 (M-B): the gate on a club admin's activation of a
// mapping version of a field without parameters, and R8's proof that the save of
// section 4.3 is ONE transaction. Contract: docs/ai/c112-drag-mapping-contract.md
// (J18), sections 4.3, 5.5, 9.1 item 7, 15.3 and 15.5. Disposable
// optimove_tests_gpexe_* databases only; every row is a test row of this file.
import { after, before, test } from "node:test";
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
const V66 = "202611131000_training_load_v66_club_activation_confirmation_gate.sql";
const V66_NAME = `migrations_v2/${V66}`;
const BEFORE_V66 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V66));
const V65_NAME = `migrations_v2/${BEFORE_V66.find((m) => m.includes("_v65_"))}`;
// MT-A's migration: merged after v66 and on production before it, and later than v66 by file name. The rehearsal
// database therefore holds it before v66 is applied, exactly as production does.
const V67 = "202611131200_training_load_v67_gpexe_track_choices.sql";
const V67_NAME = `migrations_v2/${V67}`;
const V66_FILE = path.resolve(ROOT, "migrations_v2", V66);
const RUNBOOKS = path.resolve(ROOT, "docs/runbooks");
const ROLLBACK = path.join(RUNBOOKS, "club-activation-confirmation-gate-v66-rollback.sql");
const PREFLIGHT = path.join(RUNBOOKS, "club-activation-confirmation-gate-v66-preflight.sql");
const POSTCHECK = path.join(RUNBOOKS, "club-activation-confirmation-gate-v66-postcheck.sql");
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const T4 = "training_load.source_metric_mapping_versions";
const T5 = "training_load.source_metric_mapping_activations";
const T8 = "training_load.source_metric_audit";
const T9 = "training_load.source_metric_confirmations";
const T9S = "training_load.source_metric_confirmation_sessions";
const T9I = "training_load.source_metric_confirmation_items";
let rdb, db, r, k, server, apiBase, dbModule, appPool, createSession;
const W = {};
const originalConsole = {};

async function migrate(url, files, { extra = null } = {}) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v66-migrations-"));
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
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V66), "v66 is a test migration");
  assert.equal(BEFORE_V66.at(-1), V67, "the database v66 is applied to holds v67, as production's does");
  assert.ok(BEFORE_V66.at(-2).includes("_v65_"), "v66's own previous migration is v65");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v66rb", migrations: BEFORE_V66 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v66", migrations: [...BEFORE_V66, V66] }),
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
    console[level] = (...args) => { if (process.env.V66_DEBUG) originalConsole[level](...args); };
  }
  const serverModule = await import("../src/server.js");
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

// ---------------------------------------------------------------------------
// helpers (the 7h suite's, J14 section 10)
// ---------------------------------------------------------------------------
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const key = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString("hex");
const client = async (url = db.url) => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; };

async function post(p, cookie, body) {
  const res = await fetch(`${apiBase}${PREFIX}${p}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
async function user(label, { active = true } = {}) {
  return (await one(k, `insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,$3) returning id`, [`${label}-${uid()}@test.local`, label, active])).id;
}
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
async function platformAdmin() {
  const id = await user("platform-admin");
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await workspace(id, "platform", null);
  return { id, basis: "platform_admin", cookie: await cookieFor(id) };
}
async function clubAdmin(clubId) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await workspace(id, "club", clubId);
  return { id, basis: "club_admin", clubId, cookie: await cookieFor(id) };
}
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const newTeam = async (clubId) => (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;

const connectionOf = new Map();
let gpexeTeamCounter = 0;
async function connection(clubId) {
  if (!connectionOf.has(clubId)) {
    connectionOf.set(clubId, (await one(k,
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                                credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','club',$1,'server3','v66 test','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
      [clubId, W.pa.id, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id);
  }
  return connectionOf.get(clubId);
}
async function binding(clubId, { teamOwned = false } = {}) {
  const teamId = await newTeam(clubId);
  gpexeTeamCounter += 1;
  const sourceTeamId = String(970000 + gpexeTeamCounter);
  const connectionId = teamOwned
    ? (await one(k,
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_team_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                                credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','team',$1,'server3','v66 team test','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
      [teamId, W.pa.id, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id
    : await connection(clubId);
  await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)`, [teamId, sourceTeamId, W.pa.id]);
  const bindingId = (await one(k,
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
     values ($1,$2,'gpexe',$3,$4,$1) returning id`, [teamId, connectionId, sourceTeamId, W.pa.id])).id;
  return { bindingId, teamId, clubId, connectionId, sourceTeamId };
}
// A succeeded check of the binding's team (read through the binding unless told otherwise).
async function check(b, { via = b, status = "succeeded", teamId = b.teamId } = {}) {
  return (await one(k,
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id,
                                                    source_path, source_connection_id, source_binding_id, source_team_id, source_host_key)
     values ($1,$2,$3::text,'2026-09-14','2026-09-14', case when $3::text = 'running' then null else now() end, $4, 'source_connection', $5, $6, $4, 'server3') returning id`,
    [teamId, W.pa.id, status, via.sourceTeamId, via.connectionId, via.bindingId])).id;
}
let sessionCounter = 0;
// A stored session of the binding's team, last seen by `checkId`.
async function candidate(b, checkId, { startedAt = "2026-09-14T18:08:12Z" } = {}) {
  sessionCounter += 1;
  return one(k,
    `insert into training_load.gpexe_import_candidates (owner_team_id, gpexe_team_session_id, session_started_at, session_label, bundle_hash,
                                                        raw_bundle, raw_expires_at, status, first_seen_check_id, last_seen_check_id, drill_parameter_effect)
     values ($1, $2, $3, 'S', $4, '{}'::jsonb, now() + interval '30 days', 'pending', $5, $5, 'confirmed')
     returning id, gpexe_team_session_id, bundle_hash, session_started_at, last_seen_check_id`,
    [b.teamId, String(880000 + sessionCounter), startedAt, hash(), checkId]);
}
// A stored session with its check: what a save reads from.
async function stored(b, opts = {}) {
  const checkId = await check(b);
  return { b, checkId, cand: await candidate(b, checkId, opts) };
}
// A canonical variable through the M3-0 API (numeric, both levels), in minutes.
async function variable(owner, unit = "min") {
  const res = await post("/variables", owner.cookie, { requestKey: key(), label: `Variable ${uid()}`, unit, levels: ["session", "drill"], dailyAggregationMethod: "sum" });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.variable.id };
}
// A test field of gpexe / rest_v1 in seconds; verified unless told otherwise.
async function field({ verified = true } = {}) {
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'v66 test field',$2) returning id`,
    [`v66.test.f${uid()}`, W.pa.id])).id;
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: "number", parameterKind: "none", evidenceRef: COMPAT, unit: "s", unitRef: UNIT_REF, meaning: verified, meaningRef: verified ? MEANING_REF : undefined, state: "active" });
  return { fieldId, revId };
}
// An active mapping version (s -> min, so the stored value is the raw one / 60),
// created, submitted and activated through the real routes by `owner`.
async function activeVersion(owner, { f = null, target = null, activate = true } = {}) {
  f ??= await field();
  target ??= await variable(owner);
  const m = await post("/mappings", owner.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id });
  assert.equal(m.status, 201, m.text);
  const mappingId = m.body.mapping.id;
  const v = await post(`/mappings/${mappingId}/versions`, owner.cookie, { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true, conversionNote: "Converted by the active unit conversion." });
  assert.equal(v.status, 201, v.text);
  const versionId = v.body.version.id;
  assert.equal((await post(`/mappings/${mappingId}/versions/${versionId}/submit`, owner.cookie, { requestKey: key() })).status, 200);
  if (activate) {
    const a = await post(`/mappings/${mappingId}/versions/${versionId}/activate`, owner.cookie, { requestKey: key(), expectedActiveVersionId: null });
    assert.equal(a.status, 200, a.text);
  }
  return { mappingId, versionId, ...f, target };
}
const versionRow = (id) => one(k, `select * from ${T4} where id = $1`, [id]);
async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.pa = await platformAdmin();
  W.caA = await clubAdmin(W.clubA);
  W.caA2 = await clubAdmin(W.clubA);
  W.caB = await clubAdmin(W.clubB);
  // A platform admin who works in club A's workspace (7h: the basis stays platform_admin).
  W.paA = await platformAdmin();
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [W.paA.id, W.clubA]);
  await workspace(W.paA.id, "club", W.clubA);
  W.bA = await binding(W.clubA);
  W.bB = await binding(W.clubB);
  W.sA = await stored(W.bA);
}

// ---------------------------------------------------------------------------
// The raw save: section 4.3 step 16, in its order, in ONE transaction that is
// committed for real (no SET CONSTRAINTS: the deferred links run at COMMIT).
//   16.1 each missing T3 + mapping_create; each T4 draft + mapping_version_create;
//        draft -> needs_review + mapping_status
//   16.2 the listed T5 ends + activation_end
//   16.3 T9, T9s, T9i
//   16.4 needs_review -> active + mapping_status   <- the gate
//   16.5 the T5 starts + activation_start
//   16.6 the keyed mapping_confirmation row
// `rows`: [{ f, target, checked = true, existing = null }] - a new mapping of
// (field, variable) of the actor's club, or an existing needs_review version.
// ---------------------------------------------------------------------------
const START_REASON = "Switched on by drag and drop; two athletes checked in GPEXE.";
const END_REASON = "Replaced on the drag-and-drop board.";
async function rawSave(actor, o = {}) {
  const c = o.client ?? await client();
  const b = o.binding ?? W.bA;
  const s = o.stored ?? W.sA;
  const basis = o.basis ?? actor.basis;
  const operationId = crypto.randomUUID();
  const out = { ok: false, error: null, operationId, confirmationId: null, versions: [], activations: [] };
  const audit = (action, cols, values) => c.query(
    `insert into ${T8} (action, ${cols.join(", ")}, performed_by_user_id, basis, operation_id) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}, $${cols.length + 2}, $${cols.length + 3}, $${cols.length + 4})`,
    [action, ...values, actor.id, basis, operationId]);
  try {
    await c.query("begin");
    await c.query(CTX, [actor.id]);
    if (o.before) await o.before(c);
    // 16.1
    for (const row of o.rows) {
      if (row.existing) { out.versions.push({ ...row.existing, row }); continue; }
      const mappingId = (await one(c,
        `insert into training_load.source_metric_mappings (source_metric_definition_id, source_system, api_family, metric_definition_id, owner_scope, owner_club_id, created_by_user_id)
         select d.id, d.source_system, d.api_family, $2, 'club', $3, $4 from training_load.source_metric_definitions d where d.id = $1 returning id`,
        [row.f.fieldId, row.target.id, actor.clubId ?? W.clubA, actor.id])).id;
      await audit("mapping_create", ["mapping_id"], [mappingId]);
      const versionId = (await one(c,
        `insert into ${T4} (mapping_id, source_metric_definition_id, metric_definition_id, source_metric_version_id, version_number, metric_definition_version_id,
            conversion_kind, scale, scale_divisor, "offset", source_unit, target_unit, conversion_note, parameter_kind,
            source_parameters, canonical_parameters, parameter_scale, parameter_scale_divisor, parameter_offset, applies_to_session, applies_to_drill, created_by_user_id)
         select $1, $2, $3, $4, 1, d.current_version_id, 'numeric_linear', 1, 60, 0, 's', 'min', 'Converted by OptiMove''s active unit conversion.', 'none',
                '{}'::jsonb, '{}'::jsonb, 1, 1, 0, true, true, $5
           from training_load.metric_definitions d where d.id = $3 returning id`,
        [mappingId, row.f.fieldId, row.target.id, row.f.revId, actor.id])).id;
      await audit("mapping_version_create", ["mapping_id", "mapping_version_id", "to_status"], [mappingId, versionId, "draft"]);
      await c.query(`update ${T4} set status = 'needs_review', submitted_by_user_id = $2, submitted_at = clock_timestamp(), submitted_basis = $3 where id = $1`, [versionId, actor.id, basis]);
      await audit("mapping_status", ["mapping_id", "mapping_version_id", "from_status", "to_status"], [mappingId, versionId, "draft", "needs_review"]);
      out.versions.push({ mappingId, versionId, row });
    }
    // 16.2
    for (const e of o.replaces ?? []) {
      await c.query(`update ${T5} set ended_at = now(), ended_by_user_id = $2, ended_basis = $3, end_reason = 'admin_ended' where id = $1`, [e.activationId, actor.id, basis]);
      await audit("activation_end", ["mapping_version_id", "activation_id", "team_id", "reason"], [e.versionId, e.activationId, b.teamId, END_REASON]);
    }
    // 16.3
    if (o.confirmation !== false) {
      if (o.savepoint) await c.query("savepoint s1");
      out.confirmationId = (await one(c,
        `insert into ${T9} (operation_id, kind, owner_scope, owner_club_id, binding_id, team_id, credential_connection_id, confirmed_by_user_id, confirmed_basis, confirmed_at, attested, display_registry_version, values_expire_at)
         values ($1,'team_mapping','club',$2,$3,$4,$5,$6,$7,now(),$8,1,now()) returning id`,
        [operationId, b.clubId, b.bindingId, b.teamId, b.connectionId, actor.id, basis, out.versions.some((v) => v.row.checked !== false)])).id;
      await c.query(`insert into ${T9S} (confirmation_id, session_ordinal, candidate_id, candidate_bundle_hash, gpexe_team_session_id, session_started_at, check_id, team_id, pair_index)
                     values ($1,1,$2,$3,$4,$5,$6,$7,0)`, [out.confirmationId, s.cand.id, s.cand.bundle_hash, s.cand.gpexe_team_session_id, s.cand.session_started_at, s.checkId, b.teamId]);
      let n = 0;
      for (const v of out.versions) {
        if (v.row.item === false) continue;
        n += 1;
        const checked = v.row.checked !== false;
        const facts = await one(c, `select * from ${T4} where id = $1`, [v.row.itemVersionId ?? v.versionId]);
        await c.query(`insert into ${T9I} (confirmation_id, session_ordinal, item_no, item_kind, checked, source_metric_version_id, mapping_version_id, parameter_fingerprint, source_unit, target_unit,
                         scale, scale_divisor, "offset", compared_level, gpexe_display_rule, gpexe_display_unit, raw_a, stored_a, raw_b, stored_b)
                       values ($1,1,$2,'club_mapping',$3,$4,$5,$6,$7,$8,$9,$10,$11,'session',$12,$13,$14,$15,$16,$17)`,
        [out.confirmationId, n, checked, facts.source_metric_version_id, facts.id, facts.parameter_fingerprint, facts.source_unit, facts.target_unit,
          facts.scale, facts.scale_divisor, facts.offset, checked ? "duration_mmss" : null, checked ? "mm:ss" : null,
          checked ? "120" : null, checked ? "2" : null, checked ? "300" : null, checked ? "5" : null]);
      }
      if (o.savepoint) await c.query("release savepoint s1");
    }
    // 16.4
    for (const v of out.versions) {
      await c.query(`update ${T4} set status = 'active', activated_by_user_id = $2, activated_at = clock_timestamp(), activated_basis = $3 where id = $1`, [v.versionId, actor.id, basis]);
      await audit("mapping_status", ["mapping_id", "mapping_version_id", "from_status", "to_status"], [v.mappingId, v.versionId, "needs_review", "active"]);
    }
    // 16.5
    for (const v of out.versions) {
      const row = await one(c, `select * from ${T4} where id = $1`, [v.versionId]);
      const id = (await one(c, `insert into ${T5} (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint,
                                   source_team_binding_id, team_id, applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
                                 values ($1,$2,$3,$4,$5,$6,$7,true,true,'required',$8,$9,$10) returning id`,
      [v.versionId, v.mappingId, row.source_metric_definition_id, row.metric_definition_id, row.parameter_fingerprint, b.bindingId, b.teamId, actor.id, basis, START_REASON])).id;
      await audit("activation_start", ["mapping_version_id", "activation_id", "team_id", "reason"], [v.versionId, id, b.teamId, START_REASON]);
      out.activations.push(id);
    }
    // 16.6
    if (out.confirmationId) {
      await c.query(`insert into ${T8} (action, team_id, confirmation_id, performed_by_user_id, basis, operation_id, request_key, request_hash) values ('mapping_confirmation',$1,$2,$3,$4,$5,$6,$7)`,
        [b.teamId, out.confirmationId, actor.id, basis, operationId, key(), hash()]);
    }
    await c.query("commit");
    out.ok = true;
  } catch (error) {
    out.error = error;
    await c.query("rollback").catch(() => {});
  } finally {
    if (!o.client) await c.end().catch(() => {});
  }
  return out;
}
const GATE_TEXT = "source_metric_mapping_versions: a club admin switches a version of a field without parameters on from the drag-and-drop board";
const gateRefused = (out) => assert.deepEqual([out.ok, out.error?.code, out.error?.message], [false, "23514", GATE_TEXT]);
const statusOf = async (versionId) => (await versionRow(versionId)).status;
// A needs_review version of the club, through the real routes.
const waiting = (owner, opts = {}) => activeVersion(owner, { ...opts, activate: false });
async function planted(c, fn) {
  await c.query("set local session_replication_role = replica");
  try { return await fn(); } finally { await c.query("set local session_replication_role = origin").catch(() => {}); }
}

// ---------------------------------------------------------------------------
// 1. R8: the save is ONE transaction
// ---------------------------------------------------------------------------
test("1. R8: the whole save of section 4.3 step 16 commits as ONE transaction with every guard, the gate and every deferred link on - new mappings, their versions through both transitions, a replaced activation, the confirmation and the starts", async () => {
  // What is on before: club A's version of another field onto variable X (it will be replaced).
  const x = await variable(W.caA);
  const before = await rawSave(W.caA, { rows: [{ f: await field(), target: x }] });
  assert.equal(before.ok, true, before.error?.message);
  // The save: two new mappings (one of them onto X, replacing what is on), in one transaction.
  const f1 = await field();
  const f2 = await field();
  const y = await variable(W.caA);
  const out = await rawSave(W.caA, {
    rows: [{ f: f1, target: x }, { f: f2, target: y }],
    replaces: [{ activationId: before.activations[0], versionId: before.versions[0].versionId }],
  });
  assert.equal(out.ok, true, `${out.error?.code} ${out.error?.message}`);
  for (const v of out.versions) {
    const row = await versionRow(v.versionId);
    assert.deepEqual([row.status, row.activated_basis, row.activated_by_user_id, row.submitted_basis], ["active", "club_admin", W.caA.id, "club_admin"]);
  }
  assert.deepEqual((await rows(k, `select action, count(*)::int as n from ${T8} where operation_id = $1 group by action order by action`, [out.operationId])).map((r) => [r.action, r.n]),
    [["activation_end", 1], ["activation_start", 2], ["mapping_confirmation", 1], ["mapping_create", 2], ["mapping_status", 4], ["mapping_version_create", 2]]);
  assert.deepEqual(await one(k, `select ended_at is not null as ended, end_reason from ${T5} where id = $1`, [before.activations[0]]), { ended: true, end_reason: "admin_ended" });
  assert.equal((await one(k, `select count(*)::int as n from ${T5} where id = any($1::uuid[]) and ended_at is null`, [out.activations])).n, 2);
  assert.deepEqual((await rows(k, `select item_no, checked, raw_a is not null as has_values, values_digest is not null as has_digest from ${T9I} where confirmation_id = $1 order by item_no`, [out.confirmationId])),
    [{ item_no: 1, checked: true, has_values: true, has_digest: true }, { item_no: 2, checked: true, has_values: true, has_digest: true }]);
  // One transaction: every row of the operation carries one xmin.
  assert.equal((await one(k, `select count(distinct xmin::text)::int as n from ${T8} where operation_id = $1`, [out.operationId])).n, 1);
});

// ---------------------------------------------------------------------------
// 2. The gate
// ---------------------------------------------------------------------------
test("2. the gate: a club admin's needs_review -> active of a version of a field without parameters passes only with a checked T9i row of this transaction, by the activating user, for the version's club, naming this version", async () => {
  // No confirmation at all (A1's shape).
  const v0 = await waiting(W.caA);
  gateRefused(await rawSave(W.caA, { rows: [{ existing: v0 }], confirmation: false }));
  // A confirmation with no row for this version; with an unchecked row; with a row naming another version.
  const other = await waiting(W.caA);
  gateRefused(await rawSave(W.caA, { rows: [{ existing: v0, item: false }, { existing: other }] }));
  gateRefused(await rawSave(W.caA, { rows: [{ existing: v0, checked: false }] }));
  gateRefused(await rawSave(W.caA, { rows: [{ existing: v0, itemVersionId: other.versionId }] }));
  assert.deepEqual([await statusOf(v0.versionId), await statusOf(other.versionId)], ["needs_review", "needs_review"]);
  // A confirmation of an EARLIER, committed transaction by the same admin (planted: the guards would not let one exist) does not pass.
  const plantConfirmation = async (c, versionId, { by = W.caA.id, clubId = W.clubA } = {}) => {
    const id = (await one(c, `insert into ${T9} (operation_id, kind, owner_scope, owner_club_id, binding_id, team_id, credential_connection_id, confirmed_by_user_id, confirmed_basis, confirmed_at, attested, display_registry_version, values_expire_at)
                               values (gen_random_uuid(),'team_mapping','club',$1,$2,$3,$4,$5,'club_admin',now(),true,1,now() + interval '2160 hours') returning id`,
    [clubId, W.bA.bindingId, W.bA.teamId, W.bA.connectionId, by])).id;
    const facts = await one(c, `select * from ${T4} where id = $1`, [versionId]);
    await c.query(`insert into ${T9I} (confirmation_id, session_ordinal, item_no, item_kind, checked, source_metric_version_id, mapping_version_id, parameter_fingerprint, source_unit, target_unit,
                     scale, scale_divisor, "offset", compared_level, gpexe_display_rule, gpexe_display_unit, raw_a, stored_a, raw_b, stored_b, values_salt, values_digest)
                   values ($1,1,1,'club_mapping',true,$2,$3,$4,$5,$6,$7,$8,$9,'session','duration_mmss','mm:ss','120','2','300','5',substring(sha256('salt'::bytea) from 1 for 16),repeat('a',64))`,
    [id, facts.source_metric_version_id, facts.id, facts.parameter_fingerprint, facts.source_unit, facts.target_unit, facts.scale, facts.scale_divisor, facts.offset]);
    return id;
  };
  await k.query("begin");
  try { await planted(k, () => plantConfirmation(k, v0.versionId)); await k.query("commit"); } catch (error) { await k.query("rollback"); throw error; }
  gateRefused(await rawSave(W.caA, { rows: [{ existing: v0 }], confirmation: false }));
  // In THIS transaction, but by another admin of the club, or for another club: refused. By this admin for this club: passes (the gate alone).
  const activateWith = async (plant) => {
    const c = await client();
    try {
      await c.query("begin");
      await c.query(CTX, [W.caA.id]);
      await planted(c, plant(c));
      await c.query(`update ${T4} set status = 'active', activated_by_user_id = $2, activated_at = clock_timestamp(), activated_basis = 'club_admin' where id = $1`, [v0.versionId, W.caA.id]);
      return null;
    } catch (error) {
      return error;
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
  };
  const refusedBy = async (plant) => { const e = await activateWith(plant); assert.deepEqual([e?.code, e?.message], ["23514", GATE_TEXT]); };
  await refusedBy((c) => () => plantConfirmation(c, v0.versionId, { by: W.caA2.id }));
  await refusedBy((c) => () => plantConfirmation(c, v0.versionId, { clubId: W.clubB }));
  await refusedBy((c) => () => plantConfirmation(c, other.versionId));
  // Inside a savepoint of this transaction (a subtransaction has its own xid): fails closed.
  await refusedBy((c) => async () => { await c.query("savepoint s1"); await plantConfirmation(c, v0.versionId); await c.query("release savepoint s1"); });
  assert.equal(await activateWith((c) => () => plantConfirmation(c, v0.versionId)), null, "the same rows in the transaction itself pass the gate");
  // The whole save with its confirmation inside a savepoint is refused before the gate, by v65's own guard, and nothing is written.
  const sp = await rawSave(W.caA, { rows: [{ existing: other }], savepoint: true });
  assert.equal(sp.ok, false);
  assert.ok(["23514", "42501"].includes(sp.error?.code), sp.error?.message);
  assert.equal(await statusOf(other.versionId), "needs_review");
  // And the real thing passes.
  const good = await rawSave(W.caA, { rows: [{ existing: other }] });
  assert.equal(good.ok, true, good.error?.message);
  assert.equal(await statusOf(other.versionId), "active");
});

test("3. through the routes: a club admin's A1 answers 409 confirmation_required with a sentence and changes nothing; a platform admin's activation of a system version and of a club's version is not gated", async () => {
  const v = await waiting(W.caA);
  const res = await post(`/mappings/${v.mappingId}/versions/${v.versionId}/activate`, W.caA.cookie, { requestKey: key(), expectedActiveVersionId: null });
  assert.deepEqual([res.status, res.body.error], [409, "confirmation_required"], res.text);
  assert.match(res.body.message, /drag and drop/i);
  assert.equal(res.text.includes("source_metric_mapping_versions"), false, "never the database's text");
  assert.equal(await statusOf(v.versionId), "needs_review");
  assert.equal((await one(k, `select count(*)::int as n from ${T8} where mapping_version_id = $1 and to_status = 'active'`, [v.versionId])).n, 0);
  // A platform admin in the club's workspace activates the same version (basis platform_admin).
  const viaPlatform = await post(`/mappings/${v.mappingId}/versions/${v.versionId}/activate`, W.paA.cookie, { requestKey: key(), expectedActiveVersionId: null });
  assert.equal(viaPlatform.status, 200, viaPlatform.text);
  assert.deepEqual([(await versionRow(v.versionId)).status, (await versionRow(v.versionId)).activated_basis], ["active", "platform_admin"]);
  // A system version by a platform admin.
  const sys = await activeVersion(W.pa);
  assert.equal(await statusOf(sys.versionId), "active");
});

test("3b. a field WITH parameters is not gated: a club admin's A1 of its club's zone version works on the v66 schema as before (7h), through the real routes", async () => {
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'v66 zone field',$2) returning id`,
    [`v66.test.zone.f${uid()}`, W.pa.id])).id;
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: "zone_distance", parameterKind: "zone_bounds", evidenceRef: COMPAT, unit: "m", boundUnit: "m/s", unitRef: UNIT_REF, meaning: true, operator: ">=", meaningRef: MEANING_REF, state: "active" });
  const created = await post("/variables", W.caA.cookie, { requestKey: key(), label: `Zone variable ${uid()}`, unit: "m", levels: ["session", "drill"], dailyAggregationMethod: "sum",
    condition: { kind: "zone", operator: ">=", value: "7", unit: "m/s" } });
  assert.equal(created.status, 201, created.text);
  const m = await post("/mappings", W.caA.cookie, { requestKey: key(), sourceMetricId: fieldId, metricDefinitionId: created.body.variable.id });
  assert.equal(m.status, 201, m.text);
  const v = await post(`/mappings/${m.body.mapping.id}/versions`, W.caA.cookie, { requestKey: key(), sourceRevisionId: revId, appliesToSession: true, appliesToDrill: true, sourceParameters: { lower: "7", upper: null } });
  assert.equal(v.status, 201, v.text);
  assert.equal((await post(`/mappings/${m.body.mapping.id}/versions/${v.body.version.id}/submit`, W.caA.cookie, { requestKey: key() })).status, 200);
  const a = await post(`/mappings/${m.body.mapping.id}/versions/${v.body.version.id}/activate`, W.caA.cookie, { requestKey: key(), expectedActiveVersionId: null });
  assert.equal(a.status, 200, a.text);
  const row = await versionRow(v.body.version.id);
  assert.deepEqual([row.status, row.activated_basis, row.parameter_kind], ["active", "club_admin", "zone_bounds"]);
  assert.equal((await one(k, `select count(*)::int as n from ${T9I} where mapping_version_id = $1`, [row.id])).n, 0);
});

test("4. a copy of OptiMove's mapping (J15, C125): a club admin's A1 of the copied draft passes through its link, with no confirmation; once the linked system version is disabled it is refused", async () => {
  const currentVersionOf = async (variableId) => (await one(k, `select current_version_id from training_load.metric_definitions where id = $1`, [variableId])).current_version_id;
  const copyOf = async () => {
    const sys = await activeVersion(W.pa);
    const res = await post(`/variables/${sys.target.id}/copy`, W.caA.cookie, { requestKey: key(), expectedSourceVersionId: await currentVersionOf(sys.target.id) });
    assert.ok([200, 201].includes(res.status), res.text);
    const draft = await one(k, `select l.club_version_id as "versionId", v.mapping_id as "mappingId" from training_load.source_metric_mapping_version_copies l
                                  join ${T4} v on v.id = l.club_version_id where l.system_version_id = $1`, [sys.versionId]);
    assert.equal((await post(`/mappings/${draft.mappingId}/versions/${draft.versionId}/submit`, W.caA.cookie, { requestKey: key() })).status, 200);
    return { sys, draft };
  };
  const a = await copyOf();
  const ok = await post(`/mappings/${a.draft.mappingId}/versions/${a.draft.versionId}/activate`, W.caA.cookie, { requestKey: key(), expectedActiveVersionId: null });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([(await versionRow(a.draft.versionId)).status, (await versionRow(a.draft.versionId)).activated_basis], ["active", "club_admin"]);
  assert.equal((await one(k, `select count(*)::int as n from ${T9I} where mapping_version_id = $1`, [a.draft.versionId])).n, 0, "no confirmation was needed");
  // The linked system version disabled: the link is no proof any more.
  const b = await copyOf();
  const off = await post(`/mappings/${b.sys.mappingId}/versions/${b.sys.versionId}/disable`, W.pa.cookie, { requestKey: key(), expectedStatus: "active", reason: "The system version is withdrawn for the gate test." });
  assert.equal(off.status, 200, off.text);
  const refused = await post(`/mappings/${b.draft.mappingId}/versions/${b.draft.versionId}/activate`, W.caA.cookie, { requestKey: key(), expectedActiveVersionId: null });
  assert.deepEqual([refused.status, refused.body.error], [409, "confirmation_required"], refused.text);
  assert.equal(await statusOf(b.draft.versionId), "needs_review");
});

test("4b. each remaining condition of the gate, behaviourally: the item's own xmin, the confirmation's own xmin, item_kind, and the copy link's system side", async () => {
  // The four conditions the md5 pin alone covered (the Nezavisni revizor's L2). Each case plants rows the service
  // itself never writes (session_replication_role = replica), then runs the activating UPDATE in the same
  // transaction, so only the named condition differs from a passing save.
  const confirmationRow = async (c, { by = W.caA.id, clubId = W.clubA } = {}) => (await one(c,
    `insert into ${T9} (operation_id, kind, owner_scope, owner_club_id, binding_id, team_id, credential_connection_id, confirmed_by_user_id, confirmed_basis, confirmed_at, attested, display_registry_version, values_expire_at)
       values (gen_random_uuid(),'team_mapping','club',$1,$2,$3,$4,$5,'club_admin',now(),true,1,now() + interval '2160 hours') returning id`,
    [clubId, W.bA.bindingId, W.bA.teamId, W.bA.connectionId, by])).id;
  // A checked row carries the values and the digest; an unchecked one carries none of them (v65's own CHECKs).
  const itemRow = async (c, confirmationId, versionId, { kind = "club_mapping", checked = true } = {}) => {
    const f = await one(c, `select * from ${T4} where id = $1`, [versionId]);
    await c.query(`insert into ${T9I} (confirmation_id, session_ordinal, item_no, item_kind, checked, source_metric_version_id, mapping_version_id, parameter_fingerprint, source_unit, target_unit,
                     scale, scale_divisor, "offset", compared_level, gpexe_display_rule, gpexe_display_unit, raw_a, stored_a, raw_b, stored_b, values_salt, values_digest)
                   values ($1,1,1,$10,$11,$2,$3,$4,$5,$6,$7,$8,$9,'session',
                           case when $11 then 'duration_mmss' end, case when $11 then 'mm:ss' end,
                           case when $11 then 120 end, case when $11 then 2 end, case when $11 then 300 end, case when $11 then 5 end,
                           case when $11 then substring(sha256('salt'::bytea) from 1 for 16) end, case when $11 then repeat('a',64) end)`,
      [confirmationId, f.source_metric_version_id, f.id, f.parameter_fingerprint, f.source_unit, f.target_unit, f.scale, f.scale_divisor, f.offset, kind, checked]);
  };
  // Runs `plant` and then the activation in one transaction; returns the error or null.
  const activateWith = async (versionId, plant) => {
    const c = await client();
    try {
      await c.query("begin");
      await c.query(CTX, [W.caA.id]);
      await planted(c, () => plant(c));
      await c.query(`update ${T4} set status = 'active', activated_by_user_id = $2, activated_at = clock_timestamp(), activated_basis = 'club_admin' where id = $1`, [versionId, W.caA.id]);
      return null;
    } catch (error) { return error; } finally { await c.query("rollback").catch(() => {}); await c.end(); }
  };
  const refused = async (versionId, plant, label) => {
    const e = await activateWith(versionId, plant);
    assert.deepEqual([e?.code, e?.message], ["23514", GATE_TEXT], label);
    assert.equal(await statusOf(versionId), "needs_review", `${label}: nothing changed`);
  };

  // (1) item_kind: the same confirmation of this transaction, but the item is a system_mapping row. v65's own CHECK
  //     (source_metric_confirmation_items_system_unchecked) forbids a CHECKED system row, so the two conditions
  //     cannot be separated behaviourally: the pair is closed by that CHECK and by this case.
  const v1 = await waiting(W.caA);
  await refused(v1.versionId, async (c) => itemRow(c, await confirmationRow(c), v1.versionId, { kind: "system_mapping", checked: false }), "item_kind is not club_mapping");
  const checkedSystem = await activateWith(v1.versionId, async (c) => itemRow(c, await confirmationRow(c), v1.versionId, { kind: "system_mapping", checked: true }));
  assert.match(checkedSystem?.message ?? "", /source_metric_confirmation_items_system_unchecked/, "a checked system row cannot exist at all");
  assert.equal(await activateWith(v1.versionId, async (c) => itemRow(c, await confirmationRow(c), v1.versionId)), null, "the same rows as club_mapping pass");

  // (2) the item's own xmin: the confirmation is written in this transaction, its item inside a savepoint, so the
  //     item carries the subtransaction's xid while the confirmation carries the transaction's own.
  const v2 = await waiting(W.caA);
  await refused(v2.versionId, async (c) => {
    const id = await confirmationRow(c);
    await c.query("savepoint s_item");
    await itemRow(c, id, v2.versionId);
    await c.query("release savepoint s_item");
  }, "the item is of a subtransaction");

  // (3) the confirmation's own xmin: the confirmation is committed by an earlier transaction and only its item is
  //     written in this one.
  const v3 = await waiting(W.caA);
  let earlier;
  await k.query("begin");
  try { earlier = await planted(k, () => confirmationRow(k)); await k.query("commit"); } catch (error) { await k.query("rollback"); throw error; }
  await refused(v3.versionId, (c) => itemRow(c, earlier, v3.versionId), "the confirmation is of an earlier transaction");

  // (4) the copy link's system side: a link whose "system" version is in fact the club's own active version.
  const v4 = await waiting(W.caA);
  // The stand-in: the club's own version, made active without the gate (the gate is what this case is about).
  const clubActive = await waiting(W.caA);
  await k.query("begin");
  try {
    await planted(k, () => k.query(`update ${T4} set status = 'active', activated_by_user_id = $2, activated_at = now(), activated_basis = 'club_admin' where id = $1`, [clubActive.versionId, W.caA.id]));
    await k.query("commit");
  } catch (error) { await k.query("rollback"); throw error; }
  assert.deepEqual([(await versionRow(clubActive.versionId)).owner_key, await statusOf(clubActive.versionId)], [W.clubA, "active"], "the stand-in is the club's own active version");
  await refused(v4.versionId, (c) => c.query(`insert into training_load.source_metric_mapping_version_copies (club_version_id, system_version_id, operation_id) values ($1,$2,gen_random_uuid())`,
    [v4.versionId, clubActive.versionId]), "the copy's other side is not a system version");
  const sys = await activeVersion(W.pa);
  assert.equal(await activateWith(v4.versionId, (c) => c.query(`insert into training_load.source_metric_mapping_version_copies (club_version_id, system_version_id, operation_id) values ($1,$2,gen_random_uuid())`,
    [v4.versionId, sys.versionId])), null, "the same link to an active system version passes");
});

// ---------------------------------------------------------------------------
// 3. The migration: preflight, refusals, post-check, rollback (the rehearsal database)
// ---------------------------------------------------------------------------
async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in ${S} and not t.tgisinternal order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest, obj_description(p.oid, 'pg_proc') as comment from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} order by 1, 2, 3`),
    tables: await rows(c, `select table_schema, table_name from information_schema.tables where table_schema in ${S} order by 1, 2`),
    constraints: await rows(c, `select c.conrelid::regclass::text as rel, c.conname, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
async function blocks(c, file) {
  const text = await fsp.readFile(file, "utf8");
  const out = {};
  for (const part of text.split(/^(?=-- \d+\. )/m).slice(1)) out[Number(part.match(/^-- (\d+)\./)[1])] = (await c.query(part)).rows;
  return out;
}
async function migrationRefused(promise, pattern, label) {
  let error = null;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error, `${label}: the migration is refused`);
  assert.match(`${error.message}\n${error.cause?.message ?? ""}`, pattern, label);
}
// A change that is rolled back: what the preflight or the migration says while it is in place.
async function whilePlanted(c, plant, fn) {
  await c.query("begin");
  try { await plant(c); return await fn(c); } finally { await c.query("rollback").catch(() => {}); }
}
const runRollback = async (c) => { try { await c.query(await fsp.readFile(ROLLBACK, "utf8")); return null; } catch (e) { await c.query("rollback").catch(() => {}); return e; } };
const FAKE = (name) => `create or replace function training_load.${name}() returns trigger as $$ begin return new; end; $$ language plpgsql`;

test("5. the migration: every expected value of the read-only preflight and each one flipped; v66 refuses another guard body, another trigger set and a missing v65; the post-check; every refusal of the rollback; apply -> rollback -> the identical catalog -> apply again", async () => {
  const sha = crypto.createHash("sha256").update(await fsp.readFile(V66_FILE)).digest("hex");
  // --- Before v66: the preflight.
  const pre = await blocks(r, PREFLIGHT);
  assert.deepEqual(Object.keys(pre).map(Number), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pre[1][0], { v65_rows: "1", v65_checksum_ok: true, v67_rows: "1", v67_checksum_ok: true, v66_rows: "0", other_after_v66: "0", last_migration: V67_NAME });
  assert.deepEqual(pre[2][0], { update_guard_ok: true, actor_guard_ok: true, trigger_set_ok: true });
  assert.deepEqual(pre[3][0], { v66_objects: "0", relied_on_ok: true, owns_t4_ok: true, may_create_ok: true });
  assert.deepEqual(pre[4][0], { waiting_without_link: "0", waiting_with_link: "0" });
  assert.deepEqual(pre[5][0], { statement_parameters_not_logged_ok: true, error_parameters_not_logged_ok: true, pgaudit_parameters_not_logged_ok: true, auto_explain_parameters_not_logged_ok: true,
    plans_not_printed_ok: true, no_role_or_database_override_ok: true });
  assert.equal(pre[6][0].asked_as, (await one(r, "select current_user as u")).u);
  assert.deepEqual(pre[7][0], { t4_writers: "0", idle_in_transaction: "0" });
  // Each one flipped.
  const flipped = async (plant, block) => (await whilePlanted(r, plant, (c) => blocks(c, PREFLIGHT)))[block][0];
  assert.equal((await flipped((c) => c.query(FAKE("source_metric_mapping_versions_update_guard")), 2)).update_guard_ok, false);
  assert.equal((await flipped((c) => c.query(FAKE("source_metric_mapping_versions_actor_guard")), 2)).actor_guard_ok, false);
  assert.equal((await flipped((c) => c.query(`alter table ${T4} disable trigger source_metric_mapping_versions_v35_actor_guard`), 2)).trigger_set_ok, false);
  assert.equal((await flipped((c) => c.query(`create trigger zz_extra before update on ${T4} for each row execute function training_load.source_metric_mapping_versions_update_guard()`), 2)).trigger_set_ok, false);
  assert.equal((await flipped((c) => c.query(`create function training_load.source_metric_mapping_versions_confirmation_gate() returns trigger as $$ begin return new; end; $$ language plpgsql`), 3)).v66_objects, "1");
  assert.equal((await flipped((c) => c.query(`update public.schema_migrations set checksum = repeat('0', 64) where migration_name = $1`, [V65_NAME]), 1)).v65_checksum_ok, false);
  assert.equal((await flipped((c) => c.query(`update public.schema_migrations set checksum = repeat('0', 64) where migration_name = $1`, [V67_NAME]), 1)).v67_checksum_ok, false);
  // Another migration after v66 - v67 is the only one tolerated.
  assert.equal((await flipped((c) => c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', repeat('0', 64), 'test')`), 1)).other_after_v66, "1");
  // The log settings: each way a save's values could reach the server log.
  const logs = async (settings) => flipped(async (c) => { for (const [n, v] of settings) await c.query(`select set_config($1, $2, true)`, [n, v]); }, 5);
  assert.equal((await logs([["log_statement", "all"], ["log_parameter_max_length", "-1"]])).statement_parameters_not_logged_ok, false);
  assert.equal((await logs([["log_statement", "mod"], ["log_parameter_max_length", "64"]])).statement_parameters_not_logged_ok, false);
  assert.equal((await logs([["log_min_duration_statement", "0"], ["log_parameter_max_length", "-1"]])).statement_parameters_not_logged_ok, false);
  assert.equal((await logs([["log_statement", "all"], ["log_parameter_max_length", "0"]])).statement_parameters_not_logged_ok, true, "parameters cut to nothing");
  assert.equal((await logs([["log_parameter_max_length_on_error", "-1"]])).error_parameters_not_logged_ok, false);
  assert.equal((await logs([["pgaudit.log", "write"], ["pgaudit.log_parameter", "on"]])).pgaudit_parameters_not_logged_ok, false);
  assert.equal((await logs([["auto_explain.log_min_duration", "0"], ["auto_explain.log_parameter_max_length", "-1"]])).auto_explain_parameters_not_logged_ok, false);
  assert.equal((await logs([["auto_explain.log_min_duration", "0"], ["auto_explain.log_parameter_max_length", "0"], ["auto_explain.log_verbose", "on"]])).auto_explain_parameters_not_logged_ok, false, "a verbose plan");
  assert.equal((await logs([["auto_explain.log_min_duration", "0"], ["auto_explain.log_parameter_max_length", "0"]])).auto_explain_parameters_not_logged_ok, true);
  // A sampled transaction logs its statements whatever the other settings say.
  assert.equal((await logs([["log_transaction_sample_rate", "0.01"], ["log_parameter_max_length", "-1"]])).statement_parameters_not_logged_ok, false);
  // pgaudit's object audit (its role) logs without pgaudit.log.
  assert.equal((await logs([["pgaudit.log", "none"], ["pgaudit.role", "auditor"], ["pgaudit.log_parameter", "on"]])).pgaudit_parameters_not_logged_ok, false);
  assert.equal((await logs([["pgaudit.log", "none"], ["pgaudit.role", "auditor"], ["pgaudit.log_parameter", "off"]])).pgaudit_parameters_not_logged_ok, true);
  assert.equal((await logs([["debug_print_plan", "on"]])).plans_not_printed_ok, false);
  // An override on a role or on the database, which another session would not see in its own settings.
  assert.equal((await flipped((c) => c.query(`alter database ${rdb.name} set log_min_duration_statement = 0`), 5)).no_role_or_database_override_ok, false);
  // A waiting club version of a field without parameters is counted; a held T4 writer shows.
  const before = await catalog(r);
  const other = await client(rdb.url);
  try {
    await other.query("begin");
    await other.query(`lock table ${T4} in row exclusive mode`);
    assert.equal((await blocks(r, PREFLIGHT))[7][0].t4_writers, "1");
  } finally { await other.query("rollback"); await other.end(); }
  // The rollback refuses without v66.
  assert.match((await runRollback(r)).message, /v66 is not recorded/);

  // --- v66 refuses what it was not written on, and changes nothing.
  const tampered = async (sql, pattern, label) => {
    await r.query(sql.plant);
    try { await migrationRefused(migrate(rdb.url, [...BEFORE_V66, V66]), pattern, label); } finally { await r.query(sql.undo); }
    assert.deepEqual(await catalog(r), before, `${label}: nothing changed`);
  };
  const guardBody = (await one(r, `select pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'training_load'::regnamespace and p.proname = 'source_metric_mapping_versions_update_guard'`)).def;
  await tampered({ plant: FAKE("source_metric_mapping_versions_update_guard"), undo: guardBody }, /23514|not the one this gate was written on/, "another update guard");
  await tampered({ plant: `alter table ${T4} disable trigger source_metric_mapping_versions_update_guard`, undo: `alter table ${T4} enable trigger source_metric_mapping_versions_update_guard` }, /23514|not the six/, "a disabled trigger");

  // --- Apply, post-check, the gate in force.
  await migrate(rdb.url, [...BEFORE_V66, V66]);
  const post1 = await blocks(r, POSTCHECK);
  assert.deepEqual(post1[1][0], { v66_rows: "1", v66_checksum_ok: true, v67_rows: "1", other_later_migrations: "0" });
  assert.equal((await whilePlanted(r, (c) => c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', repeat('0', 64), 'test')`), (c) => blocks(c, POSTCHECK)))[1][0].other_later_migrations, "1");
  assert.equal((await one(r, `select checksum from public.schema_migrations where migration_name = $1`, [V66_NAME])).checksum, sha);
  assert.deepEqual(post1[2][0], { gate_body_ok: true, gate_trigger_enabled_ok: true, gate_runs_last_ok: true, t4_triggers: "7", disabled_triggers: "0", update_guard_ok: true, actor_guard_ok: true });
  assert.deepEqual(post1[4][0], { idle_in_transaction: "0", waiting_locks: "0" });
  const applied = await catalog(r);
  assert.equal(applied.functions.length, before.functions.length + 1);
  assert.equal(applied.triggers.length, before.triggers.length + 1);
  assert.deepEqual([applied.tables, applied.constraints], [before.tables, before.constraints], "no table or constraint changed");
  // The post-check flips.
  assert.equal((await whilePlanted(r, (c) => c.query(`alter table ${T4} disable trigger source_metric_mapping_versions_v66_confirmation_gate`), (c) => blocks(c, POSTCHECK)))[2][0].gate_trigger_enabled_ok, false);
  assert.equal((await whilePlanted(r, (c) => c.query(FAKE("source_metric_mapping_versions_confirmation_gate")), (c) => blocks(c, POSTCHECK)))[2][0].gate_body_ok, false);
  assert.equal((await whilePlanted(r, (c) => c.query(`create trigger zz_after_gate before update on ${T4} for each row execute function training_load.source_metric_mapping_versions_update_guard()`), (c) => blocks(c, POSTCHECK)))[2][0].gate_runs_last_ok, false);

  // --- The rollback's refusals, each changing nothing.
  const refusedWith = async (plantSql, undoSql, pattern) => {
    await r.query(plantSql);
    try { assert.match((await runRollback(r))?.message ?? "", pattern); } finally { await r.query(undoSql); }
    assert.deepEqual(await catalog(r), applied);
  };
  await refusedWith(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', repeat('0', 64), 'test')`,
    `delete from public.schema_migrations where migration_name = 'migrations_v2/209912312359_training_load_v99_test_only.sql'`, /a later migration is recorded/);
  await refusedWith(`alter table ${T4} disable trigger source_metric_mapping_versions_v66_confirmation_gate`, `alter table ${T4} enable trigger source_metric_mapping_versions_v66_confirmation_gate`, /trigger is disabled/);
  const gateBody = (await one(r, `select pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'training_load'::regnamespace and p.proname = 'source_metric_mapping_versions_confirmation_gate'`)).def;
  await refusedWith(FAKE("source_metric_mapping_versions_confirmation_gate"), gateBody, /body is not v66's/);
  // The migrator's lock held by another session.
  const holder = await client(rdb.url);
  try {
    await holder.query("select pg_advisory_lock(822026)");
    assert.match((await runRollback(r))?.message ?? "", /the migrator is running/);
  } finally { await holder.query("select pg_advisory_unlock(822026)"); await holder.end(); }
  assert.deepEqual(await catalog(r), applied);

  // --- Rollback -> the catalog before v66, exactly -> apply again.
  assert.equal(await runRollback(r), null);
  assert.deepEqual(await catalog(r), before);
  await migrate(rdb.url, [...BEFORE_V66, V66]);
  assert.deepEqual(await catalog(r), applied);
});

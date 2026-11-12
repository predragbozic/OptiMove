// J18, slice 18-1 - migration v65 (M-A): the stored two-athlete confirmation of
// a drag-and-drop mapping.
// Contract: docs/ai/c112-drag-mapping-contract.md (J18), sections 5.1-5.4, 5.6,
// 5.8, 9.1 and 15. On disposable optimove_tests_gpexe_* databases only (never
// OPTIMOVE, never a real GPEXE field, connection or athlete): one migrated
// through the migration before v65 that rehearses v65 (the preflight, the
// runner, the md5 and CHECK gates, the post-check, every refusal of the
// rollback, the rollback back to the exact catalog, and v65 again), and one
// migrated through v65 for the behaviour of its guards. No application code
// writes these tables yet (18-3), so a "save" here is this file's own raw
// transaction, written the way the contract's section 4.3 step 16 orders it.
// Every field, variable, mapping, connection, binding, check and candidate is a
// test row of this file; the values are invented numbers of no athlete.
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
const V65 = "202611121800_training_load_v65_source_metric_confirmations.sql";
const V65_NAME = `migrations_v2/${V65}`;
const BEFORE_V65 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V65));
const PREVIOUS_NAME = `migrations_v2/${BEFORE_V65.at(-1)}`;
const V65_FILE = path.resolve(ROOT, "migrations_v2", V65);
const RUNBOOKS = path.resolve(ROOT, "docs/runbooks");
const ROLLBACK = path.join(RUNBOOKS, "source-metric-confirmations-v65-rollback.sql");
const PREFLIGHT = path.join(RUNBOOKS, "source-metric-confirmations-v65-preflight.sql");
const POSTCHECK = path.join(RUNBOOKS, "source-metric-confirmations-v65-postcheck.sql");
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
const REPLACED = ["source_metric_audit_row_ok", "source_metric_audit_actor_guard", "source_metric_audit_insert_guard", "source_metric_audit_revision_guard"];
// The md5 of the four bodies in force before v65 (pinned on origin/main when
// the branch was cut; the migration, the preflight and the rollback name them).
const OLD_MD5 = {
  source_metric_audit_row_ok: "a43a63c2d248cbaf71302468429acb85",
  source_metric_audit_actor_guard: "94cf466bfa765a1a03f7d290a3ce154a",
  source_metric_audit_insert_guard: "157c1ba1be40aaaa6cf5884542919c11",
  source_metric_audit_revision_guard: "16c87e61856986987a4794412c9e6dc2",
};
const V34_T8_COMMENT = "v34 (D10, T8): append-only record of every source metric, mapping, activation, unit conversion and source instance operation. No metadata column; reason and evidence_ref are bounded, format-checked and never name an athlete or carry a value.";
// Values no fixed message, detail or hint may ever carry (test 12).
const PLANTED = ["7391.25", "123.1875", "4455.5", "74.258333333"];

let rdb, db, r, k, server, apiBase, dbModule, appPool, createSession;
const W = {};
const originalConsole = {};

async function migrate(url, files, { extra = null } = {}) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v65-migrations-"));
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
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V65), "v65 is a test migration");
  assert.ok(BEFORE_V65.length > 0, "v65 follows the earlier migrations");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v65rb", migrations: BEFORE_V65 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v65", migrations: [...BEFORE_V65, V65] }),
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
    console[level] = (...args) => { if (process.env.V65_DEBUG) originalConsole[level](...args); };
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
       values ('gpexe','club',$1,'server3','v65 test','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
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
       values ('gpexe','team',$1,'server3','v65 team test','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
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
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'v65 test field',$2) returning id`,
    [`v65.test.f${uid()}`, W.pa.id])).id;
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
  W.pa2 = await platformAdmin();
  W.caA = await clubAdmin(W.clubA);
  W.caA2 = await clubAdmin(W.clubA);
  W.caB = await clubAdmin(W.clubB);
  W.bA = await binding(W.clubA);
  W.bA2 = await binding(W.clubA);
  W.bB = await binding(W.clubB);
  W.bTeamOwned = await binding(W.clubA, { teamOwned: true });
  W.sA = await stored(W.bA);
  W.sB = await stored(W.bB);
  // Club A's active version, a second one, a system version, club B's version,
  // and a submitted (not active) version of club A.
  W.vA = await activeVersion(W.caA);
  W.vA2 = await activeVersion(W.caA);
  W.vSys = await activeVersion(W.pa);
  W.vB = await activeVersion(W.caB);
  W.vWaiting = await activeVersion(W.caA, { activate: false });
}

// ---------------------------------------------------------------------------
// The raw save: the writes of section 4.3 step 16 in their order, in one
// transaction with the acting user set the way the services set it. Every
// part can be left out or changed. Deferred constraints are forced before the
// end, so a COMMIT-time refusal shows even when the transaction is rolled
// back; only `commit: true` keeps the rows.
// ---------------------------------------------------------------------------
const checkedItem = (v, over = {}) => ({ v, kind: "club_mapping", checked: true, rule: "duration_mmss", unit: "mm:ss", rawA: "120", storedA: "2", rawB: "300", storedB: "5", ...over });
const plainItem = (v, over = {}) => ({ v, kind: v === W.vSys ? "system_mapping" : "club_mapping", checked: false, ...over });

async function startRow(c, actor, v, b, operationId, basis) {
  const row = await versionRow(v.versionId);
  const id = (await one(c, `insert into ${T5} (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint,
                               source_team_binding_id, team_id, applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
                             values ($1,$2,$3,$4,$5,$6,$7,true,true,'required',$8,$9,'Switched on by drag and drop; two athletes checked in GPEXE.') returning id`,
  [v.versionId, v.mappingId, row.source_metric_definition_id, row.metric_definition_id, row.parameter_fingerprint, b.bindingId, b.teamId, actor.id, basis])).id;
  await c.query(`insert into ${T8} (action, mapping_version_id, activation_id, team_id, reason, performed_by_user_id, basis, operation_id)
                 values ('activation_start',$1,$2,$3,'Switched on by drag and drop; two athletes checked in GPEXE.',$4,$5,$6)`, [v.versionId, id, b.teamId, actor.id, basis, operationId]);
  return id;
}
async function itemRow(c, confId, n, it) {
  const row = await versionRow(it.v.versionId);
  const f = { ...row, ...(it.facts ?? {}) };
  return (await one(c, `insert into ${T9I} (confirmation_id, session_ordinal, item_no, item_kind, checked, source_metric_version_id, mapping_version_id,
                           parameter_fingerprint, source_unit, target_unit, scale, scale_divisor, "offset", compared_level, gpexe_display_rule, gpexe_display_unit,
                           raw_a, stored_a, raw_b, stored_b, values_salt, values_digest, values_removed_at, values_removed_kind, values_removed_by_user_id)
                         values ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning id`,
  [confId, it.itemNo ?? n, it.kind, it.checked, f.source_metric_version_id, it.versionId ?? it.v.versionId, f.parameter_fingerprint, f.source_unit, f.target_unit,
    f.scale, f.scale_divisor, f.offset, it.level ?? "session", it.rule ?? null, it.unit ?? null,
    it.rawA ?? null, it.storedA ?? null, it.rawB ?? null, it.storedB ?? null, it.salt ?? null, it.digest ?? null,
    it.removedAt ?? null, it.removedKind ?? null, it.removedBy ?? null])).id;
}
async function save(actor, o = {}) {
  const c = o.client ?? k;
  const s = o.stored ?? W.sA;
  const b = o.binding ?? s.b;
  const items = o.items ?? [checkedItem(W.vA)];
  const basis = o.basis ?? actor?.basis;
  const operationId = crypto.randomUUID();
  const out = { ok: false, error: null, id: null, itemIds: [], operationId };
  await c.query("begin");
  try {
    if (actor && o.context !== false) await c.query(CTX, [o.contextUser ?? actor.id]);
    if (o.before) await o.before(c);
    if (o.start !== false) for (const it of (o.startItems ?? items)) await startRow(c, o.startActor ?? actor, it.v, o.startBinding ?? b, operationId, o.startBasis ?? basis);
    if (o.savepoint) await c.query("savepoint s1");
    out.id = (await one(c, `insert into ${T9} (operation_id, kind, owner_scope, owner_club_id, binding_id, team_id, credential_connection_id, confirmed_by_user_id,
                               confirmed_basis, confirmed_at, attested, display_registry_version, values_expire_at)
                             values ($1,$2,$12,$3,$4,$5,$6,$7,$8,$9,$10,$13,$11) returning id`,
    [operationId, o.kind ?? "team_mapping", o.clubId ?? b.clubId, o.bindingId ?? b.bindingId, o.teamId ?? b.teamId, o.connectionId ?? b.connectionId,
      o.confirmedBy ?? actor.id, basis, o.confirmedAt ?? "2001-01-01T00:00:00Z", o.attested ?? items.some((it) => it.checked), o.expireAt ?? "2001-01-02T00:00:00Z", o.ownerScope ?? "club", o.registryVersion ?? 1])).id;
    if (o.savepoint) await c.query("release savepoint s1");
    if (o.afterConfirmation) await o.afterConfirmation(c, out.id);
    if (o.session !== false) {
      const sv = { candidateId: s.cand.id, hash: s.cand.bundle_hash, sessionId: s.cand.gpexe_team_session_id, startedAt: s.cand.session_started_at, checkId: s.checkId, teamId: b.teamId, ...(o.sessionFacts ?? {}) };
      for (let n = 0; n < (o.sessions ?? 1); n += 1) {
        await c.query(`insert into ${T9S} (confirmation_id, session_ordinal, candidate_id, candidate_bundle_hash, gpexe_team_session_id, session_started_at, check_id, team_id, pair_index)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [o.sessionConfirmation ?? out.id, n + 1, sv.candidateId, sv.hash, sv.sessionId, sv.startedAt, sv.checkId, sv.teamId, o.pairIndex ?? 0]);
      }
      let n = 0;
      for (const it of items) { n += 1; out.itemIds.push(await itemRow(c, out.id, n, it)); }
    }
    if (o.audit !== false) {
      await c.query(`insert into ${T8} (action, team_id, confirmation_id, performed_by_user_id, basis, operation_id, request_key, request_hash, reason)
                     values ('mapping_confirmation',$1,$2,$3,$4,$5,$6,$7,$8)`,
      [o.auditTeam ?? b.teamId, out.id, o.auditUser ?? actor.id, o.auditBasis ?? basis, o.auditOperation ?? operationId,
        o.keyed === false ? null : key(), o.keyed === false ? null : hash(), o.auditReason ?? null]);
    }
    if (o.then) await o.then(c, out);
    await c.query("set constraints all immediate");
    if (o.commit) await c.query("commit"); else await c.query("rollback");
    out.ok = true;
  } catch (error) {
    await c.query("rollback").catch(() => {});
    out.error = error;
  }
  return out;
}
function refusedWith(res, code, pattern) {
  assert.equal(res.ok, false, `expected a refusal (${pattern})`);
  assert.equal(res.error.code, code, res.error.message);
  if (pattern) assert.match(res.error.message, pattern);
  return res.error;
}
const passes = (res, label) => assert.equal(res.ok, true, `${label}: ${res.error?.message}`);
// A committed save on fresh versions and a fresh binding (so nothing collides
// with an open activation); returns its ids.
async function committed(actor = W.caA, { n = 1, checked = true } = {}) {
  const b = await binding(actor.clubId ?? W.clubA);
  const s = await stored(b);
  const owner = actor.clubId ? actor : W.caA;
  const items = [];
  for (let i = 0; i < n; i += 1) {
    const v = await activeVersion(owner);
    items.push(checked ? checkedItem(v) : plainItem(v));
  }
  const res = await save(actor, { stored: s, items, commit: true });
  passes(res, "a committed save");
  return { ...res, b, s, items };
}
// Moves a confirmation into the past (triggers off for this plant only; the
// CHECK that ties the expiry to the confirmation time still holds).
// A committed plant with the triggers off (the CHECKs still hold).
async function planted(fn) {
  await k.query("begin");
  try {
    await k.query("set local session_replication_role = replica");
    const value = await fn(k);
    await k.query("commit");
    return value;
  } catch (error) {
    await k.query("rollback").catch(() => {});
    throw error;
  }
}
const age = (confId, days) => planted((c) => c.query(
  `update ${T9} set confirmed_at = confirmed_at - make_interval(hours => $2 * 24), values_expire_at = values_expire_at - make_interval(hours => $2 * 24) where id = $1`, [confId, days]));
const itemsOf = (confId) => rows(k, `select * from ${T9I} where confirmation_id = $1 order by item_no`, [confId]);
// One transaction on `c` with an optional acting user; deferred constraints forced.
async function tx(actorId, fn, { c = k, commit = true } = {}) {
  await c.query("begin");
  try {
    if (actorId) await c.query(CTX, [actorId]);
    const value = await fn(c);
    await c.query("set constraints all immediate");
    await c.query(commit ? "commit" : "rollback");
    return { ok: true, value };
  } catch (error) {
    await c.query("rollback").catch(() => {});
    return { ok: false, error };
  }
}
const auditRemoval = (c, action, confId, userId, { reason = null, basis = "platform_admin" } = {}) =>
  c.query(`insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id, reason) values ($1,$2,$3,$4,$5,$6)`, [action, confId, userId, basis, crypto.randomUUID(), reason]);
const ERASE = `update ${T9I} set raw_a = null, stored_a = null, raw_b = null, stored_b = null, values_salt = null, values_removed_kind = 'erased' where confirmation_id = $1 and checked`;

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
const md5 = (text) => crypto.createHash("md5").update(text).digest("hex");
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
const FAKE_TRIGGER = (name) => `create or replace function training_load.${name}() returns trigger as $$ begin return new; end; $$ language plpgsql`;
const FAKE_ROW_OK = `create or replace function training_load.source_metric_audit_row_ok(p_action text, p_targets text, p_from text, p_to text, p_reason text, p_evidence text, p_basis text)
                       returns boolean language sql immutable as $$ select true $$`;
const fake = (name) => (name === "source_metric_audit_row_ok" ? FAKE_ROW_OK : FAKE_TRIGGER(name));
const LATER = (c) => c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', $1, 'test')`, ["0".repeat(64)]);
const replica = (c) => c.query("set local session_replication_role = replica");
// The runner wraps the database's error: its message carries the SQLSTATE, its cause the text.
async function migrationRefused(promise, pattern, label) {
  let error = null;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error, `${label ?? pattern}: the migration is refused`);
  assert.match(`${error.message}\n${error.cause?.message ?? ""}`, pattern, label);
}

// ---------------------------------------------------------------------------
// A. The rehearsal database (through the migration before v65).
// ---------------------------------------------------------------------------
test("A1. before v65: every expected value of the read-only preflight, each hard assertion flipped by a plant or a held lock; the rollback refuses without v65", async () => {
  const pre = await blocks(r, PREFLIGHT);
  assert.deepEqual(Object.keys(pre).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(pre[1][0].pg15_or_later, true);
  assert.deepEqual(pre[2][0], { previous_rows: "1", previous_checksum_ok: true, v65_rows: "0", at_or_after_v65: "0", last_migration: PREVIOUS_NAME });
  assert.deepEqual(pre[3][0], { row_ok_is_v52: true, actor_guard_is_v52: true, insert_guard_is_v48: true, revision_guard_is_v50: true });
  assert.deepEqual(pre[4][0], { action_check_is_v34: true, comment_is_v34: true });
  assert.deepEqual(pre[5][0], { v65_tables: "0", v65_functions: "0", v65_audit_objects: "0", disabled_triggers: "0", t8_triggers: "7", replaced_functions: "4", relied_on_functions: "7" });
  assert.deepEqual(pre[6][0], { owns_t8: true, owned_functions: "4", may_create: true });
  assert.deepEqual(pre[7][0], { setting_defaults: "0" });
  assert.deepEqual(pre[8][0], { t8_locks: "0", t4_writers: "0", fk_table_writers: "0", running_checks: "0", running_identity_loads: "0", idle_in_transaction: "0" });
  assert.deepEqual(pre[9][0], { new_action_rows: "0" });
  assert.deepEqual(Object.keys(pre[10][0]), ["log_statement", "log_min_duration_statement", "log_parameter_max_length", "log_parameter_max_length_on_error"]);
  const flipped = async (plant, block) => {
    await r.query("begin");
    try {
      await plant(r);
      return (await blocks(r, PREFLIGHT))[block][0];
    } finally {
      await r.query("rollback");
    }
  };
  assert.equal((await flipped(LATER, 2)).at_or_after_v65, "1");
  const column = { source_metric_audit_row_ok: "row_ok_is_v52", source_metric_audit_actor_guard: "actor_guard_is_v52", source_metric_audit_insert_guard: "insert_guard_is_v48", source_metric_audit_revision_guard: "revision_guard_is_v50" };
  for (const name of REPLACED) assert.equal((await flipped((c) => c.query(fake(name)), 3))[column[name]], false, name);
  const b4 = await flipped(async (c) => {
    await c.query(`alter table ${T8} drop constraint source_metric_audit_action_check`);
    await c.query(`alter table ${T8} add constraint source_metric_audit_action_check check (action <> '')`);
    await c.query(`comment on table ${T8} is 'another comment'`);
  }, 4);
  assert.deepEqual(b4, { action_check_is_v34: false, comment_is_v34: false });
  assert.equal((await flipped((c) => c.query(`alter table ${T8} disable trigger source_metric_audit_v43_transition_facts`), 5)).disabled_triggers, "1");
  assert.equal((await flipped((c) => c.query(`create table training_load.source_metric_confirmations (id uuid)`), 5)).v65_tables, "1");
  const b9 = await flipped(async (c) => {
    await replica(c);
    await c.query(`alter table ${T8} drop constraint source_metric_audit_action_check`);
    await c.query(FAKE_ROW_OK);
    const id = crypto.randomUUID();
    await c.query(`insert into ${T8} (action, performed_by_user_id, basis, operation_id) values ('mapping_confirmation',$1,'club_admin',$1)`, [id]);
  }, 9);
  assert.deepEqual(b9, { new_action_rows: "1" });
  const holder = await client(rdb.url);
  try {
    await holder.query("begin");
    await holder.query(`select 1 from ${T8} limit 1`);
    await holder.query(`lock table ${T4} in row exclusive mode`);
    await holder.query(`lock table public.teams in row exclusive mode`);
    await holder.query(`lock table training_load.source_team_bindings in row exclusive mode`);
    const b8 = (await blocks(r, PREFLIGHT))[8][0];
    assert.deepEqual([b8.t8_locks, b8.t4_writers, b8.fk_table_writers, b8.idle_in_transaction], ["1", "1", "2", "1"]);
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  assert.match((await inRolledBack(r, null, await fsp.readFile(ROLLBACK, "utf8")))?.message ?? "", /^v65 rollback refused: v65 is not recorded on this database$/);
  W.before = await catalog(r);
  W.oldBodies = await bodies(r);
  for (const name of REPLACED) assert.equal(md5(W.oldBodies[name]), OLD_MD5[name], `${name} in force is the pinned body`);
  assert.equal(W.before.tables.find((x) => x.table_name === "source_metric_audit").comment, V34_T8_COMMENT);
});

test("A2. v65 refuses, with nothing applied: a busy T8 (NOWAIT, at once), each of the four bodies not the one in force (md5), an action CHECK that is not v34's, and a failing last statement", async () => {
  const holder = await client(rdb.url);
  try {
    await holder.query("begin");
    await holder.query(`select 1 from ${T8} limit 1`);
    const started = Date.now();
    await assert.rejects(migrate(rdb.url, [...BEFORE_V65, V65]), /SQLSTATE 55P03/);
    assert.ok(Date.now() - started < 10_000, `failed at once (${Date.now() - started} ms)`);
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  assert.deepEqual(await catalog(r), W.before, "nothing applied");
  // While v65 waits for a writer of a table its foreign keys reference, it does not hold T8: a reader of T8 is not blocked.
  const writer = await client(rdb.url);
  const reader = await client(rdb.url);
  try {
    await writer.query("begin");
    await writer.query(`lock table public.teams in row exclusive mode`);
    const waiting = migrate(rdb.url, [...BEFORE_V65, V65]);
    const deadline = Date.now() + 10_000;
    for (;;) {
      if ((await one(r, `select count(*)::int as n from pg_locks where not granted`)).n > 0) break;
      assert.ok(Date.now() < deadline, "v65 waits for the writer of public.teams");
      await new Promise((res) => setTimeout(res, 50));
    }
    await reader.query("set lock_timeout = '2s'");
    assert.equal((await reader.query(`select count(*)::int as n from ${T8}`)).rows.length, 1, "T8 is readable while v65 waits");
    assert.equal((await one(r, `select count(*)::int as n from pg_locks l where l.relation = '${T8}'::regclass and l.mode = 'AccessExclusiveLock'`)).n, 0, "no exclusive lock on T8 yet");
    // The reader now holds nothing; a holder of T8 at the moment v65 reaches it fails it at once.
    await reader.query("begin");
    await reader.query(`select 1 from ${T8} limit 1`);
    await writer.query("commit");
    await migrationRefused(waiting, /SQLSTATE 55P03/, "T8 busy when v65 reaches it");
  } finally {
    await writer.query("rollback").catch(() => {});
    await reader.query("rollback").catch(() => {});
    await writer.end();
    await reader.end();
  }
  assert.deepEqual(await catalog(r), W.before, "nothing applied");
  for (const name of REPLACED) {
    const original = (await one(r, `select pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'training_load'::regnamespace and p.proname = $1`, [name])).def;
    await r.query(fake(name));
    try {
      await migrationRefused(migrate(rdb.url, [...BEFORE_V65, V65]), new RegExp(`SQLSTATE 23514[\\s\\S]*v65 refused: the body in force of training_load\\.${name} is not`), name);
    } finally {
      await r.query(original);
    }
    assert.deepEqual(await catalog(r), W.before, `${name}: nothing applied, and the body is back`);
  }
  await r.query(`alter table ${T8} drop constraint source_metric_audit_action_check, add constraint source_metric_audit_action_check check (action in (
    'source_metric_create', 'source_metric_revision_create', 'source_metric_unit_verified', 'source_metric_meaning_verified', 'source_metric_revision_activate', 'source_metric_revision_retire',
    'source_metric_retire', 'mapping_create', 'mapping_version_create', 'mapping_status', 'mapping_version_replaced', 'activation_start', 'activation_end', 'unit_conversion_create',
    'unit_conversion_retire', 'source_instance_end', 'another_action'))`);
  try {
    await migrationRefused(migrate(rdb.url, [...BEFORE_V65, V65]), /SQLSTATE 23514[\s\S]*v65 refused: the action CHECK of training_load\.source_metric_audit is not v34's/);
  } finally {
    await r.query(`alter table ${T8} drop constraint source_metric_audit_action_check, add constraint source_metric_audit_action_check check (action in (
      'source_metric_create', 'source_metric_revision_create', 'source_metric_unit_verified', 'source_metric_meaning_verified', 'source_metric_revision_activate', 'source_metric_revision_retire',
      'source_metric_retire', 'mapping_create', 'mapping_version_create', 'mapping_status', 'mapping_version_replaced', 'activation_start', 'activation_end', 'unit_conversion_create',
      'unit_conversion_retire', 'source_instance_end'))`);
  }
  assert.deepEqual(await catalog(r), W.before, "the CHECK is back");
  const failing = `${await fsp.readFile(V65_FILE, "utf8")}\nselect 1 / 0;\n`;
  await assert.rejects(migrate(rdb.url, BEFORE_V65, { extra: { name: V65, text: failing } }));
  assert.deepEqual(await catalog(r), W.before, "a failing v65 leaves nothing");
});

test("A3. v65 through the runner - waiting for a writer of T4 - adds exactly its three tables, T8's column, three constraints and index, fifteen functions and twelve triggers; the four bodies are the old ones plus the marked lines, byte for byte; every expected value of the post-check, which names the file's sha256", async () => {
  const holder = await client(rdb.url);
  try {
    await holder.query("begin");
    await holder.query(`lock table ${T4} in row exclusive mode`);
    const applying = migrate(rdb.url, [...BEFORE_V65, V65]);
    const deadline = Date.now() + 10_000;
    for (;;) {
      if ((await one(r, `select count(*)::int as n from pg_locks where not granted`)).n > 0) break;
      assert.ok(Date.now() < deadline, "v65 waits for the writer of T4");
      await new Promise((res) => setTimeout(res, 50));
    }
    await holder.query("commit");
    await applying;
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  const after = await catalog(r);
  const before = W.before;
  const NEW_TABLES = ["source_metric_confirmation_items", "source_metric_confirmation_sessions", "source_metric_confirmations"];
  const isNew = (x) => NEW_TABLES.includes(x.table_name ?? x.tablename ?? x.relname);
  const t8 = (x) => x.table_name === "source_metric_audit";
  assert.deepEqual(after.tables.filter((x) => !isNew(x) && !t8(x)), before.tables.filter((x) => !t8(x)), "every other table and comment unchanged");
  assert.deepEqual(after.tables.filter(isNew).map((x) => x.table_name), NEW_TABLES);
  assert.notEqual(after.tables.find(t8).comment, V34_T8_COMMENT);
  assert.deepEqual(after.columns.filter((x) => !isNew(x) && !(t8(x) && x.column_name === "confirmation_id")), before.columns, "one new column outside the new tables");
  assert.equal(after.columns.filter((x) => t8(x) && x.column_name === "confirmation_id").length, 1);
  const conKey = (x) => `${x.rel}.${x.conname}`;
  const newCon = after.constraints.filter((x) => !before.constraints.some((y) => conKey(y) === conKey(x)) && !/source_metric_confirmation/.test(x.rel));
  assert.deepEqual(newCon.map((x) => x.conname).sort(), ["source_metric_audit_confirmation_fk", "source_metric_audit_confirmation_iff", "source_metric_audit_erased_reason_check"]);
  assert.deepEqual(after.constraints.filter((x) => before.constraints.some((y) => conKey(y) === conKey(x) && y.def !== x.def)).map((x) => x.conname), ["source_metric_audit_action_check"]);
  assert.deepEqual(before.constraints.filter((x) => !after.constraints.some((y) => conKey(y) === conKey(x))), [], "no constraint removed");
  assert.deepEqual(after.indexes.filter((x) => !isNew(x) && !before.indexes.some((y) => y.indexname === x.indexname)).map((x) => x.indexname), ["source_metric_audit_v65_confirmation_once"]);
  assert.deepEqual(after.triggers.filter((x) => !isNew(x)), before.triggers, "no trigger outside the new tables changed");
  assert.equal(after.triggers.filter(isNew).length, 12);
  const fnKey = (x) => `${x.nspname}.${x.proname}(${x.args})`;
  assert.equal(after.functions.filter((x) => !before.functions.some((y) => fnKey(y) === fnKey(x))).length, 15, "fifteen new functions");
  assert.deepEqual(before.functions.filter((x) => !after.functions.some((y) => fnKey(y) === fnKey(x))), [], "no function removed");
  assert.deepEqual(after.functions.filter((x) => before.functions.some((y) => fnKey(y) === fnKey(x) && y.digest !== x.digest)).map((x) => x.proname).sort(), [...REPLACED].sort());
  assert.deepEqual(after.migrations, [...before.migrations, V65_NAME].sort());
  // Byte for byte: the new body without its marked lines is the old body.
  W.newBodies = await bodies(r);
  for (const name of REPLACED) {
    const marked = W.newBodies[name].match(/^ *-- M-A \(J18\) begin\n[\s\S]*?^ *-- M-A \(J18\) end\n/gm) ?? [];
    assert.ok(marked.length >= 1, `${name} carries its marked lines`);
    let stripped = W.newBodies[name];
    for (const part of marked) stripped = stripped.replace(part, "");
    assert.equal(stripped, W.oldBodies[name], `${name}: every unmarked line is the body in force before v65`);
  }
  const post = await blocks(r, POSTCHECK);
  assert.deepEqual(Object.keys(post).map(Number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(post[1][0], { v65_rows: "1", v65_checksum_ok: true, later_migrations: "0" });
  assert.deepEqual(post[2][0], { bodies_v65: "4" });
  assert.deepEqual(post[3][0], { tables: "3", new_functions: "15", audit_column: "1", audit_constraints: "3", audit_index: "1", action_check_is_v65: true, comment_is_v65: true });
  assert.deepEqual(post[4][0], { expected_enabled: "19", triggers_total: "19" });
  assert.deepEqual(post[5][0], { confirmations: "0", sessions: "0", items: "0", audit_rows: "0" });
  assert.deepEqual(post[6][0], { table_locks: "0", migrator_lock: "0", idle_in_transaction: "0" });
  const sha = crypto.createHash("sha256").update(await fsp.readFile(V65_FILE)).digest("hex");
  assert.ok((await fsp.readFile(POSTCHECK, "utf8")).includes(sha), "the post-check names the v65 file's sha256");
  const pre = await blocks(r, PREFLIGHT);
  assert.equal(pre[2][0].v65_rows, "1");
  assert.deepEqual(Object.values(pre[3][0]), [false, false, false, false]);
  assert.deepEqual(Object.values(pre[4][0]), [false, false]);
  W.after = after;
});

test("A4. the rollback refuses, changing nothing: under a later migration, once a confirmation or an audit row of one exists, while a v65 object is missing or a trigger is disabled, while a body in force is not v65's, and while the migrator holds its lock", async () => {
  const sql = await fsp.readFile(ROLLBACK, "utf8");
  const refuses = async (plant, pattern) => {
    const error = await inRolledBack(r, plant, sql);
    assert.match(error?.message ?? "", pattern);
    assert.deepEqual(await catalog(r), W.after, `nothing changed (${pattern})`);
  };
  await refuses(LATER, /^v65 rollback refused: later migrations are applied$/);
  const rawConfirmation = async (c) => {
    await replica(c);
    const id = crypto.randomUUID();
    await c.query(`insert into ${T9} (id, operation_id, kind, owner_scope, owner_club_id, binding_id, team_id, credential_connection_id, confirmed_by_user_id, confirmed_basis, confirmed_at, attested, display_registry_version, values_expire_at)
                   values ($1,$1,'team_mapping','club',$1,$1,$1,$1,$1,'club_admin',now(),false,1,now() + interval '2160 hours')`, [id]);
    return id;
  };
  await refuses(rawConfirmation, /^v65 rollback refused: a confirmation exists$/);
  await refuses(async (c) => {
    await replica(c);
    const id = crypto.randomUUID();
    await c.query(`insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id) values ('confirmation_values_expired',$1,$1,'platform_admin',$1)`, [id]);
  }, /^v65 rollback refused: an audit row of a confirmation exists$/);
  await refuses((c) => c.query(`drop table ${T9I} cascade`), /^v65 rollback refused: a v65 table is missing$/);
  await refuses((c) => c.query(`drop trigger source_metric_confirmation_items_removal_link on ${T9I}`), /^v65 rollback refused: a trigger of the v65 tables is missing$/);
  await refuses((c) => c.query(`alter table ${T9S} disable trigger source_metric_confirmation_sessions_insert_guard`), /^v65 rollback refused: a trigger is disabled$/);
  await refuses((c) => c.query(`alter table ${T8} disable trigger source_metric_audit_v37_revision_guard`), /^v65 rollback refused: a trigger is disabled$/);
  await refuses((c) => c.query(`alter table ${T8} drop constraint source_metric_audit_erased_reason_check`), /^v65 rollback refused: a v65 constraint of the audit table is missing$/);
  await refuses((c) => c.query(`drop index training_load.source_metric_audit_v65_confirmation_once`), /^v65 rollback refused: the v65 index of the audit table is missing$/);
  await refuses((c) => c.query(`drop function training_load.remove_expired_confirmation_values(integer)`), /^v65 rollback refused: a v65 function is missing$/);
  for (const name of REPLACED) await refuses((c) => c.query(fake(name)), new RegExp(`^v65 rollback refused: the body in force of ${name} is not v65's$`));
  assert.match(await fsp.readFile(path.join(ROOT, "backend", "src", "migrate.js"), "utf8"), /export const MIGRATION_LOCK_KEY = 822026n;/);
  const migrator = await client(rdb.url);
  try {
    await migrator.query("select pg_advisory_lock(822026)");
    await refuses(null, /^v65 rollback refused: the migrator is running$/);
  } finally {
    await migrator.query("select pg_advisory_unlock(822026)").catch(() => {});
    await migrator.end();
  }
});

test("A5. the rollback returns the catalog before v65 exactly (comments included; the four bodies byte for byte) and changes no row; v65 then applies again to the same catalog", async () => {
  const count = () => one(r, `select (select count(*)::int from ${T4}) as t4, (select count(*)::int from ${T5}) as t5, (select count(*)::int from ${T8}) as t8`);
  const before = await count();
  await r.query(await fsp.readFile(ROLLBACK, "utf8"));
  assert.deepEqual(await catalog(r), W.before, "the catalog before v65");
  assert.deepEqual(await bodies(r), W.oldBodies, "the four bodies byte for byte");
  assert.equal((await one(r, `select obj_description('${T8}'::regclass, 'pg_class') as c`)).c, V34_T8_COMMENT);
  assert.deepEqual(await count(), before);
  await migrate(rdb.url, [...BEFORE_V65, V65]);
  assert.deepEqual(await catalog(r), W.after, "v65 again");
  assert.deepEqual(await bodies(r), W.newBodies);
});

test("A6. the three runbook SQL files and the migration are bound to LF by .gitattributes (git check-attr eol) and carry no CR", async () => {
  const files = [ROLLBACK, PREFLIGHT, POSTCHECK, V65_FILE].map((f) => path.relative(ROOT, f));
  const out = execFileSync("git", ["check-attr", "eol", "--", ...files], { cwd: ROOT, encoding: "utf8" });
  for (const f of files) assert.match(out, new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: eol: lf$`, "m"), f);
  for (const f of [ROLLBACK, PREFLIGHT, POSTCHECK, V65_FILE]) assert.ok(!(await fsp.readFile(f, "utf8")).includes("\r"), `${path.basename(f)} has LF line endings`);
});

// ---------------------------------------------------------------------------
// B. The behaviour database (through v65).
// ---------------------------------------------------------------------------
test("B1. a whole save commits for the club's admin and for a platform admin; the time, the expiry, the salt and the digest are the database's; a row that was not compared stores nothing", async () => {
  const done = await committed(W.caA, { n: 2 });
  const conf = await one(k, `select *, extract(epoch from (values_expire_at - confirmed_at)) as kept from ${T9} where id = $1`, [done.id]);
  assert.equal(conf.confirmed_basis, "club_admin");
  assert.equal(conf.owner_club_id, W.clubA);
  assert.ok(Math.abs(Date.now() - new Date(conf.confirmed_at).getTime()) < 60_000, "confirmed_at is the database's clock, not the writer's 2001");
  assert.equal(Number(conf.kept), 90 * 24 * 3600, "the expiry is the confirmation plus 90 days, not the writer's");
  const items = await itemsOf(done.id);
  assert.equal(items.length, 2);
  for (const it of items) {
    assert.equal(it.values_salt.length, 16);
    assert.match(it.values_digest, /^[0-9a-f]{64}$/);
    assert.deepEqual([it.raw_a, it.stored_a, it.raw_b, it.stored_b].map(Number), [120, 2, 300, 5]);
    assert.equal((await one(k, `select training_load.source_metric_confirmation_item_digest(i) as d from ${T9I} i where i.id = $1`, [it.id])).d, it.values_digest, "the digest is the function's over the stored row");
  }
  assert.notEqual(items[0].values_salt.toString("hex"), items[1].values_salt.toString("hex"), "two rows with the same values get different salts");
  assert.notEqual(items[0].values_digest, items[1].values_digest, "and different digests");
  const session = await one(k, `select * from ${T9S} where confirmation_id = $1`, [done.id]);
  assert.equal(new Date(session.session_started_at).toISOString(), new Date(done.s.cand.session_started_at).toISOString());
  const audit = await rows(k, `select action, basis, team_id, request_key from ${T8} where confirmation_id = $1`, [done.id]);
  assert.deepEqual(audit.map((a) => [a.action, a.basis, a.team_id, a.request_key !== null]), [["mapping_confirmation", "club_admin", done.b.teamId, true]]);
  // A salt and a digest the writer supplies are overwritten.
  const b = await binding(W.clubA);
  const s = await stored(b);
  const v = await activeVersion(W.caA);
  const supplied = await save(W.caA, { stored: s, items: [checkedItem(v, { salt: Buffer.alloc(16, 7), digest: "0".repeat(64) })], commit: true });
  passes(supplied, "a supplied salt and digest");
  const [own] = await itemsOf(supplied.id);
  assert.notEqual(own.values_salt.toString("hex"), Buffer.alloc(16, 7).toString("hex"));
  assert.notEqual(own.values_digest, "0".repeat(64));
  // A platform admin, with the platform_admin basis; system and club rows that were not compared.
  const bp = await binding(W.clubA);
  const sp = await stored(bp);
  const vSys = await activeVersion(W.pa);
  const vClub = await activeVersion(W.caA);
  const mixed = await save(W.pa, { stored: sp, items: [{ v: vSys, kind: "system_mapping", checked: false }, plainItem(vClub)], commit: true });
  passes(mixed, "a platform admin's save of rows that were not compared");
  const plain = await itemsOf(mixed.id);
  for (const it of plain) assert.deepEqual([it.checked, it.raw_a, it.stored_a, it.raw_b, it.stored_b, it.values_salt, it.values_digest, it.gpexe_display_rule, it.gpexe_display_unit], [false, null, null, null, null, null, null, null, null]);
  assert.equal((await one(k, `select attested, confirmed_basis from ${T9} where id = $1`, [mixed.id])).attested, false);
});

test("B2. the actor guard: no acting user, another user, a basis that is not the derived one, another club's admin, a club admin without the role or inactive, an archived club, and a write inside a savepoint are refused", async () => {
  refusedWith(await save(W.caA, { context: false }), "42501", /^source metric mapping: no acting user is set for this transaction$/);
  refusedWith(await save(W.caA, { confirmedBy: W.caA2.id }), "42501", /^source metric confirmation: the row names another user than the acting user$/);
  refusedWith(await save(W.caA, { basis: "platform_admin", start: false }), "42501", /^source metric confirmation: the acting user may not write this confirmation$/);
  refusedWith(await save(W.pa, { basis: "club_admin", start: false }), "42501", /^source metric confirmation: the acting user may not write this confirmation$/);
  refusedWith(await save(W.caB, { start: false }), "42501", /^source metric confirmation: the acting user may not write this confirmation$/);
  // The club in the row is not the binding's club: club B's admin naming its own club on club A's binding.
  refusedWith(await save(W.caB, { start: false, clubId: W.clubB }), "23514", /^source_metric_confirmations: the binding's connection is not owned by the confirmation's club$/);
  const revoked = await clubAdmin(W.clubA);
  await k.query(`update public.user_club_roles set is_active = false where user_id = $1`, [revoked.id]);
  refusedWith(await save(revoked, { start: false }), "42501", /^source metric confirmation: the acting user may not write this confirmation$/);
  const inactive = await clubAdmin(W.clubA);
  await k.query(`update public.users set is_active = false where id = $1`, [inactive.id]);
  refusedWith(await save(inactive, { start: false }), "42501", /^source metric confirmation: the acting user may not write this confirmation$/);
  const clubC = await club("Club C");
  const caC = await clubAdmin(clubC);
  const bC = await binding(clubC);
  const sC = await stored(bC);
  const vC = await activeVersion(caC);
  passes(await save(caC, { stored: sC, items: [checkedItem(vC)] }), "club C while active");
  await k.query(`update public.clubs set is_active = false where id = $1`, [clubC]);
  refusedWith(await save(caC, { stored: sC, items: [checkedItem(vC)], start: false }), "42501", /^source metric confirmation: the acting user may not write this confirmation$/);
  refusedWith(await save(W.pa, { stored: sC, items: [checkedItem(vC)], start: false }), "42501", /^source metric confirmation: the acting user may not write this confirmation$/);
  // A confirmation written inside a savepoint: its rows are refused (another xmin).
  refusedWith(await save(W.caA, { savepoint: true }), "23514", /^source_metric_confirmations: a row of a confirmation is written with its confirmation in the same transaction$/);
  // A row for another user's confirmation of an earlier transaction.
  const done = await committed(W.caA);
  refusedWith(await tx(W.caA2.id, (c) => itemRow(c, done.id, 9, plainItem(W.vA2))), "23514", /^source_metric_confirmations: a row of a confirmation is written with its confirmation in the same transaction$/);
});

test("B3. the binding's facts: an ended binding, another team, a connection that is not the binding's, and a team-owned connection are refused with fixed messages; the guards take no row lock on the binding, the connection, the check or the candidate", async () => {
  const b = await binding(W.clubA);
  const s = await stored(b);
  const v = await activeVersion(W.caA);
  refusedWith(await save(W.caA, { stored: s, items: [checkedItem(v)], start: false, connectionId: W.bB.connectionId }), "23514", /^source_metric_confirmations: the connection is not the binding's$/);
  refusedWith(await save(W.caA, { stored: s, items: [checkedItem(v)], start: false, bindingId: W.bTeamOwned.bindingId, teamId: W.bTeamOwned.teamId, connectionId: W.bTeamOwned.connectionId }), "23514",
    /^source_metric_confirmations: the binding's connection is not owned by the confirmation's club$/);
  // Another team than the binding's: the composite foreign key refuses it (ids only, never a value).
  refusedWith(await save(W.caA, { stored: s, items: [checkedItem(v)], start: false, teamId: W.bA2.teamId }), "23514", /^source_metric_confirmations: the team is not the binding's$/);
  // The guards read with plain reads: a peer that holds the binding and the
  // connection the way an Unbind's or a Reconnect's update does (FOR NO KEY
  // UPDATE), and the check and the candidate FOR UPDATE, does not make a save
  // wait: a guard's FOR SHARE would. (The foreign keys of T9 and T5 take FOR
  // KEY SHARE on the binding and the connection; an Unbind itself takes the
  // binding FOR UPDATE, which those foreign keys wait for, as a T5 start does.)
  const peer = await client();
  try {
    await peer.query("begin");
    await peer.query(`select 1 from training_load.source_team_bindings where id = $1 for no key update`, [b.bindingId]);
    await peer.query(`select 1 from training_load.source_credential_connections where id = $1 for no key update`, [b.connectionId]);
    await peer.query(`select 1 from training_load.gpexe_import_checks where id = $1 for no key update`, [s.checkId]);
    await peer.query(`select 1 from training_load.gpexe_import_candidates where id = $1 for update`, [s.cand.id]);
    const started = Date.now();
    passes(await save(W.caA, { stored: s, items: [checkedItem(v)], before: (c) => c.query("set local lock_timeout = '2s'") }), "a save while a peer holds the v27 rows, the check and the candidate");
    assert.ok(Date.now() - started < 2_000, "no wait");
  } finally {
    await peer.query("rollback").catch(() => {});
    await peer.end();
  }
  await k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'Test unbind.' where id = $1`, [b.bindingId, W.pa.id]);
  refusedWith(await save(W.caA, { stored: s, items: [checkedItem(v)], start: false }), "23514", /^source_metric_confirmations: the team binding is not active$/);
});

test("B4. the session's facts: a candidate of another team, last seen by another check, with another content, superseded, an undone import, another session id or start, a check that did not succeed or read through another binding, and a second session are each refused", async () => {
  const b = await binding(W.clubA);
  const s = await stored(b);
  const v = await activeVersion(W.caA);
  const base = { stored: s, items: [checkedItem(v)] };
  passes(await save(W.caA, base), "the facts as they are");
  const S = (sessionFacts, pattern) => save(W.caA, { ...base, sessionFacts }).then((res) => refusedWith(res, "23514", pattern));
  await S({ candidateId: W.sB.cand.id }, /^source_metric_confirmation_sessions: the candidate is not a stored session of this team$/);
  await S({ candidateId: crypto.randomUUID() }, /^source_metric_confirmation_sessions: the candidate is not a stored session of this team$/);
  await S({ hash: hash() }, /^source_metric_confirmation_sessions: the candidate's content is not the one confirmed$/);
  await S({ sessionId: "424242" }, /^source_metric_confirmation_sessions: the session id is not the candidate's$/);
  await S({ startedAt: "2026-09-14T18:08:13Z" }, /^source_metric_confirmation_sessions: the session's start is not the candidate's$/);
  await S({ teamId: W.bA2.teamId }, /^source_metric_confirmation_sessions: the session's team is not the confirmation's$/);
  const otherCheck = await check(b);
  await S({ checkId: otherCheck }, /^source_metric_confirmation_sessions: the candidate was last seen by another check$/);
  // A check that did not succeed, and one that read through another binding of the same team's club.
  const failed = await check(b, { status: "running" });
  const cFailed = await candidate(b, failed);
  refusedWith(await save(W.caA, { ...base, stored: { b, checkId: failed, cand: cFailed } }), "23514", /^source_metric_confirmation_sessions: the check did not succeed for this team$/);
  // (The checks table itself refuses a check of this team through another binding; planted with the triggers off.)
  const viaOther = await planted(() => check(b, { via: W.bA2 }));
  const cOther = await candidate(b, viaOther);
  refusedWith(await save(W.caA, { ...base, stored: { b, checkId: viaOther, cand: cOther } }), "23514", /^source_metric_confirmation_sessions: the check did not read through the confirmation's binding$/);
  // A candidate with no start: the row's NOT NULL start can never equal it.
  const noStart = await candidate(b, s.checkId, { startedAt: null });
  refusedWith(await save(W.caA, { ...base, stored: { b, checkId: s.checkId, cand: { ...noStart, session_started_at: "2026-09-14T18:08:12Z" } } }), "23514", /^source_metric_confirmation_sessions: the session's start is not the candidate's$/);
  // Superseded, and an undone import (planted with the triggers off).
  const sup = await stored(b);
  await k.query(`update training_load.gpexe_import_candidates set status = 'superseded', superseded_by_check_id = $2 where id = $1`, [sup.cand.id, sup.checkId]);
  refusedWith(await save(W.caA, { ...base, stored: sup }), "23514", /^source_metric_confirmation_sessions: the candidate is superseded$/);
  const undone = await stored(b);
  await planted((c) => c.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now(), import_undone_at = now(), import_undone_request_id = gen_random_uuid() where id = $1`, [undone.cand.id]));
  refusedWith(await save(W.caA, { ...base, stored: undone }), "23514", /^source_metric_confirmation_sessions: the candidate is an undone import$/);
  // Exactly one session: a second ordinal is refused by the table, none at COMMIT.
  refusedWith(await save(W.caA, { ...base, sessions: 2 }), "23514", /source_metric_confirmation_sessions_ordinal_check/);
  refusedWith(await save(W.caA, { ...base, session: false }), "23514", /^source_metric_confirmations: a team's confirmation has exactly one session$/);
});

test("B5. each row against T4 and T2b: another club's version, a system version as a club row and the reverse, a compared system row, a wrong revision, fingerprint, unit or factor, a revision that is not verified, a level other than session, and a row created with a removal are refused", async () => {
  const b = await binding(W.clubA);
  const s = await stored(b);
  const v = await activeVersion(W.caA);
  const I = (item, pattern, opts = {}) => save(W.caA, { stored: s, items: [item], start: false, ...opts }).then((res) => refusedWith(res, "23514", pattern));
  await I(checkedItem(W.vB), /^source_metric_confirmation_items: a club row names a mapping version of the confirmation's club$/);
  await I(checkedItem(W.vSys), /^source_metric_confirmation_items: a club row names a mapping version of the confirmation's club$/);
  await I({ v, kind: "system_mapping", checked: false }, /^source_metric_confirmation_items: a system row names a system mapping version$/);
  await I({ ...checkedItem(W.vSys), kind: "system_mapping" }, /^source_metric_confirmation_items: a system mapping is not compared$/);
  await I({ ...checkedItem(v), versionId: crypto.randomUUID() }, /^source_metric_confirmation_items: the row names no mapping version$/);
  const other = await versionRow(W.vA2.versionId);
  const FACTS = /^source_metric_confirmation_items: the row's facts are not the mapping version's$/;
  await I(checkedItem(v, { facts: { source_metric_version_id: other.source_metric_version_id } }), FACTS);
  await I(checkedItem(v, { facts: { parameter_fingerprint: "another" } }), FACTS);
  await I(checkedItem(v, { facts: { source_unit: "min" } }), FACTS);
  await I(checkedItem(v, { facts: { target_unit: "s" } }), FACTS);
  await I(checkedItem(v, { facts: { scale: "2" } }), FACTS);
  await I(checkedItem(v, { facts: { scale_divisor: "1" } }), FACTS);
  await I(checkedItem(v, { facts: { offset: "1" } }), FACTS);
  await I(checkedItem(v, { level: "drill" }), /^source_metric_confirmation_items: the two athletes are compared at the session level$/);
  await I(checkedItem(v, { removedAt: new Date().toISOString(), removedKind: "erased", removedBy: W.pa.id }), /^source_metric_confirmation_items: a row is created with no removal$/);
  // A revision whose meaning is not confirmed (not verified): its version can be drafted, never confirmed.
  const vr = await activeVersion(W.caA, { f: await field({ verified: false }), activate: false });
  await I(checkedItem(vr), /^source_metric_confirmation_items: the source revision must be active and verified$/);
  // One row per version, and one per number, in a confirmation.
  refusedWith(await save(W.caA, { stored: s, items: [checkedItem(v), checkedItem(v)], startItems: [checkedItem(v)] }), "23505", /source_metric_confirmation_items_version_key/);
});

test("B6. the value rules are refused by the BEFORE trigger with fixed text that carries no value, in the message, the detail, the hint or the context; each backstop CHECK refuses on its own with the trigger off", async () => {
  const b = await binding(W.clubA);
  const s = await stored(b);
  const v = await activeVersion(W.caA);
  const [P1, P2, P3] = PLANTED;
  const clean = (error, label) => {
    const text = [error.message, error.detail, error.hint, error.where, error.internalQuery].filter(Boolean).join("\n");
    for (const p of [...PLANTED, "120", "300"]) assert.ok(!text.includes(p), `${label}: the error carries no value (${p})`);
    return error;
  };
  const V = async (over, pattern) => clean(refusedWith(await save(W.caA, { stored: s, items: [checkedItem(v, over)], start: false }), "23514", pattern), String(pattern));
  await V({ rawA: "0", storedA: "0", rawB: P1, storedB: P2 }, /^source_metric_confirmation_items: the two athletes' values are non-zero and different$/);
  await V({ rawA: P1, storedA: P2, rawB: "0", storedB: "0" }, /^source_metric_confirmation_items: the two athletes' values are non-zero and different$/);
  await V({ rawA: P1, storedA: P2, rawB: P1, storedB: P2 }, /^source_metric_confirmation_items: the two athletes' values are non-zero and different$/);
  await V({ rawA: P1, storedA: P3, rawB: "300", storedB: "5" }, /^source_metric_confirmation_items: a stored value is not the conversion of its raw value$/);
  await V({ rawA: "120", storedA: "2", rawB: P1, storedB: P3 }, /^source_metric_confirmation_items: a stored value is not the conversion of its raw value$/);
  await V({ rawA: null, storedA: P2 }, /^source_metric_confirmation_items: a compared row stores four finite values$/);
  await V({ storedB: null, rawB: P1 }, /^source_metric_confirmation_items: a compared row stores four finite values$/);
  await V({ rawA: "NaN", rawB: P1 }, /^source_metric_confirmation_items: a compared row stores four finite values$/);
  await V({ rawB: "Infinity", rawA: P1 }, /^source_metric_confirmation_items: a compared row stores four finite values$/);
  await V({ storedA: "-Infinity", rawA: P1 }, /^source_metric_confirmation_items: a compared row stores four finite values$/);
  // The three columns no other rule reads: refused by the trigger, never by NOT NULL or a CHECK that prints the row.
  const NAMES = /^source_metric_confirmation_items: a row names its id, its session and a positive number$/;
  for (const itemNo of [0, -3]) await V({ itemNo, rawA: P1, storedA: "123.1875" }, NAMES);
  const rawRow = async (column, value) => {
    const res = await save(W.caA, { stored: s, items: [], start: false, then: async (c, out) => {
      const row = await versionRow(v.versionId);
      const cols = { id: crypto.randomUUID(), session_ordinal: 1, item_no: 1, [column]: value };
      await c.query(`insert into ${T9I} (id, confirmation_id, session_ordinal, item_no, item_kind, checked, source_metric_version_id, mapping_version_id, parameter_fingerprint,
                       source_unit, target_unit, scale, scale_divisor, "offset", compared_level, gpexe_display_rule, gpexe_display_unit, raw_a, stored_a, raw_b, stored_b)
                     values ($1,$2,$3,$4,'club_mapping',true,$5,$6,$7,$8,$9,$10,$11,$12,'session','duration_mmss','mm:ss',$13,$14,'300','5')`,
      [cols.id, out.id, cols.session_ordinal, cols.item_no, row.source_metric_version_id, v.versionId, row.parameter_fingerprint, row.source_unit, row.target_unit,
        row.scale, row.scale_divisor, row.offset, P1, "123.1875"]);
    } });
    clean(refusedWith(res, "23514", NAMES), `${column} null`);
  };
  for (const column of ["id", "session_ordinal", "item_no"]) await rawRow(column, null);
  const DISPLAY = /^source_metric_confirmation_items: a compared row names a display rule and a unit of that rule$/;
  await V({ rule: null, rawA: P1 }, DISPLAY);
  await V({ unit: null, rawA: P1 }, DISPLAY);
  await V({ rule: "duration_mmss", unit: "km/h", rawA: P1 }, DISPLAY);
  await V({ rule: "speed_kmh", unit: "mph", rawA: P1 }, DISPLAY);
  await V({ rule: "Duration", unit: "mm:ss", rawA: P1 }, DISPLAY);
  await V({ rule: "bursts", unit: "count", rawA: P1 }, DISPLAY);
  const PLAIN = /^source_metric_confirmation_items: a row that was not compared stores no values and no display unit$/;
  for (const over of [{ rawA: P1 }, { storedA: P2 }, { rawB: P1 }, { storedB: P2 }, { rule: "duration_mmss" }, { unit: "mm:ss" }]) {
    clean(refusedWith(await save(W.caA, { stored: s, items: [plainItem(v, over)], start: false }), "23514", PLAIN), "a row that was not compared");
  }
  // A salt and a digest the writer supplies for a row that was not compared are dropped, not stored.
  passes(await save(W.caA, { stored: s, items: [plainItem(v, { salt: Buffer.alloc(16, 7), digest: "0".repeat(64) })], then: async (c, out) => {
    const it = await one(c, `select values_salt, values_digest from ${T9I} where id = $1`, [out.itemIds[0]]);
    assert.deepEqual([it.values_salt, it.values_digest], [null, null]);
  } }), "a supplied salt and digest on a row that was not compared");
  // The three rules of the registry, and nothing else.
  for (const [rule, unit] of [["duration_mmss", "mm:ss"], ["distance_m", "m"], ["speed_kmh", "km/h"]]) passes(await save(W.caA, { stored: s, items: [checkedItem(v, { rule, unit })] }), rule);
  assert.deepEqual((await one(k, `select training_load.source_metric_display_unit_ok(null, 'm') as a, training_load.source_metric_display_unit_ok('distance_m', null) as b, training_load.source_metric_display_unit_ok('distance_m', 'km') as c`)), { a: false, b: false, c: false });
  // The backstops, each on its own: the insert guard off, inside a transaction that is rolled back.
  const backstop = async (item, constraint) => {
    const res = await save(W.caA, { stored: s, items: [item], start: false, afterConfirmation: (c) => c.query(`alter table ${T9I} disable trigger source_metric_confirmation_items_insert_guard`) });
    assert.equal(res.ok, false, constraint);
    assert.equal(res.error.code, "23514", res.error.message);
    assert.equal(res.error.constraint, constraint, res.error.message);
  };
  const salt = Buffer.alloc(16, 1);
  const digest = "a".repeat(64);
  const full = (over = {}) => checkedItem(v, { salt, digest, ...over });
  await backstop({ ...full(), kind: "system_mapping", v: W.vSys }, "source_metric_confirmation_items_system_unchecked");
  await backstop(full({ rule: "duration_mmss", unit: "km/h" }), "source_metric_confirmation_items_display_iff");
  await backstop(plainItem(v, { rule: "duration_mmss", unit: "mm:ss" }), "source_metric_confirmation_items_display_iff");
  await backstop(full({ digest: null }), "source_metric_confirmation_items_digest_iff");
  await backstop(plainItem(v, { digest }), "source_metric_confirmation_items_digest_iff");
  await backstop(full({ salt: null }), "source_metric_confirmation_items_values_together");
  await backstop(full({ rawA: null, storedA: null, rawB: null, storedB: null, salt: null }), "source_metric_confirmation_items_values_iff");
  await backstop(full({ salt: Buffer.alloc(8, 1) }), "source_metric_confirmation_items_salt_length");
  await backstop(full({ rawA: "120", storedA: "2", rawB: "120", storedB: "2" }), "source_metric_confirmation_items_values_distinct");
  await backstop(full({ rawA: "0", storedA: "0" }), "source_metric_confirmation_items_values_distinct");
  await backstop(full({ storedA: "3" }), "source_metric_confirmation_items_values_converted");
  await backstop(full({ removedKind: "expired" }), "source_metric_confirmation_items_removed_together");
  await backstop(plainItem(v, { removedAt: new Date().toISOString(), removedKind: "expired" }), "source_metric_confirmation_items_removed_checked");
  await backstop(full({ removedBy: W.pa.id }), "source_metric_confirmation_items_removed_by_check");
  await backstop(full({ rawA: null, storedA: null, rawB: null, storedB: null, salt: null, removedAt: new Date().toISOString(), removedKind: "erased" }), "source_metric_confirmation_items_erased_by_check");
  await backstop(full({ level: "drill" }), "source_metric_confirmation_items_level_check");
  await backstop(full({ itemNo: 0 }), "source_metric_confirmation_items_item_no_check");
  await backstop({ ...full(), kind: "field_unit" }, "source_metric_confirmation_items_kind_check");
  await backstop(full({ digest: "not-a-digest" }), "source_metric_confirmation_items_digest_format");
  await backstop(full({ rawA: null, storedA: null, rawB: null, storedB: null, salt: null, removedAt: new Date().toISOString(), removedKind: "lost", removedBy: W.pa.id }), "source_metric_confirmation_items_removed_kind_check");
  // T9s's own backstops, its insert guard off.
  const t9s = async (over, constraint) => {
    const res = await save(W.caA, { stored: s, items: [checkedItem(v)], start: false, ...over, afterConfirmation: (c) => c.query(`alter table ${T9S} disable trigger source_metric_confirmation_sessions_insert_guard`) });
    assert.equal(res.error?.constraint, constraint, res.error?.message);
  };
  await t9s({ sessionFacts: { hash: "ABC" } }, "source_metric_confirmation_sessions_hash_format");
  await t9s({ sessionFacts: { sessionId: "abc" } }, "source_metric_confirmation_sessions_session_format");
  await t9s({ pairIndex: -1 }, "source_metric_confirmation_sessions_pair_check");
  await t9s({ sessions: 2 }, "source_metric_confirmation_sessions_ordinal_check");
  // T9's own backstops, its insert guard off.
  const t9 = async (over, constraint) => {
    const res = await save(W.caA, { stored: s, items: [checkedItem(v)], start: false, ...over, before: (c) => c.query(`alter table ${T9} disable trigger source_metric_confirmations_insert_guard`) });
    assert.equal(res.error?.constraint, constraint, res.error?.message);
  };
  const times = { confirmedAt: "2026-01-01T00:00:00Z", expireAt: "2026-04-01T00:00:00Z" };
  await t9({ ...times, kind: "field_observation" }, "source_metric_confirmations_kind_check");
  await t9({ ...times, basis: "team_coach" }, "source_metric_confirmations_basis_check");
  await t9({ confirmedAt: "2026-01-01T00:00:00Z", expireAt: "2026-01-02T00:00:00Z" }, "source_metric_confirmations_expiry_check");
  await t9({ ...times, teamId: W.bA2.teamId }, "source_metric_confirmations_binding_fk");
  await t9({ ...times, ownerScope: "system" }, "source_metric_confirmations_owner_scope_check");
  await t9({ ...times, registryVersion: 0 }, "source_metric_confirmations_registry_version_check");
});

test("B7. append-only: a confirmation and its session never change; a row changes only by the removal of its values; nothing is deleted or truncated", async () => {
  const done = await committed(W.caA, { n: 1 });
  const [item] = await itemsOf(done.id);
  const R = async (sql, params, code, pattern) => {
    const res = await tx(W.pa.id, (c) => c.query(sql, params), { commit: false });
    refusedWith(res, code, pattern);
  };
  await R(`update ${T9} set attested = false where id = $1`, [done.id], "23514", /append-only/);
  await R(`delete from ${T9} where id = $1`, [done.id], "23514", /append-only/);
  await R(`truncate ${T9} cascade`, [], "23514", /./);
  await R(`update ${T9S} set pair_index = 3 where confirmation_id = $1`, [done.id], "23514", /append-only/);
  await R(`delete from ${T9S} where confirmation_id = $1`, [done.id], "23514", /append-only/);
  await R(`truncate ${T9S} cascade`, [], "23514", /./);
  await R(`delete from ${T9I} where id = $1`, [item.id], "23514", /^source_metric_confirmation_items: a row is never deleted$/);
  await R(`truncate ${T9I}`, [], "23514", /./);
  const ONLY = /^source_metric_confirmation_items: only the values of a row are removed$/;
  for (const set of ["checked = false", "item_no = 7", "item_kind = 'system_mapping'", "parameter_fingerprint = 'x'", "source_unit = 'm'", "target_unit = 'm'", "scale = 3", "scale_divisor = 3", `"offset" = 3`,
    "gpexe_display_rule = 'distance_m'", "gpexe_display_unit = 'm'", `values_digest = '${"b".repeat(64)}'`, "id = gen_random_uuid()", `mapping_version_id = '${W.vA2.versionId}'`]) {
    await R(`update ${T9I} set ${set} where id = $1`, [item.id], "23514", ONLY);
  }
  // A change of a value that is not its removal, and a removal of only a part.
  await R(`update ${T9I} set raw_a = 1 where id = $1`, [item.id], "23514", /^source_metric_confirmation_items: a removal nulls the four values and the salt together$/);
  await R(`update ${T9I} set raw_a = null, stored_a = null, raw_b = null, stored_b = null, values_removed_kind = 'erased' where id = $1`, [item.id], "23514", /^source_metric_confirmation_items: a removal nulls the four values and the salt together$/);
  await R(`update ${T9I} set raw_a = null, stored_a = null, raw_b = null, stored_b = null, values_salt = null where id = $1`, [item.id], "23514", /^source_metric_confirmation_items: a removal is expired or erased$/);
  // A row that was not compared holds nothing to remove.
  const plain = await committed(W.caA, { checked: false });
  await R(`update ${T9I} set values_removed_kind = 'erased' where confirmation_id = $1`, [plain.id], "23514", /^source_metric_confirmation_items: the row holds no values to remove$/);
  assert.deepEqual((await itemsOf(done.id)).map((x) => [x.raw_a, x.values_removed_at]), [[item.raw_a, null]], "nothing changed");
});

test("B8. the deferred links at COMMIT: no keyed audit row, an unkeyed one, another user's or another operation's, no row, a version that is not active, a version with no activation started in this transaction, and attested that does not match are refused", async () => {
  const b = await binding(W.clubA);
  const s = await stored(b);
  const v = await activeVersion(W.caA);
  const base = { stored: s, items: [checkedItem(v)] };
  const KEYED = /^source_metric_confirmations: a confirmation is written with its keyed mapping_confirmation audit row$/;
  refusedWith(await save(W.caA, { ...base, audit: false }), "23514", KEYED);
  const FOLLOW = /^source_metric_audit: the audit row must follow its own confirmation in the same transaction$/;
  refusedWith(await save(W.caA, { ...base, keyed: false }), "23514", FOLLOW);
  refusedWith(await save(W.caA, { ...base, auditOperation: crypto.randomUUID() }), "23514", FOLLOW);
  // The COMMIT link on its own (T8's revision guard off for this transaction): an unkeyed row does not count.
  refusedWith(await save(W.caA, { ...base, keyed: false, before: (c) => c.query(`alter table ${T8} disable trigger source_metric_audit_v37_revision_guard`) }), "23514", KEYED);
  refusedWith(await save(W.caA, { ...base, auditTeam: W.bA2.teamId }), "23514", FOLLOW);
  refusedWith(await save(W.caA, { ...base, auditReason: "A reason." }), "23514", FOLLOW);
  refusedWith(await save(W.caA, { ...base, auditUser: W.caA2.id }), "42501", /^source metric mapping: the row names another user than the acting user$/);
  refusedWith(await save(W.caA, { ...base, auditBasis: "platform_admin" }), "42501", /^source metric confirmation: the acting user may not write this audit row$/);
  refusedWith(await save(W.caA, { ...base, items: [] }), "23514", /^source_metric_confirmations: a confirmation has at least one row$/);
  const SWITCHED = /^source_metric_confirmations: every row's mapping version is active and switched on for the binding in this transaction$/;
  // No activation at all, and one started on another binding of the club.
  refusedWith(await save(W.caA, { ...base, start: false }), "23514", SWITCHED);
  refusedWith(await save(W.caA, { ...base, startBinding: W.bA2 }), "23514", SWITCHED);
  // An activation of an earlier transaction does not count.
  const earlier = await tx(W.caA.id, (c) => startRow(c, W.caA, v, b, crypto.randomUUID(), "club_admin"));
  assert.equal(earlier.ok, true, earlier.error?.message);
  refusedWith(await save(W.caA, { ...base, start: false }), "23514", SWITCHED);
  // A version that is not active.
  refusedWith(await save(W.caA, { stored: await stored(await binding(W.clubA)), items: [checkedItem(W.vWaiting)], start: false }), "23514", SWITCHED);
  // The COMMIT link on its own: an open activation of this transaction on a version that is not active
  // (T5's guard never lets one start; planted with the triggers off) does not count.
  const bw = await binding(W.clubA);
  const waiting = await versionRow(W.vWaiting.versionId);
  refusedWith(await save(W.caA, { stored: await stored(bw), items: [checkedItem(W.vWaiting)], start: false, before: async (c) => {
    await replica(c);
    await c.query(`insert into ${T5} (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint,
                     source_team_binding_id, team_id, applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
                   values ($1,$2,$3,$4,$5,$6,$7,true,true,'required',$8,'club_admin','Planted.')`,
    [W.vWaiting.versionId, W.vWaiting.mappingId, waiting.source_metric_definition_id, waiting.metric_definition_id, waiting.parameter_fingerprint, bw.bindingId, bw.teamId, W.caA.id]);
    await c.query("set local session_replication_role = origin");
  } }), "23514", SWITCHED);
  // attested must say whether a row was compared.
  const b2 = await binding(W.clubA);
  const s2 = await stored(b2);
  const v2 = await activeVersion(W.caA);
  const ATTESTED = /^source_metric_confirmations: a confirmation is attested exactly when a row was compared$/;
  refusedWith(await save(W.caA, { stored: s2, items: [checkedItem(v2)], attested: false }), "23514", ATTESTED);
  refusedWith(await save(W.caA, { stored: s2, items: [plainItem(v2)], attested: true }), "23514", ATTESTED);
  // A row added after the confirmation's own link was forced early is still held to the rules at COMMIT.
  const v3 = await activeVersion(W.caA);
  refusedWith(await save(W.caA, { stored: s2, items: [checkedItem(v2)], then: async (c, out) => {
    await c.query("set constraints all immediate");
    await c.query("set constraints all deferred");
    await itemRow(c, out.id, 2, checkedItem(v3));
  } }), "23514", SWITCHED);
  // A second audit row for one confirmation.
  const twice = await save(W.caA, { stored: s2, items: [checkedItem(v2)], then: (c, out) => c.query(`insert into ${T8} (action, team_id, confirmation_id, performed_by_user_id, basis, operation_id, request_key, request_hash)
    values ('mapping_confirmation',$1,$2,$3,'club_admin',$4,$5,$6)`, [b2.teamId, out.id, W.caA.id, out.operationId, key(), hash()]) });
  refusedWith(twice, "23514", /^source_metric_audit: the confirmation already has its audit row$/);
});

test("B9. T8: confirmation_id is set exactly for the three actions; an erasure carries one of its two reason codes; a club-admin row names a club's confirmation; a removal row without its removal, or by a club admin, is refused; an existing action is written as before", async () => {
  const done = await committed(W.caA);
  const T = (actorId, sql, params) => tx(actorId, (c) => c.query(sql, params), { commit: false });
  // The table's own CHECKs, each on its own: the triggers off (they refuse first), inside a rolled-back transaction.
  const C = async (sql, params, constraint) => {
    const res = await tx(null, async (c) => { await replica(c); await c.query(sql, params); }, { commit: false });
    assert.equal(res.ok, false, constraint);
    assert.equal(res.error.constraint, constraint, res.error.message);
  };
  const id = () => crypto.randomUUID();
  await C(`insert into ${T8} (action, team_id, performed_by_user_id, basis, operation_id, request_key, request_hash) values ('mapping_confirmation',$1,$1,'platform_admin',$1,$2,$3)`, [id(), key(), hash()], "source_metric_audit_confirmation_iff");
  await C(`insert into ${T8} (action, mapping_id, confirmation_id, performed_by_user_id, basis, operation_id) values ('mapping_create',$1,$1,$1,'platform_admin',$1)`, [id()], "source_metric_audit_confirmation_iff");
  await C(`insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id, request_key, request_hash) values ('mapping_confirmation',$1,$1,'platform_admin',$1,$2,$3)`, [id(), key(), hash()], "source_metric_audit_action_shape");
  await C(`insert into ${T8} (action, team_id, confirmation_id, performed_by_user_id, basis, operation_id, reason) values ('mapping_confirmation',$1,$1,$1,'club_admin',$1,'A reason.')`, [id()], "source_metric_audit_action_shape");
  await C(`insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id, reason) values ('confirmation_values_expired',$1,$1,'platform_admin',$1,'A reason.')`, [id()], "source_metric_audit_action_shape");
  await C(`insert into ${T8} (action, team_id, confirmation_id, performed_by_user_id, basis, operation_id) values ('confirmation_values_expired',$1,$1,$1,'platform_admin',$1)`, [id()], "source_metric_audit_action_shape");
  await C(`insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id) values ('confirmation_values_erased',$1,$1,'platform_admin',$1)`, [id()], "source_metric_audit_action_shape");
  await C(`insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id, reason) values ('confirmation_values_erased',$1,$1,'club_admin',$1,'erasure_request')`, [id()], "source_metric_audit_action_shape");
  await C(`insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id) values ('confirmation_values_expired',$1,$1,'club_admin',$1)`, [id()], "source_metric_audit_action_shape");
  await C(`insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id, reason) values ('confirmation_values_erased',$1,$1,'platform_admin',$1,'The admin asked for it.')`, [id()], "source_metric_audit_erased_reason_check");
  await C(`insert into ${T8} (action, performed_by_user_id, basis, operation_id) values ('another_action',$1,'platform_admin',$1)`, [id()], "source_metric_audit_action_check");
  for (const reason of ["erasure_request", "wrong_confirmation"]) {
    const res = await tx(null, async (c) => { await replica(c); await c.query(`insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id, reason) values ('confirmation_values_erased',$1,$1,'platform_admin',$1,$2)`, [id(), reason]); }, { commit: false });
    assert.equal(res.ok, true, `${reason}: ${res.error?.message}`);
  }
  // With the triggers on: a confirmation row that names no confirmation is refused before any CHECK.
  refusedWith(await T(W.pa.id, `insert into ${T8} (action, team_id, performed_by_user_id, basis, operation_id, request_key, request_hash) values ('mapping_confirmation',$1,$2,'platform_admin',$3,$4,$5)`,
    [done.b.teamId, W.pa.id, crypto.randomUUID(), key(), hash()]), "42501", /^source metric confirmation: the acting user may not write this audit row$/);
  // A removal row with no removal behind it, and one by a club admin on the platform basis.
  const FOLLOW = /^source_metric_audit: the audit row must follow its own removal of values in the same transaction$/;
  refusedWith(await T(W.pa.id, `insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id, reason) values ('confirmation_values_erased',$1,$2,'platform_admin',$3,'erasure_request')`,
    [done.id, W.pa.id, crypto.randomUUID()]), "23514", FOLLOW);
  refusedWith(await T(W.pa.id, `insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id) values ('confirmation_values_expired',$1,$2,'platform_admin',$3)`,
    [done.id, W.pa.id, crypto.randomUUID()]), "23514", FOLLOW);
  refusedWith(await T(W.caA.id, `insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id, reason) values ('confirmation_values_erased',$1,$2,'platform_admin',$3,'erasure_request')`,
    [done.id, W.caA.id, crypto.randomUUID()]), "42501", /^source metric (mapping|confirmation): the acting user may not write this audit row$/);
  // The revision guard on its own (the insert guard and the actor guard off for this transaction): a removal
  // row on another basis than the platform admin's is refused by it, as a right, before any CHECK.
  const e0 = await committed(W.caA);
  refusedWith(await tx(W.pa.id, async (c) => {
    await c.query(`alter table ${T8} disable trigger source_metric_audit_insert_guard`);
    await c.query(`alter table ${T8} disable trigger source_metric_audit_v35_actor_guard`);
    await c.query(ERASE, [e0.id]);
    await auditRemoval(c, "confirmation_values_erased", e0.id, W.pa.id, { reason: "erasure_request", basis: "club_admin" });
  }, { commit: false }), "42501", /^source metric confirmation: the acting user may not write this audit row$/);
  // A club-admin confirmation row of a confirmation that does not exist.
  refusedWith(await T(W.caA.id, `insert into ${T8} (action, team_id, confirmation_id, performed_by_user_id, basis, operation_id, request_key, request_hash) values ('mapping_confirmation',$1,$2,$3,'club_admin',$4,$5,$6)`,
    [done.b.teamId, crypto.randomUUID(), W.caA.id, crypto.randomUUID(), key(), hash()]), "23514", /^source_metric_audit: a club-admin confirmation row names a club's confirmation$/);
  // A later confirmation row for an earlier confirmation, by its own writer.
  refusedWith(await T(W.caA.id, `insert into ${T8} (action, team_id, confirmation_id, performed_by_user_id, basis, operation_id, request_key, request_hash) values ('mapping_confirmation',$1,$2,$3,'club_admin',$4,$5,$6)`,
    [done.b.teamId, done.id, W.caA.id, done.operationId, key(), hash()]), "23514", /^source_metric_audit: the audit row must follow its own confirmation in the same transaction$/);
  // The audit row's time is the transaction's, not the writer's.
  const bt = await binding(W.clubA);
  const st = await stored(bt);
  const vt = await activeVersion(W.caA);
  refusedWith(await save(W.caA, { stored: st, items: [checkedItem(vt)], audit: false, then: (c, out) => c.query(
    `insert into ${T8} (action, team_id, confirmation_id, performed_by_user_id, basis, operation_id, request_key, request_hash, performed_at) values ('mapping_confirmation',$1,$2,$3,'club_admin',$4,$5,$6,'2001-01-01')`,
    [bt.teamId, out.id, W.caA.id, out.operationId, key(), hash()]) }), "23514", /^source_metric_audit: the audit row must follow its own confirmation in the same transaction$/);
  const et = await committed(W.caA);
  refusedWith(await tx(W.pa.id, async (c) => {
    await c.query(ERASE, [et.id]);
    await c.query(`insert into ${T8} (action, confirmation_id, performed_by_user_id, basis, operation_id, reason, performed_at) values ('confirmation_values_erased',$1,$2,'platform_admin',$3,'erasure_request','2001-01-01')`, [et.id, W.pa.id, crypto.randomUUID()]);
  }, { commit: false }), "23514", FOLLOW);
  // The existing actions still pass through the real routes (the 7h and 7d suites cover them in full).
  const v = await activeVersion(W.caA);
  assert.deepEqual((await rows(k, `select action, to_status from ${T8} where mapping_version_id = $1 order by performed_at, id`, [v.versionId])).map((x) => `${x.action}:${x.to_status}`),
    ["mapping_version_create:draft", "mapping_status:needs_review", "mapping_status:active"]);
});

test("B10. the removal of expired values: only past the date, only inside the removal function under its transaction's marker, whole confirmations in order, bounded, skipping a held one; with no acting user it writes no audit row and names nobody", async () => {
  const fresh = await committed(W.caA, { n: 2 });
  const old1 = await committed(W.caA, { n: 2 });
  const old2 = await committed(W.caA, { n: 1 });
  const old3 = await committed(W.caA, { n: 1 });
  const plain = await committed(W.caA, { checked: false });
  await age(old1.id, 93);
  await age(old2.id, 92);
  await age(old3.id, 91);
  await age(plain.id, 95);
  const EXPIRE = `update ${T9I} set raw_a = null, stored_a = null, raw_b = null, stored_b = null, values_salt = null, values_removed_kind = 'expired' where confirmation_id = $1 and checked`;
  // Outside the function: no marker, a stale marker (another transaction's id), a session-level one.
  const ONLY_FN = /^source_metric_confirmation_items: expired values are removed only by the removal function$/;
  refusedWith(await tx(null, (c) => c.query(EXPIRE, [old1.id])), "23514", ONLY_FN);
  refusedWith(await tx(W.pa.id, (c) => c.query(EXPIRE, [old1.id])), "23514", ONLY_FN);
  const stale = (await one(k, `select pg_current_xact_id()::text as x`)).x;
  refusedWith(await tx(null, async (c) => { await c.query(`select set_config('optimove.source_metric_confirmation_purge', $1, true)`, [stale]); await c.query(EXPIRE, [old1.id]); }), "23514", ONLY_FN);
  await k.query(`select set_config('optimove.source_metric_confirmation_purge', $1, false)`, [stale]);
  try {
    refusedWith(await tx(null, (c) => c.query(EXPIRE, [old1.id])), "23514", ONLY_FN);
  } finally {
    await k.query(`select set_config('optimove.source_metric_confirmation_purge', '', false)`);
  }
  // The right comes first: a club admin, and an invalid actor setting, are 42501 whatever the change.
  refusedWith(await tx(W.caA.id, (c) => c.query(EXPIRE, [old1.id])), "42501", /^source metric confirmation: the acting user may not remove these values$/);
  refusedWith(await tx(W.caA.id, (c) => c.query(`update ${T9I} set raw_a = 1 where confirmation_id = $1`, [old1.id])), "42501", /^source metric confirmation: the acting user may not remove these values$/);
  // Under a valid marker set by hand, a row that is not past its date is still refused.
  refusedWith(await tx(null, async (c) => { await c.query(`select set_config('optimove.source_metric_confirmation_purge', pg_current_xact_id()::text, true)`); await c.query(EXPIRE, [fresh.id]); }), "23514",
    /^source_metric_confirmation_items: the values are not past their date$/);
  // A present but invalid actor setting is 42501, never "no actor".
  for (const bad of ["not-a-user", `${W.pa.id}:1`]) {
    await k.query(`select set_config('optimove.source_metric_actor', $1, false)`, [bad]);
    try {
      const res = await tx(null, (c) => c.query(`select training_load.remove_expired_confirmation_values(10)`));
      refusedWith(res, "42501", /^source metric mapping: no acting user is set for this transaction$/);
    } finally {
      await k.query(`select set_config('optimove.source_metric_actor', '', false)`);
    }
  }
  // The limit's bounds.
  for (const bad of [0, 1001, null]) refusedWith(await tx(null, (c) => c.query(`select training_load.remove_expired_confirmation_values($1)`, [bad])), "23514", /^remove_expired_confirmation_values: the limit is between 1 and 1000$/);
  // A peer holds old1: the batch skips it and takes the next two in order; the limit counts confirmations.
  const audits = () => one(k, `select count(*)::int as n from ${T8} where action in ('confirmation_values_expired', 'confirmation_values_erased')`);
  const auditsBefore = (await audits()).n;
  const peer = await client();
  try {
    await peer.query("begin");
    await peer.query(`select 1 from ${T9} where id = $1 for update`, [old1.id]);
    const first = await tx(null, async (c) => { await c.query("set local lock_timeout = '3s'"); return (await one(c, `select training_load.remove_expired_confirmation_values(1) as ids`)).ids; });
    assert.equal(first.ok, true, `the batch does not wait for the held confirmation: ${first.error?.message}`);
    assert.deepEqual(first.value, [old2.id], "the oldest that is not held");
    await peer.query("rollback");
  } finally {
    await peer.end();
  }
  const second = await tx(null, async (c) => {
    const ids = (await one(c, `select training_load.remove_expired_confirmation_values(1) as ids`)).ids;
    // The marker is reset before the function returns: a second removal in the same transaction is refused.
    await c.query("savepoint after_fn");
    await assert.rejects(c.query(EXPIRE, [old3.id]), (e) => e.code === "23514" && ONLY_FN.test(e.message));
    await c.query("rollback to savepoint after_fn");
    return ids;
  });
  assert.equal(second.ok, true, second.error?.stack);
  assert.deepEqual(second.value, [old1.id], "then the oldest");
  const third = await tx(null, async (c) => (await one(c, `select training_load.remove_expired_confirmation_values(200) as ids`)).ids);
  assert.deepEqual(third.value, [old3.id], "then what is left: never a confirmation that is not past its date, never one with no values");
  assert.deepEqual((await tx(null, async (c) => (await one(c, `select training_load.remove_expired_confirmation_values(200) as ids`)).ids)).value, [], "nothing left");
  for (const done of [old1, old2, old3]) {
    for (const it of await itemsOf(done.id)) {
      assert.deepEqual([it.raw_a, it.stored_a, it.raw_b, it.stored_b, it.values_salt, it.values_removed_kind, it.values_removed_by_user_id], [null, null, null, null, null, "expired", null]);
      assert.ok(it.values_removed_at instanceof Date);
      assert.match(it.values_digest, /^[0-9a-f]{64}$/, "the digest stays");
      assert.equal(it.source_unit, "s", "the facts stay");
    }
  }
  for (const it of await itemsOf(fresh.id)) assert.deepEqual([Number(it.raw_a), it.values_removed_at], [120, null], "values before their date stay");
  for (const it of await itemsOf(plain.id)) assert.equal(it.values_removed_at, null, "a row that was not compared is never removed");
  assert.equal((await audits()).n, auditsBefore, "the scheduled removal writes no audit row");
  // Removed once: a second removal of the same row is refused.
  refusedWith(await tx(W.pa.id, (c) => c.query(ERASE, [old1.id]), { commit: false }), "23514", /^source_metric_confirmation_items: the row holds no values to remove$/);
});

test("B11. a removal by an acting user: only an active platform admin, named on the row by the database, with its audit row at COMMIT (same user, same transaction, once per confirmation); an erasure needs no expiry, and the confirmer who is a platform admin may erase", async () => {
  // Route 7's shape: the removal function under a platform admin's identity.
  const old = await committed(W.caA, { n: 2 });
  await age(old.id, 91);
  const LINK = /^source_metric_confirmation_items: an acting user's removal of values is written with its audit row$/;
  refusedWith(await tx(W.pa.id, (c) => c.query(`select training_load.remove_expired_confirmation_values(10)`)), "23514", LINK);
  refusedWith(await tx(W.caA.id, (c) => c.query(`select training_load.remove_expired_confirmation_values(10)`)), "42501", /^source metric confirmation: the acting user may not remove these values$/);
  const done = await tx(W.pa.id, async (c) => {
    const ids = (await one(c, `select training_load.remove_expired_confirmation_values(10) as ids`)).ids;
    for (const id of ids) await auditRemoval(c, "confirmation_values_expired", id, W.pa.id);
    return ids;
  });
  assert.equal(done.ok, true, done.error?.message);
  assert.deepEqual(done.value, [old.id]);
  for (const it of await itemsOf(old.id)) assert.deepEqual([it.raw_a, it.values_salt, it.values_removed_kind, it.values_removed_by_user_id], [null, null, "expired", W.pa.id]);
  // An erasure: before the date, by a platform admin, with one of the two codes.
  const e1 = await committed(W.caA, { n: 2 });
  refusedWith(await tx(null, (c) => c.query(ERASE, [e1.id])), "42501", /^source metric confirmation: the acting user may not remove these values$/);
  refusedWith(await tx(W.caA.id, (c) => c.query(ERASE, [e1.id])), "42501", /^source metric confirmation: the acting user may not remove these values$/);
  refusedWith(await tx(W.pa.id, (c) => c.query(ERASE, [e1.id])), "23514", LINK);
  // Another user's audit row, and one of an earlier transaction, do not count.
  refusedWith(await tx(W.pa.id, async (c) => { await c.query(ERASE, [e1.id]); await auditRemoval(c, "confirmation_values_erased", e1.id, W.pa2.id, { reason: "erasure_request" }); }), "42501",
    /^source metric mapping: the row names another user than the acting user$/);
  // The audit row before the removal, or after only a part of it, is refused.
  const FOLLOW = /^source_metric_audit: the audit row must follow its own removal of values in the same transaction$/;
  refusedWith(await tx(W.pa.id, async (c) => { await auditRemoval(c, "confirmation_values_erased", e1.id, W.pa.id, { reason: "erasure_request" }); await c.query(ERASE, [e1.id]); }), "23514", FOLLOW);
  refusedWith(await tx(W.pa.id, async (c) => {
    await c.query(`${ERASE} and item_no = 1`, [e1.id]);
    await auditRemoval(c, "confirmation_values_erased", e1.id, W.pa.id, { reason: "erasure_request" });
  }), "23514", FOLLOW);
  // The wrong action for the kind.
  refusedWith(await tx(W.pa.id, async (c) => { await c.query(ERASE, [e1.id]); await auditRemoval(c, "confirmation_values_expired", e1.id, W.pa.id); }), "23514", FOLLOW);
  // A user the writer supplies is overwritten with the acting user.
  const erased = await tx(W.pa.id, async (c) => {
    await c.query(`update ${T9I} set raw_a = null, stored_a = null, raw_b = null, stored_b = null, values_salt = null, values_removed_kind = 'erased', values_removed_by_user_id = $2, values_removed_at = '2001-01-01' where confirmation_id = $1 and checked`, [e1.id, W.caA.id]);
    await auditRemoval(c, "confirmation_values_erased", e1.id, W.pa.id, { reason: "wrong_confirmation" });
  });
  assert.equal(erased.ok, true, erased.error?.message);
  for (const it of await itemsOf(e1.id)) {
    assert.deepEqual([it.raw_a, it.values_salt, it.values_removed_kind, it.values_removed_by_user_id], [null, null, "erased", W.pa.id]);
    assert.ok(Math.abs(Date.now() - new Date(it.values_removed_at).getTime()) < 60_000, "the removal time is the database's");
  }
  assert.deepEqual((await rows(k, `select action, reason, performed_by_user_id from ${T8} where confirmation_id = $1 and action <> 'mapping_confirmation'`, [e1.id])), [{ action: "confirmation_values_erased", reason: "wrong_confirmation", performed_by_user_id: W.pa.id }]);
  // Once per confirmation and action: the values are gone, so a second erasure has nothing to remove and no row to follow.
  refusedWith(await tx(W.pa.id, (c) => auditRemoval(c, "confirmation_values_erased", e1.id, W.pa.id, { reason: "erasure_request" })), "23514", FOLLOW);
  // The confirmer who is a platform admin may erase; a platform admin's own confirmation.
  const mine = await committed(W.pa);
  const own = await tx(W.pa.id, async (c) => { await c.query(ERASE, [mine.id]); await auditRemoval(c, "confirmation_values_erased", mine.id, W.pa.id, { reason: "erasure_request" }); });
  assert.equal(own.ok, true, own.error?.message);
  // A removal of a confirmation of an earlier transaction commits: the insert-only deferred links do not run again.
  assert.equal((await one(k, `select count(*)::int as n from ${T9I} where confirmation_id = $1 and values_removed_at is not null`, [mine.id])).n, 1);
  // The removal function against an erasure of the same confirmation: each is removed once, with no deadlock.
  const race = await committed(W.caA, { n: 1 });
  await age(race.id, 91);
  const peer = await client();
  try {
    await peer.query("begin");
    await peer.query(CTX, [W.pa.id]);
    await peer.query(`select 1 from ${T9} where id = $1 for update`, [race.id]);
    await peer.query(ERASE, [race.id]);
    await auditRemoval(peer, "confirmation_values_erased", race.id, W.pa.id, { reason: "erasure_request" });
    const skipped = await tx(null, async (c) => { await c.query("set local lock_timeout = '3s'"); return (await one(c, `select training_load.remove_expired_confirmation_values(10) as ids`)).ids; });
    assert.deepEqual(skipped.value, [], "the scheduled removal skips a confirmation another transaction holds");
    await peer.query("commit");
  } finally {
    await peer.query("rollback").catch(() => {});
    await peer.end();
  }
  assert.deepEqual((await tx(null, async (c) => (await one(c, `select training_load.remove_expired_confirmation_values(10) as ids`)).ids)).value, [], "and finds nothing left afterwards");
  assert.deepEqual((await itemsOf(race.id)).map((x) => x.values_removed_kind), ["erased"]);
});

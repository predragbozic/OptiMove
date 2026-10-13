// M2 - the administrator API of the source-to-canonical metric mapping
// (backend/src/routes/sourceMetrics.js, backend/src/sourceMetricMappingService.js),
// through the real HTTP stack, on a disposable optimove_tests_gpexe_* database
// (never OPTIMOVE) migrated through v34. Contract: the "M2 HTTP contract" of
// docs/ai/gpexe-metric-variable-mapping-discovery.md (approved 2026-10-13).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN } from "./_gpexe-disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const D5 = "docs/ai/gpexe-metric-variable-mapping-discovery.md#d5-unit-conversion-seed";
const ch = (cp) => String.fromCodePoint(cp);

let db, admin, server, apiBase, service, dbModule, createSession, appPool;
const responses = [];
const logLines = [];
const originalConsole = {};
const W = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "m2" });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.M2_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  dbModule = await import("../src/db.js");
  ({ createSession } = await import("../src/auth.js"));
  appPool = dbModule.pool;
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await world();
});

after(async () => {
  service?.setMappingCommitForTests();
  service?.setMappingWriteHoldForTests(null);
  service?.setMappingUserLockWaitForTests(null);
  dbModule?.setPoolCheckoutFaultForTests(null);
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

afterEach(() => {
  // A test that failed while a write was held must not leave it held.
  for (const g of openGates.splice(0)) g.open();
  service.setMappingRightsHoldForTests(null);
  service.setMappingCommitForTests();
  service.setMappingWriteHoldForTests(null);
  service.setMappingUserLockWaitForTests(null);
  dbModule.setPoolCheckoutFaultForTests(null);
});

// ---------------------------------------------------------------------------
// helpers
const uid = () => crypto.randomBytes(4).toString("hex");
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const key = () => crypto.randomUUID();

async function api(path, { method = "GET", body, cookie, contentType = "application/json" } = {}) {
  const res = await fetch(`${apiBase}${PREFIX}${path}`, {
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
const post = (path, cookie, body) => api(path, { method: "POST", cookie, body });

async function user(label, { active = true } = {}) {
  return (await one(`insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,$3) returning id`, [`${label}-${uid()}@test.local`, label, active])).id;
}
async function workspace(userId, type, scopeId) {
  await q(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
// A club workspace exists only for an active club_admin role in that club
// (workspace.js loadAvailableWorkspaces), so a platform admin acting for a
// club in its workspace holds that role too.
async function platformAdmin(ws = ["platform", null]) {
  const id = await user("platform-admin");
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  if (ws[0] === "club") await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, ws[1]]);
  await workspace(id, ws[0], ws[1]);
  return { id, cookie: await cookieFor(id) };
}
async function clubAdmin(clubId, { roleActive = true, active = true, ws = clubId } = {}) {
  const id = await user("club-admin", { active: true });
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',$3)`, [id, clubId, roleActive]);
  await workspace(id, "club", ws);
  const cookie = await cookieFor(id);
  if (!active) await q(`update public.users set is_active = false where id = $1`, [id]);
  return { id, cookie };
}
const club = async (name) => (await one(`insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const team = async (clubId) => (await one(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;

async function canonical({ scope = "system", clubId = null, teamId = null, userId = null, unit = "min", valueType = "numeric", cd = null, caps = ["session", "component"], state = "active" } = {}) {
  const id = (await one(`insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id, owner_team_id, owner_user_id, state) values ($1,'M2 test variable',$2,$3,$4,$5,$6) returning id`,
    [`m2_${uid()}`, scope, clubId, teamId, userId, state])).id;
  const versionId = (await one(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, condition_description) values ($1,1,$2,$3,$4) returning id`, [id, unit, valueType, cd])).id;
  await q(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [versionId, id]);
  for (const s of caps) await q(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,$2)`, [id, s]);
  return { id, versionId };
}

// A source field of gpexe / rest_v1 with revision 1 (M1 SQL, an active platform admin as the actor).
async function field({ kind = "none", unit = "s", boundUnit = null, operator = null, session = true, drill = true, verify = true, activate = true } = {}) {
  const by = W.pa.id;
  const def = await one(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Test field',$2) returning id`, [`m2.test.f${uid()}`, by]);
  const shape = kind === "zone_bounds" ? "zone_distance" : kind === "event_threshold" ? "event_count" : "number";
  const rev = await one(`insert into training_load.source_metric_definition_versions (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill, evidence_status, evidence_ref, created_by_user_id)
                         values ($1,1,$2,$3,$4,$5,'observed',$6,$7) returning id`, [def.id, shape, kind, session, drill, COMPAT, by]);
  if (verify) {
    await q(`update training_load.source_metric_definition_versions set source_unit = $2, source_bound_unit = $3, unit_verified_by_user_id = $4, unit_verified_at = now(), unit_evidence_ref = $5 where id = $1`, [rev.id, unit, boundUnit, by, COMPAT]);
    await q(`update training_load.source_metric_definition_versions set bound_operator = $2, meaning_verified_by_user_id = $3, meaning_verified_at = now(), meaning_evidence_ref = $4, evidence_status = 'verified' where id = $1`, [rev.id, operator, by, COMPAT]);
  }
  if (activate) await q(`update training_load.source_metric_definition_versions set state = 'active', activated_by_user_id = $2, activated_at = now() where id = $1`, [rev.id, by]);
  return { id: def.id, revId: rev.id };
}
async function conversion(from, to, scale, divisor = "1", offset = "0") {
  return (await one(`insert into training_load.unit_conversions (from_unit, to_unit, scale, scale_divisor, "offset", evidence_ref, created_by_user_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [from, to, scale, divisor, offset, D5, W.pa.id])).id;
}
const retireConversion = (id) => q(`update training_load.unit_conversions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Test retirement' where id = $1`, [id, W.pa.id]);

async function mappingFor(actor, sourceMetricId, metricDefinitionId) {
  const r = await post("/mappings", actor.cookie, { requestKey: key(), sourceMetricId, metricDefinitionId });
  assert.equal(r.status, 201, r.text);
  return r.body.mapping;
}
const versionBody = (revId, over = {}) => ({ requestKey: key(), sourceRevisionId: revId, appliesToSession: true, appliesToDrill: true, ...over });

// Deterministic interleaving: a backend of this database (not ours) waits on a lock.
async function someoneWaits(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await one(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
    if (row.n > 0) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
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
  W.clubB = await club("Club B");
  W.clubC = await club("Club C");
  W.teamA = await team(W.clubA);
  W.pa = await platformAdmin();
  W.pa2 = await platformAdmin();
  W.paA = await platformAdmin(["club", W.clubA]);
  W.caA = await clubAdmin(W.clubA);
  W.caA2 = await clubAdmin(W.clubA);
  W.caB = await clubAdmin(W.clubB);
  W.caRevoked = await clubAdmin(W.clubA, { roleActive: false });
  W.caInactiveUser = await clubAdmin(W.clubA, { active: false });
  W.caC = await clubAdmin(W.clubC);
  await q(`update public.clubs set is_active = false where id = $1`, [W.clubC]);
  const coachId = await user("coach");
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coachId, W.teamA]);
  await workspace(coachId, "team", W.teamA);
  W.coach = { id: coachId, cookie: await cookieFor(coachId) };
  // Source fields.
  W.fSec = await field({ unit: "s" });
  W.fSessionOnly = await field({ unit: "s", drill: false });
  W.fZone = await field({ kind: "zone_bounds", unit: "m", boundUnit: "m/s", operator: ">=" });
  W.fBetween = await field({ kind: "zone_bounds", unit: "m", boundUnit: "W/kg", operator: "between" });
  W.fThreshold = await field({ kind: "event_threshold", unit: "count", boundUnit: "m/s2", operator: "<=" });
  W.fAa = await field({ unit: "aa" });
  W.fCc = await field({ unit: "cc" });
  W.seedTime = await one(`select d.id, v.id as rev_id from training_load.source_metric_definitions d join training_load.source_metric_definition_versions v on v.source_metric_definition_id = d.id where d.source_metric_key = 'athlete_session.total_time'`);
  // Canonical definitions.
  W.sysMin = await canonical({ unit: "min" });
  W.sysSec = await canonical({ unit: "s" });
  W.sysText = await canonical({ unit: "min", valueType: "text" });
  W.sysNoUnit = await canonical({ unit: null });
  W.sysBadUnit = await canonical({ unit: "km h" });
  W.sysSessionOnly = await canonical({ unit: "s", caps: ["session"] });
  W.sysArchived = await canonical({ unit: "min", state: "archived" });
  W.sysZone = await canonical({ unit: "m", cd: { operator: ">=", value: 25.2, unit: "km/h" } });
  W.sysZoneOther = await canonical({ unit: "m", cd: { operator: ">", value: 25.2, unit: "km/h" } });
  W.sysZoneBad = await canonical({ unit: "m", cd: { label: "fast" } });
  W.sysZoneNoConv = await canonical({ unit: "m", cd: { operator: ">=", value: 7, unit: "ft/s" } });
  W.sysBetween = await canonical({ unit: "m", cd: { operator: "between", min: 25, max: 60, unit: "W/kg" } });
  W.sysThreshold = await canonical({ unit: "count", cd: { operator: "<=", value: -2.5, duration_seconds: 0.5, unit: "m/s2" } });
  W.sysBb = await canonical({ unit: "bb" });
  W.sysDd = await canonical({ unit: "dd" });
  W.sysFf = await canonical({ unit: "ff" });
  W.clubAMin = await canonical({ scope: "club", clubId: W.clubA, unit: "min" });
  W.clubASec = await canonical({ scope: "club", clubId: W.clubA, unit: "s" });
  W.clubBMin = await canonical({ scope: "club", clubId: W.clubB, unit: "min" });
  W.teamMd = await canonical({ scope: "team", teamId: W.teamA, unit: "min" });
  W.userMd = await canonical({ scope: "user", userId: W.coach.id, unit: "min" });
  // A conversion that is not in the D5 normal form ((1, 4) is (0.25, 1)), and one to retire.
  W.convAaBb = await conversion("aa", "bb", "1", "4");
  W.convCcDd = await conversion("cc", "dd", "2", "1");
  W.metricsDigest = await metricsDigest();
}
async function metricsDigest() {
  const d = {};
  for (const t of ["training_load.metric_definitions", "training_load.metric_definition_versions", "training_load.metric_definition_scope_capabilities"]) {
    d[t] = (await one(`select count(*)::int as n, md5(coalesce(string_agg(x::text, ',' order by x::text), '')) as h from ${t} x`)).h;
  }
  return d;
}

// ---------------------------------------------------------------------------
test("1. who may call: no session is 401; a coach, a team workspace, another role, a revoked role, an inactive user and an archived club all get the same 404 on every route; a platform admin and a club's own admin get 200 with no-store", async () => {
  const routes = ["/fields", "/targets", "/conversions", "/mappings", `/mappings/${crypto.randomUUID()}`];
  for (const path of routes) assert.equal((await api(path)).status, 401, path);
  assert.equal((await post("/mappings", null, { requestKey: key() })).status, 401);
  for (const who of [W.coach, W.caRevoked, W.caC]) {
    for (const path of routes) {
      const r = await api(path, { cookie: who.cookie });
      assert.equal(r.status, 404, `${path}: ${r.text}`);
      assert.deepEqual(r.body, { error: "notFound" });
    }
    const w = await post("/mappings", who.cookie, { requestKey: key(), sourceMetricId: W.fSec.id, metricDefinitionId: W.sysMin.id });
    assert.equal(w.status, 404);
  }
  // An inactive user has no session at all.
  assert.equal((await api("/fields", { cookie: W.caInactiveUser.cookie })).status, 401);
  // Unknown paths under the prefix: the same 404.
  assert.equal((await api("/nothing", { cookie: W.pa.cookie })).status, 404);
  for (const who of [W.pa, W.paA, W.caA]) {
    for (const path of routes.slice(0, 4)) {
      const r = await api(path, { cookie: who.cookie });
      assert.equal(r.status, 200, `${path}: ${r.text}`);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
  }
});

test("2. GET /fields: the T2a fields with their revisions, in a stable order, with only the M1-bounded label and evidence references as text; filters checked; never unitNote or an acting user", async () => {
  const r = await api("/fields?sourceSystem=gpexe&apiFamily=rest_v1", { cookie: W.caA.cookie });
  assert.equal(r.status, 200);
  const keys = r.body.fields.map((f) => `${f.sourceSystem}/${f.apiFamily}/${f.key}`);
  assert.deepEqual(keys, [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  const seed = r.body.fields.find((f) => f.key === "athlete_session.total_time");
  assert.equal(seed.label, "TIME");
  assert.equal(seed.revisions[0].sourceUnit, null);
  assert.equal(seed.revisions[0].evidenceRef, COMPAT);
  const zone = r.body.fields.find((f) => f.id === W.fZone.id);
  assert.deepEqual(Object.keys(zone.revisions[0]).sort(), ["boundOperator", "evidenceRef", "evidenceStatus", "expectedSourceBoundUnit", "expectedSourceUnit", "id", "meaningEvidenceRef", "meaningVerifiedAt", "parameterKind", "revisionNumber", "sourceBoundUnit", "sourceUnit", "state", "supportsDrill", "supportsSession", "unitEvidenceRef", "unitVerifiedAt", "valueShape"]);
  assert.ok(!r.text.includes("unitNote") && !r.text.includes("unit_note") && !r.text.includes("hypothesis"), "no unit note");
  assert.ok(!r.text.includes(W.pa.id), "no acting user");
  assert.equal((await api("/fields?apiFamily=api", { cookie: W.pa.cookie })).body.fields.length, 0);
  for (const bad of ["?apiFamily=soap", "?sourceSystem=GPEXE", "?other=1", "?apiFamily=api&apiFamily=rest_v1"]) {
    const b = await api(`/fields${bad}`, { cookie: W.pa.cookie });
    assert.equal(b.status, 400, bad);
    assert.equal(b.body.error, "invalid_query");
  }
});

test("3. GET /targets: only the workspace's owner scope (platform: system; club A: club A only), ownerScope on every target, the ready state and the normalized canonical parameters; no key, label, raw condition description or non-token unit", async () => {
  const sys = await api("/targets", { cookie: W.pa.cookie });
  assert.equal(sys.status, 200);
  const sysIds = sys.body.targets.map((t) => t.id);
  assert.deepEqual(sysIds, [...sysIds].sort());
  assert.ok(sysIds.includes(W.sysMin.id) && !sysIds.includes(W.clubAMin.id) && !sysIds.includes(W.teamMd.id) && !sysIds.includes(W.userMd.id) && !sysIds.includes(W.sysArchived.id));
  assert.ok(sys.body.targets.every((t) => t.ownerScope === "system"));
  const byId = new Map(sys.body.targets.map((t) => [t.id, t]));
  assert.deepEqual(byId.get(W.sysMin.id), { id: W.sysMin.id, ownerScope: "system", currentVersion: { id: W.sysMin.versionId, versionNumber: 1, unit: "min", canonicalParameters: null }, scopes: ["component", "session"], versionReady: true, notReadyCode: null });
  assert.equal(byId.get(W.sysText.id).notReadyCode, "canonical_not_numeric");
  assert.equal(byId.get(W.sysNoUnit.id).notReadyCode, "canonical_unit_missing");
  assert.equal(byId.get(W.sysBadUnit.id).notReadyCode, "canonical_unit_not_a_token");
  assert.equal(byId.get(W.sysBadUnit.id).currentVersion.unit, null, "a non-token unit is not returned");
  assert.deepEqual(byId.get(W.sysZone.id).currentVersion.canonicalParameters, { operator: ">=", lower: "25.2", upper: null, unit: "km/h" });
  assert.deepEqual(byId.get(W.sysBetween.id).currentVersion.canonicalParameters, { operator: "between", lower: "25", upper: "60", unit: "W/kg" });
  assert.deepEqual(byId.get(W.sysThreshold.id).currentVersion.canonicalParameters, { operator: "<=", value: "-2.5", duration_seconds: "0.5", unit: "m/s2" });
  assert.equal(byId.get(W.sysZoneBad.id).currentVersion.canonicalParameters, null);
  assert.ok(!sys.text.includes("M2 test variable") && !sys.text.includes("m2_") && !sys.text.includes("fast"), "no Metrics Core free text");
  const clubA = await api("/targets", { cookie: W.caA.cookie });
  assert.deepEqual(new Set(clubA.body.targets.map((t) => t.ownerScope)), new Set(["club"]));
  const clubIds = clubA.body.targets.map((t) => t.id);
  assert.ok(clubIds.includes(W.clubAMin.id) && !clubIds.includes(W.clubBMin.id) && !clubIds.includes(W.sysMin.id));
  assert.deepEqual((await api("/targets", { cookie: W.paA.cookie })).body.targets.map((t) => t.id).sort(), [...clubIds].sort(), "a platform admin in club A's workspace sees club A's scope");
});

test("4. GET /conversions: the active rows only, ordered by unit pair, factors as exact decimal text", async () => {
  const r = await api("/conversions", { cookie: W.caB.cookie });
  assert.equal(r.status, 200);
  const pairs = r.body.conversions.map((c) => `${c.fromUnit}>${c.toUnit}`);
  const rows = await q(`select from_unit, to_unit from training_load.unit_conversions where state = 'active' order by from_unit collate "C", to_unit collate "C"`);
  assert.deepEqual(pairs, rows.map((x) => `${x.from_unit}>${x.to_unit}`), "the database's order");
  const sMin = r.body.conversions.find((c) => c.fromUnit === "s" && c.toUnit === "min");
  assert.deepEqual({ scale: sMin.scale, scaleDivisor: sMin.scaleDivisor, offset: sMin.offset, evidenceRef: sMin.evidenceRef }, { scale: "1", scaleDivisor: "60", offset: "0", evidenceRef: D5 });
  assert.equal(r.body.conversions.find((c) => c.fromUnit === "m/s").scale, "3.6");
});

test("5. POST /mappings: the owner comes from the workspace only (platform: system; club workspace: that club, for its admin and a platform admin alike); the request record is the T8 row; owner fields and unknown fields are refused; scope, retirement, activity and the pair are checked", async () => {
  const sys = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: W.fSec.id, metricDefinitionId: W.sysMin.id });
  assert.equal(sys.status, 201, sys.text);
  assert.equal(sys.body.replayed, false);
  assert.deepEqual(Object.keys(sys.body.mapping).sort(), ["createdAt", "id", "metricDefinitionId", "ownerScope", "sourceMetric", "versions"]);
  const t3 = await one(`select owner_scope, owner_club_id, owner_key, created_by_user_id from training_load.source_metric_mappings where id = $1`, [sys.body.mapping.id]);
  assert.deepEqual(t3, { owner_scope: "system", owner_club_id: null, owner_key: "system", created_by_user_id: W.pa.id });
  const audit = await q(`select action, mapping_id, basis, performed_by_user_id, request_hash is not null as hashed, request_key is not null as keyed from training_load.source_metric_audit where mapping_id = $1`, [sys.body.mapping.id]);
  assert.deepEqual(audit, [{ action: "mapping_create", mapping_id: sys.body.mapping.id, basis: "platform_admin", performed_by_user_id: W.pa.id, hashed: true, keyed: true }]);
  const club = await post("/mappings", W.caA.cookie, { requestKey: key(), sourceMetricId: W.fSec.id, metricDefinitionId: W.clubAMin.id });
  assert.equal(club.status, 201, club.text);
  assert.equal((await one(`select owner_club_id from training_load.source_metric_mappings where id = $1`, [club.body.mapping.id])).owner_club_id, W.clubA);
  assert.equal((await one(`select basis from training_load.source_metric_audit where mapping_id = $1`, [club.body.mapping.id])).basis, "club_admin");
  const support = await post("/mappings", W.paA.cookie, { requestKey: key(), sourceMetricId: W.fSessionOnly.id, metricDefinitionId: W.clubAMin.id });
  assert.equal(support.status, 201, support.text);
  assert.equal((await one(`select owner_scope, owner_club_id from training_load.source_metric_mappings where id = $1`, [support.body.mapping.id])).owner_club_id, W.clubA);
  // Owner fields, server-derived fields and unknown fields: 400.
  for (const extra of [{ ownerScope: "system" }, { ownerClubId: W.clubB }, { ownerKey: "system" }, { sourceSystem: "gpexe" }, { note: "x" }]) {
    const r = await post("/mappings", W.caA.cookie, { requestKey: key(), sourceMetricId: W.fZone.id, metricDefinitionId: W.clubAMin.id, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(r.body.error, "invalid_body");
  }
  assert.equal((await post("/mappings", W.caA.cookie, { requestKey: "not-a-uuid", sourceMetricId: W.fZone.id, metricDefinitionId: W.clubAMin.id })).body.error, "invalid_body");
  assert.equal((await api("/mappings", { method: "POST", cookie: W.caA.cookie, body: "requestKey=1", contentType: "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await api("/mappings", { method: "POST", cookie: W.caA.cookie, body: "[]" })).body.error, "invalid_body");
  // Scope: a system definition in a club workspace is 409; another club, a team or a user definition is the 404.
  const mismatch = await post("/mappings", W.caA.cookie, { requestKey: key(), sourceMetricId: W.fZone.id, metricDefinitionId: W.sysMin.id });
  assert.deepEqual([mismatch.status, mismatch.body.error], [409, "target_scope_mismatch"]);
  for (const md of [W.clubBMin, W.teamMd, W.userMd]) {
    const r = await post("/mappings", W.caA.cookie, { requestKey: key(), sourceMetricId: W.fZone.id, metricDefinitionId: md.id });
    assert.deepEqual([r.status, r.body], [404, { error: "notFound" }]);
  }
  for (const md of [W.clubAMin, W.teamMd]) {
    const r = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: W.fZone.id, metricDefinitionId: md.id });
    assert.equal(r.status, 404, "a system mapping never targets a club or team definition");
  }
  assert.equal((await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: crypto.randomUUID(), metricDefinitionId: W.sysMin.id })).status, 404);
  const archived = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: W.fZone.id, metricDefinitionId: W.sysArchived.id });
  assert.deepEqual([archived.status, archived.body.error], [409, "target_not_active"]);
  const exists = await post("/mappings", W.pa2.cookie, { requestKey: key(), sourceMetricId: W.fSec.id, metricDefinitionId: W.sysMin.id });
  assert.deepEqual([exists.status, exists.body.error, exists.body.current], [409, "mapping_exists", { mappingId: sys.body.mapping.id }]);
  const retired = await field({ unit: "s" });
  await q(`update training_load.source_metric_definition_versions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Test retirement' where id = $1`, [retired.revId, W.pa.id]);
  await q(`update training_load.source_metric_definitions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Test retirement' where id = $1`, [retired.id, W.pa.id]);
  const gone = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: retired.id, metricDefinitionId: W.sysMin.id });
  assert.deepEqual([gone.status, gone.body.error], [409, "source_metric_retired"]);
});

test("6. idempotency: the same key and body replays (200, the CURRENT state, never a stored historical body, the right checked again); another body on the same key is request_key_reused; a refusal does not consume a key", async () => {
  const requestKey = key();
  const body = { requestKey, sourceMetricId: W.fZone.id, metricDefinitionId: W.sysZone.id };
  const first = await post("/mappings", W.pa.cookie, body);
  assert.equal(first.status, 201);
  const replay = await post("/mappings", W.pa.cookie, body);
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.mapping.id], [200, true, first.body.mapping.id]);
  // The replay shows the state of now: a version created since is in it.
  const v = await post(`/mappings/${first.body.mapping.id}/versions`, W.pa.cookie, versionBody(W.fZone.revId, { sourceParameters: { lower: "7", upper: null } }));
  assert.equal(v.status, 201, v.text);
  const later = await post("/mappings", W.pa.cookie, body);
  assert.equal(later.body.mapping.versions.length, 1, "the current state, not the original answer");
  assert.equal((await q(`select 1 from training_load.source_metric_mappings where source_metric_definition_id = $1 and metric_definition_id = $2`, [W.fZone.id, W.sysZone.id])).length, 1);
  assert.equal((await q(`select 1 from training_load.source_metric_audit where request_key = $1`, [requestKey])).length, 1);
  const reused = await post("/mappings", W.pa.cookie, { ...body, metricDefinitionId: W.sysZoneOther.id });
  assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"]);
  // Another user's key space is separate.
  const other = await post("/mappings", W.pa2.cookie, { ...body, metricDefinitionId: W.sysZoneOther.id });
  assert.equal(other.status, 201);
  // A refusal is no request record: the key is free again.
  const refusedKey = key();
  assert.equal((await post("/mappings", W.caA.cookie, { requestKey: refusedKey, sourceMetricId: W.fZone.id, metricDefinitionId: W.sysMin.id })).status, 409);
  assert.equal((await post("/mappings", W.caA.cookie, { requestKey: refusedKey, sourceMetricId: W.fZone.id, metricDefinitionId: W.clubASec.id })).status, 201);
  // The right is checked again on a replay: the same key from a workspace that cannot write the resource is the 404.
  await workspace(W.paA.id, "platform", null);
  const supportKey = { requestKey: key(), sourceMetricId: W.fZone.id, metricDefinitionId: W.sysBetween.id };
  assert.equal((await post("/mappings", W.paA.cookie, supportKey)).status, 201);
  await workspace(W.paA.id, "club", W.clubA);
  const elsewhere = await post("/mappings", W.paA.cookie, supportKey);
  assert.equal(elsewhere.status, 404, "a system mapping is not the club workspace's to replay");
  assert.equal((await q(`select 1 from training_load.source_metric_audit where request_key = $1`, [supportKey.requestKey])).length, 1);
});

test("7. GET /mappings and /mappings/:id: the platform workspace sees system mappings, a club workspace system plus its own club, never another club; the list carries a version summary, the detail every version; stable order; no acting user", async () => {
  const listA = await api("/mappings", { cookie: W.caA.cookie });
  const listB = await api("/mappings", { cookie: W.caB.cookie });
  const listP = await api("/mappings", { cookie: W.pa.cookie });
  const own = (l) => new Set(l.body.mappings.map((m) => m.ownerScope));
  assert.deepEqual(own(listP), new Set(["system"]));
  assert.ok(own(listA).has("club") && own(listA).has("system"));
  const clubAIds = new Set((await q(`select id from training_load.source_metric_mappings where owner_club_id = $1`, [W.clubA])).map((x) => x.id));
  assert.ok(listB.body.mappings.every((m) => !clubAIds.has(m.id)), "club B never sees club A's mappings");
  const order = listA.body.mappings.map((m) => [m.ownerScope === "system" ? 0 : 1, m.createdAt, m.id].join("|"));
  assert.deepEqual(order, [...order].sort());
  const zone = listP.body.mappings.find((m) => m.sourceMetric.id === W.fZone.id && m.metricDefinitionId === W.sysZone.id);
  assert.deepEqual(Object.keys(zone).sort(), ["activeVersionId", "createdAt", "id", "latestVersion", "metricDefinitionId", "ownerScope", "sourceMetric", "versionCounts"]);
  assert.deepEqual(zone.versionCounts, { draft: 1, needs_review: 0, active: 0, disabled: 0 });
  assert.equal(zone.latestVersion.status, "draft");
  assert.equal(zone.activeVersionId, null);
  const aMapping = [...clubAIds][0];
  assert.equal((await api(`/mappings/${aMapping}`, { cookie: W.caB.cookie })).status, 404);
  assert.equal((await api(`/mappings/${aMapping}`, { cookie: W.pa.cookie })).status, 404, "the platform workspace is the system scope");
  assert.equal((await api(`/mappings/${aMapping}`, { cookie: W.caA.cookie })).status, 200);
  assert.equal((await api(`/mappings/not-a-uuid`, { cookie: W.caA.cookie })).status, 404);
  const detail = await api(`/mappings/${zone.id}`, { cookie: W.caA.cookie });
  assert.equal(detail.status, 200, "club admins read system mappings");
  assert.equal(detail.body.mapping.versions[0].parameterFingerprint.startsWith("v1:"), true);
  for (const r of [listA, listB, listP, detail]) for (const u of [W.pa.id, W.caA.id, W.paA.id]) assert.ok(!r.text.includes(u), "no acting user's id");
});

test("8. POST versions: identity and non-identity conversions are server-derived (the client never supplies factors, units, owner, fingerprint or status); the note is required when the units differ; the revision must be a proven draft or active revision of this mapping's field; levels are checked against both sides", async () => {
  const idMap = await mappingFor(W.pa, W.fSec.id, W.sysSec.id);
  const identity = await post(`/mappings/${idMap.id}/versions`, W.pa.cookie, versionBody(W.fSec.revId));
  assert.equal(identity.status, 201, identity.text);
  const iv = identity.body.version;
  assert.deepEqual([iv.status, iv.versionNumber, iv.sourceUnit, iv.targetUnit, iv.scale, iv.scaleDivisor, iv.offset, iv.parameterFingerprint, iv.parameterKind], ["draft", 1, "s", "s", "1", "1", "0", "", "none"]);
  const minMap = await mappingFor(W.pa, W.fSec.id, W.sysMin.id).catch(async () => (await api("/mappings", { cookie: W.pa.cookie })).body.mappings.find((m) => m.sourceMetric.id === W.fSec.id && m.metricDefinitionId === W.sysMin.id));
  const noNote = await post(`/mappings/${minMap.id}/versions`, W.pa.cookie, versionBody(W.fSec.revId));
  assert.deepEqual([noNote.status, noNote.body.error], [400, "conversion_note_required"]);
  const conv = await post(`/mappings/${minMap.id}/versions`, W.pa.cookie, versionBody(W.fSec.revId, { conversionNote: "Seconds to minutes" }));
  assert.equal(conv.status, 201, conv.text);
  assert.deepEqual([conv.body.version.scale, conv.body.version.scaleDivisor, conv.body.version.offset, conv.body.version.conversionNote], ["1", "60", "0", "Seconds to minutes"]);
  const second = await post(`/mappings/${minMap.id}/versions`, W.pa.cookie, versionBody(W.fSec.revId, { conversionNote: "Seconds to minutes", appliesToDrill: false }));
  assert.equal(second.body.version.versionNumber, 2, "the server numbers versions");
  for (const extra of [{ scale: "1" }, { scaleDivisor: "60" }, { offset: "0" }, { parameterFingerprint: "v1:x" }, { ownerKey: "system" }, { targetUnit: "min" }, { sourceUnit: "s" }, { status: "active" }, { versionNumber: 9 }, { metricDefinitionVersionId: W.sysMin.versionId }, { parameterScale: "1" }]) {
    const r = await post(`/mappings/${minMap.id}/versions`, W.pa.cookie, versionBody(W.fSec.revId, { conversionNote: "x", ...extra }));
    assert.deepEqual([r.status, r.body.error], [400, "invalid_body"], JSON.stringify(extra));
  }
  for (const bad of [{ appliesToSession: false, appliesToDrill: false }, { appliesToSession: "yes" }, { conversionNote: " padded" }, { conversionNote: `two${ch(10)}lines` }, { conversionNote: `bidi${ch(0x202e)}x` }, { conversionNote: "x".repeat(501) }]) {
    const r = await post(`/mappings/${minMap.id}/versions`, W.pa.cookie, versionBody(W.fSec.revId, bad));
    assert.deepEqual([r.status, r.body.error], [400, "invalid_body"], JSON.stringify(bad));
  }
  // The revision.
  const otherField = await post(`/mappings/${minMap.id}/versions`, W.pa.cookie, versionBody(W.fZone.revId, { conversionNote: "x" }));
  assert.deepEqual([otherField.status, otherField.body.error], [409, "revision_not_usable"]);
  assert.equal((await post(`/mappings/${minMap.id}/versions`, W.pa.cookie, versionBody(crypto.randomUUID(), { conversionNote: "x" }))).body.error, "revision_not_usable");
  const seedMap = await mappingFor(W.pa, W.seedTime.id, W.sysMin.id);
  const unproven = await post(`/mappings/${seedMap.id}/versions`, W.pa.cookie, versionBody(W.seedTime.rev_id, { conversionNote: "x" }));
  assert.deepEqual([unproven.status, unproven.body.error], [409, "unit_not_proven"]);
  const halfZone = await field({ kind: "zone_bounds", unit: "m", boundUnit: "m/s", operator: ">=", verify: false, activate: false });
  await q(`update training_load.source_metric_definition_versions set source_unit = 'm', source_bound_unit = 'm/s', unit_verified_by_user_id = $2, unit_verified_at = now(), unit_evidence_ref = $3 where id = $1`, [halfZone.revId, W.pa.id, COMPAT]);
  const halfMap = await mappingFor(W.pa, halfZone.id, W.sysZone.id);
  const noOperator = await post(`/mappings/${halfMap.id}/versions`, W.pa.cookie, versionBody(halfZone.revId, { sourceParameters: { lower: "7", upper: null } }));
  assert.deepEqual([noOperator.status, noOperator.body.error], [409, "parameters_not_proven"]);
  // Levels: the revision's and the definition's.
  const soMap = await mappingFor(W.pa, W.fSessionOnly.id, W.sysSec.id);
  assert.deepEqual([(await post(`/mappings/${soMap.id}/versions`, W.pa.cookie, versionBody(W.fSessionOnly.revId))).body.error], ["level_not_allowed"]);
  assert.equal((await post(`/mappings/${soMap.id}/versions`, W.pa.cookie, versionBody(W.fSessionOnly.revId, { appliesToDrill: false }))).status, 201);
  const capMap = await mappingFor(W.pa, W.fSec.id, W.sysSessionOnly.id);
  assert.equal((await post(`/mappings/${capMap.id}/versions`, W.pa.cookie, versionBody(W.fSec.revId))).body.error, "level_not_allowed");
  // The canonical side.
  for (const [md, code] of [[W.sysText, "canonical_not_numeric"], [W.sysNoUnit, "canonical_unit_missing"], [W.sysBadUnit, "canonical_unit_not_a_token"]]) {
    const m = await mappingFor(W.pa, W.fSec.id, md.id);
    const r = await post(`/mappings/${m.id}/versions`, W.pa.cookie, versionBody(W.fSec.revId, { conversionNote: "x" }));
    assert.deepEqual([r.status, r.body.error], [409, code]);
  }
});

test("9. conversion rows: a non-normal active row ((1, 4) instead of (0.25, 1)) is refused, a missing or retired row is conversion_unavailable, a new active row is used with its own factors; numerically equal parameter inputs give the same canonical parameters and fingerprint, equal to an independent computation", async () => {
  const aaMap = await mappingFor(W.pa, W.fAa.id, W.sysBb.id);
  const notNormal = await post(`/mappings/${aaMap.id}/versions`, W.pa.cookie, versionBody(W.fAa.revId, { conversionNote: "aa to bb" }));
  assert.deepEqual([notNormal.status, notNormal.body.error], [409, "conversion_not_normal"]);
  const ccMap = await mappingFor(W.pa, W.fCc.id, W.sysDd.id);
  assert.equal((await post(`/mappings/${ccMap.id}/versions`, W.pa.cookie, versionBody(W.fCc.revId, { conversionNote: "cc to dd" }))).status, 201);
  await retireConversion(W.convCcDd);
  const retired = await post(`/mappings/${ccMap.id}/versions`, W.pa.cookie, versionBody(W.fCc.revId, { conversionNote: "cc to dd" }));
  assert.deepEqual([retired.status, retired.body.error], [409, "conversion_unavailable"]);
  await conversion("cc", "dd", "0.5");
  const renewed = await post(`/mappings/${ccMap.id}/versions`, W.pa.cookie, versionBody(W.fCc.revId, { conversionNote: "cc to dd" }));
  assert.deepEqual([renewed.status, renewed.body.version.scale], [201, "0.5"]);
  const versions = await q(`select trim_scale(scale)::text as scale from training_load.source_metric_mapping_versions where mapping_id = $1 order by version_number`, [ccMap.id]);
  assert.deepEqual(versions.map((v) => v.scale), ["2", "0.5"], "an earlier version keeps its own factors");
  // Zones: equal inputs, one canonical form.
  const zMap = (await api("/mappings", { cookie: W.pa.cookie })).body.mappings.find((m) => m.sourceMetric.id === W.fZone.id && m.metricDefinitionId === W.sysZone.id);
  const a = await post(`/mappings/${zMap.id}/versions`, W.pa.cookie, versionBody(W.fZone.revId, { sourceParameters: { lower: "7.000", upper: null } }));
  assert.equal(a.status, 201, a.text);
  const fp = await one(`select parameter_fingerprint, source_parameters::text as sp, canonical_parameters::text as cp, trim_scale(parameter_scale)::text as ps from training_load.source_metric_mapping_versions where id = $1`, [a.body.version.id]);
  const first = await one(`select parameter_fingerprint, source_parameters::text as sp, canonical_parameters::text as cp from training_load.source_metric_mapping_versions where mapping_id = $1 and version_number = 1`, [zMap.id]);
  assert.deepEqual([fp.parameter_fingerprint, fp.sp, fp.cp], [first.parameter_fingerprint, first.sp, first.cp], "7 and 7.000: one canonical record");
  assert.equal(fp.ps, "3.6", "the bound conversion m/s -> km/h");
  assert.equal(fp.parameter_fingerprint, `v1:${crypto.createHash("sha256").update("zone_bounds|lower=7|operator=>=|unit=m/s|upper=null", "utf8").digest("hex")}`);
  assert.equal(service.parameterFingerprint("zone_bounds", { operator: ">=", lower: "7", upper: null, unit: "m/s" }), fp.parameter_fingerprint);
  assert.deepEqual(a.body.version.sourceParameters, { operator: ">=", lower: "7", upper: null, unit: "m/s" });
  assert.deepEqual(a.body.version.canonicalParameters, { operator: ">=", lower: "25.2", upper: null, unit: "km/h" });
  // A between zone (identity bound units) and a threshold with a negative value and a negative zero.
  const bMap = await mappingFor(W.pa, W.fBetween.id, W.sysBetween.id);
  const b = await post(`/mappings/${bMap.id}/versions`, W.pa.cookie, versionBody(W.fBetween.revId, { sourceParameters: { lower: "25.0", upper: "60" } }));
  assert.equal(b.status, 201, b.text);
  assert.deepEqual([b.body.version.parameterScale, b.body.version.sourceParameters], ["1", { operator: "between", lower: "25", upper: "60", unit: "W/kg" }]);
  const tMap = await mappingFor(W.pa, W.fThreshold.id, W.sysThreshold.id);
  const t = await post(`/mappings/${tMap.id}/versions`, W.pa.cookie, versionBody(W.fThreshold.revId, { sourceParameters: { thresholdValue: "-2.50", durationSeconds: "0.5" } }));
  assert.equal(t.status, 201, t.text);
  assert.deepEqual(t.body.version.sourceParameters, { operator: "<=", threshold_value: "-2.5", duration_seconds: "0.5", unit: "m/s2" });
  assert.equal(t.body.version.parameterFingerprint, service.parameterFingerprint("event_threshold", { operator: "<=", threshold_value: "-2.5", duration_seconds: "0.5", unit: "m/s2" }));
  assert.equal(service.canonicalDecimal("-0.0"), "0");
  assert.equal(service.canonicalDecimal("-0"), "0");
  assert.equal(service.canonicalDecimal("012.3400"), "12.34");
  assert.equal(service.canonicalDecimal("100"), "100");
  // The normal form.
  for (const [s, d, ok] of [["3.6", "1", true], ["0.001", "1", true], ["1", "60", true], ["1", "3.6", true], ["1", "4", false], ["1", "0.25", false], ["1", "2", false], ["1", "1", true], ["2", "2", false]]) {
    assert.equal(service.isNormalFormPair(s, d), ok, `(${s}, ${d})`);
  }
});

test("10. parameters: exact decimal strings only (no number, exponent, too many digits, extra or missing key); forbidden for a revision without parameters; the operator decides upper; lower below upper; non-negative duration; the canonical side must exist, have the revision's operator, a conversion for its bound unit, and be equivalent", async () => {
  const zMap = (await api("/mappings", { cookie: W.pa.cookie })).body.mappings.find((m) => m.sourceMetric.id === W.fZone.id && m.metricDefinitionId === W.sysZone.id);
  const zone = (params) => post(`/mappings/${zMap.id}/versions`, W.pa.cookie, versionBody(W.fZone.revId, { sourceParameters: params }));
  for (const bad of [{ lower: 7, upper: null }, { lower: "7e0", upper: null }, { lower: "1234567890123", upper: null }, { lower: "7.0000000001", upper: null }, { lower: "+7", upper: null }, { lower: "07", upper: null }, { lower: "7", upper: null, unit: "m/s" }, { lower: "7" }, { lower: "7", upper: "9" }, "7", null]) {
    const r = await zone(bad);
    assert.deepEqual([r.status, r.body.error], [400, "invalid_parameters"], JSON.stringify(bad));
  }
  const bMap = (await api("/mappings", { cookie: W.pa.cookie })).body.mappings.find((m) => m.sourceMetric.id === W.fBetween.id);
  for (const bad of [{ lower: "25", upper: null }, { lower: "60", upper: "25" }, { lower: "25", upper: "25" }]) {
    const r = await post(`/mappings/${bMap.id}/versions`, W.pa.cookie, versionBody(W.fBetween.revId, { sourceParameters: bad }));
    assert.deepEqual([r.status, r.body.error], [400, "invalid_parameters"], JSON.stringify(bad));
  }
  const tMap = (await api("/mappings", { cookie: W.pa.cookie })).body.mappings.find((m) => m.sourceMetric.id === W.fThreshold.id);
  const neg = await post(`/mappings/${tMap.id}/versions`, W.pa.cookie, versionBody(W.fThreshold.revId, { sourceParameters: { thresholdValue: "-2.5", durationSeconds: "-1" } }));
  assert.deepEqual([neg.status, neg.body.error], [400, "invalid_parameters"]);
  const secMap = (await api("/mappings", { cookie: W.pa.cookie })).body.mappings.find((m) => m.sourceMetric.id === W.fSec.id && m.metricDefinitionId === W.sysSec.id);
  const none = await post(`/mappings/${secMap.id}/versions`, W.pa.cookie, versionBody(W.fSec.revId, { sourceParameters: {} }));
  assert.deepEqual([none.status, none.body.error], [400, "invalid_parameters"]);
  assert.deepEqual([(await zone({ lower: "8", upper: null })).body.error], ["parameters_not_equivalent"]);
  const otherOp = await mappingFor(W.pa, W.fZone.id, W.sysZoneOther.id).catch(() => null) ?? (await api("/mappings", { cookie: W.pa.cookie })).body.mappings.find((m) => m.metricDefinitionId === W.sysZoneOther.id && m.ownerScope === "system");
  const op = await post(`/mappings/${otherOp.id}/versions`, W.pa.cookie, versionBody(W.fZone.revId, { sourceParameters: { lower: "7", upper: null } }));
  assert.deepEqual([op.status, op.body.error], [409, "parameters_not_equivalent"], "a different operator");
  const badCd = await mappingFor(W.pa, W.fZone.id, W.sysZoneBad.id);
  assert.equal((await post(`/mappings/${badCd.id}/versions`, W.pa.cookie, versionBody(W.fZone.revId, { sourceParameters: { lower: "7", upper: null } }))).body.error, "condition_description_unsupported");
  const noConv = await mappingFor(W.pa, W.fZone.id, W.sysZoneNoConv.id);
  assert.equal((await post(`/mappings/${noConv.id}/versions`, W.pa.cookie, versionBody(W.fZone.revId, { sourceParameters: { lower: "7", upper: null } }))).body.error, "bound_conversion_unavailable");
});

test("11. club scope: a club admin versions and submits its own club's mappings only; never a system mapping, never another club's; a platform admin in the club's workspace acts for the club", async () => {
  const clubMap = (await api("/mappings", { cookie: W.caA.cookie })).body.mappings.find((m) => m.ownerScope === "club" && m.metricDefinitionId === W.clubAMin.id && m.sourceMetric.id === W.fSec.id);
  const v = await post(`/mappings/${clubMap.id}/versions`, W.caA.cookie, versionBody(W.fSec.revId, { conversionNote: "Seconds to minutes" }));
  assert.equal(v.status, 201, v.text);
  const sysMap = (await api("/mappings", { cookie: W.caA.cookie })).body.mappings.find((m) => m.ownerScope === "system");
  assert.equal((await post(`/mappings/${sysMap.id}/versions`, W.caA.cookie, versionBody(W.fSec.revId, { conversionNote: "x" }))).status, 404);
  assert.equal((await post(`/mappings/${clubMap.id}/versions`, W.caB.cookie, versionBody(W.fSec.revId, { conversionNote: "x" }))).status, 404);
  assert.equal((await post(`/mappings/${clubMap.id}/versions`, W.pa.cookie, versionBody(W.fSec.revId, { conversionNote: "x" }))).status, 404, "the platform workspace is the system scope");
  const support = await post(`/mappings/${clubMap.id}/versions`, W.paA.cookie, versionBody(W.fSec.revId, { conversionNote: "Seconds to minutes" }));
  assert.equal(support.status, 201);
  // Submit: the club admin's own draft, then the platform admin's.
  const s1 = await post(`/mappings/${clubMap.id}/versions/${v.body.version.id}/submit`, W.caA.cookie, { requestKey: key() });
  assert.deepEqual([s1.status, s1.body.version.status, s1.body.replayed], [200, "needs_review", false]);
  const row = await one(`select status, submitted_basis, submitted_by_user_id from training_load.source_metric_mapping_versions where id = $1`, [v.body.version.id]);
  assert.deepEqual(row, { status: "needs_review", submitted_basis: "club_admin", submitted_by_user_id: W.caA.id });
  const audit = await one(`select action, from_status, to_status, basis from training_load.source_metric_audit where mapping_version_id = $1 and action = 'mapping_status'`, [v.body.version.id]);
  assert.deepEqual(audit, { action: "mapping_status", from_status: "draft", to_status: "needs_review", basis: "club_admin" });
  const again = await post(`/mappings/${clubMap.id}/versions/${v.body.version.id}/submit`, W.caA.cookie, { requestKey: key() });
  assert.deepEqual([again.status, again.body.error, again.body.current], [409, "version_not_draft", { status: "needs_review" }]);
  assert.equal((await post(`/mappings/${clubMap.id}/versions/${support.body.version.id}/submit`, W.caB.cookie, { requestKey: key() })).status, 404);
  const fromPlatform = await post(`/mappings/${clubMap.id}/versions/${support.body.version.id}/submit`, W.pa.cookie, { requestKey: key() });
  assert.equal(fromPlatform.status, 404, "the platform workspace is the system scope: a club version is not its to submit");
  assert.equal((await one(`select status from training_load.source_metric_mapping_versions where id = $1`, [support.body.version.id])).status, "draft");
  const s2 = await post(`/mappings/${clubMap.id}/versions/${support.body.version.id}/submit`, W.paA.cookie, { requestKey: key() });
  assert.equal(s2.status, 200);
  assert.equal((await one(`select submitted_basis from training_load.source_metric_mapping_versions where id = $1`, [support.body.version.id])).submitted_basis, "platform_admin");
  assert.equal((await post(`/mappings/${clubMap.id}/versions/${crypto.randomUUID()}/submit`, W.caA.cookie, { requestKey: key() })).status, 404);
  assert.equal((await post(`/mappings/${clubMap.id}/versions/${v.body.version.id}/submit`, W.caA.cookie, { requestKey: key(), status: "active" })).body.error, "invalid_body");
});

test("12. submit: a replay answers the current state; a revision retired after the draft blocks the submission; the request record names the transition", async () => {
  const f = await field({ unit: "s" });
  const m = await mappingFor(W.pa, f.id, W.sysSec.id);
  const v = (await post(`/mappings/${m.id}/versions`, W.pa.cookie, versionBody(f.revId))).body.version;
  const requestKey = key();
  const first = await post(`/mappings/${m.id}/versions/${v.id}/submit`, W.pa.cookie, { requestKey });
  assert.equal(first.status, 200);
  const replay = await post(`/mappings/${m.id}/versions/${v.id}/submit`, W.pa.cookie, { requestKey });
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.version.status], [200, true, "needs_review"]);
  assert.equal((await q(`select 1 from training_load.source_metric_audit where request_key = $1`, [requestKey])).length, 1);
  const g = await field({ unit: "s" });
  const gm = await mappingFor(W.pa, g.id, W.sysSec.id);
  const gv = (await post(`/mappings/${gm.id}/versions`, W.pa.cookie, versionBody(g.revId))).body.version;
  await q(`update training_load.source_metric_definition_versions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Test retirement' where id = $1`, [g.revId, W.pa.id]);
  const blocked = await post(`/mappings/${gm.id}/versions/${gv.id}/submit`, W.pa.cookie, { requestKey: key() });
  assert.deepEqual([blocked.status, blocked.body.error], [409, "revision_not_usable"]);
  assert.equal((await one(`select status from training_load.source_metric_mapping_versions where id = $1`, [gv.id])).status, "draft");
});

test("13. concurrency: one write per user at a time (bounded, try_again with Retry-After), the same key concurrently is one write and one replay, the same pair concurrently is one mapping and one mapping_exists, version numbers never collide, a busy row answers try_again within its bound", async () => {
  // The same pair from two platform admins: the first is held after its checks, the second writes the
  // mapping; the first then meets the pair's unique key (23505) and answers mapping_exists, naming it.
  const f = await field({ unit: "s" });
  const g1 = gate();
  let held = 0;
  service.setMappingWriteHoldForTests(async (_c, where) => { if (where === "mapping_create" && held++ === 0) await g1.promise; });
  const first = post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: f.id, metricDefinitionId: W.sysSec.id });
  while (held === 0) await new Promise((res) => setTimeout(res, 20));
  const second = await post("/mappings", W.pa2.cookie, { requestKey: key(), sourceMetricId: f.id, metricDefinitionId: W.sysSec.id });
  assert.equal(second.status, 201, second.text);
  g1.open();
  const r1 = await first;
  assert.deepEqual([r1.status, r1.body.error, r1.body.current], [409, "mapping_exists", { mappingId: second.body.mapping.id }]);
  assert.equal((await q(`select 1 from training_load.source_metric_audit where mapping_id = $1`, [second.body.mapping.id])).length, 1, "the losing request wrote no record");
  // The same user and key concurrently: the per-user lock serializes; the second replays.
  const f2 = await field({ unit: "s" });
  const g2 = gate();
  held = 0;
  service.setMappingWriteHoldForTests(async (_c, where) => { if (where === "mapping_create" && held++ === 0) await g2.promise; });
  const body = { requestKey: key(), sourceMetricId: f2.id, metricDefinitionId: W.sysSec.id };
  const a = post("/mappings", W.pa.cookie, body);
  await new Promise((res) => setTimeout(res, 150));
  const b = post("/mappings", W.pa.cookie, body);
  assert.equal(await someoneWaits(), true, "the same user's second write waits");
  g2.open();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.status, rb.status, rb.body.replayed, rb.body.mapping.id], [201, 200, true, ra.body.mapping.id]);
  // Another key of the same user while a write is held: try_again after the bounded wait.
  const f3 = await field({ unit: "s" });
  const g3 = gate();
  service.setMappingUserLockWaitForTests(300);
  service.setMappingWriteHoldForTests(async (_c, where) => { if (where === "mapping_create") await g3.promise; });
  const slow = post("/mappings", W.pa2.cookie, { requestKey: key(), sourceMetricId: f3.id, metricDefinitionId: W.sysSec.id });
  await new Promise((res) => setTimeout(res, 150));
  const busy = await post("/mappings", W.pa2.cookie, { requestKey: key(), sourceMetricId: f3.id, metricDefinitionId: W.sysMin.id });
  assert.deepEqual([busy.status, busy.body.error, busy.headers.get("retry-after")], [409, "try_again", "5"]);
  g3.open();
  assert.equal((await slow).status, 201);
  service.setMappingWriteHoldForTests(null);
  service.setMappingUserLockWaitForTests(null);
  // Two versions of one mapping at once (two users): the mapping row (FOR NO KEY UPDATE) serializes
  // them - the second waits for the first - and the numbers are 1 and 2.
  const vm = await mappingFor(W.pa, f2.id, W.sysMin.id);
  const g4 = gate();
  held = 0;
  service.setMappingWriteHoldForTests(async (_c, where) => { if (where === "mapping_version_create" && held++ === 0) await g4.promise; });
  const v1p = post(`/mappings/${vm.id}/versions`, W.pa.cookie, versionBody(f2.revId, { conversionNote: "s to min" }));
  while (held === 0) await new Promise((res) => setTimeout(res, 20));
  const v2p = post(`/mappings/${vm.id}/versions`, W.pa2.cookie, versionBody(f2.revId, { conversionNote: "s to min" }));
  assert.equal(await someoneWaits(), true, "the second version waits for the first one's mapping row");
  g4.open();
  const [v1, v2] = await Promise.all([v1p, v2p]);
  service.setMappingWriteHoldForTests(null);
  assert.deepEqual([v1.status, v2.status], [201, 201]);
  assert.deepEqual([v1.body.version.versionNumber, v2.body.version.versionNumber], [1, 2]);
  // A row held by another transaction: the write answers try_again after the row bound, nothing written.
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select 1 from training_load.metric_definitions where id = $1 for update`, [W.sysDd.id]);
    const f4 = await field({ unit: "dd" });
    const started = Date.now();
    const r = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: f4.id, metricDefinitionId: W.sysDd.id });
    assert.deepEqual([r.status, r.body.error], [409, "try_again"]);
    assert.ok(Date.now() - started >= service.ROW_LOCK_TIMEOUT_MS - 250, "it waited for the row bound");
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
});

test("14. the lock order against a conversion retirement, both orders: a version holding the row FOR SHARE makes the retirement wait; a retirement first makes the version find no active row", async () => {
  const conv = await conversion("ee", "ff", "3");
  const f = await field({ unit: "ee" });
  const m = await mappingFor(W.pa, f.id, W.sysFf.id);
  // The version first.
  const g = gate();
  service.setMappingWriteHoldForTests(async (_c, where) => { if (where === "mapping_version_create") await g.promise; });
  const writing = post(`/mappings/${m.id}/versions`, W.pa.cookie, versionBody(f.revId, { conversionNote: "ee to ff" }));
  await new Promise((res) => setTimeout(res, 200));
  const retirer = new pg.Client({ connectionString: db.url });
  await retirer.connect();
  try {
    const retiring = retirer.query(`update training_load.unit_conversions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Test retirement' where id = $1`, [conv, W.pa.id]);
    assert.equal(await someoneWaits(), true, "the retirement waits for the version's FOR SHARE");
    g.open();
    assert.equal((await writing).status, 201);
    await retiring;
  } finally {
    await retirer.end();
    service.setMappingWriteHoldForTests(null);
  }
  // The retirement first.
  const conv2 = await conversion("ee", "ff", "3");
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`update training_load.unit_conversions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = 'Test retirement' where id = $1`, [conv2, W.pa.id]);
    const writing2 = post(`/mappings/${m.id}/versions`, W.pa.cookie, versionBody(f.revId, { conversionNote: "ee to ff" }));
    assert.equal(await someoneWaits(), true, "the version waits for the retirement");
    await holder.query("commit");
    const r = await writing2;
    assert.deepEqual([r.status, r.body.error], [409, "conversion_unavailable"]);
  } finally {
    await holder.end();
  }
});

test("15. the COMMIT: an answer lost but verified is 200 with verified_after_commit_error (a create too, never 201); an answer lost and not found is 503 outcome_unknown with the key, and the same key then writes once", async () => {
  const f = await field({ unit: "s" });
  service.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw new Error("answer lost"); }), timeoutMs: 2_000 });
  const lost = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: f.id, metricDefinitionId: W.sysSec.id });
  assert.deepEqual([lost.status, lost.body.commitConfirmation, lost.body.replayed], [200, "verified_after_commit_error", false]);
  assert.equal(lost.body.mapping.sourceMetric.id, f.id);
  const g = await field({ unit: "s" });
  service.setMappingCommitForTests({ fault: (client) => client.query("rollback").then(() => { throw new Error("answer lost"); }), timeoutMs: 2_000 });
  const requestKey = key();
  const unknown = await post("/mappings", W.pa.cookie, { requestKey, sourceMetricId: g.id, metricDefinitionId: W.sysSec.id });
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.requestKey], [503, "outcome_unknown", requestKey]);
  service.setMappingCommitForTests();
  const retry = await post("/mappings", W.pa.cookie, { requestKey, sourceMetricId: g.id, metricDefinitionId: W.sysSec.id });
  assert.equal(retry.status, 201);
  assert.equal((await q(`select 1 from training_load.source_metric_mappings where source_metric_definition_id = $1`, [g.id])).length, 1);
});

test("16. a database refusal outside the allowlist is a sanitized 500 internal_error with nothing written (no partial state); a busy pool is 409 try_again with Retry-After 5", async () => {
  const f = await field({ unit: "s" });
  await admin.query(`create function training_load.m2_test_refusal() returns trigger as $$ begin raise exception 'm2 marker refusal text' using errcode = '23514'; end $$ language plpgsql`);
  await admin.query(`create trigger m2_test_refusal before insert on training_load.source_metric_audit for each row execute function training_load.m2_test_refusal()`);
  try {
    const before = (await one(`select count(*)::int as n from training_load.source_metric_mappings`)).n;
    const r = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: f.id, metricDefinitionId: W.sysSec.id });
    assert.deepEqual([r.status, r.body.error], [500, "internal_error"]);
    assert.ok(!r.text.includes("marker") && !r.text.includes("23514"), "no database text");
    assert.equal((await one(`select count(*)::int as n from training_load.source_metric_mappings`)).n, before, "the mapping was rolled back with the failed request record");
    assert.ok(!logLines.some((l) => l.includes("m2 marker refusal text")), "no database text in the log");
  } finally {
    await admin.query(`drop trigger m2_test_refusal on training_load.source_metric_audit`);
    await admin.query(`drop function training_load.m2_test_refusal()`);
  }
  dbModule.setPoolCheckoutFaultForTests((form) => (form === "promise" ? new Error("timeout exceeded when trying to connect") : null));
  const busy = await post("/mappings", W.pa.cookie, { requestKey: key(), sourceMetricId: f.id, metricDefinitionId: W.sysSec.id });
  dbModule.setPoolCheckoutFaultForTests(null);
  assert.deepEqual([busy.status, busy.body.error, busy.headers.get("retry-after")], [409, "try_again", "5"]);
  // The allowlist: known v34 trigger texts map to their codes; anything else is not mapped.
  assert.equal(service.classifyDatabaseError({ code: "23514", message: "source_metric_mapping_versions: canonical_unit_not_a_token" }).code, "canonical_unit_not_a_token");
  assert.equal(service.classifyDatabaseError({ code: "23514", message: "some other refusal" }), null);
  assert.equal(service.classifyDatabaseError({ code: "23514", constraint: "any_check", message: "source_metric_mapping_versions: canonical_unit_not_a_token" }), null);
  assert.equal(service.classifyDatabaseError({ code: "23505", constraint: "source_metric_mappings_pair_key" }).code, "mapping_exists");
  assert.equal(service.classifyDatabaseError({ code: "23505", constraint: "other_key" }), null);
  assert.equal(service.classifyDatabaseError({ code: "40P01" }).code, "try_again");
  assert.equal(service.classifyDatabaseError({ code: "42501" }).code, "notFound");
  assert.equal(service.classifyDatabaseError({ code: "XX000", message: "boom" }), null);
});

test("17. lists are capped and refused, never cut: more than the cap of fields is result_too_large", async () => {
  const count = (await one(`select count(*)::int as n from training_load.source_metric_definitions`)).n;
  for (let i = count; i <= service.LIST_CAPS.fields; i += 1) {
    await q(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'Filler',$2)`, [`m2.fill.f${uid()}`, W.pa.id]);
  }
  const r = await api("/fields", { cookie: W.pa.cookie });
  assert.deepEqual([r.status, r.body.error, r.body.limit], [409, "result_too_large", service.LIST_CAPS.fields]);
  assert.equal((await api("/fields?apiFamily=api", { cookie: W.pa.cookie })).status, 200, "a filter under the cap still answers");
});

test("18. the right is checked again under FOR SHARE right before the write: a club role revoked while the request runs, or the club archived, writes nothing and answers the 404", async () => {
  assert.deepEqual(await metricsDigest(), W.metricsDigest, "tests 1-17 left Metrics Core unchanged");
  const caX = await clubAdmin(W.clubA);
  const f = await field({ unit: "s" });
  service.setMappingRightsHoldForTests(async () => {
    service.setMappingRightsHoldForTests(null);
    await q(`update public.user_club_roles set is_active = false where user_id = $1`, [caX.id]);
  });
  const revoked = await post("/mappings", caX.cookie, { requestKey: key(), sourceMetricId: f.id, metricDefinitionId: W.clubASec.id });
  assert.deepEqual([revoked.status, revoked.body], [404, { error: "notFound" }]);
  assert.equal((await q(`select 1 from training_load.source_metric_mappings where source_metric_definition_id = $1`, [f.id])).length, 0, "nothing written");
  const clubY = await club("Club Y");
  const mdY = await canonical({ scope: "club", clubId: clubY, unit: "s" });
  const caY = await clubAdmin(clubY);
  service.setMappingRightsHoldForTests(async () => {
    service.setMappingRightsHoldForTests(null);
    await q(`update public.clubs set is_active = false where id = $1`, [clubY]);
  });
  const archived = await post("/mappings", caY.cookie, { requestKey: key(), sourceMetricId: f.id, metricDefinitionId: mdY.id });
  assert.deepEqual([archived.status, archived.body], [404, { error: "notFound" }]);
  assert.equal((await q(`select 1 from training_load.source_metric_mappings where metric_definition_id = $1`, [mdY.id])).length, 0);
  W.metricsDigest = await metricsDigest();
});

test("19. nothing of M2 writes a T5 activation, a T6 fact, a T2a / T2b row or Metrics Core; every request record is a mapping action; no response or log line carries a trigger's or the database's text, or an acting user's id", async () => {
  assert.equal((await one(`select count(*)::int as n from training_load.source_metric_mapping_activations`)).n, 0);
  assert.equal((await one(`select count(*)::int as n from training_load.metric_value_source_provenance`)).n, 0);
  assert.equal((await one(`select count(*)::int as n from training_load.source_metric_mapping_versions where status not in ('draft', 'needs_review')`)).n, 0, "no activation or disabling");
  assert.deepEqual(await metricsDigest(), W.metricsDigest, "Metrics Core unchanged");
  const actions = (await q(`select distinct action from training_load.source_metric_audit order by 1`)).map((r) => r.action);
  assert.deepEqual(actions, ["mapping_create", "mapping_status", "mapping_version_create"]);
  const userIds = [W.pa.id, W.pa2.id, W.paA.id, W.caA.id, W.caA2.id, W.caB.id];
  for (const text of responses) {
    assert.ok(!/source_metric_(mapping|audit|definition)|violates|syntax error|relation "/i.test(text), `no database text: ${text.slice(0, 160)}`);
    for (const id of userIds) assert.ok(!text.includes(id), "no acting user's id");
  }
  assert.ok(!logLines.some((l) => /source_metric_mapping_versions:|source_metric_mappings:/.test(l)), "no trigger text in the log");
});

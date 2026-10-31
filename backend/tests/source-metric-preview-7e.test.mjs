// Phase 7e - the aggregate preview of a mapping version through the real
// route: GET /mappings/:mappingId/versions/:versionId/preview?candidateId=.
// Contract: docs/ai/phase7e-aggregate-preview-contract.md (J11), sections 2-6
// and 8. Through the real HTTP stack on one disposable optimove_tests_gpexe_*
// database migrated through the last test migration (never OPTIMOVE, never a
// GPEXE request). The seeded gpexe / rest_v1 fields are the database's own
// (v34, v42); their revisions are confirmed here by the shared fixtures, on this
// database only. The candidates and their checks, connections and bindings are
// direct inserts that pass every database guard (v22-v33). This suite does NOT
// let synthetic keys through the registry, except for one case that builds a
// version as one made before phase 7f. The pure part (the conversion, one
// level, the mapper seam) is source-metric-preview-math-7e.test.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN } from "./_gpexe-disposable-db.mjs";
import { verifyRevisionRow, writeRevision } from "./support/source-revisions.mjs";
import { EXTRACTORS, setExtractorFallbackForTests } from "../src/sourceMetricExtractors.js";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { PLANTED, previewAthletes, previewBundle } from "./support/preview-bundles.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = "/api/training-load/sources/metrics";
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const MAX_BYTES = 16 * 1024 * 1024;

let db, k, server, apiBase, previews, appPool, createSession;
const W = {};
const V = {};
const responses = [];
const previewResponses = [];
const logLines = [];
const originalConsole = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "x7e" });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  process.env.DATABASE_URL = db.url;
  // Every console line of the suite, an Error with its message and stack.
  const fmt = (a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map(fmt).join(" "));
      if (process.env.X7E_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  previews = await import("../src/sourceMetricPreviewService.js");
  const dbModule = await import("../src/db.js");
  ({ createSession } = await import("../src/auth.js"));
  appPool = dbModule.pool;
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await world();
});

after(async () => {
  setExtractorFallbackForTests(null);
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) {
    let timer;
    await Promise.race([appPool.end(), new Promise((res) => { timer = setTimeout(res, 5_000); })]);
    clearTimeout(timer);
  }
  await k?.end().catch(() => {});
  await db?.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

// ---------------------------------------------------------------------------
// helpers
const uid = () => crypto.randomBytes(4).toString("hex");
const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
const key = () => crypto.randomUUID();
async function api(p, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${PREFIX}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  responses.push(text);
  if (p.includes("/preview")) previewResponses.push(text);
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, headers: res.headers, text };
}
const post = (p, cookie, body) => api(p, { method: "POST", cookie, body });
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const refused = (res, status, code) => { assert.deepEqual([res.status, res.body.error], [status, code], res.text); return res.body; };
const isNotFound = (res, label) => {
  assert.equal(res.status, 404, `${label}: ${res.text}`);
  assert.deepEqual(res.body, { error: "notFound" }, label);
  assert.equal(res.headers.get("cache-control"), "no-store", label);
};
const previewPath = (v, query) => `/mappings/${v.mappingId}/versions/${v.versionId}/preview${query === undefined ? "" : `?${query}`}`;
const preview = (v, candidateId, who, extra = "") => api(previewPath(v, `candidateId=${candidateId}${extra}`), { cookie: who?.cookie });

async function user(label) {
  return (await one(`insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,true) returning id`, [`${label}-${uid()}@test.local`, label])).id;
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
  if (ws[0] === "team") await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, ws[1]]);
  await workspace(id, ws[0], ws[1]);
  return { id, cookie: await cookieFor(id) };
}
async function clubAdmin(clubId, ws = ["club", clubId]) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await workspace(id, ws[0], ws[1]);
  return { id, cookie: await cookieFor(id) };
}
async function coachOf(teamId) {
  const id = await user("coach");
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await workspace(id, "team", teamId);
  return { id, cookie: await cookieFor(id) };
}
const club = async (name) => (await one(`insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const setClubActive = (clubId, active) => k.query(`update public.clubs set is_active = $2 where id = $1`, [clubId, active]);
const setTeamActive = (teamId, active) => k.query(`update public.teams set is_active = $2 where id = $1`, [teamId, active]);

// ---------------------------------------------------------------------------
// GPEXE fixtures: a club-owned connection per club and host (state verified;
// the credential parts are random bytes, never decrypted), a team with its
// gpexe settings and, unless `bound: false`, a binding; a finished check on the
// team's path; a candidate holding a stored bundle.
let gpexeTeamCounter = 0;
const connectionOf = new Map();
async function connection(clubId, hostKey) {
  const at = `${clubId}:${hostKey}`;
  if (!connectionOf.has(at)) {
    connectionOf.set(at, (await one(
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                                credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','club',$1,$2,'7e test','exchanged_token',$3,'verified',$4,$5,$6,1, now()) returning id`,
      [clubId, hostKey, W.pa.id, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id);
  }
  return connectionOf.get(at);
}
async function gpexeTeam(clubId, { bound = true, hostKey = "server3", teamOwnedConnection = false } = {}) {
  const teamId = (await one(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
  gpexeTeamCounter += 1;
  const sourceTeamId = String(970000 + gpexeTeamCounter);
  await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)`, [teamId, sourceTeamId, W.pa.id]);
  if (!bound) return { teamId, clubId, sourceTeamId, bindingId: null, connectionId: null, hostKey: null };
  const connectionId = teamOwnedConnection
    ? (await one(`insert into training_load.source_credential_connections (source_system, owner_scope, owner_team_id, host_key, account_label, credential_kind, created_by_user_id, state)
                  values ('gpexe','team',$1,$2,'7e team-owned','exchanged_token',$3,'not_connected') returning id`, [teamId, hostKey, W.pa.id])).id
    : await connection(clubId, hostKey);
  const bindingId = (await one(
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
     values ($1,$2,'gpexe',$3,$4,$1) returning id`, [teamId, connectionId, sourceTeamId, W.pa.id])).id;
  return { teamId, clubId, sourceTeamId, bindingId, connectionId, hostKey };
}
async function check(t) {
  const viaBinding = t.bindingId !== null;
  return (await one(
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id,
                                                    source_path, source_connection_id, source_binding_id, source_team_id, source_host_key)
     values ($1,$2,'succeeded','2026-09-14','2026-09-14', now(), $3, $4, $5, $6, $7, $8) returning id`,
    [t.teamId, W.pa.id, t.sourceTeamId, viaBinding ? "source_connection" : "legacy_env",
      viaBinding ? t.connectionId : null, viaBinding ? t.bindingId : null, viaBinding ? t.sourceTeamId : null, viaBinding ? t.hostKey : null])).id;
}
// state: "available" | "purged" | "expired".
async function candidate(t, { state = "available", bundle = previewBundle({ gpexeTeamId: Number(t.sourceTeamId) }) } = {}) {
  const c = await check(t);
  const purged = state === "purged";
  return (await one(
    `insert into training_load.gpexe_import_candidates (owner_team_id, gpexe_team_session_id, session_started_at, session_label, bundle_hash,
                                                        raw_bundle, raw_purged_at, raw_expires_at, status, first_seen_check_id, last_seen_check_id, drill_parameter_effect)
     values ($1, $2, '2026-09-14T18:08:12Z', 'S', $3, $4::jsonb, $5, now() + ($6 || ' minutes')::interval, 'pending', $7, $7, 'confirmed') returning id`,
    [t.teamId, String(PLANTED.sessionId), crypto.randomBytes(32).toString("hex"),
      purged ? null : JSON.stringify(bundle), purged ? new Date() : null,
      state === "available" ? String(30 * 24 * 60) : "-1", c])).id;
}
async function candidates(t) {
  return { ok: await candidate(t), purged: await candidate(t, { state: "purged" }), expired: await candidate(t, { state: "expired" }) };
}

// ---------------------------------------------------------------------------
// Fields, variables and versions (through the real M3-0 and M2 routes).
async function seeded(sourceMetricKey) {
  return one(`select d.id as "fieldId", r.id as "revId" from training_load.source_metric_definitions d
                join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id and r.revision_number = 1
               where d.source_system = 'gpexe' and d.api_family = 'rest_v1' and d.source_metric_key = $1`, [sourceMetricKey]);
}
const confirm = (f, { unit, boundUnit = null, operator = null }) => verifyRevisionRow(k, {
  fieldId: f.fieldId, revisionId: f.revId, by: W.pa.id, unit, boundUnit, unitRef: UNIT_REF, meaning: true, operator, meaningRef: MEANING_REF,
});
async function synthetic({ apiFamily = "rest_v1", valueShape = "number", parameterKind = "none", unit = "s", boundUnit = null, operator = null } = {}) {
  const fieldId = (await one(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe',$1,$2,'7e test field',$3) returning id`,
    [apiFamily, `x7e.test.f${uid()}`, W.pa.id])).id;
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape, parameterKind, evidenceRef: COMPAT, unit, boundUnit, unitRef: UNIT_REF, meaning: true, operator, meaningRef: MEANING_REF, state: "active" });
  return { fieldId, revId };
}
async function variable({ unit, condition, owner = W.pa } = {}) {
  const res = await post("/variables", owner.cookie, { requestKey: key(), label: `Preview variable ${uid()}`, unit, levels: ["session", "drill"], dailyAggregationMethod: "sum", ...(condition ? { condition } : {}) });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.variable.id };
}
// A draft version of field f into a new variable, by `owner` (the preview has
// no status gate: a draft is previewed before it is submitted).
async function version(f, { unit, condition, sourceParameters, owner = W.pa, appliesToSession = true, appliesToDrill = true, conversionNote }) {
  const target = await variable({ unit, condition, owner });
  const mappingId = ok(await post("/mappings", owner.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id }), 201).mapping.id;
  const v = ok(await post(`/mappings/${mappingId}/versions`, owner.cookie, {
    requestKey: key(), sourceRevisionId: f.revId, appliesToSession, appliesToDrill, ...(sourceParameters === undefined ? {} : { sourceParameters }),
    ...(conversionNote === undefined ? {} : { conversionNote }),
  }), 201).version;
  return { mappingId, versionId: v.id, fieldId: f.fieldId };
}
const SECONDS_TO_MINUTES = "Seconds to minutes.";
const SYNTHETIC = Object.freeze({ key: "synthetic", valueShape: null, parameterKind: null, zone: null, direction: null, checkParameters: () => null, extract: () => ({ skip: "x" }) });

async function world() {
  W.pa = await platformAdmin();
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.clubC = await club("Club C");
  W.paA = await platformAdmin(["club", W.clubA]);
  W.caA = await clubAdmin(W.clubA);
  W.caB = await clubAdmin(W.clubB);
  // An admin of two clubs, active in club B's workspace.
  W.caAB = await clubAdmin(W.clubA, ["club", W.clubB]);
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [W.caAB.id, W.clubB]);
  W.plain = { id: await user("no-role") };
  await workspace(W.plain.id, "platform", null);
  W.plain.cookie = await cookieFor(W.plain.id);

  // Teams and candidates.
  W.tA = await gpexeTeam(W.clubA);
  W.tA2 = await gpexeTeam(W.clubA); // another team of club A
  W.tB = await gpexeTeam(W.clubB);
  W.tC = await gpexeTeam(W.clubC);
  W.tArch = await gpexeTeam(W.clubA);
  W.tNoClub = await gpexeTeam(null, { teamOwnedConnection: true });
  W.tL = await gpexeTeam(W.clubA, { bound: false }); // legacy_env, never bound
  W.tE = await gpexeTeam(W.clubA, { hostKey: "e03" }); // the api family
  W.cA = await candidates(W.tA);
  W.cA2 = await candidate(W.tA2);
  W.cB = await candidates(W.tB);
  W.cC = await candidates(W.tC);
  W.cArch = await candidates(W.tArch);
  W.cNoClub = await candidates(W.tNoClub);
  W.cL = await candidate(W.tL);
  W.cE = await candidate(W.tE);
  W.coachA = await coachOf(W.tA.teamId);
  W.paTeam = await platformAdmin(["team", W.tA.teamId]);

  // The ten seeded fields, confirmed once each, and a version per spec of
  // today's mapper with that spec's own bounds.
  const F = {};
  for (const [name, sourceMetricKey, conf] of [
    ["time", "athlete_session.total_time", { unit: "s" }],
    ["distance", "athlete_session.total_distance", { unit: "m" }],
    ["maxV", "athlete_session.max_v", { unit: "m/s" }],
    ["power", "more.complementary_data.power.distance", { unit: "m", boundUnit: "W/kg", operator: "between" }],
    ["powerTop", "more.complementary_data.power.distance.open_top", { unit: "m", boundUnit: "W/kg", operator: ">=" }],
    ["speed", "more.complementary_data.speed.distance", { unit: "m", boundUnit: "m/s", operator: ">=" }],
    ["acc", "more.events.acceleration_events_count", { unit: "count", boundUnit: "m/s2", operator: ">=" }],
    ["dec", "more.events.deceleration_events_count", { unit: "count", boundUnit: "m/s2", operator: "<=" }],
    ["burst", "details.players.tot_burst_events", { unit: "count" }],
    ["brake", "details.players.tot_brake_events", { unit: "count" }],
  ]) {
    F[name] = await seeded(sourceMetricKey);
    await confirm(F[name], conf);
  }
  const closedZone = (lower, upper) => ({ unit: "m", condition: { kind: "zone", operator: "between", lower, upper, unit: "W/kg" }, sourceParameters: { lower, upper } });
  V.time = await version(F.time, { unit: "min", conversionNote: SECONDS_TO_MINUTES });
  V.timeSessionOnly = await version(F.time, { unit: "min", appliesToDrill: false, conversionNote: SECONDS_TO_MINUTES });
  V.distance = await version(F.distance, { unit: "m" });
  V.maxV = await version(F.maxV, { unit: "km/h", conversionNote: "Metres per second to kilometres per hour." });
  V.p2560 = await version(F.power, closedZone("25", "60"));
  V.p6075 = await version(F.power, closedZone("60", "75"));
  V.p2255 = await version(F.power, closedZone("22", "55")); // bounds that fit no team threshold of the fixture
  V.p75 = await version(F.powerTop, { unit: "m", condition: { kind: "zone", operator: ">=", value: "75", unit: "W/kg" }, sourceParameters: { lower: "75", upper: null } });
  V.sprint = await version(F.speed, { unit: "m", condition: { kind: "zone", operator: ">=", value: "7", unit: "m/s" }, sourceParameters: { lower: "7", upper: null } });
  V.acc = await version(F.acc, { unit: "count", condition: { kind: "event_threshold", operator: ">=", value: "2.5", durationSeconds: "0.3", unit: "m/s2" }, sourceParameters: { thresholdValue: "2.5", durationSeconds: "0.3" } });
  V.dec = await version(F.dec, { unit: "count", condition: { kind: "event_threshold", operator: "<=", value: "-2.5", durationSeconds: "0.3", unit: "m/s2" }, sourceParameters: { thresholdValue: "-2.5", durationSeconds: "0.3" } });
  V.burst = await version(F.burst, { unit: "count" });
  V.brake = await version(F.brake, { unit: "count" });
  // Club mappings of club A and club B.
  V.clubA = await version(F.time, { unit: "min", owner: W.caA, conversionNote: SECONDS_TO_MINUTES });
  V.clubB = await version(F.time, { unit: "min", owner: W.caB, conversionNote: SECONDS_TO_MINUTES });
}

// ---------------------------------------------------------------------------
test("1. 401 without a session; the 200 answer has exactly the keys of J11 section 3, a draft version of a system mapping over a club A candidate in the platform workspace", async () => {
  const anonymous = await preview(V.time, W.cA.ok, null);
  assert.equal(anonymous.status, 401);
  const res = await preview(V.time, W.cA.ok, W.pa);
  const body = ok(res);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(body), ["preview"]);
  assert.deepEqual(Object.keys(body.preview).sort(), ["candidateId", "levels", "minimumAthletes", "sourceUnit", "targetUnit", "versionId"]);
  assert.deepEqual(Object.keys(body.preview.levels).sort(), ["drill", "session"]);
  for (const level of ["session", "drill"]) assert.deepEqual(Object.keys(body.preview.levels[level]).sort(), ["athletesWithValue", "max", "maxCanonical", "min", "minCanonical"]);
  assert.deepEqual(body.preview, {
    candidateId: W.cA.ok, versionId: V.time.versionId, sourceUnit: "s", targetUnit: "min", minimumAthletes: 3,
    levels: {
      session: { athletesWithValue: 3, min: "60.00000003", max: "1800", minCanonical: "1.000000001", maxCanonical: "30" },
      drill: { athletesWithValue: 3, min: "30.00000003", max: "1800", minCanonical: "0.500000001", maxCanonical: "30" },
    },
  });
});

test("2. the identical 404 (no-store), each case with an available, a purged and an expired candidate, so the 404 always comes before snapshot_expired: a coach, a user with no role, a platform admin in a team workspace, another club's admin, an admin of two clubs in the other club's workspace, a platform admin in club A's workspace over a club B candidate, the platform workspace over a club mapping, a club admin over another club's mapping, a club-less team, an archived team, an archived club", async () => {
  const each = async (label, v, c, who) => {
    for (const state of ["ok", "purged", "expired"]) isNotFound(await preview(v, c[state], who), `${label} (${state})`);
  };
  await each("a coach of the candidate's team", V.time, W.cA, W.coachA);
  await each("a user with no role", V.time, W.cA, W.plain);
  await each("a platform admin in a team workspace", V.time, W.cA, W.paTeam);
  await each("club B's admin over a club A candidate", V.time, W.cA, W.caB);
  await each("an admin of clubs A and B in club B's workspace over a club A candidate", V.time, W.cA, W.caAB);
  await each("a platform admin in club A's workspace over a club B candidate", V.time, W.cB, W.paA);
  await each("club A's admin over a club B candidate", V.time, W.cB, W.caA);
  await each("the platform workspace over a club mapping", V.clubA, W.cA, W.pa);
  await each("club A's admin over club B's mapping", V.clubB, W.cA, W.caA);
  await each("club B's admin over club A's mapping and club A's candidate", V.clubA, W.cA, W.caB);
  await each("a team without a club (platform workspace)", V.time, W.cNoClub, W.pa);
  // An archived team: every caller, every snapshot state.
  await setTeamActive(W.tArch.teamId, false);
  try {
    await each("an archived team (platform workspace)", V.time, W.cArch, W.pa);
    await each("an archived team (club A's admin)", V.time, W.cArch, W.caA);
  } finally {
    await setTeamActive(W.tArch.teamId, true);
  }
  ok(await preview(V.time, W.cArch.ok, W.caA)); // restored, the same candidate is previewed
  // An archived club (the platform workspace, which still resolves).
  await setClubActive(W.clubC, false);
  try {
    await each("an archived club", V.time, W.cC, W.pa);
  } finally {
    await setClubActive(W.clubC, true);
  }
  ok(await preview(V.time, W.cC.ok, W.pa));
});

test("3. the path and the query: a malformed id, a version not of the named mapping, an unknown candidate, and a missing, empty, repeated, nested or malformed candidateId or any other parameter (one named like an Object.prototype member included) are the identical 404; an upper-case candidate id is the same candidate", async () => {
  const bad = [
    ["a malformed mapping id", api(previewPath({ mappingId: "not-a-uuid", versionId: V.time.versionId }, `candidateId=${W.cA.ok}`), { cookie: W.pa.cookie })],
    ["a malformed version id", api(previewPath({ mappingId: V.time.mappingId, versionId: "123" }, `candidateId=${W.cA.ok}`), { cookie: W.pa.cookie })],
    ["a version not of the named mapping", api(previewPath({ mappingId: V.distance.mappingId, versionId: V.time.versionId }, `candidateId=${W.cA.ok}`), { cookie: W.pa.cookie })],
    ["an unknown mapping", api(previewPath({ mappingId: crypto.randomUUID(), versionId: V.time.versionId }, `candidateId=${W.cA.ok}`), { cookie: W.pa.cookie })],
    ["an unknown candidate", preview(V.time, crypto.randomUUID(), W.pa)],
    ["no query", api(previewPath(V.time), { cookie: W.pa.cookie })],
    ["an empty candidateId", api(previewPath(V.time, "candidateId="), { cookie: W.pa.cookie })],
    ["a malformed candidateId", preview(V.time, "abc", W.pa)],
    ["a repeated candidateId", preview(V.time, W.cA.ok, W.pa, `&candidateId=${W.cA.ok}`)],
    ["a nested candidateId", api(previewPath(V.time, `candidateId[x]=${W.cA.ok}`), { cookie: W.pa.cookie })],
    ["another parameter", preview(V.time, W.cA.ok, W.pa, "&x=1")],
    ["another parameter alone", api(previewPath(V.time, `id=${W.cA.ok}`), { cookie: W.pa.cookie })],
    // Keys a query parser drops or nests (Object.prototype names, brackets) still count.
    ["a constructor parameter", preview(V.time, W.cA.ok, W.pa, "&constructor=1")],
    ["a toString parameter", preview(V.time, W.cA.ok, W.pa, "&toString=1")],
    ["a __proto__ parameter", preview(V.time, W.cA.ok, W.pa, "&__proto__=1")],
    ["an encoded bracket", api(previewPath(V.time, `candidateId%5Bx%5D=${W.cA.ok}`), { cookie: W.pa.cookie })],
  ];
  for (const [label, pending] of bad) isNotFound(await pending, label);
  for (const state of ["purged", "expired"]) {
    isNotFound(await preview(V.time, W.cA[state], W.pa, "&x=1"), `another parameter (${state})`);
    isNotFound(await api(previewPath({ mappingId: V.distance.mappingId, versionId: V.time.versionId }, `candidateId=${W.cA[state]}`), { cookie: W.pa.cookie }), `a version not of the mapping (${state})`);
  }
  const upper = ok(await preview(V.time, W.cA.ok.toUpperCase(), W.pa));
  assert.equal(upper.preview.candidateId, W.cA.ok);
});

test("4. who may: the platform workspace over any club's candidate (system mappings); club A's workspace - its admin and a platform admin there - over every team of club A, with system mappings and club A's own; club B's admin over its own", async () => {
  for (const [label, v, c, who] of [
    ["platform workspace, club A", V.time, W.cA.ok, W.pa],
    ["platform workspace, club B", V.time, W.cB.ok, W.pa],
    ["club A's admin, a system mapping", V.time, W.cA.ok, W.caA],
    ["club A's admin, another team of club A", V.time, W.cA2, W.caA],
    ["club A's admin, club A's mapping", V.clubA, W.cA.ok, W.caA],
    ["a platform admin in club A's workspace, a system mapping", V.time, W.cA.ok, W.paA],
    ["a platform admin in club A's workspace, club A's mapping", V.clubA, W.cA2, W.paA],
    ["club B's admin, club B's mapping", V.clubB, W.cB.ok, W.caB],
    ["an admin of clubs A and B in club B's workspace", V.clubB, W.cB.ok, W.caAB],
  ]) {
    const body = ok(await preview(v, c, who));
    assert.equal(body.preview.levels.session.athletesWithValue, 3, label);
  }
});

test("5. the order of the 409s: snapshot_expired (purged, expired) before candidate_too_large before candidate_source_mismatch before source_metric_unsupported / parameters_unsupported before candidate_not_importable; each names its code only", async () => {
  assert.deepEqual(refused(await preview(V.time, W.cA.purged, W.pa), 409, "snapshot_expired").current, { reason: "purged" });
  assert.deepEqual(refused(await preview(V.time, W.cA.expired, W.caA), 409, "snapshot_expired").current, { reason: "expired" });
  // An oversized bundle: expired wins over the size, the size over the family.
  const pad = (id) => k.query(`update training_load.gpexe_import_candidates set raw_bundle = raw_bundle || jsonb_build_object('pad', repeat('a', $2::int)) where id = $1`, [id, MAX_BYTES]);
  const bigExpired = await candidate(W.tA, { state: "expired" });
  await pad(bigExpired);
  assert.deepEqual(refused(await preview(V.time, bigExpired, W.pa), 409, "snapshot_expired").current, { reason: "expired" });
  const bigLegacy = await candidate(W.tL);
  await pad(bigLegacy);
  refused(await preview(V.time, bigLegacy, W.pa), 409, "candidate_too_large");
  // The family: a legacy_env candidate and an e03 (api) candidate, with a
  // supported version; and with a version of a field the registry does not read.
  refused(await preview(V.time, W.cL, W.pa), 409, "candidate_source_mismatch");
  refused(await preview(V.time, W.cE, W.caA), 409, "candidate_source_mismatch");
  const unsupported = await synthetic();
  const vUnsupported = await (async () => {
    setExtractorFallbackForTests(() => SYNTHETIC);
    try { return await version(unsupported, { unit: "s" }); } finally { setExtractorFallbackForTests(null); }
  })();
  refused(await preview(vUnsupported, W.cL, W.pa), 409, "candidate_source_mismatch");
  // The registry before the mapper: a session the import refuses (MATCH), with
  // a field the registry does not read, then with parameters its entry refuses.
  const match = await candidate(W.tA, { bundle: previewBundle({ gpexeTeamId: Number(W.tA.sourceTeamId), category: "MATCH" }) });
  refused(await preview(vUnsupported, match, W.pa), 409, "source_metric_unsupported");
  refused(await preview(vUnsupported, W.cA.ok, W.pa), 409, "source_metric_unsupported");
  // An api-family field over an e03 candidate: the same family, so no mismatch; no entry.
  const apiField = await synthetic({ apiFamily: "api" });
  const vApi = await (async () => {
    setExtractorFallbackForTests(() => SYNTHETIC);
    try { return await version(apiField, { unit: "s" }); } finally { setExtractorFallbackForTests(null); }
  })();
  refused(await preview(vApi, W.cE, W.pa), 409, "source_metric_unsupported");
  refused(await preview(vApi, W.cA.ok, W.pa), 409, "candidate_source_mismatch");
  // parameters_unsupported: a zone version made "before 7f" with an operator the
  // closed-power entry refuses, read by that entry for the synthetic key.
  const z = await synthetic({ valueShape: "zone_distance", parameterKind: "zone_bounds", unit: "m", boundUnit: "W/kg", operator: ">=" });
  const vz = await (async () => {
    setExtractorFallbackForTests(() => SYNTHETIC);
    try { return await version(z, { unit: "m", condition: { kind: "zone", operator: ">=", value: "75", unit: "W/kg" }, sourceParameters: { lower: "75", upper: null } }); } finally { setExtractorFallbackForTests(null); }
  })();
  setExtractorFallbackForTests(() => EXTRACTORS["gpexe/rest_v1/more.complementary_data.power.distance"]);
  try {
    refused(await preview(vz, match, W.pa), 409, "parameters_unsupported");
  } finally {
    setExtractorFallbackForTests(null);
  }
  // The mapper's refusal last, with its stable code only.
  const notImportable = refused(await preview(V.time, match, W.pa), 409, "candidate_not_importable");
  assert.deepEqual(Object.keys(notImportable).sort(), ["current", "error", "message"]);
  assert.deepEqual(notImportable.current, { reason: "unsupported_category" });
  const invalid = previewBundle({ gpexeTeamId: Number(W.tA.sourceTeamId) });
  invalid.teamSession.is_stats_valid = false;
  assert.deepEqual(refused(await preview(V.time, await candidate(W.tA, { bundle: invalid }), W.caA), 409, "candidate_not_importable").current, { reason: "session_stats_invalid" });
  const allLeftOut = await candidate(W.tA, { bundle: previewBundle({ gpexeTeamId: Number(W.tA.sourceTeamId), athletes: previewAthletes().slice(3) }) });
  assert.deepEqual(refused(await preview(V.time, allLeftOut, W.pa), 409, "candidate_not_importable").current, { reason: "no_importable_participants" });
});

// Today's specs, their versions here, and the spec's own conversion of the raw value.
const SPEC_OF = [
  ["gpexe_time_min", "time", (raw) => raw / 60],
  ["gpexe_total_distance", "distance", (raw) => raw],
  ["gpexe_power_zone_25_60_distance", "p2560", (raw) => raw],
  ["gpexe_power_zone_60_75_distance", "p6075", (raw) => raw],
  ["gpexe_power_zone_75_plus_distance", "p75", (raw) => raw],
  ["gpexe_acceleration_events", "acc", (raw) => raw],
  ["gpexe_deceleration_events", "dec", (raw) => raw],
  ["gpexe_sprint_distance_7mps", "sprint", (raw) => raw],
  ["gpexe_burst_events", "burst", (raw) => raw],
  ["gpexe_brake_events", "brake", (raw) => raw],
  ["gpexe_max_speed", "maxV", (raw) => raw * 3.6],
];

test("6. the values are the ones today's import takes: for every spec of today's mapper with its own bounds (ten fields, eleven versions), the count of athletes with a value per level and min / max equal today's plan for the same session (the athlete on two tracks left out, a drill athlete counted once); every canonical min and max passes the database's own D8 check, and fails it one unit away", async () => {
  const bundle = previewBundle({ gpexeTeamId: Number(W.tA.sourceTeamId) });
  const today = buildGpexeImportPlan(bundle);
  for (const [specKey, name, convert] of SPEC_OF) {
    const body = ok(await preview(V[name], W.cA.ok, W.caA)).preview;
    const factors = await one(`select scale, scale_divisor, "offset" from training_load.source_metric_mapping_versions where id = $1`, [V[name].versionId]);
    for (const [level, planLevel] of [["session", "full"], ["drill", "drill"]]) {
      const perAthlete = today.participants.map((p) => p.results.filter((x) => x.level === planLevel).flatMap((x) => x.values.filter((v) => v.metricKey === specKey).map((v) => v.value)));
      const all = perAthlete.flat();
      const got = body.levels[level];
      assert.equal(got.athletesWithValue, perAthlete.filter((list) => list.length > 0).length, `${specKey} ${level}`);
      assert.equal(convert(Number(got.min)), Math.min(...all), `${specKey} ${level} min`);
      assert.equal(convert(Number(got.max)), Math.max(...all), `${specKey} ${level} max`);
      for (const [source, canonical] of [[got.min, got.minCanonical], [got.max, got.maxCanonical]]) {
        const matches = await one(
          `select training_load.source_metric_value_matches($1::numeric, $2::numeric, $3, $4, $5) as exact,
                  training_load.source_metric_value_matches($1::numeric, $2::numeric + 0.000000001, $3, $4, $5) as above,
                  training_load.source_metric_value_matches($1::numeric, $2::numeric - 0.000000001, $3, $4, $5) as below`,
          [source, canonical, factors.scale, factors.scale_divisor, factors.offset]);
        assert.deepEqual(matches, { exact: true, above: false, below: false }, `${specKey} ${level} ${source} -> ${canonical}`);
      }
    }
  }
  // The drill level counts athletes, not drills: athlete 1 has two.
  assert.equal(today.participants[0].results.filter((x) => x.level === "drill").length, 2);
});

test("7. the minimum count, a level the version does not apply to, a count of 0, and the conversion at the 10th place (s -> min and m/s -> km/h, half away from zero)", async () => {
  // Two athletes the import keeps: the count only.
  const two = await candidate(W.tA, { bundle: previewBundle({ gpexeTeamId: Number(W.tA.sourceTeamId), athletes: [previewAthletes()[0], previewAthletes()[1], previewAthletes()[3]] }) });
  const twoBody = ok(await preview(V.time, two, W.pa)).preview;
  for (const level of ["session", "drill"]) assert.deepEqual(twoBody.levels[level], { athletesWithValue: 2, min: null, max: null, minCanonical: null, maxCanonical: null }, level);
  // Three: everything (test 1). A version that does not apply to drills.
  assert.deepEqual(ok(await preview(V.timeSessionOnly, W.cA.ok, W.pa)).preview.levels,
    { session: { athletesWithValue: 3, min: "60.00000003", max: "1800", minCanonical: "1.000000001", maxCanonical: "30" }, drill: null });
  // Bounds that fit no team threshold: 0 at both levels, an answer.
  assert.deepEqual(ok(await preview(V.p2255, W.cA.ok, W.pa)).preview.levels, {
    session: { athletesWithValue: 0, min: null, max: null, minCanonical: null, maxCanonical: null },
    drill: { athletesWithValue: 0, min: null, max: null, minCanonical: null, maxCanonical: null },
  });
  // m/s -> km/h: 1.000000001 x 3.6 = 3.6000000036.
  const max = ok(await preview(V.maxV, W.cA.ok, W.pa)).preview;
  assert.deepEqual([max.sourceUnit, max.targetUnit], ["m/s", "km/h"]);
  assert.deepEqual(max.levels.session, { athletesWithValue: 3, min: "1.000000001", max: "8.1", minCanonical: "3.600000004", maxCanonical: "29.16" });
});

// Every row any statement of the requests made by `fn` returns, recorded
// (pool.query checks out with a callback: that form is passed through).
async function recordRows(fn) {
  const seen = [];
  const original = appPool.connect;
  const wrapped = [];
  appPool.connect = function connect(...args) {
    if (typeof args[args.length - 1] === "function") return original.apply(this, args);
    return original.apply(this, args).then((client) => {
      const query = client.query;
      client.query = async function q(...qa) {
        const result = await query.apply(this, qa);
        for (const row of result?.rows ?? []) seen.push(row);
        return result;
      };
      wrapped.push([client, query]);
      return client;
    });
  };
  try {
    await fn();
  } finally {
    appPool.connect = original;
    for (const [client, query] of wrapped) client.query = query;
  }
  return seen;
}
const textBytes = async (id) => (await one(`select octet_length(raw_bundle::text)::int as n from training_load.gpexe_import_candidates where id = $1`, [id])).n;
// Pads a candidate's stored bundle to exactly `bytes` of text (an extra key the mapper never reads).
async function padTo(id, bytes) {
  const pad = (n) => k.query(`update training_load.gpexe_import_candidates set raw_bundle = raw_bundle || jsonb_build_object('pad', repeat('a', $2::int)) where id = $1`, [id, n]);
  await pad(1000);
  await pad(bytes - (await textBytes(id) - 1000));
  assert.equal(await textBytes(id), bytes);
}

test("8. the size bound (R7) measures the uncompressed text and is decided once: a bundle whose stored size is under 16 MiB but whose text is over it is 409 candidate_too_large and no row the database returns carries it; exactly 16 MiB of text is previewed, one byte more is refused", async () => {
  const big = await candidate(W.tA);
  await k.query(`update training_load.gpexe_import_candidates set raw_bundle = raw_bundle || jsonb_build_object('pad', repeat('a', $2::int)) where id = $1`, [big, MAX_BYTES]);
  const premise = await one(`select octet_length(raw_bundle::text) as text_bytes, pg_column_size(raw_bundle) as stored_bytes from training_load.gpexe_import_candidates where id = $1`, [big]);
  assert.ok(premise.text_bytes > MAX_BYTES && premise.stored_bytes < MAX_BYTES, JSON.stringify(premise));
  const seen = await recordRows(async () => {
    const res = await preview(V.time, big, W.pa);
    refused(res, 409, "candidate_too_large");
    assert.ok(res.text.length < 400);
  });
  const withBundle = seen.filter((row) => Object.hasOwn(row, "raw_bundle"));
  assert.equal(withBundle.length, 1, "the candidate statement ran");
  assert.equal(withBundle[0].raw_bundle, null, "the bundle never left the database");
  assert.equal(withBundle[0].too_large, true);
  // The boundary: exactly the bound is read and previewed; one byte more is refused.
  const exact = await candidate(W.tA);
  await padTo(exact, MAX_BYTES);
  assert.equal(ok(await preview(V.time, exact, W.pa)).preview.levels.session.athletesWithValue, 3);
  const over = await candidate(W.tA);
  await padTo(over, MAX_BYTES + 1);
  refused(await preview(V.time, over, W.pa), 409, "candidate_too_large");
  // Under the bound, the same statement returns it.
  const small = await candidate(W.tA);
  const seenSmall = await recordRows(async () => { ok(await preview(V.time, small, W.pa)); });
  const row = seenSmall.find((r) => Object.hasOwn(r, "raw_bundle"));
  assert.equal(typeof row.raw_bundle, "object");
  assert.equal(row.too_large, false);
});

test("9. the preview reads any stored status (no status gate): a superseded candidate is previewed; nothing is written by any preview (no candidate, check, version or audit row changes)", async () => {
  const counts = async () => one(
    `select (select count(*)::int from training_load.source_metric_audit) as audit,
            (select count(*)::int from training_load.source_metric_mapping_versions) as versions,
            (select count(*)::int from training_load.gpexe_import_checks) as checks,
            (select md5(string_agg(id::text || status || coalesce(raw_purged_at::text, '') || raw_expires_at::text || md5(coalesce(raw_bundle::text, '')), ',' order by id)) from training_load.gpexe_import_candidates) as candidates`);
  const superseded = await candidate(W.tA);
  const by = await check(W.tA);
  await k.query(`update training_load.gpexe_import_candidates set status = 'superseded', superseded_by_check_id = $2 where id = $1`, [superseded, by]);
  const before = await counts();
  ok(await preview(V.time, superseded, W.pa));
  ok(await preview(V.acc, W.cA.ok, W.caA));
  refused(await preview(V.time, W.cA.purged, W.pa), 409, "snapshot_expired");
  isNotFound(await preview(V.time, W.cB.ok, W.caA), "out of scope");
  assert.deepEqual(await counts(), before);
});

test("10. the service decides the audience too: a context outside 7d's audience is the 404 before any read, whatever the route gate does; it reads exactly one candidateId from the raw query string", async () => {
  const one_ = `candidateId=${W.cA.ok}`;
  for (const ctx of [
    null,
    { userId: W.coachA.id, basis: "team_coach", owner: { scope: "club", clubId: W.clubA } },
    { userId: W.caA.id, basis: "club_admin", owner: { scope: "system", clubId: null } },
  ]) {
    await assert.rejects(previews.previewVersion({ ctx, mappingId: V.time.mappingId, versionId: V.time.versionId, queryString: one_ }), (e) => e.status === 404, JSON.stringify(ctx));
  }
  const ctx = { userId: W.pa.id, basis: "platform_admin", owner: { scope: "system", clubId: null } };
  for (const queryString of [`${one_}&${one_}`, `candidateId[x]=${W.cA.ok}`, "", undefined, null, `${one_}&y=1`, `${one_}&constructor=1`, `${one_}&__proto__=1`, `candidateId=${W.cA.ok}x`]) {
    await assert.rejects(previews.previewVersion({ ctx, mappingId: V.time.mappingId, versionId: V.time.versionId, queryString }), (e) => e.status === 404, JSON.stringify(queryString));
  }
  const body = await previews.previewVersion({ ctx, mappingId: V.time.mappingId, versionId: V.time.versionId, queryString: one_ });
  assert.equal(body.preview.levels.session.athletesWithValue, 3);
});

test("11. architecture: the preview service writes nothing, resolves no workspace of its own, never names the check staging table or a stored details read, and is reached from the routes only through its own module", () => {
  const service = fs.readFileSync(path.join(SRC, "sourceMetricPreviewService.js"), "utf8");
  const pure = fs.readFileSync(path.join(SRC, "sourceMetricPreview.js"), "utf8");
  for (const text of [service, pure]) {
    assert.doesNotMatch(text, /\b(insert\s+into|update\s+[a-z_.]+\s+set|delete\s+from|truncate)\b/i);
    assert.doesNotMatch(text, /\b(resolveGpexeTeamAccess|resolveActiveWorkspace|runWrite|rightsStillHold)\b/);
    assert.doesNotMatch(text, /gpexe_import_check_observations|complementary_data|_events_count|\bdetails\??\.(full|drills|players)\b/);
  }
  assert.doesNotMatch(pure, /from "\.\/db\.js"|from "pg"|sourceMetricMappingService/);
  // One statement decides the candidate's scope (J11 section 2.5).
  assert.equal((service.match(/from training_load\.gpexe_import_candidates/g) || []).length, 1);
  assert.match(service, /with scoped as materialized \(/);
  // The two fences: the scope before anything is measured, the size evaluated once.
  assert.equal((service.match(/ offset 0\) (sz|b)\b/g) || []).length, 2);
  // The route hands the service the raw query string, never Express's parsed req.query.
  const routes = fs.readFileSync(path.join(SRC, "routes/sourceMetrics.js"), "utf8");
  assert.match(routes, /router\.get\("\/mappings\/:mappingId\/versions\/:versionId\/preview"/);
  assert.match(routes, /import \* as previews from "\.\.\/sourceMetricPreviewService\.js";/);
  const route = routes.slice(routes.indexOf('router.get("/mappings/:mappingId/versions/:versionId/preview"'));
  const body = route.slice(0, route.indexOf("\n}));"));
  assert.match(body, /previewVersion\(\{ ctx, mappingId: req\.params\.mappingId, versionId: req\.params\.versionId, queryString \}\)/);
  assert.doesNotMatch(body, /req\.query/);
});

test("13. a refusal of the family or of the registry is answered without reading the bundle out of the database", async () => {
  // The family: a legacy_env candidate and an e03 (api) candidate.
  for (const c of [W.cL, W.cE]) {
    const seenFamily = await recordRows(async () => { refused(await preview(V.time, c, W.pa), 409, "candidate_source_mismatch"); });
    const row = seenFamily.find((r) => Object.hasOwn(r, "raw_bundle"));
    assert.equal(row.raw_bundle, null, "the bundle never left the database");
  }
  // The registry: decided from the version row alone.
  const f = await synthetic();
  setExtractorFallbackForTests(() => SYNTHETIC);
  let v;
  try { v = await version(f, { unit: "s" }); } finally { setExtractorFallbackForTests(null); }
  const seen = await recordRows(async () => { refused(await preview(v, W.cA.ok, W.pa), 409, "source_metric_unsupported"); });
  const rows = seen.filter((row) => Object.hasOwn(row, "raw_bundle"));
  assert.equal(rows.length, 1, "the candidate statement ran");
  assert.equal(rows[0].raw_bundle, null, "the bundle never left the database");
  assert.equal(rows[0].too_large, false);
  // The same candidate with a version the registry reads: the bundle is read.
  const seenOk = await recordRows(async () => { ok(await preview(V.time, W.cA.ok, W.pa)); });
  assert.equal(typeof seenOk.find((row) => Object.hasOwn(row, "raw_bundle")).raw_bundle, "object");
});

test("14. R6: the candidate's scope is its team's current club, not the club of the connection it was read through: a team moved to club B (its binding ended first) takes its candidates to club B's admin, and club A's admin gets the identical 404 before snapshot_expired", async () => {
  const tM = await gpexeTeam(W.clubA);
  const cM = await candidates(tM);
  ok(await preview(V.time, cM.ok, W.caA));
  isNotFound(await preview(V.time, cM.ok, W.caB), "club B before the move");
  await k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'Test unbind.' where id = $1`, [tM.bindingId, W.pa.id]);
  await k.query(`update public.teams set club_id = $2 where id = $1`, [tM.teamId, W.clubB]);
  for (const state of ["ok", "purged", "expired"]) isNotFound(await preview(V.time, cM[state], W.caA), `club A after the move (${state})`);
  assert.equal(ok(await preview(V.time, cM.ok, W.caB)).preview.levels.session.athletesWithValue, 3);
  assert.deepEqual(refused(await preview(V.time, cM.purged, W.caB), 409, "snapshot_expired").current, { reason: "purged" });
  assert.deepEqual(refused(await preview(V.time, cM.expired, W.caB), 409, "snapshot_expired").current, { reason: "expired" });
  ok(await preview(V.time, cM.ok, W.pa));
  // The club mapping follows the workspace, not the team: club B's admin over club B's mapping.
  ok(await preview(V.clubB, cM.ok, W.caB));
  isNotFound(await preview(V.clubA, cM.ok, W.caB), "club A's mapping in club B's workspace");
});

test("12. no preview answer and no log line of this suite carries an athlete, track or session id, a raw key of the bundle, a stack or a database text; no answer at all carries an id of the bundle", () => {
  const needles = [PLANTED.athletePrefix, PLANTED.trackPrefix, String(PLANTED.sessionId), "athleteSessions", "teamThresholds", "complementary_data",
    "athletesession_id", "tot_burst_events", "power_thresholds", "raw_bundle", "gpexe_import_candidates", "violates"];
  assert.ok(previewResponses.length > 100, `${previewResponses.length} preview answers scanned`);
  for (const text of previewResponses) {
    for (const needle of needles) assert.ok(!text.includes(needle), `an answer carries ${needle}: ${text.slice(0, 200)}`);
    assert.doesNotMatch(text, /at [a-zA-Z]+ \(|error: /, text.slice(0, 200));
  }
  for (const line of logLines) {
    for (const needle of needles) assert.ok(!line.includes(needle), `a log line carries ${needle}: ${line.slice(0, 200)}`);
  }
  // The other answers (the M3-0 and M2 writes of the fixtures) name catalog keys, never the bundle's ids.
  for (const text of responses) {
    for (const needle of [PLANTED.athletePrefix, PLANTED.trackPrefix, String(PLANTED.sessionId)]) assert.ok(!text.includes(needle), `an answer carries ${needle}`);
  }
});

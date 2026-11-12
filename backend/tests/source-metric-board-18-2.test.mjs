// J18, slice 18-2 - the reads of the drag-and-drop board: the board of a team
// (route 1), one placement (route 2) and the stored confirmations (routes 4
// and 5). Contract: docs/ai/c112-drag-mapping-contract.md, sections 3.3-3.6,
// 4.1, 4.2, 6, 9.2 (items 11-13 and 16) and 15.
// Through the real HTTP stack on one disposable optimove_tests_gpexe_*
// database (never OPTIMOVE, never a real GPEXE field, connection or athlete).
// The columns are synthetic test fields that read through the registry's real
// extractors and display rules; the stored session is a synthetic bundle in
// the form the rest_v1 path stores it; the athletes are invented.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN } from "./_gpexe-disposable-db.mjs";
import { writeRevision } from "./support/source-revisions.mjs";
import { PLANTED, previewBundle } from "./support/preview-bundles.mjs";
import { EXTRACTORS, setExtractorFallbackForTests } from "../src/sourceMetricExtractors.js";
import { setDisplayRuleFallbackForTests } from "../src/sourceMetricBoard.js";
import { convertAtStorageScale } from "../src/sourceMetricPreview.js";

// A synthetic key "board.test.<kind>.<id>" reads through the real entry of its kind.
const REAL = { time: "athlete_session.total_time", dist: "athlete_session.total_distance", speed: "athlete_session.max_v", burst: "details.players.tot_burst_events", zone: "more.complementary_data.power.distance" };
const kindOf = (key) => key.split(".")[2];
setExtractorFallbackForTests(({ sourceMetricKey }) => (REAL[kindOf(sourceMetricKey)] ? EXTRACTORS[`gpexe/rest_v1/${REAL[kindOf(sourceMetricKey)]}`] : null));
setDisplayRuleFallbackForTests(({ sourceMetricKey }) => ({ time: "duration_mmss", dist: "distance_m", speed: "speed_kmh" })[kindOf(sourceMetricKey)] ?? null);

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = "/api/training-load/sources/metrics";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const T5 = "training_load.source_metric_mapping_activations";
const T8 = "training_load.source_metric_audit";
const T9 = "training_load.source_metric_confirmations";
const T9S = "training_load.source_metric_confirmation_sessions";
const T9I = "training_load.source_metric_confirmation_items";
const ATHLETE = (n) => `${PLANTED.athletePrefix}${String(n).padStart(2, "0")}`;
const NAMES = { 1: "Board Athlete One", 2: "Board Athlete Two", 3: "Board Athlete Three" };

let db, k, server, apiBase, appPool, createSession, boardService;
const W = {};
const responses = [];
const logLines = [];
const originalConsole = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "board182" });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => { logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  }
  const serverModule = await import("../src/server.js");
  const dbModule = await import("../src/db.js");
  boardService = await import("../src/sourceMetricBoardService.js");
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
  await k?.end().catch(() => {});
  await db?.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (sql, params = []) => (await k.query(sql, params)).rows;
const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
const key = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString("hex");

async function api(p, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${PREFIX}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  responses.push(text);
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text, cache: res.headers.get("cache-control") };
}
const get = (p, who) => api(p, { cookie: who?.cookie });
const post = (p, who, body) => api(p, { method: "POST", cookie: who.cookie, body });
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const refused = (res, status, code) => { assert.deepEqual([res.status, res.body.error], [status, code], res.text); return res.body; };
const shape = (res) => ({ status: res.status, body: res.body, cache: res.cache });
const NOT_FOUND = { status: 404, body: { error: "notFound" }, cache: "no-store" };
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("&");
const boardOf = (who, t, extra = {}) => get(`/board?${qs({ teamId: t.teamId, ...extra })}`, who);
const placement = (who, t, candidateId, field, target, pair = 0) => get(`/board/placement?${qs({ teamId: t.teamId, candidateId, pair, fieldId: field.fieldId ?? field, targetId: target.id ?? target })}`, who);

async function user(label) {
  return (await one(`insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,true) returning id`, [`${label}-${uid()}@test.local`, label])).id;
}
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
async function platformAdmin(ws = ["platform", null], label = "platform-admin") {
  const id = await user(label);
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  if (ws[0] === "club") await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, ws[1]]);
  await workspace(id, ws[0], ws[1]);
  return { id, basis: "platform_admin", cookie: await cookieFor(id) };
}
async function clubAdmin(clubId, label = "Club Admin Person") {
  const id = await user(label);
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await workspace(id, "club", clubId);
  return { id, basis: "club_admin", clubId, cookie: await cookieFor(id) };
}
const club = async (name) => (await one(`insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;

const connectionOf = new Map();
let gpexeTeamCounter = 0;
async function connection(clubId) {
  if (!connectionOf.has(clubId)) {
    connectionOf.set(clubId, (await one(
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                                credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','club',$1,'server3','18-2 test','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
      [clubId, W.pa.id, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id);
  }
  return connectionOf.get(clubId);
}
// A team of the club; bound to the club's connection unless told otherwise.
async function gpexeTeam(clubId, { bound = true, name = `Team ${uid()}` } = {}) {
  const teamId = (await one(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, name])).id;
  gpexeTeamCounter += 1;
  const sourceTeamId = String(975000 + gpexeTeamCounter);
  await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)`, [teamId, sourceTeamId, W.pa.id]);
  if (!bound) return { teamId, clubId, sourceTeamId, bindingId: null, connectionId: null, name };
  const connectionId = await connection(clubId);
  const bindingId = (await one(
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
     values ($1,$2,'gpexe',$3,$4,$1) returning id`, [teamId, connectionId, sourceTeamId, W.pa.id])).id;
  return { teamId, clubId, sourceTeamId, bindingId, connectionId, name };
}
async function check(t, { via = t } = {}) {
  return (await one(
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id,
                                                    source_path, source_connection_id, source_binding_id, source_team_id, source_host_key)
     values ($1,$2,'succeeded','2026-09-14','2026-09-14', now(), $3, 'source_connection', $4, $5, $3, 'server3') returning id`,
    [t.teamId, W.pa.id, via.sourceTeamId, via.connectionId, via.bindingId])).id;
}
let sessionCounter = 0;
// A stored session of the team. state: "available" | "purged" | "expired".
async function candidate(t, { state = "available", startedAt = "2026-09-14T18:08:12Z", checkId = null, athletes = undefined } = {}) {
  sessionCounter += 1;
  const c = checkId ?? await check(t);
  const purged = state === "purged";
  const bundle = previewBundle({ gpexeTeamId: Number(t.sourceTeamId), ...(athletes ? { athletes } : {}) });
  const row = await one(
    `insert into training_load.gpexe_import_candidates (owner_team_id, gpexe_team_session_id, session_started_at, session_label, bundle_hash,
                                                        raw_bundle, raw_purged_at, raw_expires_at, status, first_seen_check_id, last_seen_check_id, drill_parameter_effect)
     values ($1, $2, $3, 'Board session', $4, $5::jsonb, $6, now() + ($7 || ' minutes')::interval, 'pending', $8, $8, 'confirmed')
     returning id, gpexe_team_session_id, bundle_hash, session_started_at`,
    [t.teamId, String(48000000 + sessionCounter), startedAt, hash(), purged ? null : JSON.stringify(bundle), purged ? new Date() : null,
      state === "available" ? String(30 * 24 * 60) : "-1", c]);
  return { ...row, checkId: c };
}
// The team's athletes OptiMove can name: an OptiMove athlete linked to each GPEXE athlete number.
async function link(t, n, name = NAMES[n]) {
  const athleteId = (await one(`insert into public.athletes (full_name, display_name, device_timezone) values ($1,$1,'Europe/Sarajevo') returning id`, [name])).id;
  await k.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athleteId, t.clubId, t.teamId]);
  await k.query(`insert into training_load.gpexe_athlete_links (owner_team_id, gpexe_athlete_id, athlete_id, linked_by_user_id) values ($1,$2,$3,$4)`, [t.teamId, ATHLETE(n), athleteId, W.pa.id]);
}
async function variable(owner, { unit = "min", minValue = undefined, maxValue = undefined, label = `Variable ${uid()}`, levels = ["session", "drill"], condition = undefined } = {}) {
  const res = await post("/variables", owner, { requestKey: key(), label, unit, levels, dailyAggregationMethod: "sum", ...(condition === undefined ? {} : { condition }), ...(minValue === undefined ? {} : { minValue }), ...(maxValue === undefined ? {} : { maxValue }) });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.variable.id, label };
}
// A synthetic field of gpexe / rest_v1 that reads like the real column of its kind.
async function field(kind, { unit = { time: "s", dist: "m", speed: "m/s", burst: "number", zone: "m" }[kind], verified = true, label = `Column ${kind} ${uid()}`, valueShape = { burst: "unit_value_object", zone: "zone_distance" }[kind] ?? "number", parameterKind = kind === "zone" ? "zone_bounds" : "none" } = {}) {
  const fieldId = (await one(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,$2,$3) returning id`,
    [`board.test.${kind}.f${uid()}`, label, W.pa.id])).id;
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape, parameterKind, evidenceRef: COMPAT, unit, ...(parameterKind === "zone_bounds" ? { boundUnit: "W/kg", operator: "between" } : {}), unitRef: UNIT_REF, meaning: verified, meaningRef: verified ? MEANING_REF : undefined, state: "active" });
  return { fieldId, revId, label };
}
// An active mapping version through the real routes, by `owner`.
async function activeVersion(owner, f, target, { activate = true, drill = true } = {}) {
  const m = await post("/mappings", owner, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id });
  assert.equal(m.status, 201, m.text);
  const mappingId = m.body.mapping.id;
  const v = await post(`/mappings/${mappingId}/versions`, owner, { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: drill, conversionNote: "Converted by the active unit conversion." });
  assert.equal(v.status, 201, v.text);
  const versionId = v.body.version.id;
  ok(await post(`/mappings/${mappingId}/versions/${versionId}/submit`, owner, { requestKey: key() }));
  if (activate) ok(await post(`/mappings/${mappingId}/versions/${versionId}/activate`, owner, { requestKey: key(), expectedActiveVersionId: null }));
  return { mappingId, versionId, ...f, target };
}
const start = (who, v, t, requirement = "required") => post("/activations", who, { requestKey: key(), mappingId: v.mappingId, versionId: v.versionId, bindings: [{ bindingId: t.bindingId, requirement }], reason: `Start ${uid()}.` });
const end = (who, activationId) => post(`/activations/${activationId}/end`, who, { requestKey: key(), expectedState: "open", reason: `End ${uid()}.` });
const openOn = (v, t) => one(`select id from ${T5} where mapping_version_id = $1 and source_team_binding_id = $2 and ended_at is null`, [v.versionId, t.bindingId]);

// A confirmation written as raw SQL in the order of section 4.3 step 16 (18-3 writes it for real).
async function confirm(actor, t, cand, items) {
  const operationId = crypto.randomUUID();
  await k.query("begin");
  try {
    await k.query(CTX, [actor.id]);
    for (const it of items) {
      const row = await one(`select * from training_load.source_metric_mapping_versions where id = $1`, [it.v.versionId]);
      it.row = row;
      const id = (await one(`insert into ${T5} (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint, source_team_binding_id, team_id,
                                 applies_to_session, applies_to_drill, requirement, activated_by_user_id, activated_basis, reason)
                               values ($1,$2,$3,$4,$5,$6,$7,true,true,'required',$8,$9,'Switched on by drag and drop; two athletes checked in GPEXE.') returning id`,
      [it.v.versionId, it.v.mappingId, row.source_metric_definition_id, row.metric_definition_id, row.parameter_fingerprint, t.bindingId, t.teamId, actor.id, actor.basis])).id;
      await k.query(`insert into ${T8} (action, mapping_version_id, activation_id, team_id, reason, performed_by_user_id, basis, operation_id)
                     values ('activation_start',$1,$2,$3,'Switched on by drag and drop; two athletes checked in GPEXE.',$4,$5,$6)`, [it.v.versionId, id, t.teamId, actor.id, actor.basis, operationId]);
    }
    const confId = (await one(`insert into ${T9} (operation_id, kind, owner_scope, owner_club_id, binding_id, team_id, credential_connection_id, confirmed_by_user_id, confirmed_basis, confirmed_at, attested, display_registry_version, values_expire_at)
                                values ($1,'team_mapping','club',$2,$3,$4,$5,$6,$7,now(),$8,1,now()) returning id`,
    [operationId, t.clubId, t.bindingId, t.teamId, t.connectionId, actor.id, actor.basis, items.some((it) => it.checked)])).id;
    await k.query(`insert into ${T9S} (confirmation_id, session_ordinal, candidate_id, candidate_bundle_hash, gpexe_team_session_id, session_started_at, check_id, team_id, pair_index)
                   values ($1,1,$2,$3,$4,$5,$6,$7,0)`, [confId, cand.id, cand.bundle_hash, cand.gpexe_team_session_id, cand.session_started_at, cand.checkId, t.teamId]);
    let n = 0;
    for (const it of items) {
      n += 1;
      await k.query(`insert into ${T9I} (confirmation_id, session_ordinal, item_no, item_kind, checked, source_metric_version_id, mapping_version_id, parameter_fingerprint, source_unit, target_unit,
                       scale, scale_divisor, "offset", compared_level, gpexe_display_rule, gpexe_display_unit, raw_a, stored_a, raw_b, stored_b)
                     values ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'session',$13,$14,$15,$16,$17,$18)`,
      [confId, n, it.kind ?? "club_mapping", it.checked, it.row.source_metric_version_id, it.v.versionId, it.row.parameter_fingerprint, it.row.source_unit, it.row.target_unit,
        it.row.scale, it.row.scale_divisor, it.row.offset, it.checked ? "duration_mmss" : null, it.checked ? "mm:ss" : null,
        it.checked ? "1200" : null, it.checked ? "20" : null, it.checked ? "1800" : null, it.checked ? "30" : null]);
    }
    await k.query(`insert into ${T8} (action, team_id, confirmation_id, performed_by_user_id, basis, operation_id, request_key, request_hash) values ('mapping_confirmation',$1,$2,$3,$4,$5,$6,$7)`,
      [t.teamId, confId, actor.id, actor.basis, operationId, key(), hash()]);
    await k.query("commit");
    return confId;
  } catch (error) {
    await k.query("rollback").catch(() => {});
    throw error;
  }
}
async function planted(fn) {
  await k.query("begin");
  try {
    await k.query("set local session_replication_role = replica");
    const value = await fn();
    await k.query("commit");
    return value;
  } catch (error) {
    await k.query("rollback").catch(() => {});
    throw error;
  }
}

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.pa = await platformAdmin();
  W.paA = await platformAdmin(["club", W.clubA]);
  W.caA = await clubAdmin(W.clubA);
  W.caB = await clubAdmin(W.clubB);
  W.tA = await gpexeTeam(W.clubA, { name: "First Team A" });
  W.tB = await gpexeTeam(W.clubB);
  // A coach of club A's team (team workspace), an athlete, a user with no role.
  W.coach = { id: await user("coach") };
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [W.coach.id, W.tA.teamId]);
  await workspace(W.coach.id, "team", W.tA.teamId);
  W.coach.cookie = await cookieFor(W.coach.id);
  W.plain = { id: await user("no-role") };
  await workspace(W.plain.id, "platform", null);
  W.plain.cookie = await cookieFor(W.plain.id);
  for (const n of [1, 2, 3]) await link(W.tA, n);
  W.cA = await candidate(W.tA);
  W.cB = await candidate(W.tB);
  // The columns: three that can be placed, and one of each kind that cannot.
  W.fTime = await field("time");
  W.fDist = await field("dist");
  W.fSpeed = await field("speed");
  W.fUnverified = await field("time", { verified: false });
  W.fBurst = await field("burst");
  W.fZone = await field("zone");
  W.fNoReader = await field("other");
  // Club A's variables, club B's variable, OptiMove's variables.
  W.vMin = await variable(W.caA, { unit: "min", label: "Minutes played" });
  W.vSec = await variable(W.caA, { unit: "s", label: "Seconds played" });
  W.vKmh = await variable(W.caA, { unit: "km/h", label: "Top speed" });
  W.vKg = await variable(W.caA, { unit: "kg", label: "Body mass" });
  W.vSmall = await variable(W.caA, { unit: "min", maxValue: "10", label: "Short minutes" });
  W.vB = await variable(W.caB, { unit: "min", label: "Club B minutes" });
  W.sysMin = await variable(W.pa, { unit: "min", label: "OptiMove minutes" });
  W.sysM = await variable(W.pa, { unit: "m", label: "OptiMove distance" });
  W.sysFree = await variable(W.pa, { unit: "min", label: "OptiMove free minutes" });
  // OptiMove's own mappings of two columns.
  W.sysTime = await activeVersion(W.pa, W.fTime, W.sysMin);
  W.sysDist = await activeVersion(W.pa, W.fDist, W.sysM);
}

const columnOf = (board, f) => board.columns.find((c) => c.fieldId === f.fieldId);
const variableOf = (board, v) => board.variables.find((x) => x.id === v.id);

// ---------------------------------------------------------------------------
// 1. Audience and info-hiding
// ---------------------------------------------------------------------------
test("1. the audience: the club's admin and a platform admin in the club's workspace get the board; everyone and everything else the identical 404 with no-store, before any refusal; only an admitted caller's malformed query is 400", async () => {
  const good = ok(await boardOf(W.caA, W.tA));
  assert.equal(good.board.team.name, "First Team A");
  ok(await boardOf(W.paA, W.tA));
  const placeUrl = `/board/placement?${qs({ teamId: W.tA.teamId, candidateId: W.cA.id, pair: 0, fieldId: W.fTime.fieldId, targetId: W.vMin.id })}`;
  ok(await get(placeUrl, W.caA));
  for (const [label, who] of [["a coach", W.coach], ["no role", W.plain], ["another club's admin", W.caB], ["a platform admin in the platform workspace", W.pa]]) {
    assert.deepEqual(shape(await boardOf(who, W.tA)), NOT_FOUND, `board: ${label}`);
    assert.deepEqual(shape(await get(placeUrl, who)), NOT_FOUND, `placement: ${label}`);
    // Not even a malformed query tells them apart.
    // (Another club's admin is in the audience of their own club's boards, so their malformed query is theirs to hear about.)
    if (who !== W.caB) {
      assert.deepEqual(shape(await get(`/board?teamId=not-a-uuid`, who)), NOT_FOUND, `malformed board: ${label}`);
      assert.deepEqual(shape(await get(`/board/placement?teamId=${W.tA.teamId}`, who)), NOT_FOUND, `malformed placement: ${label}`);
    }
  }
  assert.deepEqual(shape(await boardOf(null, W.tA)).status, 401, "without a login");
  // Inside the audience: a team of another club, an unknown team, an unbound team - one answer.
  const unbound = await gpexeTeam(W.clubA, { bound: false });
  const unknown = { teamId: crypto.randomUUID() };
  for (const [label, t] of [["another club's team", W.tB], ["an unknown team", unknown], ["a team with no GPEXE link", unbound]]) {
    assert.deepEqual(shape(await boardOf(W.caA, t)), NOT_FOUND, label);
    assert.deepEqual(shape(await boardOf(W.caA, t, { candidateId: W.cA.id })), NOT_FOUND, `${label}, with a candidate`);
  }
  // A candidate of another club, an unknown candidate: the identical 404, never a 409 about it.
  for (const candidateId of [W.cB.id, crypto.randomUUID()]) assert.deepEqual(shape(await boardOf(W.caA, W.tA, { candidateId })), NOT_FOUND);
  // A malformed query of an admitted caller.
  for (const bad of ["", "teamId=x", `teamId=${W.tA.teamId}&other=1`, `teamId=${W.tA.teamId}&teamId=${W.tA.teamId}`, `teamId=${W.tA.teamId}&pair=-1`, `teamId=${W.tA.teamId}&pair=1.5`, `teamId=${W.tA.teamId}&candidateId=7`]) {
    const res = await get(`/board?${bad}`, W.caA);
    refused(res, 400, "invalid_query");
    assert.equal(res.cache, "no-store");
  }
  refused(await get(`/board/placement?${qs({ teamId: W.tA.teamId, candidateId: W.cA.id, pair: 0, fieldId: W.fTime.fieldId })}`, W.caA), 400, "invalid_query");
  // An archived team and an archived club are the identical 404.
  const gone = await gpexeTeam(W.clubA);
  await candidate(gone);
  await k.query(`update public.teams set is_active = false where id = $1`, [gone.teamId]);
  assert.deepEqual(shape(await boardOf(W.caA, gone)), NOT_FOUND, "an archived team");
  // An archived club: its own admin and a platform admin in its workspace get the identical 404.
  const clubC = await club("Club C");
  const caC = await clubAdmin(clubC, "Club C Admin");
  const paC = await platformAdmin(["club", clubC]);
  const tC = await gpexeTeam(clubC);
  for (const n of [1, 2]) await link(tC, n, `Club C ${NAMES[n]}`);
  await candidate(tC);
  ok(await boardOf(caC, tC));
  await k.query(`update public.clubs set is_active = false where id = $1`, [clubC]);
  assert.deepEqual(shape(await boardOf(caC, tC)), NOT_FOUND, "an archived club, its admin");
  assert.deepEqual(shape(await boardOf(paC, tC)), NOT_FOUND, "an archived club, a platform admin in its workspace");
  // The two audience rules themselves.
  const ctx = (scope, basis) => ({ owner: { scope, clubId: scope === "club" ? W.clubA : null }, basis });
  assert.deepEqual([["club", "club_admin"], ["club", "platform_admin"], ["system", "platform_admin"], ["club", "team_coach"], ["system", "club_admin"], ["team", "club_admin"]].map(([sc, b]) => [boardService.mayUseBoard(ctx(sc, b)), boardService.mayReadConfirmations(ctx(sc, b))]),
    [[true, true], [true, true], [false, true], [false, false], [false, false], [false, false]]);
  assert.deepEqual([boardService.mayUseBoard(null), boardService.mayReadConfirmations(undefined)], [false, false]);
});

// ---------------------------------------------------------------------------
// 2. The board
// ---------------------------------------------------------------------------
test("2. the board: the columns with their unit state, their reason and two athletes' raw values; the club's variables then OptiMove's; OptiMove's active mappings pre-placed; the pair named live and stable", async () => {
  const { board } = ok(await boardOf(W.caA, W.tA));
  assert.equal(board.displayRegistryVersion, 1);
  assert.deepEqual(board.team, { id: W.tA.teamId, name: "First Team A", sourceTeamId: W.tA.sourceTeamId });
  assert.equal(board.session.candidateId, W.cA.id);
  assert.equal(new Date(board.session.startedAt).toISOString(), "2026-09-14T18:08:12.000Z");
  // The pair: the first two of the three named athletes, in the server's own order.
  assert.deepEqual(board.pair, { index: 0, count: 3, labels: [NAMES[1], NAMES[2]] });
  const time = columnOf(board, W.fTime);
  assert.deepEqual({ unit: time.unit, unitProven: time.unitProven, placeable: time.placeable, reason: time.reason, rule: time.displayRule, units: time.displayUnits, a: time.rawA, b: time.rawB },
    { unit: "s", unitProven: true, placeable: true, reason: null, rule: "duration_mmss", units: ["mm:ss"], a: "60.00000003", b: "1200" });
  assert.deepEqual([columnOf(board, W.fDist).rawA, columnOf(board, W.fDist).rawB, columnOf(board, W.fDist).displayRule], ["2800", "3100", "distance_m"]);
  assert.deepEqual([columnOf(board, W.fSpeed).rawA, columnOf(board, W.fSpeed).rawB, columnOf(board, W.fSpeed).displayRule], ["1.000000001", "6.2", "speed_kmh"]);
  // Why a column cannot be placed.
  const unverified = columnOf(board, W.fUnverified);
  assert.deepEqual([unverified.placeable, unverified.reason, unverified.unitProven, unverified.unit], [false, "field_not_confirmed", false, null], "an unproven unit is never shown as what GPEXE sends");
  assert.deepEqual([columnOf(board, W.fZone).placeable, columnOf(board, W.fZone).reason], [false, "field_has_parameters"]);
  assert.deepEqual([columnOf(board, W.fNoReader).placeable, columnOf(board, W.fNoReader).reason, columnOf(board, W.fNoReader).rawA], [false, "source_metric_unsupported", null]);
  assert.deepEqual([columnOf(board, W.fBurst).placeable, columnOf(board, W.fBurst).reason], [false, "display_rule_missing"]);
  // The seeded GPEXE fields of v34 are there too, observed only.
  assert.ok(board.columns.some((c) => c.key === "athlete_session.total_time" && c.reason === "field_not_confirmed"));
  // The variables: the club's first, then OptiMove's; never another club's.
  const scopes = board.variables.map((v) => v.ownerScope);
  assert.deepEqual(scopes, [...scopes].sort(), "club before system");
  assert.equal(variableOf(board, W.vB), undefined, "another club's variable is not listed");
  assert.deepEqual([variableOf(board, W.vMin).placeable, variableOf(board, W.vMin).unit], [true, "min"]);
  assert.deepEqual([variableOf(board, W.sysMin).placeable, variableOf(board, W.sysMin).filledByFieldIds], [true, [W.fTime.fieldId]]);
  assert.deepEqual([variableOf(board, W.sysFree).placeable, variableOf(board, W.sysFree).filledByFieldIds], [false, []], "an OptiMove variable no column fills");
  // OptiMove's mappings, pre-placed with the two athletes' values (shown, not stored).
  assert.deepEqual(board.on, []);
  const pre = board.preplaced.find((p) => p.mappingVersionId === W.sysTime.versionId);
  assert.deepEqual({ kind: pre.kind, badge: pre.badge, field: pre.fieldId, variable: pre.variableId, conversion: pre.conversion, levels: pre.levels, values: pre.values },
    { kind: "preplaced", badge: "optimove_mapping", field: W.fTime.fieldId, variable: W.sysMin.id, conversion: { kind: "converted", scale: "1", divisor: "60", offset: "0" }, levels: { session: true, drill: true },
      values: { a: { raw: "60.00000003", stored: convertAtStorageScale("60.00000003", { scale: "1", divisor: "60", offset: "0" }) }, b: { raw: "1200", stored: "20" } } });
  assert.match(pre.placementHash, /^[0-9a-f]{64}$/);
  assert.ok(board.preplaced.some((p) => p.mappingVersionId === W.sysDist.versionId));
  assert.deepEqual([board.replaceable, board.switchedOff], [[], []]);
  // The same call twice: the same pair, the same hashes.
  const again = ok(await boardOf(W.caA, W.tA)).board;
  assert.deepEqual(again, board);
  // Other athletes: the next pair; then the last; then none.
  const second = ok(await boardOf(W.caA, W.tA, { pair: 1 })).board;
  assert.deepEqual(second.pair, { index: 1, count: 3, labels: [NAMES[1], NAMES[3]] });
  assert.notEqual(second.preplaced.find((p) => p.mappingVersionId === W.sysTime.versionId).placementHash, pre.placementHash, "the hash covers the pair");
  assert.deepEqual(ok(await boardOf(W.caA, W.tA, { pair: 2 })).board.pair.labels, [NAMES[2], NAMES[3]]);
  assert.deepEqual(refused(await boardOf(W.caA, W.tA, { pair: 3 }), 409, "pair_out_of_range").current, { count: 3 });
});

test("3. the stored session: the newest usable one by default; no session, an expired or purged snapshot, a session of another link, a session with no start and an undone or superseded one are each answered as the contract says", async () => {
  const t = await gpexeTeam(W.clubA);
  for (const n of [1, 2]) await link(t, n, `Second ${NAMES[n]}`);
  refused(await boardOf(W.caA, t), 409, "no_stored_session");
  const older = await candidate(t, { startedAt: "2026-09-10T10:00:00Z" });
  const newer = await candidate(t, { startedAt: "2026-09-12T10:00:00Z" });
  assert.equal(ok(await boardOf(W.caA, t)).board.session.candidateId, newer.id, "the newest by its start");
  assert.equal(ok(await boardOf(W.caA, t, { candidateId: older.id })).board.session.candidateId, older.id, "a chosen one");
  // Never used by default, each with its own answer when chosen.
  const expired = await candidate(t, { state: "expired", startedAt: "2026-09-20T10:00:00Z" });
  const purged = await candidate(t, { state: "purged", startedAt: "2026-09-21T10:00:00Z" });
  const noStart = await candidate(t, { startedAt: null });
  // Read through another binding of the club (the checks table refuses it; planted with the triggers off).
  const otherLink = await planted(async () => candidate(t, { startedAt: "2026-09-22T10:00:00Z", checkId: await check(t, { via: W.tA }) }));
  assert.equal(ok(await boardOf(W.caA, t)).board.session.candidateId, newer.id, "still the newest usable one");
  assert.deepEqual(refused(await boardOf(W.caA, t, { candidateId: expired.id }), 409, "snapshot_expired").current, { reason: "expired" });
  assert.deepEqual(refused(await boardOf(W.caA, t, { candidateId: purged.id }), 409, "snapshot_expired").current, { reason: "purged" });
  refused(await boardOf(W.caA, t, { candidateId: noStart.id }), 409, "session_start_unknown");
  refused(await boardOf(W.caA, t, { candidateId: otherLink.id }), 409, "candidate_source_mismatch");
  // An undone import and a superseded session are not stored sessions here: the identical 404 when chosen.
  const undone = await candidate(t, { startedAt: "2026-09-23T10:00:00Z" });
  await planted(() => k.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now(), import_undone_at = now(), import_undone_request_id = gen_random_uuid() where id = $1`, [undone.id]));
  const superseded = await candidate(t, { startedAt: "2026-09-24T10:00:00Z" });
  await k.query(`update training_load.gpexe_import_candidates set status = 'superseded', superseded_by_check_id = $2 where id = $1`, [superseded.id, superseded.checkId]);
  assert.deepEqual(shape(await boardOf(W.caA, t, { candidateId: undone.id })), NOT_FOUND, "an undone import");
  assert.deepEqual(shape(await boardOf(W.caA, t, { candidateId: superseded.id })), NOT_FOUND, "a superseded session");
  assert.equal(ok(await boardOf(W.caA, t)).board.session.candidateId, newer.id, "neither is the default");
  // A team whose only session is an undone import has no stored session.
  const t2 = await gpexeTeam(W.clubA);
  const only = await candidate(t2);
  await planted(() => k.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now(), import_undone_at = now(), import_undone_request_id = gen_random_uuid() where id = $1`, [only.id]));
  refused(await boardOf(W.caA, t2), 409, "no_stored_session");
  // Fewer than two athletes OptiMove can name: the refusal that points to Link athletes; a GPEXE name counts as a name.
  const t3 = await gpexeTeam(W.clubA);
  await candidate(t3);
  refused(await boardOf(W.caA, t3), 409, "not_enough_athletes");
  await link(t3, 1, "Only One Linked");
  refused(await boardOf(W.caA, t3), 409, "not_enough_athletes");
  // A GPEXE name past its expiry is not a name.
  await planted(() => k.query(`insert into training_load.gpexe_athlete_identities (owner_team_id, binding_id, connection_id, source_team_id, gpexe_athlete_id, display_name, observed_at, expires_at)
                 values ($1,$2,$3,$4,$5,'Expired Name Three', now() - interval '337 hours', now() - interval '1 hour')`, [t3.teamId, t3.bindingId, t3.connectionId, t3.sourceTeamId, ATHLETE(3)]));
  refused(await boardOf(W.caA, t3), 409, "not_enough_athletes");
  await k.query(`insert into training_load.gpexe_athlete_identities (owner_team_id, binding_id, connection_id, source_team_id, gpexe_athlete_id, display_name, birth_date, observed_at, expires_at)
                 values ($1,$2,$3,$4,$5,'Gpexe Named Two','2001-02-03', now(), now() + interval '336 hours')`, [t3.teamId, t3.bindingId, t3.connectionId, t3.sourceTeamId, ATHLETE(2)]);
  assert.deepEqual(ok(await boardOf(W.caA, t3)).board.pair, { index: 0, count: 1, labels: ["Only One Linked", "Gpexe Named Two"] });
});

// ---------------------------------------------------------------------------
// 3. One placement
// ---------------------------------------------------------------------------
test("4. a placement: the proposal from the one active conversion, the two athletes' raw, stored and GPEXE-screen values, the levels and a hash per display unit; each refusal is a 200 with its code; a foreign id is the identical 404", async () => {
  // Converted: seconds onto minutes.
  const p = ok(await placement(W.caA, W.tA, W.cA.id, W.fTime, W.vMin)).placement;
  assert.deepEqual({ placeable: p.placeable, kind: p.kind, conversion: p.conversion, levels: p.levels, rule: p.displayRule, units: p.displayUnits, reuses: p.reusesVersionId, src: p.sourceUnit, dst: p.targetUnit },
    { placeable: true, kind: "new", conversion: { kind: "converted", scale: "1", divisor: "60", offset: "0" }, levels: { session: true, drill: true }, rule: "duration_mmss", units: ["mm:ss"], reuses: null, src: "s", dst: "min" });
  assert.deepEqual(p.values, { a: { raw: "60.00000003", stored: convertAtStorageScale("60.00000003", { scale: "1", divisor: "60", offset: "0" }) }, b: { raw: "1200", stored: "20" } });
  assert.deepEqual(p.display, { "mm:ss": { a: "1:00", b: "20:00" } });
  assert.match(p.placementHashes["mm:ss"], /^[0-9a-f]{64}$/);
  assert.equal(p.revisionId, W.fTime.revId);
  // The same unit: no conversion.
  const same = ok(await placement(W.caA, W.tA, W.cA.id, W.fTime, W.vSec)).placement;
  assert.deepEqual([same.conversion, same.values.a.stored, same.values.b.stored], [{ kind: "same_unit" }, "60.00000003", "1200"]);
  assert.notEqual(same.placementHashes["mm:ss"], p.placementHashes["mm:ss"], "the hash covers the target");
  // Speed: m/s onto km/h, and what the GPEXE screen shows.
  const speed = ok(await placement(W.caA, W.tA, W.cA.id, W.fSpeed, W.vKmh)).placement;
  assert.deepEqual([speed.values.a.stored, speed.values.b.stored, speed.display["km/h"]], ["3.600000004", "22.32", { a: "3.6", b: "22.3" }]);
  // The hash covers the pair.
  const other = ok(await placement(W.caA, W.tA, W.cA.id, W.fTime, W.vMin, 1)).placement;
  assert.notEqual(other.placementHashes["mm:ss"], p.placementHashes["mm:ss"]);
  assert.deepEqual(other.values.b, { raw: "1800", stored: "30" });
  // The hash covers who the pair is: the same values under another name are another hash (placed and pre-placed).
  const preHash = async () => ok(await boardOf(W.caA, W.tA)).board.preplaced.find((x) => x.mappingVersionId === W.sysTime.versionId).placementHash;
  const preBefore = await preHash();
  const renamed = `update public.athletes set display_name = $2, full_name = $2 where id = (select athlete_id from training_load.gpexe_athlete_links where owner_team_id = $1 and gpexe_athlete_id = $3 and unlinked_at is null)`;
  await k.query(renamed, [W.tA.teamId, "Board Athlete Renamed", ATHLETE(1)]);
  const after = ok(await placement(W.caA, W.tA, W.cA.id, W.fTime, W.vMin)).placement;
  assert.deepEqual(after.values, p.values);
  assert.notEqual(after.placementHashes["mm:ss"], p.placementHashes["mm:ss"]);
  assert.notEqual(await preHash(), preBefore);
  await k.query(renamed, [W.tA.teamId, NAMES[1], ATHLETE(1)]);
  assert.equal(ok(await placement(W.caA, W.tA, W.cA.id, W.fTime, W.vMin)).placement.placementHashes["mm:ss"], p.placementHashes["mm:ss"], "and the same again under the same name");
  // The refusals.
  const code = async (f, v, pair = 0) => ok(await placement(W.caA, W.tA, W.cA.id, f, v, pair)).placement;
  assert.deepEqual(await code(W.fTime, W.vKg), { placeable: false, code: "conversion_unavailable", fieldId: W.fTime.fieldId, targetId: W.vKg.id, sourceUnit: "s", targetUnit: "kg" });
  assert.equal((await code(W.fUnverified, W.vMin)).code, "field_not_confirmed");
  assert.equal((await code(W.fZone, W.vMin)).code, "field_has_parameters");
  assert.equal((await code(W.fNoReader, W.vMin)).code, "source_metric_unsupported");
  assert.equal((await code(W.fBurst, W.vMin)).code, "display_rule_missing");
  const out = await code(W.fTime, W.vSmall);
  assert.deepEqual([out.code, out.limits], ["value_outside_limits", { min: null, max: "10", unit: "min" }], "20 minutes is above the variable's 10");
  assert.equal(JSON.stringify(out).includes("1200"), false, "a refusal carries no value");
  // An OptiMove variable: only through OptiMove's own mapping of this column.
  assert.equal((await code(W.fTime, W.sysFree)).code, "target_scope_mismatch");
  assert.equal((await code(W.fSpeed, W.sysMin)).code, "target_scope_mismatch");
  const sys = await code(W.fTime, W.sysMin);
  assert.deepEqual([sys.placeable, sys.kind, sys.mappingVersionId, sys.badge], [true, "preplaced", W.sysTime.versionId, "optimove_mapping"]);
  // A foreign or unknown id is the identical 404, never a code.
  for (const [f, v] of [[W.fTime, W.vB], [W.fTime, { id: crypto.randomUUID() }], [{ fieldId: crypto.randomUUID() }, W.vMin]]) {
    assert.deepEqual(shape(await placement(W.caA, W.tA, W.cA.id, f, v)), NOT_FOUND);
  }
  assert.deepEqual(shape(await placement(W.caA, W.tA, W.cB.id, W.fTime, W.vMin)), NOT_FOUND, "another club's candidate");
  // The variable's own refusals.
  assert.equal((await code(W.fSpeed, await variable(W.caA, { unit: "km/h", condition: { kind: "zone", operator: ">=", value: "20", unit: "km/h" } }))).code, "condition_mismatch");
  assert.equal((await code(W.fTime, await variable(W.caA, { unit: "min", levels: ["drill"] }))).code, "level_not_allowed");
  // A 404 always comes before any 409: a foreign or unknown id with a pair past the end or an expired session is still the 404.
  const expired = await candidate(W.tA, { state: "expired", startedAt: "2026-09-30T10:00:00Z" });
  for (const [f, v] of [[W.fTime, W.vB], [{ fieldId: crypto.randomUUID() }, W.vMin], [W.fTime, { id: crypto.randomUUID() }]]) {
    assert.deepEqual(shape(await placement(W.caA, W.tA, W.cA.id, f, v, 9999)), NOT_FOUND, "a pair past the end");
    assert.deepEqual(shape(await placement(W.caA, W.tA, expired.id, f, v)), NOT_FOUND, "an expired session");
  }
  assert.deepEqual(refused(await placement(W.caA, W.tA, W.cA.id, W.fTime, W.vMin, 9999), 409, "pair_out_of_range").current, { count: 3 });
  assert.deepEqual(refused(await placement(W.caA, W.tA, expired.id, W.fTime, W.vMin), 409, "snapshot_expired").current, { reason: "expired" });
  assert.deepEqual(shape(await placement(W.caA, W.tB, W.cB.id, W.fTime, W.vMin)), NOT_FOUND, "another club's team");
});

test("5. a placement against what exists: the club's own active version is reused only when it is the same contract; another variable of the same column is taken; a pair with equal or missing values cannot prove a column; collisions on the team are listed", async () => {
  const f = await field("time");
  const target = await variable(W.caA, { unit: "min" });
  const own = await activeVersion(W.caA, f, target);
  const reuse = ok(await placement(W.caA, W.tA, W.cA.id, f, target)).placement;
  assert.deepEqual([reuse.placeable, reuse.reusesVersionId], [true, own.versionId]);
  // Another variable for the same column: C33.
  assert.equal(ok(await placement(W.caA, W.tA, W.cA.id, f, W.vSec)).placement.code, "source_metric_target_taken");
  // The club's own active mapping is pre-placed on the team's board as the club's (R4).
  const { board } = ok(await boardOf(W.caA, W.tA));
  assert.equal(board.preplaced.find((p) => p.mappingVersionId === own.versionId).badge, "club_mapping");
  // Switched on for the team: a row that is on, no longer pre-placed; a new placement of the column lists the collision.
  ok(await start(W.caA, own, W.tA), 201);
  const activation = await openOn(own, W.tA);
  const on = ok(await boardOf(W.caA, W.tA)).board;
  assert.deepEqual(on.on.map((o) => [o.activationId, o.mappingVersionId, o.requirement, o.badge]), [[activation.id, own.versionId, "required", "club_mapping"]]);
  assert.equal(on.preplaced.some((p) => p.mappingVersionId === own.versionId), false);
  // The same contract is already on: nothing to place. Another column onto the same variable lists the collision.
  assert.deepEqual(ok(await placement(W.caA, W.tA, W.cA.id, f, target)).placement, { placeable: false, code: "activation_exists", fieldId: f.fieldId, targetId: target.id });
  const f2 = await field("time");
  assert.deepEqual(ok(await placement(W.caA, W.tA, W.cA.id, f2, target)).placement.collisions, [{ activationId: activation.id, fieldId: f.fieldId, variableId: target.id }]);
  // The club's active version with other levels is not this contract.
  const f3 = await field("time");
  const target3 = await variable(W.caA, { unit: "min" });
  await activeVersion(W.caA, f3, target3, { drill: false });
  assert.equal(ok(await placement(W.caA, W.tA, W.cA.id, f3, target3)).placement.code, "mapping_version_active");
  // Switched off by an administrator: not placed again, shown with who and when (Q9).
  ok(await end(W.caA, activation.id));
  const off = ok(await boardOf(W.caA, W.tA)).board;
  assert.deepEqual(off.on, []);
  assert.equal(off.preplaced.some((p) => p.mappingVersionId === own.versionId), false, "never switched back on by itself");
  const entry = off.switchedOff.find((s) => s.mappingVersionId === own.versionId);
  assert.deepEqual([entry.endedBy, entry.badge, Boolean(entry.endedAt)], ["Club Admin Person", "club_mapping", true]);
  // Switched on again and then ended another way (its version disabled): not "switched off by an administrator" any more.
  ok(await start(W.caA, own, W.tA), 201);
  const again = await openOn(own, W.tA);
  await planted(() => k.query(`update ${T5} set ended_at = now(), ended_by_user_id = $2, ended_basis = 'platform_admin', end_reason = 'mapping_version_disabled' where id = $1`, [again.id, W.pa.id]));
  const back = ok(await boardOf(W.caA, W.tA)).board;
  assert.deepEqual([back.switchedOff.some((x) => x.mappingVersionId === own.versionId), back.preplaced.some((p) => p.mappingVersionId === own.versionId)], [false, true], "the mapping's latest activation decides");
  // A pair with the same value, and a pair where one athlete has none.
  const t = await gpexeTeam(W.clubA);
  for (const n of [1, 2]) await link(t, n, `Equal ${NAMES[n]}`);
  // Two athletes with the same time, and different distances (so the pair exists).
  const equalTimes = previewBundle({ gpexeTeamId: Number(t.sourceTeamId) });
  void equalTimes;
  const c = await candidate(t);
  await k.query(`update training_load.gpexe_import_candidates set raw_bundle = jsonb_set(raw_bundle, '{athleteSessions}',
                   (select jsonb_agg(case when e ->> 'drill' is null then jsonb_set(e, '{total_time}', '900') else e end) from jsonb_array_elements(raw_bundle -> 'athleteSessions') e)) where id = $1`, [c.id]);
  const equal = ok(await boardOf(W.caA, t)).board;
  assert.deepEqual([columnOf(equal, W.fTime).placeable, columnOf(equal, W.fTime).reason, columnOf(equal, W.fTime).rawA, columnOf(equal, W.fTime).rawB], [false, "no_value_for_pair", "900", "900"]);
  assert.equal(ok(await placement(W.caA, t, c.id, W.fTime, W.vMin)).placement.code, "pair_not_distinct");
  assert.equal(ok(await placement(W.caA, t, c.id, W.fDist, await variable(W.caA, { unit: "m" }))).placement.placeable, true, "another column of the same pair can still be proven");
});

test("6. a variable the club hides: its OptiMove mapping is not pre-placed and the variable is not offered; shown again, it is back", async () => {
  const before = ok(await boardOf(W.caA, W.tA)).board;
  assert.ok(before.preplaced.some((p) => p.mappingVersionId === W.sysDist.versionId));
  ok(await post(`/variables/${W.sysM.id}/hide`, W.caA, { requestKey: key() }));
  const hidden = ok(await boardOf(W.caA, W.tA)).board;
  assert.equal(hidden.preplaced.some((p) => p.mappingVersionId === W.sysDist.versionId), false);
  assert.equal(variableOf(hidden, W.sysM), undefined);
  assert.deepEqual(shape(await placement(W.caA, W.tA, W.cA.id, W.fDist, W.sysM)), NOT_FOUND, "a hidden variable is not a target");
  ok(await post(`/variables/${W.sysM.id}/show`, W.caA, { requestKey: key() }));
  assert.ok(ok(await boardOf(W.caA, W.tA)).board.preplaced.some((p) => p.mappingVersionId === W.sysDist.versionId));
});

// ---------------------------------------------------------------------------
// 4. The stored confirmations
// ---------------------------------------------------------------------------
test("7. the stored confirmations: the club's admins and a platform admin read them, with the values until they expire; nobody else; never the confirmer's id; a failed removal batch never fails the read", async () => {
  const t = await gpexeTeam(W.clubA, { name: "History Team" });
  const cand = await candidate(t);
  const f1 = await field("time");
  const f2 = await field("time");
  const v1 = await activeVersion(W.caA, f1, await variable(W.caA, { unit: "min", label: "Confirmed minutes" }));
  const v2 = await activeVersion(W.caA, f2, await variable(W.caA, { unit: "min", label: "Plain minutes" }));
  const confId = await confirm(W.caA, t, cand, [{ v: v1, checked: true }, { v: v2, checked: false }]);
  const list = ok(await get(`/confirmations?teamId=${t.teamId}`, W.caA));
  assert.equal(list.nextCursor, null);
  assert.equal(list.confirmations.length, 1);
  const c = list.confirmations[0];
  assert.deepEqual([c.id, c.teamId, c.confirmedBy, new Date(c.sessionStartedAt).toISOString()], [confId, t.teamId, "Club Admin Person", "2026-09-14T18:08:12.000Z"]);
  assert.deepEqual(c.rows.map((r) => [r.itemNo, r.kind, r.checked, r.valuesState, r.values, r.column.label, r.variable.label, r.displayRule, r.displayUnit, r.conversion]), [
    [1, "club_mapping", true, "present", { a: { raw: "1200", stored: "20" }, b: { raw: "1800", stored: "30" } }, f1.label, "Confirmed minutes", "duration_mmss", "mm:ss", { kind: "converted", scale: "1", divisor: "60", offset: "0" }],
    [2, "club_mapping", false, "not_compared", null, f2.label, "Plain minutes", null, null, { kind: "converted", scale: "1", divisor: "60", offset: "0" }],
  ]);
  assert.equal(JSON.stringify(list).includes(W.caA.id), false, "the confirmer's user id is never returned");
  const oneRead = ok(await get(`/confirmations/${confId}`, W.caA));
  assert.deepEqual(oneRead.confirmation, c);
  // The audience: a platform admin in the club's workspace and in the platform workspace; nobody else.
  assert.deepEqual(ok(await get(`/confirmations/${confId}`, W.paA)).confirmation, c);
  assert.deepEqual(ok(await get(`/confirmations/${confId}`, W.pa)).confirmation, c);
  assert.equal(ok(await get(`/confirmations?teamId=${t.teamId}`, W.pa)).confirmations.length, 1);
  for (const [label, who] of [["another club's admin", W.caB], ["a coach", W.coach], ["no role", W.plain]]) {
    assert.deepEqual(shape(await get(`/confirmations/${confId}`, who)), NOT_FOUND, label);
    assert.deepEqual(shape(await get(`/confirmations?teamId=${t.teamId}`, who)), NOT_FOUND, label);
  }
  for (const id of [crypto.randomUUID(), "not-a-uuid"]) assert.deepEqual(shape(await get(`/confirmations/${id}`, W.caA)), NOT_FOUND);
  assert.deepEqual(shape(await get(`/confirmations?teamId=${W.tB.teamId}`, W.caA)), NOT_FOUND, "another club's team is not an empty list");
  refused(await get(`/confirmations?teamId=${t.teamId}&cursor=nonsense`, W.caA), 400, "invalid_query");
  refused(await get(`/confirmations`, W.caA), 400, "invalid_query");
  // After an Unbind the confirmation stays readable.
  await k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'Test unbind.' where id = $1`, [t.bindingId, W.pa.id]);
  assert.deepEqual(ok(await get(`/confirmations/${confId}`, W.caA)).confirmation, c, "readable after an Unbind");
  // Past the expiry: no value is returned even before the removal; a failing removal batch does not fail the read.
  await planted(() => k.query(`update ${T9} set confirmed_at = confirmed_at - interval '2184 hours', values_expire_at = values_expire_at - interval '2184 hours' where id = $1`, [confId]));
  boardService.setBoardRemovalFaultForTests(() => { throw Object.assign(new Error("planted"), { code: "57014" }); });
  try {
    const hidden = ok(await get(`/confirmations/${confId}`, W.caA)).confirmation;
    assert.deepEqual(hidden.rows.map((r) => [r.valuesState, r.values]), [["expired", null], ["not_compared", null]]);
    assert.equal((await one(`select raw_a from ${T9I} where confirmation_id = $1 and checked`, [confId])).raw_a !== null, true, "not removed yet: the batch failed");
    assert.ok(logLines.some((l) => l.includes("expired_values_removal_failed (57014)")), "the failure is logged by its code only");
    // A batch that never answers delays the read by its bound and never fails it.
    boardService.setBoardRemovalFaultForTests(() => new Promise(() => {}), { boundMs: 300 });
    assert.equal(ok(await get(`/confirmations/${confId}`, W.caA)).confirmation.id, confId);
    assert.ok(logLines.some((l) => l.includes("expired_values_removal_failed (removal_bound_exceeded)")));
    // The batch runs before a board read and a History read, never before a placement.
    let runs = 0;
    boardService.setBoardRemovalFaultForTests(() => { runs += 1; throw Object.assign(new Error("planted"), { code: "57014" }); });
    ok(await boardOf(W.caA, W.tA));
    ok(await placement(W.caA, W.tA, W.cA.id, W.fTime, W.vMin));
    ok(await get(`/confirmations?teamId=${t.teamId}`, W.caA));
    ok(await get(`/confirmations/${confId}`, W.caA));
    assert.equal(runs, 3);
  } finally {
    boardService.setBoardRemovalFaultForTests(null);
  }
  // The next read runs one batch first: the values and the salt are gone, the state stays "expired".
  const removed = ok(await get(`/confirmations/${confId}`, W.caA)).confirmation;
  assert.deepEqual(removed.rows.map((r) => [r.valuesState, r.values]), [["expired", null], ["not_compared", null]]);
  assert.deepEqual(await one(`select raw_a, values_salt, values_removed_kind, values_removed_by_user_id from ${T9I} where confirmation_id = $1 and checked`, [confId]),
    { raw_a: null, values_salt: null, values_removed_kind: "expired", values_removed_by_user_id: null });
  // The team archived: the club's admin reads the identical 404; a platform admin in the platform workspace still reads it.
  await k.query(`update public.teams set is_active = false where id = $1`, [t.teamId]);
  assert.deepEqual(shape(await get(`/confirmations/${confId}`, W.caA)), NOT_FOUND);
  assert.deepEqual(shape(await get(`/confirmations?teamId=${t.teamId}`, W.caA)), NOT_FOUND);
  assert.equal(ok(await get(`/confirmations/${confId}`, W.pa)).confirmation.id, confId);
});

test("7b. History's pages, cursor and audience after an archive: 50 per page with no row lost inside one millisecond; a forged cursor is 400; an erased value is not returned; a platform admin lists and reads after a team and a club archive", async () => {
  const clubD = await club("Club D");
  const caD = await clubAdmin(clubD, "Club D Admin");
  const t = await gpexeTeam(clubD);
  const cand = await candidate(t);
  const f = await field("time");
  const v = await activeVersion(caD, f, await variable(caD, { unit: "min" }));
  const confId = await confirm(caD, t, cand, [{ v, checked: true }]);
  // 51 more confirmations of the team (planted: no item, the guards off), a second apart, the 50th and 51st of
  // the whole list 200 microseconds apart inside one millisecond.
  await planted(async () => {
    for (let g = 1; g <= 51; g += 1) {
      const at = g === 49 ? `- interval '49 seconds' + interval '500 microseconds'` : g === 50 ? `- interval '49 seconds' + interval '300 microseconds'` : `- interval '${g} seconds'`;
      const id = (await one(
        `insert into ${T9} select (jsonb_populate_record(null::${T9}, to_jsonb(c) || jsonb_build_object('id', gen_random_uuid(), 'operation_id', gen_random_uuid(),
                   'confirmed_at', date_trunc('second', c.confirmed_at) ${at}, 'values_expire_at', date_trunc('second', c.confirmed_at) ${at} + interval '2160 hours'))).*
           from ${T9} c where c.id = $1 returning id`, [confId])).id;
      await k.query(`insert into ${T9S} select (jsonb_populate_record(null::${T9S}, to_jsonb(s) || jsonb_build_object('confirmation_id', $2::uuid))).* from ${T9S} s where s.confirmation_id = $1`, [confId, id]);
    }
  });
  const first = ok(await get(`/confirmations?teamId=${t.teamId}`, caD));
  assert.equal(first.confirmations.length, 50);
  assert.equal(first.confirmations[0].id, confId, "the newest first");
  assert.equal(typeof first.nextCursor, "string");
  const second = ok(await get(`/confirmations?teamId=${t.teamId}&cursor=${first.nextCursor}`, caD));
  assert.deepEqual([second.confirmations.length, second.nextCursor], [2, null]);
  assert.equal(new Set([...first.confirmations, ...second.confirmations].map((c) => c.id)).size, 52, "no row lost or repeated between the pages");
  assert.equal(JSON.stringify(first).includes("cursor_at"), false);
  // A cursor that is not exactly the server's form is 400, never a database error.
  const cursor = (at, id = confId) => Buffer.from(JSON.stringify([at, id])).toString("base64url");
  for (const bad of [cursor("2026"), cursor("foo 1"), cursor("2026-02-30T00:00:00.000000Z"), cursor("2026-11-12T10:00:00.000Z"), cursor("-000001-01-01T00:00:00.000000Z"), cursor("0000-01-01T00:00:00.000000Z"),
    cursor("2026-11-12T10:00:00.000000Z", "x"), Buffer.from("[]").toString("base64url"), Buffer.from("{}").toString("base64url")]) {
    refused(await get(`/confirmations?teamId=${t.teamId}&cursor=${bad}`, caD), 400, "invalid_query");
  }
  assert.equal(ok(await get(`/confirmations?teamId=${t.teamId}&cursor=${cursor("2000-01-01T00:00:00.000000Z")}`, caD)).confirmations.length, 0, "a well-formed cursor of the caller's own making reads only the team's rows");
  // A value erased on request is not returned, whatever its date.
  await planted(() => k.query(`update ${T9I} set raw_a = null, stored_a = null, raw_b = null, stored_b = null, values_salt = null,
                                 values_removed_at = now(), values_removed_kind = 'erased', values_removed_by_user_id = $2 where confirmation_id = $1 and checked`, [confId, W.pa.id]));
  assert.deepEqual(ok(await get(`/confirmations/${confId}`, caD)).confirmation.rows.map((r) => [r.valuesState, r.values]), [["erased", null]]);
  // The team archived, then the club: the club's admin reads nothing; a platform admin in the platform workspace lists and reads.
  for (const archive of [`update public.teams set is_active = false where id = '${t.teamId}'`, `update public.clubs set is_active = false where id = '${clubD}'`]) {
    await k.query(archive);
    assert.deepEqual(shape(await get(`/confirmations?teamId=${t.teamId}`, caD)), NOT_FOUND);
    assert.deepEqual(shape(await get(`/confirmations/${confId}`, caD)), NOT_FOUND);
    assert.equal(ok(await get(`/confirmations?teamId=${t.teamId}`, W.pa)).confirmations.length, 50);
    assert.equal(ok(await get(`/confirmations/${confId}`, W.pa)).confirmation.id, confId);
  }
  assert.deepEqual(shape(await get(`/confirmations?teamId=${crypto.randomUUID()}`, W.pa)), NOT_FOUND, "an unknown team is not an empty list");
});

// ---------------------------------------------------------------------------
// 5. What never leaves, and what the service never does
// ---------------------------------------------------------------------------
test("8. no answer or log line of this suite carries an athlete id, a GPEXE athlete or track id, a date of birth or SQL; the service reads no date of birth, calls no identity service, sends nothing to GPEXE and writes nothing but the removal batch", async () => {
  assert.ok(responses.length > 60, "the suite's answers were collected");
  const everything = [...responses, ...logLines].join("\n");
  for (const needle of [PLANTED.athletePrefix, PLANTED.trackPrefix, "2001-02-03", "birth", "select ", "training_load."]) {
    assert.equal(everything.includes(needle), false, `no answer or log line carries "${needle}"`);
  }
  const athleteIds = (await rows(`select id::text from public.athletes`)).map((r) => r.id);
  for (const id of athleteIds) assert.equal(everything.includes(id), false, "no OptiMove athlete id");
  const source = await fsp.readFile(path.resolve(__dirname, "../src/sourceMetricBoardService.js"), "utf8");
  const pure = await fsp.readFile(path.resolve(__dirname, "../src/sourceMetricBoard.js"), "utf8");
  const code = (text) => text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["birth_date", "gpexeAthleteIdentityService", "listIdentities", "fetch(", "gpexeClient", "gpexeRestV1Adapter", "resolveActiveWorkspace", "insert into", "update ", "delete from", "for update", "for share"]) {
    assert.equal(code(source).includes(forbidden), false, `the board service has no "${forbidden}"`);
    assert.equal(code(pure).includes(forbidden), false, `the pure module has no "${forbidden}"`);
  }
  assert.equal((code(source).match(/remove_expired_confirmation_values/g) ?? []).length, 1, "the one write: the removal batch");
});

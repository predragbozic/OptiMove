// J18, slice 18-3 - the save of the drag-and-drop board (route 3, POST
// /confirmations). Contract: docs/ai/c112-drag-mapping-contract.md, sections
// 4.3-4.5, 9.2, 9.3 and 15. Through the real HTTP stack on one disposable
// optimove_tests_gpexe_* database (never OPTIMOVE, never a real GPEXE field,
// connection or athlete). The columns are synthetic test fields that read
// through the registry's real extractors and display rules; the stored session
// is a synthetic bundle; the athletes are invented.
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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "save183" });
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
const rows_ = rows;
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
       values ('gpexe','club',$1,'server3','18-3 test','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
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
const activators = new Map();
async function activatorOf(owner) {
  if (owner.basis !== "club_admin") return owner;
  if (!activators.has(owner.clubId)) activators.set(owner.clubId, await platformAdmin(["club", owner.clubId], "activating-platform-admin"));
  return activators.get(owner.clubId);
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
  // v66 (M-B): a club admin activates a version of a field without parameters only from the board, so a club's
  // version is activated here by a platform admin in that club's workspace (the basis stays platform_admin).
  if (activate) ok(await post(`/mappings/${mappingId}/versions/${versionId}/activate`, await activatorOf(owner), { requestKey: key(), expectedActiveVersionId: null }));
  return { mappingId, versionId, ...f, target };
}
const start = (who, v, t, requirement = "required") => post("/activations", who, { requestKey: key(), mappingId: v.mappingId, versionId: v.versionId, bindings: [{ bindingId: t.bindingId, requirement }], reason: `Start ${uid()}.` });
const end = (who, activationId) => post(`/activations/${activationId}/end`, who, { requestKey: key(), expectedState: "open", reason: `End ${uid()}.` });
const openOn = (v, t) => one(`select id from ${T5} where mapping_version_id = $1 and source_team_binding_id = $2 and ended_at is null`, [v.versionId, t.bindingId]);

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

const T3 = "training_load.source_metric_mappings";
const T4 = "training_load.source_metric_mapping_versions";

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.pa = await platformAdmin();
  W.paA = await platformAdmin(["club", W.clubA]);
  W.caA = await clubAdmin(W.clubA);
  W.caA2 = await clubAdmin(W.clubA, "Second Club Admin");
  W.caB = await clubAdmin(W.clubB);
  W.tB = await gpexeTeam(W.clubB);
  for (const n of [1, 2]) await link(W.tB, n, `Club B ${NAMES[n]}`);
  W.cB = await candidate(W.tB);
  W.fTime = await field("time");
  W.fDist = await field("dist");
  W.fSpeed = await field("speed");
  W.fSysTime = await field("time");
  W.vB = await variable(W.caB, { unit: "min", label: "Club B minutes" });
  W.sysMin = await variable(W.pa, { unit: "min", label: "OptiMove minutes" });
  W.sysTime = await activeVersion(W.pa, W.fSysTime, W.sysMin);
  W.vBActive = await activeVersion(W.caB, await field("time"), W.vB);
}
// A fresh team of club A with three named athletes, a coach and a stored session.
async function freshTeam() {
  const t = await gpexeTeam(W.clubA);
  for (const n of [1, 2, 3]) await link(t, n, `${NAMES[n]} ${uid()}`);
  return { t, cand: await candidate(t) };
}
const placementOf = async (who, t, cand, f, target, pair = 0) => ok(await placement(who, t, cand.id, f, target, pair)).placement;
// A row of the save's body from what the reads returned.
async function newRow(who, t, cand, f, target, { pair = 0, requirement = "required", replaces = undefined, unit = undefined } = {}) {
  const p = await placementOf(who, t, cand, f, target, pair);
  assert.equal(p.placeable, true, JSON.stringify(p));
  const displayUnit = unit ?? p.displayUnits[0];
  return { kind: "new", fieldId: f.fieldId, targetId: target.id, expectedTargetVersionId: p.expectedTargetVersionId, displayUnit, placementHash: p.placementHashes[displayUnit],
    checked: true, requirement, replaces: replaces ?? p.collisions.map((c) => c.activationId) };
}
async function preplacedRow(who, t, cand, v, { pair = 0, requirement = "optional", replaces = undefined } = {}) {
  const b = ok(await boardOf(who, t, { candidateId: cand.id, pair })).board;
  const entry = [...b.preplaced, ...b.replaceable].find((x) => x.mappingVersionId === v.versionId);
  assert.ok(entry, "the version is pre-placed on the board");
  return { kind: "preplaced", mappingVersionId: v.versionId, placementHash: entry.placementHash, requirement, replaces: replaces ?? (entry.replaces ?? []).map((c) => c.activationId) };
}
const save = (who, t, cand, rows, { pair = 0, requestKey = key() } = {}) => post("/confirmations", who, { requestKey, teamId: t.teamId, candidateId: cand.id, pair, rows });
const counts = async () => one(`select (select count(*) from ${T3})::int as t3, (select count(*) from ${T4})::int as t4, (select count(*) from ${T5})::int as t5,
                                        (select count(*) from ${T5} where ended_at is null)::int as t5_open, (select count(*) from ${T8})::int as t8, (select count(*) from ${T9})::int as t9, (select count(*) from ${T9I})::int as t9i`);
async function nothingWritten(fn) {
  const before = await counts();
  const value = await fn();
  assert.deepEqual(await counts(), before, "nothing was written");
  return value;
}
const rowRefused = (res, code, rowIndex) => { assert.deepEqual([res.status, res.body.error, res.body.current?.rowIndex], [409, code, rowIndex], res.text); return res.body; };

// ---------------------------------------------------------------------------
// 1. The save
// ---------------------------------------------------------------------------
test("1. a save: two checked new rows and one OptiMove mapping are switched on for the team in one operation - the club's mappings and versions, the confirmation with the two athletes' values, the starts; the answer carries ids and no value; a replay answers the same; another body under the key is refused", async () => {
  const { t, cand } = await freshTeam();
  const vMin = await variable(W.caA, { unit: "min" });
  const vM = await variable(W.caA, { unit: "m" });
  const pTime = await placementOf(W.caA, t, cand, W.fTime, vMin);
  const rows = [
    await newRow(W.caA, t, cand, W.fTime, vMin, { requirement: "required" }),
    await newRow(W.caA, t, cand, W.fDist, vM, { requirement: "optional" }),
    await preplacedRow(W.caA, t, cand, W.sysTime, { requirement: "optional" }),
  ];
  const requestKey = key();
  const before = await counts();
  const res = await save(W.caA, t, cand, rows, { requestKey });
  const body = ok(res);
  assert.equal(body.replayed, false);
  assert.deepEqual(Object.keys(body.confirmation).sort(), ["confirmedAt", "id", "rows", "teamId"]);
  assert.equal(body.confirmation.teamId, t.teamId);
  assert.equal(body.confirmation.rows.length, 3);
  for (const r of body.confirmation.rows) assert.deepEqual(Object.keys(r).sort(), ["activationId", "fieldId", "mappingId", "requirement", "variableId", "versionId"]);
  const byField = new Map(body.confirmation.rows.map((r) => [r.fieldId, r]));
  assert.deepEqual([byField.get(W.fTime.fieldId).variableId, byField.get(W.fTime.fieldId).requirement, byField.get(W.fDist.fieldId).requirement, byField.get(W.fSysTime.fieldId).versionId, byField.get(W.fSysTime.fieldId).requirement],
    [vMin.id, "required", "optional", W.sysTime.versionId, "optional"]);
  // No value, name or hash in the answer.
  for (const needle of ["1200", "60.00000003", "3100", NAMES[1], rows[0].placementHash]) assert.equal(res.text.includes(needle), false, needle);
  // What was written.
  const after = await counts();
  assert.deepEqual([after.t3 - before.t3, after.t4 - before.t4, after.t5 - before.t5, after.t9 - before.t9, after.t9i - before.t9i], [2, 2, 3, 1, 3]);
  const timeVersion = await one(`select * from ${T4} where id = $1`, [byField.get(W.fTime.fieldId).versionId]);
  assert.deepEqual([timeVersion.status, timeVersion.activated_basis, timeVersion.activated_by_user_id, timeVersion.source_unit, timeVersion.target_unit, timeVersion.scale_divisor, timeVersion.conversion_note, timeVersion.applies_to_session, timeVersion.applies_to_drill, timeVersion.version_number],
    ["active", "club_admin", W.caA.id, "s", "min", "60", "Converted by OptiMove's active unit conversion.", true, true, 1]);
  const distVersion = await one(`select * from ${T4} where id = $1`, [byField.get(W.fDist.fieldId).versionId]);
  assert.deepEqual([distVersion.status, distVersion.source_unit, distVersion.target_unit, distVersion.conversion_note], ["active", "m", "m", null]);
  assert.deepEqual((await rows_(`select a.reason, a.requirement, a.activated_basis, a.ended_at from ${T5} a where a.id = any($1::uuid[]) order by a.reason`, [body.confirmation.rows.map((r) => r.activationId)])).map((a) => [a.reason, a.activated_basis, a.ended_at]),
    [["Switched on by drag and drop; OptiMove mapping.", "club_admin", null], ["Switched on by drag and drop; two athletes checked in GPEXE.", "club_admin", null], ["Switched on by drag and drop; two athletes checked in GPEXE.", "club_admin", null]]);
  const items = await rows_(`select item_no, item_kind, checked, mapping_version_id, gpexe_display_rule, gpexe_display_unit, trim_scale(raw_a)::text as raw_a, trim_scale(stored_a)::text as stored_a, trim_scale(raw_b)::text as raw_b, trim_scale(stored_b)::text as stored_b,
                                    values_digest is not null as digest from ${T9I} where confirmation_id = $1 order by item_no`, [body.confirmation.id]);
  assert.deepEqual(items[0], { item_no: 1, item_kind: "club_mapping", checked: true, mapping_version_id: timeVersion.id, gpexe_display_rule: "duration_mmss", gpexe_display_unit: "mm:ss",
    raw_a: pTime.values.a.raw, stored_a: pTime.values.a.stored, raw_b: pTime.values.b.raw, stored_b: pTime.values.b.stored, digest: true });
  assert.deepEqual([items[1].item_kind, items[1].checked, items[1].gpexe_display_rule], ["club_mapping", true, "distance_m"]);
  assert.deepEqual(items[2], { item_no: 3, item_kind: "system_mapping", checked: false, mapping_version_id: W.sysTime.versionId, gpexe_display_rule: null, gpexe_display_unit: null, raw_a: null, stored_a: null, raw_b: null, stored_b: null, digest: false });
  const conf = await one(`select c.*, s.candidate_id, s.pair_index, s.check_id from ${T9} c join ${T9S} s on s.confirmation_id = c.id where c.id = $1`, [body.confirmation.id]);
  assert.deepEqual([conf.owner_club_id, conf.team_id, conf.binding_id, conf.confirmed_by_user_id, conf.confirmed_basis, conf.attested, conf.candidate_id, conf.pair_index, conf.check_id],
    [W.clubA, t.teamId, t.bindingId, W.caA.id, "club_admin", true, cand.id, 0, cand.checkId]);
  // T8: the operation's rows, one keyed; nothing in T8 carries a value or a hash.
  const audit = await rows_(`select action, request_key, request_hash, reason from ${T8} where operation_id = (select operation_id from ${T9} where id = $1) order by action`, [body.confirmation.id]);
  assert.deepEqual(audit.map((a) => a.action), ["activation_start", "activation_start", "activation_start", "mapping_confirmation", "mapping_create", "mapping_create", "mapping_status", "mapping_status", "mapping_status", "mapping_status", "mapping_version_create", "mapping_version_create"]);
  assert.deepEqual(audit.filter((a) => a.request_key !== null).map((a) => [a.action, a.request_key]), [["mapping_confirmation", requestKey]]);
  assert.equal(JSON.stringify(audit).includes(rows[0].placementHash), false);
  // The board now shows them on; History shows the confirmation with its values.
  const now = ok(await boardOf(W.caA, t)).board;
  assert.deepEqual(now.on.map((o) => o.mappingVersionId).sort(), body.confirmation.rows.map((r) => r.versionId).sort());
  const history = ok(await get(`/confirmations/${body.confirmation.id}`, W.caA)).confirmation;
  assert.deepEqual(history.rows.map((r) => [r.kind, r.checked, r.valuesState]), [["club_mapping", true, "present"], ["club_mapping", true, "present"], ["system_mapping", false, "not_compared"]]);
  assert.deepEqual(history.rows[0].values, pTime.values);
  // A replay: the same answer, nothing written again; another body under the key is refused.
  const replay = await nothingWritten(() => save(W.caA, t, cand, rows, { requestKey }));
  assert.deepEqual(ok(replay), { ...body, replayed: true });
  const other = await nothingWritten(() => save(W.caA, t, cand, rows.slice(0, 2), { requestKey }));
  assert.deepEqual([other.status, other.body.error], [409, "request_key_reused"]);
  // The same rows again under a new key: they are on now.
  rowRefused(await nothingWritten(() => save(W.caA, t, cand, rows)), "activation_exists", 0);
});

test("2. the body and the audience: the right is asked before the body; a malformed body is 400 or 415 for an admitted caller only; every foreign or unknown id of the body is the identical 404; nothing is written", async () => {
  const { t, cand } = await freshTeam();
  const vMin = await variable(W.caA, { unit: "min" });
  const fTime = await field("time");
  const fOther = await field("time");
  const good = await newRow(W.caA, t, cand, fTime, vMin);
  const body = (over = {}) => ({ requestKey: key(), teamId: t.teamId, candidateId: cand.id, pair: 0, rows: [good], ...over });
  const otherOn = ok(await start(W.paA, W.sysTime, (await freshTeam()).t), 201).activations[0].id;
  const coachId = await user("coach");
  await nothingWritten(async () => {
    // Outside the audience: the identical 404, whatever the body.
    const coach = { id: coachId };
    await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coach.id, t.teamId]);
    await workspace(coach.id, "team", t.teamId);
    coach.cookie = await cookieFor(coach.id);
    for (const who of [coach, W.caB, W.pa]) {
      assert.deepEqual(shape(await post("/confirmations", who, body())), NOT_FOUND);
      if (who !== W.caB) assert.deepEqual(shape(await post("/confirmations", who, { nonsense: true })), NOT_FOUND);
    }
    assert.equal((await api("/confirmations", { method: "POST", body: body() })).status, 401);
    // Not JSON.
    const text = await fetch(`${apiBase}${PREFIX}/confirmations`, { method: "POST", headers: { "Content-Type": "text/plain", Cookie: W.caA.cookie }, body: "x" });
    assert.equal(text.status, 415);
    // Malformed bodies.
    const bad = [
      {}, { ...body(), extra: 1 }, body({ rows: [] }), body({ rows: Array.from({ length: 21 }, () => good) }), body({ pair: -1 }), body({ pair: "0" }), body({ teamId: "x" }),
      body({ rows: [{ ...good, checked: false }] }), body({ rows: [{ ...good, requirement: undefined }] }), body({ rows: [{ ...good, requirement: "maybe" }] }),
      body({ rows: [{ ...good, placementHash: "abc" }] }), body({ rows: [{ ...good, extra: 1 }] }), body({ rows: [{ ...good, replaces: "x" }] }), body({ rows: [{ ...good, replaces: [cand.id, cand.id] }] }),
      body({ rows: [good, { ...good }] }), body({ rows: [good, { ...good, fieldId: fOther.fieldId }] }), body({ rows: [{ ...good, kind: "other" }] }), body({ rows: [null] }),
      body({ rows: [{ ...good, displayUnit: "km" }] }), body({ rows: [{ kind: "preplaced", mappingVersionId: W.sysTime.versionId, placementHash: good.placementHash, requirement: "optional", replaces: [], checked: true }] }),
    ];
    for (const b of bad) refused(await post("/confirmations", W.caA, b), 400, "invalid_body");
    // A foreign or unknown id: the identical 404, never a 409 or a code.
    const foreign = [
      body({ teamId: W.tB.teamId }), body({ teamId: crypto.randomUUID() }), body({ candidateId: W.cB.id }), body({ candidateId: crypto.randomUUID() }),
      body({ rows: [{ ...good, targetId: W.vB.id }] }), body({ rows: [{ ...good, targetId: crypto.randomUUID() }] }), body({ rows: [{ ...good, fieldId: crypto.randomUUID() }] }),
      body({ rows: [{ kind: "preplaced", mappingVersionId: W.vBActive.versionId, placementHash: good.placementHash, requirement: "optional", replaces: [] }] }),
      body({ rows: [{ kind: "preplaced", mappingVersionId: crypto.randomUUID(), placementHash: good.placementHash, requirement: "optional", replaces: [] }] }),
      // With a pair past the end and a stale hash too: still the 404.
      body({ pair: 9999, rows: [{ ...good, targetId: W.vB.id, placementHash: "0".repeat(64) }] }),
    ];
    for (const b of foreign) assert.deepEqual(shape(await post("/confirmations", W.caA, b)), NOT_FOUND);
    // A listed activation of another binding (club B's, and another team of club A): the identical 404.
    assert.deepEqual(shape(await post("/confirmations", W.caA, body({ rows: [{ ...good, replaces: [otherOn] }] }))), NOT_FOUND);
    assert.deepEqual(shape(await post("/confirmations", W.caA, body({ rows: [{ ...good, replaces: [crypto.randomUUID()] }] }))), NOT_FOUND);
  });
});

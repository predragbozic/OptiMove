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
// Letters only: these words land in labels and column keys of the answers, and valueLeaks searches a text for a
// stored value as a number of its own - a random digit run in a label ("Variable ab20cdef") would be found by chance.
const uid = () => crypto.randomBytes(4).toString("hex").replace(/\d/g, (d) => "ghijklmnop"[d]);
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
// OptiMove's own active mapping of a fresh column onto a fresh OptiMove variable (on for no team).
async function systemMapping(kind = "time", unit = "min") {
  return activeVersion(W.pa, await field(kind), await variable(W.pa, { unit, label: `OptiMove ${kind} ${uid()}` }));
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
// The leaves of an answer that are, or contain, one of the given values, and any key that names a value.
//   * a leaf equal to a value (as numbers when both are numeric, else as text);
//   * a text leaf in which a value is written as a number of its own ("took 1200 s", "a=60.5;b=3100", "n 3100.",
//     "1200.0"), so a value inside a sentence or a joined text is found too.
// A text shaped like an id (a UUID) or like an ISO time is skipped for the token search: short numbers occur inside
// both by chance, which is what made a plain substring search fail.
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME_SHAPED = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function valueLeaks(answer, values) {
  const wanted = values.map((v) => String(v));
  const same = (leaf, v) => String(leaf) === v || (leaf !== "" && v !== "" && Number.isFinite(Number(leaf)) && Number.isFinite(Number(v)) && Number(leaf) === Number(v));
  // Every number written in the text (a digit run with an optional decimal part, not glued to another digit or
  // point) is compared as a number, so "1200.0" and "20.000000" are found for 1200 and 20, and "1200.5", "31200"
  // and "0.1200" are not.
  const numbersIn = (text) => (text.match(/(?<![0-9.])[0-9]+(\.[0-9]+)?(?![0-9])(?!\.[0-9])/g) || []).map(Number);
  const contains = (leaf, v) => typeof leaf === "string" && v !== "" && Number.isFinite(Number(v)) && !UUID_SHAPED.test(leaf) && !ISO_TIME_SHAPED.test(leaf) && numbersIn(leaf).includes(Number(v));
  const found = [];
  const walk = (node, path) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (typeof node === "object") {
      for (const [key2, x] of Object.entries(node)) {
        if (/^(raw|stored|values|raw_[ab]|stored_[ab])$/i.test(key2) && x !== null) found.push(`${path}.${key2} (key)`);
        walk(x, `${path}.${key2}`);
      }
      return;
    }
    if (typeof node === "boolean") return;
    if (wanted.some((v) => same(node, v))) found.push(path);
    else if (wanted.some((v) => contains(node, v))) found.push(`${path} (inside)`);
  };
  walk(answer, "$");
  return found;
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
  // No value, name or hash in the answer. A value is looked for as a whole leaf of the answer (and as a key), never as
  // a substring: "1200" or "3100" also occur inside an id or a time, which made this check fail by chance.
  const held = (await rows_(`select trim_scale(raw_a)::text as a, trim_scale(stored_a)::text as b, trim_scale(raw_b)::text as c, trim_scale(stored_b)::text as d from ${T9I} where confirmation_id = $1 and checked`, [body.confirmation.id])).flatMap((r) => Object.values(r));
  assert.equal(held.length, 8, "the two checked rows hold four values each");
  assert.ok([pTime.values.a.raw, pTime.values.a.stored, pTime.values.b.raw, pTime.values.b.stored].every((v) => held.some((h) => Number(h) === Number(v))), "among them the ones the placement read showed");
  assert.ok(held.every((v) => v !== null && v !== undefined && String(v) !== ""), "the two rows' values are known to the test");
  assert.deepEqual(valueLeaks(res.body, held), [], "no athlete's value in the answer");
  assert.deepEqual(valueLeaks({ x: { n: Number(held[0]) }, list: [String(held[1])] }, held), ["$.x.n", "$.list[0]"], "the check does find a value that is there");
  assert.deepEqual(valueLeaks({ row: { values: { a: 1 } } }, []), ["$.row.values (key)"], "and a key that names one");
  // The check's own test: a value inside a longer text is found as a numeric token; the same digits inside an id, a
  // time or a longer number are not.
  assert.deepEqual(valueLeaks({ a: "took 1200 s", b: "x=60.5;y=3100", c: "1200", d: 1200, e: ["n 3100."] }, ["1200", "3100", "60.5"]),
    ["$.a (inside)", "$.b (inside)", "$.c", "$.d", "$.e[0] (inside)"]);
  assert.deepEqual(valueLeaks({ id: "3f2b1200-1111-4222-8333-444431005556", at: "2026-09-14T12:00:31.000Z", day: "2026-12-00", big: "31200", dec: "1200.5", part: "0.1200", n: 31200 }, ["1200", "3100"]), [],
    "an id, a time, and a longer number that only contains the digits");
  assert.deepEqual(valueLeaks({ note: "id 3f2b1200-1111-4222-8333-444431005556 took 1200 s" }, ["1200"]), ["$.note (inside)"], "a text that merely contains an id is still searched");
  // The id and time shapes are skipped where the value really is a number inside them; the same text as part of a sentence is searched.
  assert.deepEqual(valueLeaks({ at: "2026-09-14T12:00:31.000Z", day: "2026-09-14", id: "00000020-0000-4000-8000-000000000020" }, ["12", "14", "31", "2026", "20", "9"]), []);
  assert.deepEqual(valueLeaks({ note: "on 2026-09-14 took 14 s" }, ["14"]), ["$.note (inside)"]);
  // A value printed with trailing zeros is the same number.
  assert.deepEqual(valueLeaks({ a: "took 1200.0 s", b: "(20.000000, x)", c: "60.50" }, ["1200", "20", "60.5"]), ["$.a (inside)", "$.b (inside)", "$.c"]);
  // The test's own random words carry no digit, so a label can never be taken for a value.
  for (let i = 0; i < 200; i += 1) assert.equal(/\d/.test(uid()), false);
  assert.deepEqual(valueLeaks({ label: `Variable ${uid()}`, key: `board.test.time.f${uid()}` }, ["20", "30", "1200"]), []);
  for (const needle of [NAMES[1], rows[0].placementHash]) assert.equal(res.text.includes(needle), false, needle);
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
  const vOther = await variable(W.caA, { unit: "min" });
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
      if (who === coach) assert.deepEqual(shape(await post("/confirmations", who, { nonsense: true })), NOT_FOUND);
    }
    // S: a platform admin in the platform workspace is the platform board's audience (OptiMove's variables only): a club's
    // row is outside that board (the identical 404 above), and a malformed body is theirs to hear about.
    refused(await post("/confirmations", W.pa, { nonsense: true }), 400, "invalid_body");
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
      // In a LATER row, behind a row whose own answer would be a 409: still the 404.
      body({ pair: 9999, rows: [good, { ...good, fieldId: fOther.fieldId, targetId: W.vB.id }] }),
      body({ pair: 9999, rows: [good, { ...good, fieldId: fOther.fieldId, targetId: crypto.randomUUID() }] }),
      body({ pair: 9999, rows: [good, { ...good, fieldId: crypto.randomUUID(), targetId: vOther.id }] }),
      body({ pair: 9999, rows: [good, { kind: "preplaced", mappingVersionId: W.vBActive.versionId, placementHash: good.placementHash, requirement: "optional", replaces: [] }] }),
      body({ rows: [{ ...good, placementHash: "0".repeat(64) }, { kind: "preplaced", mappingVersionId: crypto.randomUUID(), placementHash: good.placementHash, requirement: "optional", replaces: [] }] }),
    ];
    for (const b of foreign) assert.deepEqual(shape(await post("/confirmations", W.caA, b)), NOT_FOUND);
    // A listed activation of another binding (club B's, and another team of club A): the identical 404.
    assert.deepEqual(shape(await post("/confirmations", W.caA, body({ rows: [{ ...good, replaces: [otherOn] }] }))), NOT_FOUND);
    assert.deepEqual(shape(await post("/confirmations", W.caA, body({ rows: [{ ...good, replaces: [crypto.randomUUID()] }] }))), NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// 2. A board that changed, and what is already on
// ---------------------------------------------------------------------------
test("3. a row that is stale or cannot be saved is refused by its place in the list, and nothing is written: another hash, another variable version, a placement the read refuses, a collision the row does not list, a listed activation that is gone or not in the way, a hidden OptiMove variable, an undone session", async () => {
  const { t, cand } = await freshTeam();
  const fTime = await field("time");
  const fDist = await field("dist");
  const vMin = await variable(W.caA, { unit: "min" });
  const vM = await variable(W.caA, { unit: "m" });
  const good = await newRow(W.caA, t, cand, fTime, vMin);
  const second = await newRow(W.caA, t, cand, fDist, vM);
  const fake = (f, target, over = {}) => ({ ...good, fieldId: f.fieldId, targetId: target.id, ...over });
  await nothingWritten(async () => {
    rowRefused(await save(W.caA, t, cand, [{ ...good, placementHash: "0".repeat(64) }]), "board_changed", 0);
    rowRefused(await save(W.caA, t, cand, [good, { ...second, placementHash: "f".repeat(64) }]), "board_changed", 1);
    // Another pair than the one the hash was read for.
    rowRefused(await save(W.caA, t, cand, [good], { pair: 1 }), "board_changed", 0);
    rowRefused(await save(W.caA, t, cand, [{ ...good, expectedTargetVersionId: crypto.randomUUID() }]), "canonical_version_changed", 0);
    refused(await save(W.caA, t, cand, [good], { pair: 9999 }), 409, "pair_out_of_range");
  });
  // A placement the read refuses is refused by the same code (a hash cannot be had for it).
  const vKg = await variable(W.caA, { unit: "kg" });
  const vSmall = await variable(W.caA, { unit: "min", maxValue: "10" });
  const fUnverified = await field("time", { verified: false });
  await nothingWritten(async () => {
    rowRefused(await save(W.caA, t, cand, [fake(fTime, vKg)]), "conversion_unavailable", 0);
    rowRefused(await save(W.caA, t, cand, [fake(fTime, vSmall)]), "value_outside_limits", 0);
    rowRefused(await save(W.caA, t, cand, [fake(fUnverified, vMin)]), "field_not_confirmed", 0);
    // An OptiMove variable is never a new row.
    refused(await save(W.caA, t, cand, [fake(W.fSysTime, W.sysMin)]), 400, "invalid_body");
    rowRefused(await save(W.caA, t, cand, [fake(fTime, W.sysMin)]), "target_scope_mismatch", 0);
  });
  // What is on and in the way must be listed, exactly.
  const sysOn = ok(await start(W.paA, W.sysTime, t), 201).activations[0].id;
  const vOther = await variable(W.caA, { unit: "min" });
  const onto = await newRow(W.caA, t, cand, W.fSysTime, vOther);
  assert.deepEqual(onto.replaces, [sysOn], "the read names the collision");
  const elsewhere = (await freshTeam());
  const idle = ok(await start(W.paA, W.sysTime, elsewhere.t), 201).activations[0].id;
  void idle;
  await nothingWritten(async () => {
    rowRefused(await save(W.caA, t, cand, [{ ...onto, replaces: [] }]), "activation_exists", 0);
    // A pre-placed row whose version is on already.
    rowRefused(await save(W.caA, t, cand, [{ kind: "preplaced", mappingVersionId: W.sysTime.versionId, placementHash: good.placementHash, requirement: "optional", replaces: [] }]), "activation_exists", 0);
    // An open activation that is not in the way of the row that lists it.
    rowRefused(await save(W.caA, t, cand, [{ ...good, replaces: [sysOn] }]), "board_changed", 0);
  });
  // The listed activation was switched off meanwhile.
  ok(await end(W.caA, sysOn));
  await nothingWritten(async () => { rowRefused(await save(W.caA, t, cand, [onto]), "activation_changed", 0); });
  // A hidden OptiMove variable: its pre-placed row is refused (the row was read before the hide).
  const other = await freshTeam();
  const hidden = await systemMapping();
  const pre = await preplacedRow(W.caA, other.t, other.cand, hidden);
  // A pre-placed row read for another pair, or with another hash, is stale too.
  await nothingWritten(async () => {
    rowRefused(await save(W.caA, other.t, other.cand, [{ ...pre, placementHash: "0".repeat(64) }]), "board_changed", 0);
    rowRefused(await save(W.caA, other.t, other.cand, [pre], { pair: 1 }), "board_changed", 0);
  });
  ok(await post(`/variables/${hidden.target.id}/hide`, W.caA, { requestKey: key() }));
  await nothingWritten(async () => { rowRefused(await save(W.caA, other.t, other.cand, [pre]), "variable_hidden", 0); });
  // An undone session is not a stored session: the identical 404.
  await planted(() => k.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now(), import_undone_at = now(), import_undone_request_id = gen_random_uuid() where id = $1`, [other.cand.id]));
  await nothingWritten(async () => { assert.deepEqual(shape(await save(W.caA, other.t, other.cand, [pre])), NOT_FOUND); });
});

test("4. what exists: the club's own active version of the same contract is reused (no new version, a checked row for it); a mapping with only a disabled version gets version 2; another contract of the mapping is mapping_version_active; a replacement ends what was on in the same operation and is not a switch-off, a manual end is", async () => {
  const { t, cand } = await freshTeam();
  // Reuse.
  const f = await field("time");
  const target = await variable(W.caA, { unit: "min" });
  const own = await activeVersion(W.caA, f, target);
  const row = await newRow(W.caA, t, cand, f, target);
  const before = await counts();
  const saved = ok(await save(W.caA, t, cand, [row])).confirmation;
  const after = await counts();
  assert.deepEqual([after.t3 - before.t3, after.t4 - before.t4, after.t5 - before.t5, after.t9i - before.t9i], [0, 0, 1, 1]);
  assert.deepEqual([saved.rows[0].versionId, saved.rows[0].mappingId], [own.versionId, own.mappingId]);
  assert.deepEqual(await one(`select item_kind, checked, mapping_version_id from ${T9I} where confirmation_id = $1`, [saved.id]), { item_kind: "club_mapping", checked: true, mapping_version_id: own.versionId });
  assert.equal((await one(`select activated_basis from ${T4} where id = $1`, [own.versionId])).activated_basis, "platform_admin", "the reused version is not written");
  // A mapping whose only version is disabled: the next version number.
  const f2 = await field("time");
  const target2 = await variable(W.caA, { unit: "min" });
  const old = await activeVersion(W.caA, f2, target2);
  ok(await post(`/mappings/${old.mappingId}/versions/${old.versionId}/disable`, await activatorOf(W.caA), { requestKey: key(), expectedStatus: "active", reason: "Disabled for the save test." }));
  const again = ok(await save(W.caA, t, cand, [await newRow(W.caA, t, cand, f2, target2)])).confirmation;
  assert.equal(again.rows[0].mappingId, old.mappingId);
  assert.deepEqual(await one(`select version_number, status, activated_basis from ${T4} where id = $1`, [again.rows[0].versionId]), { version_number: 2, status: "active", activated_basis: "club_admin" });
  // Another contract of the mapping (other levels) is active: nothing is replaced automatically.
  const f3 = await field("time");
  const target3 = await variable(W.caA, { unit: "min" });
  await activeVersion(W.caA, f3, target3, { drill: false });
  await nothingWritten(async () => { rowRefused(await save(W.caA, t, cand, [{ ...row, fieldId: f3.fieldId, targetId: target3.id }]), "mapping_version_active", 0); });

  // A replacement: OptiMove's mapping of a column is on; the club maps the same column onto its own variable.
  const r = await freshTeam();
  const sysOn = ok(await start(W.paA, W.sysTime, r.t), 201).activations[0].id;
  const mine = await variable(W.caA, { unit: "min" });
  const replacing = await newRow(W.caA, r.t, r.cand, W.fSysTime, mine);
  assert.deepEqual(replacing.replaces, [sysOn]);
  const done = ok(await save(W.caA, r.t, r.cand, [replacing])).confirmation;
  const endedRow = await one(`select a.ended_at is not null as ended, a.end_reason, a.ended_by_user_id, a.ended_basis from ${T5} a where a.id = $1`, [sysOn]);
  assert.deepEqual(endedRow, { ended: true, end_reason: "admin_ended", ended_by_user_id: W.caA.id, ended_basis: "club_admin" });
  const endAudit = await one(`select e.reason, e.request_key, e.operation_id = c.operation_id as same_operation from ${T8} e, ${T9} c where e.activation_id = $1 and e.action = 'activation_end' and c.id = $2`, [sysOn, done.id]);
  assert.deepEqual(endAudit, { reason: "Replaced on the drag-and-drop board.", request_key: null, same_operation: true });
  // The replaced mapping is not "switched off by an administrator": it is offered again, as a replacement of what replaced it.
  const board1 = ok(await boardOf(W.caA, r.t)).board;
  assert.equal(board1.switchedOff.some((x) => x.mappingVersionId === W.sysTime.versionId), false, "a replacement is not a switch-off");
  assert.deepEqual(board1.replaceable.filter((x) => x.mappingVersionId === W.sysTime.versionId).map((x) => x.replaces.map((c) => c.activationId)), [[done.rows[0].activationId]]);
  // A manual end of the successor: only the successor's mapping is switched off; OptiMove's is pre-placed again.
  ok(await end(W.caA, done.rows[0].activationId));
  const board2 = ok(await boardOf(W.caA, r.t)).board;
  assert.deepEqual(board2.switchedOff.map((x) => x.mappingVersionId), [done.rows[0].versionId]);
  assert.equal(board2.preplaced.some((x) => x.mappingVersionId === W.sysTime.versionId), true);
  // And a manual end of OptiMove's own activation is a switch-off.
  const m = await freshTeam();
  const manual = ok(await start(W.paA, W.sysTime, m.t), 201).activations[0].id;
  ok(await end(W.caA, manual));
  assert.deepEqual(ok(await boardOf(W.caA, m.t)).board.switchedOff.map((x) => x.mappingVersionId), [W.sysTime.versionId]);
});

// ---------------------------------------------------------------------------
// 3. Races (the hold seam), the COMMIT, and the lock order
// ---------------------------------------------------------------------------
test("5. races, each held between the save's plain read and its locks: a check that saw the session again, an undone import, an Unbind, a lost right, another admin's same placement and a hide each end the save with its stated answer and nothing of it written", async () => {
  const saveService = await import("../src/sourceMetricBoardSaveService.js");
  const during = async (step, change, run) => {
    let done = false;
    saveService.setBoardSaveHoldForTests(async (client, at) => { if (at === step && !done) { done = true; await change(); } });
    try { return await run(); } finally { saveService.setBoardSaveHoldForTests(null); }
  };
  const setup = async () => {
    const x = await freshTeam();
    const f = await field("time");
    const target = await variable(W.caA, { unit: "min" });
    return { ...x, f, target, row: await newRow(W.caA, x.t, x.cand, f, target) };
  };
  // A check of the team saw the session again.
  let s = await setup();
  let before = await counts();
  let res = await during("before_locks", async () => { const c = await check(s.t); await k.query(`update training_load.gpexe_import_candidates set last_seen_check_id = $2 where id = $1`, [s.cand.id, c]); }, () => save(W.caA, s.t, s.cand, [s.row]));
  refused(res, 409, "board_changed");
  assert.deepEqual({ ...(await counts()) }, before);
  // The session's import was undone.
  s = await setup();
  before = await counts();
  res = await during("before_locks", () => planted(() => k.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now(), import_undone_at = now(), import_undone_request_id = gen_random_uuid() where id = $1`, [s.cand.id])),
    () => save(W.caA, s.t, s.cand, [s.row]));
  refused(res, 409, "board_changed");
  assert.deepEqual({ ...(await counts()) }, before);
  // An Unbind.
  s = await setup();
  before = await counts();
  res = await during("before_locks", () => k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'Race test.' where id = $1`, [s.t.bindingId, W.pa.id]),
    () => save(W.caA, s.t, s.cand, [s.row]));
  refused(res, 409, "binding_not_active");
  assert.deepEqual({ ...(await counts()) }, before);
  // The admin's role is revoked: the identical 404.
  s = await setup();
  before = await counts();
  const lost = await clubAdmin(W.clubA, "Soon Revoked Admin");
  const lostRow = await newRow(lost, s.t, s.cand, s.f, s.target);
  res = await during("before_locks", () => k.query(`update public.user_club_roles set is_active = false where user_id = $1`, [lost.id]), () => save(lost, s.t, s.cand, [lostRow]));
  assert.deepEqual(shape(res), NOT_FOUND);
  assert.deepEqual({ ...(await counts()) }, before);
  // Another admin saves the same placement first: the second answers board_changed and writes nothing of its own.
  s = await setup();
  let firstSave = null;
  res = await during("before_locks", async () => { firstSave = await save(W.caA2, s.t, s.cand, [await newRow(W.caA2, s.t, s.cand, s.f, s.target)]); }, () => save(W.caA, s.t, s.cand, [s.row]));
  ok(firstSave);
  refused(res, 409, "board_changed");
  assert.equal((await one(`select count(*)::int as n from ${T9} where team_id = $1`, [s.t.teamId])).n, 1);
  assert.equal((await one(`select count(*)::int as n from ${T8} where performed_by_user_id = $1 and team_id = $2`, [W.caA.id, s.t.teamId])).n, 0);
  // Behind the save's own checks (held right before its first write): the database's guards are the backstop.
  // The unlocked candidate is seen again by a check: v65's guard of the session row refuses, answered board_changed.
  s = await setup();
  before = await counts();
  res = await during("before_writes", async () => { const c = await check(s.t); await k.query(`update training_load.gpexe_import_candidates set last_seen_check_id = $2 where id = $1`, [s.cand.id, c]); }, () => save(W.caA, s.t, s.cand, [s.row]));
  refused(res, 409, "board_changed");
  assert.deepEqual({ ...(await counts()) }, before);
  // The session was imported meanwhile (its status moved): board_changed on the save's own re-read.
  s = await setup();
  before = await counts();
  res = await during("before_locks", () => planted(() => k.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now() where id = $1`, [s.cand.id])), () => save(W.caA, s.t, s.cand, [s.row]));
  refused(res, 409, "board_changed");
  assert.deepEqual({ ...(await counts()) }, before);
  // A hide of the OptiMove variable lands before the save's hide lock.
  const h = await freshTeam();
  const toHide = await systemMapping();
  const pre = await preplacedRow(W.caA, h.t, h.cand, toHide);
  before = await counts();
  res = await during("before_hide_locks", async () => { ok(await post(`/variables/${toHide.target.id}/hide`, W.caA2, { requestKey: key() })); }, () => save(W.caA, h.t, h.cand, [pre]));
  rowRefused(res, "variable_hidden", 0);
  const now = await counts();
  assert.deepEqual([now.t5, now.t9, now.t4, now.t3], [before.t5, before.t9, before.t4, before.t3]);
});

test("6. the COMMIT (the five-point rule): an answer lost after the COMMIT is 200 verified_after_commit_error; a COMMIT that never reached the database is 503 outcome_unknown and the same key then saves; a failed read-back is 200 readError with the confirmation's id; a replay after an Unbind still answers, after the team is archived it is the identical 404", async () => {
  const service = await import("../src/sourceMetricMappingService.js");
  const setup = async () => {
    const x = await freshTeam();
    const f = await field("time");
    const target = await variable(W.caA, { unit: "min" });
    return { ...x, rows: [await newRow(W.caA, x.t, x.cand, f, target)] };
  };
  // The answer of the COMMIT is lost, the COMMIT happened.
  let s = await setup();
  let requestKey = key();
  service.setMappingCommitForTests({ fault: (c) => c.query("commit").then(() => { throw new Error("answer lost"); }), timeoutMs: 2_000 });
  let res;
  try { res = await save(W.caA, s.t, s.cand, s.rows, { requestKey }); } finally { service.setMappingCommitForTests(); }
  const verified = ok(res);
  assert.deepEqual([verified.commitConfirmation, verified.replayed, verified.confirmation.rows.length], ["verified_after_commit_error", false, 1]);
  assert.deepEqual(ok(await save(W.caA, s.t, s.cand, s.rows, { requestKey })).confirmation, verified.confirmation);
  // The COMMIT never reached the database.
  s = await setup();
  requestKey = key();
  const before = await counts();
  service.setMappingCommitForTests({ fault: () => Promise.reject(new Error("socket gone")), timeoutMs: 2_000, checkTimeoutMs: 2_000 });
  try { res = await save(W.caA, s.t, s.cand, s.rows, { requestKey }); } finally { service.setMappingCommitForTests(); }
  assert.deepEqual([res.status, res.body.error, res.body.requestKey], [503, "outcome_unknown", requestKey], res.text);
  assert.deepEqual({ ...(await counts()) }, before, "nothing was committed");
  const repeated = ok(await save(W.caA, s.t, s.cand, s.rows, { requestKey }));
  assert.deepEqual([repeated.replayed, repeated.confirmation.rows.length], [false, 1]);
  // A committed save whose answer cannot be read back.
  s = await setup();
  service.setMappingRereadFaultForTests(() => { throw new Error("read failed"); });
  try { res = await save(W.caA, s.t, s.cand, s.rows); } finally { service.setMappingRereadFaultForTests(null); }
  const unread = ok(res);
  assert.equal(unread.readError, true);
  assert.equal(unread.confirmationId, (await one(`select id from ${T9} where team_id = $1`, [s.t.teamId])).id);
  assert.equal(Object.hasOwn(unread, "confirmation"), false);
  // A replay's scope: after an Unbind it still answers; after the team is archived it is the 404.
  s = await setup();
  requestKey = key();
  const saved = ok(await save(W.caA, s.t, s.cand, s.rows, { requestKey })).confirmation;
  await k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'Replay test.' where id = $1`, [s.t.bindingId, W.pa.id]);
  const replay = ok(await post("/confirmations", W.caA, { requestKey, teamId: s.t.teamId, candidateId: s.cand.id, pair: 0, rows: s.rows }));
  assert.deepEqual([replay.replayed, replay.confirmation.id], [true, saved.id]);
  await k.query(`update public.teams set is_active = false where id = $1`, [s.t.teamId]);
  assert.deepEqual(shape(await post("/confirmations", W.caA, { requestKey, teamId: s.t.teamId, candidateId: s.cand.id, pair: 0, rows: s.rows })), NOT_FOUND);
});

test("7. the lock order (section 4.4), from the SQL the save sends: conversions, fields, revisions, mappings, versions, variables, their levels, the activations it ends, the binding, the team, the users row before the role row, the club, then the hide lock - all before the first write, and no locking clause between the first write and the COMMIT; the candidate is never locked", async () => {
  const { t, cand } = await freshTeam();
  // What is on: OptiMove's mapping (it will be replaced by a new row onto the club's variable).
  const sys1 = await systemMapping();
  const sysOn = ok(await start(W.paA, sys1, t), 201).activations[0].id;
  const mine = await variable(W.caA, { unit: "min" });
  const fDist = await field("dist");
  const vM = await variable(W.caA, { unit: "m" });
  // A second OptiMove mapping, to be switched on as it is (a hide lock).
  const fSys2 = await field("speed");
  const sysKmh = await variable(W.pa, { unit: "km/h", label: `OptiMove speed ${uid()}` });
  const sys2 = await activeVersion(W.pa, fSys2, sysKmh);
  // A reused club version (T4 FOR SHARE, T3 FOR NO KEY UPDATE).
  const fOwn = await field("time");
  const vOwn = await variable(W.caA, { unit: "min" });
  await activeVersion(W.caA, fOwn, vOwn);
  const rows = [
    await newRow(W.caA, t, cand, sys1, mine),
    await newRow(W.caA, t, cand, fDist, vM),
    await newRow(W.caA, t, cand, fOwn, vOwn),
    await preplacedRow(W.caA, t, cand, sys2),
  ];
  assert.deepEqual(rows[0].replaces, [sysOn]);
  // The two rows with an existing mapping (the reused one and the pre-placed one) in DESCENDING mapping id, so the
  // save's ascending order is its own and not the body's.
  const ownMapping = (await one(`select id from ${T3} where source_metric_definition_id = $1 and metric_definition_id = $2`, [fOwn.fieldId, vOwn.id])).id;
  if (ownMapping < sys2.mappingId) [rows[2], rows[3]] = [rows[3], rows[2]];
  const seen = [];
  const seenValues = [];
  const wrapped = [];
  const original = appPool.connect;
  appPool.connect = function (callback) {
    if (callback) return original.call(this, callback);
    return original.call(this).then((c) => {
      if (!wrapped.some((w) => w.c === c)) {
        const send = c.query;
        wrapped.push({ c, send });
        c.query = function (...args) {
          const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
          if (text) { seen.push(text.replace(/\s+/g, " ").trim()); seenValues.push(Array.isArray(args[1]) ? args[1] : args[0]?.values ?? []); }
          return send.apply(this, args);
        };
      }
      return c;
    });
  };
  let res;
  try { res = await save(W.caA, t, cand, rows); } finally {
    appPool.connect = original;
    for (const { c, send } of wrapped) c.query = send;
  }
  assert.equal(ok(res).confirmation.rows.length, 4);
  // The save's own transaction: from its actor setting to its COMMIT.
  const from = seen.findIndex((x) => x.includes("optimove.source_metric_actor"));
  const to = seen.findIndex((x, i) => i > from && /^commit$/i.test(x));
  assert.ok(from >= 0 && to > from, "the save's transaction was recorded");
  const tx = seen.slice(from, to);
  const txValues = seenValues.slice(from, to);
  // The statements that carry an athlete's value (the confirmation's items, the only ones naming the value columns)
  // run under their own lower statement bound, set right before the first and put back right after the last.
  const saveServiceModule = await import("../src/sourceMetricBoardSaveService.js");
  const mappingServiceModule = await import("../src/sourceMetricMappingService.js");
  const valueStatements = tx.map((x, i) => (/\braw_a\b|\bstored_a\b|\braw_b\b|\bstored_b\b/.test(x) ? i : -1)).filter((i) => i >= 0);
  assert.equal(valueStatements.length, 4, "one items insert per row of the save");
  assert.ok(valueStatements.every((i) => /^insert into training_load\.source_metric_confirmation_items\b/.test(tx[i])));
  assert.deepEqual(valueStatements, valueStatements.map((_, n) => valueStatements[0] + n), "one after another, nothing between them");
  assert.equal(saveServiceModule.VALUE_STATEMENT_TIMEOUT_MS, 5000);
  assert.ok(saveServiceModule.VALUE_STATEMENT_TIMEOUT_MS < mappingServiceModule.STATEMENT_TIMEOUT_MS);
  assert.equal(tx[valueStatements[0] - 1], `set local statement_timeout = '${saveServiceModule.VALUE_STATEMENT_TIMEOUT_MS}ms'`, "the lower bound is set right before");
  assert.equal(tx[valueStatements.at(-1) + 1], `set local statement_timeout = '${mappingServiceModule.STATEMENT_TIMEOUT_MS}ms'`, "and the transaction's bound right after");
  const bounds = tx.map((x, i) => (/^set local statement_timeout\b/.test(x) ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(bounds, [valueStatements[0] - 1, valueStatements.at(-1) + 1], "no other statement of the save's own work changes the bound");
  // Bind parameters with a value: only those statements carry the four numbers of a checked row.
  const checkedValues = (await rows_(`select trim_scale(raw_a)::text as a, trim_scale(stored_a)::text as b, trim_scale(raw_b)::text as c, trim_scale(stored_b)::text as d from ${T9I} where confirmation_id = $1 and checked`, [res.body.confirmation.id]));
  assert.ok(checkedValues.length >= 1);
  for (const row of checkedValues) {
    const four = Object.values(row).map(Number);
    const carriers = txValues.map((params, i) => (four.every((v) => params.some((x) => x !== null && x !== "" && typeof x !== "boolean" && Number(x) === v)) ? i : -1)).filter((i) => i >= 0);
    assert.ok(carriers.length >= 1 && carriers.every((i) => valueStatements.includes(i)), "the four values of a row travel only in an items insert");
  }
  const LOCKING = /\bfor (share|update|no key update|key share)\b|pg_advisory_xact_lock|\block table\b/i;
  const WRITE = /^(insert|update|delete)\b/i;
  const at = (re, after = -1) => { const i = tx.findIndex((x, n) => n > after && re.test(x)); assert.ok(i >= 0, `not sent: ${re}`); return i; };
  // The patterns are anchored on the service's exact SQL: a reworded statement fails here, never passes vacuously.
  const order = [
    ["conversions", /from training_load\.unit_conversions c where c\.state = 'active' .* order by c\.id for share$/],
    ["fields", /from training_load\.source_metric_definitions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["revisions", /from training_load\.source_metric_definition_versions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["a mapping", /from training_load\.source_metric_mappings where id = \$1 for (share|no key update)$/],
    ["versions", /from training_load\.source_metric_mapping_versions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["variables", /from training_load\.metric_definitions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["levels", /from training_load\.metric_definition_scope_capabilities where metric_definition_id = any\(\$1::uuid\[\]\) order by metric_definition_id, scope_level for share$/],
    ["activations to end", /from training_load\.source_metric_mapping_activations where id = any\(\$1::uuid\[\]\) and source_team_binding_id = \$2 order by id for no key update$/],
    ["binding", /from training_load\.source_team_bindings where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["team", /from public\.teams where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["users before role", /for share of u, (g|r)$/],
    // The rights check locks the admin's own club row, then the binding's club (the same row here).
    ["club", /from public\.clubs where id = (\$1 and coalesce\(is_active, true\)|any\(\$1::uuid\[\]\) order by id) for share$/],
    ["hide lock", /pg_advisory_xact_lock\(hashtextextended\('club-variable-hide:'/],
    ["one save per binding", /pg_advisory_xact_lock\(hashtextextended\('board-save:'/],
  ];
  let last = -1;
  const positions = {};
  for (const [name, re] of order) { last = at(re, last); positions[name] = last; }
  const firstWrite = tx.findIndex((x) => WRITE.test(x));
  assert.ok(firstWrite > positions["one save per binding"], "every lock comes before the first write");
  // The mappings are locked one by one: their ids ascend, whatever the order of the body's rows.
  const t3 = tx.map((x, i) => (/from training_load\.source_metric_mappings where id = \$1 for (share|no key update)$/.test(x) ? txValues[i][0] : null)).filter(Boolean);
  assert.equal(t3.length, 2);
  assert.deepEqual(t3, [...t3].sort(), "the mappings are locked in ascending id");
  assert.deepEqual(t3, [ownMapping, sys2.mappingId].sort());
  // Nothing locks out of order: every locking statement before the first write is one of the list, in a non-decreasing place.
  const placeOf = (x) => order.findIndex(([, re]) => re.test(x));
  const places = tx.slice(0, firstWrite).filter((x) => LOCKING.test(x)).map((x) => [placeOf(x), x]);
  assert.deepEqual(places.filter(([p]) => p < 0).map(([, x]) => x), [], "a lock the order does not know");
  assert.deepEqual(places.map(([p]) => p), [...places.map(([p]) => p)].sort((a, b) => a - b), "the locks are taken in D's order");
  assert.equal(places.filter(([p]) => p === 3).length, 2, "the existing mappings: the reused one and the pre-placed one");
  // No locking clause between the first write and the COMMIT.
  assert.deepEqual(tx.slice(firstWrite).filter((x) => LOCKING.test(x)), []);
  // The candidate, the team import lock and the v11 connection are never locked.
  assert.deepEqual(tx.filter((x) => LOCKING.test(x) && /gpexe_import_candidates|hold_gpexe_team_lock|metrics_core|source_credential_connections/.test(x)), []);
  // The writes, in step 16's order.
  const writes = tx.slice(firstWrite).filter((x) => WRITE.test(x)).map((x) => {
    const m = /^insert into training_load\.(\w+)/.exec(x) ?? /^update training_load\.(\w+)/.exec(x);
    const action = /values \('(\w+)'/.exec(x)?.[1] ?? (x.includes("source_metric_audit") ? "audit" : "");
    return `${x.startsWith("insert") ? "+" : "~"}${m?.[1] ?? "?"}${action && m?.[1] === "source_metric_audit" ? `:${action}` : ""}`;
  });
  const firstOf = (w) => writes.indexOf(w);
  const lastOf = (w) => writes.lastIndexOf(w);
  assert.ok(firstOf("+source_metric_mappings") === 0, writes.join(" "));
  assert.ok(lastOf("~source_metric_mapping_activations") < firstOf("+source_metric_confirmations"), "the ends before the confirmation");
  assert.ok(lastOf("+source_metric_confirmation_items") < writes.findIndex((w, i) => w === "~source_metric_mapping_versions" && i > firstOf("+source_metric_confirmations")), "the confirmation's rows before the activation of a version");
  assert.ok(writes.findIndex((w, i) => w === "~source_metric_mapping_versions" && i > firstOf("+source_metric_confirmations")) < firstOf("+source_metric_mapping_activations"), "the versions active before the starts");
  assert.equal(writes.at(-1), "+source_metric_audit:mapping_confirmation", "the keyed request record is the last write");
});

// ---------------------------------------------------------------------------
// 4. The stored values afterwards: erasure, the on-demand and the scheduled removal
// ---------------------------------------------------------------------------
// A saved confirmation of a fresh team with one checked row.
async function savedConfirmation() {
  const { t, cand } = await freshTeam();
  const f = await field("time");
  const target = await variable(W.caA, { unit: "min" });
  const id = ok(await save(W.caA, t, cand, [await newRow(W.caA, t, cand, f, target)])).confirmation.id;
  return { t, id };
}
const expire = (ids) => planted(() => k.query(`update ${T9} set confirmed_at = confirmed_at - interval '2184 hours', values_expire_at = values_expire_at - interval '2184 hours' where id = any($1::uuid[])`, [ids]));
const valuesOf = async (id) => one(`select raw_a is not null as held, values_salt is not null as salt, values_digest is not null as digest, values_removed_kind as kind, values_removed_by_user_id as by from ${T9I} where confirmation_id = $1 and checked`, [id]);

test("8. route 6, erasure on request: only a platform admin in the platform workspace (the confirmer and the club's admins get the identical 404); a fixed reason code, never text; the values and the salt are gone, the digest, who and when stay; once", async () => {
  const { id } = await savedConfirmation();
  const erase = (who, body, target = id) => post(`/confirmations/${target}/erase-values`, who, body);
  await nothingWritten(async () => {
    for (const who of [W.caA, W.caA2, W.caB, W.paA]) assert.deepEqual(shape(await erase(who, { requestKey: key(), reasonCode: "erasure_request" })), NOT_FOUND);
    assert.deepEqual(shape(await erase(W.pa, { requestKey: key(), reasonCode: "erasure_request" }, crypto.randomUUID())), NOT_FOUND);
    assert.deepEqual(shape(await erase(W.pa, { requestKey: key(), reasonCode: "erasure_request" }, "not-a-uuid")), NOT_FOUND);
    for (const body of [{}, { requestKey: key() }, { requestKey: key(), reasonCode: "because" }, { requestKey: key(), reasonCode: "The athlete asked." }, { requestKey: key(), reasonCode: "erasure_request", note: "x" }]) {
      refused(await erase(W.pa, body), 400, "invalid_body");
    }
  });
  assert.deepEqual(await valuesOf(id), { held: true, salt: true, digest: true, kind: null, by: null });
  const heldBefore = Object.values(await one(`select trim_scale(raw_a)::text as a, trim_scale(stored_a)::text as b, trim_scale(raw_b)::text as c, trim_scale(stored_b)::text as d from ${T9I} where confirmation_id = $1 and checked`, [id]));
  assert.ok(heldBefore.length === 4 && heldBefore.every((v) => v !== null));
  const requestKey = key();
  const res = await erase(W.pa, { requestKey, reasonCode: "erasure_request" });
  const body = ok(res);
  assert.deepEqual(body.confirmation.rows.map((r) => [r.valuesState, r.values]), [["erased", null]]);
  assert.deepEqual(valueLeaks(res.body, heldBefore), [], "the erased values are not in the answer");
  assert.deepEqual(await valuesOf(id), { held: false, salt: false, digest: true, kind: "erased", by: W.pa.id });
  assert.deepEqual(await one(`select action, reason, basis, performed_by_user_id from ${T8} where confirmation_id = $1 and action = 'confirmation_values_erased'`, [id]),
    { action: "confirmation_values_erased", reason: "erasure_request", basis: "platform_admin", performed_by_user_id: W.pa.id });
  // A replay; another body under the key; a second erasure.
  assert.equal(ok(await nothingWritten(() => erase(W.pa, { requestKey, reasonCode: "erasure_request" }))).replayed, true);
  refused(await erase(W.pa, { requestKey, reasonCode: "wrong_confirmation" }), 409, "request_key_reused");
  refused(await nothingWritten(() => erase(W.pa, { requestKey: key(), reasonCode: "wrong_confirmation" })), 409, "values_already_removed");
});

// Known (the Independent, 2026-11-18): this test fails when the file is run directly with
// `node --test --experimental-test-isolation=none` and passes through the T1 runner; the cause is not established yet (a
// follow-up). Run this suite through the runner.
test("9. route 7 and the scheduled removal: values past their date are removed in batches, under the admin's identity with one audit row per confirmation (the last keyed) or by the schedule with none; two runs never remove the same confirmation; a run that removes nothing writes nothing; the schedule starts nothing inside the test runner or without a database", async () => {
  const removal = await import("../src/sourceMetricConfirmationRemoval.js");
  const remove = (who, body = { requestKey: key() }) => post("/confirmations/expired-values/remove", who, body);
  // Start clean: whatever earlier tests left past its date is removed first.
  await removal.runExpiredRemoval();
  await nothingWritten(async () => {
    for (const who of [W.caA, W.caB, W.paA]) assert.deepEqual(shape(await remove(who)), NOT_FOUND);
    refused(await remove(W.pa, {}), 400, "invalid_body");
    refused(await remove(W.pa, { requestKey: key(), limit: 5 }), 400, "invalid_body");
    // Nothing is past its date: nothing removed, no row written.
    assert.deepEqual(ok(await remove(W.pa)), { removed: 0, more: false, replayed: false });
  });
  // Route 7: two expired confirmations, one not expired.
  const a = await savedConfirmation();
  const b = await savedConfirmation();
  const fresh = await savedConfirmation();
  await expire([a.id, b.id]);
  const requestKey = key();
  const out = ok(await remove(W.pa, { requestKey }));
  assert.deepEqual(out, { removed: 2, more: false, replayed: false });
  for (const id of [a.id, b.id]) assert.deepEqual(await valuesOf(id), { held: false, salt: false, digest: true, kind: "expired", by: W.pa.id });
  assert.deepEqual(await valuesOf(fresh.id), { held: true, salt: true, digest: true, kind: null, by: null });
  const audit = await rows_(`select confirmation_id, request_key from ${T8} where action = 'confirmation_values_expired' and confirmation_id = any($1::uuid[]) order by request_key nulls first`, [[a.id, b.id]]);
  assert.deepEqual(audit.map((r) => r.request_key), [null, requestKey]);
  assert.deepEqual(ok(await nothingWritten(() => remove(W.pa, { requestKey }))), { removed: 2, more: false, replayed: true });
  // The schedule: no acting user, no audit row, batch after batch until none is left.
  const many = [];
  for (let i = 0; i < 5; i += 1) many.push((await savedConfirmation()).id);
  await expire(many);
  const before = await counts();
  assert.deepEqual(await removal.runExpiredRemoval({ limit: 2 }), { skipped: false, removed: 5, batches: 3, failed: false });
  assert.equal((await counts()).t8, before.t8, "the schedule writes no audit row");
  for (const id of many) assert.deepEqual(await valuesOf(id), { held: false, salt: false, digest: true, kind: "expired", by: null });
  assert.deepEqual(await removal.runExpiredRemoval({ limit: 2 }), { skipped: false, removed: 0, batches: 1, failed: false });
  // Two runs at once (two server processes): the second skips what the first holds and removes only the rest.
  const three = [];
  for (let i = 0; i < 3; i += 1) three.push((await savedConfirmation()).id);
  await expire(three);
  const first = new pg.Client({ connectionString: db.url });
  await first.connect();
  try {
    await first.query("begin");
    const held = (await first.query(`select training_load.remove_expired_confirmation_values(2) as ids`)).rows[0].ids;
    assert.equal(held.length, 2);
    assert.equal(await removal.removeExpiredBatch({ limit: 10 }), 1, "the other run takes only the confirmation the first does not hold");
    await first.query("commit");
    assert.equal(await removal.removeExpiredBatch({ limit: 10 }), 0);
  } finally {
    await first.query("rollback").catch(() => {});
    await first.end();
  }
  for (const id of three) assert.equal((await valuesOf(id)).kind, "expired");
  assert.equal((await one(`select count(*)::int as n from ${T9I} where confirmation_id = any($1::uuid[]) and values_removed_at is not null`, [three])).n, 3, "each removed once");
  // A failing batch ends the run without throwing; one run at a time in a process.
  removal.setRemovalFaultForTests(() => { throw Object.assign(new Error("planted"), { code: "57014" }); });
  try { assert.deepEqual(await removal.runExpiredRemoval(), { skipped: false, removed: 0, batches: 0, failed: true }); } finally { removal.setRemovalFaultForTests(null); }
  let release;
  removal.setRemovalFaultForTests(() => new Promise((resolve) => { release = resolve; }), { boundMs: 5_000 });
  try {
    const running = removal.runExpiredRemoval();
    assert.deepEqual(await removal.runExpiredRemoval(), { skipped: true, removed: 0, batches: 0 });
    release();
    assert.equal((await running).failed, false);
  } finally { removal.setRemovalFaultForTests(null); }
  // The schedule itself: nothing inside the test runner, nothing without a database; otherwise unref'd timers that can be stopped.
  assert.ok(process.env.NODE_TEST_CONTEXT || process.env.OPTIMOVE_TEST_RUNNER, "this suite runs under node --test or the T1 runner");
  assert.equal(removal.startConfirmationRemovalSchedule().started, false);
  assert.equal(removal.startConfirmationRemovalSchedule({ env: { NODE_TEST_CONTEXT: "child", DATABASE_URL: "postgres://example.invalid/x" } }).started, false);
  assert.equal(removal.startConfirmationRemovalSchedule({ env: { OPTIMOVE_TEST_RUNNER: "1", DATABASE_URL: "postgres://example.invalid/x" } }).started, false);
  assert.equal(removal.startConfirmationRemovalSchedule({ env: { DATABASE_URL: "" } }).started, false);
  assert.equal(removal.startConfirmationRemovalSchedule({ env: {} }).started, false);
  // A disposable test database, as the e2e world's server has: nothing is started, whatever markers are missing.
  assert.equal(removal.startConfirmationRemovalSchedule({ env: { DATABASE_URL: "postgresql://u:p@localhost:5432/optimove_tests_e2e_abc123" } }).started, false);
  assert.equal(removal.startConfirmationRemovalSchedule({ env: { DATABASE_URL: db.url } }).started, false);
  assert.equal(removal.startConfirmationRemovalSchedule({ env: { DATABASE_URL: "not a url" } }).started, false, "an unreadable URL is not a database to run on");
  const on = removal.startConfirmationRemovalSchedule({ env: { DATABASE_URL: "postgres://example.invalid/x" }, startupDelayMs: 3_600_000 });
  assert.equal(on.started, true);
  on.stop();
});

test("10. the size cap of a board read: a stored session with more athlete rows x readable columns than the cap is refused with 409 board_too_large on the board, a placement and a save, before any value is read", async () => {
  const { t, cand } = await freshTeam();
  const f = await field("time");
  const target = await variable(W.caA, { unit: "min" });
  const row = await newRow(W.caA, t, cand, f, target);
  const readable = ok(await boardOf(W.caA, t)).board.columns.filter((c) => c.rawA !== null || c.rawB !== null).length;
  assert.ok(readable >= 4, "several readable columns");
  // The same session with many more athlete rows (empty objects: the cap is checked before any row is read).
  const { BOARD_MAX_CELLS } = boardService;
  const rowsNeeded = Math.floor(BOARD_MAX_CELLS / readable) + 1;
  await k.query(`update training_load.gpexe_import_candidates set raw_bundle = jsonb_set(raw_bundle, '{athleteSessions}', (select jsonb_agg('{}'::jsonb) from generate_series(1, $2::int))) where id = $1`, [cand.id, rowsNeeded]);
  // Named, the session answers for itself; with no session named it is passed by, and as the only one it is "none usable", by its reason.
  refused(await boardOf(W.caA, t, { candidateId: cand.id }), 409, "board_too_large");
  assert.deepEqual(refused(await boardOf(W.caA, t), 409, "no_usable_session").current, { reason: "board_too_large", tried: 1 });
  refused(await placement(W.caA, t, cand.id, f, target), 409, "board_too_large");
  await nothingWritten(async () => { refused(await save(W.caA, t, cand, [row]), 409, "board_too_large"); });
  // A foreign id is still the identical 404 first.
  assert.deepEqual(shape(await placement(W.caA, t, cand.id, f, W.vB)), NOT_FOUND);
});

test("11. the database's refusals a save maps (the backstop behind its own checks): every mapped text is raised, word for word, by a migration, and every mapped constraint exists; a lost right is the identical 404, a changed candidate and a raced row are board_changed, anything else is not a save's answer", async () => {
  const { classifySaveError, SAVE_DATABASE_REFUSALS } = await import("../src/sourceMetricBoardSaveService.js");
  const dir = path.resolve(__dirname, "../../migrations_v2");
  const sql = (await Promise.all((await fsp.readdir(dir)).filter((f) => f.endsWith(".sql")).map((f) => fsp.readFile(path.join(dir, f), "utf8")))).join("\n");
  const quoted = (text) => `'${text.replaceAll("'", "''")}'`;
  assert.ok(SAVE_DATABASE_REFUSALS.actorTexts.length >= 9 && SAVE_DATABASE_REFUSALS.candidateTexts.length >= 8 && SAVE_DATABASE_REFUSALS.racedConstraints.length >= 7);
  for (const text of SAVE_DATABASE_REFUSALS.actorTexts) {
    assert.ok(sql.includes(`raise exception ${quoted(text)}`), `a migration raises: ${text}`);
    const e = classifySaveError({ code: "42501", message: text });
    assert.deepEqual([e.status, e.code], [404, "notFound"], text);
  }
  for (const text of SAVE_DATABASE_REFUSALS.candidateTexts) {
    assert.ok(sql.includes(`raise exception ${quoted(text)}`), `a migration raises: ${text}`);
    const e = classifySaveError({ code: "23514", message: text });
    assert.deepEqual([e.status, e.code], [409, "board_changed"], text);
  }
  const constraints = new Set((await rows(`select conname as n from pg_constraint union select indexname from pg_indexes where schemaname = 'training_load'`)).map((r) => r.n));
  for (const name of SAVE_DATABASE_REFUSALS.racedConstraints) {
    assert.ok(constraints.has(name), `the constraint or index exists: ${name}`);
    const e = classifySaveError({ code: "23505", constraint: name, message: "duplicate key" });
    assert.deepEqual([e.status, e.code], [409, "board_changed"], name);
  }
  // Every v48 / v52 / v65 actor text a save's writes can meet is mapped (a new one fails here until it is added).
  const reachable = [...sql.matchAll(/raise exception '(source metric (?:confirmation|activation|mapping): [^']*(?:''[^']*)*)'\s+using errcode = '42501'/g)].map((m) => m[1].replaceAll("''", "'"));
  const unmapped = [...new Set(reachable)].filter((text) => !SAVE_DATABASE_REFUSALS.actorTexts.includes(text)).sort();
  assert.deepEqual(unmapped, [
    // The removal's (routes 6 and 7), mapped there.
    "source metric confirmation: the acting user may not remove these values",
    // Not a lost right but a defect of the caller (no actor set, a seed marker): they stay a 500.
    "source metric mapping: a seed marker is accepted only from the seeding migration",
    "source metric mapping: no acting user is set for this transaction",
    // The three the shared classifier already answers as the 404.
    "source metric mapping: the acting user is not an active admin of the mapping's club",
    "source metric mapping: the acting user is not an active platform admin",
    // A save never disables a version.
    "source metric mapping: the acting user may not disable this mapping version",
    "source metric mapping: the acting user may not submit this mapping version",
  ], "every other actor refusal a save's writes can meet is mapped");
  for (const text of unmapped.slice(3, 5).concat(unmapped.slice(6))) assert.equal(classifySaveError({ code: "42501", message: text }).status, 404, text);
  // Not a save's answer: another text with the same code, the same text with another code, a CHECK constraint's own violation.
  assert.ok((classifySaveError({ code: "42501", message: "permission denied for table x" })) == null);
  assert.ok((classifySaveError({ code: "23514", message: SAVE_DATABASE_REFUSALS.actorTexts[0] })) == null);
  assert.ok((classifySaveError({ code: "23514", constraint: "some_check", message: SAVE_DATABASE_REFUSALS.candidateTexts[0] })) == null);
  assert.ok((classifySaveError({ code: "23505", constraint: "another_key", message: "duplicate key" })) == null);
  assert.deepEqual([classifySaveError({ code: "40P01" }).code, classifySaveError({ code: "55P03" }).code], ["try_again", "try_again"]);
});

test("12. two admins save crossed rows of one team at the same moment, on free-running connections: one save per binding at a time, so exactly one is saved and the other answers a 409 of the board - never a deadlock, a try_again or a 500", async () => {
  for (let round = 0; round < 4; round += 1) {
    const { t, cand } = await freshTeam();
    const sysA = await systemMapping();
    const sysB = await systemMapping("dist", "m");
    const a = [await preplacedRow(W.caA, t, cand, sysA), await preplacedRow(W.caA, t, cand, sysB)];
    const b = [await preplacedRow(W.caA2, t, cand, sysB), await preplacedRow(W.caA2, t, cand, sysA)];
    const [ra, rb] = await Promise.all([save(W.caA, t, cand, a), save(W.caA2, t, cand, b)]);
    const statuses = [ra.status, rb.status].sort();
    assert.deepEqual(statuses, [200, 409], `${ra.text} / ${rb.text}`);
    const lost = ra.status === 409 ? ra : rb;
    assert.ok(["activation_exists", "board_changed"].includes(lost.body.error), lost.text);
    assert.equal((await one(`select count(*)::int as n from ${T5} where source_team_binding_id = $1 and ended_at is null`, [t.bindingId])).n, 2);
    assert.equal((await one(`select count(*)::int as n from ${T9} where team_id = $1`, [t.teamId])).n, 1);
  }
});

test("13. a value-carrying statement that runs past its own bound is cancelled: the save answers 409 try_again, nothing is written, and the next save goes through", async () => {
  const { t, cand } = await freshTeam();
  const vMin = await variable(W.caA, { unit: "min" });
  const rows = [await newRow(W.caA, t, cand, await field("time"), vMin)];
  const { VALUE_STATEMENT_TIMEOUT_MS } = await import("../src/sourceMetricBoardSaveService.js");
  // The items insert is held longer than its bound (and shorter than the transaction's), by a trigger of the test.
  await k.query(`create function training_load.test_slow_item() returns trigger language plpgsql as $f$ begin perform pg_sleep(${(VALUE_STATEMENT_TIMEOUT_MS + 1500) / 1000}); return new; end $f$`);
  await k.query(`create trigger test_slow_item before insert on ${T9I} for each row execute function training_load.test_slow_item()`);
  const started = Date.now();
  let res;
  try {
    await nothingWritten(async () => { res = await save(W.caA, t, cand, rows); });
  } finally {
    await k.query(`drop trigger test_slow_item on ${T9I}`);
    await k.query(`drop function training_load.test_slow_item()`);
  }
  const took = Date.now() - started;
  refused(res, 409, "try_again");
  assert.ok(took >= VALUE_STATEMENT_TIMEOUT_MS - 200 && took < VALUE_STATEMENT_TIMEOUT_MS + 1400, `cancelled at the value bound, not at the transaction's (${took} ms)`);
  assert.equal(ok(await save(W.caA, t, cand, rows)).confirmation.rows.length, 1);
});

test("C1 (calculated variables, J21): a calculated variable takes no column on the board - it is not placeable in the board's variables, a placement onto it answers target_not_usable, and a save that names it is refused with nothing written", async () => {
  const { t, cand } = await freshTeam();
  const fCol = await field("dist");
  const a = await variable(W.caA, { unit: "m" });
  const b = await variable(W.caA, { unit: "m" });
  const made = await post("/variables", W.caA, { requestKey: key(), label: `Calculated ${uid()}`, unit: "m", levels: ["session", "drill"], dailyAggregationMethod: "sum", calculation: { kind: "sum", inputs: [a.id, b.id] } });
  assert.equal(made.status, 201, made.text);
  const calc = { id: made.body.variable.id };
  const board = ok(await boardOf(W.caA, t, { candidateId: cand.id })).board;
  const listed = board.variables.find((v) => v.id === calc.id);
  assert.equal(listed?.placeable, false, "listed, never placeable");
  assert.equal(board.variables.find((v) => v.id === a.id)?.placeable, true, "its input of the same unit is placeable");
  const plain = await placementOf(W.caA, t, cand, fCol, a);
  assert.equal(plain.placeable, true, `the same column onto an ordinary variable of the unit is placeable (${JSON.stringify(plain)})`);
  const p = await placementOf(W.caA, t, cand, fCol, calc);
  assert.deepEqual([p.placeable, p.code], [false, "target_not_usable"]);
  const row = await newRow(W.caA, t, cand, fCol, a);
  await nothingWritten(async () => {
    rowRefused(await save(W.caA, t, cand, [{ ...row, targetId: calc.id, expectedTargetVersionId: made.body.variable.currentVersion.id }]), "target_not_usable", 0);
  });
});

test("Z4 (the review of PR #602): a zone mapping that is not on for the team is never placed again from the board - the placement read and a save's pre-placed row both answer field_has_parameters, and nothing is written", async () => {
  const { t, cand } = await freshTeam();
  const fZone = await field("zone");
  const target = await variable(W.pa, { unit: "m", label: `OptiMove zone ${uid()}` });
  // An active OptiMove version of the zone column (on for no team: as after a switch-off), planted from an active
  // version's own rows with the zone's revision and bounds (the routes need a canonical condition this suite has no use for).
  // A copy of a row with some columns replaced; generated columns are left to the table.
  const copyRow = async (table, id, set) => {
    const [schema, name] = table.split(".");
    const cols = (await k.query(`select column_name from information_schema.columns where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' order by ordinal_position`, [schema, name])).rows.map((c) => c.column_name);
    const list = cols.map((c) => `"${c}"`).join(", ");
    return (await one(`insert into ${table} (${list}) select ${list} from jsonb_populate_record(null::${table}, (select to_jsonb(x) || $2::jsonb from ${table} x where x.id = $1)) returning id`,
      [id, JSON.stringify({ id: crypto.randomUUID(), ...set })])).id;
  };
  const versionId = await planted(async () => {
    const mappingId = await copyRow(T3, W.sysTime.mappingId, { source_metric_definition_id: fZone.fieldId, metric_definition_id: target.id });
    const targetVersion = (await one(`select current_version_id from training_load.metric_definitions where id = $1`, [target.id])).current_version_id;
    return copyRow(T4, W.sysTime.versionId, { mapping_id: mappingId, source_metric_definition_id: fZone.fieldId, source_metric_version_id: fZone.revId,
      metric_definition_id: target.id, metric_definition_version_id: targetVersion, parameter_kind: "zone_bounds",
      source_parameters: { operator: "between", lower: 20, upper: 25, unit: "W/kg" }, canonical_parameters: { operator: "between", lower: 20, upper: 25, unit: "W/kg" },
      parameter_fingerprint: `v1:${"a".repeat(64)}` });
  });
  assert.equal((await one(`select status, parameter_kind from ${T4} where id = $1`, [versionId])).status, "active");
  const board = ok(await boardOf(W.caA, t, { candidateId: cand.id })).board;
  assert.equal([...board.preplaced, ...board.replaceable].some((x) => x.mappingVersionId === versionId), false, "never offered as a pre-placed row");
  const own = await variable(W.caA, { unit: "m" });
  await nothingWritten(async () => {
    // Add by hand: an OptiMove variable is never placed by the club (only its own mapping, which the board does not
    // offer for a zone column); the club's own variable is refused for the zone column itself.
    assert.deepEqual(await placementOf(W.caA, t, cand, fZone, target), { placeable: false, code: "target_scope_mismatch", fieldId: fZone.fieldId, targetId: target.id });
    assert.equal((await placementOf(W.caA, t, cand, fZone, own)).code, "field_has_parameters");
    rowRefused(await save(W.caA, t, cand, [{ kind: "preplaced", mappingVersionId: versionId, placementHash: "0".repeat(64), requirement: "optional", replaces: [] }]), "field_has_parameters", 0);
  });
});

test("CM (the review of 2026-11-18): a field without a condition never fills a variable with one - creating its mapping version is refused for a platform admin and a club admin, activating an existing one is refused, starting it for a team (S1) is refused, and the board's save never switches one on; nothing written", async () => {
  const cond = { kind: "zone", operator: ">=", value: "25.2", unit: "km/h" };
  const fSys = await field("dist");
  const fClub = await field("dist");
  const sysCond = await variable(W.pa, { unit: "m", condition: cond, label: `OptiMove sprint ${uid()}` });
  const clubCond = await variable(W.caA, { unit: "m", condition: cond, label: `Club sprint ${uid()}` });
  const versionCount = async () => (await one(`select count(*)::int n from ${T4}`)).n;
  // Creating the version: both bases, the identical code and nothing written.
  const cases = [[W.pa, fSys, sysCond], [W.caA, fClub, clubCond]];
  const mappings = [];
  for (const [who, f, target] of cases) {
    const m = await post("/mappings", who, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id });
    assert.equal(m.status, 201, m.text);
    mappings.push(m.body.mapping.id);
    const before = await versionCount();
    const res = await post(`/mappings/${m.body.mapping.id}/versions`, who, { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true, conversionNote: "Converted by the active unit conversion." });
    assert.deepEqual([res.status, res.body.error], [409, "condition_mismatch"], res.text);
    assert.equal(await versionCount(), before, "nothing written");
  }
  // The same field onto a variable without a condition still works (the control).
  const free = await variable(W.pa, { unit: "m", label: `OptiMove distance ${uid()}` });
  const control = await post("/mappings", W.pa, { requestKey: key(), sourceMetricId: fSys.fieldId, metricDefinitionId: free.id });
  assert.equal(control.status, 201, control.text);
  const controlVersion = await post(`/mappings/${control.body.mapping.id}/versions`, W.pa, { requestKey: key(), sourceRevisionId: fSys.revId, appliesToSession: true, appliesToDrill: true, conversionNote: "Converted by the active unit conversion." });
  assert.equal(controlVersion.status, 201, controlVersion.text);
  // An existing version (planted, as a raw writer or an older backend could have left it): activation is refused.
  const copyVersion = async (mappingId, f, target, set) => planted(async () => {
    const cols = (await k.query(`select column_name from information_schema.columns where table_schema = 'training_load' and table_name = 'source_metric_mapping_versions' and is_generated = 'NEVER' order by ordinal_position`)).rows.map((c) => `"${c.column_name}"`).join(", ");
    const targetVersion = (await one(`select current_version_id from training_load.metric_definitions where id = $1`, [target.id])).current_version_id;
    return (await one(`insert into ${T4} (${cols}) select ${cols} from jsonb_populate_record(null::${T4}, (select to_jsonb(x) || $2::jsonb from ${T4} x where x.id = $1)) returning id`,
      [controlVersion.body.version.id, JSON.stringify({ id: crypto.randomUUID(), mapping_id: mappingId, source_metric_definition_id: f.fieldId, source_metric_version_id: f.revId,
        metric_definition_id: target.id, metric_definition_version_id: targetVersion, version_number: 1, ...set })])).id;
  });
  const submitted = { status: "needs_review", submitted_by_user_id: W.pa.id, submitted_at: new Date().toISOString(), submitted_basis: "platform_admin",
    activated_by_user_id: null, activated_at: null, activated_basis: null };
  const pendingSys = await copyVersion(mappings[0], fSys, sysCond, submitted);
  const pendingClub = await copyVersion(mappings[1], fClub, clubCond, submitted);
  for (const [who, mappingId, versionId] of [[W.pa, mappings[0], pendingSys], [W.paA, mappings[1], pendingClub]]) {
    const before = await one(`select status from ${T4} where id = $1`, [versionId]);
    const res = await post(`/mappings/${mappingId}/versions/${versionId}/activate`, who, { requestKey: key(), expectedActiveVersionId: null });
    assert.deepEqual([res.status, res.body.error], [409, "condition_mismatch"], res.text);
    assert.deepEqual(await one(`select status from ${T4} where id = $1`, [versionId]), before, "still waiting, never active");
  }
  // An active OptiMove version of it (planted): the club board's save never switches it on.
  const activeSys = await copyVersion(mappings[0], fSys, sysCond, { status: "active", version_number: 2, submitted_by_user_id: W.pa.id, submitted_at: new Date().toISOString(), submitted_basis: "platform_admin",
    activated_by_user_id: W.pa.id, activated_at: new Date().toISOString(), activated_basis: "platform_admin" });
  await k.query(`delete from ${T4} where id = $1`, [pendingSys]).catch(() => {});
  const { t, cand } = await freshTeam();
  // S1 refuses it too (the Independent's LOW on PR #609), for a platform admin and the club's admin; no activation written.
  const activations = async () => (await one(`select count(*)::int n from training_load.source_metric_mapping_activations`)).n;
  for (const who of [W.pa, W.caA]) {
    const before = await activations();
    const res = await start(who, { mappingId: mappings[0], versionId: activeSys }, t);
    assert.deepEqual([res.status, res.body.error], [409, "condition_mismatch"], res.text);
    assert.equal(await activations(), before);
  }
  await nothingWritten(async () => {
    rowRefused(await save(W.caA, t, cand, [{ kind: "preplaced", mappingVersionId: activeSys, placementHash: "0".repeat(64), requirement: "optional", replaces: [] }]), "condition_mismatch", 0);
  });
  // The code review of 2026-11-18 (MEDIUM): every way in, not one. The board never offers it, the placement of the
  // column on that OptiMove variable refuses it, and a save naming the column and the variable refuses it too.
  const b = ok(await boardOf(W.caA, t, { candidateId: cand.id })).board;
  assert.equal([...b.preplaced, ...b.replaceable].some((x) => x.mappingVersionId === activeSys), false, "not offered");
  const shown = b.variables.find((x) => x.id === sysCond.id);
  if (shown) assert.deepEqual([shown.placeable, shown.filledByFieldIds], [false, []]);
  assert.deepEqual(await placementOf(W.caA, t, cand, fSys, sysCond), { placeable: false, code: "condition_mismatch", fieldId: fSys.fieldId, targetId: sysCond.id });
  await nothingWritten(async () => {
    rowRefused(await save(W.caA, t, cand, [{ kind: "new", fieldId: fSys.fieldId, targetId: sysCond.id, expectedTargetVersionId: (await one(`select current_version_id from training_load.metric_definitions where id = $1`, [sysCond.id])).current_version_id, displayUnit: "m",
      placementHash: "0".repeat(64), checked: true, requirement: "optional", replaces: [] }]), "condition_mismatch", 0);
  });
});

// ---------------------------------------------------------------------------
// v80 step B (docs/ai/v80-condition-match-plan.md): a column without parameters fills a variable with a condition when
// the team's GPEXE setting matches - the board, the placement, the save, S1, A1 and the owner's confirmation of an event
// setting. Real GPEXE details keys (the rule is read from the key); the session's team setting is the stored bundle's
// teamThresholds (power 20/25/60/75 W/kg, events +-2.5 m/s2 for 0.3 s, set 1473), planted per test where it differs.
// ---------------------------------------------------------------------------
const ZONE3_KEY = "details.players.athletesessionpowerzone_distance_3";
const ACC_KEY = "details.players.acceleration_events";
const realFields = new Map();
// A details field with a real key, proven by a document (unit and meaning), active: read through the generic details entry.
async function realField(fieldKey, unit) {
  if (!realFields.has(fieldKey)) {
    const fieldId = (await one(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,$2,$3) returning id`,
      [fieldKey, `GPEXE ${fieldKey.split(".").at(-1)}`, W.pa.id])).id;
    const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: "unit_value_object", parameterKind: "none", evidenceRef: COMPAT, unit, unitRef: UNIT_REF, meaning: true, meaningRef: MEANING_REF, state: "active" });
    realFields.set(fieldKey, { fieldId, revId, key: fieldKey });
  }
  return realFields.get(fieldKey);
}
// The stored session's details values of the two real columns for every athlete (distinct, non-zero), and its team setting.
async function plantSession(cand, { thresholds = {} } = {}) {
  const bundle = (await one(`select raw_bundle from training_load.gpexe_import_candidates where id = $1`, [cand.id])).raw_bundle;
  const ids = Object.keys(bundle.details.full.players).sort();
  ids.forEach((id, i) => Object.assign(bundle.details.full.players[id], {
    athletesessionpowerzone_distance_3: { unit: "distance", value: 140.5 + 10 * i },
    acceleration_events: { unit: "number", value: 14 + i },
  }));
  Object.assign(bundle.teamThresholds, thresholds);
  await k.query(`update training_load.gpexe_import_candidates set raw_bundle = $2 where id = $1`, [cand.id, bundle]);
}
async function plantedTeam(opts = {}) {
  let t, cand;
  if (opts.clubId) {
    t = await gpexeTeam(opts.clubId);
    for (const n of [1, 2, 3]) await link(t, n, `${NAMES[n]} ${uid()}`);
    cand = await candidate(t);
  } else {
    ({ t, cand } = await freshTeam());
  }
  await plantSession(cand, opts);
  return { t, cand, name: (await one(`select name from public.teams where id = $1`, [t.teamId])).name };
}
const V80 = {};
const ZONE_25_60 = { kind: "zone", operator: "between", lower: "25", upper: "60", unit: "W/kg" };
const ACC_03 = { kind: "event_threshold", operator: ">=", value: "2.5", durationSeconds: "0.3", unit: "m/s2" };
const placementRaw = async (who, t, cand, f, target) => ok(await placement(who, t, cand.id, f, target)).placement;
const noMatchLeaks = (text) => {
  // Keys only (a set id like 1473 can occur inside a random UUID by chance, so values are not searched as text).
  for (const needle of ["conditionMatch", "conditionRule", "matched", "condition_raw", "setId", "\"min\":", "\"max\":"]) assert.equal(text.includes(needle), false, needle);
};
const activationRow = (id) => one(`select a.matched_condition, a.matched_source_range, a.matched_threshold_set_id, a.matched_at is not null as at, v.condition_rule
  from ${T5} a join ${T4} v on v.id = a.mapping_version_id where a.id = $1`, [id]);

test("V80-1. a numbered zone column on a club variable with that zone: offered, placed and saved for the team whose setting matches - the version carries its rule, the activation its match; a variable with another zone is refused naming both; nothing of the match leaves the server", async () => {
  const fZone = await realField(ZONE3_KEY, "m");
  const { t, cand, name } = await plantedTeam();
  const zone = await variable(W.caA, { unit: "m", label: `Zone three ${uid()}`, condition: ZONE_25_60 });
  const other = await variable(W.caA, { unit: "m", label: `Zone wide ${uid()}`, condition: { ...ZONE_25_60, lower: "20" } });
  const boardRes = await boardOf(W.caA, t, { candidateId: cand.id });
  const board = ok(boardRes).board;
  const row = (v) => board.variables.find((x) => x.id === v.id);
  assert.deepEqual([row(zone).placeable, row(zone).matchingFieldIds], [true, [fZone.fieldId]]);
  assert.deepEqual([row(other).placeable, row(other).matchingFieldIds], [false, []]);
  noMatchLeaks(boardRes.text);
  const pRes = await placement(W.caA, t, cand.id, fZone, zone);
  const p = ok(pRes).placement;
  assert.equal(p.placeable, true, JSON.stringify(p));
  noMatchLeaks(pRes.text);
  const refusedOther = await placementRaw(W.caA, t, cand, fZone, other);
  assert.deepEqual([refusedOther.placeable, refusedOther.code], [false, "team_setting_mismatch"]);
  assert.equal(refusedOther.message, `This column counts the zone 25–60 W/kg (${name}'s setting in GPEXE); ${other.label} counts the zone 20–60 W/kg. Choose a variable with the same setting, or change the team's setting in GPEXE.`);
  // The save.
  const saved = ok(await save(W.caA, t, cand, [await newRow(W.caA, t, cand, fZone, zone)]));
  V80.zone = { mappingId: saved.confirmation.rows[0].mappingId, versionId: saved.confirmation.rows[0].versionId, variable: zone };
  const a = await activationRow(saved.confirmation.rows[0].activationId);
  assert.deepEqual(a, {
    matched_condition: { operator: "between", min: 25, max: 60, unit: "W/kg" },
    matched_source_range: { max: "60", min: "25", operator: "between", unit: "W/kg" },
    matched_threshold_set_id: "1473", at: true, condition_rule: { family: "power", kind: "zone", zone: 3 },
  });
  // A save naming the other variable is refused by its row, nothing written.
  await nothingWritten(async () => {
    const res = await save(W.caA, t, cand, [{ kind: "new", fieldId: fZone.fieldId, targetId: other.id, expectedTargetVersionId: (await one(`select current_version_id from training_load.metric_definitions where id = $1`, [other.id])).current_version_id,
      displayUnit: "m", placementHash: "0".repeat(64), checked: true, requirement: "optional", replaces: [] }]);
    rowRefused(res, "team_setting_mismatch", 0);
  });
});

test("V80-2. two teams of one club with different settings: the club's version is switched on (S1) for the team whose zone matches and refused, naming the binding, for the team whose zone 3 is 25-65 W/kg and for a team with no stored session; the board of the other team does not offer it", async () => {
  // Club B (club A maps the zone column in V80-1 already: one active target per owner and field).
  const fZone = await realField(ZONE3_KEY, "m");
  const paB = await platformAdmin(["club", W.clubB]);
  const first = await plantedTeam({ clubId: W.clubB });
  const second = await plantedTeam({ clubId: W.clubB, thresholds: { power_thresholds: [20, 25, 65, 75] } });
  const zone = await variable(W.caB, { unit: "m", label: `Zone three two ${uid()}`, condition: ZONE_25_60 });
  const saved = ok(await save(W.caB, first.t, first.cand, [await newRow(W.caB, first.t, first.cand, fZone, zone)]));
  const v = { mappingId: saved.confirmation.rows[0].mappingId, versionId: saved.confirmation.rows[0].versionId };
  const before = await counts();
  const res = await start(paB, v, second.t);
  assert.deepEqual([res.status, res.body.error, res.body.current?.bindingId], [409, "team_setting_mismatch", second.t.bindingId], res.text);
  // The refusal names both settings (the code review of v80).
  assert.equal(res.body.message, `This column counts the zone 25–65 W/kg (${second.name}'s setting in GPEXE); ${zone.label} counts the zone 25–60 W/kg. Choose a variable with the same setting, or change the team's setting in GPEXE.`);
  assert.deepEqual(await counts(), before, "nothing written");
  const p = await placementRaw(W.caB, second.t, second.cand, fZone, zone);
  assert.deepEqual([p.placeable, p.code], [false, "team_setting_mismatch"]);
  assert.match(p.message, /the zone 25–65 W\/kg .* counts the zone 25–60 W\/kg/);
  assert.equal(ok(await boardOf(W.caB, second.t, { candidateId: second.cand.id })).board.variables.find((x) => x.id === zone.id).placeable, false);
  // A team with no stored session: nothing to check against.
  const bare = await gpexeTeam(W.clubB);
  const missing = await start(paB, v, bare);
  assert.deepEqual([missing.status, missing.body.error, missing.body.current?.bindingId], [409, "team_setting_missing", bare.bindingId], missing.text);
  // The same version for a third team whose setting matches: switched on with its own match.
  const third = await plantedTeam({ clubId: W.clubB });
  const started = await start(paB, v, third.t);
  assert.ok([200, 201].includes(started.status), started.text);
  const opened = await openOn(v, third.t);
  assert.deepEqual((await activationRow(opened.id)).matched_source_range, { max: "60", min: "25", operator: "between", unit: "W/kg" });
});

test("V80-3. OptiMove's own mapping through the routes: a version of a zone column on an OptiMove zone variable is created with its rule (on an event variable: condition_mismatch); A1 switches it on for a listed team that matches, and refuses the whole activation for a listed team that does not", async () => {
  const fZone = await realField(ZONE3_KEY, "m");
  const sysZone = await variable(W.pa, { unit: "m", label: `OptiMove zone three ${uid()}`, condition: ZONE_25_60 });
  const sysAcc = await variable(W.pa, { unit: "count", label: `OptiMove accelerations ${uid()}`, condition: ACC_03 });
  const make = async (target) => {
    const m = ok(await post("/mappings", W.pa, { requestKey: key(), sourceMetricId: fZone.fieldId, metricDefinitionId: target.id }), 201).mapping;
    return { m, res: await post(`/mappings/${m.id}/versions`, W.pa, { requestKey: key(), sourceRevisionId: fZone.revId, appliesToSession: true, appliesToDrill: true }) };
  };
  const wrong = await make(sysAcc);
  assert.deepEqual([wrong.res.status, wrong.res.body.error], [409, "condition_mismatch"], wrong.res.text);
  const { m, res } = await make(sysZone);
  const version = ok(res, 201).version;
  assert.deepEqual((await one(`select condition_rule from ${T4} where id = $1`, [version.id])).condition_rule, { family: "power", kind: "zone", zone: 3 });
  assert.equal(res.text.includes("condition_rule") || res.text.includes("conditionRule"), false, "the answer is unchanged");
  ok(await post(`/mappings/${m.id}/versions/${version.id}/submit`, W.pa, { requestKey: key() }));
  const good = await plantedTeam();
  const bad = await plantedTeam({ thresholds: { power_thresholds: [20, 30, 60, 75] } });
  const activate = (teams) => post(`/mappings/${m.id}/versions/${version.id}/activate`, W.pa, { requestKey: key(), expectedActiveVersionId: null,
    activations: teams.map((x) => ({ bindingId: x.t.bindingId, requirement: "optional" })), activationReason: `A1 ${uid()}.` });
  const before = await counts();
  const refusedA1 = await activate([good, bad]);
  assert.deepEqual([refusedA1.status, refusedA1.body.error, refusedA1.body.current?.bindingId], [409, "team_setting_mismatch", bad.t.bindingId], refusedA1.text);
  assert.deepEqual(await counts(), before, "the whole activation is refused: nothing written, the version still waits");
  assert.equal((await one(`select status from ${T4} where id = $1`, [version.id])).status, "needs_review");
  ok(await activate([good]));
  const opened = await openOn({ versionId: version.id }, good.t);
  assert.deepEqual(await activationRow(opened.id), {
    matched_condition: { operator: "between", min: 25, max: 60, unit: "W/kg" }, matched_source_range: { max: "60", min: "25", operator: "between", unit: "W/kg" },
    matched_threshold_set_id: "1473", at: true, condition_rule: { family: "power", kind: "zone", zone: 3 },
  });
});

test("V80-4. a GPEXE events column: matched only after the owner confirmed the team's event setting (route O's session first; two numbers and Confirm); the route is the platform administrator's in the platform workspace only; a refusal names GPEXE's own setting; then the column fills a variable with that setting and not one of 0.5 s", async () => {
  const fAcc = await realField(ACC_KEY, "count");
  const { t, cand, name } = await plantedTeam();
  const acc = await variable(W.caA, { unit: "count", label: `Accelerations ${uid()}`, condition: ACC_03 });
  const slow = await variable(W.caA, { unit: "count", label: `Long accelerations ${uid()}`, condition: { ...ACC_03, durationSeconds: "0.5" } });
  const before = await placementRaw(W.caA, t, cand, fAcc, acc);
  assert.deepEqual([before.placeable, before.code], [false, "event_setting_not_confirmed"]);
  assert.equal(ok(await boardOf(W.caA, t, { candidateId: cand.id })).board.variables.find((x) => x.id === acc.id).placeable, false);
  // A club version of the events column made through the routes, then S1 before the owner's confirmation: refused.
  const accMapping = ok(await post("/mappings", W.caA, { requestKey: key(), sourceMetricId: fAcc.fieldId, metricDefinitionId: acc.id }), 201).mapping;
  const accVersion = ok(await post(`/mappings/${accMapping.id}/versions`, W.caA, { requestKey: key(), sourceRevisionId: fAcc.revId, appliesToSession: true, appliesToDrill: true }), 201).version;
  ok(await post(`/mappings/${accMapping.id}/versions/${accVersion.id}/submit`, W.caA, { requestKey: key() }));
  ok(await post(`/mappings/${accMapping.id}/versions/${accVersion.id}/activate`, W.paA, { requestKey: key(), expectedActiveVersionId: null }));
  const early = await start(W.paA, { mappingId: accMapping.id, versionId: accVersion.id }, t);
  assert.deepEqual([early.status, early.body.error, early.body.current?.bindingId], [409, "event_setting_not_confirmed", t.bindingId], early.text);
  const url = `/fields/${fAcc.fieldId}/revisions/${fAcc.revId}/event-setting-confirmation`;
  const body = (thresholdValue, durationSeconds, requestKey = key()) => ({ requestKey, thresholdValue, durationSeconds });
  // The audience: only a platform administrator in the platform workspace; everyone else the identical 404.
  for (const who of [W.caA, W.paA]) assert.deepEqual(shape(await post(url, who, body("2.5", "0.3"))), NOT_FOUND);
  // Not compared through route O yet.
  refused(await post(url, W.pa, body("2.5", "0.3")), 409, "not_compared");
  // v80 step C0: the field detail says the state of the confirmation, to the field read's audience only.
  const detailOf = async (who) => ok(await get(`/fields/${fAcc.fieldId}`, who));
  for (const who of [W.pa, W.caA]) {
    // sessionKept is the platform administrator's only (the compared session may be another club's team).
    assert.deepEqual((await detailOf(who)).eventSetting, { event: "acceleration", revisionId: fAcc.revId, compared: false, sessionKept: who === W.pa ? false : null, confirmation: null });
  }
  const coach = { id: await user("coach") };
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coach.id, t.teamId]);
  await workspace(coach.id, "team", t.teamId);
  coach.cookie = await cookieFor(coach.id);
  assert.deepEqual(shape(await get(`/fields/${fAcc.fieldId}`, coach)), NOT_FOUND, "a coach gets the identical 404");
  assert.equal("eventSetting" in (await detailOf(W.pa)) && "eventSetting" in ok(await get(`/fields/${(await field("time")).fieldId}`, W.pa)), false, "only an events column carries it");
  // The revision proven by a comparison (route O) in a session of this team (planted as route O leaves it).
  const fTime = await field("time");
  const vMin = await variable(W.caA, { unit: "min" });
  const compared = ok(await save(W.caA, t, cand, [await newRow(W.caA, t, cand, fTime, vMin)])).confirmation.id;
  await planted(() => k.query(`update training_load.source_metric_definition_versions set evidence_status = 'source_stated', evidence_ref = null,
    unit_evidence_ref = null, unit_observation_id = $2, meaning_evidence_ref = null, meaning_observation_id = $2 where id = $1`, [fAcc.revId, compared]));
  // Compared, not confirmed: the detail never carries the compared session's setting before Confirm (the Rukovodilac's
  // condition on C1: not shown, and not in the answer either); the board names the column that waits for the confirmation.
  const waiting = await get(`/fields/${fAcc.fieldId}`, W.pa);
  assert.deepEqual(ok(waiting).eventSetting, { event: "acceleration", revisionId: fAcc.revId, compared: true, sessionKept: true, confirmation: null });
  assert.equal((await detailOf(W.caA)).eventSetting.sessionKept, null, "a club admin never learns whether the compared session is kept");
  assert.equal(/\b2\.5\b|\b0\.3\b|teamThresholds|duration_seconds/.test(waiting.text), false, waiting.text);
  const waitingBoard = ok(await boardOf(W.caA, t, { candidateId: cand.id })).board;
  const accOnBoard = waitingBoard.variables.find((x) => x.id === acc.id);
  assert.deepEqual([accOnBoard.placeable, accOnBoard.matchingFieldIds, accOnBoard.waitingFieldIds], [false, [], [fAcc.fieldId]]);
  // A column whose setting is not the variable's (0.3 s against 0.5 s) never waits: a confirmation would not make it match.
  assert.deepEqual(waitingBoard.variables.find((x) => x.id === slow.id).waitingFieldIds, []);
  // A save sent past the screen onto the waiting column is refused by the server all the same (the screen's drop filter is
  // only help; C2's condition).
  const pastScreen = await placementRaw(W.caA, t, cand, fAcc, acc);
  assert.deepEqual([pastScreen.placeable, pastScreen.code], [false, "event_setting_not_confirmed"]);
  // The body.
  for (const bad of [{}, body("x", "0.3"), body("2.5", "-1"), { ...body("2.5", "0.3"), extra: 1 }, { ...body("2.5", "0.3"), requestKey: "nope" }]) {
    refused(await post(url, W.pa, bad), 400, "invalid_body");
  }
  // Another setting than GPEXE's for the compared session: refused, naming GPEXE's.
  const differs = await post(url, W.pa, body("2.5", "0.5"));
  refused(differs, 409, "setting_differs");
  assert.equal(differs.body.message, "GPEXE's setting for the session you compared is at or above 2.5 m/s² lasting 0.3 s. Check the team's settings in GPEXE and enter what it shows.");
  // A zone column takes no event confirmation.
  const fZone = await realField(ZONE3_KEY, "m");
  refused(await post(`/fields/${fZone.fieldId}/revisions/${fZone.revId}/event-setting-confirmation`, W.pa, body("2.5", "0.3")), 409, "not_an_event_column");
  // The owner's step: 2.5 and 0.3, Confirm.
  const requestKey = key();
  const first = ok(await post(url, W.pa, body(2.5, 0.3, requestKey)), 201).confirmation;
  assert.deepEqual([first.event, first.thresholdValue, first.durationSeconds], ["acceleration", "2.5", "0.3"]);
  assert.deepEqual(ok(await post(url, W.pa, body("2.5", "0.3", requestKey)), 200).confirmation, first, "a replay answers the saved one");
  refused(await post(url, W.pa, body("2.5", "0.30001", requestKey)), 409, "request_key_reused");
  const stored = await one(`select event_kind, trim_scale(threshold_value)::text as v, trim_scale(duration_seconds)::text as d, observation_confirmation_id, threshold_set_id, confirmed_by_user_id from training_load.source_metric_event_setting_confirmations where id = $1`, [first.id]);
  assert.deepEqual(stored, { event_kind: "acceleration", v: "2.5", d: "0.3", observation_confirmation_id: compared, threshold_set_id: "1473", confirmed_by_user_id: W.pa.id });
  // The detail shows the owner's own confirmed numbers; the board offers the column (no longer waiting).
  const confirmedDetail = (await detailOf(W.caA)).eventSetting;
  assert.deepEqual({ ...confirmedDetail, confirmation: { ...confirmedDetail.confirmation, confirmedAt: Boolean(confirmedDetail.confirmation?.confirmedAt) } },
    { event: "acceleration", revisionId: fAcc.revId, compared: true, sessionKept: null, confirmation: { thresholdValue: "2.5", durationSeconds: "0.3", confirmedAt: true } });
  const accNow = ok(await boardOf(W.caA, t, { candidateId: cand.id })).board.variables.find((x) => x.id === acc.id);
  assert.deepEqual([accNow.placeable, accNow.matchingFieldIds.includes(fAcc.fieldId), accNow.waitingFieldIds], [true, true, []]);
  // Now the column fills the variable with that setting, and not the one of 0.5 s.
  const p = await placementRaw(W.caA, t, cand, fAcc, acc);
  assert.equal(p.placeable, true, JSON.stringify(p));
  const p05 = await placementRaw(W.caA, t, cand, fAcc, slow);
  assert.deepEqual([p05.placeable, p05.code], [false, "team_setting_mismatch"]);
  assert.equal(p05.message, `This column counts events at or above 2.5 m/s² lasting 0.3 s (${name}'s setting in GPEXE); ${slow.label} counts events at or above 2.5 m/s² lasting 0.5 s. Choose a variable with the same setting, or change the team's setting in GPEXE.`);
  // The club's version made above is switched on for the team (S1) now that the setting is confirmed.
  const started = await start(W.paA, { mappingId: accMapping.id, versionId: accVersion.id }, t);
  assert.ok([200, 201].includes(started.status), started.text);
  const opened = await openOn({ versionId: accVersion.id }, t);
  const saved = { confirmation: { rows: [{ activationId: opened.id }] } };
  assert.deepEqual(await activationRow(saved.confirmation.rows[0].activationId), {
    matched_condition: { operator: ">=", value: 2.5, duration_seconds: 0.3, unit: "m/s2" },
    matched_source_range: { duration_seconds: "0.3", operator: ">=", unit: "m/s2", value: "2.5" },
    matched_threshold_set_id: "1473", at: true, condition_rule: { event: "acceleration", kind: "event" },
  });
  V80.acc = { url, compared, fAcc };
  // The compared session no longer kept: a new confirmation is refused (session_not_kept).
  await planted(() => k.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 minute' where id = $1`, [cand.id]));
  try {
    refused(await post(url, W.pa, body("2.5", "0.3")), 409, "session_not_kept");
  } finally {
    await planted(() => k.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() + interval '30 days' where id = $1`, [cand.id]));
  }
});

test("V80-4b. the owner's confirmation, the same key sent twice at once: both answer the one saved row (201 and a 200 replay), never request_key_reused; one row", async () => {
  const { url } = V80.acc;
  const requestKey = key();
  const both = await Promise.all([0, 1].map(() => post(url, W.pa, { requestKey, thresholdValue: "2.5", durationSeconds: "0.3" })));
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 201], both.map((r) => r.text).join(" | "));
  assert.equal(both[0].body.confirmation.id, both[1].body.confirmation.id);
  assert.equal(Number((await one(`select count(*) as n from training_load.source_metric_event_setting_confirmations where request_key = $1`, [requestKey])).n), 1);
});

test("V80-4c. the owner's confirmation, the COMMIT's answer: lost after the COMMIT reached the database is 200 verified_after_commit_error; a COMMIT that never reached it is 503 outcome_unknown and the same key then saves; never a bare 500", async () => {
  const { url } = V80.acc;
  const eventSetting = await import("../src/sourceEventSettingService.js");
  // The answer lost after the COMMIT was applied.
  eventSetting.setEventSettingBeforeCommitForTests((client) => {
    const original = client.query.bind(client);
    client.query = async (sql, ...rest) => {
      const out = await original(sql, ...rest);
      if (sql === "commit") throw Object.assign(new Error("connection lost after commit"), { code: "08006" });
      return out;
    };
  });
  const lostKey = key();
  try {
    const lost = await post(url, W.pa, { requestKey: lostKey, thresholdValue: "2.5", durationSeconds: "0.3" });
    assert.equal(lost.status, 200, lost.text);
    assert.equal(lost.body.verified_after_commit_error, true);
    // The verify read's bound is transaction-local: no idle pooled connection keeps it (the DB re-review of v80).
    const idle = await Promise.all(Array.from({ length: appPool.idleCount }, () => appPool.connect()));
    try {
      for (const c of idle) assert.notEqual((await c.query("show statement_timeout")).rows[0].statement_timeout, "5s");
    } finally {
      for (const c of idle) c.release();
    }
    assert.equal(Number((await one(`select count(*) as n from training_load.source_metric_event_setting_confirmations where request_key = $1`, [lostKey])).n), 1);
  } finally {
    eventSetting.setEventSettingBeforeCommitForTests(null);
  }
  // The COMMIT never sent: nothing saved, outcome_unknown; the same key then saves.
  eventSetting.setEventSettingBeforeCommitForTests((client) => {
    const original = client.query.bind(client);
    client.query = async (sql, ...rest) => {
      if (sql === "commit") throw Object.assign(new Error("connection lost before commit"), { code: "08006" });
      return original(sql, ...rest);
    };
  });
  const neverKey = key();
  try {
    const never = await post(url, W.pa, { requestKey: neverKey, thresholdValue: "2.5", durationSeconds: "0.3" });
    assert.deepEqual([never.status, never.body.error], [503, "outcome_unknown"], never.text);
  } finally {
    eventSetting.setEventSettingBeforeCommitForTests(null);
  }
  assert.equal(Number((await one(`select count(*) as n from training_load.source_metric_event_setting_confirmations where request_key = $1`, [neverKey])).n), 0);
  ok(await post(url, W.pa, { requestKey: neverKey, thresholdValue: "2.5", durationSeconds: "0.3" }), 201);
});

test("V80-5. the importer through its real activation read: a team's next session whose zone 3 is 25-65 W/kg is blocked whole (team_setting_changed) by the candidate preview, while a session with the matched setting is not; the club's version is switched on for the team from the board as a pre-placed row", async () => {
  const { t, cand, name } = await plantedTeam();
  // The club's version of V80-1, pre-placed on this team's board and saved: the activation records its match.
  const saved = ok(await save(W.caA, t, cand, [await preplacedRow(W.caA, t, cand, V80.zone)]));
  assert.deepEqual((await activationRow(saved.confirmation.rows[0].activationId)).matched_source_range, { max: "60", min: "25", operator: "between", unit: "W/kg" });
  const changed = await candidate(t, { startedAt: "2026-09-15T18:08:12Z" });
  await plantSession(changed, { thresholds: { power_thresholds: [20, 25, 65, 75] } });
  const recompute = async (c) => {
    const res = await fetch(`${apiBase}/api/training-load/gpexe/teams/${t.teamId}/candidates/${c.id}/preview`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: W.paA.cookie }, body: "{}",
    });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  const blocked = await recompute(changed);
  assert.equal(blocked.status, 200, blocked.text);
  assert.equal(blocked.body.candidate.preview.blocked?.code, "team_setting_changed", blocked.text);
  // v80 step C0: the two administrators read both settings, the variable and the team (section 5's sentence); no id.
  const label = V80.zone.variable.label;
  const sentence = `${name}'s setting in GPEXE counts the zone 25–65 W/kg for this session; ${label} counts the zone 25–60 W/kg. Nothing of this session is imported. Set it back in GPEXE, or switch ${label} off for ${name}.`;
  assert.deepEqual(blocked.body.candidate.preview.blocked, {
    code: "team_setting_changed", message: sentence,
    setting: { teamName: name, variableLabel: label, current: { max: "65", min: "25", operator: "between", unit: "W/kg" }, matched: { max: "60", min: "25", operator: "between", unit: "W/kg" } },
  });
  const candidateRead = async (who) => {
    const res = await fetch(`${apiBase}/api/training-load/gpexe/teams/${t.teamId}/candidates/${changed.id}`, { headers: { Cookie: who.cookie } });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  const asClubAdmin = await candidateRead(W.caA);
  assert.equal(asClubAdmin.status, 200, asClubAdmin.text);
  assert.deepEqual(asClubAdmin.body.candidate.preview.blocked.setting, blocked.body.candidate.preview.blocked.setting);
  // A coach reads a sentence without the numbers, the variable or the structured setting.
  const coach = { id: await user("coach") };
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coach.id, t.teamId]);
  await workspace(coach.id, "team", t.teamId);
  coach.cookie = await cookieFor(coach.id);
  const asCoach = await candidateRead(coach);
  assert.equal(asCoach.status, 200, asCoach.text);
  assert.deepEqual(asCoach.body.candidate.preview.blocked, { code: "data_setup_incomplete", message: "This session can't be imported until an administrator finishes its data setup." });
  assert.equal(/25–6[05]|"setting"/.test(asCoach.text), false, "no range or structured setting reaches a coach");
  const fine = await recompute(cand);
  assert.equal(fine.status, 200, fine.text);
  assert.notEqual(fine.body.candidate.preview.blocked?.code, "team_setting_changed", fine.text);
});

test("V80-6. exact decimals: a variable whose zone limit differs from GPEXE's only past a double's precision (123456789012.000000001 W/kg against 123456789012) is refused, not matched", async () => {
  // A club of its own (clubs A and B already map the zone column: one active target per owner and field).
  const fZone = await realField(ZONE3_KEY, "m");
  const clubC = await club("Club C");
  const caC = await clubAdmin(clubC, "Club C Admin");
  const { t, cand } = await plantedTeam({ clubId: clubC, thresholds: { power_thresholds: [20, 25, 123456789012, 123456789013] } });
  const precise = await variable(caC, { unit: "m", label: `Precise zone ${uid()}`, condition: { kind: "zone", operator: "between", lower: "25", upper: "123456789012.000000001", unit: "W/kg" } });
  const p = await placementRaw(caC, t, cand, fZone, precise);
  assert.deepEqual([p.placeable, p.code], [false, "team_setting_mismatch"], JSON.stringify(p));
  assert.equal(ok(await boardOf(caC, t, { candidateId: cand.id })).board.variables.find((x) => x.id === precise.id).placeable, false);
});

test("V80-7. only a column the board can place makes a variable with a condition placeable: zone 2's column whose unit is not proven matches the setting but is not offered, and its variable stays not placeable", async () => {
  const fieldId = (await one(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,$2,$3) returning id`,
    ["details.players.athletesessionpowerzone_distance_2", "GPEXE zone two", W.pa.id])).id;
  await writeRevision(k, { fieldId, by: W.pa.id, valueShape: "unit_value_object", parameterKind: "none", evidenceRef: COMPAT, state: "active" });
  const { t, cand } = await plantedTeam();
  const zone2 = await variable(W.caA, { unit: "m", label: `Zone two ${uid()}`, condition: { ...ZONE_25_60, lower: "20", upper: "25" } });
  const board = ok(await boardOf(W.caA, t, { candidateId: cand.id })).board;
  assert.notEqual(board.columns.find((c) => c.fieldId === fieldId)?.reason ?? null, null, "the column itself is not placeable");
  const row = board.variables.find((x) => x.id === zone2.id);
  assert.deepEqual([row.placeable, row.matchingFieldIds], [false, []]);
});

test("V80-8. a variable whose stored condition is not an object (a raw or legacy write) never breaks the board: it reads as unsupported and not placeable", async () => {
  const { t, cand } = await plantedTeam();
  const odd = await variable(W.caA, { unit: "m", label: `Odd condition ${uid()}`, condition: ZONE_25_60 });
  await planted(() => k.query(`update training_load.metric_definition_versions set condition_description = '"25-60 W/kg"'::jsonb
    where id = (select current_version_id from training_load.metric_definitions where id = $1)`, [odd.id]));
  const row = ok(await boardOf(W.caA, t, { candidateId: cand.id })).board.variables.find((x) => x.id === odd.id);
  assert.deepEqual([row.condition?.kind, row.placeable, row.matchingFieldIds], ["unsupported", false, []]);
});

test("V80-9. the approve route (the Independent's LOW-3 on PR #659): a session previewed before a matched zone column was switched on, whose zone 3 is 25-65 W/kg, is refused at approval - the approval recomputes it to team_setting_changed (preview_changed), the next approval is refused as blocked, and nothing of it is imported", async () => {
  const { enableTeamImportSwitch } = await import("./support/team-import-switch.mjs");
  const { t, cand } = await plantedTeam();
  // An ordinary mapping first, so the session has something to import.
  const fTime = await field("time");
  const vMin = await variable(W.caA, { unit: "min" });
  ok(await save(W.caA, t, cand, [await newRow(W.caA, t, cand, fTime, vMin)]));
  const changed = await candidate(t, { startedAt: "2026-09-15T18:08:12Z" });
  await plantSession(changed, { thresholds: { power_thresholds: [20, 25, 65, 75] } });
  const gpexe = async (path, body) => {
    const res = await fetch(`${apiBase}/api/training-load/gpexe/teams/${t.teamId}/candidates/${changed.id}/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: W.paA.cookie }, body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  const before = await gpexe("preview", {});
  assert.equal(before.status, 200, before.text);
  assert.notEqual(before.body.candidate.preview.blocked?.code, "team_setting_changed", "before the zone column, nothing to block");
  const hashBefore = before.body.candidate.previewHash ?? before.body.candidate.preview_hash;
  // The club's matched zone column switched on for the team (from the session it matches).
  ok(await save(W.caA, t, cand, [await preplacedRow(W.caA, t, cand, V80.zone)]));
  await enableTeamImportSwitch(k, t.teamId, W.pa.id);
  const events = async () => Number((await one(`select count(*) as n from training_load.metric_events where owner_team_id = $1`, [t.teamId])).n);
  const eventsBefore = await events();
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    const first = await gpexe("approve", { previewHash: hashBefore });
    assert.deepEqual([first.status, first.body.error], [409, "preview_changed"], first.text);
    const stored = await one(`select status, preview -> 'blocked' ->> 'code' as code, preview_hash from training_load.gpexe_import_candidates where id = $1`, [changed.id]);
    assert.equal(stored.code, "team_setting_changed", JSON.stringify(stored));
    const second = await gpexe("approve", { previewHash: stored.preview_hash });
    assert.deepEqual([second.status, second.body.error], [409, "blocked"], second.text);
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
  assert.equal(await events(), eventsBefore, "nothing of the session is imported");
});

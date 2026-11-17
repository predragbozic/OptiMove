// S (the owner, 2026-11-17; the Rukovodilac's GO (a1)): the drag-and-drop board in the PLATFORM workspace, for any
// club's team, onto OptiMove's (system) variables. A platform admin compares two athletes, ticks and saves; the save
// writes OptiMove's mapping, its version, its activation and the start on the team's binding - and no stored
// confirmation; the last start is the keyed request record. The club board is unchanged. Through the real HTTP stack
// on one disposable optimove_tests_gpexe_* database; synthetic columns, a synthetic stored session, invented athletes.
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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "boards" });
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
// S tests
// ---------------------------------------------------------------------------
const teamsOf = (who) => get("/board/teams", who);
const systemRow = async (t, cand, f, target, opts) => newRow(W.pa, t, cand, f, target, opts);
const startsOf = async (operationId) => rows(`select * from ${T8} where operation_id = $1 order by performed_at, id`, [operationId]);
const lastOperation = async (userId) => (await one(`select operation_id from ${T8} where performed_by_user_id = $1 and request_key is not null order by performed_at desc limit 1`, [userId])).operation_id;

test("S1. who reaches the platform board: an active platform admin in the platform workspace reads every club's teams with an active GPEXE link in one step; a club admin, a platform admin in a club workspace, a coach and a user without a role get the identical 404 on the team list; the club board is unchanged", async () => {
  const { t } = await freshTeam();
  const list = ok(await teamsOf(W.pa));
  const mine = list.teams.find((x) => x.teamId === t.teamId);
  assert.ok(mine, "club A's team is listed");
  assert.ok(list.teams.some((x) => x.teamId === W.tB.teamId), "club B's team is listed too");
  assert.equal(typeof mine.clubName, "string");
  assert.ok(mine.clubName.startsWith("Club A"));
  assert.deepEqual(Object.keys(mine).sort(), ["clubId", "clubName", "teamId", "teamName"]);
  assert.equal(list.truncated, false);
  const unbound = await gpexeTeam(W.clubA, { bound: false });
  assert.ok(!ok(await teamsOf(W.pa)).teams.some((x) => x.teamId === unbound.teamId), "a team without a link is not offered");
  const coachId = await user("coach");
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coachId, t.teamId]);
  await workspace(coachId, "team", t.teamId);
  const nobody = await user("nobody");
  for (const who of [W.caA, W.paA, { cookie: await cookieFor(coachId) }, { cookie: await cookieFor(nobody) }]) {
    assert.deepEqual(shape(await teamsOf(who)), NOT_FOUND);
  }
  // The club board: a platform admin in club A's workspace and club A's admin read it as before; owner "club".
  assert.equal(ok(await boardOf(W.caA, t)).board.owner, "club");
  assert.equal(ok(await boardOf(W.paA, t)).board.owner, "club");
});

test("S2. the platform board of a team: owner system, OptiMove's variables only (none of the club's), each numeric variable with a unit placeable; a team of another club is reachable; a coach, a club admin of another club and an archived team or club are the identical 404", async () => {
  const { t } = await freshTeam();
  await variable(W.caA, { unit: "min", label: `Club A only ${uid()}` });
  const b = ok(await boardOf(W.pa, t)).board;
  assert.equal(b.owner, "system");
  assert.ok(b.variables.length > 0);
  assert.ok(b.variables.every((v) => v.ownerScope === "system"), "OptiMove's variables only");
  assert.equal(b.variables.find((v) => v.id === W.sysMin.id)?.placeable, true);
  assert.equal(ok(await boardOf(W.pa, W.tB)).board.owner, "system", "any club's team");
  assert.deepEqual(shape(await boardOf(W.caB, t)), NOT_FOUND);
  const archived = await freshTeam();
  await k.query(`update public.teams set is_active = false where id = $1`, [archived.t.teamId]);
  assert.deepEqual(shape(await boardOf(W.pa, archived.t)), NOT_FOUND);
  const cl = await club("Club archived");
  const tc = await gpexeTeam(cl);
  await candidate(tc);
  await k.query(`update public.clubs set is_active = false where id = $1`, [cl]);
  assert.deepEqual(shape(await boardOf(W.pa, tc)), NOT_FOUND);
  assert.ok(!ok(await teamsOf(W.pa)).teams.some((x) => x.teamId === tc.teamId || x.teamId === archived.t.teamId));
});

test("S3. a save on the platform board writes OptiMove's mapping, version, activation and start for the team, as the platform admin; no stored confirmation; the last start is the keyed request record; the answer carries no value; a replay answers the same; another body under the key is refused", async () => {
  const { t, cand } = await freshTeam();
  const f = await field("dist");
  const sysDist = await variable(W.pa, { unit: "km", label: `OptiMove distance ${uid()}` });
  const p = await placementOf(W.pa, t, cand, f, sysDist);
  assert.equal(p.placeable, true, JSON.stringify(p));
  assert.equal(p.kind, "new");
  const t9Before = (await counts()).t9;
  const requestKey = key();
  const row = await systemRow(t, cand, f, sysDist);
  const res = await save(W.pa, t, cand, [row], { requestKey });
  const body = ok(res);
  assert.equal(body.replayed, false);
  assert.equal(body.confirmation.id, null);
  assert.equal(body.confirmation.owner, "system");
  assert.equal(body.confirmation.teamId, t.teamId);
  assert.equal(body.confirmation.rows.length, 1);
  assert.deepEqual(valueLeaks(body, [p.values.a.raw, p.values.b.raw, p.values.a.stored, p.values.b.stored].filter((x) => x !== null)), []);
  assert.equal((await counts()).t9, t9Before, "no confirmation is stored");
  const m = await one(`select owner_scope, owner_club_id, created_by_user_id from ${T3} where source_metric_definition_id = $1 and metric_definition_id = $2`, [f.fieldId, sysDist.id]);
  assert.deepEqual([m.owner_scope, m.owner_club_id, m.created_by_user_id], ["system", null, W.pa.id]);
  const v = await one(`select status, activated_basis, owner_key from ${T4} where source_metric_definition_id = $1 and metric_definition_id = $2`, [f.fieldId, sysDist.id]);
  assert.deepEqual([v.status, v.activated_basis, v.owner_key], ["active", "platform_admin", "system"]);
  const a = await one(`select activated_basis, reason, requirement, source_team_binding_id from ${T5} where id = $1`, [body.confirmation.rows[0].activationId]);
  assert.deepEqual([a.activated_basis, a.reason, a.requirement, a.source_team_binding_id], ["platform_admin", "Switched on by drag and drop; two athletes checked in GPEXE.", "required", t.bindingId]);
  const audit = await startsOf(await lastOperation(W.pa.id));
  // One transaction: one time for every row, so the actions are compared as a set.
  assert.deepEqual(audit.map((r) => r.action).sort(), ["activation_start", "mapping_create", "mapping_status", "mapping_status", "mapping_version_create"]);
  assert.ok(audit.every((r) => r.basis === "platform_admin" && r.performed_by_user_id === W.pa.id));
  assert.deepEqual(audit.filter((r) => r.request_key !== null).map((r) => r.action), ["activation_start"], "the last start is the request record");
  const replay = ok(await save(W.pa, t, cand, [row], { requestKey }));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.confirmation, body.confirmation);
  refused(await save(W.pa, t, cand, [{ ...row, requirement: "optional" }], { requestKey }), 409, "request_key_reused");
});

test("S4. without the tick nothing is saved: a new row with checked false or no checked is 400, and nothing is written", async () => {
  const { t, cand } = await freshTeam();
  const f = await field("time");
  const target = await variable(W.pa, { unit: "min", label: `OptiMove minutes ${uid()}` });
  const row = await systemRow(t, cand, f, target);
  await nothingWritten(async () => {
    refused(await save(W.pa, t, cand, [{ ...row, checked: false }]), 400, "invalid_body");
    const { checked: _c, ...noTick } = row;
    refused(await save(W.pa, t, cand, [noTick]), 400, "invalid_body");
  });
});

test("S5. after the platform save the team's club board shows the OptiMove variable on (badge optimove_mapping); the club's own duplicate variable is neither switched on nor off; another club's board offers OptiMove's mapping and nothing is on for its team", async () => {
  const { t, cand } = await freshTeam();
  const f = await field("dist");
  const sysDist = await variable(W.pa, { unit: "m", label: `OptiMove total distance ${uid()}` });
  // The club's own "Total distance": a club variable of the same unit, with nothing mapped to it.
  const clubDist = await variable(W.caA, { unit: "m", label: `Club total distance ${uid()}` });
  const openBefore = await rows(`select id from ${T5} where source_team_binding_id = $1 and ended_at is null`, [t.bindingId]);
  ok(await save(W.pa, t, cand, [await systemRow(t, cand, f, sysDist)]));
  const club = ok(await boardOf(W.caA, t, { candidateId: cand.id })).board;
  const on = club.on.find((o) => o.variableId === sysDist.id);
  assert.ok(on, "the club sees the OptiMove variable on for the team");
  assert.equal(on.badge, "optimove_mapping");
  assert.ok(!club.on.some((o) => o.variableId === clubDist.id), "the club's own variable is not switched on");
  const openAfter = await rows(`select id from ${T5} where source_team_binding_id = $1 and ended_at is null`, [t.bindingId]);
  assert.equal(openAfter.length, openBefore.length + 1, "one start, nothing ended");
  assert.equal((await one(`select count(*)::int n from ${T3} where metric_definition_id = $1`, [clubDist.id])).n, 0, "no mapping of the club's own variable");
  // Another club: the OptiMove mapping is offered (switch on), nothing is on for its team.
  const fresh = await gpexeTeam(W.clubB);
  for (const n of [1, 2]) await link(fresh, n, `Club B other ${uid()}`);
  const candB = await candidate(fresh);
  const other = ok(await boardOf(W.caB, fresh, { candidateId: candB.id })).board;
  assert.ok(!other.on.some((o) => o.variableId === sysDist.id));
  assert.equal(other.variables.find((v) => v.id === sysDist.id)?.placeable, true, "placeable where OptiMove's mapping fills it");
  assert.equal((await one(`select count(*)::int n from ${T5} where source_team_binding_id = $1 and metric_definition_id = $2`, [fresh.bindingId, sysDist.id])).n, 0);
});

test("S6. what exists: OptiMove's active version of the same contract is reused (one start, no new version); another OptiMove mapping of the column to another variable is source_metric_target_taken; a variable the team's club hides is the identical 404 on the board's placement and absent from its variables", async () => {
  const { t, cand } = await freshTeam();
  const versionsBefore = (await counts()).t4;
  const p = await placementOf(W.pa, t, cand, W.fSysTime, W.sysMin);
  assert.equal(p.reusesVersionId, W.sysTime.versionId);
  const res = ok(await save(W.pa, t, cand, [await systemRow(t, cand, W.fSysTime, W.sysMin)]));
  assert.equal(res.confirmation.rows[0].versionId, W.sysTime.versionId);
  assert.equal((await counts()).t4, versionsBefore, "no new version");
  // The column is OptiMove's to W.sysMin: onto another OptiMove variable it is taken.
  const second = await freshTeam();
  const otherTarget = await variable(W.pa, { unit: "min", label: `OptiMove other ${uid()}` });
  const taken = await placementOf(W.pa, second.t, second.cand, W.fSysTime, otherTarget);
  assert.deepEqual([taken.placeable, taken.code], [false, "source_metric_target_taken"]);
  // Club A hides an OptiMove variable: the platform board of club A's team does not offer it.
  const f = await field("time");
  const hiddenTarget = await variable(W.pa, { unit: "min", label: `OptiMove hidden ${uid()}` });
  ok(await post(`/variables/${hiddenTarget.id}/hide`, W.caA, { requestKey: key() }));
  const b = ok(await boardOf(W.pa, second.t, { candidateId: second.cand.id })).board;
  assert.ok(!b.variables.some((v) => v.id === hiddenTarget.id));
  assert.deepEqual(shape(await placement(W.pa, second.t, second.cand.id, f, hiddenTarget)), NOT_FOUND);
});

test("S7. the burst path, as the owner will meet it: GPEXE's Burst events (details, unit count after the owner's two acts, shown as sent) onto OptiMove's Burst variable (count) from the platform board; the importer then has the mapping on for the team", async () => {
  const { t, cand } = await freshTeam();
  // The seeded field, proven through the real routes (unit count, meaning), as the owner did on 2026-11-16.
  const seeded = await one(`select d.id as field_id, r.id as rev_id from training_load.source_metric_definitions d
                              join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id and r.state = 'active'
                             where d.source_metric_key = 'details.players.tot_burst_events'`);
  if ((await one(`select evidence_status from training_load.source_metric_definition_versions where id = $1`, [seeded.rev_id])).evidence_status !== "verified") {
    ok(await post(`/fields/${seeded.field_id}/revisions/${seeded.rev_id}/unit-verification`, W.pa, { requestKey: key(), sourceUnit: "count", evidenceRef: UNIT_REF }), 201);
    ok(await post(`/fields/${seeded.field_id}/revisions/${seeded.rev_id}/meaning-verification`, W.pa, { requestKey: key(), evidenceRef: MEANING_REF }), 201);
  }
  const burst = await variable(W.pa, { unit: "count", label: `Burst ${uid()}` });
  const b = ok(await boardOf(W.pa, t, { candidateId: cand.id })).board;
  const col = b.columns.find((c) => c.fieldId === seeded.field_id);
  assert.ok(col, "the Burst events column is on the board");
  assert.deepEqual([col.unit, col.unitProven, col.placeable, col.displayRule, col.displayUnits], ["count", true, true, "as_sent", ["count"]]);
  const p = await placementOf(W.pa, t, cand, { fieldId: seeded.field_id }, burst);
  assert.equal(p.placeable, true, JSON.stringify(p));
  assert.deepEqual([p.sourceUnit, p.targetUnit, p.conversion.kind, p.displayRule], ["count", "count", "same_unit", "as_sent"]);
  assert.deepEqual([p.display.count.a, p.display.count.b], [String(p.values.a.raw), String(p.values.b.raw)], "shown as GPEXE sends it");
  const row = await systemRow(t, cand, { fieldId: seeded.field_id }, burst);
  const res = ok(await save(W.pa, t, cand, [row]));
  const a = await one(`select a.applies_to_session, m.owner_scope from ${T5} a join ${T3} m on m.id = a.mapping_id where a.id = $1`, [res.confirmation.rows[0].activationId]);
  assert.deepEqual([a.applies_to_session, a.owner_scope], [true, "system"]);
});

test("S8. the lock order of a platform save, from the SQL it sends: the same order as the club save (fields, revisions, variables, levels, binding, team, users before the role row, the club, the hide lock, the binding's save lock), all before the first write; no confirmation statement", async () => {
  const { t, cand } = await freshTeam();
  const f = await field("time");
  const target = await variable(W.pa, { unit: "min", label: `OptiMove order ${uid()}` });
  const row = await systemRow(t, cand, f, target);
  const seen = [];
  const pg2 = await import("pg");
  const original = pg2.default.Client.prototype.query;
  pg2.default.Client.prototype.query = function patched(text, ...rest) {
    const sql = typeof text === "string" ? text : text?.text;
    if (typeof sql === "string") seen.push(sql);
    return original.call(this, text, ...rest);
  };
  try { ok(await save(W.pa, t, cand, [row])); } finally { pg2.default.Client.prototype.query = original; }
  const firstWrite = seen.findIndex((x) => /^\s*(insert|update|delete)\b/i.test(x) && /source_metric_|source_team_bindings|metric_definitions/.test(x));
  assert.ok(firstWrite > 0);
  // Each lock after the one before it, by the save's exact SQL (the club save's patterns, 18-3 test 7).
  const order = [
    ["conversions", /from training_load\.unit_conversions c\s+where c\.state = 'active' .* order by c\.id for share$/s],
    ["fields", /from training_load\.source_metric_definitions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["revisions", /from training_load\.source_metric_definition_versions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["variables", /from training_load\.metric_definitions where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["levels", /from training_load\.metric_definition_scope_capabilities\s+where metric_definition_id = any\(\$1::uuid\[\]\) order by metric_definition_id, scope_level for share$/s],
    ["binding", /from training_load\.source_team_bindings where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["team", /from public\.teams where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["users before role", /for share of u, g$/],
    ["club", /from public\.clubs where id = any\(\$1::uuid\[\]\) order by id for share$/],
    ["hide lock", /pg_advisory_xact_lock\(hashtextextended\('club-variable-hide:'/],
    ["one save per binding", /pg_advisory_xact_lock\(hashtextextended\('board-save:'/],
  ];
  const trimmed = seen.map((x) => x.replace(/\s+/g, " ").trim());
  let last = -1;
  for (const [name, re] of order) {
    const i = trimmed.findIndex((x, n) => n > last && re.test(x));
    assert.ok(i > last, `not sent in order: ${name}`);
    last = i;
  }
  assert.ok(last < firstWrite, "every lock before the first write");
  assert.ok(!seen.some((s) => /source_metric_confirmation/.test(s)), "no confirmation is written or read");
  const commitAt = trimmed.findIndex((x, n) => n > firstWrite && /^commit$/i.test(x));
  assert.ok(commitAt > firstWrite, "the save commits");
  assert.ok(!trimmed.slice(firstWrite, commitAt).some((x) => /\bfor (share|update|no key update|key share)\b|pg_advisory_xact_lock/i.test(x)), "no locking clause between the first write and the COMMIT");
});

test("S9. the answer names the team's own club (the other board's workspace); a replay of a platform save after the team or its club was archived is the identical 404", async () => {
  const { t, cand } = await freshTeam();
  assert.equal(ok(await boardOf(W.pa, t)).board.team.clubId, t.clubId);
  assert.equal(ok(await boardOf(W.caA, t)).board.team.clubId, t.clubId);
  const f = await field("time");
  const target = await variable(W.pa, { unit: "min", label: `OptiMove replay ${uid()}` });
  const requestKey = key();
  const row = await systemRow(t, cand, f, target);
  ok(await save(W.pa, t, cand, [row], { requestKey }));
  await k.query(`update public.teams set is_active = false where id = $1`, [t.teamId]);
  assert.deepEqual(shape(await save(W.pa, t, cand, [row], { requestKey })), NOT_FOUND, "an archived team");
  await k.query(`update public.teams set is_active = true where id = $1`, [t.teamId]);
  assert.equal(ok(await save(W.pa, t, cand, [row], { requestKey })).replayed, true);
  await k.query(`update public.clubs set is_active = false where id = $1`, [t.clubId]);
  try {
    assert.deepEqual(shape(await save(W.pa, t, cand, [row], { requestKey })), NOT_FOUND, "an archived club");
  } finally {
    await k.query(`update public.clubs set is_active = true where id = $1`, [t.clubId]);
  }
});

test("S10. two platform saves of two teams (two clubs) that create the same OptiMove mapping at once: one is saved, the other answers board_changed - one mapping, one version, never a deadlock or a 500", async () => {
  const saveService = await import("../src/sourceMetricBoardSaveService.js");
  const a = await freshTeam();
  const tB = await gpexeTeam(W.clubB);
  for (const n of [1, 2]) await link(tB, n, `Club B race ${uid()}`);
  const candB = await candidate(tB);
  const f = await field("time");
  const target = await variable(W.pa, { unit: "min", label: `OptiMove race ${uid()}` });
  const rowA = await systemRow(a.t, a.cand, f, target);
  // Another platform admin: one admin's own saves already run one at a time (the per-user write lock answers try_again).
  const pa2 = await platformAdmin(["platform", null], "second-platform-admin");
  const rowB = await newRow(pa2, tB, candB, f, target);
  // Save A holds after every lock and its recompute, before its first write; save B runs to its COMMIT meanwhile.
  let resB = null;
  saveService.setBoardSaveHoldForTests(async (_client, at) => {
    if (at === "before_writes" && resB === null) {
      resB = "running";
      resB = await save(pa2, tB, candB, [rowB]);
    }
  });
  let resA;
  try { resA = await save(W.pa, a.t, a.cand, [rowA]); } finally { saveService.setBoardSaveHoldForTests(null); }
  assert.equal(resB.status, 200, `B: ${resB.text}`);
  refused(resA, 409, "board_changed");
  assert.equal((await one(`select count(*)::int n from ${T3} where source_metric_definition_id = $1 and metric_definition_id = $2`, [f.fieldId, target.id])).n, 1);
  assert.equal((await one(`select count(*)::int n from ${T4} where source_metric_definition_id = $1 and metric_definition_id = $2`, [f.fieldId, target.id])).n, 1);
  // Read again, team A's admin switches the same OptiMove mapping on for team A: a reuse, no second version.
  const again = ok(await save(W.pa, a.t, a.cand, [await systemRow(a.t, a.cand, f, target)]));
  assert.equal(again.confirmation.rows[0].versionId, resB.body.confirmation.rows[0].versionId);
});

test("S11. the COMMIT of a platform save: an answer lost after the COMMIT is 200 verified_after_commit_error through the keyed start (one start, no confirmation), and the same key replays it; a COMMIT that never reached the database is 503 outcome_unknown and the same key then saves once", async () => {
  const service = await import("../src/sourceMetricMappingService.js");
  const setup = async () => {
    const x = await freshTeam();
    const f = await field("time");
    const target = await variable(W.pa, { unit: "min", label: `OptiMove commit ${uid()}` });
    return { ...x, f, target, rows: [await systemRow(x.t, x.cand, f, target)] };
  };
  let s = await setup();
  let requestKey = key();
  const t9 = (await counts()).t9;
  service.setMappingCommitForTests({ fault: (c) => c.query("commit").then(() => { throw new Error("answer lost"); }), timeoutMs: 2_000 });
  let res;
  try { res = await save(W.pa, s.t, s.cand, s.rows, { requestKey }); } finally { service.setMappingCommitForTests(); }
  const verified = ok(res);
  assert.deepEqual([verified.commitConfirmation, verified.replayed, verified.confirmation.owner, verified.confirmation.rows.length], ["verified_after_commit_error", false, "system", 1]);
  assert.equal((await one(`select count(*)::int n from ${T5} where source_team_binding_id = $1 and metric_definition_id = $2`, [s.t.bindingId, s.target.id])).n, 1);
  assert.equal((await counts()).t9, t9, "no confirmation");
  assert.deepEqual(ok(await save(W.pa, s.t, s.cand, s.rows, { requestKey })).confirmation, verified.confirmation);
  // The COMMIT never reached the database.
  s = await setup();
  requestKey = key();
  service.setMappingCommitForTests({ fault: (c) => c.query("rollback").then(() => { throw new Error("connection lost"); }), timeoutMs: 2_000 });
  try { res = await save(W.pa, s.t, s.cand, s.rows, { requestKey }); } finally { service.setMappingCommitForTests(); }
  refused(res, 503, "outcome_unknown");
  assert.equal((await one(`select count(*)::int n from ${T5} where source_team_binding_id = $1 and metric_definition_id = $2`, [s.t.bindingId, s.target.id])).n, 0);
  const saved = ok(await save(W.pa, s.t, s.cand, s.rows, { requestKey }));
  assert.equal(saved.replayed, false);
  assert.equal((await one(`select count(*)::int n from ${T5} where source_team_binding_id = $1 and metric_definition_id = $2`, [s.t.bindingId, s.target.id])).n, 1);
});

test("S12. a platform save that replaces what the club had on (its own mapping of the column) is a replacement, not a switch-off: the club board does not list the club's mapping as switched off", async () => {
  const { t, cand } = await freshTeam();
  const f = await field("dist");
  const clubVar = await variable(W.caA, { unit: "m", label: `Club distance ${uid()}` });
  const clubV = await activeVersion(W.caA, f, clubVar);
  ok(await start(W.paA, clubV, t), 201);
  const open = await openOn(clubV, t);
  assert.ok(open, "the club's mapping is on for the team");
  const sysVar = await variable(W.pa, { unit: "m", label: `OptiMove distance ${uid()}` });
  const p = await placementOf(W.pa, t, cand, f, sysVar);
  assert.equal(p.placeable, true, JSON.stringify(p));
  assert.deepEqual(p.collisions.map((c) => c.activationId), [open.id], "the club's activation is in the way");
  ok(await save(W.pa, t, cand, [await systemRow(t, cand, f, sysVar)]));
  assert.ok((await one(`select ended_at from ${T5} where id = $1`, [open.id])).ended_at, "the club's activation ended");
  const club = ok(await boardOf(W.caA, t, { candidateId: cand.id })).board;
  assert.ok(!club.switchedOff.some((x) => x.mappingVersionId === clubV.versionId), "not shown as switched off");
  assert.ok(club.on.some((o) => o.variableId === sysVar.id && o.badge === "optimove_mapping"));
});

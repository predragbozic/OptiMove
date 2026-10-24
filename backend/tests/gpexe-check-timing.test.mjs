// P0 — the GPEXE check timing line (owner order 2026-10-13): one aggregated,
// closed-grammar line per check, on a disposable optimove_tests_gpexe_*
// database (never OPTIMOVE) through the real server, against a fake server3
// that serves the discovery fixture: three sessions of one day (one with five
// drills), twenty linked athletes, a whole list of 320 rows. Nothing of the
// check's behaviour may change: the same requests in the same order, the same
// database statements, the same results, with the meter on or off.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg, DISPOSABLE_DB_NAME_PATTERN } from "./_gpexe-disposable-db.mjs";
import { makeBundle } from "./_gpexe-fixtures.mjs";
import * as cryptoMod from "../src/sourceCredentialCrypto.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const ORIGINAL_ACTIVE = process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION;
const ORIGINAL_ENV_TOKEN = process.env.GPEXE_API_TOKEN;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../src");
const USERNAME = "marker-username-timing@example.invalid";
const PASSWORD = "MARKER-password-timing-not-real";
const TOKEN = "MARKER-token-timing-connection-not-real-0123456789";
const EXCHANGE_URL = "https://server3.gpexe.com/api-token-auth/";
const REST = "https://server3.gpexe.com/rest/v1/";
const LEGACY = "https://server3.gpexe.com/api/";
const DAY = "2026-10-05";
const ATHLETES = 20;
const HISTORY_ROWS = 320;
const NAME_MARK = "Timing Athlete";
const SESSIONS = [{ sid: 3001, drills: 5, hour: "09" }, { sid: 3011, drills: 0, hour: "11" }, { sid: 3021, drills: 0, hour: "17" }];

let db, admin, server, apiBase, importer, connections, resolver, timing, createSession, appPool;
const lines = [];
const originalConsole = {};
// Every statement any client of this process sends while `counting` is on.
let counting = false;
let statements = 0;
const originalQuery = pg.Client.prototype.query;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "timing" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  process.env.DATABASE_URL = db.url;
  process.env.SOURCE_CREDENTIAL_KEYS = cryptoMod.generateKeyEntry(1);
  delete process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  delete process.env.GPEXE_API_TOKEN;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => { if (process.env.TIMING_DEBUG) originalConsole[level](...args); };
  }
  pg.Client.prototype.query = function countedQuery(...args) {
    if (counting) statements += 1;
    return originalQuery.apply(this, args);
  };
  const serverModule = await import("../src/server.js");
  importer = await import("../src/gpexeImportService.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  timing = await import("../src/gpexeCheckTiming.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  timing.setCheckTimingForTests({ sink: (line) => lines.push(line) });
  // Never a real network: Connect, bind and every check read the fake.
  connections.setSourceFetchForTests(fakeFetch);
  resolver.setImportSourceFetchForTests(fakeFetch);
});

after(async () => {
  timing?.setCheckTimingForTests({});
  importer?.setGpexeClientFactory(null);
  importer?.setCheckRunObserver(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  pg.Client.prototype.query = originalQuery;
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS; else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
  if (ORIGINAL_ACTIVE === undefined) delete process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION; else process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION = ORIGINAL_ACTIVE;
  if (ORIGINAL_ENV_TOKEN === undefined) delete process.env.GPEXE_API_TOKEN; else process.env.GPEXE_API_TOKEN = ORIGINAL_ENV_TOKEN;
  if (ORIGINAL_SWITCH === undefined) delete process.env.GPEXE_IMPORT_APPLY_ENABLED; else process.env.GPEXE_IMPORT_APPLY_ENABLED = ORIGINAL_SWITCH;
});

afterEach(() => {
  timing.setCheckTimingForTests({ sink: (line) => lines.push(line) });
  importer.setGpexeClientFactory(null);
  importer.setCheckRunObserver(null);
});

// ---------------------------------------------------------------------------
// helpers
async function api(urlPath, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load${urlPath}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json };
}
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
const uid = () => crypto.randomBytes(4).toString("hex");
async function makeUser(label) { return (await q(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${uid()}@test.local`, label]))[0].id; }
async function setWorkspace(userId, type, scopeId) {
  await q(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3) on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;

// The discovery fixture for one source team: three parents of DAY (the first
// with five drills, each drill answer different), twenty athletes with one
// track each and whole-session rows only, and a whole list of 320 rows.
const athleteIds = Array.from({ length: ATHLETES }, (_, i) => 1001 + i);
function fixture(sourceTeamId) {
  const team = Number(sourceTeamId);
  const bundles = SESSIONS.map(({ sid, drills, hour }) => {
    const athletes = athleteIds.map((id, i) => ({
      id, tracks: [sid * 1000 + i],
      parts: [{ drill: null, time: 3000, distance: 5000 + i, maxV: 7.1, power: [2400, 200, 300, 60, 40], sprint: 10, acc: 20, dec: 18, burst: 9 + i, brake: 7 }],
    }));
    const b = makeBundle({ sessionId: sid, gpexeTeamId: team, start: `${DAY}T${hour}:00:00`, updatedOn: `${DAY}T20:00:00.000`, drillsCount: drills, athletes, detailsDrills: Array.from({ length: drills }, (_, k) => k) });
    for (let k = 0; k < drills; k += 1) {
      b.details.drills[String(k)].players = Object.fromEntries(athleteIds.map((id, i) => [String(id), { tot_burst_events: { unit: "number", value: 1 + k + i }, tot_brake_events: { unit: "number", value: 1 + k } }]));
    }
    // Each whole-session row's max_v in the whole details, as the owner-run reads of 2026-10-24 saw it.
    for (const r of b.athleteSessions) if (r.drill === null) b.details.full.players[String(r.athlete)].max_values_speed = { unit: "speed", value: r.max_v };
    return b;
  });
  const rows = [];
  for (const b of bundles) {
    const sid = b.teamSession.id;
    const drillIds = Array.from({ length: b.teamSession.drills_count }, (_, k) => 50000 + sid * 10 + k);
    rows.push({ ...b.teamSession, drills: drillIds, drills_count: drillIds.length });
    for (const id of drillIds) rows.push({ id, team, category_name: "DRILL", start_timestamp: b.teamSession.start_timestamp, end_timestamp: b.teamSession.end_timestamp, updated_on: b.teamSession.updated_on, is_stats_valid: true, drills: [], drills_count: 0 });
  }
  for (let i = 0; rows.length < HISTORY_ROWS; i += 1) {
    const ts = new Date(Date.parse("2026-10-01T10:00:00Z") - i * 86_400_000).toISOString().slice(0, 19);
    rows.push({ id: 10000 + i, team, category_name: "FULL TRAINING", start_timestamp: ts, end_timestamp: ts, updated_on: ts, is_stats_valid: true, drills: [], drills_count: 0 });
  }
  return { bundles, rows };
}

// The fake server3: the exchange and team reads (Connect / bind) and the
// rest_v1 / legacy reads of the served team. `calls` holds what a check sent.
const visibleTeams = new Set();
const src = { calls: [], served: null, data: null, applyDateFilter: false, faults: { drillMissing: null } };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const key = `${u.pathname}${u.search}`;
  if (String(url) === EXCHANGE_URL) {
    const params = new URLSearchParams(init.body);
    return params.get("username") === USERNAME && params.get("password") === PASSWORD ? json(200, { token: TOKEN }) : json(400, { non_field_errors: ["no"] });
  }
  if (!String(url).startsWith(REST) && !String(url).startsWith(LEGACY)) return json(404, {});
  src.calls.push(key);
  if ((init.headers?.Authorization ?? "") !== `Token ${TOKEN}`) return json(401, {});
  if (key === "/rest/v1/team/") return json(200, [...visibleTeams].map((id) => ({ id, name: `Team ${id}` })), { "x-total-count": String(visibleTeams.size) });
  let m = key.match(/^\/rest\/v1\/team\/(\d+)\/$/);
  if (m) return visibleTeams.has(Number(m[1])) ? json(200, { id: Number(m[1]), name: `Team ${m[1]}` }) : json(404, {});
  const t = src.served;
  if (t === null) return json(404, {});
  const { bundles, rows } = src.data;
  const bySid = (sid) => bundles.find((b) => String(b.teamSession.id) === String(sid));
  // A window's list carries the server's date filter (owner decision 2026-10-24); this fake answers it
  // with the whole list (rows in excess, as server3 can) and keeps the filter in its next links.
  const filter = key.match(/&start_timestamp_gte=[^&]*&start_timestamp_lte=[^&]*/)?.[0] ?? "";
  m = key.replace(filter, "").match(new RegExp(`^/rest/v1/team_session/\\?team=${t}&limit=100(?:&offset=(\\d+))?$`));
  if (m) {
    const offset = Number(m[1] ?? 0);
    // With src.applyDateFilter the fake applies the bounds as server3 does (test 10).
    const u = new URL(String(url));
    const [gte, lte] = ["start_timestamp_gte", "start_timestamp_lte"].map((k) => (u.searchParams.get(k) ?? "").replace(" ", "T"));
    const set = src.applyDateFilter && filter ? rows.filter((r) => r.start_timestamp >= gte && r.start_timestamp <= lte) : rows;
    const next = offset + 100 < set.length ? { link: `<${REST}team_session/?team=${t}${filter}&limit=100&offset=${offset + 100}>; rel="next"` } : {};
    return json(200, set.slice(offset, offset + 100), { "x-total-count": String(set.length), ...next });
  }
  m = key.match(/^\/rest\/v1\/team_session\/(\d+)\/$/);
  if (m && bySid(m[1])) return json(200, { ...bySid(m[1]).teamSession });
  m = key.match(/^\/rest\/v1\/athlete_session\/\?teamsession=(\d+)&limit=100$/);
  if (m && bySid(m[1])) return json(200, bySid(m[1]).athleteSessions, { "x-total-count": String(bySid(m[1]).athleteSessions.length) });
  m = key.match(/^\/rest\/v1\/athlete_session\/(\d+)\/(more\/)?$/);
  if (m) {
    for (const b of bundles) {
      const row = b.athleteSessions.find((r) => String(r.id) === m[1]);
      if (row) return json(200, m[2] ? b.more[m[1]] : row);
    }
    return json(404, {});
  }
  m = key.match(/^\/rest\/v1\/track\/(\d+)\/$/);
  if (m) { for (const b of bundles) if (b.tracks[m[1]]) return json(200, b.tracks[m[1]]); return json(404, {}); }
  m = key.match(/^\/rest\/v1\/team_session\/(\d+)\/details\/$/);
  if (m && bySid(m[1])) return json(200, { drills_count: bySid(m[1]).teamSession.drills_count, players: bySid(m[1]).details.full.players, team: { aggregate: 1 }, teamsession: Number(m[1]) });
  m = key.match(/^\/api\/team_session\/(\d+)\/details\/\?drill=(\d+)$/);
  if (m && bySid(m[1])) {
    if (src.faults.drillMissing && src.faults.drillMissing.sid === m[1] && src.faults.drillMissing.index === Number(m[2])) return json(404, {});
    return json(200, { drills_count: 0, players: bySid(m[1]).details.drills[m[2]].players, team: { aggregate: 1 }, teamsession: 1 });
  }
  if (/^\/api\/team_session\/\d+\/brief\/$/.test(key)) return json(404, {});
  m = key.match(/^\/rest\/v1\/team\/(\d+)\/thresholds\/\?valid_on=\d{4}-\d{2}-\d{2}$/);
  if (m && m[1] === t) return json(200, bundles[0].teamThresholds);
  return json(404, {});
}

let nextSourceTeam = 2981;
async function org({ bind = true } = {}) {
  const o = await createGpexePilotOrg(admin, { athleteNames: athleteIds.map((id) => `${NAME_MARK} ${id}`) });
  const sourceTeamId = String(nextSourceTeam++);
  visibleTeams.add(Number(sourceTeamId));
  const padmin = await makeUser("platform-admin");
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [padmin]);
  await setWorkspace(padmin, "platform", null);
  const cadmin = await makeUser("club-admin");
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [cadmin, o.clubId]);
  await setWorkspace(cadmin, "club", o.clubId);
  const coach = await makeUser("coach");
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coach, o.teamId]);
  await setWorkspace(coach, "team", o.teamId);
  const cookies = { padmin: await cookieFor(padmin), cadmin: await cookieFor(cadmin), coach: await cookieFor(coach) };
  assert.equal((await api(`/gpexe/teams/${o.teamId}/settings`, { method: "PUT", cookie: cookies.padmin, body: { gpexeTeamId: sourceTeamId } })).status, 200);
  for (let i = 0; i < athleteIds.length; i += 1) {
    const r = await api(`/gpexe/teams/${o.teamId}/athlete-links`, { method: "POST", cookie: cookies.coach, body: { gpexeAthleteId: String(athleteIds[i]), athleteId: o.athleteIds[i] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  if (bind) {
    const c = await api("/sources/gpexe/connections", { method: "POST", cookie: cookies.cadmin, body: { ownerScope: "club", ownerClubId: o.clubId, hostKey: "server3", accountLabel: "Club account (label only)", credentialKind: "exchanged_token" } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal((await api(`/sources/gpexe/connections/${c.body.connection.id}/connect`, { method: "POST", cookie: cookies.cadmin, body: { username: USERNAME, password: PASSWORD } })).status, 200);
    assert.equal((await api(`/sources/gpexe/connections/${c.body.connection.id}/bindings`, { method: "POST", cookie: cookies.cadmin, body: { teamId: o.teamId, sourceTeamId } })).status, 201);
    importer.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a team with an active binding"); });
  }
  return { ...o, sourceTeamId, cookies };
}
const serve = (o) => { src.served = o.sourceTeamId; src.data = fixture(o.sourceTeamId); };

// One check through the route, awaited to its end; what it sent and logged.
async function runCheck(o, { countStatements = false } = {}) {
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  importer.setCheckRunObserver(() => release());
  src.calls.length = 0;
  lines.length = 0;
  statements = 0;
  counting = countStatements;
  try {
    const r = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.cookies.coach, body: { from: DAY, to: DAY } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    // A check that never reaches its end fails here instead of hanging.
    let timer;
    const stuck = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the check did not end within 60 s")), 60_000); });
    try {
      if (r.body.check.status === "running") await Promise.race([done, stuck]);
    } finally {
      clearTimeout(timer);
    }
    const row = (await q(`select status, error_code, sessions_seen, candidates_new, candidates_changed, candidates_unchanged from training_load.gpexe_import_checks where id = $1`, [r.body.check.id]))[0];
    return { row, calls: [...src.calls], lines: [...lines], statements };
  } finally {
    counting = false;
  }
}

function parseLine(line) {
  assert.ok(line.startsWith(timing.CHECK_TIMING_PREFIX), "the line has the fixed prefix");
  const fields = Object.fromEntries(line.slice(timing.CHECK_TIMING_PREFIX.length).split("; ").map((part) => {
    const at = part.indexOf("=");
    return [part.slice(0, at), part.slice(at + 1)];
  }));
  const kinds = (value) => (value === "untracked" ? "untracked" : Object.fromEntries(value.split(",").map((p) => { const [k, n] = p.split(":"); return [k, Number(n)]; })));
  return { ...fields, requests: kinds(fields.requests), net_ms: kinds(fields.net_ms) };
}
const sum = (o) => Object.values(o).reduce((s, n) => s + n, 0);

// What a line may never carry.
const SECRETS = [USERNAME, PASSWORD, TOKEN, NAME_MARK];
function assertNothingPrivate(line) {
  assert.ok(timing.checkTimingLineAccepted(line), `the line passes the closed grammar: ${line}`);
  assert.doesNotMatch(line, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "no uuid");
  assert.doesNotMatch(line, /\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/, "no date or time");
  assert.doesNotMatch(line, /https?:|gpexe\.com|server3|rest\/v1|\/api\/|\?|team_session/i, "no host, url or query");
  for (const s of SECRETS) assert.ok(!line.includes(s), `no secret marker or name (${s.slice(0, 12)}…)`);
}

// The request reduction (owner orders 2026-10-23 and 2026-10-24): a check reads no brief and no tag list
// (it strips the drill labels), the thresholds once per day, and one canary row per session (max_v from
// the details); before it this fixture cost 206 requests (athlete_detail 60, brief_tags 1, thresholds 3).
const EXPECTED_REQUESTS = {
  list_sessions: 8, parent_session: 3, athlete_list: 3, athlete_detail: 3, more: 60, track: 60,
  whole_details: 3, drill: 5, brief_tags: 0, thresholds: 1, other: 0,
};

// ---------------------------------------------------------------------------
test("1. a succeeded check writes exactly one timing line: the discovery fixture's counters, every request kind summing to what the check sent, the drills in order and once each, nothing private", async () => {
  const o = await org();
  serve(o);
  const run = await runCheck(o);
  assert.equal(run.row.status, "succeeded", JSON.stringify(run.row));
  assert.equal(run.row.candidates_new, 3);
  assert.equal(run.lines.length, 1, "exactly one timing line");
  const line = parseLine(run.lines[0]);
  assert.equal(line.v, "1");
  assert.equal(line.outcome, "succeeded");
  assert.equal(line.code, "none");
  assert.deepEqual(line.requests, EXPECTED_REQUESTS, "the fixture's request kinds (other stays 0)");
  assert.equal(sum(line.requests), run.calls.length, "the kinds sum to every request the check sent");
  assert.equal(run.calls.length, 146, "8 list pages + 3 × (parent, list, whole details, 1 canary row, 20 /more/, 20 tracks) + 5 drills + 1 thresholds (206 before the reduction)");
  assert.deepEqual(Object.keys(line.net_ms), timing.CHECK_TIMING_REQUEST_KINDS, "a network time for every kind");
  assert.equal(line.sessions_found, "3");
  assert.equal(line.sessions_done, "3");
  assert.equal(line.athletes, "60");
  assert.equal(line.tracks, "60");
  assert.equal(line.drills, "5");
  // 146 per-response pings + 2 after the list + 3 per session.
  assert.equal(line.heartbeats, "157");
  // before, between the two complete reads and after the list; before and after each bundle.
  assert.equal(line.revalidations, "9");
  assert.equal(line.previews, "3");
  for (const k of ["total_ms", "heartbeat_ms", "revalidation_ms", "retention_ms", "preview_ms", "staging_ms", "finalize_ms"]) {
    assert.match(line[k], /^(0|[1-9][0-9]{0,8})$/, `${k} is a whole number of milliseconds`);
  }
  // The drills of the five-drill parent: in order, each index once, no other parent's.
  const drills = run.calls.filter((k) => k.includes("?drill=")).map((k) => k.match(/team_session\/(\d+)\/details\/\?drill=(\d+)$/).slice(1).join(":"));
  assert.deepEqual(drills, ["3001:0", "3001:1", "3001:2", "3001:3", "3001:4"]);
  assertNothingPrivate(run.lines[0]);
});

test("2. a failed check writes exactly one timing line with its stable code; the requests counted are the ones sent before it stopped", async () => {
  const o = await org();
  serve(o);
  src.faults.drillMissing = { sid: "3001", index: 2 };
  try {
    const run = await runCheck(o);
    assert.equal(run.row.status, "failed");
    assert.equal(run.row.error_code, "drill_set_incomplete");
    assert.equal(run.lines.length, 1, "exactly one timing line");
    const line = parseLine(run.lines[0]);
    assert.equal(line.outcome, "failed");
    assert.equal(line.code, "drill_set_incomplete");
    // The details and drills are read before the rows (max_v from the details), and an incomplete drill
    // set reads no row, /more/ or track: the check stops before recording the session.
    assert.deepEqual(line.requests, {
      list_sessions: 8, parent_session: 1, athlete_list: 1, athlete_detail: 0, more: 0, track: 0,
      whole_details: 1, drill: 3, brief_tags: 0, thresholds: 1, other: 0,
    });
    assert.equal(sum(line.requests), run.calls.length);
    assert.equal(line.sessions_found, "3");
    assert.equal(line.sessions_done, "0");
    assert.equal(line.previews, "0", "nothing of the failed session was previewed");
    assertNothingPrivate(run.lines[0]);
  } finally {
    src.faults.drillMissing = null;
  }
});

test("3. an error the check does not know keeps its text out of the line: the code is internal_error, and the legacy path's requests are untracked", async () => {
  const o = await org({ bind: false });
  const marker = `MARKER unknown failure ${DAY} ${REST} ${TOKEN}`;
  importer.setGpexeClientFactory(() => ({
    async listTeamSessions() { throw new Error(marker); },
    async fetchSessionBundle() { throw new Error(marker); },
  }));
  const run = await runCheck(o);
  assert.equal(run.row.status, "failed");
  assert.equal(run.row.error_code, "internal_error");
  assert.equal(run.lines.length, 1, "exactly one timing line");
  const line = parseLine(run.lines[0]);
  assert.equal(line.outcome, "failed");
  assert.equal(line.code, "internal_error");
  assert.equal(line.requests, "untracked");
  assert.equal(line.net_ms, "untracked");
  assert.ok(!run.lines[0].includes("MARKER"), "no error text");
  assertNothingPrivate(run.lines[0]);
});

test("4. a failing logger, or a fault inside every method of the meter, changes nothing of the check", async () => {
  const o = await org();
  serve(o);
  const first = await runCheck(o);
  assert.equal(first.row.status, "succeeded");
  timing.setCheckTimingForTests({ sink: () => { throw new Error("the logger is down"); } });
  const loggerDown = await runCheck(o);
  timing.setCheckTimingForTests({ sink: (line) => lines.push(line), fault: () => { throw new Error("the meter is broken"); } });
  const meterDown = await runCheck(o);
  for (const [name, run] of [["logger down", loggerDown], ["meter broken", meterDown]]) {
    assert.deepEqual(run.row, { status: "succeeded", error_code: null, sessions_seen: 3, candidates_new: 0, candidates_changed: 0, candidates_unchanged: 3 }, name);
    assert.deepEqual(run.calls, first.calls, `${name}: the same requests in the same order`);
  }
  assert.equal(meterDown.lines.length, 0, "a meter that cannot measure writes nothing rather than a wrong line");
});

test("5. with the meter on or off: the same requests in the same order, the same number of database statements, the same published results", async () => {
  const o = await org();
  serve(o);
  assert.equal((await runCheck(o)).row.status, "succeeded");
  const published = () => q(
    `select gpexe_team_session_id as sid, status, bundle_hash, preview_hash, drill_parameter_effect as effect, md5(raw_bundle::text) as raw,
            superseded_by_candidate_id is not null as by_cand, superseded_by_check_id is not null as by_check
       from training_load.gpexe_import_candidates where owner_team_id = $1 order by gpexe_team_session_id, id`, [o.teamId]);
  const before = await published();
  // The retention's projection cursor starts at the same place for both runs.
  timing.setCheckTimingForTests({ enabled: false });
  importer.setProjectionBoundsForTests();
  const off = await runCheck(o, { countStatements: true });
  const afterOff = await published();
  timing.setCheckTimingForTests({ sink: (line) => lines.push(line) });
  importer.setProjectionBoundsForTests();
  const on = await runCheck(o, { countStatements: true });
  const afterOn = await published();
  assert.equal(off.lines.length, 0, "off: no line");
  assert.equal(on.lines.length, 1, "on: one line");
  assert.deepEqual(on.row, off.row, "the same check outcome and counts");
  assert.deepEqual(on.calls, off.calls, "the same requests in the same order");
  assert.equal(on.statements, off.statements, "not one database statement more for the measurement");
  assert.deepEqual(afterOff, before, "the off run republished the same candidates");
  assert.deepEqual(afterOn, before, "the on run republished the same candidates");
  assert.equal(sum(parseLine(on.lines[0]).requests), on.calls.length);
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_check_observations`))[0].n, 0, "no staging is left");
});

test("6. the closed sets: every code a check row can carry is in the meter's set, and the guard refuses any line outside the grammar", async () => {
  const read = (file) => fsp.readFile(path.join(SRC, file), "utf8");
  const codes = new Set(timing.CHECK_TIMING_CODES);
  const found = new Set(resolver.IMPORT_RESOLVE_CODES);
  for (const file of ["gpexeRestV1Adapter.js", "sourceAdapters.js"]) {
    for (const m of (await read(file)).matchAll(/new SourceAdapterError\(\s*"([a-z_]+)"/g)) found.add(m[1]);
  }
  for (const m of (await read("gpexeClient.js")).matchAll(/new GpexeClientError\(\s*"([a-z_]+)"/g)) found.add(m[1]);
  for (const code of found) assert.ok(codes.has(code), `${code} is in the meter's closed set`);
  for (const code of ["internal_error", "check_outcome_unknown"]) assert.ok(codes.has(code));

  const meter = (() => { let out = null; timing.setCheckTimingForTests({ sink: (l) => { out = l; } }); const m = timing.createCheckMeter(); m.outcome("failed", "drill_set_incomplete"); m.emit(); return out; })();
  assert.ok(timing.checkTimingLineAccepted(meter), meter);
  const swap = (from, to) => meter.replace(from, to);
  for (const bad of [
    swap("code=drill_set_incomplete", "code=Something went wrong"),
    swap("code=drill_set_incomplete", "code=8c1f2e4a-0000-4000-8000-000000000000"),
    swap("total_ms=", "window=2026-10-05; total_ms="),
    swap("total_ms=", "url=https://server3.gpexe.com/; total_ms="),
    swap("athletes=0", "athletes=-1"),
    swap("athletes=0", "athletes=1.5"),
    `${meter}; extra=1`,
    meter.replace("[gpexe] check timing", "[gpexe] check"),
  ]) assert.ok(!timing.checkTimingLineAccepted(bad), `refused: ${bad}`);
  assert.ok(timing.checkTimingLineAccepted(timing.CHECK_TIMING_FALLBACK_LINE));

  // An unknown code becomes `other`; a second emit writes nothing.
  const out = [];
  timing.setCheckTimingForTests({ sink: (l) => out.push(l) });
  const m = timing.createCheckMeter();
  m.request({ kind: "not_a_kind" }, m.start());
  m.outcome("failed", "a code with 2026-10-05 in it");
  m.emit();
  m.emit();
  assert.equal(out.length, 1);
  assert.equal(parseLine(out[0]).code, "other");
  assert.equal(parseLine(out[0]).requests.other, 1);
});

test("7. a finalization whose COMMIT is never answered writes outcome=unknown with its stable code, never failed", async () => {
  const o = await org();
  serve(o);
  importer.setCheckFinalizeForTests({ commit: () => new Promise(() => {}), commitBoundMs: 200 });
  try {
    const run = await runCheck(o);
    assert.equal(run.row.error_code, "check_finalize_outcome_unknown", JSON.stringify(run.row));
    assert.equal(run.lines.length, 1, "exactly one timing line");
    const line = parseLine(run.lines[0]);
    assert.equal(line.outcome, "unknown");
    assert.equal(line.code, "check_finalize_outcome_unknown");
    assertNothingPrivate(run.lines[0]);
  } finally {
    importer.setCheckFinalizeForTests({});
  }
});

test("8. max_v from the details: 146 requests instead of 203 (one canary row read per session) and the same stored bundles - a check with every row read, then the default check, finds every session unchanged", async () => {
  const o = await org();
  serve(o);
  importer.setCheckMaxSpeedFromDetailsForTests(false);
  let first;
  try {
    first = await runCheck(o);
  } finally {
    importer.setCheckMaxSpeedFromDetailsForTests(null);
  }
  assert.equal(first.row.status, "succeeded", JSON.stringify(first.row));
  assert.equal(first.row.candidates_new, 3);
  assert.equal(first.calls.length, 203, "every row read");
  const run = await runCheck(o);
  assert.equal(run.row.status, "succeeded", JSON.stringify(run.row));
  assert.deepEqual([run.row.candidates_new, run.row.candidates_changed, run.row.candidates_unchanged], [0, 0, 3], "the stored bundles and their hashes are the same");
  assert.deepEqual(parseLine(run.lines[0]).requests, EXPECTED_REQUESTS);
  assert.equal(run.calls.length, 146);
  const rowReads = run.calls.filter((k) => /^\/rest\/v1\/athlete_session\/\d+\/$/.test(k));
  assert.deepEqual(rowReads, src.data.bundles.map((b) => `/rest/v1/athlete_session/${b.athleteSessions[0].id}/`), "the canary is each session's first row, read once");
});

test("9. a canary that differs from its list row with the details' max_v: that session's rows are all read on their own, the others keep one canary, and the check succeeds with the rows' own values", async () => {
  const o = await org();
  serve(o);
  const second = src.data.bundles[1];
  second.details.full.players[String(second.athleteSessions[0].athlete)].max_values_speed.value += 0.5;
  const run = await runCheck(o);
  assert.equal(run.row.status, "succeeded", JSON.stringify(run.row));
  assert.equal(run.row.candidates_new, 3);
  assert.equal(parseLine(run.lines[0]).requests.athlete_detail, 1 + 20 + 1, "one canary, every row of the second session, one canary");
  assert.equal(run.calls.length, 146 + 19);
});

test("10. the date filter applied by the source: the check asks for the look-back day and the window with two days of margin, reads 2 list pages instead of 8 (two reads of one page), and finds the same sessions with the same stored bundles", async () => {
  const o = await org();
  serve(o);
  const first = await runCheck(o);
  assert.equal(first.row.status, "succeeded", JSON.stringify(first.row));
  assert.equal(first.row.candidates_new, 3);
  src.applyDateFilter = true;
  try {
    const run = await runCheck(o);
    assert.equal(run.row.status, "succeeded", JSON.stringify(run.row));
    assert.deepEqual([run.row.candidates_new, run.row.candidates_changed, run.row.candidates_unchanged], [0, 0, 3], "the same sessions, the same stored bundles");
    assert.deepEqual(parseLine(run.lines[0]).requests, { ...EXPECTED_REQUESTS, list_sessions: 2 });
    assert.equal(run.calls.length, 146 - 6);
    assert.ok(run.calls.filter((k) => k.startsWith("/rest/v1/team_session/?")).every((k) => k.includes("start_timestamp_gte=") && k.includes("start_timestamp_lte=")));
  } finally {
    src.applyDateFilter = false;
  }
});

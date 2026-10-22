// A check meets the source's "slow down" (429) - owner decision 2026-10-22: on
// a disposable optimove_tests_gpexe_* database (never OPTIMOVE) through the
// real server, against a fake server3 (the discovery fixture of the timing
// test: three sessions of one day, one with five drills, twenty linked
// athletes, a whole list of 320 rows). The check repeats a rate-limited
// request at most once, only after a whole-seconds Retry-After within the
// maximum, never after an Unbind or a closed check during the wait; any other
// 429 stops it with no further request, and the administrator reads why.
// No real GPEXE request, no real wait (the resolver's sleep seam).
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
import { rateLimitDiagnosticAccepted } from "../src/gpexeCheckRateLimit.js";

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
let currentCheckId = null;
const sleeps = [];
let onSleep = null;
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
  // No real wait: the resolver's sleep seam records each tick; a scenario may
  // act during the wait (an Unbind, a check closed elsewhere, a stale sweep).
  resolver.setImportSourceSleepForTests(async (ms) => {
    sleeps.push(ms);
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (onSleep) await onSleep(ms);
  });
});

after(async () => {
  timing?.setCheckTimingForTests({});
  importer?.setGpexeClientFactory(null);
  importer?.setCheckRunObserver(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  resolver?.setImportSourceSleepForTests(null);
  resolver?.setImportSourceRevalidateHoldForTests(null);
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
  onSleep = null;
  sleeps.length = 0;
  src.fault = null;
  resolver.setImportSourceRevalidateHoldForTests(null);
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
const src = { calls: [], served: null, data: null, faults: { drillMissing: null }, fault: null, seen: new Map() };
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
  const n = (src.seen.get(key) ?? 0) + 1;
  src.seen.set(key, n);
  if (src.fault) { const hit = await src.fault(key, n); if (hit) return hit; }
  if ((init.headers?.Authorization ?? "") !== `Token ${TOKEN}`) return json(401, {});
  if (key === "/rest/v1/team/") return json(200, [...visibleTeams].map((id) => ({ id, name: `Team ${id}` })), { "x-total-count": String(visibleTeams.size) });
  let m = key.match(/^\/rest\/v1\/team\/(\d+)\/$/);
  if (m) return visibleTeams.has(Number(m[1])) ? json(200, { id: Number(m[1]), name: `Team ${m[1]}` }) : json(404, {});
  const t = src.served;
  if (t === null) return json(404, {});
  const { bundles, rows } = src.data;
  const bySid = (sid) => bundles.find((b) => String(b.teamSession.id) === String(sid));
  m = key.match(new RegExp(`^/rest/v1/team_session/\\?team=${t}&limit=100(?:&offset=(\\d+))?$`));
  if (m) {
    const offset = Number(m[1] ?? 0);
    const next = offset + 100 < rows.length ? { link: `<${REST}team_session/?team=${t}&limit=100&offset=${offset + 100}>; rel="next"` } : {};
    return json(200, rows.slice(offset, offset + 100), { "x-total-count": String(rows.length), ...next });
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
    o.connectionId = c.body.connection.id;
    o.bindingId = (await q(`select id from training_load.source_team_bindings where team_id = $1 and state = 'active'`, [o.teamId]))[0].id;
    importer.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a team with an active binding"); });
  }
  return { ...o, sourceTeamId, cookies };
}
const serve = (o) => { src.served = o.sourceTeamId; src.data = fixture(o.sourceTeamId); src.seen = new Map(); };

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
    currentCheckId = r.body.check.id;
    // A check that never reaches its end fails here instead of hanging.
    let timer;
    const stuck = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the check did not end within 60 s")), 60_000); });
    try {
      if (r.body.check.status === "running") await Promise.race([done, stuck]);
    } finally {
      clearTimeout(timer);
    }
    const row = (await q(`select id, status, error_code, error_message, heartbeat_at, sessions_seen, candidates_new, candidates_changed, candidates_unchanged from training_load.gpexe_import_checks where id = $1`, [r.body.check.id]))[0];
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


const BASELINE_REQUESTS = 206; // the discovery fixture's check without a 429 (gpexe-check-timing.test.mjs)
const slowDown = (headers = {}) => new Response("{}", { status: 429, headers: { "content-type": "application/json", ...headers } });
const TRACK = (o) => `/rest/v1/track/${3011 * 1000 + 4}/`; // one athlete's track of the second session
const DIAGNOSTIC = " Diagnostic: ";
async function checkViews(o, id) {
  const coach = await api(`/gpexe/teams/${o.teamId}/checks/${id}`, { cookie: o.cookies.coach });
  const padmin = await api(`/gpexe/teams/${o.teamId}/checks/${id}`, { cookie: o.cookies.padmin });
  return { coach: coach.body.check, admin: padmin.body.check };
}
const published = async (o) => (await q(`select count(*)::int as n from training_load.gpexe_import_candidates where owner_team_id = $1`, [o.teamId]))[0].n;
const heartbeatOf = async (id) => (await q(`select heartbeat_at from training_load.gpexe_import_checks where id = $1`, [id]))[0].heartbeat_at;

test("1. one 429 with Retry-After 2 on a track: the check waits (with a heartbeat), checks the binding again, repeats that one request and succeeds - one request more than without it", async () => {
  const o = await org();
  serve(o);
  let atWait = null;
  let atRepeat = null;
  let revalidationsDuringWait = 0;
  let waiting = false;
  resolver.setImportSourceRevalidateHoldForTests(async () => { if (waiting) revalidationsDuringWait += 1; });
  onSleep = async () => { waiting = true; atWait ??= await heartbeatOf(currentCheckId); };
  src.fault = async (key, n) => {
    if (key !== TRACK(o)) return null;
    if (n === 1) return slowDown({ "retry-after": "2" });
    atRepeat = await heartbeatOf(currentCheckId);
    waiting = false;
    return null;
  };
  const { row, calls, lines: ls } = await runCheck(o);
  assert.equal(row.status, "succeeded", row.error_message ?? "");
  assert.deepEqual(sleeps, [2000], "exactly the wait the source named");
  assert.equal(calls.length, BASELINE_REQUESTS + 1);
  assert.equal(calls.filter((k) => k === TRACK(o)).length, 2, "the same request, once more");
  assert.ok(atRepeat > atWait, "the heartbeat moved during the wait");
  assert.ok(revalidationsDuringWait >= 1, "the binding facts were checked again before the repeat");
  assert.equal(await published(o), 3);
  assert.match(ls.find((l) => l.startsWith(timing.CHECK_TIMING_PREFIX)), /outcome=succeeded; code=none;/);
});

test("2. a second 429 after the wait stops the check at once: source_unavailable with the administrator's line, no request after it, nothing published; a coach reads the sentence only", async () => {
  const o = await org();
  serve(o);
  src.fault = async (key) => (key === TRACK(o) ? slowDown({ "retry-after": "2" }) : null);
  const { row, calls, lines: ls } = await runCheck(o);
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "source_unavailable");
  assert.ok(row.error_message.startsWith(`The source server asked to slow down.${DIAGNOSTIC}`), row.error_message);
  const line = row.error_message.slice(row.error_message.indexOf(DIAGNOSTIC) + DIAGNOSTIC.length);
  assert.ok(rateLimitDiagnosticAccepted(line), line);
  assert.match(line, /^op=rate_limit; request_kind=track; requests_sent=(\d+); elapsed_s=\d+; first_429_request=(\d+); first_429_elapsed_s=\d+; retry_after=seconds; retry_after_s=2; retry_used=yes; outcome=second_429\.$/);
  const [, sent, first] = line.match(/requests_sent=(\d+);.*first_429_request=(\d+);/);
  assert.equal(Number(sent), Number(first) + 1, "the stop is the repeat of the first 429");
  assert.equal(Number(sent), calls.length, "the count is every request of this check");
  assert.equal(calls[calls.length - 1], TRACK(o), "the second 429 was the last request");
  assert.equal(calls.filter((k) => k === TRACK(o)).length, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(await published(o), 0);
  const views = await checkViews(o, row.id);
  assert.equal(views.coach.error.code, "source_unavailable");
  assert.equal(views.coach.error.message, "The source server asked to slow down.", "a coach never sees the line");
  assert.ok(views.admin.error.message.includes(DIAGNOSTIC + line), "an administrator does");
  assert.match(ls.find((l) => l.startsWith(timing.CHECK_TIMING_PREFIX)), /outcome=failed; code=source_unavailable;/);
});

test("3. a 429 without Retry-After, or one past the maximum wait: no wait, no repeat, the check stops at once with the reason", async () => {
  for (const [headers, expected] of [[{}, /retry_after=absent; retry_after_s=none; retry_used=no; outcome=no_retry_after\.$/], [{ "retry-after": "3600" }, /retry_after=seconds; retry_after_s=3600; retry_used=no; outcome=retry_after_over_max\.$/], [{ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, /retry_after=date; retry_after_s=none; retry_used=no; outcome=retry_after_date\.$/]]) {
    const o = await org();
    serve(o);
    sleeps.length = 0;
    src.fault = async (key) => (key === TRACK(o) ? slowDown(headers) : null);
    const { row, calls } = await runCheck(o);
    assert.equal(row.status, "failed", JSON.stringify(headers));
    assert.equal(row.error_code, "source_unavailable");
    assert.match(row.error_message, expected);
    assert.deepEqual(sleeps, [], "no wait");
    assert.equal(calls.filter((k) => k === TRACK(o)).length, 1, "never repeated");
    assert.equal(calls[calls.length - 1], TRACK(o), "nothing after the 429");
  }
});

test("4. an Unbind during the wait: the repeat is never sent, the check stops with binding_ended and sends nothing more", async () => {
  const o = await org();
  serve(o);
  let unbind = null;
  onSleep = async () => {
    unbind = await api(`/sources/gpexe/connections/${o.connectionId}/bindings/${o.bindingId}/unbind`, { method: "POST", cookie: o.cookies.cadmin, body: { requestKey: crypto.randomUUID(), reason: "Ended during the wait", expected: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } } });
  };
  src.fault = async (key) => (key === TRACK(o) ? slowDown({ "retry-after": "2" }) : null);
  const { row, calls } = await runCheck(o);
  assert.equal(unbind?.status, 200, JSON.stringify(unbind?.body));
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "binding_ended");
  assert.equal(calls.filter((k) => k === TRACK(o)).length, 1, "the repeat was not sent");
  assert.equal(calls[calls.length - 1], TRACK(o), "nothing after the 429");
  assert.equal(await published(o), 0);
});

test("5. a check closed elsewhere during the wait (abandoned): no repeat, the run stops and leaves the row as it was closed", async () => {
  const o = await org();
  serve(o);
  onSleep = async () => {
    await q(`update training_load.gpexe_import_checks set status = 'failed', finished_at = now(), error_code = 'abandoned', error_message = 'closed for the test' where id = $1 and status = 'running'`, [currentCheckId]);
  };
  src.fault = async (key) => (key === TRACK(o) ? slowDown({ "retry-after": "2" }) : null);
  const { row, calls, lines: ls } = await runCheck(o);
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "abandoned", "never overwritten by the run");
  assert.equal(calls.filter((k) => k === TRACK(o)).length, 1);
  assert.equal(calls[calls.length - 1], TRACK(o));
  assert.match(ls.find((l) => l.startsWith(timing.CHECK_TIMING_PREFIX)), /outcome=closed_elsewhere;/);
});

test("6. the stale sweep during a wait does not close the waiting check: a heartbeat made 16 minutes old during the second tick is renewed by that tick before the sweep of the third, and the check succeeds", async () => {
  const o = await org();
  serve(o);
  const beats = [];
  let tick = 0;
  onSleep = async () => {
    tick += 1;
    beats.push(await heartbeatOf(currentCheckId));
    // Make the check look abandoned; only the tick after this sleep can save it.
    if (tick === 2) await q(`update training_load.gpexe_import_checks set heartbeat_at = now() - interval '16 minutes' where id = $1`, [currentCheckId]);
    // The stale sweep (every check and the server's schedule run it): it closes
    // a running check whose heartbeat is older than 15 minutes.
    if (tick === 3) await importer.runRetention("interval");
  };
  src.fault = async (key, n) => (key === TRACK(o) && n === 1 ? slowDown({ "retry-after": "25" }) : null);
  const { row } = await runCheck(o);
  assert.equal(row.status, "succeeded", row.error_message ?? "");
  assert.deepEqual(sleeps, [10_000, 10_000, 5_000], "a long wait in ticks of at most 10 s");
  assert.equal(beats.length, 3);
  assert.ok(beats[1] > beats[0], "the heartbeat moves after every tick of the wait, not only at its end");
  assert.ok(beats[2] > beats[1], "the 16-minute-old heartbeat was renewed by the tick, before the sweep");
});

test("7. a 429 with Retry-After 1 on the second page of the whole list: repeated once, the two complete reads still agree, the check succeeds", async () => {
  const o = await org();
  serve(o);
  const page2 = new RegExp(`^/rest/v1/team_session/\\?team=${o.sourceTeamId}&limit=100&offset=100$`);
  src.fault = async (key, n) => (page2.test(key) && n === 1 ? slowDown({ "retry-after": "1" }) : null);
  const { row, calls } = await runCheck(o);
  assert.equal(row.status, "succeeded", row.error_message ?? "");
  assert.equal(calls.length, BASELINE_REQUESTS + 1);
  assert.deepEqual(sleeps, [1000]);
});

test("8. one repeat per check: after a repeat that succeeded, a later 429 is not repeated and stops the check (retry_already_used); the next check has its own repeat again", async () => {
  const o = await org();
  serve(o);
  const OTHER = `/rest/v1/track/${3021 * 1000 + 7}/`;
  src.fault = async (key, n) => ((key === TRACK(o) && n === 1) || key === OTHER ? slowDown({ "retry-after": "1" }) : null);
  const { row, calls } = await runCheck(o);
  assert.equal(row.status, "failed");
  assert.match(row.error_message, /request_kind=track; .*retry_used=yes; outcome=retry_already_used\.$/);
  assert.equal(calls[calls.length - 1], OTHER);
  assert.deepEqual(sleeps, [1000]);
  sleeps.length = 0;
  src.seen = new Map();
  src.fault = async (key, n) => (key === TRACK(o) && n === 1 ? slowDown({ "retry-after": "1" }) : null);
  const again = await runCheck(o);
  assert.equal(again.row.status, "succeeded", again.row.error_message ?? "");
  assert.deepEqual(sleeps, [1000]);
});

test("9. fail-closed: a source opened with rateLimitRetry but without the run's own check (setBeforeRateLimitRetry) never sends the repeat", async () => {
  const o = await org();
  serve(o);
  const facts = await resolver.resolveImportSourceFacts(admin, { teamId: o.teamId });
  resolver.preflightImportSource(facts);
  const source = resolver.openImportSource(facts, { rateLimitRetry: true });
  const LIST_FIRST = new RegExp(`^/rest/v1/team_session/\\?team=${o.sourceTeamId}&limit=100$`);
  src.calls.length = 0;
  src.fault = async (key, n) => (LIST_FIRST.test(key) && n === 1 ? slowDown({ "retry-after": "1" }) : null);
  const client = resolver.importClientFor(source);
  await assert.rejects(client.listTeamSessions({ gpexeTeamId: o.sourceTeamId, fromDay: DAY, toDay: DAY }), (e) => e.code === "context_not_issued");
  assert.equal(src.calls.filter((k) => LIST_FIRST.test(k)).length, 1, "the list page was not repeated");
  assert.equal(src.calls.length, 1, "nothing else was sent");
});

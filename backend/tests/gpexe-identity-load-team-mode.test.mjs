// D3 (after the pilot): the team's own coach may start the identity load, but only while the team's import switch is on in
// mode `team` (v56). The service holds that right in every phase of the load (the claim, a replay, and FOR SHARE in the
// finalize), so a switch-off or a move to `pilot` during a load ends it as rights_changed with nothing stored. Everyone else
// keeps the identical 404; the stored list (GET athlete-identities) stays the administrators'. No migration.
// U3 (J19): suggested athlete pairs - the matching rule and the read
// GET /teams/:teamId/athlete-pair-suggestions, on a disposable
// optimove_tests_gpexe_* database against a fake source (never OPTIMOVE, no
// real GPEXE request). Plan: docs/ai/u3-suggested-pairs-plan.md.
// Every name and date below is a made-up marker.
// Every name and date below is a made-up marker; the suite scans responses,
// log lines, audit rows and request rows for them.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, createGpexePilotOrg, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import * as cryptoMod from "../src/sourceCredentialCrypto.js";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const ORIGINAL_ACTIVE = process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION;
const ORIGINAL_ENV_TOKEN = process.env.GPEXE_API_TOKEN;

const USERNAME = "marker-username-identity@example.invalid";
const PASSWORD = "MARKER-password-identity-not-real";
const TOKEN = "MARKER-token-identity-not-real-0123456789";
const SOURCE_SENTENCE = "Marker sentence from the source server body";
const EXCHANGE_URL = "https://server3.gpexe.com/api-token-auth/";
const REST = "https://server3.gpexe.com/rest/v1/";
const LEGACY = "https://server3.gpexe.com/api/";
const DAY = "2026-09-14";
// Made-up identity markers: every first / last name, short name and extra
// field the fake source sends carries one of these prefixes.
const FIRST = "Zqfirst";
const LAST = "Zqlast";
const SHORT = "ZqshortMARK";
const EXTRA = "ZqextraMARK";
const DOB = (id) => `19${String(80 + (Number(id) % 20)).padStart(2, "0")}-0${1 + (Number(id) % 9)}-1${Number(id) % 10}`;

let db, admin, server, apiBase, identity, importer, connections, resolver, createSession, appPool;
const logLines = [];
const originalConsole = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "idteam" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  // The real public.athletes has birth_date (athleteProfile.js); the legacy test scaffold does not.
  await admin.query(`alter table public.athletes add column if not exists birth_date date`);
  process.env.DATABASE_URL = db.url;
  process.env.SOURCE_CREDENTIAL_KEYS = cryptoMod.generateKeyEntry(1);
  delete process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION;
  delete process.env.GPEXE_API_TOKEN;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : safeString(a))).join(" "));
      if (process.env.IDENTITY_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  identity = await import("../src/gpexeAthleteIdentityService.js");
  importer = await import("../src/gpexeImportService.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  connections.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 5_000 });
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  identity?.setIdentityFetchForTests(null);
  identity?.setIdentityTimingForTests(null);
  connections?.setSourceFetchForTests(null);
  connections?.setSourceConnectionTimingForTests?.({});
  resolver?.setImportSourceFetchForTests(null);
  importer?.setCheckRunObserver(null);
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS; else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
  if (ORIGINAL_ACTIVE === undefined) delete process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION; else process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION = ORIGINAL_ACTIVE;
  if (ORIGINAL_ENV_TOKEN === undefined) delete process.env.GPEXE_API_TOKEN; else process.env.GPEXE_API_TOKEN = ORIGINAL_ENV_TOKEN;
});

afterEach(() => {
  identity.setIdentityTimingForTests(null);
  identity.setIdentityFinalizeHoldForTests(null);
  identity.setIdentityCommitFaultForTests(null);
  identity.setIdentityVerifyFaultForTests(null);
  identity.setIdentityInsertFaultForTests(null);
  identity.setIdentityListHoldForTests(null);
  resolver.setImportSourceRevalidateHoldForTests(null);
  importer.setCheckRunObserver(null);
});

// ---------------------------------------------------------------------------
// helpers
function safeString(value) { try { return JSON.stringify(value); } catch { return String(value); } }
const SECRETS = [USERNAME, PASSWORD, TOKEN, SOURCE_SENTENCE];
const PII = [FIRST, LAST, SHORT, EXTRA];
function noSecret(text, where) {
  for (const s of SECRETS) assert.ok(!String(text).includes(s), `${where} carries a secret marker (${s.slice(0, 14)}…)`);
}
function noPii(text, where) {
  for (const s of PII) assert.ok(!String(text).includes(s), `${where} carries an identity marker (${s})`);
  assert.doesNotMatch(String(text), /19[89]\d-0\d-1\d/, `${where} carries a date-of-birth marker`);
}
async function api(p, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  noSecret(text, `the response to ${method} ${p}`);
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text, cacheControl: res.headers.get("cache-control") };
}
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
const uid = () => crypto.randomBytes(4).toString("hex");
async function makeUser(label) { return (await q(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${uid()}@test.local`, label]))[0].id; }
async function setWorkspace(userId, type, scopeId) {
  await q(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3) on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
async function cookieFor(userId) { return `optimove_session=${await createSession(userId)}`; }
async function platformAdmin(workspace = ["platform", null]) {
  const id = await makeUser("platform-admin");
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, ...workspace);
  return { id, cookie: await cookieFor(id) };
}
async function clubAdmin(clubId) {
  const id = await makeUser("club-admin");
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await setWorkspace(id, "club", clubId);
  return { id, cookie: await cookieFor(id) };
}
async function coachOf(teamId) {
  const id = await makeUser("coach");
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return { id, cookie: await cookieFor(id) };
}
let nextSourceTeam = 4700;
async function org() {
  const o = await createGpexePilotOrg(admin, { athleteNames: ["A101", "B102", "C103"] });
  const sourceTeamId = String(nextSourceTeam++);
  const padmin = await platformAdmin();
  const coach = await coachOf(o.teamId);
  const cadmin = await clubAdmin(o.clubId);
  assert.equal((await api(`/gpexe/teams/${o.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } })).status, 200);
  return { ...o, sourceTeamId, padmin, coach, cadmin };
}

// The fake source: the exchange and the team reads (Connect / bind), the
// rest_v1 session reads of one served team (a real check), and the athlete
// records. Per athlete id an answer can be scripted: a status, a body, a
// delay, a hang.
const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
function fakeSource() {
  const calls = [];
  const st = { visible: new Set(), served: null, bundle: null, athlete: new Map(), inflight: 0, maxInflight: 0, delayMs: 0, holdAthletes: null };
  const json = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const abortable = (init, p) => new Promise((resolve, reject) => {
    if (init.signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    p.then(resolve, reject);
  });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const key = `${u.pathname}${u.search}`;
    const auth = init.headers?.Authorization ?? null;
    calls.push({ key, method: init.method ?? "GET", redirect: init.redirect, auth: auth === `Token ${TOKEN}` ? "connection" : auth ? "other" : "none" });
    if (String(url) === EXCHANGE_URL) {
      const params = new URLSearchParams(init.body);
      return params.get("username") === USERNAME && params.get("password") === PASSWORD ? json(200, { token: TOKEN }) : json(400, { non_field_errors: [SOURCE_SENTENCE] });
    }
    if (!String(url).startsWith(REST) && !String(url).startsWith(LEGACY)) return json(404, { detail: "not served" });
    if (init.method !== "GET") return json(405, {});
    if (auth !== `Token ${TOKEN}`) return json(401, { detail: SOURCE_SENTENCE });
    let m = key.match(/^\/rest\/v1\/athlete\/(\d+)\/$/);
    if (m) {
      const id = m[1];
      st.inflight += 1;
      st.maxInflight = Math.max(st.maxInflight, st.inflight);
      try {
        if (st.holdAthletes) await abortable(init, st.holdAthletes.p);
        const script = st.athlete.get(id) ?? {};
        const delay = script.delayMs ?? st.delayMs;
        if (script.hang) await abortable(init, new Promise(() => {}));
        if (delay) await abortable(init, new Promise((r) => setTimeout(r, delay)));
        if (script.status && script.status !== 200) return json(script.status, script.body ?? { detail: SOURCE_SENTENCE }, script.headers ?? {});
        if (script.raw !== undefined) return new Response(script.raw, { status: 200, headers: { "content-type": "application/json" } });
        return json(200, script.body ?? { id: Number(id), first_name: `${FIRST}${id}`, last_name: `${LAST}${id}`, name: `${FIRST}${id} ${LAST}${id} full`, short_name: SHORT, birthdate: DOB(id), extra_one: EXTRA, picture: EXTRA });
      } finally {
        st.inflight -= 1;
      }
    }
    if (key === "/rest/v1/team/") return json(200, [...st.visible].map((id) => ({ id, name: `team ${id}` })), { "x-total-count": String(st.visible.size) });
    m = key.match(/^\/rest\/v1\/team\/(\d+)\/$/);
    if (m) return st.visible.has(Number(m[1])) ? json(200, { id: Number(m[1]), name: `team ${m[1]}` }) : json(404, { detail: SOURCE_SENTENCE });
    // The rest_v1 session reads of the served team (a real check, test 3).
    const t = st.served; const b = st.bundle;
    if (t === null) return json(404, { detail: "no team served" });
    const sid = b.teamSession.id;
    if (key.replace(/&start_timestamp_gte=[^&]*&start_timestamp_lte=[^&]*/, "") === `/rest/v1/team_session/?team=${t}&limit=100`) {
      const base = { team: Number(t), category_name: "DRILL", start_timestamp: b.teamSession.start_timestamp, end_timestamp: b.teamSession.end_timestamp, updated_on: b.teamSession.updated_on, is_stats_valid: true, drills: [], drills_count: 0 };
      const rows = [{ ...b.teamSession, drills: [sid * 1000 + 1, sid * 1000 + 2], drills_count: 2 }, { ...base, id: sid * 1000 + 1 }, { ...base, id: sid * 1000 + 2 }];
      return json(200, rows, { "x-total-count": String(rows.length) });
    }
    if (key === `/rest/v1/team_session/${sid}/`) return json(200, { ...b.teamSession, drills_count: 2 });
    if (key === `/rest/v1/athlete_session/?teamsession=${sid}&limit=100`) return json(200, b.athleteSessions, { "x-total-count": String(b.athleteSessions.length) });
    m = key.match(/^\/rest\/v1\/athlete_session\/(\d+)\/(more\/)?$/);
    if (m) {
      const row = b.athleteSessions.find((r) => String(r.id) === m[1]);
      return row ? json(200, m[2] ? b.more[m[1]] : row) : json(404, { detail: SOURCE_SENTENCE });
    }
    m = key.match(/^\/rest\/v1\/track\/(\d+)\/$/);
    if (m) return b.tracks[m[1]] ? json(200, b.tracks[m[1]]) : json(404, { detail: SOURCE_SENTENCE });
    if (key === `/rest/v1/team_session/${sid}/details/`) return json(200, { drills_count: 2, players: b.details.full.players, team: { aggregate: 1 }, teamsession: sid });
    m = key.match(/^\/api\/team_session\/(\d+)\/details\/\?drill=(\d)$/);
    if (m) return json(200, { drills_count: 2, players: b.details.drills[m[2]].players, team: { aggregate: 1 }, teamsession: sid * 1000 + Number(m[2]) + 1 });
    if (key === `/api/team_session/${sid}/brief/`) return json(404, { detail: SOURCE_SENTENCE });
    if (key === `/rest/v1/team/${t}/thresholds/?valid_on=${DAY}`) return json(200, b.teamThresholds);
    return json(404, { detail: "not served" });
  };
  const serve = (sourceTeamId) => {
    st.served = String(sourceTeamId);
    st.bundle = makeBundle({ sessionId: Number(sourceTeamId) * 10, gpexeTeamId: Number(sourceTeamId), athletes: standardAthletes(), detailsDrills: [0, 1] });
  };
  return { calls, fetchImpl, st, serve };
}
let src;
const useSource = () => {
  src = fakeSource();
  connections.setSourceFetchForTests(src.fetchImpl);
  resolver.setImportSourceFetchForTests(src.fetchImpl);
  identity.setIdentityFetchForTests(src.fetchImpl);
  return src;
};
const athleteCalls = () => src.calls.filter((c) => c.key.startsWith("/rest/v1/athlete/"));
const CREATE = (club) => ({ ownerScope: "club", ownerClubId: club, hostKey: "server3", accountLabel: "Club account (label only)", credentialKind: "exchanged_token" });
async function bound(o) {
  src.st.visible.add(Number(o.sourceTeamId));
  const c = await api("/sources/gpexe/connections", { method: "POST", cookie: o.cadmin.cookie, body: CREATE(o.clubId) });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const r = await api(`/sources/gpexe/connections/${c.body.connection.id}/connect`, { method: "POST", cookie: o.cadmin.cookie, body: { username: USERNAME, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = await api(`/sources/gpexe/connections/${c.body.connection.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  return { conn: c.body.connection, binding: b.body.result.binding };
}
async function unbind(o, conn, binding) {
  return api(`/sources/gpexe/connections/${conn.id}/bindings/${binding.bindingId}/unbind`, { method: "POST", cookie: o.cadmin.cookie, body: { requestKey: crypto.randomUUID(), reason: "test: end the binding", expected: { teamId: binding.teamId, sourceTeamId: binding.sourceTeamId } } });
}
// A stored chain without a network check: one check row and one candidate
// whose preview names the given athletes.
let sessionSeq = 700000;
async function seedChain(o, { conn, binding }, athleteIds, { status = "succeeded", path: sourcePath = "source_connection", bindingId = binding?.bindingId, startedAt = "2026-09-14T10:00:00Z", userId = o.padmin.id } = {}) {
  const check = (await q(
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id, source_path, source_connection_id, source_binding_id, source_team_id, source_host_key, error_code)
     values ($1, $2, $3, '2026-09-14', '2026-09-14', now(), $4, $5, $6, $7, $8, $9, $10) returning id`,
    [o.teamId, userId, status, o.sourceTeamId, sourcePath, sourcePath === "source_connection" ? conn.id : null, sourcePath === "source_connection" ? bindingId : null, sourcePath === "source_connection" ? o.sourceTeamId : null, sourcePath === "source_connection" ? "server3" : null, status === "failed" ? "source_unavailable" : null],
  ))[0].id;
  const preview = { session: { categoryName: "FULL" }, athletes: athleteIds.map((id) => ({ gpexeAthleteId: String(id), results: [] })) };
  await q(
    `insert into training_load.gpexe_import_candidates (owner_team_id, gpexe_team_session_id, session_started_at, session_label, bundle_hash, raw_bundle, raw_expires_at, status, preview, preview_hash, preview_computed_at, first_seen_check_id, last_seen_check_id)
     values ($1, $2, $3, 'S', $4, '{}'::jsonb, now() + interval '30 days', 'pending', $5::jsonb, $6, now(), $7, $7)`,
    [o.teamId, String(sessionSeq++), startedAt, crypto.randomBytes(32).toString("hex"), JSON.stringify(preview), crypto.randomBytes(32).toString("hex"), check],
  );
  return check;
}
const ids = (from, n) => Array.from({ length: n }, (_, i) => String(from + i));
const load = (o, cookie = o.padmin.cookie, requestKey = crypto.randomUUID()) => api(`/gpexe/teams/${o.teamId}/athlete-identities/loads`, { method: "POST", cookie, body: { requestKey } });
const list = (o, cookie = o.padmin.cookie) => api(`/gpexe/teams/${o.teamId}/athlete-identities`, { cookie });
const rowsOf = (teamId) => q(`select gpexe_athlete_id, display_name, to_char(birth_date, 'YYYY-MM-DD') as birth_date, observed_at, expires_at, binding_id, connection_id, source_team_id from training_load.gpexe_athlete_identities where owner_team_id = $1 order by length(gpexe_athlete_id), gpexe_athlete_id`, [teamId]);
const requestsOf = (teamId) => q(`select * from training_load.gpexe_athlete_identity_requests where owner_team_id = $1 order by started_at`, [teamId]);
const connRow = async (id) => (await q(`select state, last_error_code from training_load.source_credential_connections where id = $1`, [id]))[0];
const auditOf = (id) => q(`select action, outcome, error_code, basis, metadata from training_load.source_connection_audit where connection_id = $1 order by performed_at, id`, [id]);
async function ready(n = 3, from = 501) {
  const o = await org();
  useSource();
  const b = await bound(o);
  await seedChain(o, b, ids(from, n));
  return { o, ...b };
}

const sug = (o, cookie) => api(`/gpexe/teams/${o.teamId}/athlete-pair-suggestions`, { cookie });
async function setAthlete(id, name, dob) { await q(`update public.athletes set full_name = $2, display_name = $2, birth_date = $3 where id = $1`, [id, name, dob]); }
async function scriptG(id, first, last, birthdate) { src.st.athlete.set(String(id), { body: { id: Number(id), first_name: first, last_name: last, birthdate } }); }
const KEYS = {
  top: ["ambiguous", "dateConflicts", "exact", "expiresAt", "snapshotCount", "state"],
  exact: ["athleteId", "athleteName", "birthDate", "gpexeAthleteId", "gpexeName"],
  ambiguous: ["birthDate", "candidates", "gpexeAthleteId", "gpexeName"],
  candidate: ["athleteId", "athleteName"],
  conflict: ["athleteId", "athleteName", "birthDate", "gpexeAthleteId", "gpexeName"],
};
const keys = (x) => Object.keys(x).sort();
const NOT_FOUND = { error: "notFound" };


const statusOf = async (o, cookie) => (await api(`/gpexe/teams/${o.teamId}/status`, { cookie })).body;
const teamMode = (o, mode = "team", enabled = true) => enableTeamImportSwitch(admin, o.teamId, o.padmin.id, { mode, enabled });

test("1. a team coach in the team workspace: no switch, the switch off, or on in pilot mode - the identical 404 and no request row; on in team mode - the load runs and stores the snapshot", async () => {
  const { o } = await ready(3, 801);
  for (const id of ids(801, 3)) await scriptG(id, FIRST, `${LAST}${id}`, DOB(id));
  const missing = await api(`/gpexe/teams/00000000-0000-4000-8000-000000000000/athlete-identities/loads`, { method: "POST", cookie: o.coach.cookie, body: { requestKey: crypto.randomUUID() } });
  for (const setup of [async () => {}, () => teamMode(o, "team", false), () => teamMode(o, "pilot", true)]) {
    await setup();
    const r = await load(o, o.coach.cookie);
    assert.equal(r.status, 404, r.text);
    assert.deepEqual(r.body, NOT_FOUND);
    assert.equal(r.text, missing.text, "the identical 404");
    assert.equal(r.cacheControl, "no-store");
    assert.equal((await statusOf(o, o.coach.cookie)).viewer.identityLoad, undefined, "no load offered to the coach");
  }
  assert.equal((await requestsOf(o.teamId)).length, 0, "nothing was claimed");
  await teamMode(o, "team", true);
  assert.equal((await statusOf(o, o.coach.cookie)).viewer.identityLoad, true);
  assert.equal((await statusOf(o, o.coach.cookie)).viewer.identityAdmin, undefined, "the coach is still not an identity administrator");
  const r = await load(o, o.coach.cookie);
  assert.equal(r.status, 200, r.text);
  assert.equal((await rowsOf(o.teamId)).length, 3, "the snapshot is stored");
  const reqs = await requestsOf(o.teamId);
  assert.equal(reqs.length, 1);
  assert.equal(String(reqs[0].requested_by_user_id ?? reqs[0].user_id), String(o.coach.id), "the coach's own request");
  noPii(r.text, "the coach's load answer carries counts only");
});

test("2. team mode does not widen anything else: the stored list stays the administrators' (identical 404 for the coach), a coach of another team, another club's admin and a user without a role get the identical 404", async () => {
  const { o } = await ready(2, 811);
  await teamMode(o, "team", true);
  const missing = await api(`/gpexe/teams/00000000-0000-4000-8000-000000000000/athlete-identities`, { cookie: o.coach.cookie });
  const lst = await list(o, o.coach.cookie);
  assert.equal(lst.status, 404);
  assert.equal(lst.text, missing.text);
  const other = await org();
  const foreignCoach = other.coach;
  const otherClubAdmin = other.cadmin;
  const nobody = await makeUser("nobody");
  await setWorkspace(nobody, "team", o.teamId);
  for (const [who, cookie] of [["a coach of another team", foreignCoach.cookie], ["another club's admin", otherClubAdmin.cookie], ["a user without a role", await cookieFor(nobody)]]) {
    const r = await load(o, cookie);
    assert.equal(r.status, 404, `${who}: ${r.text}`);
    assert.deepEqual(r.body, NOT_FOUND);
  }
  assert.equal((await requestsOf(o.teamId)).length, 0);
  // The administrators are unchanged in any mode.
  assert.equal((await statusOf(o, o.padmin.cookie)).viewer.identityLoad, true);
  assert.equal((await statusOf(o, o.cadmin.cookie)).viewer.identityLoad, true);
});

test("3. the switch moved to pilot while the coach's load reads GPEXE: the finalize finds the right gone - rights_changed, nothing stored; a replay of the same key by the coach is the identical 404", async () => {
  const { o } = await ready(2, 821);
  for (const id of ids(821, 2)) await scriptG(id, FIRST, `${LAST}${id}`, DOB(id));
  await teamMode(o, "team", true);
  const inner = src.fetchImpl;
  let flipped = false;
  identity.setIdentityFetchForTests(async (url, opts) => {
    if (!flipped && String(url).includes("/rest/v1/athlete/")) { flipped = true; await teamMode(o, "pilot", true); }
    return inner(url, opts);
  });
  const key = crypto.randomUUID();
  try {
    const r = await load(o, o.coach.cookie, key);
    assert.equal(r.status, 404, r.text);
    assert.deepEqual(r.body, NOT_FOUND);
  } finally {
    identity.setIdentityFetchForTests(src.fetchImpl);
  }
  assert.equal(flipped, true, "the switch moved during the network phase");
  assert.equal((await rowsOf(o.teamId)).length, 0, "nothing stored");
  const [req] = await requestsOf(o.teamId);
  assert.equal(req.status, "failed");
  assert.equal(req.error_code, "rights_changed");
  const again = await load(o, o.coach.cookie, key);
  assert.equal(again.status, 404, "the replay re-checks the right");
  // An administrator's load is unaffected by the mode.
  assert.equal((await load(o, o.padmin.cookie)).status, 200);
});

test("4. a switch-off waits for a finalize that holds the switch row (FOR SHARE), and the next coach load sees it off", async () => {
  const { o } = await ready(2, 831);
  for (const id of ids(831, 2)) await scriptG(id, FIRST, `${LAST}${id}`, DOB(id));
  await teamMode(o, "team", true);
  const g1 = gate();
  const reached = gate();
  identity.setIdentityFinalizeHoldForTests(async () => { reached.release(); await g1.p; });
  const loading = load(o, o.coach.cookie);
  let offDone = false;
  try {
    await reached.p;
    const off = teamMode(o, "team", false).then(() => { offDone = true; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(offDone, false, "the switch-off waits for the load's finalize");
    g1.release();
    assert.equal((await loading).status, 200, "the load that held the right completes");
    await off;
  } finally {
    identity.setIdentityFinalizeHoldForTests(null);
    g1.release();
  }
  assert.equal(offDone, true);
  const after = await load(o, o.coach.cookie);
  assert.equal(after.status, 404, "after the switch-off the coach's load is the identical 404");
});

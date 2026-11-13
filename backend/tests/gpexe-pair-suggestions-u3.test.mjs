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
import * as matching from "../src/gpexePairMatching.js";

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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "identity" });
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
let nextSourceTeam = 4100;
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

test("1. the pure rule: diacritics, case, token order, extra spaces; exact only for one-to-one with equal present dates; a missing date, a shared name on either side, one athlete for two GPEXE athletes are ambiguous; equal names with different dates are a date conflict", () => {
  assert.equal(matching.nameKey("  Ana   MARIĆ "), matching.nameKey("maric ana"));
  assert.equal(matching.nameKey("Đorđe Šimić"), matching.nameKey("dorde simic"));
  assert.equal(matching.nameKey("Ａna Marić"), matching.nameKey("Ana Marić"), "NFKC");
  assert.equal(matching.nameKey("   "), null);
  assert.equal(matching.nameKey(null), null);
  const G = (id, name, birthDate) => ({ gpexeAthleteId: id, name, birthDate });
  const A = (id, name, birthDate) => ({ athleteId: id, name, birthDate });
  const ids = (r) => ({ e: r.exact.map((p) => p.gpexe.gpexeAthleteId), a: r.ambiguous.map((p) => p.gpexe.gpexeAthleteId), c: r.dateConflicts.map((p) => p.gpexe.gpexeAthleteId) });
  assert.deepEqual(ids(matching.computePairSuggestions([G("1", "Ana Marić", "2005-01-02")], [A("a", "Marić Ana", "2005-01-02")])), { e: ["1"], a: [], c: [] });
  assert.deepEqual(ids(matching.computePairSuggestions([G("1", "Ana Marić", "2005-01-02")], [A("a", "Ana Marić", "2005-01-03")])), { e: [], a: [], c: ["1"] });
  assert.deepEqual(ids(matching.computePairSuggestions([G("1", "Ana Marić", null)], [A("a", "Ana Marić", "2005-01-02")])), { e: [], a: ["1"], c: [] });
  assert.deepEqual(ids(matching.computePairSuggestions([G("1", "Ana Marić", "2005-01-02")], [A("a", "Ana Marić", null)])), { e: [], a: ["1"], c: [] });
  assert.deepEqual(ids(matching.computePairSuggestions([G("1", "Ana Marić", "2005-01-02"), G("2", "Ana Marić", "2005-01-02")], [A("a", "Ana Marić", "2005-01-02")])), { e: [], a: ["1", "2"], c: [] }, "two GPEXE athletes, one athlete");
  assert.deepEqual(ids(matching.computePairSuggestions([G("1", "Ana Marić", "2005-01-02")], [A("a", "Ana Marić", "2005-01-02"), A("b", "Ana Marić", "2005-01-02")])), { e: [], a: ["1"], c: [] }, "one GPEXE athlete, two athletes");
  assert.deepEqual(ids(matching.computePairSuggestions([G("1", "Ana Marić", "2005-01-02")], [A("a", "Eva Kos", "2005-01-02")])), { e: [], a: [], c: [] }, "different names never pair");
  assert.deepEqual(ids(matching.computePairSuggestions([G("1", null, "2005-01-02")], [A("a", "Ana", "2005-01-02")])), { e: [], a: [], c: [] }, "no GPEXE name");
});

test("2. the team's coach (team workspace), the club admin and a platform admin read the three lists for their team; the answer keys are an allow-list, no-store, no snapshot beyond the lists", async () => {
  const { o } = await ready(5, 3001);
  await setAthlete(o.athleteIds[0], "Ana Zqmarić", "2005-01-02");
  await setAthlete(o.athleteIds[1], "Bojan Zqkos", "2004-05-06");
  await setAthlete(o.athleteIds[2], "Cara Zqdup", "2003-07-08");
  await scriptG(3001, "Zqmarić", "Ana", "2005-01-02");     // exact (token order, diacritics)
  await scriptG(3002, "Bojan", "ZQKOS", "2004-05-07");     // date conflict
  await scriptG(3003, "Cara", "Zqdup", "2003-07-08");      // ambiguous: a second athlete below
  await scriptG(3004, "Unknown", "Person", "2001-01-01");  // no athlete
  await scriptG(3005, "Dora", "Zqnodate", null);           // one athlete of that name, but no date: ambiguous
  const [extra] = await q(`insert into public.athletes (full_name, display_name, device_timezone, birth_date) values ('Cara Zqdup','Cara Zqdup','Europe/Sarajevo','2003-07-08') returning id`);
  await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status) values ($1,$2,$3,'team','active')`, [extra.id, o.clubId, o.teamId]);
  const [dora] = await q(`insert into public.athletes (full_name, display_name, device_timezone) values ('Dora Zqnodate','Dora Zqnodate','Europe/Sarajevo') returning id`);
  await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status) values ($1,$2,$3,'team','active')`, [dora.id, o.clubId, o.teamId]);
  assert.equal((await load(o)).status, 200);
  for (const who of [o.coach, o.cadmin, o.padmin]) {
    const r = await sug(o, who.cookie);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.cacheControl, "no-store");
    assert.deepEqual(keys(r.body), KEYS.top);
    assert.equal(r.body.state, "ok");
    assert.equal(r.body.snapshotCount, 5);
    assert.ok(r.body.expiresAt);
    assert.deepEqual(r.body.exact.map((p) => keys(p)), [KEYS.exact]);
    assert.deepEqual(r.body.exact.map((p) => [p.gpexeAthleteId, p.athleteId, p.birthDate]), [["3001", o.athleteIds[0], "2005-01-02"]]);
    assert.deepEqual(r.body.dateConflicts.map((p) => [keys(p), p.gpexeAthleteId, p.athleteId]), [[KEYS.conflict, "3002", o.athleteIds[1]]]);
    assert.ok(!r.text.includes("2004-05-06"), "OptiMove's own date of birth is never returned");
    const amb = r.body.ambiguous.map((p) => p.gpexeAthleteId).sort();
    assert.deepEqual(amb, ["3003", "3005"]);
    for (const p of r.body.ambiguous) { assert.deepEqual(keys(p), KEYS.ambiguous); for (const c of p.candidates) assert.deepEqual(keys(c), KEYS.candidate); }
    assert.ok(!r.text.includes("Unknown"), "a GPEXE athlete without any team athlete of that name is not listed");
  }
  // The coach never gets the full identity list (plan coach-gpexe-name: the unlinked names only, no date) or, in pilot mode,
  // the load.
  const coachList = await list(o, o.coach.cookie);
  assert.equal(coachList.status, 200);
  assert.ok(coachList.body.identities.every((i) => !("birthDate" in i)) && !("birthDateConflicts" in coachList.body));
  assert.equal((await load(o, o.coach.cookie)).status, 404);
});

test("3. identical 404 {error:notFound} with no-store for: a coach of another team, a user with no role, a revoked coach, an inactive user, an athlete-only user, a club admin in the team workspace without a coach role, another club's admin, an archived team or club, a team without a binding, an ended binding; 401 without a session", async () => {
  const { o, conn, binding } = await ready(2, 3101);
  await scriptG(3101, "Ana", "Test", "2005-01-02");
  await load(o);
  const other = await org();                       // another team, another club, its own coach
  const outsiders = {
    otherTeamCoach: other.coach,
    noRoleUser: await (async () => { const id = await makeUser("nobody"); await setWorkspace(id, "team", o.teamId); return { id, cookie: await cookieFor(id) }; })(),
    otherClubAdmin: other.cadmin,
  };
  for (const [name, who] of Object.entries(outsiders)) {
    const r = await sug(o, who.cookie);
    assert.equal(r.status, 404, name);
    assert.deepEqual(r.body, NOT_FOUND, name);
    assert.equal(r.cacheControl, "no-store", name);
    noPii(r.text, name);
  }
  assert.equal((await api(`/gpexe/teams/${o.teamId}/athlete-pair-suggestions`)).status, 401);
  // A revoked coach and an inactive user.
  const revoked = await coachOf(o.teamId);
  await q(`update public.user_team_roles set is_active = false where user_id = $1`, [revoked.id]);
  assert.deepEqual((await sug(o, revoked.cookie)).body, NOT_FOUND);
  const inactive = await coachOf(o.teamId);
  await q(`update public.users set is_active = false where id = $1`, [inactive.id]);
  assert.notEqual((await sug(o, inactive.cookie)).status, 200);
  // Archived team / club and an ended binding: the same 404, with no PII.
  assert.equal((await sug(o, o.coach.cookie)).status, 200);
  assert.equal((await unbind(o, conn, binding)).status, 200);
  const afterUnbind = await sug(o, o.coach.cookie);
  assert.deepEqual([afterUnbind.status, afterUnbind.body], [404, NOT_FOUND]);
  const never = await org();                         // never bound
  assert.deepEqual((await sug(never, never.coach.cookie)).body, NOT_FOUND);
  const o2 = (await ready(2, 3151)).o;
  await scriptG(3151, "Ana", "Test", "2005-01-02");
  await load(o2);
  await q(`update public.teams set is_active = false where id = $1`, [o2.teamId]);
  assert.deepEqual((await sug(o2, o2.coach.cookie)).body, NOT_FOUND);
  await q(`update public.teams set is_active = true where id = $1`, [o2.teamId]);
  await q(`update public.clubs set is_active = false where id = $1`, [o2.clubId]);
  assert.deepEqual((await sug(o2, o2.coach.cookie)).body, NOT_FOUND);
});

test("4. nothing leaks across teams or links: a linked GPEXE athlete's identity and a linked team athlete are not offered; another team's identical names are never listed; a coach never sees a name outside the lists", async () => {
  const { o } = await ready(6, 3201);
  const peer = await ready(3, 3201);             // a second team with the SAME GPEXE ids and names
  for (const t of [o, peer.o]) {
    await setAthlete(t.athleteIds[0], "Ana Zqone", "2005-01-02");
    await setAthlete(t.athleteIds[1], "Bojan Zqtwo", "2004-04-04");
  }
  await scriptG(3201, "Ana", "Zqone", "2005-01-02");
  await scriptG(3202, "Bojan", "Zqtwo", "2004-04-04");
  await scriptG(3203, "Hidden", "Zqlinked", "2001-01-01");
  // The linked pair shares name and date, so it WOULD be an exact pair if the link filters were missing.
  await setAthlete(o.athleteIds[2], "Hidden Zqlinked", "2001-01-01");
  // Each link filter must hold alone: a linked GPEXE athlete's name collides with an UNLINKED team athlete, and a linked team athlete's name with an UNLINKED GPEXE athlete.
  const addAthlete = async (name, dob) => {
    const [a] = await q(`insert into public.athletes (full_name, display_name, device_timezone, birth_date) values ($1,$1,'Europe/Sarajevo',$2) returning id`, [name, dob]);
    await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status) values ($1,$2,$3,'team','active')`, [a.id, o.clubId, o.teamId]);
    return a.id;
  };
  const pee = await addAthlete("Pee Zqp", "1990-01-01");
  const gonlyTarget = await addAthlete("Gonly Zqlink", "1999-09-09");
  const aonly = await addAthlete("Aonly Zqlink", "1998-08-08");
  await scriptG(3204, "Gonly", "Zqlink", "1999-09-09");   // will be linked to Pee; Gonly Zqlink (unlinked) shares its name
  await scriptG(3205, "Aonly", "Zqlink", "1998-08-08");   // stays unlinked; its same-name athlete will be linked elsewhere
  await scriptG(3206, "Zzz", "Zqother", "1980-02-02");    // will be linked to the athlete named Aonly Zqlink
  await load(o); await load(peer.o);
  const linkIn = (t, g, a) => api(`/gpexe/teams/${t.teamId}/athlete-links`, { method: "POST", cookie: t.padmin.cookie, body: { gpexeAthleteId: g, athleteId: a } });
  assert.equal((await linkIn(o, "3204", pee)).status, 201);
  assert.equal((await linkIn(o, "3206", aonly)).status, 201);
  // Link 3203 in team o to its third athlete: its name must not come back, neither may its athlete.
  assert.equal((await api(`/gpexe/teams/${o.teamId}/athlete-links`, { method: "POST", cookie: o.padmin.cookie, body: { gpexeAthleteId: "3203", athleteId: o.athleteIds[2] } })).status, 201);
  // Link 3202 in the PEER team only.
  assert.equal((await api(`/gpexe/teams/${peer.o.teamId}/athlete-links`, { method: "POST", cookie: peer.o.padmin.cookie, body: { gpexeAthleteId: "3202", athleteId: peer.o.athleteIds[1] } })).status, 201);
  const r = await sug(o, o.coach.cookie);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.exact.map((p) => p.gpexeAthleteId).sort(), ["3201", "3202"], "3202 is still unlinked in THIS team; neither a linked GPEXE athlete nor a linked team athlete forms a pair");
  assert.deepEqual(r.body.ambiguous, []);
  assert.ok(!r.text.includes("3204") && !r.text.includes("3206") && !r.text.includes(gonlyTarget) && !r.text.includes(aonly));
  assert.ok(!r.text.includes("Hidden") && !r.text.includes("Zqlinked") && !r.text.includes("2001-01-01"), "a linked GPEXE athlete's identity is not offered");
  assert.ok(!JSON.stringify(r.body).includes(o.athleteIds[2]), "a linked team athlete is not offered");
  const r2 = await sug(peer.o, peer.o.coach.cookie);
  assert.deepEqual(r2.body.exact.map((p) => p.gpexeAthleteId), ["3201"], "the peer's own link hides 3202 there");
  for (const a of r2.body.exact) assert.ok(peer.o.athleteIds.includes(a.athleteId), "only the peer team's athletes");
  // The peer coach cannot read team o's suggestions.
  assert.deepEqual((await sug(o, peer.o.coach.cookie)).body, NOT_FOUND);
});

test("5. no loaded names (empty snapshot) and an expired snapshot: state no_identities_loaded, empty lists, no count of GPEXE athletes; an expired row is never offered", async () => {
  const { o } = await ready(2, 3301);
  await scriptG(3301, "Ana", "Test", "2005-01-02");
  await setAthlete(o.athleteIds[0], "Ana Test", "2005-01-02");
  const empty = await sug(o, o.coach.cookie);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { state: "no_identities_loaded", snapshotCount: 0, expiresAt: null, exact: [], ambiguous: [], dateConflicts: [] });
  await load(o);
  assert.equal((await sug(o, o.coach.cookie)).body.exact.length, 1);
  await q(`alter table training_load.gpexe_athlete_identities disable trigger user`);
  try { await q(`update training_load.gpexe_athlete_identities set observed_at = observed_at - interval '30 days', expires_at = expires_at - interval '30 days' where owner_team_id = $1`, [o.teamId]); }
  finally { await q(`alter table training_load.gpexe_athlete_identities enable trigger user`); }
  const gone = await sug(o, o.coach.cookie);
  assert.equal(gone.body.state, "no_identities_loaded");
  assert.ok(!gone.text.includes("Ana"));
});

test("6. the right is checked again under the lock: a coach role ended after the route's check and before the read's locks reads nothing (identical 404); a role change while the read holds its locks waits for the read", async () => {
  const { o } = await ready(2, 3401);
  await scriptG(3401, "Ana", "Test", "2005-01-02");
  await setAthlete(o.athleteIds[0], "Ana Test", "2005-01-02");
  await load(o);
  const c1 = await coachOf(o.teamId);
  identity.setIdentityListHoldForTests(async (when) => {
    if (when === "before") await q(`update public.user_team_roles set is_active = false where user_id = $1`, [c1.id]);
  });
  const r1 = await sug(o, c1.cookie);
  assert.deepEqual([r1.status, r1.body], [404, NOT_FOUND]);
  noPii(r1.text, "revoked before the lock");
  identity.setIdentityListHoldForTests(null);
  // While the read holds its locks, the revocation waits (and the next read is 404).
  const c2 = await coachOf(o.teamId);
  const g = gate();
  let revokeDone = false;
  identity.setIdentityListHoldForTests(async (when) => {
    if (when === "locked") await g.p;
  });
  const inFlight = sug(o, c2.cookie);
  await new Promise((r) => setTimeout(r, 300));
  const rev = (async () => {
    const c = new pg.Client({ connectionString: db.url }); await c.connect();
    try { await c.query(`set lock_timeout = '5s'`); await c.query(`update public.user_team_roles set is_active = false where user_id = $1`, [c2.id]); revokeDone = true; } finally { await c.end(); }
  })();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(revokeDone, false, "the revocation waits for the read");
  g.release();
  const read = await inFlight;
  assert.equal(read.status, 200);
  await rev;
  identity.setIdentityListHoldForTests(null);
  assert.deepEqual((await sug(o, c2.cookie)).body, NOT_FOUND);
});

test("7. a link made between the suggestion and the confirmation: the existing link route refuses that pair and the others still link; the link route is unchanged (a stale pair is not re-matched there)", async () => {
  const { o } = await ready(2, 3501);
  await scriptG(3501, "Ana", "Zqa", "2005-01-02");
  await scriptG(3502, "Bojan", "Zqb", "2004-04-04");
  await setAthlete(o.athleteIds[0], "Ana Zqa", "2005-01-02");
  await setAthlete(o.athleteIds[1], "Bojan Zqb", "2004-04-04");
  await load(o);
  const r = await sug(o, o.coach.cookie);
  assert.equal(r.body.exact.length, 2);
  // Someone links 3501 meanwhile.
  assert.equal((await api(`/gpexe/teams/${o.teamId}/athlete-links`, { method: "POST", cookie: o.padmin.cookie, body: { gpexeAthleteId: "3501", athleteId: o.athleteIds[0] } })).status, 201);
  const results = [];
  for (const p of r.body.exact) results.push((await api(`/gpexe/teams/${o.teamId}/athlete-links`, { method: "POST", cookie: o.coach.cookie, body: { gpexeAthleteId: p.gpexeAthleteId, athleteId: p.athleteId } })).status);
  assert.deepEqual(results.map((s) => s === 201), [false, true]);
  const after = await sug(o, o.coach.cookie);
  assert.deepEqual([after.body.exact.length, after.body.ambiguous.length, after.body.dateConflicts.length], [0, 0, 0]);
});

test("8. an athlete whose team membership is not active is offered in none of the three lists (exact, ambiguous, date conflict)", async () => {
  const { o } = await ready(3, 3601);
  await scriptG(3601, "Gone", "Zqexact", "2005-01-02");
  await scriptG(3602, "Gone", "Zqamb", null);
  await scriptG(3603, "Gone", "Zqdiff", "2005-01-02");
  await setAthlete(o.athleteIds[0], "Gone Zqexact", "2005-01-02");
  await setAthlete(o.athleteIds[1], "Gone Zqamb", "2005-01-02");
  await setAthlete(o.athleteIds[2], "Gone Zqdiff", "2006-06-06");
  await load(o);
  const before = await sug(o, o.coach.cookie);
  assert.deepEqual([before.body.exact.length, before.body.ambiguous.length, before.body.dateConflicts.length], [1, 1, 1], "all three kinds are offered while the memberships are active");
  await q(`update public.athlete_memberships set status = 'archived' where team_id = $1`, [o.teamId]);
  const after = await sug(o, o.coach.cookie);
  assert.equal(after.status, 200);
  assert.deepEqual([after.body.exact, after.body.ambiguous, after.body.dateConflicts], [[], [], []]);
  assert.ok(!after.text.includes("Gone"), "no name of a former member");
});

test("9. lock order users then role (#191): a revocation that holds the users row and then updates the role row never deadlocks with the read - the read waits at the users row and then finds the role ended (identical 404)", async () => {
  const { o } = await ready(2, 3701);
  await scriptG(3701, "Ana", "Zqlock", "2005-01-02");
  await setAthlete(o.athleteIds[0], "Ana Zqlock", "2005-01-02");
  await load(o);
  for (const who of ["coach", "club admin"]) {
    const subject = who === "coach" ? await coachOf(o.teamId) : await clubAdmin(o.clubId);
    assert.equal((await sug(o, subject.cookie)).status, 200);
    const writer = new pg.Client({ connectionString: db.url });
    await writer.connect();
    try {
      await writer.query("begin");
      await writer.query(`select 1 from public.users where id = $1 for update`, [subject.id]);
      const reading = sug(o, subject.cookie);
      await new Promise((r) => setTimeout(r, 400));
      await writer.query(who === "coach" ? `update public.user_team_roles set is_active = false where user_id = $1` : `update public.user_club_roles set is_active = false where user_id = $1`, [subject.id]);
      await writer.query("commit");
      const r = await reading;
      assert.deepEqual([r.status, r.body], [404, NOT_FOUND], `${who}: no deadlock, the read sees the ended role`);
    } finally {
      await writer.end();
    }
  }
});

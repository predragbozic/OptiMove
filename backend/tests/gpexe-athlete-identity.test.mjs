// GPEXE athlete identity (owner order 2026-10-06): the administrator's
// explicit, read-only load of rest/v1/athlete/<id>/ and the 14-day snapshot of
// migration v32, on a disposable optimove_tests_gpexe_* database (never
// OPTIMOVE) against a fake source. No real GPEXE request, no real credential.
// Discovery: docs/ai/gpexe-athlete-identity-discovery.md.
//
// Every name and date below is a made-up marker; the suite scans responses,
// log lines, audit rows and request rows for them.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyGpexeTestMigrations, createGpexeDisposableDb, createGpexePilotOrg, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import * as cryptoMod from "../src/sourceCredentialCrypto.js";
import * as rules from "../src/gpexeAthleteIdentity.js";

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
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V32 = "202610061000_training_load_v32_gpexe_athlete_identities.sql";
const UP_TO_V31 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V32));
const V32_ROLLBACK = path.resolve(ROOT, "docs/runbooks/gpexe-athlete-identities-v32-rollback.sql");

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
    if (key === `/rest/v1/team_session/?team=${t}&start_timestamp_gte=2026-09-13%2000%3A00%3A00&start_timestamp_lte=${DAY}%2023%3A59%3A59&limit=100`) {
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

// ---------------------------------------------------------------------------
test("1. the pure rules: a display name is Unicode NFC, trimmed, space runs collapsed, and refused whole (never cleaned) for a control, bidi, zero-width, private-use or blank-letter character, no letter or more than 120 characters; first + last only when both are usable, then name, then null; short_name and every other key are never read", () => {
  const N = rules.normalizeNamePart;
  assert.equal(N("  Ana  "), "Ana");
  assert.equal(N("Ana\u00A0\u2003Marija"), "Ana Marija", "space separators collapse to one space");
  assert.equal(N("José"), "José", "NFC");
  assert.equal(N("Đorđe Šćepanović"), "Đorđe Šćepanović");
  for (const bad of ["Ana\tB", "Ana\nB", "A\u0000", "A\u007F", "A\u0085", "A\u202EB", "A\u2066B", "A\u200BB", "A\u200DB", "A\uFEFFB", "A\u00ADB", "A\u061CB", "A\u2028B", "A\uE000B", "A\u3164B", "A\u115FB", "\u2800", "12345", "  ", "", "A".repeat(121)]) assert.equal(N(bad), null, JSON.stringify(bad));
  assert.equal(N("A".repeat(120)), "A".repeat(120));
  for (const notText of [null, undefined, 5, {}, ["Ana"], true]) assert.equal(N(notText), null);
  const D = rules.displayNameOf;
  assert.equal(D({ first_name: " Ana ", last_name: "Marić", name: "Other Name", short_name: "X" }), "Ana Marić");
  assert.equal(D({ first_name: "Ana", last_name: "M\u202Eb", name: "Ana Full" }), "Ana Full", "one part refused: the name fallback");
  assert.equal(D({ first_name: "Ana", name: "Ana  Full" }), "Ana Full", "a missing part: the name fallback");
  assert.equal(D({ first_name: "A".repeat(70), last_name: "B".repeat(70), name: "Short Name" }), "Short Name", "first + last over 120: the name fallback, never cut");
  assert.equal(D({ first_name: "\u200B", last_name: "", name: "\u202E" }), null, "nothing usable: Name not provided");
  assert.equal(D({ short_name: "Shorty" }), null, "short_name is never used");
  assert.equal(D(), null);
});

test("2. the pure rules: a date of birth is a valid YYYY-MM-DD or a valid ISO date-time whose first ten characters are taken without any time-zone shift; null and empty give null without counting; every other form, an impossible date, a year before 1900 and a future date give null and count as unrecognised; the raw value never comes back", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const P = (v) => rules.parseBirthDate(v, now);
  assert.deepEqual(P("2000-02-29"), { birthDate: "2000-02-29", unrecognised: false });
  assert.deepEqual(P("1999-12-31T23:30:00-05:00"), { birthDate: "1999-12-31", unrecognised: false }, "no shift to UTC");
  assert.deepEqual(P("1999-12-31T23:30:00+14:00"), { birthDate: "1999-12-31", unrecognised: false });
  assert.deepEqual(P("2001-01-01T00:00Z"), { birthDate: "2001-01-01", unrecognised: false });
  // UTC offsets: at most +-14:00 (external review of PR #144).
  for (const ok of ["2001-01-01T10:00+14:00", "2001-01-01T10:00-14:00", "2001-01-01T10:00+1400", "2001-01-01T10:00+13:59", "2001-01-01T10:00-12:00", "2001-01-01T10:00+05:45"]) assert.deepEqual(P(ok), { birthDate: "2001-01-01", unrecognised: false }, ok);
  for (const bad of ["2001-01-01T10:00+14:01", "2001-01-01T10:00-14:01", "2001-01-01T10:00+14:30", "2001-01-01T10:00+15:00", "2001-01-01T10:00+23:59", "2001-01-01T10:00-23:59", "2001-01-01T10:00+1401"]) assert.deepEqual(P(bad), { birthDate: null, unrecognised: true }, bad);
  assert.deepEqual(P("2001-01-01T00:00:00.123456Z"), { birthDate: "2001-01-01", unrecognised: false });
  assert.deepEqual(P(null), { birthDate: null, unrecognised: false });
  assert.deepEqual(P(undefined), { birthDate: null, unrecognised: false });
  assert.deepEqual(P(""), { birthDate: null, unrecognised: false });
  assert.deepEqual(P("   "), { birthDate: null, unrecognised: false });
  for (const bad of ["2001-02-29", "2000-13-01", "2000-00-10", "2000-01-32", "1899-12-31", "2026-10-08", "01.02.2000", "2000/01/02", "20000102", "2000-1-2", " 2000-01-02", "2000-01-02 ", "2000-01-02T25:00:00Z", "2000-01-02T10:60Z", "2000-01-02T10:00:00+24:00", "2000-01-02Tgarbage", "2000-01-02T10", "yesterday", 946771200, true, {}, []]) {
    const r = P(bad);
    assert.deepEqual(r, { birthDate: null, unrecognised: true }, JSON.stringify(bad));
    assert.deepEqual(Object.keys(r).sort(), ["birthDate", "unrecognised"], "the raw value never comes back");
  }
  assert.equal(rules.formatBirthDate("2000-02-29"), "29.02.2000");
  // The answer projection reads exactly five keys and refuses another athlete's id.
  assert.deepEqual(rules.identityFromAnswer({ id: 7, first_name: "A", last_name: "B", birthdate: "2000-01-02", short_name: "S", extra: "E" }, "7", now), { ok: true, identity: { gpexeAthleteId: "7", displayName: "A B", birthDate: "2000-01-02" }, birthDateUnrecognised: false });
  assert.deepEqual(rules.identityFromAnswer({ id: 8, first_name: "A", last_name: "B" }, "7", now), { ok: false, reason: "id_mismatch" });
  assert.deepEqual(rules.identityFromAnswer({ id: "07", first_name: "A" }, "7", now), { ok: false, reason: "id_mismatch" });
  assert.deepEqual(rules.identityFromAnswer([{ id: 7 }], "7", now), { ok: false, reason: "not_an_object" });
  const inherited = Object.create({ id: 7, first_name: "Proto", last_name: "Type" });
  assert.deepEqual(rules.identityFromAnswer(inherited, "7", now), { ok: false, reason: "id_mismatch" }, "inherited keys are never read");
});

test("3. a real check through the binding loads no identity (zero athlete requests); the athletes a load may read come only from that succeeded check of the current binding — GET answers pendingCount 3 and no identity; the load reads exactly those three, each once, GET only, with the connection's token, and stores only the sanitized name and the date", async () => {
  const o = await org();
  useSource();
  const { conn, binding } = await bound(o);
  src.serve(o.sourceTeamId);
  const done = gate();
  importer.setCheckRunObserver(() => done.release());
  const started = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.coach.cookie, body: { from: DAY, to: DAY } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  if (started.body.check.status === "running") await done.p;
  assert.equal((await q(`select status from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0].status, "succeeded");
  assert.equal(athleteCalls().length, 0, "a check never reads an athlete record");
  const before = await list(o);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual([before.body.identities, before.body.pendingCount, before.body.maxPerLoad, before.body.retentionDays], [[], 3, 50, 14]);
  const r = await load(o);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.outcome, r.body.loaded, r.body.notFound, r.body.notRead, r.body.unrecognisedBirthDates, r.body.replayed], ["completed", 3, 0, 0, 0, false]);
  noPii(r.text, "the load's answer (counts only)");
  assert.deepEqual(athleteCalls().map((c) => c.key).sort(), ["/rest/v1/athlete/101/", "/rest/v1/athlete/102/", "/rest/v1/athlete/103/"]);
  assert.ok(athleteCalls().every((c) => c.method === "GET" && c.auth === "connection" && c.redirect === "manual"));
  const rows = await rowsOf(o.teamId);
  assert.deepEqual(rows.map((x) => [x.gpexe_athlete_id, x.display_name, x.birth_date]), ["101", "102", "103"].map((id) => [id, `${FIRST}${id} ${LAST}${id}`, DOB(id)]));
  assert.ok(rows.every((x) => x.binding_id === binding.bindingId && x.connection_id === conn.id && x.source_team_id === o.sourceTeamId));
  const columns = (await q(`select column_name from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_athlete_identities' order by ordinal_position`)).map((c) => c.column_name);
  assert.deepEqual(columns, ["id", "owner_team_id", "binding_id", "connection_id", "source_team_id", "gpexe_athlete_id", "display_name", "birth_date", "observed_at", "expires_at"], "no raw answer, no name parts, no short name, no extra field");
  const dump = JSON.stringify(await q(`select * from training_load.gpexe_athlete_identities where owner_team_id = $1`, [o.teamId]));
  assert.ok(!dump.includes(SHORT) && !dump.includes(EXTRA) && !dump.includes(" full"), "short_name, the extra fields and the name fallback are not stored when first + last are usable");
  const after = await list(o);
  assert.deepEqual(after.body.identities.map((i) => i.gpexeAthleteId), ["101", "102", "103"]);
  assert.equal(after.body.pendingCount, 0);
});

test("4. authorization and information hiding: a platform admin (platform or the team's club workspace) and the team's club admin (that club's workspace) get the identity; a coach, a platform admin in the team workspace, a club admin in another workspace, another club's admin, a revoked club admin, a missing or malformed team, an archived team or club, a never-bound team and an ended binding all get the identical 404 {error:notFound} with no-store, on GET and POST, and nothing is read; a coach's status has no identity trace", async () => {
  const { o, conn, binding } = await ready(2);
  const ok = async (cookie, who) => {
    const r = await list(o, cookie);
    assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.body)}`);
    assert.equal(r.cacheControl, "no-store", who);
  };
  const hidden = async (cookie, who, teamId = o.teamId) => {
    for (const [method, p, body] of [["GET", `/gpexe/teams/${teamId}/athlete-identities`, undefined], ["POST", `/gpexe/teams/${teamId}/athlete-identities/loads`, { requestKey: crypto.randomUUID() }]]) {
      const r = await api(p, { method, cookie, body });
      assert.deepEqual([r.status, r.body], [404, { error: "notFound" }], `${who} ${method}: ${r.text}`);
      assert.equal(r.cacheControl, "no-store", `${who} ${method}: no-store`);
    }
  };
  await ok(o.padmin.cookie, "platform admin, platform workspace");
  const padminClub = await platformAdmin(["club", o.clubId]);
  await ok(padminClub.cookie, "platform admin, club workspace");
  await ok(o.cadmin.cookie, "club admin, own club workspace");
  await hidden(o.coach.cookie, "coach");
  const status = await api(`/gpexe/teams/${o.teamId}/status`, { cookie: o.coach.cookie });
  assert.equal(status.status, 200);
  assert.ok(!status.text.includes("identity"), "the coach's status carries no identity trace");
  assert.equal((await api(`/gpexe/teams/${o.teamId}/status`, { cookie: o.cadmin.cookie })).body.viewer.identityAdmin, true);
  // A platform admin who also coaches the team, active in the team workspace (a team workspace needs a team role).
  const padminTeam = await platformAdmin(["team", o.teamId]);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [padminTeam.id, o.teamId]);
  await hidden(padminTeam.cookie, "platform admin, team workspace");
  const otherClub = (await q(`insert into public.clubs (name) values ('Other') returning id`))[0].id;
  const otherAdmin = await clubAdmin(otherClub);
  await hidden(otherAdmin.cookie, "another club's admin");
  const twoClubs = await clubAdmin(o.clubId);
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [twoClubs.id, otherClub]);
  await setWorkspace(twoClubs.id, "club", otherClub);
  await hidden(twoClubs.cookie, "a club admin in another club's workspace");
  const revoked = await clubAdmin(o.clubId);
  await q(`update public.user_club_roles set is_active = false where user_id = $1`, [revoked.id]);
  await hidden(revoked.cookie, "a revoked club admin");
  await hidden(o.padmin.cookie, "a missing team", crypto.randomUUID());
  await hidden(o.padmin.cookie, "a malformed team id", "not-a-uuid");
  // A never-bound team of the same club.
  const plain = (await q(`insert into public.teams (club_id, name) values ($1, 'Plain') returning id`, [o.clubId]))[0].id;
  await hidden(o.padmin.cookie, "a never-bound team", plain);
  // An archived team, an archived club (restored afterwards), an ended binding.
  await q(`update public.teams set is_active = false where id = $1`, [o.teamId]);
  await hidden(o.padmin.cookie, "an archived team");
  await q(`update public.teams set is_active = true where id = $1`, [o.teamId]);
  await q(`update public.clubs set is_active = false where id = $1`, [o.clubId]);
  await hidden(o.padmin.cookie, "an archived club");
  await q(`update public.clubs set is_active = true where id = $1`, [o.clubId]);
  await ok(o.padmin.cookie, "restored");
  assert.equal((await unbind(o, conn, binding)).status, 200);
  await hidden(o.padmin.cookie, "an ended binding");
  await hidden(o.cadmin.cookie, "an ended binding, club admin");
  assert.equal(athleteCalls().length, 0, "nothing was read for any refused caller");
});

test("4b. the right and the identity rows are read atomically (external review of PR #144, HIGH): a revocation, a team or club archive or an Unbind that commits after the route's own check but before the read gives the identical 404 with no PII, for both bases; a revocation that comes while the read holds its locks waits for the read, and the next read is 404", async () => {
  const scenarios = [
    ["platform admin revoked", "padmin", async (x) => q(`update public.user_global_roles set is_active = false where user_id = $1`, [x.o.padmin.id])],
    ["platform admin user deactivated", "padmin", async (x) => q(`update public.users set is_active = false where id = $1`, [x.o.padmin.id])],
    ["club admin revoked", "cadmin", async (x) => q(`update public.user_club_roles set is_active = false where user_id = $1`, [x.o.cadmin.id])],
    ["club admin, club archived", "cadmin", async (x) => q(`update public.clubs set is_active = false where id = $1`, [x.o.clubId])],
    ["club admin, team archived", "cadmin", async (x) => q(`update public.teams set is_active = false where id = $1`, [x.o.teamId])],
    ["platform admin, binding ended", "padmin", async (x) => q(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'race test' where id = $1`, [x.binding.bindingId, x.o.padmin.id])],
  ];
  for (const [name, who, change] of scenarios) {
    const x = await ready(2, 1001);
    assert.equal((await load(x.o)).body.loaded, 2, name);
    let fired = false;
    identity.setIdentityListHoldForTests(async (stage) => {
      if (stage !== "before" || fired) return;
      fired = true;
      await change(x);
    });
    const r = await list(x.o, x.o[who].cookie);
    identity.setIdentityListHoldForTests(null);
    assert.ok(fired, `${name}: the change ran after the route's check`);
    assert.deepEqual([r.status, r.body], [404, { error: "notFound" }], `${name}: ${r.text}`);
    assert.equal(r.cacheControl, "no-store");
    noPii(r.text, `${name}: the 404`);
    assert.ok(!/pending|identit|retention/i.test(r.text), `${name}: no signal that a snapshot exists`);
  }
  // A change while the read holds its locks waits for the read (which still had the right), then the next read is 404:
  // a role revocation for both bases, a user deactivation, a club archive, a team archive and an ended binding.
  const lockedChanges = [
    ["padmin", "platform admin role revoked", (x) => [`update public.user_global_roles set is_active = false where user_id = $1`, [x.o.padmin.id]]],
    ["cadmin", "club admin role revoked", (x) => [`update public.user_club_roles set is_active = false where user_id = $1`, [x.o.cadmin.id]]],
    ["padmin", "platform admin user deactivated", (x) => [`update public.users set is_active = false where id = $1`, [x.o.padmin.id]]],
    ["cadmin", "club archived", (x) => [`update public.clubs set is_active = false where id = $1`, [x.o.clubId]]],
    ["cadmin", "team archived", (x) => [`update public.teams set is_active = false where id = $1`, [x.o.teamId]]],
    ["padmin", "binding ended", (x) => [`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'race test' where id = $1`, [x.binding.bindingId, x.o.padmin.id]]],
  ];
  for (const [who, label, sqlOf] of lockedChanges) {
    const x = await ready(2, 1051);
    assert.equal((await load(x.o)).body.loaded, 2);
    const other = new pg.Client({ connectionString: db.url });
    await other.connect();
    try {
      let revoking = null;
      let revokedAt = 0;
      let answeredAt = 0;
      identity.setIdentityListHoldForTests(async (stage) => {
        if (stage !== "locked") return;
        const [sql, params] = sqlOf(x);
        revoking = other.query(sql, params).then(() => { revokedAt = Date.now(); });
        await new Promise((r) => setTimeout(r, 300));
        answeredAt = Date.now();
      });
      const r = await list(x.o, x.o[who].cookie);
      identity.setIdentityListHoldForTests(null);
      assert.equal(r.status, 200, `${label}: the read that held the locks first completes`);
      await revoking;
      assert.ok(revokedAt >= answeredAt, `${label}: the change waited for the read's locks`);
      const after = await list(x.o, x.o[who].cookie);
      if (label === "platform admin user deactivated") {
        // An inactive user's session itself is refused by requireAuth (401) before any identity route runs.
        assert.equal(after.status, 401, `${label}: the next request is refused at sign-in`);
        noPii(after.text, `${label}: the refusal`);
      } else assert.deepEqual([after.status, after.body], [404, { error: "notFound" }], `${label}: the next read is 404`);
    } finally {
      await other.end();
    }
  }
});

test("4c. the club the route resolved the workspace for is re-checked under the lock: a call with another expected club reads nothing", async () => {
  const { o } = await ready(1, 1091);
  assert.equal((await load(o)).body.loaded, 1);
  const ctx = { userId: String(o.padmin.id), basis: "platform_admin" };
  assert.ok(await identity.listIdentities(o.teamId, ctx, { expectedClubId: o.clubId }), "the team's own club reads");
  assert.equal(await identity.listIdentities(o.teamId, ctx, { expectedClubId: crypto.randomUUID() }), null, "another club reads nothing");
});

test("5. the athletes are derived on the server only: a body with anything but requestKey is 400 with nothing read; a failed check, a legacy-path check, another (ended) binding's check and an expired or purged candidate give no athlete; only the succeeded chain of the current binding is read", async () => {
  const o = await org();
  useSource();
  const first = await bound(o);
  await seedChain(o, first, ["611"]);
  assert.equal((await unbind(o, first.conn, first.binding)).status, 200);
  // Bind again (same connection), then several chains of which one is good.
  const again = await api(`/sources/gpexe/connections/${first.conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  const current = { conn: first.conn, binding: again.body.result.binding };
  await seedChain(o, current, ["621"], { status: "failed" });
  await seedChain(o, current, ["631"]);
  await seedChain(o, current, ["641"]);
  await q(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 second' where preview::text like '%"641"%' and owner_team_id = $1`, [o.teamId]);
  for (const body of [{ requestKey: crypto.randomUUID(), athleteIds: ["611"] }, { athleteIds: ["611"] }, { requestKey: "nope" }, [], { requestKey: crypto.randomUUID(), teamId: o.teamId }]) {
    const r = await api(`/gpexe/teams/${o.teamId}/athlete-identities/loads`, { method: "POST", cookie: o.padmin.cookie, body });
    assert.deepEqual([r.status, r.body.error], [400, "invalid_body"], JSON.stringify(body));
  }
  assert.equal(athleteCalls().length, 0);
  const r = await load(o);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(athleteCalls().map((c) => c.key), ["/rest/v1/athlete/631/"], "only the succeeded chain of the current binding");
  assert.equal(r.body.loaded, 1);
});

test("6. at most 50 athletes per load and at most 3 requests at once: 60 eligible athletes — the first load reads 50 (newest sessions first), never more than 3 in flight and really 3 in parallel, notRead 10; the second reads the remaining 10; a third reuses every snapshot and sends nothing", async () => {
  const o = await org();
  useSource();
  const b = await bound(o);
  await seedChain(o, b, ids(1000, 30), { startedAt: "2026-09-10T10:00:00Z" });
  await seedChain(o, b, ids(2000, 30), { startedAt: "2026-09-12T10:00:00Z" });
  src.st.delayMs = 15;
  const r1 = await load(o);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual([r1.body.loaded, r1.body.notRead], [50, 10]);
  assert.equal(athleteCalls().length, 50);
  assert.ok(athleteCalls().slice(0, 30).every((c) => c.key.includes("/athlete/20")), "the newest session's athletes first");
  assert.equal(src.st.maxInflight, 3, "never more than three at once, and three really in parallel");
  const r2 = await load(o);
  assert.deepEqual([r2.status, r2.body.loaded, r2.body.notRead], [200, 10, 0]);
  assert.equal(athleteCalls().length, 60);
  assert.equal(new Set(athleteCalls().map((c) => c.key)).size, 60, "each athlete read once");
  const r3 = await load(o);
  assert.deepEqual([r3.status, r3.body.loaded, r3.body.notRead], [200, 0, 0]);
  assert.equal(athleteCalls().length, 60, "valid snapshots are reused; nothing is sent");
  assert.equal((await rowsOf(o.teamId)).length, 60);
});

test("7. source answers: 404 counts as not found and the rest is saved; a 429, a 5xx, a non-JSON answer, a JSON array and a redirect stop the load without retry or redirect follow and keep what was already confirmed; an answer for another athlete id saves nothing at all", async () => {
  const cases = [
    ["404", { status: 404 }, { outcome: "completed", stopCode: null, saved: 2, notFound: 1, notCached: true }],
    ["429", { status: 429 }, { outcome: "partial", stopCode: "source_unavailable" }],
    ["503", { status: 503 }, { outcome: "partial", stopCode: "source_unavailable" }],
    ["non-JSON", { raw: "<html>" }, { outcome: "partial", stopCode: "source_answer_unexpected" }],
    ["array", { body: [{ id: 1 }] }, { outcome: "partial", stopCode: "source_answer_unexpected" }],
    ["redirect", { status: 302, headers: { location: "https://evil.example/athlete/1/" } }, { outcome: "partial", stopCode: "source_answer_unexpected" }],
  ];
  for (const [name, script, expected] of cases) {
    const { o } = await ready(3, 801);
    src.st.athlete.set("802", script);
    // Order the reads so the scripted one is read after the first: one worker only.
    identity.setIdentityTimingForTests({ concurrency: 1 });
    const r = await load(o);
    assert.equal(r.status, 200, `${name}: ${r.text}`);
    assert.equal(r.body.outcome, expected.outcome, name);
    assert.equal(r.body.stopCode, expected.stopCode, name);
    const calls = athleteCalls().map((c) => c.key);
    assert.equal(calls.filter((k) => k === "/rest/v1/athlete/802/").length, 1, `${name}: no retry`);
    assert.ok(!src.calls.some((c) => c.key.includes("evil")), `${name}: no redirect followed`);
    const rows = await rowsOf(o.teamId);
    if (expected.saved !== undefined) assert.equal(rows.length, expected.saved, name);
    if (expected.notFound !== undefined) assert.equal(r.body.notFound, expected.notFound, name);
    assert.ok(rows.some((x) => x.gpexe_athlete_id === "801"), `${name}: the confirmed answer before the stop is kept`);
    assert.ok(!rows.some((x) => x.gpexe_athlete_id === "802"), `${name}: nothing stored for 802`);
    if (expected.notCached) {
      // GPEXE's 404 is never an identity; it is left out of the next loads for 24 hours (owner decision
      // 2026-10-07), with no automatic retry, and counted in the answer without its id.
      assert.deepEqual([r.body.loaded, r.body.notFound, r.body.notRead], [2, 1, 0], `${name}: a 404 is counted once, never also as not read`);
      noPii(r.text, `${name}: the answer`);
      assert.ok(!/\b802\b/.test(r.text), `${name}: no id in the answer`);
      const g = await list(o);
      assert.deepEqual([g.body.pendingCount, g.body.retryLaterCount], [0, 1], `${name}: suppressed, counted apart`);
      assert.ok(!g.body.identities.some((i) => i.gpexeAthleteId === "802"), `${name}: never an identity`);
      assert.equal(athleteCalls().filter((c) => c.key === "/rest/v1/athlete/802/").length, 1, `${name}: no automatic retry`);
      const again = await load(o);
      assert.deepEqual([again.status, again.body.loaded, again.body.notFound, again.body.notRead], [200, 0, 0, 0]);
      assert.equal(athleteCalls().filter((c) => c.key === "/rest/v1/athlete/802/").length, 1, `${name}: not read again within 24 hours`);
      assert.ok(!(await rowsOf(o.teamId)).some((x) => x.gpexe_athlete_id === "802"));
    }
  }
  const { o } = await ready(3, 851);
  src.st.athlete.set("852", { body: { id: 999, first_name: `${FIRST}x`, last_name: `${LAST}x` } });
  identity.setIdentityTimingForTests({ concurrency: 1 });
  const r = await load(o);
  assert.deepEqual([r.status, r.body.error], [502, "source_identity_mismatch"], r.text);
  noPii(r.text, "the mismatch answer");
  assert.equal((await rowsOf(o.teamId)).length, 0, "an answer for another athlete saves nothing at all");
  assert.equal((await requestsOf(o.teamId))[0].status, "failed");
});

// Ages the 24-hour suppressions of the given athletes past their retry time (the update guard is lifted
// for this one statement only; a real row is never changed).
async function ageSuppressions(teamId, athleteIds) {
  await q(`alter table training_load.gpexe_athlete_identity_suppressions disable trigger gpexe_athlete_identity_suppressions_guard`);
  try {
    await q(`update training_load.gpexe_athlete_identity_suppressions set observed_at = now() - interval '25 hours', retry_after = now() - interval '1 hour' where owner_team_id = $1 and gpexe_athlete_id = any($2::text[])`, [teamId, athleteIds]);
  } finally {
    await q(`alter table training_load.gpexe_athlete_identity_suppressions enable trigger gpexe_athlete_identity_suppressions_guard`);
  }
}
const suppressionsOf = (teamId) => q(`select gpexe_athlete_id, observed_at, retry_after from training_load.gpexe_athlete_identity_suppressions where owner_team_id = $1 order by length(gpexe_athlete_id), gpexe_athlete_id`, [teamId]);

test("7c. 404s cannot starve the other athletes: with 60 pending and the first 50 answering 404, the second explicit load within 24 hours reads none of them again and reaches the next 10; after the expiry one of them is eligible again; opening the screen never extends retry_after; no suppression is ever returned as an identity; the purge, an Unbind, a team archive and a club archive delete the suppressions", async () => {
  const o = await org();
  useSource();
  const b = await bound(o);
  await seedChain(o, b, ids(3000, 30), { startedAt: "2026-09-12T10:00:00Z" });
  await seedChain(o, b, ids(4000, 30), { startedAt: "2026-09-10T10:00:00Z" });
  // The newest-first order: 3000..3029, then 4000..4029. The first 50 answer 404.
  const first50 = [...ids(3000, 30), ...ids(4000, 20)];
  const last10 = ids(4020, 10);
  for (const id of first50) src.st.athlete.set(id, { status: 404 });
  const r1 = await load(o);
  assert.deepEqual([r1.status, r1.body.loaded, r1.body.notFound, r1.body.notRead], [200, 0, 50, 10], r1.text);
  assert.ok(!first50.some((id) => r1.text.includes(`"${id}"`)), "no id in the answer");
  let sup = await suppressionsOf(o.teamId);
  assert.deepEqual(sup.map((x) => x.gpexe_athlete_id).sort(), [...first50].sort());
  for (const x of sup) assert.equal(new Date(x.retry_after).getTime() - new Date(x.observed_at).getTime(), 24 * 3_600_000, "exactly 24 hours");
  const columns = (await q(`select column_name from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_athlete_identity_suppressions' order by ordinal_position`)).map((c) => c.column_name);
  assert.deepEqual(columns, ["id", "owner_team_id", "binding_id", "gpexe_athlete_id", "observed_at", "retry_after"], "no name, no date, nothing of the answer");
  // Opening / reloading the screen twice: nothing extends, nothing becomes an identity.
  const g1 = await list(o);
  const g2 = await list(o);
  assert.deepEqual([g2.body.pendingCount, g2.body.retryLaterCount, g2.body.identities.length], [10, 50, 0]);
  assert.deepEqual((await suppressionsOf(o.teamId)).map((x) => x.retry_after.toISOString()), sup.map((x) => x.retry_after.toISOString()), "reading never extends retry_after");
  assert.ok(!g1.text.includes('"3000"') && !g2.text.includes('"4000"'), "no suppressed id in the read");
  // The second explicit load reaches the next 10, and none of the 50 is read again.
  const calls = athleteCalls().length;
  const r2 = await load(o);
  assert.deepEqual([r2.status, r2.body.loaded, r2.body.notFound, r2.body.notRead], [200, 10, 0, 0], r2.text);
  assert.deepEqual(athleteCalls().slice(calls).map((c) => c.key.match(/athlete\/(\d+)/)[1]).sort(), [...last10].sort());
  const g3 = await list(o);
  assert.deepEqual(g3.body.identities.map((i) => i.gpexeAthleteId).sort(), [...last10].sort(), "only the 10 real identities, never a suppression");
  // After the expiry one of the 50 is eligible again (and only on an explicit load).
  await ageSuppressions(o.teamId, ["3000"]);
  assert.equal((await list(o)).body.pendingCount, 1);
  src.st.athlete.set("3000", {});
  const c3 = athleteCalls().length;
  const r3 = await load(o);
  assert.deepEqual([r3.body.loaded, r3.body.notFound], [1, 0]);
  assert.deepEqual(athleteCalls().slice(c3).map((c) => c.key), ["/rest/v1/athlete/3000/"]);
  // The purge deletes an expired suppression.
  await ageSuppressions(o.teamId, ["3001"]);
  await importer.runRetention("cli");
  assert.ok(!(await suppressionsOf(o.teamId)).some((x) => x.gpexe_athlete_id === "3001"), "the retention run deletes it");
  assert.equal((await importer.retentionStatus()).expiredSuppressionsNotPurged, 0);
  // An Unbind deletes the suppressions of the binding.
  assert.ok((await suppressionsOf(o.teamId)).length > 0);
  assert.equal((await unbind(o, b.conn, b.binding)).status, 200);
  assert.equal((await suppressionsOf(o.teamId)).length, 0, "an Unbind deletes them");
  // A team archive and a club archive delete them too.
  for (const scope of ["team", "club"]) {
    const x = await ready(2, scope === "team" ? 5001 : 5101);
    for (const id of (scope === "team" ? ["5001", "5002"] : ["5101", "5102"])) src.st.athlete.set(id, { status: 404 });
    assert.equal((await load(x.o)).body.notFound, 2);
    assert.equal((await suppressionsOf(x.o.teamId)).length, 2);
    if (scope === "team") await q(`update public.teams set is_active = false where id = $1`, [x.o.teamId]);
    else await q(`update public.clubs set is_active = false where id = $1`, [x.o.clubId]);
    assert.equal((await suppressionsOf(x.o.teamId)).length, 0, `a ${scope} archive deletes them`);
  }
});

test("7d. a re-404 after the expiry replaces the expired suppression with a new 24-hour one, even when the expired row is still there at the write (the purge before the load did not remove it)", async () => {
  const x = await ready(1, 5201);
  src.st.athlete.set("5201", { status: 404 });
  assert.equal((await load(x.o)).body.notFound, 1);
  await ageSuppressions(x.o.teamId, ["5201"]);
  // Inside the write transaction the expired row is put back (as if the pre-load purge had failed).
  identity.setIdentityFinalizeHoldForTests(async (client) => {
    await client.query(`delete from training_load.gpexe_athlete_identity_suppressions where owner_team_id = $1`, [x.o.teamId]);
    await client.query(`alter table training_load.gpexe_athlete_identity_suppressions disable trigger gpexe_athlete_identity_suppressions_guard`);
    await client.query(`insert into training_load.gpexe_athlete_identity_suppressions (owner_team_id, binding_id, gpexe_athlete_id, observed_at, retry_after) values ($1, $2, '5201', now() - interval '25 hours', now() - interval '1 hour')`, [x.o.teamId, x.binding.bindingId]);
    await client.query(`alter table training_load.gpexe_athlete_identity_suppressions enable trigger gpexe_athlete_identity_suppressions_guard`);
  });
  const r = await load(x.o);
  identity.setIdentityFinalizeHoldForTests(null);
  assert.deepEqual([r.status, r.body.notFound], [200, 1], r.text);
  const rows = (await q(`select gpexe_athlete_id, retry_after > now() + interval '23 hours' as fresh from training_load.gpexe_athlete_identity_suppressions where owner_team_id = $1`, [x.o.teamId]));
  assert.deepEqual(rows.map((y) => [y.gpexe_athlete_id, y.fresh]), [["5201", true]], "exactly one, fresh 24-hour suppression");
});

test("7e. no stale contract text: the code and v32 describe the 24-hour suppression, not the removed no-negative-cache rule", async () => {
  const svc = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeAthleteIdentityService.js"), "utf8");
  const mig = await fsp.readFile(path.resolve(ROOT, "migrations_v2", V32), "utf8");
  assert.ok(!/next explicit load\s+(\/\/\s*)?reads it again/.test(svc), "service comment");
  assert.ok(!/no negative cache\)/.test(mig), "migration header");
});

test("8. a 401 moves the connection to needs_reconnect through the auto-invalidate path (one audit row, basis system, trigger identity_read) and saves nothing; a 403 saves nothing and changes nothing of the credential's state", async () => {
  const a = await ready(2, 901);
  src.st.athlete.set("902", { status: 401 });
  identity.setIdentityTimingForTests({ concurrency: 1 });
  const r = await load(a.o);
  assert.deepEqual([r.status, r.body.error], [409, "source_auth_rejected"], r.text);
  assert.equal((await connRow(a.conn.id)).state, "needs_reconnect");
  const auto = (await auditOf(a.conn.id)).filter((x) => x.action === "auto_invalidate");
  assert.equal(auto.length, 1);
  assert.deepEqual([auto[0].basis, auto[0].metadata.trigger], ["system", "identity_read"]);
  noPii(JSON.stringify(await auditOf(a.conn.id)), "the audit");
  assert.equal((await rowsOf(a.o.teamId)).length, 0);
  assert.deepEqual((await requestsOf(a.o.teamId)).map((x) => [x.status, x.error_code]), [["failed", "source_auth_rejected"]]);
  // A load now: the connection is not usable — the precise reason for the administrator, nothing read.
  const before = athleteCalls().length;
  const again = await load(a.o);
  assert.deepEqual([again.status, again.body.error, again.body.reason], [409, "source_connection_unavailable", "connection_not_usable"]);
  assert.equal(athleteCalls().length, before);

  const b = await ready(2, 951);
  src.st.athlete.set("952", { status: 403 });
  identity.setIdentityTimingForTests({ concurrency: 1 });
  const f = await load(b.o);
  assert.deepEqual([f.status, f.body.error], [409, "source_access_refused"], f.text);
  assert.equal((await connRow(b.conn.id)).state, "verified", "a 403 changes nothing of the credential state");
  assert.equal((await auditOf(b.conn.id)).filter((x) => x.action === "auto_invalidate").length, 0);
  assert.equal((await rowsOf(b.o.teamId)).length, 0);
});

test("9. the per-request timeout and the total budget: a hanging read stops the load (source_unavailable) within the request timeout and keeps the answers already confirmed; slow answers past the total budget stop it as network_budget_exhausted, the HTTP answer comes back within the budget plus the database steps, and nothing runs on afterwards", async () => {
  const { o } = await ready(3, 1101);
  src.st.athlete.set("1102", { hang: true });
  identity.setIdentityTimingForTests({ concurrency: 1, requestTimeout: 300 });
  const t0 = Date.now();
  const r = await load(o);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.outcome, r.body.stopCode, r.body.loaded], ["partial", "source_unavailable", 1]);
  assert.ok(Date.now() - t0 < 5_000, "bounded by the request timeout");

  const two = await ready(12, 1201);
  src.st.delayMs = 250;
  identity.setIdentityTimingForTests({ networkBudget: 600 });
  const t1 = Date.now();
  const s = await load(two.o);
  const took = Date.now() - t1;
  assert.equal(s.status, 200, s.text);
  assert.equal(s.body.outcome, "partial");
  assert.ok(["network_budget_exhausted", "source_unavailable"].includes(s.body.stopCode), s.body.stopCode);
  assert.ok(s.body.loaded < 12 && s.body.notRead > 0);
  assert.ok(took < 4_000, `the answer is bounded by the budget (${took} ms)`);
  const callsAtAnswer = athleteCalls().length;
  await new Promise((r2) => setTimeout(r2, 600));
  assert.equal(athleteCalls().length, callsAtAnswer, "nothing is read after the answer");
  src.st.delayMs = 0;
});

test("10. requestKey: a replay answers the saved counts (replayed, no request, no second row); the same key for another team is request_key_reused; a double click (the same key twice at once) reads once; two loads of one team at once — one runs, the other is identity_load_running — and nothing is read twice", async () => {
  const { o } = await ready(3, 1301);
  const key = crypto.randomUUID();
  const r1 = await load(o, o.padmin.cookie, key);
  assert.equal(r1.body.loaded, 3);
  const n = athleteCalls().length;
  const r2 = await load(o, o.padmin.cookie, key);
  assert.deepEqual([r2.status, r2.body.replayed, r2.body.loaded, r2.body.unrecognisedBirthDates], [200, true, 3, null]);
  assert.equal(athleteCalls().length, n, "a replay sends nothing");
  assert.equal((await requestsOf(o.teamId)).length, 1);
  const other = await ready(1, 1351);
  // The same platform admin, the same key, another team.
  const reused = await api(`/gpexe/teams/${other.o.teamId}/athlete-identities/loads`, { method: "POST", cookie: o.padmin.cookie, body: { requestKey: key } });
  assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"]);

  const d = await ready(3, 1401);
  src.st.holdAthletes = gate();
  const dupKey = crypto.randomUUID();
  const both = [load(d.o, d.o.padmin.cookie, dupKey), load(d.o, d.o.padmin.cookie, dupKey)];
  await new Promise((r3) => setTimeout(r3, 300));
  src.st.holdAthletes.release();
  src.st.holdAthletes = null;
  const answers = await Promise.all(both);
  const statuses = answers.map((a) => a.status).sort();
  assert.ok(statuses.includes(200), JSON.stringify(answers.map((a) => a.body)));
  assert.ok(answers.every((a) => a.status === 200 || a.body.error === "identity_load_running"), JSON.stringify(answers.map((a) => a.body)));
  assert.equal(athleteCalls().filter((c) => c.key.startsWith("/rest/v1/athlete/14")).length, 3, "read once");

  const p = await ready(3, 1501);
  src.st.holdAthletes = gate();
  const parallel = [load(p.o), load(p.o, p.o.cadmin.cookie)];
  await new Promise((r3) => setTimeout(r3, 300));
  src.st.holdAthletes.release();
  src.st.holdAthletes = null;
  const two = await Promise.all(parallel);
  assert.deepEqual(two.map((a) => a.status).sort(), [200, 409], JSON.stringify(two.map((a) => a.body)));
  assert.equal(two.find((a) => a.status === 409).body.error, "identity_load_running");
  assert.equal(athleteCalls().filter((c) => c.key.startsWith("/rest/v1/athlete/15")).length, 3);
});

test("10b. the same key after an Unbind and a new binding answers request_key_reused (never the old binding's counts); the date-of-birth conflicts name only pairs that can be staged (no linked GPEXE athlete, no linked OptiMove athlete)", async () => {
  const { o, conn, binding } = await ready(2, 1381);
  src.st.athlete.set("1381", { body: { id: 1381, first_name: "Ada", last_name: "One", birthdate: "2002-02-02" } });
  src.st.athlete.set("1382", { body: { id: 1382, first_name: "Bea", last_name: "Two", birthdate: "2003-03-03" } });
  const key = crypto.randomUUID();
  assert.equal((await load(o, o.padmin.cookie, key)).body.loaded, 2);
  await q(`update public.athletes set birth_date = '1990-01-01' where id = any($1::uuid[])`, [o.athleteIds]);
  let g = await list(o);
  assert.equal(g.body.birthDateConflicts.length, 2 * o.athleteIds.length, "every stageable pair whose dates differ");
  // Link GPEXE 1381 to athlete 0: neither appears in any conflict pair any more.
  assert.equal((await api(`/gpexe/teams/${o.teamId}/athlete-links`, { method: "POST", cookie: o.padmin.cookie, body: { gpexeAthleteId: "1381", athleteId: o.athleteIds[0] } })).status, 201);
  g = await list(o);
  assert.ok(g.body.birthDateConflicts.every((c) => c.gpexeAthleteId !== "1381" && c.athleteId !== o.athleteIds[0]), JSON.stringify(g.body.birthDateConflicts));
  assert.equal(g.body.birthDateConflicts.length, o.athleteIds.length - 1);
  // Unbind, bind again, replay the old key.
  assert.equal((await unbind(o, conn, binding)).status, 200);
  const again = await api(`/sources/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
  assert.equal(again.status, 201, again.text);
  const replayed = await load(o, o.padmin.cookie, key);
  assert.deepEqual([replayed.status, replayed.body.error], [409, "request_key_reused"]);
});

test("11. a lost COMMIT answer: when the COMMIT happened, the answer is the counts with verified_after_commit_error; when it did not and cannot be verified, 503 outcome_unknown names the requestKey, nothing is saved, and the same key answers identity_load_running and, once stale, identity_load_abandoned — never a second read", async () => {
  const a = await ready(2, 1601);
  identity.setIdentityCommitFaultForTests((client) => client.query("commit").then(() => { throw new Error("the answer to COMMIT was lost"); }));
  const r = await load(a.o);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.loaded, r.body.commitConfirmation], [2, "verified_after_commit_error"]);
  assert.equal((await rowsOf(a.o.teamId)).length, 2);

  const b = await ready(2, 1651);
  identity.setIdentityCommitFaultForTests((client) => client.query("rollback").then(() => { throw new Error("lost"); }));
  identity.setIdentityVerifyFaultForTests(() => { throw new Error("cannot verify"); });
  const key = crypto.randomUUID();
  const u = await load(b.o, b.o.padmin.cookie, key);
  assert.deepEqual([u.status, u.body.error, u.body.requestKey], [503, "outcome_unknown", key]);
  assert.equal((await rowsOf(b.o.teamId)).length, 0);
  identity.setIdentityCommitFaultForTests(null);
  identity.setIdentityVerifyFaultForTests(null);
  const n = athleteCalls().length;
  const again = await load(b.o, b.o.padmin.cookie, key);
  assert.deepEqual([again.status, again.body.error], [409, "identity_load_running"]);
  identity.setIdentityTimingForTests({ staleSeconds: 0 });
  await new Promise((r2) => setTimeout(r2, 50));
  const stale = await load(b.o, b.o.padmin.cookie, key);
  assert.deepEqual([stale.status, stale.body.error], [409, "identity_load_abandoned"]);
  assert.equal(athleteCalls().length, n, "the same key is never read again");
  // A new key starts a new load (the abandoned one no longer blocks the team).
  const fresh = await load(b.o);
  assert.equal(fresh.status, 200, fresh.text);
  assert.equal(fresh.body.loaded, 2);
});

test("12. a change while GPEXE is read: a Reconnect-like credential change, an Unbind, a team archive, a club archive and a revoked right during the reads each stop the load with nothing saved (the precise code or the identical 404)", async () => {
  const scenarios = [
    ["credential", async (x) => q(`update training_load.source_credential_connections set credential_nonce = gen_random_bytes(12) where id = $1`, [x.conn.id]), 409, "source_connection_unavailable"],
    ["unbind", async (x) => { assert.equal((await unbind(x.o, x.conn, x.binding)).status, 200); }, 404, "notFound"],
    ["team archive", async (x) => q(`update public.teams set is_active = false where id = $1`, [x.o.teamId]), 404, "notFound"],
    ["club archive", async (x) => q(`update public.clubs set is_active = false where id = $1`, [x.o.clubId]), 404, "notFound"],
    ["right revoked", async (x) => q(`update public.user_global_roles set is_active = false where user_id = $1`, [x.o.padmin.id]), 404, "notFound"],
  ];
  for (const [name, change, status, error] of scenarios) {
    const x = await ready(3, 1701 + scenarios.findIndex((s) => s[0] === name) * 10);
    identity.setIdentityTimingForTests({ concurrency: 1 });
    let changed = false;
    resolver.setImportSourceRevalidateHoldForTests(async () => {
      if (changed || athleteCalls().length < 1) return;
      changed = true;
      await change(x);
    });
    const r = await load(x.o);
    resolver.setImportSourceRevalidateHoldForTests(null);
    assert.equal(r.status, status, `${name}: ${r.text}`);
    assert.equal(status === 404 ? JSON.stringify(r.body) : r.body.error, status === 404 ? JSON.stringify({ error: "notFound" }) : error, name);
    assert.equal((await rowsOf(x.o.teamId)).length, 0, `${name}: nothing saved`);
    assert.equal((await requestsOf(x.o.teamId))[0]?.status, "failed", name);
  }
});

test("13. Unbind and archive against the write, in both orders: a load that commits first loses its rows to the Unbind / archive that follows (DB trigger, same transaction); an Unbind / archive that commits first makes the load save nothing; either way no identity is shown afterwards", async () => {
  // Load first, Unbind second.
  const a = await ready(2, 1901);
  const holding = gate();
  const held = gate();
  identity.setIdentityFinalizeHoldForTests(async () => { held.release(); await holding.p; });
  const loading = load(a.o);
  await held.p;
  const unbinding = unbind(a.o, a.conn, a.binding);
  await new Promise((r) => setTimeout(r, 300));
  holding.release();
  const [lr, ur] = await Promise.all([loading, unbinding]);
  identity.setIdentityFinalizeHoldForTests(null);
  assert.equal(lr.status, 200, lr.text);
  assert.equal(ur.status, 200, ur.text);
  assert.equal((await rowsOf(a.o.teamId)).length, 0, "the Unbind deleted what the load wrote");

  // Unbind first (held inside its transaction), load second.
  const b = await ready(2, 1951);
  const uHold = gate();
  const uHeld = gate();
  connections.setSourceUnbindHoldForTests(async () => { uHeld.release(); await uHold.p; });
  const unbinding2 = unbind(b.o, b.conn, b.binding);
  await uHeld.p;
  connections.setSourceUnbindHoldForTests(null);
  const loading2 = load(b.o);
  await new Promise((r) => setTimeout(r, 300));
  uHold.release();
  const [ur2, lr2] = await Promise.all([unbinding2, loading2]);
  assert.equal(ur2.status, 200, ur2.text);
  assert.ok([404, 409].includes(lr2.status), lr2.text);
  assert.equal((await rowsOf(b.o.teamId)).length, 0);

  // Load first, team archive second (the archive waits for the load's team lock, then its trigger deletes).
  const c = await ready(2, 2001);
  const cHold = gate();
  const cHeld = gate();
  identity.setIdentityFinalizeHoldForTests(async () => { cHeld.release(); await cHold.p; });
  const loading3 = load(c.o);
  await cHeld.p;
  const archiving = admin.query(`update public.teams set is_active = false where id = $1`, [c.o.teamId]);
  await new Promise((r) => setTimeout(r, 300));
  cHold.release();
  const [lr3] = await Promise.all([loading3, archiving]);
  identity.setIdentityFinalizeHoldForTests(null);
  assert.equal(lr3.status, 200, lr3.text);
  assert.equal((await rowsOf(c.o.teamId)).length, 0, "the team archive deleted what the load wrote");

  // Club archive first (an open transaction), load second: the load waits on the club, then sees it archived.
  const d = await ready(2, 2051);
  const other = new pg.Client({ connectionString: db.url });
  await other.connect();
  try {
    await other.query("begin");
    await other.query(`update public.clubs set is_active = false where id = $1`, [d.o.clubId]);
    const loading4 = load(d.o);
    await new Promise((r) => setTimeout(r, 400));
    await other.query("commit");
    const lr4 = await loading4;
    assert.ok([404, 409].includes(lr4.status), lr4.text);
  } finally {
    await other.end();
  }
  assert.equal((await rowsOf(d.o.teamId)).length, 0);
  // And a club archive after a completed load deletes the rows of every team of the club.
  const e = await ready(2, 2101);
  assert.equal((await load(e.o)).body.loaded, 2);
  assert.equal((await rowsOf(e.o.teamId)).length, 2);
  await q(`update public.clubs set is_active = false where id = $1`, [e.o.clubId]);
  assert.equal((await rowsOf(e.o.teamId)).length, 0, "a club archive deletes its teams' identities");
});

test("14. the 14-day TTL: expires_at is observed_at + 14 days exactly; a reuse never extends it; an expired row is never shown, is read again by the next load (a new row), and is physically deleted by the purge and by the retention run, which reports it; an UPDATE of a row is refused by the database", async () => {
  const { o } = await ready(2, 2201);
  assert.equal((await load(o)).body.loaded, 2);
  const rows = await rowsOf(o.teamId);
  for (const row of rows) assert.equal(new Date(row.expires_at).getTime() - new Date(row.observed_at).getTime(), 14 * 86_400_000);
  await load(o);
  assert.deepEqual((await rowsOf(o.teamId)).map((x) => x.expires_at.toISOString()), rows.map((x) => x.expires_at.toISOString()), "a reuse never extends");
  await assert.rejects(q(`update training_load.gpexe_athlete_identities set expires_at = expires_at + interval '1 day' where owner_team_id = $1`, [o.teamId]), /never changed or extended/);
  // Age one row past its expiry (the update guard is lifted for this one statement only).
  await q(`alter table training_load.gpexe_athlete_identities disable trigger gpexe_athlete_identities_no_update`);
  await q(`update training_load.gpexe_athlete_identities set observed_at = now() - interval '15 days', expires_at = now() - interval '1 day' where owner_team_id = $1 and gpexe_athlete_id = '2201'`, [o.teamId]);
  await q(`alter table training_load.gpexe_athlete_identities enable trigger gpexe_athlete_identities_no_update`);
  const status = await importer.retentionStatus();
  assert.ok(status.expiredIdentitiesNotPurged >= 1 && status.healthy === false, "the retention status reports it");
  const shown = await list(o);
  assert.deepEqual(shown.body.identities.map((i) => i.gpexeAthleteId), ["2202"], "an expired row is never shown");
  assert.equal(shown.body.pendingCount, 1);
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_athlete_identities where owner_team_id = $1 and expires_at <= now()`, [o.teamId]))[0].n, 0, "a read purges it too");
  // The retention run (every runner) deletes it as well.
  await q(`alter table training_load.gpexe_athlete_identities disable trigger gpexe_athlete_identities_no_update`);
  await q(`update training_load.gpexe_athlete_identities set observed_at = now() - interval '15 days', expires_at = now() - interval '1 day' where owner_team_id = $1 and gpexe_athlete_id = '2202'`, [o.teamId]);
  await q(`alter table training_load.gpexe_athlete_identities enable trigger gpexe_athlete_identities_no_update`);
  const run = await importer.runRetention("cli");
  assert.ok(run.identitiesPurged >= 1);
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_athlete_identities where expires_at <= now()`))[0].n, 0, "physically deleted");
  assert.equal((await importer.retentionStatus()).expiredIdentitiesNotPurged, 0);
  const n = athleteCalls().length;
  const again = await load(o);
  assert.equal(again.body.loaded, 2, "the expired athletes are read again");
  assert.equal(athleteCalls().length, n + 2);
  // The purge function on its own.
  await q(`alter table training_load.gpexe_athlete_identities disable trigger gpexe_athlete_identities_no_update`);
  await q(`update training_load.gpexe_athlete_identities set observed_at = now() - interval '15 days', expires_at = now() - interval '1 day' where owner_team_id = $1`, [o.teamId]);
  await q(`alter table training_load.gpexe_athlete_identities enable trigger gpexe_athlete_identities_no_update`);
  assert.equal(await identity.purgeExpiredIdentities(), 2);
  assert.equal((await rowsOf(o.teamId)).length, 0);
});

test("15. the GET shows the sanitized names and dates; an unrecognised date form is counted in the load's answer only (null in the row, nothing stored per athlete); a refused name is 'not provided' (null); duplicated names and a date conflict with an OptiMove athlete are reported as pairs only, never OptiMove's date", async () => {
  const { o } = await ready(4, 2301);
  src.st.athlete.set("2301", { body: { id: 2301, first_name: "Ana", last_name: "Same", birthdate: "31.12.1999" } });
  src.st.athlete.set("2302", { body: { id: 2302, first_name: "Ana", last_name: "Same", birthdate: "1999-12-31T23:30:00-05:00" } });
  src.st.athlete.set("2303", { body: { id: 2303, first_name: "Bad\u202E", last_name: "X", name: "\u200B", birthdate: null } });
  src.st.athlete.set("2304", { body: { id: 2304, first_name: "Eve", last_name: "Zed", birthdate: "2004-02-29" } });
  const r = await load(o);
  assert.deepEqual([r.body.loaded, r.body.unrecognisedBirthDates], [4, 1]);
  const rows = await rowsOf(o.teamId);
  assert.deepEqual(rows.map((x) => [x.gpexe_athlete_id, x.display_name, x.birth_date]), [["2301", "Ana Same", null], ["2302", "Ana Same", "1999-12-31"], ["2303", null, null], ["2304", "Eve Zed", "2004-02-29"]]);
  const reqRow = JSON.stringify(await requestsOf(o.teamId));
  assert.ok(!reqRow.includes("31.12.1999") && !reqRow.includes("unrecognised"), "the unrecognised form is not stored");
  // A conflict: an OptiMove athlete of the team with another date of birth than GPEXE's 2304.
  const athleteId = o.athleteIds[0];
  await q(`update public.athletes set birth_date = '2004-03-01' where id = $1`, [athleteId]);
  const g = await list(o);
  assert.deepEqual(g.body.birthDateConflicts.filter((c) => c.gpexeAthleteId === "2304"), [{ gpexeAthleteId: "2304", athleteId }]);
  assert.ok(!g.text.includes("2004-03-01"), "OptiMove's own date is never returned");
  assert.deepEqual(g.body.identities.find((i) => i.gpexeAthleteId === "2303"), { gpexeAthleteId: "2303", name: null, birthDate: null });
});

test("16. privacy: no name, date or extra field in any log line, audit row, request row, check row, error body or load answer of the whole suite; the snapshot is never copied into the OptiMove athlete profile; links still follow their own guards", async () => {
  const { o } = await ready(2, 2401);
  const athletesBefore = JSON.stringify(await q(`select id, full_name, display_name, first_name, last_name, birth_date from public.athletes order by id`));
  const r = await load(o);
  noPii(r.text, "the load answer");
  assert.equal(JSON.stringify(await q(`select id, full_name, display_name, first_name, last_name, birth_date from public.athletes order by id`)), athletesBefore, "public.athletes unchanged");
  for (const line of logLines) { noPii(line, "a console line"); noSecret(line, "a console line"); }
  noPii(JSON.stringify(await q(`select * from training_load.source_connection_audit`)), "the audit table");
  noPii(JSON.stringify(await q(`select * from training_load.gpexe_athlete_identity_requests`)), "the request table");
  noPii(JSON.stringify(await q(`select id, status, error_code, error_message from training_load.gpexe_import_checks`)), "the check rows");
  // A link is made only by the existing route and its guards; a second link of the same GPEXE athlete is refused.
  const linked = await api(`/gpexe/teams/${o.teamId}/athlete-links`, { method: "POST", cookie: o.padmin.cookie, body: { gpexeAthleteId: "2401", athleteId: o.athleteIds[0] } });
  assert.equal(linked.status, 201, linked.text);
  const twice = await api(`/gpexe/teams/${o.teamId}/athlete-links`, { method: "POST", cookie: o.padmin.cookie, body: { gpexeAthleteId: "2401", athleteId: o.athleteIds[1] } });
  assert.equal(twice.status, 409, twice.text);
  // The coach's source-athletes list carries no name.
  const sa = await api(`/gpexe/teams/${o.teamId}/source-athletes`, { cookie: o.coach.cookie });
  assert.equal(sa.status, 200);
  noPii(sa.text, "the coach's source-athletes list");
});

test("16b. a database guard of another kind than an ended binding or team is an internal error (500, request failed internal_error), never the 404 of a team that is no longer available", async () => {
  const { o } = await ready(1, 2451);
  identity.setIdentityInsertFaultForTests(() => { throw Object.assign(new Error("guard"), { code: "23514", constraint: "gpexe_athlete_identities_observed_at" }); });
  const r = await load(o);
  assert.deepEqual([r.status, r.body.error], [500, "internal_error"], r.text);
  assert.deepEqual((await requestsOf(o.teamId)).map((x) => [x.status, x.error_code]), [["failed", "internal_error"]]);
  assert.equal((await rowsOf(o.teamId)).length, 0);
  identity.setIdentityInsertFaultForTests(() => { throw Object.assign(new Error("guard"), { code: "23514", constraint: "gpexe_athlete_identities_active_team" }); });
  const t = await load(o);
  assert.deepEqual([t.status, t.body], [404, { error: "notFound" }], "an ended team or binding stays the 404");
});

test("17. static boundaries: the check run never reaches the identity module; the identity load never reads the environment token or the legacy client; the adapter's athlete read is built by sourceApiUrl only", async () => {
  const importerSource = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeImportService.js"), "utf8");
  assert.doesNotMatch(importerSource, /gpexeAthleteIdentityService|readAthleteIdentity/);
  const service = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeAthleteIdentityService.js"), "utf8");
  assert.doesNotMatch(service, /GPEXE_API_TOKEN|gpexeClient|createGpexeClient|redirect:\s*"follow"/);
  const adapter = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeRestV1Adapter.js"), "utf8");
  assert.match(adapter, /sourceApiUrl\(ADAPTER_SOURCE, hostKey, catalogRow, `athlete\/\$\{id\}\/`\)/);
});

test("18. migration v32 applies on v31 (three tables, seven triggers, two purges), enforces its invariants (the active binding of the row's team, connection and source team; an active team and club; the 14-day TTL; the name and date guards; no UPDATE; one running load per team; a finished request is final), rolls back to exactly the v31 catalog, applies again identically, refuses to roll back under a later migration and while a completed load exists, and a file that fails at its last statement applies nothing", async () => {
  const m = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v32mig", migrations: UP_TO_V31 });
  const k = new pg.Client({ connectionString: m.url });
  await k.connect();
  try {
    assert.equal((await k.query("select current_database() as db")).rows[0].db, m.name);
    const catalog = async () => ({
      tables: (await k.query(`select table_schema, table_name from information_schema.tables where table_schema in ('training_load', 'public') order by 1, 2`)).rows,
      columns: (await k.query(`select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ('training_load', 'public') order by 1, 2, ordinal_position`)).rows,
      constraints: (await k.query(`select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace in ('training_load'::regnamespace, 'public'::regnamespace) order by 1, 2`)).rows,
      indexes: (await k.query(`select schemaname, indexname, indexdef from pg_indexes where schemaname in ('training_load', 'public') order by 1, 2`)).rows,
      triggers: (await k.query(`select tgrelid::regclass::text as rel, tgname, pg_get_triggerdef(oid) as def from pg_trigger where not tgisinternal order by 1, 2`)).rows,
      functions: (await k.query(`select n.nspname, p.proname, md5(pg_get_functiondef(p.oid)) as digest from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('training_load', 'public') and p.prokind = 'f' order by 1, 2, 3`)).rows,
    });
    const v31 = await catalog();
    await applyGpexeTestMigrations(m.url, [...UP_TO_V31, V32]);
    const v32 = await catalog();
    assert.deepEqual(v32.tables.filter((x) => !v31.tables.some((y) => y.table_name === x.table_name)).map((x) => x.table_name).sort(), ["gpexe_athlete_identities", "gpexe_athlete_identity_requests", "gpexe_athlete_identity_suppressions"]);
    assert.deepEqual(v32.triggers.filter((x) => !v31.triggers.some((y) => y.tgname === x.tgname)).map((x) => x.tgname).sort(), ["clubs_drop_gpexe_athlete_identities", "gpexe_athlete_identities_check", "gpexe_athlete_identities_no_update", "gpexe_athlete_identity_requests_guard", "gpexe_athlete_identity_suppressions_guard", "source_team_bindings_drop_identities", "teams_drop_gpexe_athlete_identities"]);
    assert.ok(v32.functions.some((f) => f.proname === "purge_expired_gpexe_athlete_identities"));
    assert.ok(v32.functions.some((f) => f.proname === "purge_expired_gpexe_athlete_identity_suppressions"));
    // Fixture: a club, two teams, a user, a connection and an active binding.
    const club = (await k.query(`insert into public.clubs (name) values ('C') returning id`)).rows[0].id;
    const team = (await k.query(`insert into public.teams (club_id, name) values ($1, 'T') returning id`, [club])).rows[0].id;
    const team2 = (await k.query(`insert into public.teams (club_id, name) values ($1, 'T2') returning id`, [club])).rows[0].id;
    const user = (await k.query(`insert into public.users (email) values ('u@test.local') returning id`)).rows[0].id;
    await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, '981', $2)`, [team, user]);
    const parts = cryptoMod.encryptCredential(TOKEN, { connectionId: "00000000-0000-0000-0000-000000000001", ownerScope: "club", ownerClubId: club, ownerTeamId: null, sourceSystem: "gpexe", hostKey: "server3", credentialKind: "exchanged_token" }, cryptoMod.parseKeyring(process.env.SOURCE_CREDENTIAL_KEYS));
    const conn = (await k.query(
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state, credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','club',$1,'server3','L','exchanged_token',$2,'verified',$3,$4,$5,$6, now()) returning id`,
      [club, user, parts.ciphertext, parts.nonce, parts.authTag, parts.keyVersion],
    )).rows[0].id;
    const binding = (await k.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1, $2, 'gpexe', '981', $3, $1) returning id`, [team, conn, user])).rows[0].id;
    const insert = (over = {}) => {
      const v = { team, binding, conn, sourceTeam: "981", athlete: "7", name: "Ana B", dob: "2000-01-02", observed: "now()", ...over };
      return k.query(`insert into training_load.gpexe_athlete_identities (owner_team_id, binding_id, connection_id, source_team_id, gpexe_athlete_id, display_name, birth_date, observed_at, expires_at)
                      values ($1, $2, $3, $4, $5, $6, $7, ${v.observed}, ${v.observed} + interval '336 hours')`, [v.team, v.binding, v.conn, v.sourceTeam, v.athlete, v.name, v.dob]);
    };
    const refused = async (over, pattern) => { const e = await insert(over).then(() => null, (err) => err); assert.ok(e, `refused: ${JSON.stringify(over)}`); assert.match(String(e.message), pattern, JSON.stringify(over)); };
    await insert();
    await refused({ athlete: "7" }, /one_per_athlete|duplicate/);
    // The TTL is elapsed time, whatever the session's time zone: across a DST change (Europe/Belgrade,
    // 2026-10-25) 336 hours pass, while "+ 14 days" would be 337 hours and is refused.
    await k.query(`set time zone 'Europe/Belgrade'`);
    await k.query(`alter table training_load.gpexe_athlete_identities disable trigger gpexe_athlete_identities_check`);
    await k.query(`insert into training_load.gpexe_athlete_identities (owner_team_id, binding_id, connection_id, source_team_id, gpexe_athlete_id, observed_at, expires_at) values ($1, $2, $3, '981', '901', timestamptz '2026-10-20 12:00+00', timestamptz '2026-10-20 12:00+00' + interval '336 hours')`, [team, binding, conn]);
    const dstRefused = await k.query(`insert into training_load.gpexe_athlete_identities (owner_team_id, binding_id, connection_id, source_team_id, gpexe_athlete_id, observed_at, expires_at) values ($1, $2, $3, '981', '902', timestamptz '2026-10-20 12:00+00', timestamptz '2026-10-20 12:00+00' + interval '14 days')`, [team, binding, conn]).then(() => null, (e) => e);
    assert.equal(dstRefused?.constraint, "gpexe_athlete_identities_ttl", "calendar days across a DST change are refused");
    await k.query(`delete from training_load.gpexe_athlete_identities where gpexe_athlete_id in ('901')`);
    await k.query(`alter table training_load.gpexe_athlete_identities enable trigger gpexe_athlete_identities_check`);
    await k.query(`set time zone 'UTC'`);
    await refused({ athlete: "8", team: team2 }, /does not name its binding/);
    await refused({ athlete: "8", sourceTeam: "982" }, /does not name its binding|source_team/);
    await refused({ athlete: "08" }, /athlete_format/);
    await refused({ athlete: "8", name: "A\u202EB" }, /display_name/);
    await refused({ athlete: "8", name: " Ana" }, /display_name/);
    await refused({ athlete: "8", name: "A  B" }, /display_name/);
    await refused({ athlete: "8", name: "A\tB" }, /display_name/);
    await refused({ athlete: "8", name: "A".repeat(121) }, /display_name/);
    await refused({ athlete: "8", dob: "1899-12-31" }, /birth_date/);
    await refused({ athlete: "8", dob: "2999-01-01" }, /future/);
    await refused({ athlete: "8", observed: "now() - interval '1 hour'" }, /reading time/);
    await refused({ athlete: "8", observed: "now() + interval '1 hour'" }, /reading time/);
    const ttl = await k.query(`insert into training_load.gpexe_athlete_identities (owner_team_id, binding_id, connection_id, source_team_id, gpexe_athlete_id, observed_at, expires_at) values ($1, $2, $3, '981', '9', now(), now() + interval '15 days')`, [team, binding, conn]).then(() => null, (e) => e);
    assert.match(String(ttl?.message), /gpexe_athlete_identities_ttl/);
    await insert({ athlete: "10", name: null, dob: null });
    await assert.rejects(k.query(`update training_load.gpexe_athlete_identities set display_name = 'X' where gpexe_athlete_id = '7'`), /never changed or extended/);
    // The request record: one running load per team; a finished request is final.
    const req = (key, status = "running") => k.query(`insert into training_load.gpexe_athlete_identity_requests (owner_team_id, binding_id, requested_by_user_id, request_key, status, targets, finished_at) values ($1, $2, $3, $4, $5::varchar, 1, case when $5::varchar = 'running' then null else now() end) returning id`, [team, binding, user, key, status]);
    const r1 = (await req(crypto.randomUUID())).rows[0].id;
    await assert.rejects(req(crypto.randomUUID()), /one_running/);
    await k.query(`update training_load.gpexe_athlete_identity_requests set status = 'completed', finished_at = now(), loaded = 1, not_found = 0, not_read = 0 where id = $1`, [r1]);
    await assert.rejects(k.query(`update training_load.gpexe_athlete_identity_requests set loaded = 0 where id = $1`, [r1]), /finished and final/);
    await assert.rejects(k.query(`insert into training_load.gpexe_athlete_identity_requests (owner_team_id, binding_id, requested_by_user_id, request_key, targets) values ($1, $2, $3, $4, 1)`, [team2, binding, user, crypto.randomUUID()]), /active gpexe binding of team/);
    // The rollback refuses while a completed load exists, and under a later migration.
    const rollbackSql = await fsp.readFile(V32_ROLLBACK, "utf8");
    await assert.rejects(k.query(rollbackSql), /running or completed/);
    await k.query("rollback").catch(() => {});
    await k.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ('migrations_v2/209912312359_later.sql', repeat('0', 64), 0, 'test')`);
    await assert.rejects(k.query(rollbackSql), /later migrations are applied/);
    await k.query("rollback").catch(() => {});
    await k.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/209912312359_later.sql'`);
    // The 24-hour suppression: exactly 24 hours, an active binding of the row's team, never updated.
    const supp = (over = {}) => {
      const v = { team, binding, athlete: "70", observed: "now()", hours: "24", ...over };
      return k.query(`insert into training_load.gpexe_athlete_identity_suppressions (owner_team_id, binding_id, gpexe_athlete_id, observed_at, retry_after) values ($1, $2, $3, ${v.observed}, ${v.observed} + interval '${v.hours} hours')`, [v.team, v.binding, v.athlete]);
    };
    await supp();
    const suppRefused = async (over, pattern) => { const e = await supp(over).then(() => null, (err) => err); assert.ok(e, JSON.stringify(over)); assert.match(String(e.message), pattern, JSON.stringify(over)); };
    await suppRefused({ athlete: "70" }, /one_per_athlete|duplicate/);
    await suppRefused({ athlete: "71", hours: "25" }, /suppressions_ttl/);
    await suppRefused({ athlete: "71", team: team2 }, /not an active gpexe binding/);
    await suppRefused({ athlete: "071" }, /athlete_format/);
    await suppRefused({ athlete: "71", observed: "now() - interval '1 hour'" }, /reading time/);
    await assert.rejects(k.query(`update training_load.gpexe_athlete_identity_suppressions set retry_after = retry_after + interval '1 hour'`), /never changed or extended/);
    // A team archive and an Unbind delete the snapshot in the same statement's transaction.
    await insert({ athlete: "11" });
    await k.query(`update public.teams set is_active = false where id = $1`, [team]);
    assert.equal((await k.query(`select count(*)::int as n from training_load.gpexe_athlete_identities where owner_team_id = $1`, [team])).rows[0].n, 0);
    assert.equal((await k.query(`select count(*)::int as n from training_load.gpexe_athlete_identity_suppressions where owner_team_id = $1`, [team])).rows[0].n, 0, "a team archive deletes the suppressions");
    await k.query(`update public.teams set is_active = true where id = $1`, [team]);
    await insert({ athlete: "12" });
    await supp({ athlete: "72" });
    await k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'test' where id = $1`, [binding, user]);
    assert.equal((await k.query(`select count(*)::int as n from training_load.gpexe_athlete_identities`)).rows[0].n, 0, "an ended binding leaves no identity");
    assert.equal((await k.query(`select count(*)::int as n from training_load.gpexe_athlete_identity_suppressions`)).rows[0].n, 0, "nor a suppression");
    await refused({ athlete: "13" }, /not an active gpexe binding/);
    // With only failed requests left, the rollback runs and returns exactly the v31 catalog.
    await k.query(`alter table training_load.gpexe_athlete_identity_requests disable trigger gpexe_athlete_identity_requests_guard`);
    await k.query(`update training_load.gpexe_athlete_identity_requests set status = 'failed', error_code = 'abandoned'`);
    await k.query(`alter table training_load.gpexe_athlete_identity_requests enable trigger gpexe_athlete_identity_requests_guard`);
    await k.query(rollbackSql);
    assert.deepEqual(await catalog(), v31, "the rollback returns exactly the v31 catalog");
    assert.equal((await k.query(`select count(*)::int as n from public.schema_migrations where migration_name like $1`, [`%${V32}`])).rows[0].n, 0);
    const sql = await fsp.readFile(path.resolve(ROOT, "migrations_v2", V32), "utf8");
    assert.doesNotMatch(sql.replace(/[$][$][^]*?[$][$]/g, "<body>"), /https?:\/\/|SOURCE_CREDENTIAL_KEYS|^\s*(begin|commit|rollback)\b/im, "no URL, key or transaction control outside the function bodies");
    await k.query("begin");
    await assert.rejects(k.query(`${sql}\nselect 1/0;`), /division by zero/);
    await k.query("rollback");
    assert.deepEqual(await catalog(), v31, "nothing of the failed file was applied");
    await applyGpexeTestMigrations(m.url, [...UP_TO_V31, V32]);
    assert.deepEqual(await catalog(), v32, "v32 applies again, identically");
  } finally {
    await k.end();
    await m.drop();
  }
});

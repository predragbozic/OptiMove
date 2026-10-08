// F3c2g — the importer's credential resolver and the strict transition rule
// (a team with an active source binding reads only through it, never through
// GPEXE_API_TOKEN; a team without one keeps the legacy path), on a disposable
// optimove_tests_gpexe_* database (never OPTIMOVE) against a fake source that
// serves the rest_v1 reads of the F3c2c adapter. Discovery and rule:
// docs/ai/source-connections-f3c2g-discovery.md; contract section 2.8.
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

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const ORIGINAL_ACTIVE = process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION;
const ORIGINAL_ENV_TOKEN = process.env.GPEXE_API_TOKEN;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;

const USERNAME = "marker-username-f3c2g@example.invalid";
const PASSWORD = "MARKER-password-f3c2g-not-real";
const TOKEN = "MARKER-token-f3c2g-connection-not-real-0123456789";
const ENV_TOKEN = "MARKER-env-token-f3c2g-legacy-not-real-9876543210";
const SOURCE_SENTENCE = "Marker sentence from the source server body";
const SOURCE_TEAM_NAME_MARKER = "Marker source team name";
const EXCHANGE_URL = "https://server3.gpexe.com/api-token-auth/";
const REST = "https://server3.gpexe.com/rest/v1/";
const LEGACY = "https://server3.gpexe.com/api/";
const DAY = "2026-09-14";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V31 = "202610041200_training_load_v31_gpexe_import_checks_source_path.sql";
const UP_TO_V30 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V31));
const V31_ROLLBACK = path.resolve(ROOT, "docs/runbooks/gpexe-import-checks-v31-rollback.sql");

let db, admin, server, apiBase, importer, connections, resolver, createSession, appPool;
const logLines = [];
const originalConsole = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "f3c2g" });
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
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : safeString(a))).join(" "));
      if (process.env.F3C2G_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  importer = await import("../src/gpexeImportService.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  // A held team read (test 6) must outlive the check's start; the budget stays bounded.
  connections.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 5_000 });
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  importer?.setGpexeClientFactory(null);
  importer?.setCheckRunObserver(null);
  connections?.setSourceFetchForTests(null);
  connections?.setSourceConnectionTimingForTests?.({});
  connections?.setSourceUnbindHoldForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  resolver?.setImportSourceRevalidateHoldForTests(null);
  resolver?.setImportSourceAutoInvalidateCommitFaultForTests(null);
  importer?.setCheckStartCommitFaultForTests(null);
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
  importer.setGpexeClientFactory(null);
  importer.setCheckRunObserver(null);
  importer.setImportSourcePreReadHoldForTests(null);
  importer.setCheckStartCommitFaultForTests(null);
  connections.setSourceUnbindHoldForTests(null);
  resolver.setImportSourceRevalidateHoldForTests(null);
  resolver.setImportSourceAutoInvalidateCommitFaultForTests(null);
  resolver.setImportSourceAutoInvalidateBoundForTests(null);
  delete process.env.GPEXE_API_TOKEN;
  if (process.env.SOURCE_CREDENTIAL_KEYS === undefined || process.env.SOURCE_CREDENTIAL_KEYS === "") process.env.SOURCE_CREDENTIAL_KEYS = KEYS;
});
let KEYS;
before(() => { KEYS = process.env.SOURCE_CREDENTIAL_KEYS; });

// ---------------------------------------------------------------------------
// helpers
function safeString(value) { try { return JSON.stringify(value); } catch { return String(value); } }
const SECRETS = [USERNAME, PASSWORD, TOKEN, ENV_TOKEN, SOURCE_SENTENCE];
function noSecret(text, where, allowed = []) {
  for (const s of SECRETS) if (!allowed.includes(s)) assert.ok(!String(text).includes(s), `${where} carries a secret marker (${s.slice(0, 14)}…)`);
}
async function api(path, { method = "GET", body, cookie, allowed = [] } = {}) {
  const res = await fetch(`${apiBase}/api/training-load${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  noSecret(text, `the response to ${method} ${path}`, allowed);
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
async function cookieFor(userId) { return `optimove_session=${await createSession(userId)}`; }
async function platformAdmin() {
  const id = await makeUser("platform-admin");
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
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
// Every OptiMove team of this suite gets its own GPEXE team id (the approved
// pair is globally unique, and a check row makes it final — v24 / v30).
let nextSourceTeam = 981;
const visibleTeams = new Set();
async function org({ leadingZero = false, bare = false } = {}) {
  // `bare`: a team without athlete memberships, so a raw team move meets no membership foreign key
  // (public.athlete_memberships references (team_id, club_id)) and only a trigger can refuse it.
  const o = await createGpexePilotOrg(admin, { athleteNames: bare ? [] : ["A101", "B102", "C103"] });
  const sourceTeamId = String(nextSourceTeam++);
  visibleTeams.add(Number(sourceTeamId));
  const padmin = await platformAdmin();
  const coach = await coachOf(o.teamId);
  const cadmin = await clubAdmin(o.clubId);
  assert.equal((await api(`/gpexe/teams/${o.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: leadingZero ? `0${sourceTeamId}` : sourceTeamId } })).status, 200, "the approved pair is set");
  return { ...o, sourceTeamId, padmin, coach, cadmin };
}

// The fake source: the exchange, the team list and team reads (Connect / Test
// / bind), and the rest_v1 session reads of ONE served team at a time, derived
// from the shared e03 bundle fixture so the mapper gets consistent data.
function bundleFor(sourceTeamId, { detailsDrills = [0, 1], emptyDrill = null } = {}) {
  const sid = Number(sourceTeamId) * 10;
  const b = makeBundle({ sessionId: sid, gpexeTeamId: Number(sourceTeamId), athletes: standardAthletes(), detailsDrills });
  if (emptyDrill !== null) b.details.drills[String(emptyDrill)] = { players: {} };
  return b;
}
function fakeSource({ token = TOKEN } = {}) {
  const calls = [];
  const state = { served: null, bundle: null, gates: { team: null, list: null, athletes: null, track: null }, faults: { listStatus: 200, drillMissing: null, refuseAllReads: false, emptyList: false } };
  const json = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const abortable = (init, p) => new Promise((resolve, reject) => {
    if (init.signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    p.then(resolve, reject);
  });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const key = `${u.pathname}${u.search}`;
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? null;
    const record = { key, method: init.method ?? "GET", auth: auth === `Token ${token}` ? "connection" : auth === `Token ${ENV_TOKEN}` ? "ENV" : auth ? "other" : "none" };
    calls.push(record);
    if (String(url) === EXCHANGE_URL) {
      const params = new URLSearchParams(init.body);
      return params.get("username") === USERNAME && params.get("password") === PASSWORD ? json(200, { token }) : json(400, { non_field_errors: [SOURCE_SENTENCE] });
    }
    if (!String(url).startsWith(REST) && !String(url).startsWith(LEGACY)) return json(404, { detail: "not served" });
    if (init.method !== "GET") return json(405, {});
    if (record.auth !== "connection") return json(401, { detail: SOURCE_SENTENCE });
    if (state.faults.refuseAllReads && !key.startsWith("/rest/v1/team/")) return json(401, { detail: SOURCE_SENTENCE });
    if (key === "/rest/v1/team/") return json(200, [...visibleTeams].map((id) => ({ id, name: `${SOURCE_TEAM_NAME_MARKER} ${id}` })), { "x-total-count": String(visibleTeams.size) });
    let m = key.match(/^\/rest\/v1\/team\/(\d+)\/$/);
    if (m) {
      if (state.gates.team) await abortable(init, state.gates.team.p);
      return visibleTeams.has(Number(m[1])) ? json(200, { id: Number(m[1]), name: `${SOURCE_TEAM_NAME_MARKER} ${m[1]}` }) : json(404, { detail: SOURCE_SENTENCE });
    }
    const t = state.served; const b = state.bundle;
    if (t === null) return json(404, { detail: "no team served" });
    const sid = b.teamSession.id;
    if (key === `/rest/v1/team_session/?team=${t}&start_timestamp_gte=2026-09-13%2000%3A00%3A00&start_timestamp_lte=${DAY}%2023%3A59%3A59&limit=100`) {
      if (state.gates.list) await abortable(init, state.gates.list.p);
      if (state.faults.listStatus !== 200) return json(state.faults.listStatus, { detail: SOURCE_SENTENCE });
      if (state.faults.emptyList) return json(200, [], { "x-total-count": "0" });
      const base = { team: Number(t), category_name: "DRILL", start_timestamp: b.teamSession.start_timestamp, end_timestamp: b.teamSession.end_timestamp, updated_on: b.teamSession.updated_on, is_stats_valid: true, drills: [], drills_count: 0 };
      const rows = [{ ...b.teamSession, drills: [sid * 1000 + 1, sid * 1000 + 2], drills_count: 2 }, { ...base, id: sid * 1000 + 1 }, { ...base, id: sid * 1000 + 2 }];
      if (state.faults.listExtraRows) rows.push(...state.faults.listExtraRows.map((r) => ({ ...base, ...r })));
      return json(200, rows, { "x-total-count": String(rows.length) });
    }
    if (key === `/rest/v1/team_session/${sid}/`) return json(200, { ...b.teamSession, drills_count: 2 });
    if (key === `/rest/v1/athlete_session/?teamsession=${sid}&limit=100`) {
      if (state.gates.athletes) await abortable(init, state.gates.athletes.p);
      return json(200, b.athleteSessions, { "x-total-count": String(b.athleteSessions.length) });
    }
    m = key.match(/^\/rest\/v1\/athlete_session\/(\d+)\/(more\/)?$/);
    if (m) {
      const row = b.athleteSessions.find((r) => String(r.id) === m[1]);
      if (!row) return json(404, { detail: SOURCE_SENTENCE });
      return json(200, m[2] ? b.more[m[1]] : row);
    }
    m = key.match(/^\/rest\/v1\/track\/(\d+)\/$/);
    if (m) {
      if (state.gates.track) await abortable(init, state.gates.track.p);
      return b.tracks[m[1]] ? json(200, b.tracks[m[1]]) : json(404, { detail: SOURCE_SENTENCE });
    }
    if (key === `/rest/v1/team_session/${sid}/details/`) return json(200, { drills_count: 2, players: state.faults.wholePlayers ?? b.details.full.players, team: { aggregate: 1 }, teamsession: sid });
    m = key.match(/^\/api\/team_session\/(\d+)\/details\/\?drill=(\d)$/);
    if (m) {
      const d = b.details.drills[m[2]];
      if (!d || state.faults.drillMissing === Number(m[2])) return json(404, { detail: SOURCE_SENTENCE });
      const players = state.faults.drillPlayers && state.faults.drillPlayers.index === Number(m[2]) ? state.faults.drillPlayers.players : d.players;
      return json(200, { drills_count: 2, players, team: { aggregate: 1 }, teamsession: sid * 1000 + Number(m[2]) + 1 });
    }
    if (key === `/api/team_session/${sid}/brief/`) return json(404, { detail: SOURCE_SENTENCE });
    if (key === `/rest/v1/team/${t}/thresholds/?valid_on=${DAY}`) return json(200, b.teamThresholds);
    return json(404, { detail: "not served" });
  };
  const serve = (sourceTeamId, options) => { state.served = String(sourceTeamId); state.bundle = bundleFor(sourceTeamId, options); };
  return { calls, fetchImpl, state, serve };
}
let src;
const useSource = () => {
  src = fakeSource();
  connections.setSourceFetchForTests(src.fetchImpl);
  resolver.setImportSourceFetchForTests(src.fetchImpl);
  return src;
};
const importReads = () => src.calls.filter((c) => c.key.startsWith("/rest/v1/team_session") || c.key.startsWith("/rest/v1/athlete_session") || c.key.startsWith("/rest/v1/track") || c.key.startsWith("/api/") || c.key.includes("/thresholds/"));
// The legacy client factory as a seam: either a fake e03-style client, or a
// trap that fails the test when the legacy path is reached at all.
const legacyTrap = () => importer.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a team with an active binding"); });
const legacyFake = (sourceTeamId, { listGate = null, bundleGate = null, emptyList = false } = {}) => {
  const calls = { factory: 0, list: 0, bundle: 0 };
  importer.setGpexeClientFactory(() => {
    calls.factory += 1;
    const bundle = bundleFor(sourceTeamId);
    return {
      async listTeamSessions({ gpexeTeamId }) { calls.list += 1; assert.equal(String(gpexeTeamId), String(sourceTeamId)); if (listGate) await listGate.p; return emptyList ? [] : [{ id: String(bundle.teamSession.id) }]; },
      async fetchSessionBundle() { calls.bundle += 1; if (bundleGate) await bundleGate.p; return structuredClone(bundle); },
    };
  });
  return calls;
};
const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
const waitFor = async (fn, ms = 4_000) => { for (let i = 0; i < ms / 25 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 25)); assert.ok(fn(), "the awaited condition did not come"); };
async function startCheck(o, cookie = o.coach.cookie) {
  const done = gate();
  importer.setCheckRunObserver(() => done.release());
  const r = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie, body: { from: DAY, to: DAY } });
  return { ...r, done };
}
async function runCheck(o, cookie) {
  const started = await startCheck(o, cookie);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  if (started.body.check.status === "running") await started.done.p;
  const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
  return row;
}
const candidatesOf = (teamId) => q(`select id, gpexe_team_session_id, status, raw_bundle, bundle_hash from training_load.gpexe_import_candidates where owner_team_id = $1 order by first_seen_at`, [teamId]);
const CREATE = (club) => ({ ownerScope: "club", ownerClubId: club, hostKey: "server3", accountLabel: "Club account (label only)", credentialKind: "exchanged_token" });
async function verifiedConnection(o) {
  const c = await api("/sources/gpexe/connections", { method: "POST", cookie: o.cadmin.cookie, body: CREATE(o.clubId) });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const r = await api(`/sources/gpexe/connections/${c.body.connection.id}/connect`, { method: "POST", cookie: o.cadmin.cookie, body: { username: USERNAME, password: PASSWORD }, allowed: [SOURCE_TEAM_NAME_MARKER] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.state, "verified");
  return r.body.connection;
}
async function bound(o) {
  const conn = await verifiedConnection(o);
  const r = await api(`/sources/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { conn, binding: r.body.result.binding };
}
async function unbind(o, conn, binding, cookie = o.cadmin.cookie) {
  return api(`/sources/gpexe/connections/${conn.id}/bindings/${binding.bindingId}/unbind`, { method: "POST", cookie, body: { requestKey: crypto.randomUUID(), reason: "test: end the binding", expected: { teamId: binding.teamId, sourceTeamId: binding.sourceTeamId } } });
}
const connRow = async (id) => (await q(`select state, last_error_code from training_load.source_credential_connections where id = $1`, [id]))[0];
const auditOf = (id) => q(`select action, outcome, error_code, basis, performed_by_user_id, metadata, team_id from training_load.source_connection_audit where connection_id = $1 order by performed_at, id`, [id]);

// ---------------------------------------------------------------------------
test("1. a team without a new binding keeps the legacy path, explicitly: the legacy client factory is called once, no request reaches the new adapter, the check succeeds and records its candidate, and the log names legacy_env", async () => {
  const o = await org();
  useSource();
  const legacy = legacyFake(o.sourceTeamId);
  const logBefore = logLines.length;
  const row = await runCheck(o);
  assert.equal(row.status, "succeeded", JSON.stringify(row));
  assert.deepEqual([legacy.factory, legacy.list, legacy.bundle], [1, 1, 1]);
  assert.equal(importReads().length, 0, "the new adapter was not used");
  assert.equal((await candidatesOf(o.teamId)).length, 1);
  assert.ok(logLines.slice(logBefore).some((l) => l.includes(`check ${row.id}`) && l.includes("legacy_env")), "the path is logged");
  assert.deepEqual([row.source_path, row.source_connection_id, row.source_binding_id, row.source_team_id, row.source_host_key], ["legacy_env", null, null, null, null], "v31: the row records the legacy path and nothing else");
  // Without an environment token the legacy path answers as before: 503, no check row.
  importer.setGpexeClientFactory(null);
  delete process.env.GPEXE_API_TOKEN;
  const before = (await q(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [o.teamId]))[0].n;
  const r = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.coach.cookie, body: { from: DAY, to: DAY } });
  assert.deepEqual([r.status, r.body.error], [503, "gpexe_token_missing"]);
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [o.teamId]))[0].n, before);
});

test("2. a team with an active binding reads only through it: the environment token is set and the legacy factory is a trap, yet the check succeeds through the adapter bound to the approved source team, every request carries the connection's token (never the environment one), the candidate is stored in the F1 bundle shape without drillsStatus / drillLabels, and no secret leaks anywhere", async () => {
  const o = await org();
  useSource();
  const { conn, binding } = await bound(o);
  process.env.GPEXE_API_TOKEN = ENV_TOKEN;
  legacyTrap();
  src.serve(o.sourceTeamId);
  const logBefore = logLines.length;
  const row = await runCheck(o);
  assert.equal(row.status, "succeeded", JSON.stringify(row));
  assert.equal(row.gpexe_team_id, o.sourceTeamId);
  assert.deepEqual([row.source_path, row.source_connection_id, row.source_binding_id, row.source_team_id, row.source_host_key], ["source_connection", conn.id, binding.bindingId, o.sourceTeamId, "server3"], "v31: the row records the path, the connection, the binding, the source team and the host key — written in the locked INSERT");
  await assert.rejects(q(`update training_load.gpexe_import_checks set source_path = 'legacy_env', source_connection_id = null, source_binding_id = null, source_team_id = null, source_host_key = null where id = $1`, [row.id]), /credential path of check .* is final/);
  const reads = importReads();
  assert.ok(reads.length >= 8, `the adapter read the list, the session, the athletes, their rows, more, tracks, details, drills, thresholds (${reads.length})`);
  assert.ok(reads.every((c) => c.method === "GET" && c.auth === "connection"), "GET only, the connection's token only");
  assert.ok(src.calls.every((c) => c.auth !== "ENV"), "the environment token never reached the source");
  assert.ok(reads.every((c) => c.key.includes(`team=${o.sourceTeamId}`) || !c.key.includes("team=")), "every list is scoped to the bound team");
  const candidates = await candidatesOf(o.teamId);
  assert.equal(candidates.length, 1);
  const raw = candidates[0].raw_bundle;
  assert.deepEqual(Object.keys(raw).sort(), ["athleteSessions", "details", "more", "teamSession", "teamThresholds", "tracks"], "the F1 bundle shape, nothing of the adapter's extras");
  assert.equal(String(raw.teamSession.team), o.sourceTeamId);
  assert.deepEqual(Object.keys(raw.details.drills).sort(), ["0", "1"], "both drills read");
  assert.ok(logLines.slice(logBefore).some((l) => l.includes(`check ${row.id}`) && l.includes("source_connection") && l.includes(conn.id) && l.includes(binding.bindingId)), "the path, connection and binding are logged");
  for (const line of logLines) noSecret(line, "a console line");
  noSecret(JSON.stringify(row), "the check row");
  noSecret(JSON.stringify(candidates), "the candidate rows");
  assert.equal((await connRow(conn.id)).state, "verified", "a successful import read changes no state");
  assert.equal((await auditOf(conn.id)).filter((a) => a.action === "auto_invalidate").length, 0);
});

test("3. a binding that is not usable never falls back to the environment token: needs_reconnect, source_unavailable and linked_untested connections, a retired host and a missing key answer 409 / 503 source_connection_unavailable — the precise reason for an administrator only, the coach gets the stable code and the sentence to contact an administrator —, no check row, the legacy factory never called; an unreadable credential is found after COMMIT, on the check row, with zero source requests; after the cause is gone the same team checks normally", async () => {
  const o = await org();
  useSource();
  const { conn } = await bound(o);
  process.env.GPEXE_API_TOKEN = ENV_TOKEN;
  legacyTrap();
  src.serve(o.sourceTeamId);
  const checks = async () => (await q(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [o.teamId]))[0].n;
  const expectRefusal = async (status, reason) => {
    const before = await checks();
    const coach = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.coach.cookie, body: { from: DAY, to: DAY } });
    assert.deepEqual([coach.status, coach.body.error, coach.body.reason], [status, "source_connection_unavailable", undefined], JSON.stringify(coach.body));
    assert.match(coach.body.message, /contact an administrator/);
    const padmin = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.padmin.cookie, body: { from: DAY, to: DAY } });
    assert.deepEqual([padmin.status, padmin.body.error, padmin.body.reason], [status, "source_connection_unavailable", reason], JSON.stringify(padmin.body));
    const cadmin = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.cadmin.cookie, body: { from: DAY, to: DAY } });
    assert.deepEqual([cadmin.status, cadmin.body.error, cadmin.body.reason], [status, "source_connection_unavailable", reason], JSON.stringify(cadmin.body));
    assert.equal(await checks(), before, "no check row");
    assert.equal(importReads().length, 0, "nothing read");
  };
  for (const state of ["needs_reconnect", "source_unavailable", "linked_untested"]) {
    await q(`update training_load.source_credential_connections set state = $2, last_error_code = 'source_auth_rejected', last_error_at = now() where id = $1`, [conn.id, state]);
    await expectRefusal(409, "connection_not_usable");
  }
  await q(`update training_load.source_credential_connections set state = 'verified', last_verified_at = now() where id = $1`, [conn.id]);
  await q(`update training_load.source_host_catalog set state = 'retired' where source_system = 'gpexe' and host_key = 'server3'`);
  await expectRefusal(409, "host_not_allowed");
  await q(`update training_load.source_host_catalog set state = 'approved' where source_system = 'gpexe' and host_key = 'server3'`);
  const keys = process.env.SOURCE_CREDENTIAL_KEYS;
  delete process.env.SOURCE_CREDENTIAL_KEYS;
  await expectRefusal(503, "key_missing");
  process.env.SOURCE_CREDENTIAL_KEYS = cryptoMod.generateKeyEntry(2);
  await expectRefusal(503, "key_missing");
  process.env.SOURCE_CREDENTIAL_KEYS = keys;
  const parts = (await q(`select credential_auth_tag from training_load.source_credential_connections where id = $1`, [conn.id]))[0];
  await q(`update training_load.source_credential_connections set credential_auth_tag = decode('00000000000000000000000000000000', 'hex') where id = $1`, [conn.id]);
  // The key ring is proven before the row (no decrypt); the decrypt itself happens once, after COMMIT: an
  // unreadable credential is therefore a failed check row with zero source requests, never a fallback.
  const startedByCoach = await startCheck(o);
  assert.equal(startedByCoach.status, 202, JSON.stringify(startedByCoach.body));
  if (startedByCoach.body.check.status === "running") await startedByCoach.done.p;
  const unreadable = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [startedByCoach.body.check.id]))[0];
  assert.deepEqual([unreadable.status, unreadable.error_code], ["failed", "credential_unreadable"], JSON.stringify(unreadable));
  assert.equal(importReads().length, 0, "nothing read");
  // Round 5: the precise code stays in the database; on the API the coach sees the stable code and the sentence to
  // contact an administrator — on the start answer, the check detail and the status — while the platform admin and
  // the club's own admin see the precise code: the same failed row for all three.
  assert.deepEqual([startedByCoach.body.check.error.code, /contact an administrator/.test(startedByCoach.body.check.error.message)], ["source_connection_unavailable", true], JSON.stringify(startedByCoach.body));
  // A coach who is also a club admin of ANOTHER club is still a coach here (the authority is the team's own club).
  const otherClub = (await q(`insert into public.clubs (name) values ($1) returning id`, [`other-${uid()}`]))[0].id;
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [o.coach.id, otherClub]);
  for (const [who, cookie, expected] of [["coach", o.coach.cookie, "source_connection_unavailable"], ["coach who administers another club", o.coach.cookie, "source_connection_unavailable"], ["platform admin", o.padmin.cookie, "credential_unreadable"], ["club admin", o.cadmin.cookie, "credential_unreadable"]]) {
    const detail = await api(`/gpexe/teams/${o.teamId}/checks/${unreadable.id}`, { cookie });
    const status = await api(`/gpexe/teams/${o.teamId}/status`, { cookie });
    assert.deepEqual([detail.status, detail.body.check.error.code, status.status, status.body.lastCheck.error.code], [200, expected, 200, expected], `${who}: ${JSON.stringify([detail.body, status.body.lastCheck])}`);
    if (expected === "source_connection_unavailable") {
      assert.match(detail.body.check.error.message, /contact an administrator/);
      assert.doesNotMatch(JSON.stringify([detail.body, status.body.lastCheck]), /credential|unreadable|reconnect/i, `${who} sees no connection fact`);
    } else {
      assert.match(detail.body.check.error.message, /could not be read/);
    }
  }
  // The same failure started by the club's admin: the start answer itself carries the precise code.
  const startedByAdmin = await startCheck(o, o.cadmin.cookie);
  assert.equal(startedByAdmin.status, 202, JSON.stringify(startedByAdmin.body));
  if (startedByAdmin.body.check.status === "running") await startedByAdmin.done.p;
  assert.deepEqual([startedByAdmin.body.check.error.code, /could not be read/.test(startedByAdmin.body.check.error.message)], ["credential_unreadable", true], JSON.stringify(startedByAdmin.body));
  await q(`update training_load.source_credential_connections set credential_auth_tag = $2 where id = $1`, [conn.id, parts.credential_auth_tag]);
  const row = await runCheck(o);
  assert.equal(row.status, "succeeded", JSON.stringify(row));
});

test("4. the resolver's own contract (a fake executor): no binding → legacy_env; two active bindings → binding_ambiguous; an inactive or missing team → team_not_available; a missing or different approved pair → team_setting_missing / team_setting_mismatch; a connection of another club or an archived club → connection_foreign_club; every non-verified state → connection_not_usable; a retired catalog row or an unknown host key → host_not_allowed; a facts object never carries a URL; the resolver takes no host, URL, source team or credential from the caller", async () => {
  const teamId = crypto.randomUUID();
  const base = {
    team_id: teamId, team_club_id: "c1", team_active: true, binding_id: "b1", connection_id: "k1", source_team_id: "981", binding_state: "active", source_system: "gpexe",
    approved_source_team_id: "981", connection_row_id: "k1", owner_scope: "club", owner_club_id: "c1", connection_state: "verified", host_key: "server3", credential_kind: "exchanged_token",
    credential_ciphertext: Buffer.alloc(1), credential_nonce: Buffer.alloc(1), credential_auth_tag: Buffer.alloc(1), credential_key_version: 1, club_active: true, credential_fingerprint: "f".repeat(64),
    catalog_source_system: "gpexe", catalog_host_key: "server3", catalog_state: "approved", team_club_active: true, has_ended_binding: false,
  };
  const exec = (rows) => ({ query: async () => ({ rows }) });
  const code = async (rows) => { try { await resolver.resolveImportSourceFacts(exec(rows), { teamId }); return "ok"; } catch (e) { return e.code; } };
  const none = { ...base, binding_id: null, connection_id: null, source_team_id: null, binding_state: null, source_system: null, connection_row_id: null };
  assert.equal((await resolver.resolveImportSourceFacts(exec([none]), { teamId })).path, "legacy_env");
  assert.equal(await code([base, { ...base, binding_id: "b2" }]), "binding_ambiguous");
  assert.equal(await code([]), "team_not_available");
  assert.equal(await code([{ ...base, team_active: false }]), "team_not_available");
  assert.equal(await code([{ ...base, team_club_active: false }]), "team_not_available");
  assert.equal(await code([{ ...none, has_ended_binding: true }]), "binding_ended", "a team that had a binding never returns to the legacy path");
  // Every code this module can put on a check row is classified: masked for a coach (a connection fact) or deliberately
  // visible (a team fact, a source-data fact). A new code fails here until it is classified.
  const coachVisible = ["team_not_available", "team_club_changed", "drill_set_incomplete"];
  for (const c of resolver.IMPORT_RESOLVE_CODES) assert.ok(resolver.isConnectionConfigurationCode(c) !== coachVisible.includes(c), `${c} is classified exactly once`);
  for (const c of ["source_auth_rejected", "source_access_refused"]) assert.ok(resolver.isConnectionConfigurationCode(c), `${c} (the adapter's credential answers) is masked`);
  for (const c of ["source_unavailable", "source_answer_unexpected", "source_list_ambiguous", "internal_error", "abandoned"]) assert.ok(!resolver.isConnectionConfigurationCode(c), `${c} stays visible`);
  assert.deepEqual([...resolver.CONNECTION_CONFIGURATION_CODE_LIST].sort(), [...new Set(resolver.CONNECTION_CONFIGURATION_CODE_LIST)].sort());
  assert.equal(await code([{ ...base, approved_source_team_id: null }]), "team_setting_missing");
  assert.equal(await code([{ ...base, approved_source_team_id: "0981" }]), "ok", "the approved pair is compared canonically, the one rule v30 / the bind / the Settings route share");
  assert.equal(await code([{ ...base, approved_source_team_id: "x981" }]), "team_setting_missing");
  assert.equal(await code([{ ...base, credential_fingerprint: null }]), "credential_unreadable");
  assert.equal(await code([{ ...base, approved_source_team_id: "982" }]), "team_setting_mismatch");
  assert.equal(await code([{ ...base, owner_club_id: "c2" }]), "connection_foreign_club");
  assert.equal(await code([{ ...base, club_active: false }]), "connection_foreign_club");
  assert.equal(await code([{ ...base, connection_row_id: null }]), "connection_foreign_club");
  for (const state of ["not_connected", "linked_untested", "needs_reconnect", "source_unavailable"]) assert.equal(await code([{ ...base, connection_state: state }]), "connection_not_usable");
  assert.equal(await code([{ ...base, catalog_state: "retired" }]), "host_not_allowed");
  assert.equal(await code([{ ...base, catalog_host_key: null }]), "host_not_allowed");
  assert.equal(await code([{ ...base, host_key: "e03", catalog_host_key: "e03" }]), "ok", "e03 is approved in the catalog and in code (its family has no adapter: that refusal comes when the source is opened)");
  assert.equal(await code([{ ...base, host_key: "evil", catalog_host_key: "evil" }]), "host_not_allowed");
  const facts = await resolver.resolveImportSourceFacts(exec([base]), { teamId });
  assert.deepEqual([facts.path, facts.bindingId, facts.connectionId, facts.sourceTeamId, facts.hostKey, facts.apiFamily, facts.credentialFingerprint], ["source_connection", "b1", "k1", "981", "server3", "rest_v1", "f".repeat(64)]);
  assert.ok(!JSON.stringify(facts).includes("http"), "no URL in the facts");
  // Only objects the resolver issued are accepted back: a forged facts object, however complete, is refused.
  for (const forged of [{ ...facts }, { path: "source_connection", hostKey: "evil", catalogRow: { state: "approved" }, credential: facts.credential }, {}]) {
    assert.throws(() => resolver.openImportSource(forged), (e) => e.code === "context_not_issued");
    assert.throws(() => resolver.preflightImportSource(forged), (e) => e.code === "context_not_issued");
    assert.throws(() => resolver.importClientFor(forged), (e) => e.code === "context_not_issued");
    await assert.rejects(resolver.assertImportSourceStillUsable(forged), (e) => e.code === "context_not_issued");
    assert.equal(await resolver.autoInvalidateImportSource(forged), false);
  }
  resolver.preflightImportSource(facts);
  for (const bad of [{ teamId: "not-a-uuid" }, { teamId, sourceSystem: "GPEXE" }, { teamId: undefined }]) {
    await assert.rejects(resolver.resolveImportSourceFacts(exec([base]), bad), (e) => ["team_not_available", "binding_ambiguous"].includes(e.code));
  }
  // The e03 host has no rest_v1 adapter: opening it is refused as adapter_not_available (no fallback to another host).
  const e03 = await resolver.resolveImportSourceFacts(exec([{ ...base, host_key: "e03", catalog_host_key: "e03" }]), { teamId });
  assert.throws(() => resolver.openImportSource(e03), (e) => e.code === "adapter_not_available" || e.code === "credential_unreadable");
});

test("5. an ended binding is never used, and a team that had one never returns to the environment token: after an Unbind a check answers 409 source_connection_unavailable (reason binding_ended for an administrator), the legacy factory is not called and the environment token is not read; a new binding opens the source-connection path again; a second club's own binding is read; another club's team cannot be bound through this club's connection", async () => {
  const o = await org();
  useSource();
  const { conn, binding } = await bound(o);
  legacyTrap();
  src.serve(o.sourceTeamId);
  assert.equal((await runCheck(o)).status, "succeeded");
  assert.equal((await unbind(o, conn, binding)).status, 200);
  process.env.GPEXE_API_TOKEN = ENV_TOKEN;
  const readsBefore = importReads().length;
  const checksBefore = (await q(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [o.teamId]))[0].n;
  const coach = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.coach.cookie, body: { from: DAY, to: DAY } });
  assert.deepEqual([coach.status, coach.body.error, coach.body.reason], [409, "source_connection_unavailable", undefined], JSON.stringify(coach.body));
  const padmin = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.padmin.cookie, body: { from: DAY, to: DAY } });
  assert.deepEqual([padmin.status, padmin.body.error, padmin.body.reason], [409, "source_connection_unavailable", "binding_ended"], JSON.stringify(padmin.body));
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [o.teamId]))[0].n, checksBefore, "no check row");
  assert.equal(importReads().length, readsBefore, "the ended binding's connection was not read");
  assert.ok(src.calls.every((c) => c.auth !== "ENV"), "the environment token was never sent");
  // A new binding of the same pair opens the source-connection path again.
  const again = await api(`/sources/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  const rowAgain = await runCheck(o);
  assert.deepEqual([rowAgain.status, rowAgain.source_path, rowAgain.source_binding_id], ["succeeded", "source_connection", again.body.result.binding.bindingId]);
  assert.ok(importReads().length > readsBefore, "read through the new binding");
  // Binding B: the approved pair must change first (allowed once the binding ended and only
  // while nothing of the team describes the old one — this team has checks, so v24 refuses);
  // so B is bound on a second team of the same club through the same connection.
  const other = await org();
  legacyTrap();
  const otherBinding = await api(`/sources/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: other.teamId, sourceTeamId: other.sourceTeamId } });
  assert.equal(otherBinding.status, 404, "another club's team cannot be bound through this club's connection");
  const second = await verifiedConnection(other);
  const b2 = await api(`/sources/gpexe/connections/${second.id}/bindings`, { method: "POST", cookie: other.cadmin.cookie, body: { teamId: other.teamId, sourceTeamId: other.sourceTeamId } });
  assert.equal(b2.status, 201, JSON.stringify(b2.body));
  src.serve(other.sourceTeamId);
  const row = await runCheck(other);
  assert.equal(row.status, "succeeded", JSON.stringify(row));
  assert.ok(importReads().filter((c) => c.key.includes(`team=${other.sourceTeamId}`)).length > 0);
});

test("6. concurrency: an Unbind holding the team lock, a Test / bind in flight or any holder of the team import lock makes the check answer 409 gpexe_change_busy with no check row; an Unbind that lands after the resolve and before the first source read stops the run with binding_ended before any request (nothing recorded, the Unbind itself succeeded); a connection moved to needs_reconnect or a host retired during the run stop it with their codes", async () => {
  const o = await org();
  useSource();
  const { conn, binding } = await bound(o);
  legacyTrap();
  src.serve(o.sourceTeamId);
  const checks = async () => (await q(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [o.teamId]))[0].n;
  // (a) an Unbind held before its UPDATE holds the team's try-lock.
  {
    const g = gate(); let held = false;
    connections.setSourceUnbindHoldForTests(async () => { held = true; await g.p; });
    const pending = unbind(o, conn, binding);
    await waitFor(() => held);
    const before = await checks();
    const r = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.coach.cookie, body: { from: DAY, to: DAY } });
    assert.deepEqual([r.status, r.body.error], [409, "gpexe_change_busy"], JSON.stringify(r.body));
    assert.equal(await checks(), before);
    // Let the Unbind through, then rebind the same pair for the rest of the test.
    connections.setSourceUnbindHoldForTests(null);
    g.release();
    assert.equal((await pending).status, 200);
  }
  const rebound = await api(`/sources/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
  assert.equal(rebound.status, 201, JSON.stringify(rebound.body));
  const binding2 = rebound.body.result.binding;
  // (b) a Test in flight (its team read held at the source) holds the bound team's try-lock.
  {
    src.state.gates.team = gate();
    const testing = api(`/sources/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: o.cadmin.cookie, body: {}, allowed: [SOURCE_TEAM_NAME_MARKER] });
    await waitFor(() => src.calls.some((c) => c.key === `/rest/v1/team/${o.sourceTeamId}/` && c.auth === "connection") && src.calls.filter((c) => c.key === "/rest/v1/team/").length >= 2);
    const before = await checks();
    const r = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.coach.cookie, body: { from: DAY, to: DAY } });
    assert.deepEqual([r.status, r.body.error], [409, "gpexe_change_busy"], JSON.stringify(r.body));
    assert.equal(await checks(), before);
    src.state.gates.team.release(); src.state.gates.team = null;
    assert.equal((await testing).status, 200);
  }
  // (c) any holder of the team import lock (an import, a Settings change, the undo).
  {
    const peer = new pg.Client({ connectionString: db.url });
    await peer.connect();
    try {
      await peer.query("begin");
      await peer.query(`select training_load.hold_gpexe_team_lock($1, 'import')`, [o.teamId]);
      const before = await checks();
      const r = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.coach.cookie, body: { from: DAY, to: DAY } });
      assert.deepEqual([r.status, r.body.error], [409, "gpexe_change_busy"]);
      assert.equal(await checks(), before);
      await peer.query("rollback");
    } finally { await peer.end(); }
  }
  // (d) the Unbind lands after the resolve, before the first source read: the run re-validates and stops.
  {
    const g = gate(); let held = false;
    resolver.setImportSourceRevalidateHoldForTests(async () => { held = true; await g.p; });
    const readsBefore = importReads().length;
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => held);
    resolver.setImportSourceRevalidateHoldForTests(null);
    const u = await unbind(o, conn, binding2);
    assert.equal(u.status, 200, JSON.stringify(u.body));
    g.release();
    await started.done.p;
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "binding_ended"], JSON.stringify(row));
    assert.equal(importReads().length, readsBefore, "no source request after the binding ended");
    assert.equal((await candidatesOf(o.teamId)).length, 0, "nothing recorded by this check");
    assert.ok(src.calls.every((c) => c.auth !== "ENV"));
  }
  const rebound2 = await api(`/sources/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
  assert.equal(rebound2.status, 201, JSON.stringify(rebound2.body));
  // (e) the connection leaves `verified` while the run is between two reads; (f) the host is retired meanwhile.
  for (const [mutate, code, restore] of [
    [() => q(`update training_load.source_credential_connections set state = 'needs_reconnect', last_error_code = 'source_auth_rejected', last_error_at = now() where id = $1`, [conn.id]), "connection_not_usable", () => q(`update training_load.source_credential_connections set state = 'verified', last_verified_at = now() where id = $1`, [conn.id])],
    [() => q(`update training_load.source_host_catalog set state = 'retired' where host_key = 'server3'`), "host_not_allowed", () => q(`update training_load.source_host_catalog set state = 'approved' where host_key = 'server3'`)],
  ]) {
    const g = gate(); let holds = 0;
    // The first re-validation (before the list) passes; the mutation lands before the second one (after the list,
    // before any bundle): re-validations are list-pre (1), list-post (2), bundle-pre (3), bundle-post (4).
    resolver.setImportSourceRevalidateHoldForTests(async () => { holds += 1; if (holds === 2) await g.p; });
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => holds === 2);
    const listReads = importReads().filter((c) => c.key.includes("start_timestamp_gte")).length;
    await mutate();
    g.release();
    await started.done.p;
    resolver.setImportSourceRevalidateHoldForTests(null);
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", code], JSON.stringify(row));
    assert.equal(importReads().filter((c) => c.key.includes("start_timestamp_gte")).length, listReads, "no further list read");
    assert.equal((await candidatesOf(o.teamId)).length, 0, "the session was not recorded");
    await restore();
  }
  assert.ok(src.calls.every((c) => c.auth !== "ENV"), "the environment token was never tried");
});

test("7. a refused or lost source answer never causes a fallback: a 403 fails the check with source_access_refused and changes no state (one resource the credential may not read is not a refused credential); 401 on the first read fails the check with source_auth_rejected, moves the connection to needs_reconnect with exactly one auto_invalidate audit row (basis system, no user, the binding and team named) and the legacy factory is never called; a 503 fails the check with source_unavailable and changes no state; a second refused check adds no second auto_invalidate row", async () => {
  const o = await org();
  useSource();
  const { conn, binding } = await bound(o);
  process.env.GPEXE_API_TOKEN = ENV_TOKEN;
  legacyTrap();
  src.serve(o.sourceTeamId);
  src.state.faults.listStatus = 403;
  const forbidden = await runCheck(o);
  assert.deepEqual([forbidden.status, forbidden.error_code], ["failed", "source_access_refused"], JSON.stringify(forbidden));
  assert.equal((await connRow(conn.id)).state, "verified", "a 403 keeps the state");
  assert.equal((await auditOf(conn.id)).filter((a) => a.action === "auto_invalidate").length, 0);
  src.state.faults.listStatus = 503;
  let row = await runCheck(o);
  assert.deepEqual([row.status, row.error_code], ["failed", "source_unavailable"], JSON.stringify(row));
  assert.equal((await connRow(conn.id)).state, "verified");
  assert.equal((await auditOf(conn.id)).filter((a) => a.action === "auto_invalidate").length, 0);
  // Round 5: a general source answer (a 5xx) is not a connection fact — the coach sees it as it is.
  assert.equal((await api(`/gpexe/teams/${o.teamId}/checks/${row.id}`, { cookie: o.coach.cookie })).body.check.error.code, "source_unavailable");
  assert.equal((await api(`/gpexe/teams/${o.teamId}/checks/${forbidden.id}`, { cookie: o.coach.cookie })).body.check.error.code, "source_connection_unavailable", "a resource the credential may not read is a connection fact: masked for the coach");
  src.state.faults.listStatus = 401;
  row = await runCheck(o);
  assert.deepEqual([row.status, row.error_code], ["failed", "source_auth_rejected"], JSON.stringify(row));
  assert.deepEqual(await connRow(conn.id), { state: "needs_reconnect", last_error_code: "source_auth_rejected" });
  // Round 5: a refused credential is a connection fact — the coach sees the stable code on the detail and the status,
  // the club admin and the platform admin the precise one.
  const refusedByCoach = await api(`/gpexe/teams/${o.teamId}/checks/${row.id}`, { cookie: o.coach.cookie });
  assert.deepEqual([refusedByCoach.body.check.error.code, /contact an administrator/.test(refusedByCoach.body.check.error.message)], ["source_connection_unavailable", true], JSON.stringify(refusedByCoach.body));
  assert.equal((await api(`/gpexe/teams/${o.teamId}/status`, { cookie: o.coach.cookie })).body.lastCheck.error.code, "source_connection_unavailable");
  assert.equal((await api(`/gpexe/teams/${o.teamId}/status`, { cookie: o.cadmin.cookie })).body.lastCheck.error.code, "source_auth_rejected");
  assert.equal((await api(`/gpexe/teams/${o.teamId}/checks/${row.id}`, { cookie: o.padmin.cookie })).body.check.error.code, "source_auth_rejected");
  const rows = (await auditOf(conn.id)).filter((a) => a.action === "auto_invalidate");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].outcome, rows[0].error_code, rows[0].basis, rows[0].performed_by_user_id, rows[0].team_id, rows[0].metadata.binding_id, rows[0].metadata.source_team_id, rows[0].metadata.trigger], ["ok", "source_auth_rejected", "system", null, o.teamId, binding.bindingId, o.sourceTeamId, "import_read"]);
  noSecret(JSON.stringify(rows), "the audit row");
  // Now the connection is not usable: the next check is refused locally, and the audit has no second row.
  const r = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.padmin.cookie, body: { from: DAY, to: DAY } });
  assert.deepEqual([r.status, r.body.error, r.body.reason], [409, "source_connection_unavailable", "connection_not_usable"]);
  assert.equal((await auditOf(conn.id)).filter((a) => a.action === "auto_invalidate").length, 1);
  assert.ok(src.calls.every((c) => c.auth !== "ENV"), "the environment token was never tried");
  assert.equal((await candidatesOf(o.teamId)).length, 0);
});

test("8. drills on the binding path: a drill the source does not answer makes the check stop with drill_set_incomplete before the session is recorded (never a candidate with fewer drills); an empty, successfully read players map is a valid empty drill and the session is recorded with it", async () => {
  const o = await org();
  useSource();
  await bound(o);
  legacyTrap();
  src.serve(o.sourceTeamId);
  src.state.faults.drillMissing = 1;
  let row = await runCheck(o);
  assert.deepEqual([row.status, row.error_code], ["failed", "drill_set_incomplete"], JSON.stringify(row));
  assert.equal((await candidatesOf(o.teamId)).length, 0, "an incomplete drill set is never recorded");
  src.state.faults.drillMissing = null;
  src.serve(o.sourceTeamId, { emptyDrill: 1 });
  row = await runCheck(o);
  assert.equal(row.status, "succeeded", JSON.stringify(row));
  const [candidate] = await candidatesOf(o.teamId);
  assert.deepEqual(candidate.raw_bundle.details.drills["1"].players, {}, "a valid empty drill, kept as such");
  assert.ok(Object.keys(candidate.raw_bundle.details.drills["0"].players).length > 0);
});

test("9. cross-club and cross-team isolation through the resolver: a coach of another team cannot start a check on this team (404), a club admin of the owning club does not get the coach's route either way, and the resolver reads only the one team it was given", async () => {
  const o = await org();
  const other = await org();
  useSource();
  await bound(o);
  legacyTrap();
  src.serve(o.sourceTeamId);
  assert.equal((await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: other.coach.cookie, body: { from: DAY, to: DAY } })).status, 404);
  assert.equal((await api(`/gpexe/teams/${crypto.randomUUID()}/checks`, { method: "POST", cookie: o.coach.cookie, body: { from: DAY, to: DAY } })).status, 404);
  assert.equal(importReads().length, 0);
  // The other team (no binding) stays on the legacy path even while this club's connection exists.
  const legacy = legacyFake(other.sourceTeamId);
  assert.equal((await runCheck(other)).status, "succeeded");
  assert.equal(legacy.factory, 1);
  assert.equal(importReads().length, 0);
});

test("11. the path is decided once, under the team lock: a binding created between the unlocked pre-read (legacy) and the locked read, or ended between them (binding path), answers 409 gpexe_change_busy with no check row and no request; the next start takes the new path", async () => {
  const o = await org();
  useSource();
  const checks = async () => (await q(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [o.teamId]))[0].n;
  // (a) legacy at the pre-read, a binding appears before the lock.
  const legacy = legacyFake(o.sourceTeamId);
  const conn = await verifiedConnection(o);
  {
    const g = gate(); let held = false;
    importer.setImportSourcePreReadHoldForTests(async () => { held = true; await g.p; });
    const pending = api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.coach.cookie, body: { from: DAY, to: DAY } });
    await waitFor(() => held);
    importer.setImportSourcePreReadHoldForTests(null);
    const b = await api(`/sources/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    g.release();
    const r = await pending;
    assert.deepEqual([r.status, r.body.error], [409, "gpexe_change_busy"], JSON.stringify(r.body));
    assert.equal(await checks(), 0, "no check row");
    assert.deepEqual([legacy.list, legacy.bundle], [0, 0], "the legacy client built at the pre-read was never used");
    assert.equal(importReads().length, 0);
  }
  // The next start takes the binding path (the legacy factory is a trap now).
  legacyTrap();
  src.serve(o.sourceTeamId);
  assert.equal((await runCheck(o)).status, "succeeded");
  // (b) the binding path at the pre-read, the binding ends before the lock.
  const binding = (await q(`select id, team_id, source_team_id from training_load.source_team_bindings where team_id = $1 and state = 'active'`, [o.teamId]))[0];
  {
    const g = gate(); let held = false;
    importer.setImportSourcePreReadHoldForTests(async () => { held = true; await g.p; });
    const before = await checks();
    const readsBefore = importReads().length;
    const pending = api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.coach.cookie, body: { from: DAY, to: DAY } });
    await waitFor(() => held);
    importer.setImportSourcePreReadHoldForTests(null);
    const u = await unbind(o, conn, { bindingId: binding.id, teamId: binding.team_id, sourceTeamId: binding.source_team_id });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    g.release();
    const r = await pending;
    assert.deepEqual([r.status, r.body.error], [409, "gpexe_change_busy"], JSON.stringify(r.body));
    assert.equal(await checks(), before, "no check row");
    assert.equal(importReads().length, readsBefore, "no request");
  }
});

test("12. round-2 hardening: a Reconnect during a run stops it with connection_credential_changed (the fresh credential stays verified, no auto_invalidate row, nothing recorded); binding A ended and B created mid-run stops it with binding_ended; a legacy run stops with binding_started when a binding appears mid-run; the binding path reports progress per request (heartbeat_at advances inside one bundle); an auto_invalidate whose COMMIT never answers neither holds the check's outcome nor leaks a client, and the next refused check invalidates normally; a check-start COMMIT that lands but does not answer still runs the check, one that never lands answers 503 check_outcome_unknown and the next start is not check_already_running; an approved pair stored with a leading zero imports normally", async () => {
  // (a) Reconnect mid-run.
  {
    const o = await org();
    useSource();
    const { conn } = await bound(o);
    legacyTrap();
    src.serve(o.sourceTeamId);
    const g = gate(); let holds = 0;
    resolver.setImportSourceRevalidateHoldForTests(async () => { holds += 1; if (holds === 2) await g.p; });
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => holds === 2);
    const fpBefore = (await q(`select encode(sha256(credential_nonce), 'hex') as fp from training_load.source_credential_connections where id = $1`, [conn.id]))[0].fp;
    const re = await api(`/sources/gpexe/connections/${conn.id}/reconnect`, { method: "POST", cookie: o.cadmin.cookie, body: { username: USERNAME, password: PASSWORD, confirmation: { sourceSystem: "gpexe", ownerClubId: o.clubId, affectedTeamCount: 1 } }, allowed: [SOURCE_TEAM_NAME_MARKER] });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    assert.equal(re.body.result.state, "verified");
    assert.notEqual((await q(`select encode(sha256(credential_nonce), 'hex') as fp from training_load.source_credential_connections where id = $1`, [conn.id]))[0].fp, fpBefore, "a Reconnect re-encrypts with a fresh nonce");
    const readsBefore = importReads().length;
    g.release();
    await started.done.p;
    resolver.setImportSourceRevalidateHoldForTests(null);
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "connection_credential_changed"], JSON.stringify(row));
    assert.equal(importReads().length, readsBefore, "no bundle read with the replaced credential");
    assert.equal((await connRow(conn.id)).state, "verified", "the fresh credential is untouched");
    assert.equal((await auditOf(conn.id)).filter((a) => a.action === "auto_invalidate").length, 0);
    assert.equal((await candidatesOf(o.teamId)).length, 0);
    // The next check reads with the fresh credential.
    assert.equal((await runCheck(o)).status, "succeeded");
  }
  // (b) binding A ends and binding B (same pair, new row) appears between two reads.
  {
    const o = await org();
    useSource();
    const { conn, binding } = await bound(o);
    legacyTrap();
    src.serve(o.sourceTeamId);
    const g = gate(); let holds = 0;
    resolver.setImportSourceRevalidateHoldForTests(async () => { holds += 1; if (holds === 2) await g.p; });
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => holds === 2);
    const u = await unbind(o, conn, binding);
    assert.equal(u.status, 200, JSON.stringify(u.body));
    const b2 = await api(`/sources/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
    assert.equal(b2.status, 201, JSON.stringify(b2.body));
    g.release();
    await started.done.p;
    resolver.setImportSourceRevalidateHoldForTests(null);
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "binding_ended"], JSON.stringify(row));
    assert.equal((await candidatesOf(o.teamId)).length, 0);
    assert.equal((await runCheck(o)).status, "succeeded", "the next check runs through binding B");
  }
  // (c) the legacy path is re-validated too: a binding created mid-run stops it.
  {
    const o = await org();
    useSource();
    const conn = await verifiedConnection(o);
    const listGate = gate();
    const legacy = legacyFake(o.sourceTeamId, { listGate });
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => legacy.list === 1);
    const b = await api(`/sources/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    listGate.release();
    await started.done.p;
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "binding_started"], JSON.stringify(row));
    assert.equal(legacy.bundle, 0, "no bundle read through the environment token after the binding appeared");
    assert.equal((await candidatesOf(o.teamId)).length, 0);
    legacyTrap();
    src.serve(o.sourceTeamId);
    assert.equal((await runCheck(o)).status, "succeeded", "the next check reads through the binding");
  }
  // (d) progress per request inside one bundle.
  {
    const o = await org();
    useSource();
    await bound(o);
    legacyTrap();
    src.serve(o.sourceTeamId);
    src.state.gates.athletes = gate();
    src.state.gates.track = gate();
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => src.calls.some((c) => c.key.includes("/athlete_session/?teamsession=")));
    await new Promise((r) => setTimeout(r, 60));
    const t1 = (await q(`select heartbeat_at from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0].heartbeat_at;
    src.state.gates.athletes.release();
    await waitFor(() => src.calls.some((c) => c.key.startsWith("/rest/v1/track/")));
    await new Promise((r) => setTimeout(r, 60));
    const t2 = (await q(`select heartbeat_at from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0].heartbeat_at;
    assert.ok(new Date(t2).getTime() > new Date(t1).getTime(), `the heartbeat advanced between two requests of one bundle (${t1} → ${t2})`);
    src.state.gates.track.release();
    await started.done.p;
    assert.equal((await q(`select status from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0].status, "succeeded");
  }
  // (e) an auto_invalidate whose COMMIT never answers.
  {
    const o = await org();
    useSource();
    const { conn } = await bound(o);
    legacyTrap();
    src.serve(o.sourceTeamId);
    src.state.faults.listStatus = 401;
    resolver.setImportSourceAutoInvalidateCommitFaultForTests(() => new Promise(() => {}));
    const t0 = Date.now();
    const row = await runCheck(o);
    assert.deepEqual([row.status, row.error_code], ["failed", "source_auth_rejected"], JSON.stringify(row));
    assert.ok(Date.now() - t0 < resolver.AUTO_INVALIDATE_BOUND_MS + 10_000, "the check's outcome was not held beyond the bound");
    resolver.setImportSourceAutoInvalidateCommitFaultForTests(null);
    assert.equal((await connRow(conn.id)).state, "verified", "an unconfirmed invalidation changed nothing");
    assert.equal((await auditOf(conn.id)).filter((a) => a.action === "auto_invalidate").length, 0);
    await waitFor(() => appPool.totalCount === appPool.idleCount && appPool.waitingCount === 0, 10_000);
    const again = await runCheck(o);
    assert.deepEqual([again.status, again.error_code], ["failed", "source_auth_rejected"]);
    assert.deepEqual(await connRow(conn.id), { state: "needs_reconnect", last_error_code: "source_auth_rejected" });
    assert.equal((await auditOf(conn.id)).filter((a) => a.action === "auto_invalidate").length, 1, "the next refused check invalidates normally");
  }
  // (f) the check-start COMMIT: landed but unanswered → the row is found and the check runs; never landed → 503, and the next start is free.
  {
    const o = await org();
    useSource();
    await bound(o);
    legacyTrap();
    src.serve(o.sourceTeamId);
    // A plain start first: a confirmed COMMIT is never verified again and never logged as unconfirmed.
    const logPlain = logLines.length;
    assert.equal((await runCheck(o)).status, "succeeded");
    assert.equal(logLines.slice(logPlain).filter((l) => /COMMIT of its start was not confirmed/.test(l)).length, 0, "no false not-confirmed line after a confirmed COMMIT");
    importer.setCheckStartCommitFaultForTests(async (client) => { await client.query("commit"); await new Promise(() => {}); });
    const logLanded = logLines.length;
    const landed = await runCheck(o);
    importer.setCheckStartCommitFaultForTests(null);
    assert.equal(landed.status, "succeeded", JSON.stringify(landed));
    assert.equal(logLines.slice(logLanded).filter((l) => /COMMIT of its start was not confirmed, but the row exists/.test(l)).length, 1, "the unanswered-but-landed case is logged once");
    importer.setCheckStartCommitFaultForTests(() => new Promise(() => {}));
    const before = (await q(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [o.teamId]))[0].n;
    const r = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.coach.cookie, body: { from: DAY, to: DAY } });
    importer.setCheckStartCommitFaultForTests(null);
    assert.deepEqual([r.status, r.body.error], [503, "check_outcome_unknown"], JSON.stringify(r.body));
    assert.ok(!/nothing was written/i.test(r.body.message), "never 'nothing was written' after a sent COMMIT");
    assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [o.teamId]))[0].n, before, "the row was not committed");
    await waitFor(() => appPool.totalCount === appPool.idleCount && appPool.waitingCount === 0, 10_000);
    assert.equal((await runCheck(o)).status, "succeeded", "the next start is not check_already_running");
  }
  // (h) a 401 for the OLD credential after a Reconnect inside one bundle: the run's auto-invalidation is conditional on the
  //     fingerprint of the credential it held, so the FRESH credential stays verified and no audit row is written.
  {
    const o = await org();
    useSource();
    const { conn } = await bound(o);
    legacyTrap();
    src.serve(o.sourceTeamId);
    src.state.gates.track = gate();
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => src.calls.some((c) => c.key.startsWith("/rest/v1/track/")));
    const re = await api(`/sources/gpexe/connections/${conn.id}/reconnect`, { method: "POST", cookie: o.cadmin.cookie, body: { username: USERNAME, password: PASSWORD, confirmation: { sourceSystem: "gpexe", ownerClubId: o.clubId, affectedTeamCount: 1 } }, allowed: [SOURCE_TEAM_NAME_MARKER] });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    src.state.faults.refuseAllReads = true;
    src.state.gates.track.release();
    await started.done.p;
    src.state.faults.refuseAllReads = false;
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "source_auth_rejected"], JSON.stringify(row));
    assert.equal((await connRow(conn.id)).state, "verified", "the fresh credential is never invalidated by a stale 401");
    assert.equal((await auditOf(conn.id)).filter((a) => a.action === "auto_invalidate").length, 0);
    assert.equal((await candidatesOf(o.teamId)).length, 0);
  }
  // (i) the post-read re-validation: a bundle read across the end of its binding is dropped, never recorded.
  {
    const o = await org();
    useSource();
    const { conn, binding } = await bound(o);
    legacyTrap();
    src.serve(o.sourceTeamId);
    // Re-validations in order: list-pre (1), list-post (2), bundle-pre (3), bundle-post (4).
    const g = gate(); let holds = 0;
    resolver.setImportSourceRevalidateHoldForTests(async () => { holds += 1; if (holds === 4) await g.p; });
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => holds === 4);
    assert.ok(importReads().some((c) => c.key.includes("/details/")), "the bundle was read before the hold");
    const u = await unbind(o, conn, binding);
    assert.equal(u.status, 200, JSON.stringify(u.body));
    g.release();
    await started.done.p;
    resolver.setImportSourceRevalidateHoldForTests(null);
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "binding_ended"], JSON.stringify(row));
    assert.equal((await candidatesOf(o.teamId)).length, 0, "a bundle read across the end of its binding is not recorded");
  }
  // (j) a pool checkout that arrives after the auto-invalidation's bound is released, never leaked; the check's outcome stands.
  {
    const o = await org();
    useSource();
    const { conn } = await bound(o);
    legacyTrap();
    src.serve(o.sourceTeamId);
    src.state.faults.listStatus = 401;
    resolver.setImportSourceAutoInvalidateBoundForTests(100);
    const originalConnect = appPool.connect;
    appPool.connect = function slowConnect(...args) {
      if (typeof args[0] === "function") return originalConnect.apply(this, args);
      return new Promise((resolve, reject) => setTimeout(() => originalConnect.apply(this, args).then(resolve, reject), 400));
    };
    let row;
    try {
      row = await runCheck(o);
    } finally {
      appPool.connect = originalConnect;
      resolver.setImportSourceAutoInvalidateBoundForTests(null);
    }
    assert.deepEqual([row.status, row.error_code], ["failed", "source_auth_rejected"], JSON.stringify(row));
    assert.equal((await connRow(conn.id)).state, "verified", "the invalidation did not happen within its bound");
    assert.equal((await auditOf(conn.id)).filter((a) => a.action === "auto_invalidate").length, 0);
    await new Promise((r) => setTimeout(r, 600));
    await waitFor(() => appPool.totalCount === appPool.idleCount && appPool.waitingCount === 0, 10_000);
    assert.equal(appPool.totalCount, appPool.idleCount, "the late checkout was released, not leaked");
    assert.deepEqual([(await runCheck(o)).status, (await connRow(conn.id)).state], ["failed", "needs_reconnect"], "with the bound back the next refused check invalidates normally");
  }
  // (k) the legacy path's post-read check: a binding that lands during a legacy bundle read drops that bundle.
  {
    const o = await org();
    useSource();
    const conn = await verifiedConnection(o);
    const bundleGate = gate();
    const legacy = legacyFake(o.sourceTeamId, { bundleGate });
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => legacy.bundle === 1);
    const b = await api(`/sources/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    bundleGate.release();
    await started.done.p;
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "binding_started"], JSON.stringify(row));
    assert.equal((await candidatesOf(o.teamId)).length, 0, "a legacy bundle read across the appearance of a binding is not recorded");
  }
  // (g) an approved pair stored with a leading zero (accepted by the Settings route and by the bind) imports normally.
  {
    const o = await org({ leadingZero: true });
    useSource();
    await bound(o);
    legacyTrap();
    src.serve(o.sourceTeamId);
    const row = await runCheck(o);
    assert.equal(row.status, "succeeded", JSON.stringify(row));
    assert.equal(row.gpexe_team_id, `0${o.sourceTeamId}`, "the check row keeps the stored value");
    assert.ok(importReads().some((c) => c.key.includes(`team=${o.sourceTeamId}`)), "the adapter is bound to the canonical id");
  }
});

test("13. the facts are re-validated after a list too, empty or not: a binding ended while an EMPTY list was in flight → binding_ended, not a succeeded check; a credential replaced while an empty list was in flight → connection_credential_changed; a binding created while a legacy empty list was in flight → binding_started; in every case no candidate, no further read and no fallback", async () => {
  // (a) binding path, empty list, Unbind during the list.
  {
    const o = await org();
    useSource();
    const { conn, binding } = await bound(o);
    process.env.GPEXE_API_TOKEN = ENV_TOKEN;
    legacyTrap();
    src.serve(o.sourceTeamId);
    src.state.faults.emptyList = true;
    src.state.gates.list = gate();
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => src.calls.some((c) => c.key.includes("start_timestamp_gte")));
    assert.equal((await unbind(o, conn, binding)).status, 200);
    const readsBefore = importReads().length;
    src.state.gates.list.release();
    await started.done.p;
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "binding_ended"], JSON.stringify(row));
    assert.equal(importReads().length, readsBefore, "nothing more was read");
    assert.equal((await candidatesOf(o.teamId)).length, 0);
    assert.ok(src.calls.every((c) => c.auth !== "ENV"));
  }
  // (b) binding path, empty list, Reconnect during the list.
  {
    const o = await org();
    useSource();
    const { conn } = await bound(o);
    legacyTrap();
    src.serve(o.sourceTeamId);
    src.state.faults.emptyList = true;
    src.state.gates.list = gate();
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => src.calls.some((c) => c.key.includes("start_timestamp_gte")));
    const re = await api(`/sources/gpexe/connections/${conn.id}/reconnect`, { method: "POST", cookie: o.cadmin.cookie, body: { username: USERNAME, password: PASSWORD, confirmation: { sourceSystem: "gpexe", ownerClubId: o.clubId, affectedTeamCount: 1 } }, allowed: [SOURCE_TEAM_NAME_MARKER] });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    src.state.gates.list.release();
    await started.done.p;
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "connection_credential_changed"], JSON.stringify(row));
    assert.equal((await candidatesOf(o.teamId)).length, 0);
    assert.equal((await connRow(conn.id)).state, "verified");
  }
  // (c) legacy path, empty list, a binding appears during the list.
  {
    const o = await org();
    useSource();
    const conn = await verifiedConnection(o);
    const listGate = gate();
    const legacy = legacyFake(o.sourceTeamId, { listGate, emptyList: true });
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => legacy.list === 1);
    const b = await api(`/sources/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    listGate.release();
    await started.done.p;
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "binding_started"], JSON.stringify(row));
    assert.equal(legacy.bundle, 0);
    assert.equal((await candidatesOf(o.teamId)).length, 0);
  }
});

test("14. the legacy path is open only to a team that never had a source binding: no history → legacy; after an Unbind → 409 source_connection_unavailable / binding_ended with the legacy factory never called and the environment token never read; a new binding → the source-connection path again; an unusable ACTIVE binding never falls back either", async () => {
  const o = await org();
  useSource();
  const legacy = legacyFake(o.sourceTeamId);
  assert.equal((await runCheck(o)).status, "succeeded", "no history: the legacy path");
  assert.equal(legacy.factory, 1);
  const { conn, binding } = await bound(o);
  assert.equal((await unbind(o, conn, binding)).status, 200);
  process.env.GPEXE_API_TOKEN = ENV_TOKEN;
  legacyTrap();
  for (let i = 0; i < 2; i += 1) {
    const r = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.padmin.cookie, body: { from: DAY, to: DAY } });
    assert.deepEqual([r.status, r.body.error, r.body.reason], [409, "source_connection_unavailable", "binding_ended"], JSON.stringify(r.body));
  }
  assert.ok(src.calls.every((c) => c.auth !== "ENV"));
  assert.equal(importReads().length, 0);
  const again = await api(`/sources/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  src.serve(o.sourceTeamId);
  assert.equal((await runCheck(o)).source_path, "source_connection");
  await q(`update training_load.source_credential_connections set state = 'needs_reconnect', last_error_code = 'source_auth_rejected', last_error_at = now() where id = $1`, [conn.id]);
  const unusable = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.padmin.cookie, body: { from: DAY, to: DAY } });
  assert.deepEqual([unusable.status, unusable.body.reason], [409, "connection_not_usable"]);
  assert.ok(src.calls.every((c) => c.auth !== "ENV"), "an unusable active binding never falls back to the environment token");
});

test("15. both paths pin the team's club: a legacy team moved to another club during a held list stops with team_club_changed (no candidate, no bundle read); a legacy team whose club is archived during a held bundle stops with team_not_available (nothing recorded); the database refuses to move a BOUND team (the v27 backstop, proven); a bound team whose club is archived during a run stops with team_not_available", async () => {
  // (a) legacy team moved during the list.
  {
    const o = await org({ bare: true });
    useSource();
    const listGate = gate();
    const legacy = legacyFake(o.sourceTeamId, { listGate });
    const otherClub = (await q(`insert into public.clubs (name) values ('Other club') returning id`))[0].id;
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => legacy.list === 1);
    await q(`update public.teams set club_id = $2 where id = $1`, [o.teamId, otherClub]);
    listGate.release();
    await started.done.p;
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "team_club_changed"], JSON.stringify(row));
    assert.equal(legacy.bundle, 0, "no bundle read after the move");
    assert.equal((await candidatesOf(o.teamId)).length, 0);
  }
  // (b) legacy team's club archived during the bundle.
  {
    const o = await org();
    useSource();
    const bundleGate = gate();
    const legacy = legacyFake(o.sourceTeamId, { bundleGate });
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => legacy.bundle === 1);
    await q(`update public.clubs set is_active = false where id = $1`, [o.clubId]);
    bundleGate.release();
    await started.done.p;
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "team_not_available"], JSON.stringify(row));
    assert.equal((await candidatesOf(o.teamId)).length, 0, "the bundle read across the archive is not recorded");
    await q(`update public.clubs set is_active = true where id = $1`, [o.clubId]);
  }
  // (c) a bound team cannot be moved: the v27 backstop, proven, not assumed (a bare team, so no membership FK answers first).
  {
    const o = await org({ bare: true });
    useSource();
    await bound(o);
    legacyTrap();
    src.serve(o.sourceTeamId);
    const otherClub = (await q(`insert into public.clubs (name) values ('Other club B') returning id`))[0].id;
    const moved = await q(`update public.teams set club_id = $2 where id = $1`, [o.teamId, otherClub]).then(() => null, (e) => e);
    assert.ok(moved, "the move of a bound team is refused by the database");
    assert.match(String(moved.message), /bound|binding/i, `the v27 move guard, not a foreign key: ${moved.message}`);
    assert.equal(String((await q(`select club_id from public.teams where id = $1`, [o.teamId]))[0].club_id), String(o.clubId), "the team stays in its club");
    assert.equal((await runCheck(o)).status, "succeeded");
  }
  // (d) a bound team's club archived during a held bundle.
  {
    const o = await org();
    useSource();
    await bound(o);
    legacyTrap();
    src.serve(o.sourceTeamId);
    const g = gate(); let holds = 0;
    resolver.setImportSourceRevalidateHoldForTests(async () => { holds += 1; if (holds === 4) await g.p; });
    const started = await startCheck(o);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(() => holds === 4);
    await q(`update public.clubs set is_active = false where id = $1`, [o.clubId]);
    g.release();
    await started.done.p;
    resolver.setImportSourceRevalidateHoldForTests(null);
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [started.body.check.id]))[0];
    assert.deepEqual([row.status, row.error_code], ["failed", "team_not_available"], JSON.stringify(row));
    assert.equal((await candidatesOf(o.teamId)).length, 0);
    await q(`update public.clubs set is_active = true where id = $1`, [o.clubId]);
  }
});

test("16. migration v31 applies on v30 (five columns, one CHECK, two triggers and their functions), backfills every earlier row as legacy_env with nulls by its default, makes the database refuse a connection-path row whose binding is ended / of another team / of another connection / of another source team or whose host key is not the connection's, refuses the mixed shapes (23514), keeps the five columns final (a raw UPDATE refused), rolls back to exactly the v30 catalog, applies again, refuses to roll back under a later migration and while a source-connection row exists, and a file that fails at its last statement applies nothing", async () => {
  const m = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v31mig", migrations: UP_TO_V30 });
  const k = new pg.Client({ connectionString: m.url });
  await k.connect();
  try {
    assert.equal((await k.query("select current_database() as db")).rows[0].db, m.name);
    const catalog = async () => ({
      columns: (await k.query(`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_checks' order by ordinal_position`)).rows,
      constraints: (await k.query(`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'training_load.gpexe_import_checks'::regclass order by 1`)).rows,
      triggers: (await k.query(`select tgname, pg_get_triggerdef(oid) as def from pg_trigger where tgrelid = 'training_load.gpexe_import_checks'::regclass and not tgisinternal order by 1`)).rows,
      functions: (await k.query(`select p.proname, md5(pg_get_functiondef(p.oid)) as digest from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname like '%gpexe_check%' order by 1`)).rows,
    });
    const v30 = await catalog();
    assert.ok(!v30.columns.some((c) => c.column_name === "source_path"));
    // Fixture written BEFORE v31: a club, a team with its approved pair, a user, and one check row from the legacy era.
    const club = (await k.query(`insert into public.clubs (name) values ('C') returning id`)).rows[0].id;
    const team = (await k.query(`insert into public.teams (club_id, name) values ($1, 'T') returning id`, [club])).rows[0].id;
    const team2 = (await k.query(`insert into public.teams (club_id, name) values ($1, 'T2') returning id`, [club])).rows[0].id;
    const user = (await k.query(`insert into public.users (email) values ('u@test.local') returning id`)).rows[0].id;
    await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, '981', $2)`, [team, user]);
    await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, '982', $2)`, [team2, user]);
    const oldRow = (await k.query(`insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id) values ($1, $2, 'succeeded', '2026-09-01', '2026-09-01', now(), '981') returning id`, [team, user])).rows[0].id;
    await applyGpexeTestMigrations(m.url, [...UP_TO_V30, V31]);
    const v31 = await catalog();
    assert.deepEqual(v31.columns.filter((c) => c.column_name.startsWith("source_")).map((c) => [c.column_name, c.is_nullable]), [["source_path", "NO"], ["source_connection_id", "YES"], ["source_binding_id", "YES"], ["source_team_id", "YES"], ["source_host_key", "YES"]]);
    assert.ok(v31.constraints.some((c) => c.conname === "gpexe_import_checks_source_path_facts"));
    assert.match(v31.constraints.find((c) => c.conname === "gpexe_import_checks_source_host_key_format").def, /\[a-z0-9\]\[a-z0-9_-\]\{0,30\}/, "the host-key format is the catalog's own (v27), not a stricter one");
    assert.deepEqual(v31.triggers.filter((t) => /source/.test(t.tgname)).map((t) => t.tgname), ["gpexe_import_checks_freeze_source", "gpexe_import_checks_source_facts"]);
    const backfilled = (await k.query(`select source_path, source_connection_id, source_binding_id, source_team_id, source_host_key from training_load.gpexe_import_checks where id = $1`, [oldRow])).rows[0];
    assert.deepEqual(backfilled, { source_path: "legacy_env", source_connection_id: null, source_binding_id: null, source_team_id: null, source_host_key: null }, "every earlier row is the legacy path by default");
    // A connection and an active binding of the approved pair (team ↔ 981), for the guards.
    const parts = cryptoMod.encryptCredential(TOKEN, { connectionId: "00000000-0000-0000-0000-000000000001", ownerScope: "club", ownerClubId: club, ownerTeamId: null, sourceSystem: "gpexe", hostKey: "server3", credentialKind: "exchanged_token" }, cryptoMod.parseKeyring(process.env.SOURCE_CREDENTIAL_KEYS));
    const connId = (await k.query(
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state, credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','club',$1,'server3','L','exchanged_token',$2,'verified',$3,$4,$5,$6, now()) returning id`,
      [club, user, parts.ciphertext, parts.nonce, parts.authTag, parts.keyVersion],
    )).rows[0].id;
    const connId2 = (await k.query(
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state, credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','club',$1,'server3','L2','exchanged_token',$2,'verified',$3,$4,$5,$6, now()) returning id`,
      [club, user, parts.ciphertext, parts.nonce, parts.authTag, parts.keyVersion],
    )).rows[0].id;
    const bindingId = (await k.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1, $2, 'gpexe', '981', $3, $1) returning id`, [team, connId, user])).rows[0].id;
    const binding2 = (await k.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1, $2, 'gpexe', '982', $3, $1) returning id`, [team2, connId, user])).rows[0].id;
    const insertCheck = (over = {}) => {
      const v = { team, path: "source_connection", conn: connId, binding: bindingId, sourceTeam: "981", host: "server3", gpexe: "981", ...over };
      return k.query(`insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id, source_path, source_connection_id, source_binding_id, source_team_id, source_host_key)
                      values ($1, $2, 'succeeded', '2026-09-02', '2026-09-02', now(), $3, $4, $5, $6, $7, $8) returning id`, [v.team, user, v.gpexe, v.path, v.conn, v.binding, v.sourceTeam, v.host]);
    };
    const refused = async (over, pattern) => { const e = await insertCheck(over).then(() => null, (err) => err); assert.ok(e, `refused: ${JSON.stringify(over)}`); assert.match(String(e.message), pattern); };
    // Round 5: a legacy row only for a team that NEVER had a gpexe binding — refused for the two bound teams (SQLSTATE 23514,
    // the named constraint), accepted for a third team that was never bound.
    const team3 = (await k.query(`insert into public.teams (club_id, name) values ($1, 'T3') returning id`, [club])).rows[0].id;
    await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, '983', $2)`, [team3, user]);
    const legacyRow = (over = {}) => insertCheck({ path: "legacy_env", conn: null, binding: null, sourceTeam: null, host: null, gpexe: "983", team: team3, ...over });
    const refusedLegacy = async (over) => {
      const e = await legacyRow(over).then(() => null, (err) => err);
      assert.ok(e, `legacy refused: ${JSON.stringify(over)}`);
      assert.deepEqual([e.code, e.constraint], ["23514", "gpexe_import_checks_legacy_path_never_bound"], String(e.message));
      assert.match(String(e.message), /environment token/);
    };
    await refusedLegacy({ team, gpexe: "981" });
    await refusedLegacy({ team: team2, gpexe: "982" });
    const neverBound = (await legacyRow()).rows[0].id;
    assert.equal((await k.query(`select source_path from training_load.gpexe_import_checks where id = $1`, [neverBound])).rows[0].source_path, "legacy_env");
    await refused({ binding: binding2 }, /another team/);
    await refused({ conn: connId2 }, /other than its binding/);
    await refused({ sourceTeam: "982" }, /source team other than its binding/);
    await refused({ host: "e03" }, /host key other than its connection/);
    await refused({ binding: "00000000-0000-0000-0000-00000000dead" }, /does not exist|violates foreign key/);
    await refused({ path: "legacy_env", team: team3, gpexe: "983" }, /source_path_facts/);
    await refused({ path: "legacy_env" }, /source_path_facts|environment token/);
    // (the row trigger fires before the CHECK: a connection-path row without a binding is refused by whichever answers first)
    await refused({ conn: null, binding: null, sourceTeam: null, host: null }, /source_path_facts|does not exist/);
    await refused({ sourceTeam: "0981" }, /source team other than its binding/);
    // Mixed shapes and formats (on the never-bound team, so the CHECK itself answers, not the legacy guard).
    await refused({ path: "legacy_env", team: team3, gpexe: "983", binding: null, conn: null, sourceTeam: null, host: "server3" }, /source_path_facts/);
    await refused({ host: "Server3" }, /source_host_key_format|host key other/);
    // Before any connection-path row exists: the rollback runs, and the atomicity of the file holds.
    const rollbackSql = await fsp.readFile(V31_ROLLBACK, "utf8");
    await k.query(rollbackSql);
    assert.deepEqual(await catalog(), v30, "the rollback leaves exactly the v30 columns, constraints, triggers and functions of the checks table");
    assert.equal((await k.query(`select count(*)::int as n from public.schema_migrations where migration_name like $1`, [`%${V31}`])).rows[0].n, 0);
    assert.equal((await k.query(`select count(*)::int as n from training_load.gpexe_import_checks`)).rows[0].n, 2, "no row lost (the legacy-era row and the never-bound team's row)");
    const sql = await fsp.readFile(path.resolve(ROOT, "migrations_v2", V31), "utf8");
    assert.doesNotMatch(sql.replace(/[$][$][^]*?[$][$]/g, "<body>"), /https?:\/\/|SOURCE_CREDENTIAL_KEYS|^\s*(begin|commit|rollback)\b/im, "no URL, key or transaction control outside the function bodies");
    await k.query("begin");
    await assert.rejects(k.query(`${sql}\nselect 1/0;`), /division by zero/);
    await k.query("rollback");
    assert.deepEqual(await catalog(), v30, "nothing of the failed file was applied");
    await applyGpexeTestMigrations(m.url, [...UP_TO_V30, V31]);
    assert.deepEqual(await catalog(), v31, "v31 applies again, identically");
    // A correct connection-path row is accepted, is final, and is evidence the rollback refuses to erase.
    const good = (await insertCheck()).rows[0].id;
    await assert.rejects(k.query(`update training_load.gpexe_import_checks set source_host_key = 'e03' where id = $1`, [good]), /credential path of check .* is final/);
    await assert.rejects(k.query(`update training_load.gpexe_import_checks set source_path = 'legacy_env', source_connection_id = null, source_binding_id = null, source_team_id = null, source_host_key = null where id = $1`, [good]), /credential path of check .* is final/);
    await k.query(`update training_load.gpexe_import_checks set sessions_seen = 3 where id = $1`, [good]);
    // An ended binding is refused for a NEW row, while the earlier row keeps pointing at it (history).
    await k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'test' where id = $1`, [bindingId, user]);
    await refused({}, /not active/);
    // Round 5: after the binding ended the team has history — a legacy row stays refused; the never-bound team still writes one.
    await refusedLegacy({ team, gpexe: "981" });
    await legacyRow();
    await assert.rejects(k.query(rollbackSql), /v31 rollback refused: 1 check row\(s\) record a source-connection read/);
    await k.query("rollback").catch(() => {});
    assert.deepEqual(await catalog(), v31, "a refused rollback drops nothing");
    await k.query("begin");
    await k.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ('migrations_v2/209901010000_test_only_later.sql', repeat('0', 64), 0, 'test')`);
    await assert.rejects(k.query(rollbackSql), /v31 rollback refused: later migrations are applied/);
    await k.query("rollback").catch(() => {});
    assert.deepEqual(await catalog(), v31);
  } finally {
    await k.end();
    await m.drop();
  }
});

test("17. the database refuses the legacy path to a team with any gpexe binding, whoever writes the row, serialized by the one team import lock in both orders: a legacy check INSERT held open makes a bind try-lock-refused (try_again) and after its COMMIT the bind succeeds with the earlier legacy row kept as history; a binding INSERT held open makes a raw legacy INSERT try-lock-refused, and after its COMMIT the same INSERT is refused by the v31 guard (23514 gpexe_import_checks_legacy_path_never_bound); after an Unbind through the API a raw legacy INSERT stays refused while the application answers binding_ended", async () => {
  const o = await org();
  useSource();
  const conn = await verifiedConnection(o);
  process.env.GPEXE_API_TOKEN = ENV_TOKEN;
  const user = o.padmin.id;
  const a = new pg.Client({ connectionString: db.url });
  const b = new pg.Client({ connectionString: db.url });
  await a.connect();
  await b.connect();
  const legacyInsert = (c, teamId, sourceTeamId) => c.query(
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id)
     values ($1, $2, 'succeeded', $3, $3, now(), $4) returning id`, [teamId, user, DAY, sourceTeamId]);
  const bindBody = (teamId, sourceTeamId) => ({ method: "POST", cookie: o.cadmin.cookie, body: { teamId, sourceTeamId } });
  try {
    // Order 1: the legacy INSERT holds the team lock → the bind is refused at once (try_again, nothing bound); after the
    // COMMIT the bind succeeds, and the row from before the binding stays as history.
    await a.query("begin");
    const legacyId = (await legacyInsert(a, o.teamId, o.sourceTeamId)).rows[0].id;
    const bindWhileHeld = await api(`/sources/gpexe/connections/${conn.id}/bindings`, bindBody(o.teamId, o.sourceTeamId));
    assert.deepEqual([bindWhileHeld.status, bindWhileHeld.body.error], [409, "try_again"], JSON.stringify(bindWhileHeld.body));
    assert.equal((await q(`select count(*)::int as n from training_load.source_team_bindings where team_id = $1`, [o.teamId]))[0].n, 0);
    await a.query("commit");
    const bind = await api(`/sources/gpexe/connections/${conn.id}/bindings`, bindBody(o.teamId, o.sourceTeamId));
    assert.equal(bind.status, 201, JSON.stringify(bind.body));
    assert.equal((await q(`select source_path from training_load.gpexe_import_checks where id = $1`, [legacyId]))[0].source_path, "legacy_env", "the row from before the binding stays as history");
    // With the binding active a raw legacy INSERT is refused by the database (the application takes the connection path).
    const whileBound = await legacyInsert(a, o.teamId, o.sourceTeamId).then(() => null, (e) => e);
    assert.deepEqual([whileBound?.code, whileBound?.constraint], ["23514", "gpexe_import_checks_legacy_path_never_bound"], String(whileBound?.message));
    // Order 2 (a second team of the same club): the binding INSERT holds the team lock → the raw legacy INSERT is
    // try-lock-refused (v24, before any read of the facts); after the COMMIT the same INSERT is refused by the v31 guard.
    const team2 = (await q(`insert into public.teams (club_id, name) values ($1, $2) returning id`, [o.clubId, `T2-${uid()}`]))[0].id;
    const sourceTeam2 = String(nextSourceTeam++);
    visibleTeams.add(Number(sourceTeam2));
    assert.equal((await api(`/gpexe/teams/${team2}/settings`, { method: "PUT", cookie: o.padmin.cookie, body: { gpexeTeamId: sourceTeam2 } })).status, 200);
    await b.query("begin");
    await b.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1, $2, 'gpexe', $3, $4, $1)`, [team2, conn.id, sourceTeam2, user]);
    const whileHeld = await legacyInsert(a, team2, sourceTeam2).then(() => null, (e) => e);
    assert.ok(whileHeld, "refused while the binding INSERT holds the team lock");
    assert.match(String(whileHeld.message), /is running for team .*\(check\)/, "v24's own trigger answers first");
    // The v31 trigger holds the team's import try-lock ITSELF: with v24's trigger disabled for one statement the same
    // refusal comes from the v31 function ("check source"), so the guard never depends on another trigger's lock.
    await a.query(`alter table training_load.gpexe_import_checks disable trigger gpexe_import_checks_require_team`);
    let ownLock;
    try {
      ownLock = await legacyInsert(a, team2, sourceTeam2).then(() => null, (e) => e);
    } finally {
      await a.query(`alter table training_load.gpexe_import_checks enable trigger gpexe_import_checks_require_team`);
    }
    assert.ok(ownLock, "refused by the v31 trigger's own try-lock");
    assert.match(String(ownLock.message), /is running for team .*\(check source\)/);
    assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [team2]))[0].n, 0);
    await b.query("commit");
    const afterCommit = await legacyInsert(a, team2, sourceTeam2).then(() => null, (e) => e);
    assert.deepEqual([afterCommit?.code, afterCommit?.constraint], ["23514", "gpexe_import_checks_legacy_path_never_bound"], String(afterCommit?.message));
    assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [team2]))[0].n, 0, "no legacy row for a team bound meanwhile");
    // After an Unbind through the API the team has history: the raw legacy INSERT stays refused, and the application
    // answers binding_ended (an administrator's view) without calling the legacy factory.
    assert.equal((await unbind(o, conn, bind.body.result.binding)).status, 200);
    const afterUnbind = await legacyInsert(a, o.teamId, o.sourceTeamId).then(() => null, (e) => e);
    assert.deepEqual([afterUnbind?.code, afterUnbind?.constraint], ["23514", "gpexe_import_checks_legacy_path_never_bound"], String(afterUnbind?.message));
    legacyTrap();
    const started = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie: o.padmin.cookie, body: { from: DAY, to: DAY } });
    assert.deepEqual([started.status, started.body.error, started.body.reason], [409, "source_connection_unavailable", "binding_ended"], JSON.stringify(started.body));
    assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [o.teamId]))[0].n, 1, "only the row from before the binding");
  } finally {
    await a.query("rollback").catch(() => {});
    await b.query("rollback").catch(() => {});
    await a.end();
    await b.end();
  }
});

test("18. the import switch off - unset and explicitly 'false' - never touches a check: a connection-backed check reads only through the binding (the legacy factory a trap, the environment token never sent), succeeds and saves its check row, candidate, preview and snapshot; no other table of the training / training_load schemas gains a row; approving one candidate and the batch both answer 409 import_switch_off with nothing written; a source read that fails leaves the check failed with its own code, which the status reports apart from the switch's sentence", async () => {
  // Every base table of the two schemas is measured, except what a check may
  // write - so a table the writer or the materialize function gains later is
  // covered without editing this list.
  const CHECK_MAY_WRITE = new Set(["training_load.gpexe_import_checks", "training_load.gpexe_import_candidates", "training_load.gpexe_retention_runs"]);
  const measured = (await q(
    `select table_schema || '.' || table_name as t from information_schema.tables
      where table_schema in ('training', 'training_load') and table_type = 'BASE TABLE' order by 1`,
  )).map((r) => r.t).filter((t) => !CHECK_MAY_WRITE.has(t));
  for (const t of ["training_load.metric_events", "training_load.metric_values", "training_load.metric_source_identities", "training_load.metric_definitions",
    "training_load.gpexe_import_approvals", "training.activities", "training.activity_participants", "training.activity_metric_event_links",
    "training.activity_component_metric_segment_links", "training.activity_source_observations"]) {
    assert.ok(measured.includes(t), `the measured set includes ${t}`);
  }
  const importRows = async () => {
    const out = {};
    for (const t of measured) {
      const [schema, table] = t.split(".");
      out[t] = (await q(`select count(*)::int as n from ${schema}.${table}`))[0].n;
    }
    return out;
  };
  for (const switchValue of [undefined, "false"]) {
    if (switchValue === undefined) delete process.env.GPEXE_IMPORT_APPLY_ENABLED; else process.env.GPEXE_IMPORT_APPLY_ENABLED = switchValue;
    try {
      const o = await org();
      useSource();
      const { conn, binding } = await bound(o);
      process.env.GPEXE_API_TOKEN = ENV_TOKEN;
      legacyTrap();
      src.serve(o.sourceTeamId);
      const before = await importRows();

      const row = await runCheck(o);
      assert.equal(row.status, "succeeded", `switch ${switchValue ?? "unset"}: ${JSON.stringify(row)}`);
      assert.equal(row.error_code, null);
      assert.deepEqual([row.source_path, row.source_connection_id, row.source_binding_id], ["source_connection", conn.id, binding.bindingId], "pinned to the connection, never the environment token");
      const saved = await q(`select id, status, preview is not null as has_preview, preview_hash, raw_bundle is not null as has_snapshot from training_load.gpexe_import_candidates where owner_team_id = $1`, [o.teamId]);
      assert.equal(saved.length, 1);
      assert.ok(saved[0].has_preview && saved[0].preview_hash && saved[0].has_snapshot, "the check saved its candidate, preview and snapshot");
      assert.deepEqual(await importRows(), before, "the check wrote nothing of an import (its preview is a rolled-back dry run)");
      assert.ok(src.calls.every((c) => c.auth !== "ENV"), "the environment token never reached the source");

      // The status reports the check and the switch apart.
      const st = await api(`/gpexe/teams/${o.teamId}/status`, { cookie: o.padmin.cookie });
      assert.equal(st.status, 200);
      assert.deepEqual([st.body.lastCheck.status, st.body.lastCheck.error, st.body.importSwitch.enabled], ["succeeded", null, false]);

      // Approving stays refused while the switch is off: one candidate and the batch, nothing written.
      const list = await api(`/gpexe/teams/${o.teamId}/candidates`, { cookie: o.padmin.cookie });
      assert.equal(list.status, 200);
      const cand = list.body.candidates[0];
      assert.ok(cand.approvalBlockers.includes("import_switch_off"));
      const one = await api(`/gpexe/teams/${o.teamId}/candidates/${cand.id}/approve`, { method: "POST", cookie: o.padmin.cookie, body: { previewHash: cand.previewHash, acceptChanges: false } });
      assert.deepEqual([one.status, one.body.error], [409, "import_switch_off"]);
      const batch = await api(`/gpexe/teams/${o.teamId}/imports`, { method: "POST", cookie: o.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } } });
      assert.deepEqual([batch.status, batch.body.error], [409, "import_switch_off"]);
      assert.deepEqual(await importRows(), before, "a refused approval writes nothing");
      assert.equal((await q(`select status from training_load.gpexe_import_candidates where id = $1`, [cand.id]))[0].status, saved[0].status, "the candidate is unchanged");

      // A source read that fails: the check fails with its own code - never succeeded, never a fallback.
      src.state.faults.listStatus = 500;
      const failed = await runCheck(o);
      assert.equal(failed.status, "failed");
      assert.equal(failed.error_code, "source_unavailable");
      assert.equal(failed.source_path, "source_connection");
      const st2 = await api(`/gpexe/teams/${o.teamId}/status`, { cookie: o.padmin.cookie });
      assert.deepEqual([st2.body.lastCheck.status, st2.body.lastCheck.error?.code], ["failed", "source_unavailable"]);
      assert.notEqual(st2.body.lastCheck.error.message, st2.body.importSwitch.message, "the check's reason is never the switch's sentence");
      assert.deepEqual(await importRows(), before);
      assert.ok(src.calls.every((c) => c.auth !== "ENV"));
    } finally {
      delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
    }
  }
});

test("19. the whole-session details are projected to the consumed fields (the F3c3 pilot's diagnostic): an unconsumed 5-16-key object metric no longer refuses the check - it completes, and that metric is absent from the candidate, its preview and the retained snapshot; a malformed tot_burst_events or tot_brake_events, a dangerous metric key and an invalid players container still fail closed with nothing recorded; the switch off still refuses single and batch approval; the environment token is never sent", async () => {
  const MARKER_METRIC = "markerUnconsumedObjZq";
  const MARKER_TEXT = "Marker free text value";
  const MARKER_NUMBER = 24680.1357;
  const tables = (await q(`select table_schema || '.' || table_name as t from information_schema.tables where table_schema in ('training', 'training_load') and table_type = 'BASE TABLE' and table_name not in ('gpexe_import_checks', 'gpexe_retention_runs') order by 1`)).map((r) => r.t);
  const rows = async () => { const out = {}; for (const t of tables) { const [s, n] = t.split("."); out[t] = (await q(`select count(*)::int as n from ${s}.${n}`))[0].n; } return out; };
  const setup = async (mutate) => {
    const o = await org();
    useSource();
    const { conn } = await bound(o);
    process.env.GPEXE_API_TOKEN = ENV_TOKEN;
    legacyTrap();
    src.serve(o.sourceTeamId);
    const players = structuredClone(src.state.bundle.details.full.players);
    mutate(players);
    src.state.faults.wholePlayers = players;
    return { o, conn, players };
  };

  // (a) The production case: both consumed fields in the documented shape, plus one unconsumed
  // object metric of another shape (8 keys; null, number, short text, other-character text; no unit / value key).
  const unrelated = { k1: null, k2: MARKER_NUMBER, k3: "ok", k4: MARKER_TEXT, k5: 3, k6: null, k7: "a-b", k8: 7 };
  const a = await setup((players) => { for (const id of Object.keys(players)) players[id][MARKER_METRIC] = { ...unrelated }; });
  const row = await runCheck(a.o);
  assert.equal(row.status, "succeeded", JSON.stringify(row));
  assert.deepEqual([row.error_code, row.source_path], [null, "source_connection"]);
  const candidates = await q(`select id, status, preview, preview_hash, raw_bundle from training_load.gpexe_import_candidates where owner_team_id = $1`, [a.o.teamId]);
  assert.equal(candidates.length, 1, "the check completed and recorded its candidate");
  const raw = candidates[0].raw_bundle;
  for (const [id, values] of Object.entries(raw.details.full.players)) {
    assert.deepEqual(Object.keys(values).sort(), ["tot_brake_events", "tot_burst_events"], `athlete ${id}: only the consumed fields are retained`);
    for (const field of ["tot_burst_events", "tot_brake_events"]) assert.deepEqual(Object.keys(values[field]).sort(), ["unit", "value"]);
  }
  const everything = JSON.stringify({ candidates, row });
  for (const leak of [MARKER_METRIC, MARKER_TEXT, String(MARKER_NUMBER), "24680"]) assert.ok(!everything.includes(leak), `${leak} is absent from the candidate, its preview, the snapshot and the check row`);
  assert.ok(candidates[0].preview && candidates[0].preview_hash, "the preview was computed");
  // The switch is off: a successful check / preview is allowed, approving is not.
  const list = await api(`/gpexe/teams/${a.o.teamId}/candidates`, { cookie: a.o.padmin.cookie });
  const cand = list.body.candidates[0];
  const before = await rows();
  const one = await api(`/gpexe/teams/${a.o.teamId}/candidates/${cand.id}/approve`, { method: "POST", cookie: a.o.padmin.cookie, body: { previewHash: cand.previewHash, acceptChanges: false } });
  const batch = await api(`/gpexe/teams/${a.o.teamId}/imports`, { method: "POST", cookie: a.o.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } } });
  assert.deepEqual([one.status, one.body.error, batch.status, batch.body.error], [409, "import_switch_off", 409, "import_switch_off"]);
  assert.deepEqual(await rows(), before, "a refused approval writes nothing");
  assert.ok(src.calls.every((c) => c.auth !== "ENV"), "the environment token never reached the source");

  // (b)-(e) Still refused, nothing recorded: a malformed consumed field, a dangerous key, an invalid container.
  const firstOf = (players) => Object.keys(players)[0];
  const refused = [
    ["tot_burst_events as a list", (p) => { p[firstOf(p)].tot_burst_events = [1, 2]; }, "The source answer to the whole-session details carries a consumed metric in an unknown shape.", "Diagnostic: op=session_details; field=tot_burst_events; kind=array."],
    ["tot_brake_events nested", (p) => { p[firstOf(p)].tot_brake_events = { unit: "number", value: { n: 1 } }; }, "The source answer to the whole-session details carries a consumed metric in an unknown shape.", "Diagnostic: op=session_details; field=tot_brake_events; kind=object."],
    ["a dangerous metric key", (p) => { Object.defineProperty(p[firstOf(p)], "__proto__", { value: 1, enumerable: true, configurable: true, writable: true }); }, "The source answer to the whole-session details names a metric in an unknown way.", "Diagnostic: op=session_details; names=prototype_key."],
    ["an athlete without metric values", (p) => { p[firstOf(p)] = {}; }, "The source answer to the whole-session details has an athlete without metric values.", null],
  ];
  for (const [label, mutate, sentence, diagnostic] of refused) {
    const r = await setup(mutate);
    const beforeRefused = await rows();
    const failed = await runCheck(r.o);
    assert.deepEqual([failed.status, failed.error_code], ["failed", "source_answer_unexpected"], `${label}: ${JSON.stringify(failed)}`);
    assert.ok(failed.error_message.startsWith(sentence), `${label}: ${failed.error_message}`);
    if (diagnostic) assert.ok(failed.error_message.endsWith(diagnostic), `${label}: ${failed.error_message}`);
    assert.deepEqual(await rows(), beforeRefused, `${label}: no candidate, preview, snapshot or import row`);
    assert.equal((await connRow(r.conn.id)).state, "verified", `${label}: a refused answer shape is not a refused credential - the connection stays verified`);
    const callsBefore = src.calls.length;
    const admin = await api(`/gpexe/teams/${r.o.teamId}/checks/${failed.id}`, { cookie: r.o.cadmin.cookie });
    const coach = await api(`/gpexe/teams/${r.o.teamId}/checks/${failed.id}`, { cookie: r.o.coach.cookie });
    const status = await api(`/gpexe/teams/${r.o.teamId}/status`, { cookie: r.o.coach.cookie });
    assert.equal(src.calls.length, callsBefore, `${label}: reading the failed check sends no source request`);
    assert.equal(admin.body.check.error.message, failed.error_message, `${label}: the administrator reads the whole message`);
    assert.equal(coach.body.check.error.message, sentence, `${label}: the coach reads the sentence only`);
    assert.equal(status.body.importSwitch.enabled, false, label);
    assert.ok(src.calls.every((c) => c.auth !== "ENV"), label);
  }
  src.state.faults.wholePlayers = null;
});

test("20. a drill answer whose metric value has an unknown shape: the check stops with drill_set_incomplete and the drill's sanitized description (index, code, shape) on its row - for an administrator only -, records nothing, and the check start's own answer applies the same rule (the coach view without the description, the administrator view with it)", async () => {
  const o = await org();
  useSource();
  await bound(o);
  process.env.GPEXE_API_TOKEN = ENV_TOKEN;
  legacyTrap();
  src.serve(o.sourceTeamId);
  const players = structuredClone(src.state.bundle.details.drills["0"].players);
  const firstId = Object.keys(players)[0];
  players[firstId].markerMetricNameZq = [13579.2468];
  src.state.faults.drillPlayers = { index: 0, players };
  const before = (await q(`select count(*)::int as n from training_load.gpexe_import_candidates where owner_team_id = $1`, [o.teamId]))[0].n;
  const BASE = "The source did not answer every drill of a session; that session was not recorded and the check stopped.";

  // The check start's own answer (wait: true), as a coach would get it.
  const coachView = await importer.startCheck(o.teamId, { userId: o.coach.id, window: { from: DAY, to: DAY }, wait: true, adminViewer: false });
  assert.deepEqual([coachView.status, coachView.error], ["failed", { code: "drill_set_incomplete", message: BASE }]);
  const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [coachView.id]))[0];
  assert.ok(row.error_message.startsWith(`${BASE} Diagnostic: drill_index=0; drill_code=source_answer_unexpected; op=session_drill_details; consumed_failing=no;`), row.error_message);
  for (const leak of [firstId, "markerMetricNameZq", "13579", SOURCE_SENTENCE]) assert.ok(!row.error_message.includes(leak), `${leak} is not on the check row`);
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_candidates where owner_team_id = $1`, [o.teamId]))[0].n, before, "nothing recorded");
  assert.ok(src.calls.every((c) => c.auth !== "ENV"));

  // The same start, as an administrator would get it, carries the description.
  const adminView = await importer.startCheck(o.teamId, { userId: o.cadmin.id, window: { from: DAY, to: DAY }, wait: true, adminViewer: true });
  assert.equal(adminView.error.code, "drill_set_incomplete");
  assert.ok(adminView.error.message.startsWith(`${BASE} Diagnostic: drill_index=0;`), adminView.error.message);
  const viaRoute = await api(`/gpexe/teams/${o.teamId}/checks/${adminView.id}`, { cookie: o.cadmin.cookie });
  assert.equal(viaRoute.body.check.error.message, adminView.error.message);
  const viaCoach = await api(`/gpexe/teams/${o.teamId}/checks/${adminView.id}`, { cookie: o.coach.cookie });
  assert.equal(viaCoach.body.check.error.message, BASE);
  src.state.faults.drillPlayers = null;
});

test("21. a date window the source does not keep: the check still ends source_filter_ignored with no candidate and no retry; the stored failed check row carries the sanitized description after Diagnostic: (counts and fixed words only) - for an administrator only; nothing of it is written anywhere else", async () => {
  const o = await org();
  useSource();
  await bound(o);
  process.env.GPEXE_API_TOKEN = ENV_TOKEN;
  legacyTrap();
  src.serve(o.sourceTeamId);
  // A row far after the window (no parent names it) and a row with no start.
  src.state.faults.listExtraRows = [
    { id: 991234567, start_timestamp: "2026-09-20T10:00:00", category_name: "Marker Category Zq" },
    { id: 991234568, start_timestamp: null },
  ];
  const before = (await q(`select count(*)::int as n from training_load.gpexe_import_candidates where owner_team_id = $1`, [o.teamId]))[0].n;
  const logBefore = logLines.length;
  const STABLE = "The source server returned sessions outside the asked window; the window cannot be trusted.";
  try {
    const coachView = await importer.startCheck(o.teamId, { userId: o.coach.id, window: { from: DAY, to: DAY }, wait: true, adminViewer: false });
    assert.deepEqual([coachView.status, coachView.error], ["failed", { code: "source_filter_ignored", message: STABLE }], "a coach gets the stable sentence only");
    const row = (await q(`select * from training_load.gpexe_import_checks where id = $1`, [coachView.id]))[0];
    assert.equal(row.error_code, "source_filter_ignored");
    assert.match(row.error_message, /^The source server returned sessions outside the asked window; the window cannot be trusted\. Diagnostic: op=session_list_by_date; rows=5; before_lookback=0; after_end=1; unreadable=1; outside_named_drill=0; distance=under_3h:0,3h_to_24h:0,over_24h:1,unknown:1; tz=Z:\d+,offset:\d+,none:\d+,other:\d+\.$/);
    for (const leak of ["991234567", "991234568", "2026-09-20", "10:00", "Marker", String(o.sourceTeamId), SOURCE_SENTENCE]) assert.ok(!row.error_message.includes(leak), `${leak} is not on the check row`);
    assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_candidates where owner_team_id = $1`, [o.teamId]))[0].n, before, "no candidate recorded");
    assert.equal(src.calls.filter((c) => c.key.includes("start_timestamp_gte")).length, 1, "one list read, no retry");
    assert.ok(!src.calls.some((c) => c.key.includes("/details/") || c.key.includes("athlete_session")), "no read after the refused list");
    const viaAdmin = await api(`/gpexe/teams/${o.teamId}/checks/${coachView.id}`, { cookie: o.cadmin.cookie });
    assert.equal(viaAdmin.body.check.error.message, row.error_message, "the club admin reads the description");
    const viaPlatform = await api(`/gpexe/teams/${o.teamId}/checks/${coachView.id}`, { cookie: o.padmin.cookie });
    assert.equal(viaPlatform.body.check.error.message, row.error_message, "a platform admin reads the description");
    const viaCoach = await api(`/gpexe/teams/${o.teamId}/checks/${coachView.id}`, { cookie: o.coach.cookie });
    assert.equal(viaCoach.body.check.error.message, STABLE, "the coach does not");
    const statusCoach = await api(`/gpexe/teams/${o.teamId}/status`, { cookie: o.coach.cookie });
    assert.ok(!JSON.stringify(statusCoach.body).includes("Diagnostic"), "nor in the coach's status");
    for (const line of logLines.slice(logBefore)) assert.ok(!line.includes("op=session_list_by_date") && !line.includes("991234567"), `not written to a log line: ${line.slice(0, 120)}`);
  } finally {
    src.state.faults.listExtraRows = null;
  }
});

test("10. this suite runs on a disposable database only; every console line, check row, candidate row and connection column is free of the connection token, the environment token, the username, the password and the source's sentence", async () => {
  assert.match((await q("select current_database() as db"))[0].db, DISPOSABLE_DB_NAME_PATTERN);
  assert.ok(db.url !== ORIGINAL_DATABASE_URL);
  for (const line of logLines) noSecret(line, "a console line");
  for (const r of await q(`select to_jsonb(c) as j from training_load.gpexe_import_checks c`)) noSecret(JSON.stringify(r.j), "a check row");
  for (const r of await q(`select to_jsonb(c) - 'raw_bundle' as j, raw_bundle::text as raw from training_load.gpexe_import_candidates c`)) { noSecret(JSON.stringify(r.j), "a candidate row"); noSecret(r.raw, "a raw bundle"); }
  for (const r of await q(`select to_jsonb(c) - 'credential_ciphertext' - 'credential_nonce' - 'credential_auth_tag' as j from training_load.source_credential_connections c`)) noSecret(JSON.stringify(r.j), "a connection row");
  for (const r of await q(`select to_jsonb(a) as j from training_load.source_connection_audit a`)) noSecret(JSON.stringify(r.j), "an audit row");
});

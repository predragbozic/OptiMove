// F3c2e — the verified team binding (POST …/connections/:id/bindings) and
// the club-admin path of the source connection routes, against a fake
// source, on a disposable optimove_tests_gpexe_* database (never OPTIMOVE).
// Discovery and rules: docs/ai/source-connections-f3c2e-discovery.md;
// contract: docs/ai/source-connections-f3c2-contract.md section 2.
// No real credential, no real host, no binding of a persistent team: every
// network call goes to an in-process fake fetch that records the exact URL,
// method and whether the Authorization value is the issued marker token.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyGpexeTestMigrations, createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import * as cryptoMod from "../src/sourceCredentialCrypto.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V30 = "202610041000_training_load_v30_gpexe_team_settings_bound_final.sql";
const UP_TO_V29 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V30));
const V30_ROLLBACK = path.resolve(ROOT, "docs/runbooks/source-connections-v30-rollback.sql");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const ORIGINAL_ACTIVE = process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION;

// Marker values: never in a response, an audit row, a log line or a column
// other than the ciphertext.
const USERNAME = "marker-username-f3c2e@example.invalid";
const PASSWORD = "MARKER-password-f3c2e-not-real";
const TOKEN = "MARKER-token-f3c2e-not-real-0123456789";
const SOURCE_SENTENCE = "Marker sentence from the source server body";
const SOURCE_TEAM_NAME_MARKER = "Marker source team name";
const EXCHANGE_URL = "https://server3.gpexe.com/api-token-auth/";
const BASE = "https://server3.gpexe.com/rest/v1/";
const ALL_TEAMS = [980, 981, 982, 983, 984, 985, 986, 987];

let db, admin, server, apiBase, service, settings, createSession, appPool;
const logLines = [];
const originalConsole = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "f3c2e" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  process.env.DATABASE_URL = db.url;
  process.env.SOURCE_CREDENTIAL_KEYS = cryptoMod.generateKeyEntry(1);
  delete process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : safeString(a))).join(" "));
      if (process.env.F3C2E_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceConnectionService.js");
  settings = await import("../src/gpexeImportService.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
});

after(async () => {
  service?.setSourceFetchForTests(null);
  service?.setSourceConnectionCommitForTests();
  service?.setSourceConnectionClockForTests(null);
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS; else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
  if (ORIGINAL_ACTIVE === undefined) delete process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION; else process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION = ORIGINAL_ACTIVE;
});

function safeString(value) { try { return JSON.stringify(value); } catch { return String(value); } }
const SECRETS = [USERNAME, PASSWORD, TOKEN, SOURCE_SENTENCE, SOURCE_TEAM_NAME_MARKER];
function noSecret(text, where, allowed = []) {
  for (const s of SECRETS) if (!allowed.includes(s)) assert.ok(!String(text).includes(s), `${where} carries a secret marker (${s.slice(0, 12)}…)`);
}

async function api(path, { method = "GET", body, cookie, contentType = "application/json", allowed = [] } = {}) {
  const res = await fetch(`${apiBase}/api/training-load/sources${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": contentType }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  noSecret(text, `the response to ${method} ${path}`, allowed);
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, headers: res.headers };
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
  await setWorkspace(id, workspace[0], workspace[1]);
  return { id, cookie: await cookieFor(id) };
}
async function addClubAdminRole(userId, clubId) {
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [userId, clubId]);
}
async function clubAdmin(clubId, workspaceClub = clubId) {
  const id = await makeUser("club-admin");
  await addClubAdminRole(id, clubId);
  await setWorkspace(id, "club", workspaceClub);
  return { id, cookie: await cookieFor(id) };
}
async function coachOf(teamId) {
  const id = await makeUser("coach");
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return { id, cookie: await cookieFor(id) };
}
// A club with two active teams and, by default, their approved pairs (the
// platform-admin allowlist = gpexe_team_settings): team → 981, team2 → 982.
async function org({ approve = true } = {}) {
  const club = (await q(`insert into public.clubs (name) values ($1) returning id`, [`Club ${uid()}`]))[0].id;
  const team = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [club, `Team ${uid()}`]))[0].id;
  const team2 = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [club, `Team B ${uid()}`]))[0].id;
  const configurer = await makeUser("configurer");
  if (approve) { await approvePair(team, "981", configurer); await approvePair(team2, "982", configurer); }
  return { club, team, team2, configurer };
}
// The F3b setting as a platform admin makes it (raw here: the F3b route is not under test).
// gpexe_team_settings keeps one OptiMove team per GPEXE team for the whole database and a row
// is never deleted (v24), so every approved team is tracked and, after its test, its bindings
// are ended and its setting is re-pointed to a unique spare id (with a reason, as v24 wants),
// which frees 981/982/... for the next test whatever happened in this one.
const approvedTeams = [];
let releaseCounter = 0;
async function approvePair(teamId, gpexeTeamId, userId) {
  await q(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, $2, $3)`, [teamId, gpexeTeamId, userId]);
  approvedTeams.push(teamId);
}
afterEach(async () => {
  for (const teamId of approvedTeams.splice(0)) {
    await q(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = bound_by_user_id, end_reason = 'test cleanup' where team_id = $1 and state = 'active'`, [teamId]);
    releaseCounter += 1;
    await q(`update training_load.gpexe_team_settings set gpexe_team_id = $2, change_reason = 'test cleanup', configured_at = now() where owner_team_id = $1`, [teamId, String(900000000000 + releaseCounter)]);
  }
});
const SETTINGS = `select owner_team_id, gpexe_team_id, configured_by_user_id, configured_at, change_reason from training_load.gpexe_team_settings where owner_team_id = any($1::uuid[])`;
const HISTORY = `select owner_team_id, gpexe_team_id, configured_by_user_id, configured_at from training_load.gpexe_team_settings_history where owner_team_id = any($1::uuid[])`;
const CREATE = (club, over = {}) => ({ ownerScope: "club", ownerClubId: club, hostKey: "server3", accountLabel: "Club account (label only)", credentialKind: "exchanged_token", ...over });
async function created(adminUser, club) {
  const r = await api("/gpexe/connections", { method: "POST", cookie: adminUser.cookie, body: CREATE(club) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.connection;
}
// A connection with a stored, verified credential (one exchange, one list read).
async function verified(adminUser, club) {
  const conn = await created(adminUser, club);
  useSource();
  const r = await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: adminUser.cookie, body: { username: USERNAME, password: PASSWORD }, allowed: [SOURCE_TEAM_NAME_MARKER] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.state, "verified");
  return r.body.connection;
}
const bindApi = (connectionId, cookie, body) => api(`/gpexe/connections/${connectionId}/bindings`, { method: "POST", cookie, body });
async function endBindings(connectionId, userId) {
  await q(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'test finished' where connection_id = $1 and state = 'active'`, [connectionId, userId]);
}
async function rowOf(id) { return (await q(`select * from training_load.source_credential_connections where id = $1`, [id]))[0]; }
async function auditOf(id) { return q(`select action, outcome, error_code, performed_by_user_id, basis, metadata, team_id from training_load.source_connection_audit where connection_id = $1 order by performed_at, id`, [id]); }
async function bindingsOf(id) { return q(`select id, team_id, source_team_id, state, bound_by_user_id, legacy_gpexe_settings_team_id from training_load.source_team_bindings where connection_id = $1 order by bound_at, id`, [id]); }
async function dbTextOf(connectionId) {
  const conn = (await q(`select to_jsonb(c) - 'credential_ciphertext' - 'credential_nonce' - 'credential_auth_tag' as j from training_load.source_credential_connections c where id = $1`, [connectionId]))[0]?.j;
  const audit = await q(`select to_jsonb(a) as j from training_load.source_connection_audit a where connection_id = $1`, [connectionId]);
  const bindings = await q(`select to_jsonb(b) as j from training_load.source_team_bindings b where connection_id = $1`, [connectionId]);
  return JSON.stringify([conn, audit.map((r) => r.j), bindings.map((r) => r.j)]);
}
async function digestOf(sql, params) {
  return (await q(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d from (${sql}) t`, params))[0].d;
}

// ---------------------------------------------------------------------------
// The fake source: the exchange, the team list and the team reads of server3
// rest_v1, every request recorded. The team list names a marker that must
// never leak anywhere but the sourceTeams answer (which is its purpose).
// ---------------------------------------------------------------------------
function fakeSource({ token = TOKEN, teams = ALL_TEAMS, teamRead = "ok", listRead = "ok", teamGate = null, listGate = null, names = true } = {}) {
  const calls = [];
  const json = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? null;
    const record = { url: u, method: init.method ?? "GET", redirect: init.redirect, authIsIssuedToken: auth === `Token ${token}` };
    calls.push(record);
    const abortable = (p) => new Promise((resolve, reject) => {
      if (init.signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      p.then(resolve, reject);
    });
    if (u === EXCHANGE_URL) {
      const params = new URLSearchParams(init.body);
      return params.get("username") === USERNAME && params.get("password") === PASSWORD ? json(200, { token }) : json(400, { non_field_errors: [SOURCE_SENTENCE] });
    }
    if (!u.startsWith(BASE)) return json(404, { detail: "not served" });
    if (init.method !== "GET") return json(405, {});
    if (!record.authIsIssuedToken) return json(401, { detail: SOURCE_SENTENCE });
    const rel = u.slice(BASE.length);
    if (rel === "team/") {
      if (listGate) await abortable(listGate.p);
      if (listRead === "500") return json(500, SOURCE_SENTENCE);
      return json(200, teams.map((id, i) => ({ id, ...(names && i !== 2 ? { name: `${SOURCE_TEAM_NAME_MARKER} ${id}` } : {}), users: [{ email: USERNAME }], notes: SOURCE_SENTENCE })), { "x-total-count": String(teams.length) });
    }
    const m = rel.match(/^team\/(\d+)\/$/);
    if (m) {
      if (teamGate) await abortable(teamGate.p);
      switch (teamRead) {
        case "401": return json(401, { detail: SOURCE_SENTENCE });
        case "403": return json(403, { detail: SOURCE_SENTENCE });
        case "429": return json(429, { detail: SOURCE_SENTENCE }, { "retry-after": "60" });
        case "500": return json(500, SOURCE_SENTENCE);
        case "hang": return abortable(new Promise(() => {}));
        case "network": throw new TypeError("fetch failed");
        case "redirect": return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
        case "huge": return json(200, `{"id":${m[1]},"padding":"${"x".repeat(6 * 1024 * 1024)}"}`);
        case "not-json": return json(200, `<html>${SOURCE_SENTENCE}</html>`);
        case "wrong-id": return json(200, { id: Number(m[1]) + 1, name: SOURCE_TEAM_NAME_MARKER });
        case "not-object": return json(200, [Number(m[1])]);
        default: break;
      }
      if (!teams.includes(Number(m[1]))) return json(404, { detail: SOURCE_SENTENCE });
      return json(200, { id: Number(m[1]), name: `${SOURCE_TEAM_NAME_MARKER} ${m[1]}`, athlete_name: "Marker Athlete Name" });
    }
    return json(404, { detail: "not served" });
  };
  return { calls, fetchImpl };
}
const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
const useSource = (over) => { const s = fakeSource(over); service.setSourceFetchForTests(s.fetchImpl); return s; };
const teamReads = (calls) => calls.filter((c) => /\/team\/\d+\/$/.test(c.url)).map((c) => c.url.slice(BASE.length));
const waitFor = async (fn, ms = 3_000) => { for (let i = 0; i < ms / 25 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 25)); assert.ok(fn(), "the awaited condition did not come"); };
const BINDING_KEYS = ["bindingId", "boundAt", "sourceTeamId", "state", "teamActive", "teamId", "teamName"];
const TEAM_ENTRY_KEYS = ["approvedTeamId", "approvedTeamName", "name", "sourceTeamId"];
const otherTeamFacts = (text, allowedIds) => {
  for (const id of ALL_TEAMS.map(String)) {
    if (allowedIds.includes(id)) continue;
    assert.ok(!text.includes(`"sourceTeamId":"${id}"`) && !text.includes(`${SOURCE_TEAM_NAME_MARKER} ${id}`), `a fact of source team ${id} outside the allowlist leaked`);
  }
};

// ---------------------------------------------------------------------------
// 1–3. Access, body shape
// ---------------------------------------------------------------------------
test("1. the bind route: 401 without a session; 415 for a body that is not JSON; the same 404 for a coach, another club's admin, an admin of both clubs acting in the other club's workspace, a platform admin in another club's workspace, a club admin whose role was revoked, an archived club, an archived team, a team of another club, an unknown connection, an unknown team and a malformed id — none sends a request, writes a row or audits anything", async () => {
  const { club, team } = await org();
  const other = await org({ approve: false });
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  const src = useSource();
  const good = { teamId: team, sourceTeamId: "981" };
  assert.equal((await bindApi(conn.id, undefined, good)).status, 401, "signed out");
  assert.equal((await api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: ca.cookie, body: "teamId=a", contentType: "application/x-www-form-urlencoded" })).status, 415);
  const both = await clubAdmin(club, other.club);
  await addClubAdminRole(both.id, other.club);
  const paOther = await platformAdmin(["club", other.club]);
  await addClubAdminRole(paOther.id, other.club);
  const revoked = await clubAdmin(club);
  await q(`update public.user_club_roles set is_active = false where user_id = $1`, [revoked.id]);
  const cases = [
    ["coach", (await coachOf(team)).cookie, good],
    ["another club's admin", (await clubAdmin(other.club)).cookie, good],
    ["an admin of both clubs in the other club's workspace", both.cookie, good],
    ["a platform admin in another club's workspace", paOther.cookie, good],
    ["a club admin whose role was revoked", revoked.cookie, good],
    ["a team of another club", ca.cookie, { teamId: other.team, sourceTeamId: "981" }],
    ["an unknown team", ca.cookie, { teamId: crypto.randomUUID(), sourceTeamId: "981" }],
  ];
  for (const [who, cookie, body] of cases) {
    const r = await bindApi(conn.id, cookie, body);
    assert.deepEqual([r.status, r.body.error], [404, "notFound"], who);
  }
  assert.deepEqual([(await bindApi(crypto.randomUUID(), ca.cookie, good)).status, (await bindApi("not-a-uuid", ca.cookie, good)).status], [404, 404], "an unknown or malformed connection id");
  assert.equal((await api(`/garmin/connections/${conn.id}/bindings`, { method: "POST", cookie: ca.cookie, body: good })).status, 404, "another source");
  await q(`update public.teams set is_active = false where id = $1`, [team]);
  assert.equal((await bindApi(conn.id, ca.cookie, good)).status, 404, "an archived team");
  await q(`update public.teams set is_active = true where id = $1`, [team]);
  await q(`update public.clubs set is_active = false where id = $1`, [club]);
  assert.equal((await bindApi(conn.id, ca.cookie, good)).status, 404, "an archived club");
  await q(`update public.clubs set is_active = true where id = $1`, [club]);
  assert.equal(src.calls.length, 0, "nothing was sent");
  assert.deepEqual(await bindingsOf(conn.id), []);
  assert.deepEqual((await auditOf(conn.id)).map((a) => a.action), ["create", "connect"], "no 404 is audited");
});

test("2. a body the route does not take is 400 before any lock, request or audit: an unknown field, a missing field, a team id that is not a UUID, a source team id with a leading zero, letters, thirteen digits, a number or a list", async () => {
  const { club, team } = await org();
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  const src = useSource();
  for (const body of [
    { teamId: team, sourceTeamId: "981", extra: 1 }, { teamId: team }, { sourceTeamId: "981" }, { teamId: "not-a-uuid", sourceTeamId: "981" },
    { teamId: team, sourceTeamId: "0981" }, { teamId: team, sourceTeamId: "98o" }, { teamId: team, sourceTeamId: "9".repeat(13) }, { teamId: team, sourceTeamId: 981 }, { teamId: team, sourceTeamId: ["981"] },
    { teamId: team, sourceTeamId: "" }, { teamId: team, sourceTeamId: "981&team=980" },
  ]) {
    const r = await bindApi(conn.id, ca.cookie, body);
    assert.deepEqual([r.status, r.body.error], [400, "invalid_body"], JSON.stringify(body));
  }
  assert.equal(src.calls.length, 0);
  assert.deepEqual((await auditOf(conn.id)).map((a) => a.action), ["create", "connect"]);
  assert.deepEqual(await bindingsOf(conn.id), []);
  // A source name that is a prototype key is an unknown source: 404, never a 500.
  for (const source of ["constructor", "__proto__", "hasownproperty"]) {
    assert.equal((await api(`/${source}/connections/${conn.id}/bindings`, { method: "POST", cookie: ca.cookie, body: { teamId: team, sourceTeamId: "981" } })).status, 404, source);
  }
});

// ---------------------------------------------------------------------------
// 4–6. Local refusals: state, host, key
// ---------------------------------------------------------------------------
test("3. the connection must be verified: not_connected, needs_reconnect, source_unavailable and linked_untested answer 409 connection_not_verified with zero requests, audited as refused with the team and never counted", async () => {
  const { club, team } = await org();
  const ca = await clubAdmin(club);
  const fresh = await created(ca, club);
  const src = useSource();
  const r0 = await bindApi(fresh.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
  assert.deepEqual([r0.status, r0.body.error], [409, "connection_not_verified"]);
  const conn = await verified(ca, club);
  const src2 = useSource();
  for (const state of ["needs_reconnect", "source_unavailable", "linked_untested"]) {
    await q(`update training_load.source_credential_connections set state = $2, last_error_code = 'source_auth_rejected', last_error_at = now() where id = $1`, [conn.id, state]);
    const r = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    assert.deepEqual([r.status, r.body.error], [409, "connection_not_verified"], state);
  }
  assert.equal(src.calls.length + src2.calls.length, 0, "nothing was sent");
  const refusals = (await auditOf(conn.id)).filter((a) => a.action === "bind");
  assert.equal(refusals.length, 3);
  assert.ok(refusals.every((a) => a.outcome === "refused" && a.error_code === "connection_not_verified" && a.team_id === team && a.metadata.counted === false && a.basis === "club_admin"));
  assert.deepEqual(await bindingsOf(conn.id), []);
  await q(`update training_load.source_credential_connections set state = 'verified', last_error_code = null, last_error_at = null where id = $1`, [conn.id]);
});

test("4. a host retired between the connection's creation and the bind: 409 host_not_allowed with zero requests, nothing bound; approved again, the bind goes through", async () => {
  const { club, team } = await org();
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  const src = useSource();
  await q(`update training_load.source_host_catalog set state = 'retired' where source_system = 'gpexe' and host_key = 'server3'`);
  try {
    const r = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    assert.deepEqual([r.status, r.body.error], [409, "host_not_allowed"]);
    assert.equal(src.calls.length, 0);
    assert.deepEqual(await bindingsOf(conn.id), []);
  } finally {
    await q(`update training_load.source_host_catalog set state = 'approved' where source_system = 'gpexe' and host_key = 'server3'`);
  }
  assert.equal((await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" })).status, 201);
  await endBindings(conn.id, ca.id);
});

test("5. without SOURCE_CREDENTIAL_KEYS the bind answers 503 key_missing; a stored credential that no longer decrypts (a tampered nonce) answers 503 credential_unreadable; zero requests, nothing bound, the audit names the team", async () => {
  const { club, team } = await org();
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  const src = useSource();
  const keys = process.env.SOURCE_CREDENTIAL_KEYS;
  delete process.env.SOURCE_CREDENTIAL_KEYS;
  try {
    const r = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    assert.deepEqual([r.status, r.body.error], [503, "key_missing"]);
  } finally {
    process.env.SOURCE_CREDENTIAL_KEYS = keys;
  }
  const row = await rowOf(conn.id);
  const nonce = Buffer.from(row.credential_nonce);
  nonce[0] ^= 0xff;
  await q(`update training_load.source_credential_connections set credential_nonce = $2 where id = $1`, [conn.id, nonce]);
  const r2 = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
  assert.deepEqual([r2.status, r2.body.error], [503, "credential_unreadable"]);
  assert.equal(src.calls.length, 0);
  assert.deepEqual(await bindingsOf(conn.id), []);
  const binds = (await auditOf(conn.id)).filter((a) => a.action === "bind");
  assert.deepEqual(binds.map((a) => [a.outcome, a.error_code, a.team_id, a.metadata.counted]), [["refused", "key_missing", team, false], ["refused", "credential_unreadable", team, false]]);
  await q(`update training_load.source_credential_connections set credential_nonce = $2 where id = $1`, [conn.id, row.credential_nonce]);
});

// ---------------------------------------------------------------------------
// 7–9. The happy path, idempotency, the answer classes
// ---------------------------------------------------------------------------
test("6. a club admin's whole flow: Connect answers the teams the credential sees (id and name only, nothing preselected, a team without a name is null); the bind of one team of the club to the chosen source team sends exactly one GET team/<id>/ with the stored token, writes one binding and one audit row (bind, ok, the team, basis club_admin, the source team id as a fact), answers 201 with the binding; GET shows it with the allowed fields only; no secret anywhere", async () => {
  const { club, team } = await org();
  const ca = await clubAdmin(club);
  const conn = await created(ca, club);
  const src0 = useSource();
  const c = await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: ca.cookie, body: { username: USERNAME, password: PASSWORD }, allowed: [SOURCE_TEAM_NAME_MARKER] });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.result.state, "verified");
  // The shared account sees eight teams; the club admin gets exactly the two approved pairs of their club and no fact of the other six.
  assert.equal(c.body.result.sourceTeamCount, 2);
  assert.equal(c.body.result.sourceTeamsTruncated, false);
  const teamName = (await q(`select name from public.teams where id = $1`, [team]))[0].name;
  const team2Name = (await q(`select name from public.teams where id = $1`, [(await q(`select id from public.teams where club_id = $1 and id <> $2`, [club, team]))[0].id]))[0].name;
  assert.deepEqual(c.body.result.sourceTeams, [
    { sourceTeamId: "981", name: `${SOURCE_TEAM_NAME_MARKER} 981`, approvedTeamId: team, approvedTeamName: teamName },
    { sourceTeamId: "982", name: null, approvedTeamId: (await q(`select id from public.teams where club_id = $1 and id <> $2`, [club, team]))[0].id, approvedTeamName: team2Name },
  ], "the intersection of the visible teams and the club's approved pairs, in the source's order; a team without a name is null");
  otherTeamFacts(JSON.stringify(c.body), ["981", "982"]);
  assert.ok(!JSON.stringify(c.body).includes(USERNAME) && !JSON.stringify(c.body).includes(SOURCE_SENTENCE), "no user, no note of the source list");
  assert.deepEqual(src0.calls.map((x) => x.url), [EXCHANGE_URL, `${BASE}team/`]);
  // The bind: the chosen team, read again alone.
  const src = useSource();
  const r = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(src.calls.map((x) => [x.method, x.url, x.authIsIssuedToken, x.redirect]), [["GET", `${BASE}team/981/`, true, "manual"]], "exactly the chosen team's own read with the stored token");
  const { bindingId, boundAt, ...binding } = r.body.result.binding;
  assert.match(bindingId, /^[0-9a-f-]{36}$/);
  assert.ok(boundAt);
  assert.deepEqual(binding, { teamId: team, teamName: (await q(`select name from public.teams where id = $1`, [team]))[0].name, sourceTeamId: "981", state: "active" });
  assert.deepEqual([r.body.result.action, r.body.result.outcome, r.body.result.idempotent], ["bind", "ok", false]);
  assert.equal(r.body.connection.state, "verified");
  assert.deepEqual(r.body.connection.boundTeams.map((b) => Object.keys(b).sort()), [BINDING_KEYS]);
  const rows = await bindingsOf(conn.id);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].team_id, rows[0].source_team_id, rows[0].state, rows[0].bound_by_user_id, rows[0].legacy_gpexe_settings_team_id], [team, "981", "active", ca.id, team], "the binding points at the approved pair it continues");
  const audit = (await auditOf(conn.id)).filter((a) => a.action === "bind");
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].outcome, audit[0].error_code, audit[0].team_id, audit[0].basis, audit[0].performed_by_user_id], ["ok", null, team, "club_admin", ca.id]);
  const { attempt_id: attemptId, ...facts } = audit[0].metadata;
  assert.match(attemptId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(facts, { host_key: "server3", credential_kind: "exchanged_token", status_class: "2xx", attempt_no: 2, bound_team_count: 1, counted: false, source_team_id: "981" }, "the connect was attempt 1; a successful bind is numbered in the window but not counted, and its row says counted: false");
  noSecret(await dbTextOf(conn.id), "the database rows");
  const read = await api(`/gpexe/connections/${conn.id}`, { cookie: ca.cookie });
  assert.deepEqual(read.body.connection.boundTeams.map((b) => [b.teamId, b.sourceTeamId, b.state, b.teamActive, b.bindingId]), [[team, "981", "active", true, bindingId]]);
  // The connection row itself was not touched by the bind.
  assert.equal(String((await rowOf(conn.id)).updated_at), String((await q(`select updated_at from training_load.source_credential_connections where id = $1`, [conn.id]))[0].updated_at));
  await endBindings(conn.id, ca.id);
});

test("7. the same bind again is the same final answer: 200 with idempotent true and the existing binding, one row in total, no request, no new audit row; a bind of the same team to another source team is a conflict, not a replacement", async () => {
  const { club, team } = await org();
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  useSource();
  const first = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
  assert.equal(first.status, 201);
  const src = useSource();
  const again = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.result.idempotent, true);
  assert.equal(again.body.result.binding.bindingId, first.body.result.binding.bindingId);
  assert.equal(src.calls.length, 0, "no second request");
  assert.equal((await bindingsOf(conn.id)).length, 1);
  assert.equal((await auditOf(conn.id)).filter((a) => a.action === "bind").length, 1, "no audit row for the no-op");
  const other = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "983" });
  assert.deepEqual([other.status, other.body.error], [409, "team_already_bound"]);
  assert.equal(src.calls.length, 0);
  assert.equal((await bindingsOf(conn.id)).length, 1);
  // The identical repeat survives a state change: the binding is answered before the verified gate.
  await q(`update training_load.source_credential_connections set state = 'source_unavailable', last_error_code = 'source_unavailable', last_error_at = now() where id = $1`, [conn.id]);
  const afterStateChange = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
  assert.deepEqual([afterStateChange.status, afterStateChange.body.result?.idempotent, afterStateChange.body.result?.binding?.bindingId, src.calls.length], [200, true, first.body.result.binding.bindingId, 0], JSON.stringify(afterStateChange.body));
  assert.equal((await bindingsOf(conn.id)).length, 1);
  await q(`update training_load.source_credential_connections set state = 'verified', last_error_code = null, last_error_at = null where id = $1`, [conn.id]);
  await endBindings(conn.id, ca.id);
});

test("8. every answer class of the chosen team's read: 401 → 409 source_auth_rejected and the connection becomes needs_reconnect (credential kept); 403 and a team the credential does not see → 409 source_team_not_visible; 429, 5xx, a network failure and a timeout → 502 source_unavailable; a redirect, an oversized answer, a non-JSON answer, a team of another id and a non-object → 502 source_answer_unexpected; each audited with the team, nothing bound, the source's sentence nowhere", async () => {
  const { club, team } = await org();
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  const cipher = (await rowOf(conn.id)).credential_ciphertext;
  // Twelve source-reaching failures follow: the window is moved past them so the throttle stays out of this test (test 21 covers it).
  service.setSourceConnectionClockForTests(() => new Date(Date.now() + 16 * 60 * 1000));
  const steps = [
    [{ teamRead: "403" }, 409, "source_team_not_visible", "failed", "verified"],
    [{ teams: [980] }, 409, "source_team_not_visible", "failed", "verified"],
    [{ teamRead: "429" }, 502, "source_unavailable", "failed", "verified"],
    [{ teamRead: "500" }, 502, "source_unavailable", "failed", "verified"],
    [{ teamRead: "network" }, 502, "source_unavailable", "failed", "verified"],
    [{ teamRead: "hang" }, 502, "source_unavailable", "failed", "verified"],
    [{ teamRead: "redirect" }, 502, "source_answer_unexpected", "failed", "verified"],
    [{ teamRead: "huge" }, 502, "source_answer_unexpected", "failed", "verified"],
    [{ teamRead: "not-json" }, 502, "source_answer_unexpected", "failed", "verified"],
    [{ teamRead: "wrong-id" }, 502, "source_answer_unexpected", "failed", "verified"],
    [{ teamRead: "not-object" }, 502, "source_answer_unexpected", "failed", "verified"],
    [{ teamRead: "401" }, 409, "source_auth_rejected", "refused", "needs_reconnect"],
  ];
  let seen = 0;
  for (const [mode, status, code, outcome, state] of steps) {
    const src = useSource(mode);
    const r = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    assert.deepEqual([r.status, r.body.error, r.body.teamId], [status, code, team], JSON.stringify(mode));
    assert.deepEqual(teamReads(src.calls), ["team/981/"], "one read, never repeated");
    const row = await rowOf(conn.id);
    assert.equal(row.state, state);
    assert.ok(row.credential_ciphertext.equals(cipher), "the stored credential is kept");
    const last = (await auditOf(conn.id)).at(-1);
    seen += 1;
    assert.deepEqual([last.action, last.outcome, last.error_code, last.team_id, last.metadata.counted, last.metadata.source_team_id], ["bind", outcome, code, team, true, "981"]);
    assert.deepEqual(await bindingsOf(conn.id), [], "nothing bound");
  }
  assert.equal((await auditOf(conn.id)).filter((a) => a.action === "bind").length, seen);
  noSecret(await dbTextOf(conn.id), "the database rows");
  service.setSourceConnectionClockForTests(null);
  // After the refused credential a repeat is refused locally: not verified, zero requests.
  const src = useSource();
  const r = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
  assert.deepEqual([r.status, r.body.error, src.calls.length], [409, "connection_not_verified", 0]);
});

// ---------------------------------------------------------------------------
// 10–12. The legacy setting (D12) and the conflicts
// ---------------------------------------------------------------------------
test("9. the approved pair: a team whose gpexe_team_settings names the chosen source team (also with a leading zero, compared canonically) binds and the binding carries the provenance pointer, the settings row and its history digest-identical before and after; a team without a setting → 409 team_setting_missing; a setting naming another source team → 409 team_setting_mismatch; both with zero requests and nothing changed", async () => {
  const { club, team, team2 } = await org({ approve: false });
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  const team3 = (await q(`insert into public.teams (club_id, name) values ($1, 'No setting') returning id`, [club]))[0].id;
  await approvePair(team, "0984", ca.id);
  await approvePair(team2, "985", ca.id);
  const before = [await digestOf(SETTINGS, [[team, team2]]), await digestOf(HISTORY, [[team, team2]])];
  const none = await bindApi(conn.id, ca.cookie, { teamId: team3, sourceTeamId: "986" });
  assert.deepEqual([none.status, none.body.error], [409, "team_setting_missing"]);
  const src = useSource();
  const same = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "984" });
  assert.equal(same.status, 201, JSON.stringify(same.body));
  assert.deepEqual(teamReads(src.calls), ["team/984/"]);
  assert.equal((await bindingsOf(conn.id))[0].legacy_gpexe_settings_team_id, team, "the provenance pointer names the team's own setting");
  const mismatch = await bindApi(conn.id, ca.cookie, { teamId: team2, sourceTeamId: "986" });
  assert.deepEqual([mismatch.status, mismatch.body.error], [409, "team_setting_mismatch"]);
  assert.deepEqual(teamReads(src.calls), ["team/984/"], "the mismatch sent nothing");
  assert.equal((await bindingsOf(conn.id)).length, 1);
  assert.deepEqual([await digestOf(SETTINGS, [[team, team2]]), await digestOf(HISTORY, [[team, team2]])], before, "the legacy rows and their history are byte-identical");
  const binds = (await auditOf(conn.id)).filter((a) => a.action === "bind");
  assert.deepEqual(binds.map((a) => [a.outcome, a.error_code, a.team_id, a.metadata.counted]), [["refused", "team_setting_missing", team3, false], ["ok", null, team, false], ["refused", "team_setting_mismatch", team2, false]], "only a source-reaching bind that did not succeed is counted; a successful one and the local refusals say counted: false");
  await endBindings(conn.id, ca.id);
});

test("10. conflicts: a team already bound for this source through another connection of the club → 409 team_already_bound before any request; an approved source team asked for another OptiMove team of the club → 409 team_setting_mismatch locally (the allowlist pair is exact); a visible but unapproved source team → the same local refusal; nothing written, nothing sent", async () => {
  const { club, team, team2 } = await org();
  const ca = await clubAdmin(club);
  const a = await verified(ca, club);
  const b = await verified(ca, club);
  useSource();
  assert.equal((await bindApi(a.id, ca.cookie, { teamId: team, sourceTeamId: "981" })).status, 201);
  const src = useSource();
  const teamTaken = await bindApi(b.id, ca.cookie, { teamId: team, sourceTeamId: "982" });
  assert.deepEqual([teamTaken.status, teamTaken.body.error], [409, "team_already_bound"]);
  const approvedElsewhere = await bindApi(b.id, ca.cookie, { teamId: team2, sourceTeamId: "981" });
  assert.deepEqual([approvedElsewhere.status, approvedElsewhere.body.error], [409, "team_setting_mismatch"], "981 is approved for the other team, not for team2");
  const unapproved = await bindApi(b.id, ca.cookie, { teamId: team2, sourceTeamId: "983" });
  assert.deepEqual([unapproved.status, unapproved.body.error], [409, "team_setting_mismatch"], "983 is visible to the credential but approved for nobody");
  assert.equal(src.calls.length, 0, "none of the three sent anything");
  assert.deepEqual(await bindingsOf(b.id), []);
  const binds = (await auditOf(b.id)).filter((x) => x.action === "bind");
  assert.deepEqual(binds.map((x) => [x.outcome, x.error_code, x.metadata.counted]), [["refused", "team_already_bound", false], ["refused", "team_setting_mismatch", false], ["refused", "team_setting_mismatch", false]]);
  await endBindings(a.id, ca.id);
});

// ---------------------------------------------------------------------------
// 13–17. Concurrency
// ---------------------------------------------------------------------------
test("11. two concurrent identical binds by one admin: one row, the second answers 200 idempotent after waiting on the per-user lock and sends nothing; by two admins (a club admin and a platform admin): one row, the other answers idempotent or try_again, never a second row or a second read", async () => {
  const { club, team, team2 } = await org();
  const ca = await clubAdmin(club);
  const pa = await platformAdmin();
  const conn = await verified(ca, club);
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 10_000, testTimeout: 10_000 });
  try {
    const g = gate();
    const src = useSource({ teamGate: g });
    const first = bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    await waitFor(() => src.calls.length === 1);
    const second = bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    await new Promise((r) => setTimeout(r, 300));
    g.release();
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    assert.deepEqual([r2.status, r2.body.result?.idempotent], [200, true], JSON.stringify(r2.body));
    assert.equal(src.calls.length, 1, "one read in total");
    assert.equal((await bindingsOf(conn.id)).length, 1);
    // Two admins on one connection: the connection row serializes them.
    const g2 = gate();
    const src2 = useSource({ teamGate: g2 });
    const byClub = bindApi(conn.id, ca.cookie, { teamId: team2, sourceTeamId: "982" });
    await waitFor(() => src2.calls.length === 1);
    const byPlatform = await bindApi(conn.id, pa.cookie, { teamId: team2, sourceTeamId: "982" });
    assert.deepEqual([byPlatform.status, byPlatform.body.error], [409, "try_again"], "the row is held: at once, without a request");
    g2.release();
    assert.equal((await byClub).status, 201);
    assert.equal(src2.calls.length, 1);
    assert.equal((await bindingsOf(conn.id)).length, 2);
  } finally {
    service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
  }
  await endBindings(conn.id, ca.id);
});

test("12. a bind while a Test of the same connection is at the source (another admin): try_again at once, zero requests; a Test while a bind is at the source: the same; a Reconnect too", async () => {
  const { club, team } = await org();
  const ca = await clubAdmin(club);
  const pa = await platformAdmin();
  const conn = await verified(ca, club);
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 10_000, testTimeout: 10_000 });
  try {
    const g = gate();
    const src = useSource({ listGate: g });
    const testing = api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {}, allowed: [SOURCE_TEAM_NAME_MARKER] });
    await waitFor(() => src.calls.length === 1);
    const bind = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    assert.deepEqual([bind.status, bind.body.error], [409, "try_again"]);
    assert.equal(src.calls.length, 1);
    g.release();
    assert.equal((await testing).status, 200);
    const g2 = gate();
    const src2 = useSource({ teamGate: g2 });
    const binding = bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    await waitFor(() => src2.calls.length === 1);
    const t = await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} });
    assert.deepEqual([t.status, t.body.error], [409, "try_again"]);
    const rc = await api(`/gpexe/connections/${conn.id}/reconnect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD, confirmation: { sourceSystem: "gpexe", ownerClubId: club, affectedTeamCount: 0 } } });
    assert.deepEqual([rc.status, rc.body.error], [409, "try_again"]);
    assert.equal(src2.calls.length, 1, "neither sent anything");
    g2.release();
    assert.equal((await binding).status, 201);
  } finally {
    service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
  }
  await endBindings(conn.id, ca.id);
});

test("13. the team while a bind is at the source: a move to another club is refused at once by the team's try-lock (never a wait), an archive goes through and the bind then answers the standard 404 with nothing bound but audited and counted (a refused credential still turns the connection to needs_reconnect); after a committed bind the move is refused by the database; a bind against a running move answers try_again at once with zero requests", async () => {
  const { club, team } = await org();
  const other = await org({ approve: false });
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 10_000, testTimeout: 10_000 });
  const peer = new pg.Client({ connectionString: db.url });
  await peer.connect();
  try {
    const g = gate();
    const src = useSource({ teamGate: g });
    const pending = bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    await waitFor(() => src.calls.length === 1);
    await peer.query("begin");
    await peer.query(`set local lock_timeout = '300ms'`);
    const started = Date.now();
    const move = await peer.query(`update public.teams set club_id = $1 where id = $2`, [other.club, team]).then(() => null, (e) => e.code);
    assert.equal(move, "P0001", "the move is refused at once by the team's try-lock the bind holds");
    assert.ok(Date.now() - started < 250, "no wait on a row");
    await peer.query("rollback");
    await peer.query("begin");
    await peer.query(`set local lock_timeout = '300ms'`);
    const renamed = await peer.query(`update public.teams set name = name || ' (renamed)' where id = $1`, [team]).then(() => null, (e) => e.code);
    assert.equal(renamed, null, "a rename never waits behind the source");
    await peer.query("rollback");
    await peer.query(`update public.teams set is_active = false where id = $1`, [team]);
    g.release();
    const archivedMeanwhile = await pending;
    assert.deepEqual([archivedMeanwhile.status, archivedMeanwhile.body.error], [404, "notFound"], "the team archived while the source answered: nothing bound");
    assert.deepEqual(await bindingsOf(conn.id), []);
    const archivedRow = (await auditOf(conn.id)).filter((a) => a.action === "bind").at(-1);
    assert.deepEqual([archivedRow.outcome, archivedRow.error_code, archivedRow.team_id, archivedRow.metadata.counted, archivedRow.metadata.attempt_no], ["failed", "team_not_available", team, true, 2], "the source was reached: audited and counted, the answer still the standard 404");
    // The same race with a refused credential: the connection becomes needs_reconnect before the 404.
    await peer.query(`update public.teams set is_active = true where id = $1`, [team]);
    const g3 = gate();
    const src3 = useSource({ teamGate: g3, teamRead: "401" });
    const pending3 = bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    await waitFor(() => src3.calls.length === 1);
    await peer.query(`update public.teams set is_active = false where id = $1`, [team]);
    g3.release();
    assert.equal((await pending3).status, 404);
    assert.equal((await rowOf(conn.id)).state, "needs_reconnect", "the refused credential is not lost behind the 404");
    await q(`update training_load.source_credential_connections set state = 'verified', last_error_code = null, last_error_at = null where id = $1`, [conn.id]);
    await peer.query(`update public.teams set is_active = true where id = $1`, [team]);
    useSource();
    assert.equal((await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" })).status, 201);
    const moveAfter = await peer.query(`update public.teams set club_id = $1 where id = $2`, [other.club, team]).then(() => null, (e) => e);
    assert.equal(moveAfter?.code, "23514", "the database refuses the move while the binding is active");
    assert.match(moveAfter.message, /end that binding before moving the team/);
    await endBindings(conn.id, ca.id);
    // A move running (holding the team row and the team's try-lock) makes a new bind answer try_again.
    await peer.query("begin");
    await peer.query(`update public.teams set club_id = $1 where id = $2`, [other.club, team]);
    const src2 = useSource();
    const r = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    assert.deepEqual([r.status, r.body.error, src2.calls.length], [409, "try_again", 0]);
    await peer.query("rollback");
  } finally {
    await peer.end();
    service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
  }
});

test("14. the club archived, or the club admin's role revoked, while the chosen team was being read: 409 rights_changed, nothing bound, audited as failed with the team; the platform admin's revoked right the same", async () => {
  const { club, team } = await org();
  const ca = await clubAdmin(club);
  const pa = await platformAdmin();
  const conn = await verified(ca, club);
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 10_000, testTimeout: 10_000 });
  try {
    const run = async (cookie, revoke, restore) => {
      const g = gate();
      const src = useSource({ teamGate: g });
      const pending = bindApi(conn.id, cookie, { teamId: team, sourceTeamId: "981" });
      await waitFor(() => src.calls.length === 1);
      await revoke();
      g.release();
      const r = await pending;
      assert.deepEqual([r.status, r.body.error], [409, "rights_changed"], JSON.stringify(r.body));
      assert.deepEqual(await bindingsOf(conn.id), [], "nothing bound");
      const last = (await auditOf(conn.id)).at(-1);
      assert.deepEqual([last.action, last.outcome, last.error_code, last.team_id], ["bind", "failed", "rights_changed", team]);
      await restore();
    };
    await run(ca.cookie, () => q(`update public.user_club_roles set is_active = false where user_id = $1`, [ca.id]), () => q(`update public.user_club_roles set is_active = true where user_id = $1`, [ca.id]));
    await run(ca.cookie, () => q(`update public.clubs set is_active = false where id = $1`, [club]), () => q(`update public.clubs set is_active = true where id = $1`, [club]));
    await run(pa.cookie, () => q(`update public.user_global_roles set is_active = false where user_id = $1`, [pa.id]), () => q(`update public.user_global_roles set is_active = true where user_id = $1`, [pa.id]));
  } finally {
    service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
  }
});

test("15. a Check now / import / settings change holding the team's lock: the bind answers try_again with zero requests and nothing written; the binding trigger's own try-lock is the backstop for a raw insert; a lock held on an already BOUND team of the connection refuses a bind of another team the same way", async () => {
  const { club, team, team2 } = await org();
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  const peer = new pg.Client({ connectionString: db.url });
  await peer.connect();
  try {
    await peer.query("begin");
    await peer.query(`select training_load.hold_gpexe_team_lock($1, 'check')`, [team]);
    const src = useSource();
    const r = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    assert.deepEqual([r.status, r.body.error, r.body.teamId, src.calls.length], [409, "try_again", team, 0]);
    assert.deepEqual(await bindingsOf(conn.id), []);
    const raw = await admin.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe','981',$3)`, [team, conn.id, ca.id]).then(() => null, (e) => e.code);
    assert.equal(raw, "P0001", "the database's own try-lock refuses a raw insert while the team is busy");
    await peer.query("rollback");
  } finally {
    await peer.end();
  }
  assert.equal((await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" })).status, 201, "free again");
  // A bind of ANOTHER team of the connection while a BOUND team's lock is held: the bound teams are locked too (the credential-attempt rule), so try_again, zero requests, nothing written.
  const peer2 = new pg.Client({ connectionString: db.url });
  await peer2.connect();
  try {
    await peer2.query("begin");
    await peer2.query(`select training_load.hold_gpexe_team_lock($1, 'import')`, [team]);
    const src2 = useSource();
    const r2 = await bindApi(conn.id, ca.cookie, { teamId: team2, sourceTeamId: "982" });
    assert.deepEqual([r2.status, r2.body.error, r2.body.teamId, src2.calls.length], [409, "try_again", team, 0], "the busy BOUND team is named, not the target");
    assert.equal((await bindingsOf(conn.id)).length, 1);
    await peer2.query("rollback");
  } finally {
    await peer2.end();
  }
  await endBindings(conn.id, ca.id);
});

// ---------------------------------------------------------------------------
// 18. The COMMIT outcome
// ---------------------------------------------------------------------------
test("16. the COMMIT answer lost but the row committed: 201 with commitConfirmation verified_after_commit_error and one binding; an unverifiable COMMIT: 503 outcome_unknown naming the team, a second unknown audit row with the team, and the retry answers the same binding without a second row or request", async () => {
  const { club, team, team2 } = await org();
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  useSource();
  service.setSourceConnectionCommitForTests({ fault: async (client) => { await client.query("commit"); await new Promise(() => {}); }, timeoutMs: 200 });
  try {
    const r = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.result.commitConfirmation, "verified_after_commit_error");
  } finally {
    service.setSourceConnectionCommitForTests();
  }
  assert.equal((await bindingsOf(conn.id)).length, 1);
  service.setSourceConnectionCommitForTests({
    fault: async (client) => { await client.query("commit"); await new Promise(() => {}); }, timeoutMs: 200,
    checkFault: async () => { await new Promise(() => {}); }, checkTimeoutMs: 200,
  });
  try {
    const r = await bindApi(conn.id, ca.cookie, { teamId: team2, sourceTeamId: "982" });
    assert.deepEqual([r.status, r.body.error, r.body.teamId, r.body.connectionId], [503, "outcome_unknown", team2, conn.id], JSON.stringify(r.body));
  } finally {
    service.setSourceConnectionCommitForTests();
  }
  const rows = (await auditOf(conn.id)).filter((a) => a.action === "bind" && a.team_id === team2);
  assert.deepEqual(rows.map((a) => [a.outcome, a.error_code]), [["ok", null], ["unknown", "outcome_unknown"]]);
  assert.equal(rows[0].metadata.attempt_id, rows[1].metadata.attempt_id, "one attempt, two rows");
  const src = useSource();
  const retry = await bindApi(conn.id, ca.cookie, { teamId: team2, sourceTeamId: "982" });
  assert.deepEqual([retry.status, retry.body.result?.idempotent, src.calls.length], [200, true, 0]);
  assert.equal((await bindingsOf(conn.id)).length, 2, "the retry made no second row");
  await endBindings(conn.id, ca.id);
});

// ---------------------------------------------------------------------------
// 19–22. Reads, the platform path, the suite's own safety
// ---------------------------------------------------------------------------
test("17. GET after bindings carries only the allowed binding fields and the connection's safe facts; the list route the same; a coach still gets 404", async () => {
  const { club, team, team2 } = await org();
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  useSource();
  assert.equal((await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" })).status, 201);
  assert.equal((await bindApi(conn.id, ca.cookie, { teamId: team2, sourceTeamId: "982" })).status, 201);
  await q(`update public.teams set is_active = false where id = $1`, [team2]);
  for (const path of [`/gpexe/connections/${conn.id}`, `/gpexe/connections?clubId=${club}`]) {
    const r = await api(path, { cookie: ca.cookie });
    assert.equal(r.status, 200);
    const c = r.body.connection ?? r.body.connections[0];
    assert.deepEqual(Object.keys(c).sort(), ["accountLabel", "boundTeams", "createdAt", "credentialKind", "hasCredential", "hostKey", "hostLabel", "id", "lastErrorAt", "lastErrorCode", "lastVerifiedAt", "ownerClubId", "ownerScope", "sourceSystem", "state", "updatedAt"]);
    assert.deepEqual(c.boundTeams.map((b) => Object.keys(b).sort()), [BINDING_KEYS, BINDING_KEYS]);
    assert.deepEqual(c.boundTeams.map((b) => [b.sourceTeamId, b.teamActive]).sort(), [["981", true], ["982", false]]);
    assert.ok(!JSON.stringify(r.body).includes(SOURCE_TEAM_NAME_MARKER), "the source's own team names are not stored or shown here");
  }
  assert.equal((await api(`/gpexe/connections/${conn.id}`, { cookie: (await coachOf(team)).cookie })).status, 404);
  await endBindings(conn.id, ca.id);
});

test("18. the platform admin path: create, connect, test and bind for a club with basis platform_admin in every audit row; the club admin's own create for their club is 201 and for another club 404; a club admin sees sourceTeams after Test as well", async () => {
  const { club, team } = await org();
  const other = await org({ approve: false });
  const pa = await platformAdmin();
  const ca = await clubAdmin(club);
  const conn = await verified(pa, club);
  useSource();
  const t = await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: ca.cookie, body: {}, allowed: [SOURCE_TEAM_NAME_MARKER] });
  assert.equal(t.status, 200);
  assert.equal(t.body.result.sourceTeams.length, 2, "the club admin sees the two approved pairs of the club, not the eight teams");
  assert.deepEqual(Object.keys(t.body.result.sourceTeams[0]).sort(), TEAM_ENTRY_KEYS);
  const r = await bindApi(conn.id, pa.cookie, { teamId: team, sourceTeamId: "981" });
  assert.equal(r.status, 201);
  const audit = await auditOf(conn.id);
  assert.deepEqual(audit.map((a) => [a.action, a.basis]), [["create", "platform_admin"], ["connect", "platform_admin"], ["test", "club_admin"], ["bind", "platform_admin"]]);
  assert.equal((await api("/gpexe/connections", { method: "POST", cookie: ca.cookie, body: CREATE(club) })).status, 201);
  assert.equal((await api("/gpexe/connections", { method: "POST", cookie: ca.cookie, body: CREATE(other.club) })).status, 404);
  await endBindings(conn.id, pa.id);
});

test("21. a bind that reaches the source and does not succeed counts in the 5 / 15 min window: after the connect and four failed binds the next bind is 429 with zero requests (audited uncounted); once the window has passed it goes through; a successful bind never counts", async () => {
  const { club, team, team2 } = await org();
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  useSource({ teamRead: "500" });
  for (let i = 2; i <= 5; i += 1) {
    const r = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
    assert.deepEqual([r.status, r.body.error], [502, "source_unavailable"], `attempt ${i}`);
    assert.equal((await auditOf(conn.id)).at(-1).metadata.attempt_no, i);
  }
  const src = useSource();
  const sixth = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
  assert.deepEqual([sixth.status, sixth.body.error, sixth.headers.get("retry-after"), src.calls.length], [429, "source_auth_throttled", "900", 0]);
  const last = (await auditOf(conn.id)).at(-1);
  assert.deepEqual([last.action, last.outcome, last.error_code, last.team_id, last.metadata.counted], ["bind", "refused", "source_auth_throttled", team, false]);
  service.setSourceConnectionClockForTests(() => new Date(Date.now() + 16 * 60 * 1000));
  try {
    assert.equal((await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" })).status, 201);
    assert.equal((await bindApi(conn.id, ca.cookie, { teamId: team2, sourceTeamId: "982" })).status, 201);
    assert.equal((await auditOf(conn.id)).at(-1).metadata.attempt_no, 1, "a successful bind did not count: the second one is still attempt 1 of the moved window");
  } finally {
    service.setSourceConnectionClockForTests(null);
  }
  await endBindings(conn.id, ca.id);
});

test("22. the unique-index backstop of the INSERT: with v30 no valid row can clash any more (one OptiMove team per canonical GPEXE team, one binding per team through the team lock, the pair enforced by the database), so the exact-name mapping is proven through the insert seam: a 23505 on source_team_bindings_one_active_per_source_team → 409 source_team_already_bound, on ..._one_active_per_team_source → team_already_bound, any other unique violation → binding_refused; each audited failed with the team and counted, nothing bound; a clashing raw row itself is refused by the v30 pair trigger", async () => {
  const { club, team, team2 } = await org();
  const ca = await clubAdmin(club);
  const a = await verified(ca, club);
  const b = await verified(ca, club);
  // A raw clash of the same source team on another team is no longer possible: team2 is approved for 982.
  const raw = await admin.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1, $2, 'gpexe', '981', $3, $1)`, [team2, b.id, ca.id]).then(() => null, (e) => e);
  assert.deepEqual([raw?.code, raw?.constraint], ["23514", "source_team_bindings_approved_pair"], "the database refuses the clashing row before any index is reached");
  assert.deepEqual((await q(`select indexname from pg_indexes where schemaname = 'training_load' and tablename = 'source_team_bindings' and indexname like 'source_team_bindings_one_active_%' order by 1`)).map((r) => r.indexname), ["source_team_bindings_one_active_per_source_team", "source_team_bindings_one_active_per_team_source"], "the names the mapping relies on exist in the catalog");
  const unique = (constraint) => Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", constraint });
  service.setSourceConnectionClockForTests(() => new Date(Date.now() + 16 * 60 * 1000));
  try {
    for (const [constraint, code] of [["source_team_bindings_one_active_per_source_team", "source_team_already_bound"], ["source_team_bindings_one_active_per_team_source", "team_already_bound"], ["some_other_unique_key", "binding_refused"]]) {
      service.setSourceBindingInsertFaultForTests(async () => { throw unique(constraint); });
      let r;
      try {
        const src = useSource();
        r = await bindApi(a.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
        assert.deepEqual(teamReads(src.calls), ["team/981/"]);
      } finally {
        service.setSourceBindingInsertFaultForTests(null);
      }
      assert.deepEqual([r.status, r.body.error, r.body.teamId], [409, code, team], JSON.stringify(r.body));
      assert.ok(!JSON.stringify(r.body).includes("duplicate key"), "never the database's text");
      assert.deepEqual(await bindingsOf(a.id), []);
      const last = (await auditOf(a.id)).at(-1);
      assert.deepEqual([last.action, last.outcome, last.error_code, last.team_id, last.metadata.counted, last.metadata.source_team_id], ["bind", "failed", code, team, true, "981"]);
    }
  } finally {
    service.setSourceConnectionClockForTests(null);
  }
  assert.equal((await q(`select count(*)::int as n from training_load.source_team_bindings where source_team_id = '981' and state = 'active'`))[0].n, 0, "nothing bound");
});

test("23. the allowlist decision across clubs: two clubs on the same shared account each see only their own approved pairs after Connect and Test (no name, id or count of the other club's or of the unapproved teams); a platform admin sees the bounded list with the approved pair per row and the truncation flag, but cannot bind outside the pair either", async () => {
  const first = await org();
  const second = await org({ approve: false });
  await approvePair(second.team, "983", second.configurer);
  const caFirst = await clubAdmin(first.club);
  const caSecond = await clubAdmin(second.club);
  const pa = await platformAdmin();
  const connFirst = await verified(caFirst, first.club);
  const connSecond = await verified(caSecond, second.club);
  useSource();
  const tFirst = await api(`/gpexe/connections/${connFirst.id}/test`, { method: "POST", cookie: caFirst.cookie, body: {}, allowed: [SOURCE_TEAM_NAME_MARKER] });
  assert.deepEqual(tFirst.body.result.sourceTeams.map((t) => [t.sourceTeamId, t.approvedTeamId]), [["981", first.team], ["982", first.team2]]);
  assert.equal(tFirst.body.result.sourceTeamCount, 2);
  otherTeamFacts(JSON.stringify(tFirst.body), ["981", "982"]);
  const tSecond = await api(`/gpexe/connections/${connSecond.id}/test`, { method: "POST", cookie: caSecond.cookie, body: {}, allowed: [SOURCE_TEAM_NAME_MARKER] });
  assert.deepEqual(tSecond.body.result.sourceTeams.map((t) => [t.sourceTeamId, t.approvedTeamId]), [["983", second.team]]);
  assert.equal(tSecond.body.result.sourceTeamCount, 1);
  otherTeamFacts(JSON.stringify(tSecond.body), ["983"]);
  // The platform admin: the whole bounded list, annotated; truncation reported.
  const tPa = await api(`/gpexe/connections/${connFirst.id}/test`, { method: "POST", cookie: pa.cookie, body: {}, allowed: [SOURCE_TEAM_NAME_MARKER] });
  assert.equal(tPa.body.result.sourceTeamCount, 8);
  assert.equal(tPa.body.result.sourceTeams.length, 8);
  assert.deepEqual(Object.keys(tPa.body.result.sourceTeams[0]).sort(), TEAM_ENTRY_KEYS);
  assert.deepEqual(tPa.body.result.sourceTeams.filter((t) => t.approvedTeamId).map((t) => t.sourceTeamId), ["981", "982"], "only this club's pairs are matched, never the other club's 983");
  assert.equal(tPa.body.result.sourceTeamsTruncated, false);
  // A truncated source list is reported to both, and the club admin's filtering does not hide it.
  const many = useSource({ teams: Array.from({ length: 100 }, (_, i) => 1000 + i).concat([981]) });
  many.calls.length = 0;
  service.setSourceFetchForTests(async (url, init) => {
    const u = String(url);
    if (u === `${BASE}team/`) return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i === 0 ? 981 : 1000 + i }))), { status: 200, headers: { "content-type": "application/json", "x-total-count": "250" } });
    return many.fetchImpl(url, init);
  });
  const truncated = await api(`/gpexe/connections/${connFirst.id}/test`, { method: "POST", cookie: caFirst.cookie, body: {} });
  assert.equal(truncated.status, 200, JSON.stringify(truncated.body));
  assert.deepEqual([truncated.body.result.sourceTeamsTruncated, truncated.body.result.sourceTeams.map((t) => t.sourceTeamId), truncated.body.result.sourceTeamCount], [true, ["981"], 1]);
  // The platform admin cannot bind outside the pair: 983 is not approved for first.team.
  const src = useSource();
  const outside = await bindApi(connFirst.id, pa.cookie, { teamId: first.team, sourceTeamId: "983" });
  assert.deepEqual([outside.status, outside.body.error, src.calls.length], [409, "team_setting_mismatch", 0]);
  assert.equal((await bindApi(connFirst.id, pa.cookie, { teamId: first.team, sourceTeamId: "981" })).status, 201, "the approved pair binds for the platform admin too");
  await endBindings(connFirst.id, pa.id);
});

test("24. the allowlist and the binding in both orders: a Settings change to another GPEXE team is refused (409 gpexe_team_bound) while the binding is active, through the service and by the v30 trigger for a raw UPDATE; the same value stays idempotent (no history row); without an active binding the change works with a reason and the following bind must name the new pair; a Settings change in flight makes the bind answer try_again, and a bind in flight makes the Settings change answer busy", async () => {
  const { club, team, team2, configurer } = await org();
  const ca = await clubAdmin(club);
  const pa = await platformAdmin();
  const conn = await verified(ca, club);
  useSource();
  assert.equal((await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" })).status, 201);
  const historyBefore = (await q(`select count(*)::int as n from training_load.gpexe_team_settings_history where owner_team_id = $1`, [team]))[0].n;
  // Order A: binding first, then a change of the approved pair.
  const changed = await settings.setTeamSettings(team, { gpexeTeamId: "983", reason: "test change", userId: pa.id }).then(() => null, (e) => e);
  assert.deepEqual([changed?.status, changed?.code], [409, "gpexe_team_bound"], String(changed?.message));
  assert.ok(!/sql|constraint|trigger|exception/i.test(changed.message), "an administrator sentence, not a database text");
  const raw = await admin.query(`update training_load.gpexe_team_settings set gpexe_team_id = '983', change_reason = 'raw' where owner_team_id = $1`, [team]).then(() => null, (e) => e);
  assert.deepEqual([raw?.code, raw?.constraint], ["23514", "gpexe_team_settings_bound_team_final"], "the database's own backstop");
  const rawLeadingZero = await admin.query(`update training_load.gpexe_team_settings set gpexe_team_id = '0981', change_reason = 'raw leading zero' where owner_team_id = $1`, [team]).then(() => null, (e) => e);
  assert.equal(rawLeadingZero, null, "the same canonical value is not a change for v30");
  await admin.query(`update training_load.gpexe_team_settings set gpexe_team_id = '981', change_reason = 'raw restore' where owner_team_id = $1`, [team]);
  const same = await settings.setTeamSettings(team, { gpexeTeamId: "981", userId: pa.id });
  assert.equal(same.gpexeTeamId ?? same.gpexe_team_id ?? "981", "981");
  assert.equal((await q(`select gpexe_team_id from training_load.gpexe_team_settings where owner_team_id = $1`, [team]))[0].gpexe_team_id, "981");
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_team_settings_history where owner_team_id = $1`, [team]))[0].n, historyBefore + 2, "only the two raw statements above wrote history (the leading-zero write and its restore); the idempotent service call wrote none");
  // Order B: no active binding → the change works (with a reason, history grows), and the bind must then name the new pair.
  await endBindings(conn.id, ca.id);
  await settings.setTeamSettings(team, { gpexeTeamId: "983", reason: "team moved to another GPEXE team", userId: pa.id });
  assert.equal((await q(`select gpexe_team_id from training_load.gpexe_team_settings where owner_team_id = $1`, [team]))[0].gpexe_team_id, "983");
  const src = useSource();
  const old = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" });
  assert.deepEqual([old.status, old.body.error, src.calls.length], [409, "team_setting_mismatch", 0]);
  assert.equal((await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "983" })).status, 201);
  await endBindings(conn.id, ca.id);
  // Concurrency: a Settings change holding the team lock → the bind answers try_again at once; a bind at the source → the Settings change answers busy.
  const peer = new pg.Client({ connectionString: db.url });
  await peer.connect();
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 10_000, testTimeout: 10_000 });
  try {
    await peer.query("begin");
    await peer.query(`select training_load.hold_gpexe_team_lock($1, 'connection change')`, [team]);
    await peer.query(`update training_load.gpexe_team_settings set gpexe_team_id = '984', change_reason = 'in flight', configured_by_user_id = $2, configured_at = now() where owner_team_id = $1`, [team, configurer]);
    const src2 = useSource();
    const during = await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "983" });
    assert.deepEqual([during.status, during.body.error, src2.calls.length], [409, "try_again", 0]);
    await peer.query("rollback");
    const g = gate();
    const src3 = useSource({ teamGate: g });
    const pending = bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "983" });
    await waitFor(() => src3.calls.length === 1);
    const busy = await settings.setTeamSettings(team, { gpexeTeamId: "985", reason: "while a bind runs", userId: pa.id }).then(() => null, (e) => e);
    assert.deepEqual([busy?.status, busy?.code], [409, "gpexe_change_busy"], String(busy?.message));
    // A raw UPDATE of the approved id meanwhile waits on the settings row the bind holds FOR SHARE (lock_timeout → 55P03) and, once the bind committed, meets the v30 trigger.
    await peer.query("begin");
    await peer.query(`set local lock_timeout = '300ms'`);
    const rawDuring = await peer.query(`update training_load.gpexe_team_settings set gpexe_team_id = '986', change_reason = 'raw during bind' where owner_team_id = $1`, [team]).then(() => null, (e) => e.code);
    assert.equal(rawDuring, "55P03", "the raw UPDATE waits on the settings row the bind holds");
    await peer.query("rollback");
    g.release();
    assert.equal((await pending).status, 201);
    const rawAfter = await peer.query(`update training_load.gpexe_team_settings set gpexe_team_id = '986', change_reason = 'raw after bind' where owner_team_id = $1`, [team]).then(() => null, (e) => e);
    assert.deepEqual([rawAfter?.code, rawAfter?.constraint], ["23514", "gpexe_team_settings_bound_team_final"]);
    assert.equal((await q(`select gpexe_team_id from training_load.gpexe_team_settings where owner_team_id = $1`, [team]))[0].gpexe_team_id, "983", "the pair never diverged");
    // A canonical clash with another team's setting is the same conflict as the raw key: '0983' for team2 while team holds '983'.
    const clash = await settings.setTeamSettings(team2, { gpexeTeamId: "0983", reason: "clash", userId: pa.id }).then(() => null, (e) => e);
    assert.deepEqual([clash?.status, clash?.code], [409, "gpexe_team_taken"], String(clash?.message));
  } finally {
    await peer.end();
    service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
  }
  await endBindings(conn.id, ca.id);
});

test("25. migration v30 applies on v29 (two triggers, three functions, the canonical unique index), refuses to apply over canonical duplicates or over an unpaired active binding without changing anything, keeps the approved GPEXE team of a bound team final for a raw UPDATE (same canonical value allowed; no binding → allowed; v24 still refuses DELETE), makes the database itself refuse an active binding that is not the approved pair (wrong source team, no pointer, pointer to another team, no setting; a leading-zero setting still matches canonically), refuses a second setting of the same canonical GPEXE team, orders a settings change and a raw binding INSERT in both directions, rolls back to exactly the v29 catalog, applies again, refuses under a later migration and while an active binding relies on it; a file that fails at its last statement applies nothing", async () => {
  const m = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v30mig", migrations: UP_TO_V29 });
  const k = new pg.Client({ connectionString: m.url });
  await k.connect();
  try {
    assert.equal((await k.query("select current_database() as db")).rows[0].db, m.name);
    const catalog = async () => ({
      triggers: (await k.query(`select tgrelid::regclass::text as rel, tgname, pg_get_triggerdef(oid) as def from pg_trigger where tgrelid in ('training_load.gpexe_team_settings'::regclass, 'training_load.source_team_bindings'::regclass) and not tgisinternal order by 1, 2`)).rows,
      functions: (await k.query(`select p.proname, md5(pg_get_functiondef(p.oid)) as digest from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and (p.proname like '%gpexe_team%' or p.proname like '%gpexe_binding%') order by 1`)).rows,
      constraints: (await k.query(`select conname from pg_constraint where conrelid = 'training_load.gpexe_team_settings'::regclass order by 1`)).rows.map((r) => r.conname),
      indexes: (await k.query(`select indexname, indexdef from pg_indexes where schemaname = 'training_load' and tablename in ('gpexe_team_settings', 'source_team_bindings') order by 1`)).rows,
    });
    const v29 = await catalog();
    assert.ok(!v29.triggers.some((t) => t.tgname === "gpexe_team_settings_bound_team_final"));
    // Fixture: a club, a team with a setting, a verified-looking connection and an active binding.
    const club = (await k.query(`insert into public.clubs (name) values ('C') returning id`)).rows[0].id;
    const team = (await k.query(`insert into public.teams (club_id, name) values ($1, 'T') returning id`, [club])).rows[0].id;
    const user = (await k.query(`insert into public.users (email) values ('u@test.local') returning id`)).rows[0].id;
    await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, '981', $2)`, [team, user]);
    const parts = cryptoMod.encryptCredential(TOKEN, { connectionId: "00000000-0000-0000-0000-000000000001", ownerScope: "club", ownerClubId: club, ownerTeamId: null, sourceSystem: "gpexe", hostKey: "server3", credentialKind: "exchanged_token" }, cryptoMod.parseKeyring(cryptoMod.generateKeyEntry(1)));
    const connId = (await k.query(
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state, credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','club',$1,'server3','L','exchanged_token',$2,'verified',$3,$4,$5,$6, now()) returning id`,
      [club, user, parts.ciphertext, parts.nonce, parts.authTag, parts.keyVersion],
    )).rows[0].id;
    const bind = () => k.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1, $2, 'gpexe', '981', $3, $1) returning id`, [team, connId, user]);
    const unbind = () => k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'test' where team_id = $1 and state = 'active'`, [team, user]);
    const change = (value) => k.query(`update training_load.gpexe_team_settings set gpexe_team_id = $2, change_reason = 'test', configured_by_user_id = $3, configured_at = now() where owner_team_id = $1`, [team, value, user]);
    // Before v30 the gaps are real: the approved team changes under an active binding, a binding needs no pair,
    // and "0981" can sit next to "981".
    await bind();
    await change("982");
    await change("981");
    await unbind();
    const team2 = (await k.query(`insert into public.teams (club_id, name) values ($1, 'T2') returning id`, [club])).rows[0].id;
    const team3 = (await k.query(`insert into public.teams (club_id, name) values ($1, 'T3') returning id`, [club])).rows[0].id;
    const unpaired = (await k.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1, $2, 'gpexe', '555', $3) returning id`, [team2, connId, user])).rows[0].id;
    // The migration refuses to apply over an ACTIVE binding that is not its team's approved pair, and changes nothing.
    await assert.rejects(applyGpexeTestMigrations(m.url, [...UP_TO_V29, V30]), /ABORT while applying .*v30.*SQLSTATE P0001/);
    assert.deepEqual(await catalog(), v29, "a v30 refused over an unpaired active binding leaves the v29 catalog");
    await k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'test' where id = $1`, [unpaired, user]);
    await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, '0981', $2)`, [team2, user]);
    // The migration refuses canonical duplicates and changes nothing.
    // The runner reports the SQLSTATE of the refusing statement (P0001 from the duplicate check), never its text.
    await assert.rejects(applyGpexeTestMigrations(m.url, [...UP_TO_V29, V30]), /ABORT while applying .*v30.*SQLSTATE P0001/);
    const refusedDirectly = await k.query(`do $$ declare dups integer; begin select count(*) into dups from (select training_load.gpexe_team_id_canonical(gpexe_team_id) c from training_load.gpexe_team_settings group by 1 having count(*) > 1) d; if dups > 0 then raise exception 'dups %', dups; end if; end $$`).then(() => "no-function-yet", (e) => e.code);
    assert.equal(refusedDirectly, "42883", "before v30 the canonical function does not exist: the refusal came from the migration's own check");
    assert.deepEqual(await catalog(), v29, "a refused v30 leaves the v29 catalog");
    assert.equal((await k.query(`select count(*)::int as n from public.schema_migrations where migration_name like $1`, [`%${V30}`])).rows[0].n, 0);
    await k.query(`update training_load.gpexe_team_settings set gpexe_team_id = '982', change_reason = 'resolved by hand' where owner_team_id = $1`, [team2]);

    await applyGpexeTestMigrations(m.url, [...UP_TO_V29, V30]);
    const v30 = await catalog();
    assert.ok(v30.triggers.some((t) => t.tgname === "gpexe_team_settings_bound_team_final"));
    assert.ok(v30.triggers.some((t) => t.tgname === "source_team_bindings_check_pair"));
    assert.ok(v30.indexes.some((i) => i.indexname === "gpexe_team_settings_canonical_team_id_key"));
    assert.deepEqual(v30.triggers.filter((t) => t.rel.endsWith("source_team_bindings")).map((t) => t.tgname), ["source_team_bindings_check_owner", "source_team_bindings_check_pair", "source_team_bindings_immutable", "source_team_bindings_no_truncate"], "the pair check fires after the owner check (the team try-lock)");
    // The approved pair on INSERT: the correct pair passes; everything else is refused by the database.
    const rawBind = (teamId, sourceTeamId, pointer) => k.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1, $2, 'gpexe', $3, $4, $5) returning id`, [teamId, connId, sourceTeamId, user, pointer]).then((r) => r.rows[0].id, (e) => e);
    const pairError = async (promise, what, constraint = "source_team_bindings_approved_pair") => { const e = await promise; assert.deepEqual([e?.code, e?.constraint], ["23514", constraint], what); };
    await pairError(rawBind(team, "982", team), "a wrong source team");
    await pairError(rawBind(team, "981", null), "no pointer");
    await pairError(rawBind(team3, "983", team3), "no setting for the team (its own guard, named apart)", "source_team_bindings_approved_pair_missing");
    const foreignPointer = await rawBind(team, "981", team2);
    assert.equal(foreignPointer?.code, "23514", "a pointer to another team's setting (v27 refuses it first)");
    assert.notEqual(foreignPointer?.constraint, "source_team_bindings_approved_pair");
    const paired = await rawBind(team, "981", team);
    assert.match(String(paired), /^[0-9a-f-]{36}$/, "the exact pair passes");
    await k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'test' where id = $1`, [paired, user]);
    // A leading-zero setting still matches its canonical binding.
    await change("0981");
    const canonicalPair = await rawBind(team, "981", team);
    assert.match(String(canonicalPair), /^[0-9a-f-]{36}$/, "'0981' approves binding '981'");
    await k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'test' where id = $1`, [canonicalPair, user]);
    await change("981");
    // An ended row is outside the rule (history), an active one is not.
    const endedUnpaired = await k.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, state, ended_at, ended_by_user_id, end_reason) values ($1, $2, 'gpexe', '777', $3, 'ended', now(), $3, 'history') returning id`, [team3, connId, user]).then(() => null, (e) => e);
    assert.equal(endedUnpaired, null, "an already-ended row is not an active binding");
    // Canonical uniqueness of the settings: '0981' next to '981' is one GPEXE team.
    const dup = await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, '0981', $2)`, [team3, user]).then(() => null, (e) => e);
    assert.deepEqual([dup?.code, dup?.constraint], ["23505", "gpexe_team_settings_canonical_team_id_key"]);
    // A settings change and a raw binding INSERT in both orders, never a mismatch and never a wait without a bound.
    const peer = new pg.Client({ connectionString: m.url });
    await peer.connect();
    try {
      await peer.query("begin");
      await peer.query(`update training_load.gpexe_team_settings set gpexe_team_id = '0981', change_reason = 'in flight', configured_by_user_id = $2, configured_at = now() where owner_team_id = $1`, [team, user]);
      await k.query("begin");
      await k.query(`set local lock_timeout = '300ms'`);
      const insertDuring = await k.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1, $2, 'gpexe', '981', $3, $1)`, [team, connId, user]).then(() => null, (e) => e.code);
      assert.ok(["P0001", "55P03"].includes(insertDuring), `a binding INSERT during a settings change is refused or waits only within lock_timeout (${insertDuring})`);
      await k.query("rollback");
      await peer.query("rollback");
      await peer.query("begin");
      await peer.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1, $2, 'gpexe', '981', $3, $1)`, [team, connId, user]);
      await k.query("begin");
      await k.query(`set local lock_timeout = '300ms'`);
      const changeDuring = await change("982").then(() => null, (e) => e.code);
      assert.ok(["P0001", "55P03"].includes(changeDuring), `a settings change during a binding INSERT is refused at once or waits only within lock_timeout (${changeDuring})`);
      await k.query("rollback");
      await peer.query("commit");
      const changeAfter = await change("982").then(() => null, (e) => e);
      assert.deepEqual([changeAfter?.code, changeAfter?.constraint], ["23514", "gpexe_team_settings_bound_team_final"], "once the binding committed, the approved team is final");
      await unbind();
      // The waiter that CONTINUES: a settings UPDATE that changes nothing still holds the row (no team lock, so the
      // INSERT really waits on FOR SHARE); once it commits the INSERT re-reads the committed row and is decided by it.
      await peer.query("begin");
      await peer.query(`update training_load.gpexe_team_settings set gpexe_team_id = '981' where owner_team_id = $1`, [team]);
      const waiting = k.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1, $2, 'gpexe', '981', $3, $1) returning id`, [team, connId, user]);
      await new Promise((r) => setTimeout(r, 300));
      await peer.query("commit");
      const waited = await waiting.then((r) => r.rows[0].id, (e) => e);
      assert.match(String(waited), /^[0-9a-f-]{36}$/, "the waiter continued and the pair, unchanged, passed");
      await unbind();
      // A real id change always takes the team try-lock (v24), so an INSERT or a settings change never waits on it: it is refused at once (asserted above).
    } finally {
      await peer.end();
    }
    assert.equal((await k.query(`select training_load.gpexe_team_id_canonical('0980') as c`)).rows[0].c, "980");
    assert.equal((await k.query(`select training_load.gpexe_team_id_canonical('0') as c`)).rows[0].c, "0");
    // The invariant: bound → the approved team is final; same canonical value passes; no binding → a change passes; v24 still refuses DELETE.
    await bind();
    const refused = await change("982").then(() => null, (e) => e);
    assert.deepEqual([refused?.code, refused?.constraint], ["23514", "gpexe_team_settings_bound_team_final"]);
    await change("0981");
    assert.equal((await k.query(`select gpexe_team_id from training_load.gpexe_team_settings where owner_team_id = $1`, [team])).rows[0].gpexe_team_id, "0981");
    await change("981");
    await assert.rejects(k.query(`delete from training_load.gpexe_team_settings where owner_team_id = $1`, [team]), /never deleted/);
    // The rollback refuses while the protection is needed.
    const rollbackSql = await fsp.readFile(V30_ROLLBACK, "utf8");
    await assert.rejects(k.query(rollbackSql), /v30 rollback refused: 1 active gpexe binding/);
    await k.query("rollback").catch(() => {});
    assert.deepEqual(await catalog(), v30, "a refused rollback drops nothing");
    await unbind();
    await change("984");
    await change("981");
    // Rollback: exactly the v29 catalog again; apply again; refuse under a later migration.
    await k.query(rollbackSql);
    assert.deepEqual(await catalog(), v29, "the rollback leaves exactly the v29 triggers, functions and constraints of the settings table");
    assert.equal((await k.query(`select count(*)::int as n from public.schema_migrations where migration_name like $1`, [`%${V30}`])).rows[0].n, 0);
    await applyGpexeTestMigrations(m.url, [...UP_TO_V29, V30]);
    assert.deepEqual(await catalog(), v30, "v30 applies again, identically");
    await k.query("begin");
    await k.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ('migrations_v2/209901010000_test_only_later.sql', repeat('0', 64), 0, 'test')`);
    await assert.rejects(k.query(rollbackSql), /v30 rollback refused: later migrations are applied/);
    await k.query("rollback").catch(() => {});
    assert.deepEqual(await catalog(), v30, "a refused rollback drops nothing");
    // Atomicity: the file's statements plus a failing last statement, in one transaction, leave nothing behind.
    await k.query(rollbackSql);
    const sql = await fsp.readFile(path.resolve(ROOT, "migrations_v2", V30), "utf8");
    assert.doesNotMatch(sql.replace(/[$][$][^]*?[$][$]/g, "<body>"), /https?:\/\/|SOURCE_CREDENTIAL_KEYS|^\s*(begin|commit|rollback)\b/im, "no URL, key or transaction control outside the function bodies");
    await k.query("begin");
    await assert.rejects(k.query(`${sql}\nselect 1/0;`), /division by zero/);
    await k.query("rollback");
    assert.deepEqual(await catalog(), v29, "nothing of the failed file was applied");
    await applyGpexeTestMigrations(m.url, [...UP_TO_V29, V30]);
    assert.deepEqual(await catalog(), v30);
  } finally {
    await k.end();
    await m.drop();
  }
});

test("26. '981' against '0981': the service refuses the second setting (409 gpexe_team_taken), the database refuses a raw one (23505 on the canonical index), and should such a duplicate exist anyway (the index dropped on this disposable database only), Connect / Test withhold the team list fail-closed (sourceTeamsUnavailable: approved_pairs_ambiguous) instead of letting one row win; a bind of the ambiguous pair is still decided by the exact canonical pair", async () => {
  const { club, team, team2, configurer } = await org();
  const ca = await clubAdmin(club);
  const conn = await verified(ca, club);
  const team3 = (await q(`insert into public.teams (club_id, name) values ($1, 'Third') returning id`, [club]))[0].id;
  const viaService = await settings.setTeamSettings(team3, { gpexeTeamId: "0981", userId: configurer }).then(() => null, (e) => e);
  assert.deepEqual([viaService?.status, viaService?.code], [409, "gpexe_team_taken"], String(viaService?.message));
  assert.ok(!/sql|constraint|index|duplicate/i.test(viaService.message));
  const rawDup = await admin.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, '0981', $2)`, [team3, configurer]).then(() => null, (e) => e);
  assert.deepEqual([rawDup?.code, rawDup?.constraint], ["23505", "gpexe_team_settings_canonical_team_id_key"]);
  await admin.query(`drop index training_load.gpexe_team_settings_canonical_team_id_key`);
  try {
    await approvePair(team3, "0981", configurer);
    useSource();
    const t = await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: ca.cookie, body: {} });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.deepEqual([t.body.result.state, t.body.result.sourceTeams, t.body.result.sourceTeamCount, t.body.result.sourceTeamsTruncated, t.body.result.sourceTeamsUnavailable], ["verified", null, null, null, "approved_pairs_ambiguous"]);
    const pa = await platformAdmin();
    const tPa = await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} });
    assert.equal(tPa.body.result.sourceTeamsUnavailable, "approved_pairs_ambiguous", "the platform admin's list is withheld too");
    assert.ok(!JSON.stringify(t.body).includes(SOURCE_TEAM_NAME_MARKER) && !JSON.stringify(tPa.body).includes(SOURCE_TEAM_NAME_MARKER), "nothing of the list leaves");
    // The exact pair of team still binds; team3's pair asks for "981" too (canonical of "0981") — the own-team settings decide, team by team.
    assert.equal((await bindApi(conn.id, ca.cookie, { teamId: team, sourceTeamId: "981" })).status, 201);
    await endBindings(conn.id, ca.id);
    releaseCounter += 1;
    await q(`update training_load.gpexe_team_settings set gpexe_team_id = $2, change_reason = 'test cleanup' where owner_team_id = $1`, [team3, String(920000000000 + releaseCounter)]);
  } finally {
    await admin.query(`create unique index gpexe_team_settings_canonical_team_id_key on training_load.gpexe_team_settings (training_load.gpexe_team_id_canonical(gpexe_team_id))`);
  }
  assert.equal((await q(`select count(*)::int as n from pg_indexes where schemaname = 'training_load' and indexname = 'gpexe_team_settings_canonical_team_id_key'`))[0].n, 1, "the index is back");
  void team2;
});

test("27. the audit fact `counted` agrees with the throttle's own predicate on every row this suite wrote (action / outcome / error_code decide the window; the metadata only documents it); the one divergence is an attempt whose COMMIT outcome stayed unknown — its ok row says false, its later unknown row true, and the window counts that attempt once by attempt_id", async () => {
  const rows = await q(`
    select id, action, outcome, error_code, metadata,
           (((action in ('connect', 'reconnect', 'test') and (outcome in ('ok', 'failed', 'unknown') or (outcome = 'refused' and error_code = 'source_auth_rejected')))
             or (action = 'bind' and (outcome in ('failed', 'unknown') or (outcome = 'refused' and error_code = 'source_auth_rejected'))))) as window_counts
      from training_load.source_connection_audit
     where action in ('connect', 'reconnect', 'test', 'bind')`);
  assert.ok(rows.length > 50, `enough rows to mean something (${rows.length})`);
  const disagreeing = rows.filter((r) => (r.metadata.counted === true) !== r.window_counts);
  for (const r of disagreeing) {
    assert.ok(r.outcome === "unknown" && r.error_code === "outcome_unknown", `only the second row of an unknown outcome may differ: ${r.action} ${r.outcome} ${r.error_code} ${JSON.stringify(r.metadata)}`);
    const sibling = rows.find((o) => o.id !== r.id && o.metadata.attempt_id === r.metadata.attempt_id);
    assert.ok(sibling && sibling.outcome === "ok" && sibling.metadata.counted === false, "its sibling is the committed ok row of a successful bind, which the window does not count; the attempt counts once by attempt_id");
  }
  assert.ok(rows.some((r) => r.action === "bind" && r.outcome === "ok" && r.metadata.counted === false), "a successful bind row says false");
  assert.ok(rows.some((r) => r.action === "bind" && r.outcome === "failed" && r.metadata.counted === true), "a failed source-reaching bind row says true");
  assert.ok(rows.some((r) => r.action === "bind" && r.outcome === "refused" && r.error_code !== "source_auth_rejected" && r.metadata.counted === false), "a local refusal says false");
});

test("19. this suite runs on a disposable database only and bound nothing persistent: the database is the disposable one and every binding it made is ended", async () => {
  assert.match((await q("select current_database() as db"))[0].db, DISPOSABLE_DB_NAME_PATTERN);
  assert.ok(db.url !== ORIGINAL_DATABASE_URL);
  assert.equal((await q(`select count(*)::int as n from training_load.source_team_bindings where state = 'active'`))[0].n, 0, "no binding left active");
});

test("20. no console line of the whole suite carries a secret marker, a source sentence or a source team name", () => {
  assert.ok(logLines.length >= 0);
  for (const line of logLines) noSecret(line, "a console line");
});

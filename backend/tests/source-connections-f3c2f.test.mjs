// F3c2f — the safe Unbind (POST …/connections/:id/bindings/:bindingId/unbind)
// on a disposable optimove_tests_gpexe_* database (never OPTIMOVE), against a
// fake source that must never be called. Contract:
// docs/ai/source-connections-f3c2-contract.md section 2.7; discovery
// docs/ai/source-connections-f3c2e-discovery.md section 7.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import * as cryptoMod from "../src/sourceCredentialCrypto.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const ORIGINAL_ACTIVE = process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V30_ROLLBACK = path.resolve(ROOT, "docs/runbooks/source-connections-v30-rollback.sql");
// The v30 rollback rehearsal needs a database whose LAST migration is v30 (it refuses under a later one by design).
const UP_TO_V30 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf("202610041000_training_load_v30_gpexe_team_settings_bound_final.sql") + 1);

const USERNAME = "marker-username-f3c2f@example.invalid";
const PASSWORD = "MARKER-password-f3c2f-not-real";
const TOKEN = "MARKER-token-f3c2f-not-real-0123456789";
const SOURCE_SENTENCE = "Marker sentence from the source server body";
const SOURCE_TEAM_NAME_MARKER = "Marker source team name";
const EXCHANGE_URL = "https://server3.gpexe.com/api-token-auth/";
const BASE = "https://server3.gpexe.com/rest/v1/";
const ALL_TEAMS = [980, 981, 982, 983, 984, 985, 986, 987];

let db, admin, server, apiBase, service, settings, createSession, appPool;
const logLines = [];
const originalConsole = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "f3c2f" });
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
      if (process.env.F3C2F_DEBUG) originalConsole[level](...args);
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
  service?.setSourceUnbindHoldForTests(null);
  service?.setSourceUnbindReplayHoldForTests(null);
  service?.setSourceAuditDedupeHoldForTests(null);
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
const approvedTeams = [];
let releaseCounter = 0;
async function approvePair(teamId, gpexeTeamId, userId) {
  await q(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, $2, $3)`, [teamId, gpexeTeamId, userId]);
  approvedTeams.push(teamId);
}
afterEach(async () => {
  service.setSourceUnbindHoldForTests(null);
  service.setSourceUnbindReplayHoldForTests(null);
  service.setSourceAuditDedupeHoldForTests(null);
  for (const teamId of approvedTeams.splice(0)) {
    await q(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = bound_by_user_id, end_reason = 'test cleanup' where team_id = $1 and state = 'active'`, [teamId]);
    releaseCounter += 1;
    await q(`update training_load.gpexe_team_settings set gpexe_team_id = $2, change_reason = 'test cleanup', configured_at = now() where owner_team_id = $1`, [teamId, String(940000000000 + releaseCounter)]);
  }
});
async function org({ approve = true } = {}) {
  const club = (await q(`insert into public.clubs (name) values ($1) returning id`, [`Club ${uid()}`]))[0].id;
  const team = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [club, `Team ${uid()}`]))[0].id;
  const team2 = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [club, `Team B ${uid()}`]))[0].id;
  const configurer = await makeUser("configurer");
  if (approve) { await approvePair(team, "981", configurer); await approvePair(team2, "982", configurer); }
  return { club, team, team2, configurer };
}
const CREATE = (club, over = {}) => ({ ownerScope: "club", ownerClubId: club, hostKey: "server3", accountLabel: "Club account (label only)", credentialKind: "exchanged_token", ...over });
async function created(adminUser, club) {
  const r = await api("/gpexe/connections", { method: "POST", cookie: adminUser.cookie, body: CREATE(club) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.connection;
}
async function verified(adminUser, club) {
  const conn = await created(adminUser, club);
  useSource();
  const r = await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: adminUser.cookie, body: { username: USERNAME, password: PASSWORD }, allowed: [SOURCE_TEAM_NAME_MARKER] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.state, "verified");
  return r.body.connection;
}
// A verified connection with team → 981 bound through the real route.
async function bound(adminUser, club, team, sourceTeamId = "981") {
  const conn = await verified(adminUser, club);
  useSource();
  const r = await api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: adminUser.cookie, body: { teamId: team, sourceTeamId } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { conn, binding: r.body.result.binding };
}
const unbindBody = (binding, over = {}) => ({ requestKey: crypto.randomUUID(), reason: "Season over; the team changes its GPEXE set-up", expected: { teamId: binding.teamId, sourceTeamId: binding.sourceTeamId }, ...over });
const unbindApi = (connectionId, bindingId, cookie, body) => api(`/gpexe/connections/${connectionId}/bindings/${bindingId}/unbind`, { method: "POST", cookie, body });
async function rowOf(id) { return (await q(`select * from training_load.source_credential_connections where id = $1`, [id]))[0]; }
async function auditOf(id) { return q(`select id, action, outcome, error_code, reason, performed_by_user_id, basis, metadata, team_id from training_load.source_connection_audit where connection_id = $1 order by performed_at, id`, [id]); }
async function bindingRow(id) { return (await q(`select * from training_load.source_team_bindings where id = $1`, [id]))[0]; }
async function dbTextOf(connectionId) {
  const conn = (await q(`select to_jsonb(c) - 'credential_ciphertext' - 'credential_nonce' - 'credential_auth_tag' as j from training_load.source_credential_connections c where id = $1`, [connectionId]))[0]?.j;
  const audit = await q(`select to_jsonb(a) as j from training_load.source_connection_audit a where connection_id = $1`, [connectionId]);
  const bindings = await q(`select to_jsonb(b) as j from training_load.source_team_bindings b where connection_id = $1`, [connectionId]);
  return JSON.stringify([conn, audit.map((r) => r.j), bindings.map((r) => r.j)]);
}

function fakeSource({ token = TOKEN, teams = ALL_TEAMS, teamGate = null } = {}) {
  const calls = [];
  const json = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? null;
    const record = { url: u, method: init.method ?? "GET", authIsIssuedToken: auth === `Token ${token}` };
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
    if (rel === "team/") return json(200, teams.map((id) => ({ id, name: `${SOURCE_TEAM_NAME_MARKER} ${id}` })), { "x-total-count": String(teams.length) });
    const m = rel.match(/^team\/(\d+)\/$/);
    if (m) {
      if (teamGate) await abortable(teamGate.p);
      if (!teams.includes(Number(m[1]))) return json(404, { detail: SOURCE_SENTENCE });
      return json(200, { id: Number(m[1]), name: `${SOURCE_TEAM_NAME_MARKER} ${m[1]}` });
    }
    return json(404, { detail: "not served" });
  };
  return { calls, fetchImpl };
}
const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
const useSource = (over) => { const s = fakeSource(over); service.setSourceFetchForTests(s.fetchImpl); return s; };
const waitFor = async (fn, ms = 3_000) => { for (let i = 0; i < ms / 25 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 25)); assert.ok(fn(), "the awaited condition did not come"); };
const RESULT_KEYS = ["action", "auditId", "binding", "connectionId", "outcome", "replayed", "sourceContacted"];
const BINDING_KEYS = ["bindingId", "boundAt", "endReason", "endedAt", "endedByUserId", "sourceTeamId", "state", "teamId", "teamName"];

// ---------------------------------------------------------------------------
test("1. the unbind route: 401 without a session; 415 for a body that is not JSON; 400 before any lock or audit for an unknown field, a missing or empty reason, a reason that is not one line, a requestKey that is not a UUID, a malformed or incomplete expected; nothing audited, nothing sent", async () => {
  const { club, team } = await org();
  const pa = await platformAdmin();
  const { conn, binding } = await bound(pa, club, team);
  const src = useSource();
  assert.equal((await unbindApi(conn.id, binding.bindingId, undefined, unbindBody(binding))).status, 401, "signed out");
  assert.equal((await api(`/gpexe/connections/${conn.id}/bindings/${binding.bindingId}/unbind`, { method: "POST", cookie: pa.cookie, body: "reason=x", contentType: "application/x-www-form-urlencoded" })).status, 415);
  for (const body of [
    unbindBody(binding, { extra: 1 }), unbindBody(binding, { reason: undefined }), unbindBody(binding, { reason: "   " }), unbindBody(binding, { reason: "two\nlines" }), unbindBody(binding, { reason: "x".repeat(501) }),
    unbindBody(binding, { reason: String.fromCharCode(0x200b) }), unbindBody(binding, { reason: "ok" + String.fromCharCode(0x202e) + "reversed" }), unbindBody(binding, { reason: "a" + String.fromCharCode(0x2028) + "b" }), unbindBody(binding, { reason: "tab\there" }),
    unbindBody(binding, { reason: String.fromCharCode(0x3164).repeat(3) }), unbindBody(binding, { reason: String.fromCharCode(0x115f) }), unbindBody(binding, { reason: "✓" }),
    unbindBody(binding, { requestKey: "not-a-uuid" }), unbindBody(binding, { requestKey: undefined }), unbindBody(binding, { expected: undefined }), unbindBody(binding, { expected: { teamId: binding.teamId } }),
    unbindBody(binding, { expected: { teamId: binding.teamId, sourceTeamId: "0981" } }), unbindBody(binding, { expected: { teamId: binding.teamId, sourceTeamId: binding.sourceTeamId, extra: true } }), { ...unbindBody(binding), expected: [binding.teamId] },
  ]) {
    const r = await unbindApi(conn.id, binding.bindingId, pa.cookie, body);
    assert.deepEqual([r.status, r.body.error], [400, "invalid_body"], JSON.stringify(body));
  }
  assert.equal(src.calls.length, 0, "nothing was sent");
  assert.equal((await bindingRow(binding.bindingId)).state, "active");
  assert.deepEqual((await auditOf(conn.id)).map((a) => a.action), ["create", "connect", "bind"], "a malformed request is not audited");
});

test("2. the same 404 for a coach, another club's admin, an admin of both clubs acting in the other club's workspace, a platform admin in another club's workspace, a revoked club-admin role, an archived club, a binding of another connection (same club), a binding of another club's connection, an unknown binding or connection and a malformed id; none sends a request, writes or audits anything", async () => {
  const { club, team, team2 } = await org();
  const other = await org({ approve: false });
  await approvePair(other.team, "983", other.configurer);
  const ca = await clubAdmin(club);
  const { conn, binding } = await bound(ca, club, team);
  const sibling = await bound(ca, club, team2, "982");
  const foreign = await bound(await clubAdmin(other.club), other.club, other.team, "983");
  const both = await clubAdmin(club, other.club);
  await addClubAdminRole(both.id, other.club);
  const paOther = await platformAdmin(["club", other.club]);
  await addClubAdminRole(paOther.id, other.club);
  const revoked = await clubAdmin(club);
  await q(`update public.user_club_roles set is_active = false where user_id = $1`, [revoked.id]);
  const src = useSource();
  const body = unbindBody(binding);
  const cases = [
    ["coach", (await coachOf(team)).cookie, conn.id, binding.bindingId],
    ["another club's admin", (await clubAdmin(other.club)).cookie, conn.id, binding.bindingId],
    ["an admin of both clubs in the other club's workspace", both.cookie, conn.id, binding.bindingId],
    ["a platform admin in another club's workspace", paOther.cookie, conn.id, binding.bindingId],
    ["a revoked club admin", revoked.cookie, conn.id, binding.bindingId],
    ["a binding of another connection of the same club", ca.cookie, conn.id, sibling.binding.bindingId],
    ["a binding of another club's connection", ca.cookie, conn.id, foreign.binding.bindingId],
    ["another club's connection with its own binding", ca.cookie, foreign.conn.id, foreign.binding.bindingId],
    ["an unknown binding", ca.cookie, conn.id, crypto.randomUUID()],
    ["an unknown connection", ca.cookie, crypto.randomUUID(), binding.bindingId],
    ["a malformed binding id", ca.cookie, conn.id, "not-a-uuid"],
  ];
  for (const [who, cookie, connectionId, bindingId] of cases) {
    const r = await unbindApi(connectionId, bindingId, cookie, body);
    assert.deepEqual([r.status, r.body.error], [404, "notFound"], who);
  }
  await q(`update public.clubs set is_active = false where id = $1`, [club]);
  assert.equal((await unbindApi(conn.id, binding.bindingId, ca.cookie, body)).status, 404, "an archived club");
  await q(`update public.clubs set is_active = true where id = $1`, [club]);
  assert.equal(src.calls.length, 0);
  for (const b of [binding, sibling.binding, foreign.binding]) assert.equal((await bindingRow(b.bindingId)).state, "active");
  assert.deepEqual((await auditOf(conn.id)).map((a) => a.action), ["create", "connect", "bind"], "no 404 is audited");
});

test("3. a platform admin ends an active binding: 200, the row is ended with when / who / why, nothing deleted, the settings row and the provenance pointer untouched, exactly one audit row (unbind, ok, the team, basis platform_admin, the reason, request_id, counted:false, source_contacted:false), zero requests to the source, GET lists only active bindings, the history row stays readable; the answer carries only the allowed fields", async () => {
  const { club, team } = await org();
  const pa = await platformAdmin();
  const { conn, binding } = await bound(pa, club, team);
  const settingsBefore = await q(`select owner_team_id, gpexe_team_id, configured_by_user_id, configured_at, change_reason from training_load.gpexe_team_settings where owner_team_id = $1`, [team]);
  const src = useSource();
  const body = unbindBody(binding, { reason: "  Season over; the team changes its GPEXE set-up  " });
  const r = await unbindApi(conn.id, binding.bindingId, pa.cookie, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body.result).sort(), RESULT_KEYS);
  assert.deepEqual(Object.keys(r.body.result.binding).sort(), BINDING_KEYS);
  assert.deepEqual([r.body.result.action, r.body.result.outcome, r.body.result.replayed, r.body.result.sourceContacted, r.body.result.binding.state, r.body.result.binding.endedByUserId, r.body.result.binding.endReason], ["unbind", "ok", false, false, "ended", pa.id, "Season over; the team changes its GPEXE set-up"]);
  assert.ok(r.body.result.binding.endedAt && r.body.result.auditId);
  assert.equal(src.calls.length, 0, "an Unbind never contacts the source");
  const row = await bindingRow(binding.bindingId);
  assert.deepEqual([row.state, row.ended_by_user_id, row.end_reason, row.legacy_gpexe_settings_team_id, row.source_team_id], ["ended", pa.id, "Season over; the team changes its GPEXE set-up", team, "981"]);
  assert.ok(row.ended_at);
  assert.deepEqual(await q(`select owner_team_id, gpexe_team_id, configured_by_user_id, configured_at, change_reason from training_load.gpexe_team_settings where owner_team_id = $1`, [team]), settingsBefore, "the settings row is untouched");
  assert.equal((await q(`select count(*)::int as n from training_load.source_team_bindings where connection_id = $1`, [conn.id]))[0].n, 1, "nothing deleted");
  const audit = (await auditOf(conn.id)).filter((a) => a.action === "unbind");
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].outcome, audit[0].error_code, audit[0].team_id, audit[0].basis, audit[0].performed_by_user_id, audit[0].reason, audit[0].id], ["ok", null, team, "platform_admin", pa.id, "Season over; the team changes its GPEXE set-up", r.body.result.auditId]);
  const { attempt_id: attemptId, request_hash: requestHash, ...facts } = audit[0].metadata;
  assert.match(attemptId, /^[0-9a-f-]{36}$/);
  assert.match(requestHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(facts, { host_key: "server3", credential_kind: "exchanged_token", source_team_id: "981", binding_id: binding.bindingId, bound_team_count: 0, counted: false, source_contacted: false, request_id: body.requestKey });
  assert.deepEqual(r.body.connection.boundTeams, [], "GET lists active bindings only");
  assert.deepEqual((await api(`/gpexe/connections/${conn.id}`, { cookie: pa.cookie })).body.connection.boundTeams, []);
  assert.equal((await rowOf(conn.id)).state, "verified", "the connection and its credential are untouched");
  noSecret(await dbTextOf(conn.id), "the database rows");
});

test("4. the owning club's admin ends a binding of their own club (basis club_admin); the connection does not have to be verified: a binding on a needs_reconnect connection ends the same way", async () => {
  const { club, team, team2 } = await org();
  const ca = await clubAdmin(club);
  const { conn, binding } = await bound(ca, club, team);
  useSource();
  assert.equal((await api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: ca.cookie, body: { teamId: team2, sourceTeamId: "982" } })).status, 201);
  const second = (await api(`/gpexe/connections/${conn.id}`, { cookie: ca.cookie })).body.connection.boundTeams.find((b) => b.teamId === team2);
  const src = useSource();
  const r = await unbindApi(conn.id, binding.bindingId, ca.cookie, unbindBody(binding));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await auditOf(conn.id)).at(-1).basis, "club_admin");
  assert.equal((await auditOf(conn.id)).at(-1).metadata.bound_team_count, 1, "one binding stays active");
  assert.deepEqual(r.body.connection.boundTeams.map((b) => b.teamId), [team2]);
  await q(`update training_load.source_credential_connections set state = 'needs_reconnect', last_error_code = 'source_auth_rejected', last_error_at = now() where id = $1`, [conn.id]);
  const r2 = await unbindApi(conn.id, second.bindingId, ca.cookie, unbindBody(second));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(src.calls.length, 0, "no request, whatever the connection's state");
  assert.equal((await rowOf(conn.id)).state, "needs_reconnect", "the state is not touched by an Unbind");
  await q(`update training_load.source_credential_connections set state = 'verified', last_error_code = null, last_error_at = null where id = $1`, [conn.id]);
});

test("5. idempotency: the same requestKey again answers the same saved result (replayed: true, the same auditId and facts) without a second UPDATE or audit row; the same key with another body is 409 request_key_reused; a new key on the already ended binding is 409 binding_already_ended with the current state; a stale expected pair is 409 binding_mismatch with the current state and nothing changes", async () => {
  const { club, team } = await org();
  const pa = await platformAdmin();
  const { conn, binding } = await bound(pa, club, team);
  useSource();
  const stale = await unbindApi(conn.id, binding.bindingId, pa.cookie, unbindBody(binding, { expected: { teamId: binding.teamId, sourceTeamId: "982" } }));
  assert.deepEqual([stale.status, stale.body.error, stale.body.current], [409, "binding_mismatch", { bindingId: binding.bindingId, teamId: team, sourceTeamId: "981", state: "active", endedAt: null }]);
  assert.equal((await bindingRow(binding.bindingId)).state, "active");
  const body = unbindBody(binding);
  const first = await unbindApi(conn.id, binding.bindingId, pa.cookie, body);
  assert.equal(first.status, 200);
  const endedAt = (await bindingRow(binding.bindingId)).ended_at;
  const auditCount = (await auditOf(conn.id)).length;
  const again = await unbindApi(conn.id, binding.bindingId, pa.cookie, body);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.result.replayed, again.body.result.auditId, again.body.result.binding.endedAt, again.body.result.binding.endReason], [true, first.body.result.auditId, first.body.result.binding.endedAt, first.body.result.binding.endReason]);
  assert.equal(String((await bindingRow(binding.bindingId)).ended_at), String(endedAt), "no second UPDATE");
  assert.equal((await auditOf(conn.id)).length, auditCount, "no second audit row");
  const reused = await unbindApi(conn.id, binding.bindingId, pa.cookie, { ...body, reason: "another reason" });
  assert.deepEqual([reused.status, reused.body.error, reused.body.current?.state], [409, "request_key_reused", "ended"]);
  const newKey = await unbindApi(conn.id, binding.bindingId, pa.cookie, unbindBody(binding));
  assert.deepEqual([newKey.status, newKey.body.error, newKey.body.current?.state, newKey.body.current?.bindingId], [409, "binding_already_ended", "ended", binding.bindingId]);
  assert.ok(newKey.body.current.endedAt, "the current safe state names when it ended");
  assert.deepEqual((await auditOf(conn.id)).filter((a) => a.action === "unbind").map((a) => [a.outcome, a.error_code]), [["refused", "binding_mismatch"], ["ok", null], ["refused", "request_key_reused"], ["refused", "binding_already_ended"]], "every refusal is audited as refused; the replay leaves no row");
  assert.ok((await auditOf(conn.id)).filter((a) => a.action === "unbind" && a.outcome === "refused").every((a) => a.metadata.counted === false && a.metadata.source_contacted === false));
  // A replay is answered behind the connection row only: even while the team's lock is busy (an import), the saved answer comes back.
  {
    const peer = new pg.Client({ connectionString: db.url });
    await peer.connect();
    try {
      await peer.query("begin");
      await peer.query(`select training_load.hold_gpexe_team_lock($1, 'import')`, [team]);
      const busyReplay = await unbindApi(conn.id, binding.bindingId, pa.cookie, body);
      assert.deepEqual([busyReplay.status, busyReplay.body.result?.replayed], [200, true], "a retry of a lost answer never meets a busy team");
      await peer.query("rollback");
    } finally {
      await peer.end();
    }
  }
  // Another user with the same key does not get the first user's saved answer: the record is per user.
  const ca = await clubAdmin(club);
  const otherUser = await unbindApi(conn.id, binding.bindingId, ca.cookie, body);
  assert.deepEqual([otherUser.status, otherUser.body.error], [409, "binding_already_ended"]);
  // A refusal repeated with the same key by the same user is audited once: the append-only audit never grows from retries.
  const before = (await auditOf(conn.id)).length;
  for (let i = 0; i < 5; i += 1) assert.equal((await unbindApi(conn.id, binding.bindingId, ca.cookie, body)).body.error, "binding_already_ended");
  assert.equal((await auditOf(conn.id)).length, before, "five identical refusals added no row");
  const another = await unbindApi(conn.id, binding.bindingId, ca.cookie, unbindBody(binding));
  assert.equal(another.body.error, "binding_already_ended");
  assert.equal((await auditOf(conn.id)).length, before + 1, "a new requestKey is a new refusal row");
  // The replay path re-checks the right too.
  await q(`update public.user_global_roles set is_active = false where user_id = $1`, [pa.id]);
  const revokedReplay = await unbindApi(conn.id, binding.bindingId, pa.cookie, body);
  assert.equal(revokedReplay.status, 404, "a revoked platform admin is not an admin at all any more (the context answers 404 before the replay)");
  await q(`update public.user_global_roles set is_active = true where user_id = $1`, [pa.id]);
});

test("6. the COMMIT outcome: an answer lost after the COMMIT is verified on a fresh connection (200 with commitConfirmation, the row ended once); an unverifiable COMMIT is 503 outcome_unknown naming the team, with a second unknown audit row for the team, and the retry with the same key answers the saved result without a second UPDATE", async () => {
  const { club, team, team2 } = await org();
  const pa = await platformAdmin();
  const { conn, binding } = await bound(pa, club, team);
  useSource();
  assert.equal((await api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: pa.cookie, body: { teamId: team2, sourceTeamId: "982" } })).status, 201);
  const second = (await api(`/gpexe/connections/${conn.id}`, { cookie: pa.cookie })).body.connection.boundTeams.find((b) => b.teamId === team2);
  service.setSourceConnectionCommitForTests({ fault: async (client) => { await client.query("commit"); await new Promise(() => {}); }, timeoutMs: 200 });
  try {
    const r = await unbindApi(conn.id, binding.bindingId, pa.cookie, unbindBody(binding));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.commitConfirmation, "verified_after_commit_error");
    assert.equal((await bindingRow(binding.bindingId)).state, "ended");
  } finally {
    service.setSourceConnectionCommitForTests();
  }
  const body = unbindBody(second);
  service.setSourceConnectionCommitForTests({
    fault: async (client) => { await client.query("commit"); await new Promise(() => {}); }, timeoutMs: 200,
    checkFault: async () => { await new Promise(() => {}); }, checkTimeoutMs: 200,
  });
  try {
    const r = await unbindApi(conn.id, second.bindingId, pa.cookie, body);
    assert.deepEqual([r.status, r.body.error, r.body.teamId, r.body.connectionId], [503, "outcome_unknown", team2, conn.id], JSON.stringify(r.body));
  } finally {
    service.setSourceConnectionCommitForTests();
  }
  const rows = (await auditOf(conn.id)).filter((a) => a.action === "unbind" && a.team_id === team2);
  assert.deepEqual(rows.map((a) => [a.outcome, a.error_code]), [["ok", null], ["unknown", "outcome_unknown"]]);
  assert.equal(rows[0].metadata.attempt_id, rows[1].metadata.attempt_id);
  const endedAt = (await bindingRow(second.bindingId)).ended_at;
  const retry = await unbindApi(conn.id, second.bindingId, pa.cookie, body);
  assert.deepEqual([retry.status, retry.body.result?.replayed, retry.body.result?.auditId], [200, true, rows[0].id]);
  assert.equal(String((await bindingRow(second.bindingId)).ended_at), String(endedAt));
});

test("7. concurrency: two parallel Unbinds with one key by one admin end the row once (the second replays); two admins with two keys: one ends it, the other gets binding_already_ended or try_again, never two ends; an import or Settings change holding the team's lock makes the Unbind answer try_again with nothing changed; an Unbind held before its UPDATE makes a bind of the connection, a Settings change of the team and a raw binding insert answer at once (try_again / busy / P0001), and a bind at the source makes the Unbind answer try_again", async () => {
  const { club, team, team2 } = await org();
  const ca = await clubAdmin(club);
  const pa = await platformAdmin();
  const { conn, binding } = await bound(ca, club, team);
  useSource();
  const body = unbindBody(binding);
  const [r1, r2] = await Promise.all([unbindApi(conn.id, binding.bindingId, ca.cookie, body), unbindApi(conn.id, binding.bindingId, ca.cookie, body)]);
  const statuses = [r1, r2].map((r) => [r.status, r.body.result?.replayed ?? r.body.error]).sort();
  assert.deepEqual(statuses, [[200, false], [200, true]], JSON.stringify([r1.body, r2.body]));
  assert.equal((await auditOf(conn.id)).filter((a) => a.action === "unbind" && a.outcome === "ok").length, 1, "one UPDATE, one audit row");
  // Two admins, two keys, on a fresh binding.
  useSource();
  assert.equal((await api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: ca.cookie, body: { teamId: team2, sourceTeamId: "982" } })).status, 201);
  const second = (await api(`/gpexe/connections/${conn.id}`, { cookie: ca.cookie })).body.connection.boundTeams.find((b) => b.teamId === team2);
  const [a, b] = await Promise.all([unbindApi(conn.id, second.bindingId, ca.cookie, unbindBody(second)), unbindApi(conn.id, second.bindingId, pa.cookie, unbindBody(second))]);
  const outcomes = [a, b].map((r) => r.status === 200 ? "ended" : r.body.error).sort();
  assert.equal(outcomes.filter((o) => o === "ended").length, 1, JSON.stringify(outcomes));
  assert.ok(outcomes.every((o) => ["ended", "binding_already_ended", "try_again"].includes(o)), JSON.stringify(outcomes));
  assert.equal((await auditOf(conn.id)).filter((a2) => a2.action === "unbind" && a2.outcome === "ok" && a2.team_id === team2).length, 1);
  // A held team lock (a Check now / import / Settings change of the team) → try_again, nothing changed.
  useSource();
  assert.equal((await api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: ca.cookie, body: { teamId: team, sourceTeamId: "981" } })).status, 201, "team can be bound again after its Unbind");
  const third = (await api(`/gpexe/connections/${conn.id}`, { cookie: ca.cookie })).body.connection.boundTeams.find((b) => b.teamId === team);
  const peer = new pg.Client({ connectionString: db.url });
  await peer.connect();
  try {
    await peer.query("begin");
    await peer.query(`select training_load.hold_gpexe_team_lock($1, 'import')`, [team]);
    const src = useSource();
    const held = await unbindApi(conn.id, third.bindingId, ca.cookie, unbindBody(third));
    assert.deepEqual([held.status, held.body.error, held.body.teamId, src.calls.length], [409, "try_again", team, 0]);
    assert.equal((await bindingRow(third.bindingId)).state, "active");
    await peer.query("rollback");
    // An Unbind held right before its UPDATE: everything of the team and the connection answers at once.
    const g = gate();
    let holding = false;
    service.setSourceUnbindHoldForTests(async () => { holding = true; await g.p; });
    const pending = unbindApi(conn.id, third.bindingId, ca.cookie, unbindBody(third));
    await waitFor(() => holding);
    const src2 = useSource();
    const bindDuring = await api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: pa.cookie, body: { teamId: team2, sourceTeamId: "982" } });
    assert.deepEqual([bindDuring.status, bindDuring.body.error, src2.calls.length], [409, "try_again", 0], "the connection row is held by the Unbind");
    const settingsDuring = await settings.setTeamSettings(team, { gpexeTeamId: "985", reason: "during an unbind", userId: pa.id }).then(() => null, (e) => e.code);
    assert.equal(settingsDuring, "gpexe_change_busy", "the team lock is held by the Unbind");
    await peer.query("begin");
    await peer.query(`set local lock_timeout = '300ms'`);
    const rawDuring = await peer.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1, $2, 'gpexe', '982', $3, $1)`, [team2, conn.id, ca.id]).then(() => null, (e) => e.code);
    assert.ok(["P0001", "55P03"].includes(rawDuring), `a raw binding insert of the connection is refused or bounded (${rawDuring})`);
    await peer.query("rollback");
    g.release();
    service.setSourceUnbindHoldForTests(null);
    assert.equal((await pending).status, 200);
    // A bind at the source holds the connection row: the Unbind of a sibling binding answers try_again at once.
    useSource();
    assert.equal((await api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: ca.cookie, body: { teamId: team, sourceTeamId: "981" } })).status, 201);
    const fourth = (await api(`/gpexe/connections/${conn.id}`, { cookie: ca.cookie })).body.connection.boundTeams.find((b) => b.teamId === team);
    service.setSourceConnectionTimingForTests({ exchangeTimeout: 10_000, testTimeout: 10_000 });
    try {
      const g2 = gate();
      const src3 = useSource({ teamGate: g2 });
      const bindPending = api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: pa.cookie, body: { teamId: team2, sourceTeamId: "982" } });
      await waitFor(() => src3.calls.length === 1);
      const unbindDuring = await unbindApi(conn.id, fourth.bindingId, ca.cookie, unbindBody(fourth));
      assert.deepEqual([unbindDuring.status, unbindDuring.body.error], [409, "try_again"]);
      g2.release();
      assert.equal((await bindPending).status, 201);
    } finally {
      service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
    }
  } finally {
    service.setSourceUnbindHoldForTests(null);
    await peer.end();
  }
});

test("8. after an Unbind: the v30 trigger no longer blocks a change of the team's approved GPEXE Team ID; the same team takes a new valid binding; the freed source team can be bound to another approved pair (every v30 rule still applied); the ended row stays as history with its provenance pointer; the audit history stays; a rollback of v30 on a separate disposable database is no longer blocked by an ended binding", async () => {
  const { club, team, team2, configurer } = await org();
  const pa = await platformAdmin();
  const { conn, binding } = await bound(pa, club, team);
  useSource();
  const blocked = await settings.setTeamSettings(team, { gpexeTeamId: "983", reason: "before unbind", userId: pa.id }).then(() => null, (e) => e.code);
  assert.equal(blocked, "gpexe_team_bound");
  assert.equal((await unbindApi(conn.id, binding.bindingId, pa.cookie, unbindBody(binding))).status, 200);
  await settings.setTeamSettings(team, { gpexeTeamId: "983", reason: "after unbind", userId: pa.id });
  assert.equal((await q(`select gpexe_team_id from training_load.gpexe_team_settings where owner_team_id = $1`, [team]))[0].gpexe_team_id, "983", "the approved pair can change again");
  const src = useSource();
  const rebind = await api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: pa.cookie, body: { teamId: team, sourceTeamId: "983" } });
  assert.equal(rebind.status, 201, "the same team takes a new valid binding");
  assert.deepEqual(src.calls.map((c) => c.url.slice(BASE.length)), ["team/983/"], "the new pair is verified alone");
  // The freed source team 981 goes to another approved pair: team2's setting changes to 981 (free again), then binds.
  await settings.setTeamSettings(team2, { gpexeTeamId: "981", reason: "takes the freed team", userId: pa.id });
  const old = await api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: pa.cookie, body: { teamId: team2, sourceTeamId: "982" } });
  assert.deepEqual([old.status, old.body.error], [409, "team_setting_mismatch"], "the old pair is no longer approved");
  assert.equal((await api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: pa.cookie, body: { teamId: team2, sourceTeamId: "981" } })).status, 201, "the freed source team is bound to its new approved pair");
  const history = await q(`select state, source_team_id, legacy_gpexe_settings_team_id, end_reason from training_load.source_team_bindings where connection_id = $1 order by bound_at`, [conn.id]);
  assert.deepEqual(history.map((h) => [h.state, h.source_team_id, h.legacy_gpexe_settings_team_id !== null]), [["ended", "981", true], ["active", "983", true], ["active", "981", true]], "the ended row is history with its pointer");
  assert.ok((await auditOf(conn.id)).some((a) => a.action === "unbind" && a.outcome === "ok"), "the audit history stays");
  assert.deepEqual((await api(`/gpexe/connections/${conn.id}`, { cookie: pa.cookie })).body.connection.boundTeams.map((b) => b.sourceTeamId).sort(), ["981", "983"]);
  void configurer;
  // The v30 rollback refuses only while an ACTIVE binding relies on it: on a separate disposable database an ended binding no longer blocks it.
  const m = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "f3c2frb", migrations: UP_TO_V30 });
  const k = new pg.Client({ connectionString: m.url });
  await k.connect();
  try {
    const c2 = (await k.query(`insert into public.clubs (name) values ('C') returning id`)).rows[0].id;
    const t2 = (await k.query(`insert into public.teams (club_id, name) values ($1, 'T') returning id`, [c2])).rows[0].id;
    const u2 = (await k.query(`insert into public.users (email) values ('u@test.local') returning id`)).rows[0].id;
    await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, '981', $2)`, [t2, u2]);
    const parts = cryptoMod.encryptCredential(TOKEN, { connectionId: "00000000-0000-0000-0000-000000000001", ownerScope: "club", ownerClubId: c2, ownerTeamId: null, sourceSystem: "gpexe", hostKey: "server3", credentialKind: "exchanged_token" }, cryptoMod.parseKeyring(cryptoMod.generateKeyEntry(1)));
    const connId = (await k.query(
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state, credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','club',$1,'server3','L','exchanged_token',$2,'verified',$3,$4,$5,$6, now()) returning id`,
      [c2, u2, parts.ciphertext, parts.nonce, parts.authTag, parts.keyVersion],
    )).rows[0].id;
    const bId = (await k.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id) values ($1, $2, 'gpexe', '981', $3, $1) returning id`, [t2, connId, u2])).rows[0].id;
    const rollbackSql = await fsp.readFile(V30_ROLLBACK, "utf8");
    await assert.rejects(k.query(rollbackSql), /v30 rollback refused: 1 active gpexe binding/);
    await k.query("rollback").catch(() => {});
    await k.query(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'the same change the Unbind makes' where id = $1 and state = 'active'`, [bId, u2]);
    await k.query(rollbackSql);
    assert.equal((await k.query(`select count(*)::int as n from pg_trigger where tgname in ('gpexe_team_settings_bound_team_final', 'source_team_bindings_check_pair')`)).rows[0].n, 0, "the rollback went through once the binding was ended");
    assert.equal((await k.query(`select state from training_load.source_team_bindings where id = $1`, [bId])).rows[0].state, "ended", "the history row stays");
    await applyGpexeTestMigrations(m.url, UP_TO_V30);
  } finally {
    await k.end();
    await m.drop();
  }
});

test("10. the right and the club are re-checked right before the write: a club admin's role revoked, the club archived, or a platform admin's right revoked while the Unbind is held answer 409 rights_changed with the binding still active; a lock held on ANOTHER bound team of the connection does not block the Unbind (only the target team is locked); the same requestKey reused for another binding is request_key_reused", async () => {
  const { club, team, team2 } = await org();
  const ca = await clubAdmin(club);
  const pa = await platformAdmin();
  const { conn, binding } = await bound(ca, club, team);
  useSource();
  assert.equal((await api(`/gpexe/connections/${conn.id}/bindings`, { method: "POST", cookie: ca.cookie, body: { teamId: team2, sourceTeamId: "982" } })).status, 201);
  const run = async (cookie, revoke, restore) => {
    const g = gate();
    let held = false;
    service.setSourceUnbindHoldForTests(async () => { held = true; await g.p; });
    const pending = unbindApi(conn.id, binding.bindingId, cookie, unbindBody(binding));
    await waitFor(() => held);
    await revoke();
    g.release();
    const r = await pending;
    service.setSourceUnbindHoldForTests(null);
    assert.deepEqual([r.status, r.body.error], [409, "rights_changed"], JSON.stringify(r.body));
    assert.equal((await bindingRow(binding.bindingId)).state, "active", "nothing changed");
    const last = (await auditOf(conn.id)).at(-1);
    assert.deepEqual([last.action, last.outcome, last.error_code, last.team_id, last.metadata.counted], ["unbind", "refused", "rights_changed", team, false]);
    await restore();
  };
  await run(ca.cookie, () => q(`update public.user_club_roles set is_active = false where user_id = $1`, [ca.id]), () => q(`update public.user_club_roles set is_active = true where user_id = $1`, [ca.id]));
  await run(ca.cookie, () => q(`update public.clubs set is_active = false where id = $1`, [club]), () => q(`update public.clubs set is_active = true where id = $1`, [club]));
  await run(pa.cookie, () => q(`update public.user_global_roles set is_active = false where user_id = $1`, [pa.id]), () => q(`update public.user_global_roles set is_active = true where user_id = $1`, [pa.id]));
  // A lock held on the OTHER bound team (team2) does NOT block the Unbind of team's binding: an Unbind changes neither the
  // credential nor the connection's state, so only its own team is locked — an import of a sibling team never blocks the remedy.
  const peer = new pg.Client({ connectionString: db.url });
  await peer.connect();
  try {
    await peer.query("begin");
    await peer.query(`select training_load.hold_gpexe_team_lock($1, 'import')`, [team2]);
    const body = unbindBody(binding);
    const r = await unbindApi(conn.id, binding.bindingId, ca.cookie, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await bindingRow(binding.bindingId)).state, "ended");
    // The same key reused for ANOTHER binding of the connection is refused as request_key_reused (the record names the binding).
    const second = (await q(`select id, team_id, source_team_id from training_load.source_team_bindings where connection_id = $1 and state = 'active'`, [conn.id]))[0];
    await peer.query("rollback");
    const reused = await unbindApi(conn.id, second.id, ca.cookie, { ...body, expected: { teamId: second.team_id, sourceTeamId: second.source_team_id } });
    assert.deepEqual([reused.status, reused.body.error, reused.body.current?.bindingId], [409, "request_key_reused", binding.bindingId], "the key belongs to the first Unbind");
    assert.equal((await bindingRow(second.id)).state, "active", "nothing changed");
  } finally {
    await peer.end();
  }
  // The replay path re-checks the right too: a club admin whose role is revoked while the replay is held gets
  // rights_changed, not the saved answer (the right is read FOR SHARE at the replay's own moment).
  {
    const g = gate();
    let held = false;
    service.setSourceUnbindReplayHoldForTests(async () => { held = true; await g.p; });
    const before = (await auditOf(conn.id)).length;
    const pending = unbindApi(conn.id, binding.bindingId, ca.cookie, unbindBody(binding, { requestKey: (await auditOf(conn.id)).find((a) => a.outcome === "ok" && a.metadata.binding_id === binding.bindingId).metadata.request_id }));
    await waitFor(() => held);
    await q(`update public.user_club_roles set is_active = false where user_id = $1`, [ca.id]);
    g.release();
    const r = await pending;
    service.setSourceUnbindReplayHoldForTests(null);
    assert.deepEqual([r.status, r.body.error], [409, "rights_changed"], JSON.stringify(r.body));
    const rows = await auditOf(conn.id);
    assert.equal(rows.length, before + 1, "one refusal row");
    assert.deepEqual([rows.at(-1).action, rows.at(-1).outcome, rows.at(-1).error_code, rows.at(-1).metadata.binding_id], ["unbind", "refused", "rights_changed", binding.bindingId]);
    await q(`update public.user_club_roles set is_active = true where user_id = $1`, [ca.id]);
    const again = await unbindApi(conn.id, binding.bindingId, ca.cookie, unbindBody(binding, { requestKey: rows.find((a) => a.outcome === "ok" && a.metadata.binding_id === binding.bindingId).metadata.request_id }));
    assert.deepEqual([again.status, again.body.result?.replayed], [200, true], "with the right back the same key replays");
  }
});

test("11. the refusal-audit dedupe is serialized: two parallel identical refused Unbinds (same user, connection, binding, requestKey, body, refusal) write exactly one refusal audit row — the first is held after taking the dedupe advisory lock, the second waits on that lock within the bound, both answer the same refusal, and no transaction, advisory lock or pooled client is left behind", async () => {
  const { club, team } = await org();
  const ca = await clubAdmin(club);
  const { conn, binding } = await bound(ca, club, team);
  assert.equal((await unbindApi(conn.id, binding.bindingId, ca.cookie, unbindBody(binding))).status, 200);
  const body = unbindBody(binding); // a fresh key: a stable refusal (binding_already_ended) for both
  const g = gate();
  let held = false;
  service.setSourceAuditDedupeHoldForTests(async () => { held = true; await g.p; });
  const before = (await auditOf(conn.id)).length;
  const logBefore = logLines.length;
  let firstDone = false;
  let secondDone = false;
  // Only this database's advisory locks (other suites run in parallel against other disposable databases), and only the
  // dedupe lock of exactly this identity: the same bigint key the service derives.
  // (a 64-bit advisory key shows in pg_locks as classid = its high 32 bits, objid = its low 32 bits, objsubid = 1)
  const h = `hashtextextended('source-audit-dedupe:' || $1::text, 21)`;
  const identity = [conn.id, ca.id, "unbind", "refused", "binding_already_ended", team, body.requestKey].join("|");
  const lockRows = async (granted) => (await q(`select count(*)::int as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database()) and granted = $2 and objsubid = 1 and classid = ((${h} >> 32) & 4294967295)::oid and objid = (${h} & 4294967295)::oid`, [identity, granted]))[0].n;
  const waiting = () => lockRows(false);
  let first; let second; let sawWait = false; let firstDoneWhileHeld = null; let rowsWhileHeld = null; let secondStarted = null; let releasedAt = null; let heldLock = null; const started = Date.now();
  try {
    first = unbindApi(conn.id, binding.bindingId, ca.cookie, body).then((r) => { firstDone = true; return r; });
    await waitFor(() => held);
    service.setSourceAuditDedupeHoldForTests(null); // the second is not held — it waits on the lock itself
    secondStarted = Date.now();
    second = unbindApi(conn.id, binding.bindingId, ca.cookie, body).then((r) => { secondDone = true; return r; });
    // Wait until the second either waits on the dedupe lock (the serialized case) or finished without waiting (a broken dedupe).
    while (!secondDone && !sawWait && Date.now() - started < 3_000) {
      sawWait = (await waiting()) === 1;
      if (!sawWait) await new Promise((r) => setTimeout(r, 25));
    }
    firstDoneWhileHeld = firstDone;
    rowsWhileHeld = (await auditOf(conn.id)).length;
    heldLock = await lockRows(true);
  } finally {
    releasedAt = Date.now();
    g.release();
  }
  const [r1, r2] = await Promise.all([first, second]);
  assert.deepEqual([r1.status, r1.body.error, r2.status, r2.body.error], [409, "binding_already_ended", 409, "binding_already_ended"]);
  const rows = (await auditOf(conn.id)).filter((a) => a.action === "unbind" && a.outcome === "refused" && a.error_code === "binding_already_ended" && a.performed_by_user_id === ca.id && a.metadata.request_id === body.requestKey);
  assert.equal(rows.length, 1, `exactly one refusal row for this user / key / refusal (found ${rows.length})`);
  assert.equal(rows[0].team_id, team);
  assert.equal(logLines.slice(logBefore).filter((l) => l.includes("could not be audited")).length, 0, "neither refusal lost its audit (the second waited, it did not time out)");
  assert.equal(heldLock, 1, "the first held the dedupe lock of exactly this identity");
  assert.equal(sawWait, true, "the second refusal waited on the dedupe advisory lock");
  assert.equal(firstDoneWhileHeld, false, "the first request was still held inside its dedupe transaction");
  assert.equal(rowsWhileHeld, before, "nothing was written while the first was held");
  assert.ok(releasedAt - secondStarted < service.ROW_LOCK_TIMEOUT_MS, "the second waited inside the lock bound, not until lock_timeout");
  assert.equal(await lockRows(true) + await lockRows(false), 0, "no dedupe advisory lock left behind");
  assert.equal((await q(`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`))[0].n, 0, "no transaction left open");
  await waitFor(() => appPool.totalCount === appPool.idleCount && appPool.waitingCount === 0);
  // Not a request record: the same key repeats the same refusal (no second row), and a fresh key is a new attempt (one more row).
  assert.equal((await unbindApi(conn.id, binding.bindingId, ca.cookie, body)).body.error, "binding_already_ended");
  assert.equal((await auditOf(conn.id)).length, before + 1);
  assert.equal((await unbindApi(conn.id, binding.bindingId, ca.cookie, unbindBody(binding))).body.error, "binding_already_ended");
  assert.equal((await auditOf(conn.id)).length, before + 2);
});

test("12. the dedupe wait is bounded and a failed secondary audit never changes the answer: a second identical refusal that cannot get the dedupe lock within lock_timeout still answers the same 409 and only the first writes its row; an audit transaction that fails after its insert is rolled back, leaves no row, no lock and no open transaction, and the answer is unchanged with a code-only console line", async () => {
  const { club, team } = await org();
  const ca = await clubAdmin(club);
  const { conn, binding } = await bound(ca, club, team);
  assert.equal((await unbindApi(conn.id, binding.bindingId, ca.cookie, unbindBody(binding))).status, 200);
  const before = (await auditOf(conn.id)).length;
  // (a) the wait is bounded: the first is held past lock_timeout, the second times out (55P03, dropped and logged by code only).
  const body = unbindBody(binding);
  const g = gate();
  let held = false;
  service.setSourceAuditDedupeHoldForTests(async () => { held = true; await g.p; });
  let first;
  try {
    first = unbindApi(conn.id, binding.bindingId, ca.cookie, body);
    await waitFor(() => held);
    service.setSourceAuditDedupeHoldForTests(null);
    const logA = logLines.length;
    const t0 = Date.now();
    const second = await unbindApi(conn.id, binding.bindingId, ca.cookie, body);
    const took = Date.now() - t0;
    assert.deepEqual([second.status, second.body.error], [409, "binding_already_ended"], JSON.stringify(second.body));
    assert.ok(took >= service.ROW_LOCK_TIMEOUT_MS - 100 && took < service.ROW_LOCK_TIMEOUT_MS + 3_000, `the second waited only until lock_timeout (${took} ms)`);
    assert.equal((await auditOf(conn.id)).length, before, "the second wrote nothing while the first is still held");
    assert.ok(logLines.slice(logA).some((l) => l.includes("could not be audited: 55P03")), "the dropped audit is logged by code only");
  } finally {
    g.release();
  }
  assert.deepEqual([(await first).status, (await first).body.error], [409, "binding_already_ended"]);
  assert.equal((await auditOf(conn.id)).length, before + 1, "exactly the first's row");
  // (b) a failure inside the audit transaction after its insert: rolled back, no row, the answer unchanged.
  const body2 = unbindBody(binding);
  service.setSourceAuditDedupeHoldForTests(async () => { throw new Error("injected audit fault"); });
  const r = await unbindApi(conn.id, binding.bindingId, ca.cookie, body2);
  service.setSourceAuditDedupeHoldForTests(null);
  assert.deepEqual([r.status, r.body.error], [409, "binding_already_ended"], JSON.stringify(r.body));
  assert.equal((await auditOf(conn.id)).length, before + 1, "the failed audit left no row");
  assert.ok(!logLines.some((l) => l.includes("injected audit fault")), "the failure is logged by code only, never by message");
  assert.equal((await q(`select count(*)::int as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`))[0].n, 0, "no advisory lock left behind");
  assert.equal((await q(`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`))[0].n, 0, "no transaction left open");
  await waitFor(() => appPool.totalCount === appPool.idleCount && appPool.waitingCount === 0);
  // A later identical refusal with that key is audited normally (nothing of the failed attempt lingers).
  assert.equal((await unbindApi(conn.id, binding.bindingId, ca.cookie, body2)).body.error, "binding_already_ended");
  assert.equal((await auditOf(conn.id)).length, before + 2);
  // (c) an audit COMMIT whose answer never comes: the Unbind answer is not held, the pooled client is destroyed (no
  // ROLLBACK is queued behind the unanswered COMMIT), and the server ends the abandoned transaction with the socket.
  service.setSourceConnectionCommitForTests({ timeoutMs: 150 });
  service.setSourceAuditDedupeHoldForTests(async (client) => {
    const original = client.query.bind(client);
    client.query = (text, ...rest) => (typeof text === "string" && /^(commit|rollback)$/i.test(text.trim()) ? new Promise(() => {}) : original(text, ...rest));
  });
  const t1 = Date.now();
  let hung;
  let r3;
  try {
    r3 = await Promise.race([
      unbindApi(conn.id, binding.bindingId, ca.cookie, unbindBody(binding)),
      new Promise((resolve) => { hung = setTimeout(() => resolve({ status: 0, body: { error: "hung" } }), 7_000); }),
    ]);
  } finally {
    clearTimeout(hung);
    service.setSourceAuditDedupeHoldForTests(null);
    service.setSourceConnectionCommitForTests();
  }
  assert.deepEqual([r3.status, r3.body.error], [409, "binding_already_ended"], `the answer is not held by the audit COMMIT (${Date.now() - t1} ms)`);
  assert.ok(Date.now() - t1 < 5_000, "answered within the COMMIT bound, not a ROLLBACK or TCP wait");
  await waitFor(() => appPool.totalCount === appPool.idleCount && appPool.waitingCount === 0);
  for (let i = 0; i < 80 && (await q(`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`))[0].n !== 0; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await q(`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`))[0].n, 0, "the abandoned audit transaction ended with its connection");
  assert.equal((await q(`select count(*)::int as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`))[0].n, 0, "no advisory lock left behind");
  assert.equal((await unbindApi(conn.id, binding.bindingId, ca.cookie, unbindBody(binding))).body.error, "binding_already_ended", "the next refusal is served and audited normally");
  assert.equal((await auditOf(conn.id)).length, before + 3);
});

test("9. this suite runs on a disposable database only, left no active binding, and no console line carries a secret, a source sentence or a source team name", async () => {
  assert.match((await q("select current_database() as db"))[0].db, DISPOSABLE_DB_NAME_PATTERN);
  assert.ok(db.url !== ORIGINAL_DATABASE_URL);
  assert.equal((await q(`select count(*)::int as n from training_load.source_team_bindings where state = 'active'`))[0].n, 0, "no binding left active");
  for (const line of logLines) noSecret(line, "a console line");
});

// F3c2d — GPEXE Connect / Reconnect / Test routes against a fake source,
// on a disposable optimove_tests_gpexe_* database (never OPTIMOVE).
// Contract: docs/ai/source-connections-f3c2-contract.md sections 2 and 3.
// No real credential, no real host: every network call goes to an in-process
// fake fetch that records the exact URL, method, header names and whether
// the Authorization value equals the issued marker token.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import * as cryptoMod from "../src/sourceCredentialCrypto.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const ORIGINAL_ACTIVE = process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V28 = "202609291000_training_load_v28_source_host_server3.sql";
const V29 = "202610031000_training_load_v29_source_connection_state_facts.sql";
const UP_TO_V28 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V28) + 1);
const V29_ROLLBACK = path.resolve(ROOT, "docs/runbooks/source-connections-v29-rollback.sql");

// Marker values. They must never appear in a response, an audit row, a log
// line or a database column other than the ciphertext.
const USERNAME = "marker-username-f3c2d@example.invalid";
const PASSWORD = "MARKER-password-f3c2d-not-real";
const TOKEN = "MARKER-token-f3c2d-not-real-0123456789";
const TOKEN2 = "MARKER-token-f3c2d-second-9876543210";
const SOURCE_SENTENCE = "Marker sentence from the source server body";
const EXCHANGE_URL = "https://server3.gpexe.com/api-token-auth/";
const BASE = "https://server3.gpexe.com/rest/v1/";

let db, admin, server, apiBase, service, createSession, appPool;
const logLines = [];
const originalConsole = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "f3c2d" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  process.env.SOURCE_CREDENTIAL_KEYS = cryptoMod.generateKeyEntry(1);
  delete process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION;
  // Every console line of the whole suite is kept and checked at the end for a secret.
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : safeString(a))).join(" "));
      if (process.env.F3C2D_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceConnectionService.js");
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
const SECRETS = [USERNAME, PASSWORD, TOKEN, TOKEN2, SOURCE_SENTENCE];
function noSecret(text, where) {
  for (const s of SECRETS) assert.ok(!String(text).includes(s), `${where} carries a secret marker (${s.slice(0, 12)}…)`);
}

async function api(path, { method = "GET", body, cookie, contentType = "application/json" } = {}) {
  const res = await fetch(`${apiBase}/api/training-load/sources${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": contentType }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  noSecret(text, `the response to ${method} ${path}`);
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
async function org() {
  const club = (await q(`insert into public.clubs (name) values ($1) returning id`, [`Club ${uid()}`]))[0].id;
  const team = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [club, `Team ${uid()}`]))[0].id;
  const team2 = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [club, `Team B ${uid()}`]))[0].id;
  return { club, team, team2 };
}
const CREATE = (club, over = {}) => ({ ownerScope: "club", ownerClubId: club, hostKey: "server3", accountLabel: "Club account (label only)", credentialKind: "exchanged_token", ...over });
async function created(adminUser, club) {
  const r = await api("/gpexe/connections", { method: "POST", cookie: adminUser.cookie, body: CREATE(club) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.connection;
}
async function bind(connectionId, teamId, sourceTeamId, userId) {
  return (await q(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id) values ($1,$2,'gpexe',$3,$4) returning id`, [teamId, connectionId, sourceTeamId, userId]))[0].id;
}
// One active binding per source team across the whole database: a test that bound team 980 ends its bindings before the next one.
async function endBindings(connectionId, userId) {
  await q(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'test finished' where connection_id = $1 and state = 'active'`, [connectionId, userId]);
}
async function rowOf(id) { return (await q(`select * from training_load.source_credential_connections where id = $1`, [id]))[0]; }
async function auditOf(id) { return q(`select action, outcome, error_code, performed_by_user_id, basis, metadata, team_id from training_load.source_connection_audit where connection_id = $1 order by performed_at, id`, [id]); }
function decryptRow(row) {
  const ring = cryptoMod.keyringFromEnv();
  return cryptoMod.decryptCredential({ ciphertext: row.credential_ciphertext, nonce: row.credential_nonce, authTag: row.credential_auth_tag, keyVersion: row.credential_key_version }, {
    connectionId: row.id, ownerScope: row.owner_scope, ownerClubId: row.owner_club_id, ownerTeamId: row.owner_team_id, sourceSystem: row.source_system, hostKey: row.host_key, credentialKind: row.credential_kind,
  }, ring);
}
// Every column of every F3c row, as text: no secret may be there except inside the ciphertext bytes.
async function dbTextOf(connectionId) {
  const conn = (await q(`select to_jsonb(c) - 'credential_ciphertext' - 'credential_nonce' - 'credential_auth_tag' as j from training_load.source_credential_connections c where id = $1`, [connectionId]))[0]?.j;
  const audit = await q(`select to_jsonb(a) as j from training_load.source_connection_audit a where connection_id = $1`, [connectionId]);
  const bindings = await q(`select to_jsonb(b) as j from training_load.source_team_bindings b where connection_id = $1`, [connectionId]);
  return JSON.stringify([conn, audit.map((r) => r.j), bindings.map((r) => r.j)]);
}

// ---------------------------------------------------------------------------
// The fake source: a fetch that answers the exchange and the rest_v1 reads
// of server3 and records every request. Nothing else is reachable.
// ---------------------------------------------------------------------------
function fakeSource({
  token = TOKEN, exchange = "ok", teams = [980, 981, 982, 983, 984, 985, 986, 987], teamRead = "ok", listRead = "ok",
  exchangeGate = null, onExchange = null, teamGate = null,
} = {}) {
  const calls = [];
  const json = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? null;
    const record = {
      url: u, method: init.method ?? "GET", redirect: init.redirect, headerNames: Object.keys(init.headers ?? {}).sort(),
      authPresent: auth !== null, authIsIssuedToken: auth === `Token ${token}` || auth === `Token ${TOKEN2}`,
      bodyShape: typeof init.body === "string" ? describeBody(init.body) : null,
    };
    calls.push(record);
    const abortable = (p) => new Promise((resolve, reject) => {
      if (init.signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      p.then(resolve, reject);
    });
    if (u === EXCHANGE_URL) {
      if (onExchange) onExchange();
      if (exchangeGate) await abortable(exchangeGate.p);
      if (init.method !== "POST") return json(405, { detail: SOURCE_SENTENCE });
      const params = new URLSearchParams(init.body);
      const ok = params.get("username") === USERNAME && params.get("password") === PASSWORD;
      switch (exchange) {
        case "ok": return ok ? json(200, { token }) : json(400, { non_field_errors: [SOURCE_SENTENCE] });
        case "401": return json(401, { detail: SOURCE_SENTENCE });
        case "403": return json(403, { detail: SOURCE_SENTENCE });
        case "429": return json(429, { detail: SOURCE_SENTENCE }, { "retry-after": "60" });
        case "500": return json(500, SOURCE_SENTENCE);
        case "redirect": return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
        case "hang": return abortable(new Promise(() => {}));
        case "network": throw new TypeError("fetch failed");
        case "huge": return json(200, `{"token":"${token}","padding":"${"x".repeat(70 * 1024)}"}`);
        case "not-json": return json(200, `<html>${SOURCE_SENTENCE}</html>`);
        case "no-token": return json(200, { detail: SOURCE_SENTENCE });
        case "token-with-space": return json(200, { token: "two words" });
        default: throw new Error(`unknown exchange mode ${exchange}`);
      }
    }
    if (!u.startsWith(BASE)) return json(404, { detail: "not served" });
    if (init.method !== "GET") return json(405, {});
    if (!record.authIsIssuedToken) return json(401, { detail: SOURCE_SENTENCE });
    const rel = u.slice(BASE.length);
    if (rel === "team/" || rel.startsWith("team/?")) {
      if (listRead === "500") return json(500, SOURCE_SENTENCE);
      if (listRead === "401") return json(401, { detail: SOURCE_SENTENCE });
      return json(200, teams.map((id) => ({ id, name: `Team ${id}` })), { "x-total-count": String(teams.length) });
    }
    const m = rel.match(/^team\/(\d+)\/$/);
    if (m) {
      if (teamGate) await abortable(teamGate.p);
      if (teamRead === "401") return json(401, { detail: SOURCE_SENTENCE });
      if (teamRead === "403") return json(403, { detail: SOURCE_SENTENCE });
      if (teamRead === "500") return json(500, SOURCE_SENTENCE);
      if (teamRead === "hang") return abortable(new Promise(() => {}));
      if (!teams.includes(Number(m[1]))) return json(404, { detail: SOURCE_SENTENCE });
      return json(200, { id: Number(m[1]), name: `Team ${m[1]}`, athlete_name: "Marker Athlete Name" });
    }
    return json(404, { detail: "not served" });
  };
  return { calls, fetchImpl };
}
function describeBody(body) {
  const params = new URLSearchParams(body);
  return { keys: [...params.keys()].sort(), usernameOnce: body.split("username=").length === 2, passwordOnce: body.split("password=").length === 2 };
}
const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
const useSource = (over) => { const s = fakeSource(over); service.setSourceFetchForTests(s.fetchImpl); return s; };
const exchangeCalls = (calls) => calls.filter((c) => c.url === EXCHANGE_URL);
const readCalls = (calls) => calls.filter((c) => c.url.startsWith(BASE));

// ---------------------------------------------------------------------------
// 1. Migration v29
// ---------------------------------------------------------------------------
test("1. v29 applies on v28, enforces the two state/fact invariants, adds the per-user index, rolls back exactly, applies again, and the rollback refuses under a later migration", async () => {
  const m = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v29mig", migrations: UP_TO_V28 });
  const k = new pg.Client({ connectionString: m.url });
  await k.connect();
  try {
    assert.equal((await k.query("select current_database() as db")).rows[0].db, m.name);
    const constraints = async () => (await k.query(`select conname from pg_constraint where conrelid = 'training_load.source_credential_connections'::regclass order by 1`)).rows.map((r) => r.conname);
    const before = await constraints();
    assert.ok(!before.includes("source_credential_connections_state_linked_untested_facts"), `v28 constraints: ${before.join(",")}`);
    // Before v29 the gap is real: a linked_untested row without facts is accepted (and never by the routes).
    const club = (await k.query(`insert into public.clubs (name) values ('C') returning id`)).rows[0].id;
    const user = (await k.query(`insert into public.users (email) values ('u@test.local') returning id`)).rows[0].id;
    const parts = cryptoMod.encryptCredential(TOKEN, { connectionId: "00000000-0000-0000-0000-000000000001", ownerScope: "club", ownerClubId: club, ownerTeamId: null, sourceSystem: "gpexe", hostKey: "server3", credentialKind: "exchanged_token" }, cryptoMod.parseKeyring(cryptoMod.generateKeyEntry(1)));
    const insertState = (state, extra = {}) => k.query(
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state, credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_error_code, last_error_at, last_verified_at)
       values ('gpexe','club',$1,'server3','L','exchanged_token',$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [club, user, state, extra.cipher === false ? null : parts.ciphertext, extra.cipher === false ? null : parts.nonce, extra.cipher === false ? null : parts.authTag, extra.cipher === false ? null : parts.keyVersion, extra.code ?? null, extra.at ?? null, extra.verifiedAt ?? null],
    );
    const gapRow = (await insertState("linked_untested")).rows[0].id;
    await k.query(`delete from training_load.source_credential_connections where id = $1`, [gapRow]);

    await applyGpexeTestMigrations(m.url, [...UP_TO_V28, V29]);
    const after29 = await constraints();
    assert.ok(after29.includes("source_credential_connections_state_linked_untested_facts"));
    assert.ok(after29.includes("source_credential_connections_state_has_credential"));
    assert.equal((await k.query(`select count(*)::int as n from pg_indexes where schemaname = 'training_load' and indexname = 'source_connection_audit_user_attempts_idx'`)).rows[0].n, 1);
    // The invariants hold now.
    await assert.rejects(insertState("linked_untested"), /state_linked_untested_facts/);
    await assert.rejects(insertState("linked_untested", { code: "source_unavailable" }), /state_linked_untested_facts/);
    const okRow = (await insertState("linked_untested", { code: "source_unavailable", at: new Date() })).rows[0].id;
    for (const state of ["linked_untested", "needs_reconnect", "source_unavailable"]) {
      await assert.rejects(insertState(state, { cipher: false, code: "source_auth_rejected", at: new Date() }), /state_has_credential/, state);
    }
    await k.query(`delete from training_load.source_credential_connections where id = $1`, [okRow]);
    // Rollback: exactly v28 again; apply again; refuse under a later migration.
    const rollbackSql = await fsp.readFile(V29_ROLLBACK, "utf8");
    await k.query(rollbackSql);
    assert.deepEqual(await constraints(), before, "the rollback leaves exactly the v28 constraints");
    assert.equal((await k.query(`select count(*)::int as n from public.schema_migrations where migration_name like $1`, [`%${V29}`])).rows[0].n, 0);
    await applyGpexeTestMigrations(m.url, [...UP_TO_V28, V29]);
    assert.deepEqual(await constraints(), after29, "v29 applies again, identically");
    await k.query("begin");
    await k.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ('migrations_v2/209901010000_test_only_later.sql', repeat('0', 64), 0, 'test')`);
    await assert.rejects(k.query(rollbackSql), /v29 rollback refused: later migrations are applied/);
    await k.query("rollback").catch(() => {});
    assert.deepEqual(await constraints(), after29, "a refused rollback drops nothing");
    // The migration file carries no key, URL or transaction control.
    const sql = await fsp.readFile(path.resolve(ROOT, "migrations_v2", V29), "utf8");
    assert.doesNotMatch(sql, /https?:\/\/|SOURCE_CREDENTIAL_KEYS|^\s*(begin|commit|rollback)\b/im);
  } finally {
    await k.end();
    await m.drop();
  }
});

// ---------------------------------------------------------------------------
// 2. Route contract and info hiding
// ---------------------------------------------------------------------------
test("2. only a platform admin in the platform or the owning club's workspace sees or touches a connection; a club admin, a coach, another club's workspace, an archived club and a malformed id all get 404; a signed-out caller 401; a form body 415; an unknown field 400", async () => {
  const { club, team } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  const ca = await clubAdmin(club);
  const co = await coachOf(team);
  const other = await org();
  const paOtherClub = await platformAdmin(["club", other.club]);
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [paOtherClub.id, other.club]);
  for (const [who, cookie] of [["club admin", ca.cookie], ["coach", co.cookie], ["platform admin acting in another club's workspace", paOtherClub.cookie]]) {
    assert.equal((await api(`/gpexe/connections/${conn.id}`, { cookie })).status, 404, who);
    assert.equal((await api(`/gpexe/connections?clubId=${club}`, { cookie })).status, 404, who);
    assert.equal((await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie, body: {} })).status, 404, who);
    assert.equal((await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie, body: { username: "x", password: "y" } })).status, 404, who);
    assert.equal((await api(`/gpexe/connections`, { method: "POST", cookie, body: CREATE(club) })).status, 404, who);
  }
  assert.equal((await api(`/gpexe/connections/${conn.id}`)).status, 401, "signed out");
  assert.equal((await api(`/gpexe/connections/${crypto.randomUUID()}`, { cookie: pa.cookie })).status, 404);
  assert.equal((await api(`/gpexe/connections/not-a-uuid`, { cookie: pa.cookie })).status, 404);
  assert.equal((await api(`/garmin/connections/${conn.id}`, { cookie: pa.cookie })).status, 404, "another source");
  assert.equal((await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: "username=a&password=b", contentType: "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: "a", password: "b", extra: 1 } })).body.error, "invalid_body");
  assert.equal((await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: "a" } })).body.error, "invalid_body");
  assert.equal((await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: "a", password: "b\nc" } })).body.error, "invalid_body");
  // A platform admin who is also this club's admin, acting in the club workspace, sees it; the platform workspace too.
  const paClub = await platformAdmin(["club", club]);
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [paClub.id, club]);
  assert.equal((await api(`/gpexe/connections/${conn.id}`, { cookie: paClub.cookie })).status, 200);
  const list = await api(`/gpexe/connections?clubId=${club}`, { cookie: pa.cookie });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.connections.map((c) => c.id), [conn.id]);
  assert.deepEqual(Object.keys(list.body.connections[0]).sort(), ["accountLabel", "boundTeams", "createdAt", "credentialKind", "hasCredential", "hostKey", "hostLabel", "id", "lastErrorAt", "lastErrorCode", "lastVerifiedAt", "ownerClubId", "ownerScope", "sourceSystem", "state", "updatedAt"]);
  // An archived club hides its connection, for reads and writes alike.
  await q(`update public.clubs set is_active = false where id = $1`, [club]);
  assert.equal((await api(`/gpexe/connections/${conn.id}`, { cookie: pa.cookie })).status, 404);
  assert.equal((await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} })).status, 404);
  assert.equal((await api(`/gpexe/connections`, { method: "POST", cookie: pa.cookie, body: CREATE(club) })).status, 404);
  await q(`update public.clubs set is_active = true where id = $1`, [club]);
  // No malformed body is ever audited; the create row is the only audit row.
  assert.deepEqual((await auditOf(conn.id)).map((a) => a.action), ["create"]);
});

test("3. create: club-owned only, an approved host that this backend can resolve, read and exchange on (server3), the exchanged-token kind only; e03, an unknown key, a URL, a team scope and api_token are refused; the row is not_connected with one audit row", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const create = (over) => api("/gpexe/connections", { method: "POST", cookie: pa.cookie, body: CREATE(club, over) });
  assert.equal((await create({ hostKey: "e03" })).body.error, "exchange_not_supported");
  assert.equal((await create({ hostKey: "server4" })).body.error, "host_not_allowed");
  assert.equal((await create({ hostKey: "https://server3.gpexe.com/" })).body.error, "invalid_body");
  assert.equal((await create({ ownerScope: "team" })).body.error, "owner_scope_unsupported");
  assert.equal((await create({ credentialKind: "api_token" })).body.error, "credential_kind_unsupported");
  const r = await create({});
  assert.equal(r.status, 201);
  const c = r.body.connection;
  assert.equal(c.state, "not_connected");
  assert.equal(c.hasCredential, false);
  assert.equal(c.hostLabel, "GPEXE server3");
  assert.deepEqual(c.boundTeams, []);
  const row = await rowOf(c.id);
  assert.equal(row.credential_ciphertext, null);
  assert.deepEqual((await auditOf(c.id)).map(({ action, outcome, basis, metadata }) => ({ action, outcome, basis, metadata })), [{ action: "create", outcome: "ok", basis: "platform_admin", metadata: { host_key: "server3", credential_kind: "exchanged_token" } }]);
  // Retired catalog key: no new connection.
  await q(`update training_load.source_host_catalog set state = 'retired' where host_key = 'server3'`);
  try {
    assert.equal((await create({})).body.error, "host_not_allowed");
  } finally {
    await q(`update training_load.source_host_catalog set state = 'approved' where host_key = 'server3'`);
  }
});

// ---------------------------------------------------------------------------
// 4–5. Connect
// ---------------------------------------------------------------------------
test("4. connect: one form-encoded POST to exactly the confirmed exchange endpoint, then one GET on the team list with the issued token; the token is stored AES-256-GCM under the row's context and nothing else; state verified; the audit row names facts only; no secret in the response, the audit, the row or the log", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  const src = useSource();
  const r = await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.outcome, "ok", JSON.stringify(r.body.result));
  assert.equal(r.body.result.state, "verified");
  assert.equal(r.body.result.sourceTeamCount, 8);
  assert.equal(r.body.result.boundTeamsChecked, 0);
  assert.equal(r.body.connection.state, "verified");
  assert.equal(r.body.connection.hasCredential, true);
  assert.deepEqual(src.calls.map((c) => [c.method, c.url, c.redirect]), [["POST", EXCHANGE_URL, "manual"], ["GET", `${BASE}team/`, "manual"]]);
  assert.deepEqual(src.calls[0].bodyShape, { keys: ["password", "username"], usernameOnce: true, passwordOnce: true });
  assert.deepEqual(src.calls[0].headerNames, ["Accept", "Content-Type"]);
  assert.equal(src.calls[0].authPresent, false, "the exchange carries no Authorization header");
  assert.equal(src.calls[1].authIsIssuedToken, true, "the test read uses the issued token");
  const row = await rowOf(conn.id);
  assert.equal(decryptRow(row), TOKEN);
  assert.ok(!row.credential_ciphertext.toString("utf8").includes(TOKEN), "the ciphertext is not the plaintext");
  assert.equal(row.credential_key_version, 1);
  assert.equal(row.state, "verified");
  assert.ok(row.last_verified_at);
  assert.equal(row.last_error_code, null);
  const audit = await auditOf(conn.id);
  assert.deepEqual(audit.map((a) => [a.action, a.outcome, a.error_code]), [["create", "ok", null], ["connect", "ok", null]]);
  assert.deepEqual(audit[1].metadata, { host_key: "server3", credential_kind: "exchanged_token", status_class: "2xx", attempt_no: 1, bound_team_count: 0, source_team_count: 8, counted: true });
  assert.equal(audit[1].performed_by_user_id, pa.id);
  noSecret(await dbTextOf(conn.id), "the database rows");
  // A second connect on a connected row is refused and audited, not counted.
  const again = await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "already_connected");
  assert.equal(src.calls.length, 2, "nothing more was sent");
  assert.deepEqual((await auditOf(conn.id)).at(-1).metadata.counted, false);
  // The GET answers never carry a credential part.
  const read = await api(`/gpexe/connections/${conn.id}`, { cookie: pa.cookie });
  assert.equal(read.body.connection.hasCredential, true);
  assert.ok(!("credentialCiphertext" in read.body.connection) && !("token" in read.body.connection));
});

test("5. connect with bound teams: the account sees eight teams, but the test reads exactly the bound teams' own rows (team 980 and the other binding), never the list, never another team; no binding is created or changed by the route; an archived bound team is skipped", async () => {
  const { club, team, team2 } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  await bind(conn.id, team, "980", pa.id);
  await bind(conn.id, team2, "983", pa.id);
  const bindingsBefore = await q(`select id, team_id, source_team_id, state from training_load.source_team_bindings where connection_id = $1 order by team_id`, [conn.id]);
  const src = useSource();
  const r = await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.boundTeamsChecked, 2);
  assert.equal(r.body.result.sourceTeamCount, null);
  const reads = readCalls(src.calls).map((c) => c.url.slice(BASE.length));
  assert.deepEqual(reads.sort(), ["team/980/", "team/983/"]);
  assert.ok(!src.calls.some((c) => c.url.includes("team/?")), "the list is never read when a binding exists");
  assert.deepEqual(await q(`select id, team_id, source_team_id, state from training_load.source_team_bindings where connection_id = $1 order by team_id`, [conn.id]), bindingsBefore, "bindings untouched");
  assert.equal((await q(`select count(*)::int as n from training_load.source_team_bindings where connection_id = $1`, [conn.id]))[0].n, 2);
  assert.deepEqual(r.body.connection.boundTeams.map((b) => b.sourceTeamId).sort(), ["980", "983"]);
  // A bound team the account cannot see: the whole test fails as source_team_not_visible; nothing is bound or unbound.
  const src2 = useSource({ teams: [980] });
  const t = await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} });
  assert.equal(t.status, 200);
  assert.equal(t.body.result.outcome, "failed");
  assert.equal(t.body.result.code, "source_team_not_visible");
  assert.equal(t.body.connection.state, "source_unavailable");
  assert.ok(readCalls(src2.calls).length <= 2);
  // Archive the second team: only team 980 is read.
  await q(`update public.teams set is_active = false where id = $1`, [team2]);
  const src3 = useSource();
  const t2 = await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} });
  assert.equal(t2.body.result.boundTeamsChecked, 1);
  assert.deepEqual(readCalls(src3.calls).map((c) => c.url.slice(BASE.length)), ["team/980/"]);
  assert.equal(t2.body.connection.state, "verified");
  // Moving a bound team to another club is refused by the database while the binding is active.
  const otherClub = (await q(`insert into public.clubs (name) values ('Other') returning id`))[0].id;
  await assert.rejects(q(`update public.teams set club_id = $1 where id = $2`, [otherClub, team]), /end that binding before moving the team/);
  await endBindings(conn.id, pa.id);
});

// ---------------------------------------------------------------------------
// 6. Every answer class of the exchange
// ---------------------------------------------------------------------------
test("6. a wrong credential (400/401/403) is source_auth_rejected, counted, nothing stored; 429 and 5xx, a network failure and a timeout are source_unavailable; a redirect, an oversized answer, a non-JSON answer, a missing or malformed token field are source_answer_unexpected; the source's sentence appears nowhere and the state stays not_connected", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const cases = [
    ["400 wrong pair", { exchange: "ok" }, { username: "someone-else", password: "wrong" }, 409, "source_auth_rejected", "refused", "4xx"],
    ["401", { exchange: "401" }, null, 409, "source_auth_rejected", "refused", "4xx"],
    ["403", { exchange: "403" }, null, 409, "source_auth_rejected", "refused", "4xx"],
    ["429", { exchange: "429" }, null, 502, "source_unavailable", "failed", "4xx"],
    ["500", { exchange: "500" }, null, 502, "source_unavailable", "failed", "5xx"],
    ["network", { exchange: "network" }, null, 502, "source_unavailable", "failed", "network"],
    ["timeout", { exchange: "hang" }, null, 502, "source_unavailable", "failed", "network"],
    ["redirect", { exchange: "redirect" }, null, 502, "source_answer_unexpected", "failed", "3xx"],
    ["oversized", { exchange: "huge" }, null, 502, "source_answer_unexpected", "failed", "2xx"],
    ["not JSON", { exchange: "not-json" }, null, 502, "source_answer_unexpected", "failed", "2xx"],
    ["no token field", { exchange: "no-token" }, null, 502, "source_answer_unexpected", "failed", "2xx"],
    ["token with whitespace", { exchange: "token-with-space" }, null, 502, "source_answer_unexpected", "failed", "2xx"],
  ];
  for (const [label, mode, pair, status, code, outcome, statusClass] of cases) {
    // A fresh admin per case keeps the per-user throttle out of this test.
    const user = await platformAdmin();
    const conn = await created(user, club);
    const src = useSource(mode);
    const r = await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: user.cookie, body: pair ?? { username: USERNAME, password: PASSWORD } });
    assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, code, label);
    assert.equal(exchangeCalls(src.calls).length, 1, `${label}: one exchange`);
    assert.equal(readCalls(src.calls).length, 0, `${label}: no read after a failed exchange`);
    const row = await rowOf(conn.id);
    assert.equal(row.state, "not_connected", label);
    assert.equal(row.credential_ciphertext, null, label);
    const last = (await auditOf(conn.id)).at(-1);
    assert.deepEqual([last.action, last.outcome, last.error_code, last.metadata.status_class, last.metadata.counted], ["connect", outcome, code, statusClass, true], label);
    noSecret(await dbTextOf(conn.id), label);
  }
});

// ---------------------------------------------------------------------------
// 7. Test connection
// ---------------------------------------------------------------------------
test("7. test uses the stored token on exactly the chosen host: ok → verified; 401 on the read → needs_reconnect (ciphertext kept); 5xx / timeout → source_unavailable; a later ok clears the error; a test on a not_connected row is refused without a request; the username is never sent again", async () => {
  const { club, team } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  await bind(conn.id, team, "980", pa.id);
  assert.equal((await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} })).body.error, "not_connected");
  useSource();
  assert.equal((await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } })).body.result.state, "verified");
  const cipherBefore = (await rowOf(conn.id)).credential_ciphertext;
  // Six attempts follow in this test; the window is moved past the first ones so the throttle stays out of it.
  service.setSourceConnectionClockForTests(() => new Date(Date.now() + 16 * 60 * 1000));
  const steps = [
    [{ teamRead: "401" }, "needs_reconnect", "source_auth_rejected", "refused"],
    [{ teamRead: "403" }, "source_unavailable", "source_team_not_visible", "failed"],
    [{ teamRead: "500" }, "source_unavailable", "source_unavailable", "failed"],
    [{ teamRead: "hang" }, "source_unavailable", "source_unavailable", "failed"],
    [{}, "verified", null, "ok"],
  ];
  for (const [mode, state, code, outcome] of steps) {
    const src = useSource(mode);
    const r = await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.state, state, JSON.stringify(mode));
    assert.equal(r.body.result.code, code);
    assert.equal(r.body.result.outcome, outcome);
    assert.deepEqual(src.calls.map((c) => [c.method, c.url, c.authIsIssuedToken]), [["GET", `${BASE}team/980/`, true]], "exactly the bound team's own read with the stored token");
    assert.equal(exchangeCalls(src.calls).length, 0, "a test never exchanges");
    const row = await rowOf(conn.id);
    assert.equal(row.state, state);
    assert.ok(row.credential_ciphertext.equals(cipherBefore), "the stored credential is kept");
    if (state === "verified") { assert.equal(row.last_error_code, null); assert.equal(row.last_error_at, null); } else { assert.equal(row.last_error_code, code); assert.ok(row.last_error_at); }
  }
  service.setSourceConnectionClockForTests(null);
  // A test does not accept a body with fields.
  assert.equal((await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME } })).body.error, "invalid_body");
  await endBindings(conn.id, pa.id);
});

// ---------------------------------------------------------------------------
// 8. Reconnect
// ---------------------------------------------------------------------------
test("8. reconnect needs a confirmation that names the source, the owning club and the number of bound teams exactly; a mismatch is refused before any request and audited, not counted; a matching one exchanges, stores a new ciphertext with a new nonce, and verifies; a refused exchange keeps the old credential", async () => {
  const { club, team, team2 } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  await bind(conn.id, team, "980", pa.id);
  await bind(conn.id, team2, "981", pa.id);
  useSource();
  assert.equal((await api(`/gpexe/connections/${conn.id}/reconnect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD, confirmation: { sourceSystem: "gpexe", ownerClubId: club, affectedTeamCount: 2 } } })).body.error, "not_connected", "reconnect needs a credential first");
  await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
  const before = await rowOf(conn.id);
  const src = useSource({ token: TOKEN2 });
  for (const [label, confirmation] of [
    ["wrong team count", { sourceSystem: "gpexe", ownerClubId: club, affectedTeamCount: 1 }],
    ["wrong club", { sourceSystem: "gpexe", ownerClubId: crypto.randomUUID(), affectedTeamCount: 2 }],
    ["wrong source", { sourceSystem: "garmin", ownerClubId: club, affectedTeamCount: 2 }],
  ]) {
    const r = await api(`/gpexe/connections/${conn.id}/reconnect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD, confirmation } });
    assert.equal(r.status, 409, label);
    assert.equal(r.body.error, "confirmation_mismatch", label);
    assert.deepEqual(r.body.expected, { sourceSystem: "gpexe", ownerClubId: club, affectedTeamCount: 2 }, label);
    assert.equal(src.calls.length, 0, `${label}: nothing sent`);
    const last = (await auditOf(conn.id)).at(-1);
    assert.deepEqual([last.action, last.outcome, last.error_code, last.metadata.counted], ["reconnect", "refused", "confirmation_mismatch", false], label);
  }
  assert.equal((await api(`/gpexe/connections/${conn.id}/reconnect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } })).body.error, "invalid_body", "no confirmation at all");
  const ok = await api(`/gpexe/connections/${conn.id}/reconnect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD, confirmation: { sourceSystem: "gpexe", ownerClubId: club, affectedTeamCount: 2 } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.result.state, "verified");
  assert.equal(ok.body.result.boundTeamsChecked, 2);
  const after = await rowOf(conn.id);
  assert.equal(decryptRow(after), TOKEN2);
  assert.ok(!after.credential_nonce.equals(before.credential_nonce), "a new nonce");
  assert.ok(!after.credential_ciphertext.equals(before.credential_ciphertext));
  // The bound teams are read in the lock order (ascending OptiMove team id), so the two reads may come either way round.
  assert.deepEqual(src.calls[0].url, EXCHANGE_URL);
  assert.deepEqual(src.calls.slice(1).map((c) => [c.method, c.url.replace(BASE, "")]).sort(), [["GET", "team/980/"], ["GET", "team/981/"]]);
  // A refused exchange on reconnect keeps the old credential and the state.
  useSource({ exchange: "401" });
  const bad = await api(`/gpexe/connections/${conn.id}/reconnect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD, confirmation: { sourceSystem: "gpexe", ownerClubId: club, affectedTeamCount: 2 } } });
  assert.equal(bad.body.error, "source_auth_rejected");
  const kept = await rowOf(conn.id);
  assert.ok(kept.credential_ciphertext.equals(after.credential_ciphertext));
  assert.equal(kept.state, "verified");
  // After needs_reconnect, reconnect works and clears it.
  useSource({ teamRead: "401" });
  assert.equal((await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} })).body.result.state, "needs_reconnect");
  useSource();
  assert.equal((await api(`/gpexe/connections/${conn.id}/reconnect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD, confirmation: { sourceSystem: "gpexe", ownerClubId: club, affectedTeamCount: 2 } } })).body.result.state, "verified");
  noSecret(await dbTextOf(conn.id), "the database rows");
  await endBindings(conn.id, pa.id);
});

// ---------------------------------------------------------------------------
// 9. The host gate
// ---------------------------------------------------------------------------
test("9. a host retired between the row's creation and the call: connect, reconnect and test answer host_not_allowed with zero requests, audited and not counted; a retired key between two tests turns the second into host_not_allowed", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  const src = useSource();
  assert.equal((await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } })).body.result.state, "verified");
  assert.equal((await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} })).status, 200);
  const sent = src.calls.length;
  await q(`update training_load.source_host_catalog set state = 'retired' where host_key = 'server3'`);
  try {
    for (const [path, body] of [["test", {}], ["reconnect", { username: USERNAME, password: PASSWORD, confirmation: { sourceSystem: "gpexe", ownerClubId: club, affectedTeamCount: 0 } }]]) {
      const r = await api(`/gpexe/connections/${conn.id}/${path}`, { method: "POST", cookie: pa.cookie, body });
      assert.equal(r.status, 409, path);
      assert.equal(r.body.error, "host_not_allowed", path);
      const last = (await auditOf(conn.id)).at(-1);
      assert.deepEqual([last.outcome, last.error_code, last.metadata.counted], ["refused", "host_not_allowed", false], path);
    }
    const fresh = await created(pa, club).catch(() => null);
    assert.equal(fresh, null, "no new connection on a retired key");
    assert.equal(src.calls.length, sent, "zero requests while retired");
    assert.equal((await rowOf(conn.id)).state, "verified", "the state is untouched");
  } finally {
    await q(`update training_load.source_host_catalog set state = 'approved' where host_key = 'server3'`);
  }
});

// ---------------------------------------------------------------------------
// 10. Throttle
// ---------------------------------------------------------------------------
test("10. throttle: five attempts that reached the source in 15 minutes, per connection and per user; the sixth is 429 with zero requests, audited and not counted; a seventh does not extend the window; the window slides; a test does not reset it; across two connections two truly concurrent requests of one user let exactly one through", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  let src = useSource({ exchange: "401" });
  const connect = (cookie = pa.cookie, id = conn.id) => api(`/gpexe/connections/${id}/connect`, { method: "POST", cookie, body: { username: USERNAME, password: PASSWORD } });
  for (let i = 1; i <= 5; i += 1) {
    const r = await connect();
    assert.equal(r.body.error, "source_auth_rejected", `attempt ${i}`);
    assert.equal((await auditOf(conn.id)).at(-1).metadata.attempt_no, i);
  }
  assert.equal(exchangeCalls(src.calls).length, 5);
  for (const n of [6, 7]) {
    const r = await connect();
    assert.equal(r.status, 429, `attempt ${n}`);
    assert.equal(r.body.error, "source_auth_throttled");
    assert.equal(r.headers.get("retry-after"), "900");
    assert.equal(exchangeCalls(src.calls).length, 5, "nothing reached the source");
    const last = (await auditOf(conn.id)).at(-1);
    assert.deepEqual([last.outcome, last.error_code, last.metadata.counted], ["refused", "source_auth_throttled", false]);
  }
  // Per user: the same admin on a fresh connection is throttled too; another admin is not.
  const conn2 = await created(pa, club);
  assert.equal((await connect(pa.cookie, conn2.id)).status, 429, "per user across connections");
  const other = await platformAdmin();
  assert.equal((await connect(other.cookie, conn2.id)).body.error, "source_auth_rejected", "another user has their own window");
  // The window slides: 16 minutes later the same user is allowed again.
  service.setSourceConnectionClockForTests(() => new Date(Date.now() + 16 * 60 * 1000));
  try {
    assert.equal((await connect()).body.error, "source_auth_rejected", "allowed again after the window");
  } finally {
    service.setSourceConnectionClockForTests(null);
  }
  // Two truly concurrent requests of one user with four counted attempts: exactly one reaches the source.
  const user = await platformAdmin();
  const a = await created(user, club);
  const b = await created(user, club);
  src = useSource({ exchange: "401" });
  for (let i = 0; i < 4; i += 1) assert.equal((await connect(user.cookie, a.id)).body.error, "source_auth_rejected");
  const g = gate();
  let entered = 0;
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 10_000, testTimeout: 10_000 });
  src = useSource({ exchange: "401", exchangeGate: g, onExchange: () => { entered += 1; } });
  const p1 = connect(user.cookie, a.id);
  const p2 = connect(user.cookie, b.id);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(entered, 1, "only one request is at the source while the other waits on the user's lock");
  g.release();
  const results = await Promise.all([p1, p2]);
  assert.deepEqual(results.map((r) => r.body.error).sort(), ["source_auth_rejected", "source_auth_throttled"]);
  assert.equal(exchangeCalls(src.calls).length, 1, "exactly one reached the source");
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
  // A successful test does not reset the count: still throttled.
  assert.equal((await connect(user.cookie, b.id)).status, 429);
  // Five refusals that never reached the source, inside the window, do not count: the user's next attempt reaches the source.
  const fresh = await platformAdmin();
  const f = await created(fresh, club);
  for (let i = 0; i < 5; i += 1) {
    await q(`insert into training_load.source_connection_audit (connection_id, action, outcome, error_code, performed_by_user_id, basis, metadata) values ($1,'connect','refused','source_auth_throttled',$2,'platform_admin','{"counted": false}'::jsonb)`, [f.id, fresh.id]);
  }
  src = useSource({ exchange: "401" });
  assert.equal((await connect(fresh.cookie, f.id)).body.error, "source_auth_rejected", "uncounted refusals never lock anyone out");
  assert.equal(exchangeCalls(src.calls).length, 1);
});

// ---------------------------------------------------------------------------
// 11. Concurrency and locks
// ---------------------------------------------------------------------------
test("11. two overlapping attempts on one connection: one runs, the other answers try_again at once without a request; an attempt while another session holds a bound team's import lock is try_again with zero requests; a binding inserted during an attempt waits or is refused, never half; the audit rows are in order", async () => {
  const { club, team } = await org();
  const pa = await platformAdmin();
  const pb = await platformAdmin();
  const conn = await created(pa, club);
  await bind(conn.id, team, "980", pa.id);
  // Overlapping: pa's connect is held at the exchange; pb's connect on the same row times out on the row lock.
  // The gates are held longer than the suite's short network timeout, so the first attempt really holds its locks meanwhile.
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 10_000, testTimeout: 10_000 });
  const g = gate();
  const src = useSource({ exchangeGate: g });
  const first = api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
  for (let i = 0; i < 50 && src.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(src.calls.length, 1, "the first attempt reached the exchange and holds the row lock");
  const started = Date.now();
  const second = await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pb.cookie, body: {} });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "try_again");
  assert.ok(Date.now() - started < 10_000, "try_again comes from the bounded row lock, not a hang");
  assert.equal(src.calls.length, 1, "the second attempt sent nothing");
  g.release();
  const r1 = await first;
  assert.equal(r1.body.result.state, "verified");
  const audit = await auditOf(conn.id);
  // performed_at is the transaction's start time, so the attempt that ran (started first) sorts before the refusal it caused; both rows exist, each by its own user.
  assert.deepEqual(audit.map((a) => [a.action, a.outcome, a.error_code]).sort(), [["connect", "ok", null], ["create", "ok", null], ["test", "refused", "try_again"]]);
  assert.equal(audit.find((a) => a.error_code === "try_again").performed_by_user_id, pb.id);
  assert.equal(audit.find((a) => a.action === "connect").performed_by_user_id, pa.id);
  // A bound team's import lock held elsewhere: try_again, zero requests.
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`gpexe-import-team:${team}`]);
    const src2 = useSource();
    const r = await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} });
    assert.equal(r.body.error, "try_again");
    assert.equal(r.body.teamId, team);
    assert.equal(src2.calls.length, 0);
    assert.deepEqual((await auditOf(conn.id)).at(-1).metadata.counted, false);
    await holder.query("rollback");
  } finally {
    await holder.end();
  }
  // A binding inserted while an attempt holds the team lock: the trigger's try-lock refuses it; after the attempt it lands.
  const { team2 } = await (async () => ({ team2: (await q(`insert into public.teams (club_id, name) values ($1,'T2') returning id`, [club]))[0].id }))();
  const g2 = gate();
  const src3 = useSource({ teamGate: g2 });
  const inFlight = api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} });
  await new Promise((r) => setTimeout(r, 200));
  // Only the try-lock can refuse this: ending the locked team's binding (the update trigger try-locks the same team).
  await assert.rejects(q(`update training_load.source_team_bindings set state = 'ended', ended_at = now(), ended_by_user_id = $2, end_reason = 'x' where connection_id = $1 and team_id = $3 and state = 'active'`, [conn.id, pa.id, team]), /try again when it has finished/, "the attempt holds the bound team's import lock");
  // Another team of the club: the trigger's FOR SHARE on the connection waits for the attempt (v27), then lands whole.
  const okBind = bind(conn.id, team2, "981", pa.id);
  g2.release();
  assert.equal((await inFlight).status, 200);
  assert.ok(await okBind, "another team of the club binds once the attempt committed");
  assert.ok(src3.calls.length >= 1);
  assert.equal(r1.body.result.state, "verified", JSON.stringify(r1.body));
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
  await endBindings(conn.id, pa.id);
});

// ---------------------------------------------------------------------------
// 12. Keys and crypto in the route
// ---------------------------------------------------------------------------
test("12. without SOURCE_CREDENTIAL_KEYS every attempt answers key_missing with zero requests and no state change; a stored credential that no longer decrypts answers credential_unreadable; the stored parts decrypt only under the row's own context", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  const keys = process.env.SOURCE_CREDENTIAL_KEYS;
  delete process.env.SOURCE_CREDENTIAL_KEYS;
  try {
    const src = useSource();
    const r = await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "key_missing");
    assert.equal(src.calls.length, 0, "nothing was sent without a key to store the answer under");
    assert.equal((await rowOf(conn.id)).state, "not_connected");
    assert.deepEqual((await auditOf(conn.id)).at(-1).metadata.counted, false);
  } finally {
    process.env.SOURCE_CREDENTIAL_KEYS = keys;
  }
  useSource();
  assert.equal((await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } })).body.result.state, "verified");
  const row = await rowOf(conn.id);
  assert.throws(() => cryptoMod.decryptCredential({ ciphertext: row.credential_ciphertext, nonce: row.credential_nonce, authTag: row.credential_auth_tag, keyVersion: row.credential_key_version }, {
    connectionId: row.id, ownerScope: "club", ownerClubId: crypto.randomUUID(), ownerTeamId: null, sourceSystem: "gpexe", hostKey: "server3", credentialKind: "exchanged_token",
  }, cryptoMod.keyringFromEnv()), (e) => e.code === "decrypt_failed", "another owner cannot decrypt");
  // Tamper with the stored nonce: the next test cannot read the credential and sends nothing.
  await q(`alter table training_load.source_credential_connections disable trigger source_credential_connections_protect_identity`);
  await q(`update training_load.source_credential_connections set credential_nonce = $2 where id = $1`, [conn.id, crypto.randomBytes(12)]);
  await q(`alter table training_load.source_credential_connections enable trigger source_credential_connections_protect_identity`);
  const src = useSource();
  const t = await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} });
  assert.equal(t.status, 503);
  assert.equal(t.body.error, "credential_unreadable");
  assert.equal(src.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 13. The COMMIT outcome
// ---------------------------------------------------------------------------
test("13. an answer lost after the source call: the in-request verify on a fresh connection answers the committed outcome; when the verify cannot resolve it, outcome_unknown with a second audit row 'unknown' by the same user and basis (never system), state as committed", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  useSource();
  // The COMMIT really runs, but its answer is lost.
  service.setSourceConnectionCommitForTests({ fault: async (client) => { await client.query("commit"); throw Object.assign(new Error("connection reset after commit"), { code: "ECONNRESET" }); } });
  try {
    const r = await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.commitConfirmation, "verified_after_commit_error");
    assert.equal(r.body.result.state, "verified");
  } finally {
    service.setSourceConnectionCommitForTests();
  }
  assert.equal((await rowOf(conn.id)).state, "verified");
  // The COMMIT hangs and the verify cannot answer in time.
  const conn2 = await created(pa, club);
  service.setSourceConnectionCommitForTests({
    fault: async (client) => { await client.query("commit"); await new Promise(() => {}); }, timeoutMs: 200,
    checkFault: async () => { await new Promise(() => {}); }, checkTimeoutMs: 200,
  });
  try {
    const r = await api(`/gpexe/connections/${conn2.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "outcome_unknown");
    assert.equal(r.body.connectionId, conn2.id);
  } finally {
    service.setSourceConnectionCommitForTests();
  }
  assert.equal((await rowOf(conn2.id)).state, "verified", "the row is as committed");
  const audit = await auditOf(conn2.id);
  assert.deepEqual(audit.map((a) => [a.action, a.outcome, a.error_code, a.basis]), [["create", "ok", null, "platform_admin"], ["connect", "ok", null, "platform_admin"], ["connect", "unknown", "outcome_unknown", "platform_admin"]]);
  assert.ok(audit.every((a) => a.performed_by_user_id === pa.id));
  await assert.rejects(q(`insert into training_load.source_connection_audit (connection_id, action, outcome, error_code, performed_by_user_id, basis) values ($1,'connect','unknown','outcome_unknown',null,'system')`, [conn2.id]), /source_connection_audit_actor/);
  // The client re-reads the state instead of resending.
  assert.equal((await api(`/gpexe/connections/${conn2.id}`, { cookie: pa.cookie })).body.connection.state, "verified");
});

// ---------------------------------------------------------------------------
// 14. Secrets: audit key allowlist, logs, columns
// ---------------------------------------------------------------------------
test("14. the audit trigger refuses a secret-named key the service could mistakenly write; the service's own allowlist refuses it first; across the whole suite no console line carried a username, a password, a token or a source sentence", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  await assert.rejects(q(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis, metadata) values ($1,'test','ok',$2,'platform_admin','{"username":"x"}'::jsonb)`, [conn.id, pa.id]), /metadata_no_secret_keys/);
  await assert.rejects(q(`insert into training_load.source_connection_audit (connection_id, action, outcome, performed_by_user_id, basis, metadata) values ($1,'test','ok',$2,'platform_admin','{"authToken":"x"}'::jsonb)`, [conn.id, pa.id]), /metadata_no_secret_keys/);
  const { auditMetadata } = service;
  for (const bad of [{ username: "x" }, { token: 1 }, { note: "a benign key the allowlist does not know" }, { host_key: { nested: 1 } }, { status_class: "x".repeat(65) }]) {
    assert.throws(() => auditMetadata(bad), /audit metadata/, JSON.stringify(Object.keys(bad)));
  }
  assert.deepEqual(auditMetadata({ host_key: "server3", counted: true, attempt_no: 1, status_class: undefined }), { host_key: "server3", counted: true, attempt_no: 1 });
  const text = logLines.join("\n");
  noSecret(text, "the console output of the suite");
  // The route logged nothing about a request body at all.
  assert.ok(!/username|password/i.test(text), "no log line names the credential fields");
});

// ---------------------------------------------------------------------------
// 15–19. Internal review round 1 (code / security / db reviewers, 2026-10-03)
// ---------------------------------------------------------------------------
test("15. a body the JSON parser cannot read never reaches a log or the answer: an unterminated JSON with a password answers 400 invalid_json and no console line or response carries the pair; the same for a non-object JSON body", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  const before = logLines.length;
  for (const path of ["connect", "reconnect"]) {
    const res = await fetch(`${apiBase}/api/training-load/sources/gpexe/connections/${conn.id}/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: pa.cookie },
      body: `{"username":"${USERNAME}","password":"${PASSWORD}"`,
    });
    const text = await res.text();
    assert.equal(res.status, 400, path);
    assert.equal(JSON.parse(text).error, "invalid_json", path);
    noSecret(text, `the answer to a malformed ${path} body`);
    const res2 = await fetch(`${apiBase}/api/training-load/sources/gpexe/connections/${conn.id}/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: pa.cookie }, body: `"${PASSWORD}"`,
    });
    assert.equal(res2.status, 400, `${path}: a JSON string body`);
    noSecret(await res2.text(), `the answer to a string ${path} body`);
  }
  const since = logLines.slice(before).join("\n");
  noSecret(since, "the console lines of the malformed-body requests");
  assert.ok(!/username|password/i.test(since), "no log line names the credential fields");
  assert.ok(since.includes("request body refused"), "the refusal is logged by type only");
  assert.deepEqual((await auditOf(conn.id)).map((a) => a.action), ["create"], "a malformed body is not an attempt");
});

test("16. an attempt that reached the source but could not be stored (a database failure after the exchange) is recorded as unknown, counted by the throttle, answers 500 attempt_not_recorded without claiming the source was not reached, and stores nothing", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  const src = useSource();
  service.setSourceConnectionWriteFaultForTests(async () => { throw Object.assign(new Error("simulated write failure"), { code: "XX000" }); });
  try {
    const r = await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "attempt_not_recorded");
    assert.ok(!/nothing was changed|not reached/i.test(r.body.message));
  } finally {
    service.setSourceConnectionWriteFaultForTests(null);
  }
  assert.equal(exchangeCalls(src.calls).length, 1, "the exchange was sent");
  const row = await rowOf(conn.id);
  assert.equal(row.state, "not_connected");
  assert.equal(row.credential_ciphertext, null, "the token issued by the source was discarded");
  const last = (await auditOf(conn.id)).at(-1);
  assert.deepEqual([last.action, last.outcome, last.error_code, last.metadata.counted], ["connect", "unknown", "attempt_not_recorded", true]);
  // It counts: the next attempt is number 2.
  const ok = await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await auditOf(conn.id)).at(-1).metadata.attempt_no, 2);
  noSecret(await dbTextOf(conn.id), "the database rows");
});

test("17. a right revoked or a club archived while the source was being called stores nothing: the attempt answers 409 rights_changed, is audited as failed and counted, the issued token is discarded", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 10_000, testTimeout: 10_000 });
  try {
    const g = gate();
    const src = useSource({ exchangeGate: g });
    const pending = api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
    for (let i = 0; i < 50 && src.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    await q(`update public.user_global_roles set is_active = false where user_id = $1`, [pa.id]);
    g.release();
    const r = await pending;
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "rights_changed");
    assert.equal((await rowOf(conn.id)).credential_ciphertext, null);
    const last = (await auditOf(conn.id)).at(-1);
    assert.deepEqual([last.outcome, last.error_code, last.metadata.counted], ["failed", "rights_changed", true], "an outcome the throttle really counts");
    await q(`update public.user_global_roles set is_active = true where user_id = $1`, [pa.id]);
    // It counted: the next attempt of this user is number 2.
    useSource({ exchange: "401" });
    await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
    assert.equal((await auditOf(conn.id)).at(-1).metadata.attempt_no, 2);
    // The club archived mid-call: the same refusal.
    const g2 = gate();
    const src2 = useSource({ exchangeGate: g2 });
    const pending2 = api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
    for (let i = 0; i < 50 && src2.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    await q(`update public.clubs set is_active = false where id = $1`, [club]);
    g2.release();
    const r2 = await pending2;
    assert.equal(r2.body.error, "rights_changed");
    assert.equal((await rowOf(conn.id)).state, "not_connected");
    await q(`update public.clubs set is_active = true where id = $1`, [club]);
  } finally {
    service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
  }
});

test("18. bounded waits: a second attempt of the same user waits for the first only up to the user-lock bound, then answers try_again without a request; a connection's attempts never hold the pool past the network budget", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const a = await created(pa, club);
  const b = await created(pa, club);
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 10_000, testTimeout: 10_000, userLockWait: 300 });
  try {
    const g = gate();
    const src = useSource({ exchangeGate: g });
    const first = api(`/gpexe/connections/${a.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
    for (let i = 0; i < 50 && src.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    const second = await api(`/gpexe/connections/${b.id}/test`, { method: "POST", cookie: pa.cookie, body: {} });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.error, "try_again");
    assert.ok(Date.now() - started < 5_000, "the user-lock wait is bounded");
    assert.equal(src.calls.length, 1, "the second attempt sent nothing");
    assert.deepEqual((await auditOf(b.id)).at(-1).metadata.counted, false);
    g.release();
    assert.equal((await first).status, 200);
  } finally {
    service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
  }
  // The network budget caps the test reads: with a budget already spent, the reads are not sent and the test fails as source_unavailable.
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400, networkBudget: 0 });
  try {
    const src2 = useSource();
    const r = await api(`/gpexe/connections/${a.id}/test`, { method: "POST", cookie: pa.cookie, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.code, "source_unavailable");
    assert.equal(readCalls(src2.calls).length, 0, "nothing was sent past the budget");
  } finally {
    service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
  }
});

test("19. create: an unknown source is 404; a COMMIT whose answer is lost still answers 201 with the row created once; a hung COMMIT answers outcome_unknown and the row exists exactly once", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  assert.equal((await api(`/garmin/connections`, { method: "POST", cookie: pa.cookie, body: CREATE(club) })).status, 404);
  service.setSourceConnectionCommitForTests({ fault: async (client) => { await client.query("commit"); throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); } });
  let r;
  try {
    r = await api("/gpexe/connections", { method: "POST", cookie: pa.cookie, body: CREATE(club, { accountLabel: "lost answer" }) });
  } finally {
    service.setSourceConnectionCommitForTests();
  }
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.connection.commitConfirmation, "verified_after_commit_error");
  assert.equal((await q(`select count(*)::int as n from training_load.source_credential_connections where owner_club_id = $1 and account_label = 'lost answer'`, [club]))[0].n, 1);
  service.setSourceConnectionCommitForTests({ fault: async (client) => { await client.query("commit"); await new Promise(() => {}); }, timeoutMs: 200, checkFault: async () => { await new Promise(() => {}); }, checkTimeoutMs: 200 });
  try {
    r = await api("/gpexe/connections", { method: "POST", cookie: pa.cookie, body: CREATE(club, { accountLabel: "hung commit" }) });
  } finally {
    service.setSourceConnectionCommitForTests();
  }
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.error, "outcome_unknown");
  assert.equal((await q(`select count(*)::int as n from training_load.source_credential_connections where owner_club_id = $1 and account_label = 'hung commit'`, [club]))[0].n, 1, "created exactly once, as committed");
});

test("20. a read that fails after a confirmed COMMIT never hides the write: the attempt answers 200 with the result and connectionReadError; a lock wait on the catalog row answers try_again, not a 500", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  useSource();
  service.setPostCommitReadFaultForTests(async () => { throw new Error("simulated read failure after the commit"); });
  let r;
  try {
    r = await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
  } finally {
    service.setPostCommitReadFaultForTests(null);
  }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.state, "verified");
  assert.equal(r.body.connection, null);
  assert.equal(r.body.connectionReadError, true);
  assert.equal((await rowOf(conn.id)).state, "verified");
  // The catalog row held by another session longer than the row-lock bound: try_again, nothing sent.
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`update training_load.source_host_catalog set note = note where host_key = 'server3'`);
    const src = useSource();
    const t = await api(`/gpexe/connections/${conn.id}/test`, { method: "POST", cookie: pa.cookie, body: {} });
    assert.equal(t.status, 409, JSON.stringify(t.body));
    assert.equal(t.body.error, "try_again");
    assert.equal(src.calls.length, 0);
    await holder.query("rollback");
    // The club row held by another session: create answers try_again too, never a 500.
    await holder.query("begin");
    await holder.query(`update public.clubs set is_active = is_active where id = $1`, [club]);
    const c = await api("/gpexe/connections", { method: "POST", cookie: pa.cookie, body: CREATE(club) });
    assert.equal(c.status, 409, JSON.stringify(c.body));
    assert.equal(c.body.error, "try_again");
    await holder.query("rollback");
  } finally {
    await holder.end();
  }
});

test("21. a database session ended by the server while the attempt waits for the source does not crash the process: the attempt answers 500 attempt_not_recorded, one unknown audit row is written, nothing is stored, and the server keeps answering", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const conn = await created(pa, club);
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 10_000, testTimeout: 10_000 });
  try {
    const g = gate();
    const src = useSource({ exchangeGate: g });
    const pending = api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
    for (let i = 0; i < 50 && src.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(src.calls.length, 1);
    // The attempt's own backend: idle in its transaction, waiting for the source.
    const killed = await q(`select pg_terminate_backend(pid) as ok from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state = 'idle in transaction'`);
    assert.ok(killed.length >= 1 && killed.every((k) => k.ok === true), "the waiting session was ended");
    await new Promise((r) => setTimeout(r, 200));
    g.release();
    const r = await pending;
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "attempt_not_recorded");
    assert.equal((await rowOf(conn.id)).credential_ciphertext, null);
    const last = (await auditOf(conn.id)).at(-1);
    assert.deepEqual([last.action, last.outcome, last.error_code, last.metadata.counted], ["connect", "unknown", "attempt_not_recorded", true]);
    // The process is alive and the pool still serves: a plain read and a fresh attempt both work.
    assert.equal((await api(`/gpexe/connections/${conn.id}`, { cookie: pa.cookie })).status, 200);
    useSource();
    assert.equal((await api(`/gpexe/connections/${conn.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } })).body.result.state, "verified");
  } finally {
    service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
  }
});

test("22. the per-user lock wait is bounded by its own lock timeout, not cut short by the statement timeout: with a statement timeout shorter than the user-lock wait, the waiting attempt still answers try_again after the user-lock bound", async () => {
  const { club } = await org();
  const pa = await platformAdmin();
  const a = await created(pa, club);
  const b = await created(pa, club);
  service.setSourceConnectionTimingForTests({ exchangeTimeout: 10_000, testTimeout: 10_000, userLockWait: 1_500, statementTimeout: 300 });
  try {
    const g = gate();
    const src = useSource({ exchangeGate: g });
    const first = api(`/gpexe/connections/${a.id}/connect`, { method: "POST", cookie: pa.cookie, body: { username: USERNAME, password: PASSWORD } });
    for (let i = 0; i < 50 && src.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    const second = await api(`/gpexe/connections/${b.id}/test`, { method: "POST", cookie: pa.cookie, body: {} });
    const waited = Date.now() - started;
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.error, "try_again");
    assert.ok(waited >= 1_200 && waited < 6_000, `waited the user-lock bound, not the statement timeout (${waited} ms)`);
    g.release();
    assert.equal((await first).status, 200);
  } finally {
    service.setSourceConnectionTimingForTests({ exchangeTimeout: 400, testTimeout: 400 });
  }
});

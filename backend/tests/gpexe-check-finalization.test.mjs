// v33 — a check's results become actionable only when the check itself is
// atomically succeeded (owner order 2026-10-11: condition 6 and the server3
// drill-parameter guard), on a disposable optimove_tests_gpexe_* database
// (never OPTIMOVE) through the real server, against a fake source that serves
// the rest_v1 reads of the F3c2c adapter for several sessions at once.
//
// The mechanism under test: every candidate a check writes or refreshes names
// that check as its last sighting; an approval needs that check to be
// 'succeeded' (application gate in approveCandidate, database gate in the v33
// validate_gpexe_import_approval trigger); the check becomes 'succeeded' only
// in one transaction (finalizeCheck) that also supersedes what the check
// replaced, withdraws what a complete read no longer confirms in its exact
// window, and restores a candidate the check saw again.
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

const USERNAME = "marker-username-v33@example.invalid";
const PASSWORD = "MARKER-password-v33-not-real";
const TOKEN = "MARKER-token-v33-connection-not-real-0123456789";
const SOURCE_SENTENCE = "Marker sentence from the source server body";
const EXCHANGE_URL = "https://server3.gpexe.com/api-token-auth/";
const REST = "https://server3.gpexe.com/rest/v1/";
const LEGACY = "https://server3.gpexe.com/api/";
const D1 = "2026-09-14";
const D2 = "2026-09-15";
const D3 = "2026-09-16";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V33 = "202610111000_training_load_v33_gpexe_check_finalization.sql";
const UP_TO_V32 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V33));
const V33_ROLLBACK = path.resolve(ROOT, "docs/runbooks/gpexe-check-finalization-v33-rollback.sql");

let db, admin, server, apiBase, importer, connections, resolver, adapterMod, createSession, appPool;
const logLines = [];
const originalConsole = {};

before(async () => {
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V33), "v33 is part of the test migrations");
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v33" });
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
      if (process.env.V33_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  importer = await import("../src/gpexeImportService.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  adapterMod = await import("../src/gpexeRestV1Adapter.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  importer?.setGpexeClientFactory(null);
  importer?.setCheckRunObserver(null);
  importer?.setCheckFinalizeForTests({});
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
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
  importer.setCheckFinalizeForTests({});
  importer.setApprovalObserver(null);
  delete process.env.GPEXE_API_TOKEN;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
});

// ---------------------------------------------------------------------------
// helpers
function safeString(value) { try { return JSON.stringify(value); } catch { return String(value); } }
const SECRETS = [USERNAME, PASSWORD, TOKEN, SOURCE_SENTENCE];
function noSecret(text, where) {
  for (const s of SECRETS) assert.ok(!String(text).includes(s), `${where} carries a secret marker (${s.slice(0, 14)}…)`);
}
const responses = [];
async function api(urlPath, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load${urlPath}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!urlPath.startsWith("/sources/")) noSecret(text, `the response to ${method} ${urlPath}`);
  responses.push(text);
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
let nextSourceTeam = 1981;
const visibleTeams = new Set();
async function org() {
  const o = await createGpexePilotOrg(admin, { athleteNames: ["A101", "B102"] });
  const sourceTeamId = String(nextSourceTeam++);
  visibleTeams.add(Number(sourceTeamId));
  const padmin = await platformAdmin();
  const coach = await coachOf(o.teamId);
  const cadmin = await clubAdmin(o.clubId);
  assert.equal((await api(`/gpexe/teams/${o.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } })).status, 200, "the approved pair is set");
  for (const [gpexeAthleteId, athleteId] of [["101", o.athleteIds[0]], ["102", o.athleteIds[1]]]) {
    const r = await api(`/gpexe/teams/${o.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId, athleteId } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  return { ...o, sourceTeamId, padmin, coach, cadmin };
}

// One session of a team: two linked athletes, two drills, its own tracks.
function sessionOf(sourceTeamId, sid, day, { updatedOn = `${day}T20:18:09.337` } = {}) {
  const [a101, a102] = standardAthletes().slice(0, 2).map((a, i) => {
    const c = structuredClone(a);
    c.tracks = [sid * 10 + i];
    for (const part of c.parts) delete part.track;
    return c;
  });
  return makeBundle({ sessionId: sid, gpexeTeamId: Number(sourceTeamId), start: `${day}T18:08:12`, updatedOn, athletes: [a101, a102], detailsDrills: [0, 1] });
}

// The fake source: the exchange and team reads (Connect / bind), and the
// rest_v1 reads of every session in state.bundles for the served team.
function fakeSource() {
  const calls = [];
  const state = { served: null, bundles: [], gates: { athletes: {} }, faults: { drillPlayers: {}, drillMissing: {} } };
  const json = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const bySid = (sid) => state.bundles.find((b) => String(b.teamSession.id) === String(sid));
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const key = `${u.pathname}${u.search}`;
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? null;
    calls.push({ key, method: init.method ?? "GET" });
    if (String(url) === EXCHANGE_URL) {
      const params = new URLSearchParams(init.body);
      return params.get("username") === USERNAME && params.get("password") === PASSWORD ? json(200, { token: TOKEN }) : json(400, { non_field_errors: [SOURCE_SENTENCE] });
    }
    if (!String(url).startsWith(REST) && !String(url).startsWith(LEGACY)) return json(404, { detail: "not served" });
    if (init.method !== "GET") return json(405, {});
    if (auth !== `Token ${TOKEN}`) return json(401, { detail: SOURCE_SENTENCE });
    if (key === "/rest/v1/team/") return json(200, [...visibleTeams].map((id) => ({ id, name: `Team ${id}` })), { "x-total-count": String(visibleTeams.size) });
    let m = key.match(/^\/rest\/v1\/team\/(\d+)\/$/);
    if (m) return visibleTeams.has(Number(m[1])) ? json(200, { id: Number(m[1]), name: `Team ${m[1]}` }) : json(404, { detail: SOURCE_SENTENCE });
    const t = state.served;
    if (t === null) return json(404, { detail: "no team served" });
    if (key === `/rest/v1/team_session/?team=${t}&limit=100`) {
      const lg = state.gates.list;
      if (lg) { lg.reached = true; await lg.p; }
      const rows = [];
      for (const b of state.bundles) {
        const sid = b.teamSession.id;
        rows.push({ ...b.teamSession, drills: [sid * 1000 + 1, sid * 1000 + 2], drills_count: 2 });
        for (const k of [1, 2]) rows.push({ id: sid * 1000 + k, team: Number(t), category_name: "DRILL", start_timestamp: b.teamSession.start_timestamp, end_timestamp: b.teamSession.end_timestamp, updated_on: b.teamSession.updated_on, is_stats_valid: true, drills: [], drills_count: 0 });
      }
      return json(200, rows, { "x-total-count": String(rows.length) });
    }
    m = key.match(/^\/rest\/v1\/team_session\/(\d+)\/$/);
    if (m && bySid(m[1])) return json(200, { ...bySid(m[1]).teamSession, drills_count: 2 });
    m = key.match(/^\/rest\/v1\/athlete_session\/\?teamsession=(\d+)&limit=100$/);
    if (m && bySid(m[1])) {
      const g = state.gates.athletes[m[1]];
      if (g) { g.reached = true; await g.p; }
      const rows = bySid(m[1]).athleteSessions;
      return json(200, rows, { "x-total-count": String(rows.length) });
    }
    m = key.match(/^\/rest\/v1\/athlete_session\/(\d+)\/(more\/)?$/);
    if (m) {
      for (const b of state.bundles) {
        const row = b.athleteSessions.find((r) => String(r.id) === m[1]);
        if (row) return json(200, m[2] ? b.more[m[1]] : row);
      }
      return json(404, { detail: SOURCE_SENTENCE });
    }
    m = key.match(/^\/rest\/v1\/track\/(\d+)\/$/);
    if (m) {
      for (const b of state.bundles) if (b.tracks[m[1]]) return json(200, b.tracks[m[1]]);
      return json(404, { detail: SOURCE_SENTENCE });
    }
    m = key.match(/^\/rest\/v1\/team_session\/(\d+)\/details\/$/);
    if (m && bySid(m[1])) return json(200, { drills_count: 2, players: bySid(m[1]).details.full.players, team: { aggregate: 1 }, teamsession: Number(m[1]) });
    m = key.match(/^\/api\/team_session\/(\d+)\/details\/\?drill=(\d)$/);
    if (m && bySid(m[1])) {
      if (state.faults.drillMissing[m[1]] === Number(m[2])) return json(404, { detail: SOURCE_SENTENCE });
      const override = state.faults.drillPlayers[m[1]];
      const players = override ? override(Number(m[2])) : bySid(m[1]).details.drills[m[2]].players;
      return json(200, { drills_count: 0, players, team: { aggregate: 1 }, teamsession: Number(m[1]) * 1000 + Number(m[2]) + 1 });
    }
    m = key.match(/^\/api\/team_session\/(\d+)\/brief\/$/);
    if (m) return json(404, { detail: SOURCE_SENTENCE });
    m = key.match(/^\/rest\/v1\/team\/(\d+)\/thresholds\/\?valid_on=(\d{4}-\d{2}-\d{2})$/);
    if (m && m[1] === t) return json(200, state.bundles[0]?.teamThresholds ?? {});
    return json(404, { detail: "not served" });
  };
  const serve = (sourceTeamId, bundles) => { state.served = String(sourceTeamId); state.bundles = bundles; };
  return { calls, fetchImpl, state, serve };
}
let src;
const useSource = () => {
  src = fakeSource();
  connections.setSourceFetchForTests(src.fetchImpl);
  resolver.setImportSourceFetchForTests(src.fetchImpl);
  return src;
};
const legacyTrap = () => importer.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a team with an active binding"); });
const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release, reached: false }; };
const until = async (fn, ms = 6_000) => {
  for (let i = 0; i < ms / 25; i += 1) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); }
  assert.fail("the awaited condition did not come");
};
async function startCheck(o, { from = D1, to = D1, cookie = o.coach.cookie } = {}) {
  const done = gate();
  importer.setCheckRunObserver(() => done.release());
  const r = await api(`/gpexe/teams/${o.teamId}/checks`, { method: "POST", cookie, body: { from, to } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  return { id: r.body.check.id, done, running: r.body.check.status === "running" };
}
const checkRow = async (id) => (await q(`select * from training_load.gpexe_import_checks where id = $1`, [id]))[0];
async function runCheck(o, options) {
  const s = await startCheck(o, options);
  if (s.running) await s.done.p;
  return checkRow(s.id);
}
const candidates = (teamId) => q(
  `select id, gpexe_team_session_id as sid, status, superseded_by_candidate_id as by_cand, superseded_by_check_id as by_check,
          reappeared_status as reappeared, drill_parameter_effect as effect, last_seen_check_id as seen, bundle_hash, preview_hash, raw_bundle, preview
     from training_load.gpexe_import_candidates where owner_team_id = $1 order by first_seen_at, id`, [teamId]);
const bySession = async (teamId) => {
  const out = {};
  for (const c of await candidates(teamId)) (out[c.sid] ??= []).push(c);
  return out;
};
const listed = async (o, cookie = o.coach.cookie) => (await api(`/gpexe/teams/${o.teamId}/candidates?includeSuperseded=true`, { cookie })).body.candidates ?? [];
const summaryOf = async (o, id) => (await listed(o)).find((c) => c.id === id) ?? (await api(`/gpexe/teams/${o.teamId}/candidates/${id}`, { cookie: o.coach.cookie })).body.candidate;
async function approve(o, candidateId, { acceptChanges } = {}) {
  const row = (await q(`select preview_hash from training_load.gpexe_import_candidates where id = $1`, [candidateId]))[0];
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await api(`/gpexe/teams/${o.teamId}/candidates/${candidateId}/approve`, { method: "POST", cookie: o.padmin.cookie, body: { previewHash: row.preview_hash, ...(acceptChanges === undefined ? {} : { acceptChanges }) } });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}
// The database gate alone: a raw approval row for the candidate, rolled back.
async function rawApproval(candidateId, approverId) {
  const c = (await q(`select owner_team_id, gpexe_team_session_id, bundle_hash, preview_hash, coalesce(jsonb_array_length(preview -> 'changesToImported'), 0) as n from training_load.gpexe_import_candidates where id = $1`, [candidateId]))[0];
  await admin.query("begin");
  try {
    await admin.query(
      `insert into training_load.gpexe_import_approvals (candidate_id, owner_team_id, gpexe_team_session_id, bundle_hash, preview_hash, approved_by_user_id, approval_basis, changes_to_imported, changes_accepted, metric_event_id, import_counts)
       values ($1,$2,$3,$4,$5,$6,'platform_admin',$7,true,gen_random_uuid(),'{}')`,
      [candidateId, c.owner_team_id, c.gpexe_team_session_id, c.bundle_hash, c.preview_hash, approverId, c.n],
    );
    return "inserted";
  } catch (error) {
    return error.message;
  } finally {
    await admin.query("rollback");
  }
}
const CREATE = (club) => ({ ownerScope: "club", ownerClubId: club, hostKey: "server3", accountLabel: "Club account (label only)", credentialKind: "exchanged_token" });
async function bound(o) {
  const c = await api("/sources/gpexe/connections", { method: "POST", cookie: o.cadmin.cookie, body: CREATE(o.clubId) });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const r = await api(`/sources/gpexe/connections/${c.body.connection.id}/connect`, { method: "POST", cookie: o.cadmin.cookie, body: { username: USERNAME, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = await api(`/sources/gpexe/connections/${c.body.connection.id}/bindings`, { method: "POST", cookie: o.cadmin.cookie, body: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  return c.body.connection;
}
async function boundOrg() {
  const o = await org();
  useSource();
  await bound(o);
  legacyTrap();
  return o;
}
const legacyFake = (sourceTeamId, bundles) => {
  importer.setGpexeClientFactory(() => ({
    async listTeamSessions() { return bundles.map((b) => ({ id: String(b.teamSession.id) })); },
    async fetchSessionBundle({ sessionId }) { return structuredClone(bundles.find((b) => String(b.teamSession.id) === String(sessionId))); },
  }));
};
const actionable = (summary) => !summary.approvalBlockers.includes("not_confirmed_for_import");

// ---------------------------------------------------------------------------
test("1. migration v33 on v32: the exactly-one, reappeared and drill-effect constraints by name, the approval gate, the index; the rollback returns the identical v32 catalog, refuses while a row depends on superseded_by_check_id or reappeared_status (dropping nothing), and v33 applies again identically; a failing file applies nothing", async () => {
  const m = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v33mig", migrations: UP_TO_V32 });
  const k = new pg.Client({ connectionString: m.url });
  await k.connect();
  try {
    assert.match((await k.query("select current_database() as d")).rows[0].d, DISPOSABLE_DB_NAME_PATTERN);
    const catalog = async () => ({
      columns: (await k.query(`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_candidates' order by ordinal_position`)).rows,
      constraints: (await k.query(`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'training_load.gpexe_import_candidates'::regclass order by 1`)).rows,
      indexes: (await k.query(`select indexname, indexdef from pg_indexes where schemaname = 'training_load' and tablename = 'gpexe_import_candidates' order by 1`)).rows,
      triggers: (await k.query(`select tgname, pg_get_triggerdef(oid) as def from pg_trigger where tgrelid in ('training_load.gpexe_import_candidates'::regclass, 'training_load.gpexe_import_approvals'::regclass, 'training_load.gpexe_import_checks'::regclass) and not tgisinternal order by 1`)).rows,
      functions: (await k.query(`select p.proname, md5(pg_get_functiondef(p.oid)) as digest from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and (p.proname like '%gpexe_import%' or p.proname like 'gpexe_check%') order by 1`)).rows,
      comments: (await k.query(`select a.attname, col_description(a.attrelid, a.attnum) as c from pg_attribute a where a.attrelid = 'training_load.gpexe_import_candidates'::regclass and a.attnum > 0 and not a.attisdropped order by 1`)).rows,
    });
    const v32 = await catalog();
    assert.ok(!v32.columns.some((c) => c.column_name === "superseded_by_check_id"));
    // Rows from before v33: a team with its approved pair, a check, two candidates.
    const club = (await k.query(`insert into public.clubs (name) values ('C') returning id`)).rows[0].id;
    const team = (await k.query(`insert into public.teams (club_id, name) values ($1, 'T') returning id`, [club])).rows[0].id;
    const user = (await k.query(`insert into public.users (email) values ('u-v33@test.local') returning id`)).rows[0].id;
    await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, '1981', $2)`, [team, user]);
    const check = async (status = "succeeded") => (await k.query(
      `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id) values ($1,$2,$3,'2026-09-14','2026-09-14', now(),'1981') returning id`,
      [team, user, status])).rows[0].id;
    const c1 = await check();
    const cand = async (sid, status = "pending", extra = {}) => (await k.query(
      `insert into training_load.gpexe_import_candidates (owner_team_id, gpexe_team_session_id, bundle_hash, raw_bundle, raw_expires_at, status, first_seen_check_id, last_seen_check_id, superseded_by_candidate_id)
       values ($1,$2,$3,'{}'::jsonb, now() + interval '1 day', $4, $5, $5, $6) returning id`,
      [team, sid, crypto.createHash("sha256").update(`${sid}-${status}-${uid()}`).digest("hex"), status, c1, extra.by ?? null])).rows[0].id;
    const p1 = await cand("1");
    await cand("1", "superseded", { by: p1 });
    await applyGpexeTestMigrations(m.url, [...UP_TO_V32, V33]);
    const v33 = await catalog();
    const names = v33.constraints.map((c) => c.conname);
    for (const n of ["gpexe_import_candidates_superseded_by_exactly_one", "gpexe_import_candidates_reappeared_only_superseded", "gpexe_import_candidates_drill_parameter_effect_values", "gpexe_import_candidates_superseded_by_check_id_fkey"]) assert.ok(names.includes(n), n);
    assert.ok(!v33.constraints.some((c) => c.def === "CHECK ((((status)::text = 'superseded'::text) = (superseded_by_candidate_id IS NOT NULL)))"), "the v22 rule is replaced");
    assert.match(v33.constraints.find((c) => c.conname === "gpexe_import_candidates_superseded_by_check_id_fkey").def, /ON DELETE RESTRICT/);
    assert.ok(v33.indexes.some((i) => i.indexname === "gpexe_import_candidates_superseded_by_check_idx"));
    assert.ok(v33.triggers.some((t) => t.tgname === "gpexe_import_checks_status_final"), "a finished check's status is final in the database");
    for (const col of ["superseded_by_check_id", "reappeared_status", "drill_parameter_effect"]) assert.ok(v33.comments.find((c) => c.attname === col)?.c, `${col} is commented`);
    assert.deepEqual(v33.columns.filter((c) => ["superseded_by_check_id", "reappeared_status", "drill_parameter_effect"].includes(c.column_name)).map((c) => [c.column_name, c.is_nullable, c.column_default]),
      [["superseded_by_check_id", "YES", null], ["reappeared_status", "YES", null], ["drill_parameter_effect", "YES", null]]);
    assert.deepEqual((await k.query(`select status, superseded_by_check_id, reappeared_status, drill_parameter_effect from training_load.gpexe_import_candidates order by status`)).rows,
      [{ status: "pending", superseded_by_check_id: null, reappeared_status: null, drill_parameter_effect: null }, { status: "superseded", superseded_by_check_id: null, reappeared_status: null, drill_parameter_effect: null }], "no data rewritten");
    // The rollback refuses while history depends on v33, dropping nothing.
    const rollbackSql = await fsp.readFile(V33_ROLLBACK, "utf8");
    const withdrawn = await cand("2");
    await k.query(`update training_load.gpexe_import_candidates set status = 'superseded', superseded_by_check_id = $2 where id = $1`, [withdrawn, c1]);
    await assert.rejects(k.query(rollbackSql), /v33 rollback refused: 1 candidate\(s\) are superseded by a check/);
    await k.query("rollback").catch(() => {});
    assert.deepEqual(await catalog(), v33, "a refused rollback drops nothing");
    await k.query(`delete from training_load.gpexe_import_candidates where id = $1`, [withdrawn]);
    // A waiting reappearance mark does not refuse the rollback: the row is superseded by a candidate and stays so.
    const waiting = await cand("3");
    await k.query(`update training_load.gpexe_import_candidates set status = 'superseded', superseded_by_candidate_id = $2, reappeared_status = 'pending' where id = $1`, [waiting, p1]);
    // Without rows superseded by a check: the rollback returns exactly the v32 catalog and keeps every row.
    await k.query(`update training_load.gpexe_import_candidates set drill_parameter_effect = 'confirmed' where id = $1`, [p1]);
    await k.query(rollbackSql);
    assert.deepEqual(await catalog(), v32, "the rollback leaves exactly the v32 columns, constraints, indexes, triggers, functions and comments");
    assert.equal((await k.query(`select count(*)::int as n from public.schema_migrations where migration_name like $1`, [`%${V33}`])).rows[0].n, 0);
    assert.equal((await k.query(`select count(*)::int as n from training_load.gpexe_import_candidates`)).rows[0].n, 3, "no row lost");
    assert.deepEqual((await k.query(`select status, superseded_by_candidate_id from training_load.gpexe_import_candidates where id = $1`, [waiting])).rows[0], { status: "superseded", superseded_by_candidate_id: p1 }, "the waiting row stays superseded by its candidate");
    // A failing copy of the file applies nothing.
    const sql = await fsp.readFile(path.resolve(ROOT, "migrations_v2", V33), "utf8");
    assert.doesNotMatch(sql.replace(/[$][$][^]*?[$][$]/g, "<body>"), /^\s*(begin|commit|rollback)\b/im, "no transaction control outside the function bodies");
    await k.query("begin");
    await assert.rejects(k.query(`${sql}\nselect 1/0;`), /division by zero/);
    await k.query("rollback");
    assert.deepEqual(await catalog(), v32, "nothing of the failed file was applied");
    await applyGpexeTestMigrations(m.url, [...UP_TO_V32, V33]);
    assert.deepEqual(await catalog(), v33, "v33 applies again, identically");
    // The rollback refuses under a later recorded migration.
    await k.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ('migrations_v2/209901010000_test_only_later.sql', repeat('0', 64), 0, 'test')`);
    await assert.rejects(k.query(rollbackSql), /v33 rollback refused: later migrations are applied/);
    await k.query("rollback").catch(() => {});
  } finally {
    await k.end();
    await m.drop();
  }
});

test("2. the v33 constraints by name on real rows: a superseded row needs exactly one superseded_by, no other status may carry one, reappeared_status only on a superseded row, the drill effect only from its closed set, last_seen_check_id is never NULL, and a check referenced by superseded_by_check_id cannot be deleted (ON DELETE RESTRICT, below the v24 refusal)", async () => {
  const o = await org();
  legacyFake(o.sourceTeamId, [sessionOf(o.sourceTeamId, 30001, D1), sessionOf(o.sourceTeamId, 30002, D1)]);
  const first = await runCheck(o);
  assert.equal(first.status, "succeeded", JSON.stringify(first));
  const [a, b] = await candidates(o.teamId);
  const violates = async (sql, params, name) => {
    await admin.query("savepoint s");
    try {
      await assert.rejects(admin.query(sql, params), (e) => (e.constraint === name || String(e.message).includes(name)) || assert.fail(`${name}: ${e.code} ${e.constraint} ${e.message}`));
    } finally {
      await admin.query("rollback to savepoint s");
    }
  };
  await admin.query("begin");
  try {
    const EXACTLY = "gpexe_import_candidates_superseded_by_exactly_one";
    await violates(`update training_load.gpexe_import_candidates set status = 'superseded' where id = $1`, [a.id], EXACTLY);
    await violates(`update training_load.gpexe_import_candidates set status = 'superseded', superseded_by_candidate_id = $2, superseded_by_check_id = $3 where id = $1`, [a.id, b.id, first.id], EXACTLY);
    await violates(`update training_load.gpexe_import_candidates set superseded_by_check_id = $2 where id = $1`, [a.id, first.id], EXACTLY);
    await violates(`update training_load.gpexe_import_candidates set superseded_by_candidate_id = $2 where id = $1`, [a.id, b.id], EXACTLY);
    await violates(`update training_load.gpexe_import_candidates set status = 'blocked', superseded_by_check_id = $2 where id = $1`, [a.id, first.id], EXACTLY);
    const REAPPEARED = "gpexe_import_candidates_reappeared_only_superseded";
    await violates(`update training_load.gpexe_import_candidates set reappeared_status = 'pending' where id = $1`, [a.id], REAPPEARED);
    await violates(`update training_load.gpexe_import_candidates set status = 'superseded', superseded_by_check_id = $2, reappeared_status = 'imported' where id = $1`, [a.id, first.id], REAPPEARED);
    await violates(`update training_load.gpexe_import_candidates set drill_parameter_effect = 'not_distinguishable' where id = $1`, [a.id], "gpexe_import_candidates_drill_parameter_effect_values");
    await admin.query("savepoint s");
    await assert.rejects(admin.query(`update training_load.gpexe_import_candidates set last_seen_check_id = null where id = $1`, [a.id]), (e) => e.code === "23502");
    await admin.query("rollback to savepoint s");
    // A finished check's status and finished_at are final (gpexe_import_checks_status_final); other columns are not frozen by it.
    const FINAL = "its status and finished_at are final";
    await violates(`update training_load.gpexe_import_checks set status = 'failed', error_code = 'x', error_message = 'x' where id = $1`, [first.id], FINAL);
    await violates(`update training_load.gpexe_import_checks set status = 'running', finished_at = null where id = $1`, [first.id], FINAL);
    await violates(`update training_load.gpexe_import_checks set finished_at = finished_at - interval '1 day' where id = $1`, [first.id], FINAL);
    await admin.query(`update training_load.gpexe_import_checks set heartbeat_at = now() where id = $1`, [first.id]);
    const running = (await admin.query(`insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, gpexe_team_id) values ($1,$2,'running','2026-08-02','2026-08-02',$3) returning id`, [o.teamId, o.userId, o.sourceTeamId])).rows[0].id;
    await admin.query(`update training_load.gpexe_import_checks set status = 'succeeded', finished_at = now() where id = $1`, [running]);
    await violates(`update training_load.gpexe_import_checks set status = 'failed', error_code = 'late', error_message = 'late' where id = $1`, [running], FINAL);
    // Both legal forms pass.
    await admin.query(`update training_load.gpexe_import_candidates set status = 'superseded', superseded_by_check_id = $2, reappeared_status = 'pending' where id = $1`, [a.id, first.id]);
    await admin.query(`update training_load.gpexe_import_candidates set status = 'superseded', superseded_by_check_id = null, superseded_by_candidate_id = $2, reappeared_status = null where id = $1`, [a.id, b.id]);
    // A check that only superseded_by_check_id references: the v24 trigger refuses a delete first; below it, the foreign key.
    const other = (await admin.query(`insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id) values ($1,$2,'succeeded','2026-08-01','2026-08-01', now(), $3) returning id`, [o.teamId, o.userId, o.sourceTeamId])).rows[0].id;
    await admin.query(`update training_load.gpexe_import_candidates set superseded_by_candidate_id = null, superseded_by_check_id = $2 where id = $1`, [a.id, other]);
    await admin.query("savepoint s");
    await assert.rejects(admin.query(`delete from training_load.gpexe_import_checks where id = $1`, [other]), /never deleted|refuse|not allowed/i);
    await admin.query("rollback to savepoint s");
    await admin.query(`alter table training_load.gpexe_import_checks disable trigger gpexe_import_checks_refuse_delete`);
    await violates(`delete from training_load.gpexe_import_checks where id = $1`, [other], "gpexe_import_candidates_superseded_by_check_id_fkey");
  } finally {
    await admin.query("rollback");
  }
  assert.equal((await q(`select tgenabled from pg_trigger where tgname = 'gpexe_import_checks_refuse_delete'`))[0].tgenabled, "O", "the v24 trigger is enabled again (rolled back)");
});

test("3. a running check's candidates are not actionable, nothing is superseded or withdrawn while it runs, and its success publishes them, supersedes what it replaced and withdraws what the complete list no longer confirms - in one transaction (binding path)", async () => {
  const o = await boundOrg();
  const s1 = sessionOf(o.sourceTeamId, 31001, D1);
  src.serve(o.sourceTeamId, [s1]);
  const first = await runCheck(o);
  assert.equal(first.status, "succeeded", JSON.stringify(first));
  const [c1] = await candidates(o.teamId);
  assert.deepEqual([c1.status, c1.effect, c1.seen], ["pending", "confirmed", first.id]);
  assert.ok(actionable(await summaryOf(o, c1.id)), "a candidate of a succeeded check with a confirmed drill effect is actionable");

  // The next check no longer lists s1; it sees s2 and s3, and is held at s3.
  const s2 = sessionOf(o.sourceTeamId, 31002, D1);
  const s3 = sessionOf(o.sourceTeamId, 31003, D1);
  src.serve(o.sourceTeamId, [s2, s3]);
  const held = gate();
  src.state.gates.athletes["31003"] = held;
  const run = await startCheck(o);
  try {
    await until(async () => held.reached && (await candidates(o.teamId)).some((c) => c.sid === "31002"));
    const mid = await bySession(o.teamId);
    const c2 = mid["31002"][0];
    assert.deepEqual([c2.status, c2.seen, (await checkRow(run.id)).status], ["pending", run.id, "running"]);
    assert.equal(mid["31001"][0].status, "pending", "nothing is withdrawn while the check runs");
    assert.ok(!actionable(await summaryOf(o, c2.id)), "the running check's candidate is not actionable (list)");
    const refused = await approve(o, c2.id);
    assert.deepEqual([refused.status, refused.body.error], [409, "candidate_not_actionable"], JSON.stringify(refused.body));
    assert.match(await rawApproval(c2.id, o.padmin.id), /not confirmed by a succeeded check/, "the database refuses it whoever writes it");
    assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_approvals where owner_team_id = $1`, [o.teamId]))[0].n, 0);
  } finally {
    held.release();
  }
  await run.done.p;
  const done = await checkRow(run.id);
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  const after_ = await bySession(o.teamId);
  assert.deepEqual([after_["31001"][0].status, after_["31001"][0].by_check, after_["31001"][0].by_cand], ["superseded", run.id, null], "withdrawn by the check that no longer confirmed it");
  for (const sid of ["31002", "31003"]) {
    assert.equal(after_[sid][0].status, "pending");
    assert.ok(actionable(await summaryOf(o, after_[sid][0].id)), `${sid} is published`);
  }
  const withdrawnSummary = await summaryOf(o, after_["31001"][0].id);
  assert.deepEqual([withdrawnSummary.supersededByCheckId, withdrawnSummary.supersededByCandidateId], [run.id, null]);
  assert.ok(withdrawnSummary.approvalBlockers.includes("not_confirmed_for_import") && !withdrawnSummary.approvalBlockers.includes("superseded_by_newer_data"), "a withdrawn row is no newer data");
  const refusedWithdrawn = await approve(o, after_["31001"][0].id);
  assert.deepEqual([refusedWithdrawn.status, refusedWithdrawn.body.error], [409, "candidate_not_actionable"]);
  assert.equal(importer.checkFinalizeCallsForTests() >= 1, true);
});

test("4. a failed check leaves nothing actionable and supersedes nothing: the changed content it recorded stays unpublished and the older candidate stays as it was; the next successful check then supersedes it by candidate", async () => {
  const o = await boundOrg();
  const s1 = sessionOf(o.sourceTeamId, 32001, D1);
  src.serve(o.sourceTeamId, [s1]);
  assert.equal((await runCheck(o)).status, "succeeded");
  const [old] = await candidates(o.teamId);
  // Changed content of s1, then a session whose drill 1 cannot be read: the check fails after recording s1.
  const s1b = sessionOf(o.sourceTeamId, 32001, D1, { updatedOn: `${D1}T23:00:00.000` });
  const s2 = sessionOf(o.sourceTeamId, 32002, D1);
  src.serve(o.sourceTeamId, [s1b, s2]);
  src.state.faults.drillMissing["32002"] = 1;
  const failed = await runCheck(o);
  assert.deepEqual([failed.status, failed.error_code], ["failed", "drill_set_incomplete"], JSON.stringify(failed));
  const rows = await bySession(o.teamId);
  assert.equal(rows["32001"].length, 2);
  const [oldNow, changed] = rows["32001"];
  assert.deepEqual([oldNow.id, oldNow.status, oldNow.by_cand, oldNow.by_check, oldNow.seen], [old.id, "pending", null, null, old.seen], "the older candidate is untouched");
  assert.deepEqual([changed.status, changed.seen], ["pending", failed.id]);
  assert.ok(actionable(await summaryOf(o, oldNow.id)), "the older candidate stays actionable");
  assert.ok(!actionable(await summaryOf(o, changed.id)), "the failed check's candidate is not");
  assert.deepEqual((await approve(o, changed.id)).body.error, "candidate_not_actionable");
  assert.match(await rawApproval(changed.id, o.padmin.id), /not confirmed by a succeeded check/);
  assert.equal(rows["32002"], undefined, "the session that failed was not recorded");
  // A last sighting pointing at another team's succeeded check (only a raw writer can do that) never makes it actionable.
  const other = await org();
  legacyFake(other.sourceTeamId, [sessionOf(other.sourceTeamId, 32101, D1)]);
  const otherCheck = await runCheck(other);
  assert.equal(otherCheck.status, "succeeded");
  importer.setGpexeClientFactory(null);
  legacyTrap();
  await q(`update training_load.gpexe_import_candidates set last_seen_check_id = $2 where id = $1`, [changed.id, otherCheck.id]);
  assert.ok(!actionable(await summaryOf(o, changed.id)));
  assert.equal((await approve(o, changed.id)).body.error, "candidate_not_actionable");
  assert.match(await rawApproval(changed.id, o.padmin.id), /not confirmed by a succeeded check/);
  await q(`update training_load.gpexe_import_candidates set last_seen_check_id = $2 where id = $1`, [changed.id, failed.id]);
  // A successful check of the same content publishes it and supersedes the older one by candidate.
  src.state.faults.drillMissing = {};
  src.serve(o.sourceTeamId, [s1b]);
  const ok = await runCheck(o);
  assert.equal(ok.status, "succeeded");
  const [o2, c2] = (await bySession(o.teamId))["32001"];
  assert.deepEqual([o2.status, o2.by_cand, o2.by_check], ["superseded", c2.id, null]);
  assert.deepEqual([c2.status, c2.seen], ["pending", ok.id]);
  assert.ok(actionable(await summaryOf(o, c2.id)));
});

test("5. a reappearing session: while the check runs the withdrawn candidate keeps its status and superseded_by (reappeared_status waits); only the check's success restores it and clears both fields; a reappearance in a check that fails restores nothing, and the next successful check drops the stale mark", async () => {
  const o = await boundOrg();
  const s1 = sessionOf(o.sourceTeamId, 33001, D1);
  const s2 = sessionOf(o.sourceTeamId, 33002, D1);
  src.serve(o.sourceTeamId, [s1]);
  assert.equal((await runCheck(o)).status, "succeeded");
  src.serve(o.sourceTeamId, [s2]);
  const withdrawer = await runCheck(o);
  const [c1] = (await bySession(o.teamId))["33001"];
  assert.deepEqual([c1.status, c1.by_check], ["superseded", withdrawer.id]);
  // s1 comes back with the same content; the check is held at s2.
  src.serve(o.sourceTeamId, [s1, s2]);
  const held = gate();
  src.state.gates.athletes["33002"] = held;
  const run = await startCheck(o);
  try {
    await until(async () => held.reached && (await bySession(o.teamId))["33001"][0].reappeared === "pending");
    const mid = (await bySession(o.teamId))["33001"][0];
    assert.deepEqual([mid.id, mid.status, mid.by_check, mid.by_cand, mid.reappeared, mid.seen], [c1.id, "superseded", withdrawer.id, null, "pending", run.id]);
    assert.equal((await approve(o, c1.id)).body.error, "candidate_not_actionable");
    assert.match(await rawApproval(c1.id, o.padmin.id), /is superseded, not pending|not confirmed/);
  } finally {
    held.release();
  }
  await run.done.p;
  assert.equal((await checkRow(run.id)).status, "succeeded");
  const back = (await bySession(o.teamId))["33001"];
  assert.equal(back.length, 1, "the same row, no new candidate");
  assert.deepEqual([back[0].status, back[0].by_check, back[0].by_cand, back[0].reappeared], ["pending", null, null, null]);
  assert.ok(actionable(await summaryOf(o, c1.id)));

  // Withdrawn again, then seen again by a check that fails: nothing is restored.
  src.serve(o.sourceTeamId, [s2]);
  const withdrawer2 = await runCheck(o);
  assert.equal((await bySession(o.teamId))["33001"][0].by_check, withdrawer2.id);
  const s3 = sessionOf(o.sourceTeamId, 33003, D1);
  src.serve(o.sourceTeamId, [s1, s3]);
  src.state.faults.drillMissing["33003"] = 0;
  const failing = await runCheck(o);
  assert.equal(failing.status, "failed");
  const stale = (await bySession(o.teamId))["33001"][0];
  assert.deepEqual([stale.status, stale.by_check, stale.reappeared, stale.seen], ["superseded", withdrawer2.id, "pending", failing.id], "superseded as before; the mark waits for a success that never came");
  assert.equal((await approve(o, c1.id)).body.error, "candidate_not_actionable");
  // The next successful check that does not list s1 drops the stale mark; the row stays withdrawn.
  src.state.faults.drillMissing = {};
  src.serve(o.sourceTeamId, [s2]);
  assert.equal((await runCheck(o)).status, "succeeded");
  const final = (await bySession(o.teamId))["33001"][0];
  assert.deepEqual([final.status, final.by_check, final.reappeared], ["superseded", withdrawer2.id, null]);
});

test("6. the withdrawal is exact: same team, pending / blocked only, the session day inside the check's [from, to]; overlapping sequential periods withdraw only their own days; imported rows and rows outside the period stay untouched, and another team is never touched", async () => {
  const o = await boundOrg();
  const sa = sessionOf(o.sourceTeamId, 34001, D1);
  const sb = sessionOf(o.sourceTeamId, 34002, D2);
  src.serve(o.sourceTeamId, [sa, sb]);
  const a = await runCheck(o, { from: D1, to: D2 });
  assert.equal(a.status, "succeeded", JSON.stringify(a));
  const rows = await bySession(o.teamId);
  const ca = rows["34001"][0];
  const cb = rows["34002"][0];
  const imported = await approve(o, ca.id);
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  // Another team with a pending candidate on the same days.
  const other = await org();
  legacyFake(other.sourceTeamId, [sessionOf(other.sourceTeamId, 34101, D2)]);
  assert.equal((await runCheck(other, { from: D2, to: D2 })).status, "succeeded");
  importer.setGpexeClientFactory(null);
  legacyTrap();
  // Period B overlaps A on D2: only D2 and D3 are its business.
  src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, 34003, D3)]);
  const b = await runCheck(o, { from: D2, to: D3 });
  assert.equal(b.status, "succeeded", JSON.stringify(b));
  const afterB = await bySession(o.teamId);
  assert.deepEqual([afterB["34002"][0].status, afterB["34002"][0].by_check], ["superseded", b.id], "D2 is inside B and no longer listed");
  assert.equal(afterB["34001"][0].status, "imported", "an imported row is never withdrawn");
  assert.equal(afterB["34003"][0].status, "pending");
  // Period C covers D1 only and lists nothing: the imported row stays, D3 (outside C) stays pending.
  src.serve(o.sourceTeamId, []);
  const c = await runCheck(o, { from: D1, to: D1 });
  assert.equal(c.status, "succeeded", JSON.stringify(c));
  const afterC = await bySession(o.teamId);
  assert.equal(afterC["34001"][0].status, "imported");
  assert.deepEqual([afterC["34003"][0].status, afterC["34003"][0].by_check], ["pending", null], "a row outside the period is untouched");
  const otherRow = (await candidates(other.teamId))[0];
  assert.deepEqual([otherRow.status, otherRow.by_check], ["pending", null], "another team is never touched");
  void cb;
});

test("7. the finalization's COMMIT: an answer lost after the COMMIT is verified on a new connection (succeeded, withdrawn, published); a COMMIT that never answers is bounded, never repeated, the connection is closed, nothing is published or withdrawn, and the check fails as check_finalize_outcome_unknown", async () => {
  const o = await boundOrg();
  const s1 = sessionOf(o.sourceTeamId, 35001, D1);
  const s2 = sessionOf(o.sourceTeamId, 35002, D1);
  src.serve(o.sourceTeamId, [s1]);
  assert.equal((await runCheck(o)).status, "succeeded");
  // (a) committed, answer lost.
  let commits = 0;
  importer.setCheckFinalizeForTests({ commit: async (client) => { commits += 1; await client.query("commit"); throw new Error("answer lost"); }, commitBoundMs: 2_000 });
  src.serve(o.sourceTeamId, [s2]);
  const a = await runCheck(o);
  assert.equal(a.status, "succeeded", JSON.stringify(a));
  assert.equal(commits, 1);
  assert.equal(importer.checkFinalizeCallsForTests(), 1, "one finalization, no retry");
  const rows = await bySession(o.teamId);
  assert.deepEqual([rows["35001"][0].status, rows["35001"][0].by_check], ["superseded", a.id]);
  assert.ok(actionable(await summaryOf(o, rows["35002"][0].id)));
  // (b) the COMMIT never answers: bounded, the connection closed, outcome unknown → failed, nothing changed.
  const s3 = sessionOf(o.sourceTeamId, 35003, D1);
  let sent = 0;
  importer.setCheckFinalizeForTests({ commit: () => { sent += 1; return new Promise(() => {}); }, commitBoundMs: 300 });
  src.serve(o.sourceTeamId, [s3]);
  const started = Date.now();
  const b = await runCheck(o);
  assert.ok(Date.now() - started < 20_000, "bounded");
  assert.deepEqual([b.status, b.error_code], ["failed", "check_finalize_outcome_unknown"], JSON.stringify(b));
  assert.equal(sent, 1, "the COMMIT is never repeated");
  assert.equal(importer.checkFinalizeCallsForTests(), 1);
  const afterB = await bySession(o.teamId);
  assert.deepEqual([afterB["35002"][0].status, afterB["35002"][0].by_check], ["pending", null], "nothing withdrawn");
  assert.ok(actionable(await summaryOf(o, afterB["35002"][0].id)), "the earlier publication stands");
  assert.ok(!actionable(await summaryOf(o, afterB["35003"][0].id)), "nothing of the unknown check is published");
  assert.equal((await approve(o, afterB["35003"][0].id)).body.error, "candidate_not_actionable");
  // A coach reads the code and the sentence (a team fact, not a connection fact).
  const view = (await api(`/gpexe/teams/${o.teamId}/checks/${b.id}`, { cookie: o.coach.cookie })).body.check;
  assert.equal(view.error.code, "check_finalize_outcome_unknown");
});

test("8. a busy candidate row or team lock at the finalization: lock_timeout / the team try-lock end it in bounded time as check_finalize_busy; nothing is published, superseded or withdrawn", async () => {
  const o = await boundOrg();
  const s1 = sessionOf(o.sourceTeamId, 36001, D1);
  src.serve(o.sourceTeamId, [s1]);
  assert.equal((await runCheck(o)).status, "succeeded");
  const [c1] = await candidates(o.teamId);
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    for (const [what, hold] of [
      ["candidate row", () => holder.query(`select id from training_load.gpexe_import_candidates where id = $1 for update`, [c1.id])],
      ["team lock", () => holder.query(`select training_load.hold_gpexe_team_lock($1, 'test holder')`, [o.teamId])],
    ]) {
      const sid = what === "candidate row" ? 36002 : 36003;
      src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, sid, D1)]);
      importer.setCheckFinalizeForTests({ beforeLocks: async () => { await holder.query("begin"); await hold(); } });
      const started = Date.now();
      const r = await runCheck(o);
      await holder.query("rollback");
      assert.ok(Date.now() - started < 20_000, `${what}: bounded`);
      assert.deepEqual([r.status, r.error_code], ["failed", "check_finalize_busy"], `${what}: ${JSON.stringify(r)}`);
      const rows = await bySession(o.teamId);
      assert.deepEqual([rows["36001"][0].status, rows["36001"][0].by_check], ["pending", null], `${what}: nothing withdrawn`);
      assert.ok(!actionable(await summaryOf(o, rows[String(sid)][0].id)), `${what}: nothing published`);
    }
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  importer.setCheckFinalizeForTests({});
  src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, 36004, D1)]);
  assert.equal((await runCheck(o)).status, "succeeded", "the team checks normally afterwards");
  const rows = await bySession(o.teamId);
  for (const sid of ["36001", "36002", "36003"]) assert.equal(rows[sid][0].status, "superseded", `${sid} withdrawn by the successful check`);
});

test("9. the legacy path does not withdraw: a session its list no longer shows stays pending; supersede by newer content of the same session and the publication still happen at the finalization", async () => {
  const o = await org();
  const s1 = sessionOf(o.sourceTeamId, 37001, D1);
  legacyFake(o.sourceTeamId, [s1]);
  const first = await runCheck(o);
  assert.equal(first.status, "succeeded");
  const [c1] = await candidates(o.teamId);
  assert.equal(c1.effect, "confirmed", "the legacy bundle's full drill maps were compared");
  legacyFake(o.sourceTeamId, [sessionOf(o.sourceTeamId, 37002, D1)]);
  assert.equal((await runCheck(o)).status, "succeeded");
  const rows = await bySession(o.teamId);
  assert.deepEqual([rows["37001"][0].status, rows["37001"][0].by_check], ["pending", null], "no withdrawal on the legacy path");
  legacyFake(o.sourceTeamId, [sessionOf(o.sourceTeamId, 37001, D1, { updatedOn: `${D1}T23:30:00.000` })]);
  const third = await runCheck(o);
  const [old, changed] = (await bySession(o.teamId))["37001"];
  assert.deepEqual([old.status, old.by_cand, changed.status, changed.seen], ["superseded", changed.id, "pending", third.id]);
  // A legacy bundle whose two drills carry the same players is refused like the binding path.
  const twin = sessionOf(o.sourceTeamId, 37003, D1);
  twin.details.drills["1"] = structuredClone(twin.details.drills["0"]);
  legacyFake(o.sourceTeamId, [twin]);
  const refused = await runCheck(o);
  assert.deepEqual([refused.status, refused.error_code], ["failed", "drill_parameter_effect_not_distinguishable"]);
  assert.equal((await bySession(o.teamId))["37003"], undefined);
});

test("10. the drill-parameter guard through a bound check: identical non-empty drill answers fail the check fail-closed with no candidate; a coach gets no proof or reason; fewer than two non-empty answers store not_observed, which is never actionable; no fingerprint and no unconsumed metric is stored, returned or logged", async () => {
  const o = await boundOrg();
  const twin = sessionOf(o.sourceTeamId, 38001, D1);
  const shared = { 101: { tot_burst_events: { unit: "number", value: 3 }, tot_brake_events: { unit: "number", value: 2 }, hidden_metric_marker_v33: { a: [1, 2] } } };
  src.serve(o.sourceTeamId, [twin]);
  src.state.faults.drillPlayers["38001"] = () => structuredClone(shared);
  const logBefore = logLines.length;
  const failed = await runCheck(o);
  assert.deepEqual([failed.status, failed.error_code], ["failed", "drill_parameter_effect_not_distinguishable"], JSON.stringify(failed));
  assert.equal((await candidates(o.teamId)).length, 0, "no candidate");
  const coachView = (await api(`/gpexe/teams/${o.teamId}/checks/${failed.id}`, { cookie: o.coach.cookie })).body.check;
  assert.equal(coachView.error.code, "source_connection_unavailable", "the coach gets no proof or reason");
  assert.doesNotMatch(JSON.stringify(coachView), /drill|parameter|fingerprint|same content/i);
  const adminView = (await api(`/gpexe/teams/${o.teamId}/checks/${failed.id}`, { cookie: o.padmin.cookie })).body.check;
  assert.equal(adminView.error.code, "drill_parameter_effect_not_distinguishable");
  const fp = adapterMod.drillAnswerFingerprint(shared);
  // One non-empty drill answer of two: not_observed, stored and never actionable.
  delete src.state.faults.drillPlayers["38001"];
  const half = sessionOf(o.sourceTeamId, 38002, D1);
  src.serve(o.sourceTeamId, [half]);
  src.state.faults.drillPlayers["38002"] = (index) => (index === 0 ? structuredClone(half.details.drills["0"].players) : {});
  const ok = await runCheck(o);
  assert.equal(ok.status, "succeeded", JSON.stringify(ok));
  const [c] = await candidates(o.teamId);
  assert.equal(c.effect, "not_observed");
  const coachSummary = (await listed(o)).find((x) => x.id === c.id);
  assert.ok(coachSummary.approvalBlockers.includes("not_confirmed_for_import"));
  assert.doesNotMatch(JSON.stringify(coachSummary), /not_observed|parameter|fingerprint/i, "one generic word, no proof");
  assert.equal((await approve(o, c.id)).body.error, "candidate_not_actionable");
  assert.match(await rawApproval(c.id, o.padmin.id), /no confirmed drill-parameter effect/);
  // Nowhere: candidate rows, check rows, audit, API answers, console.
  const stored = JSON.stringify(await q(`select * from training_load.gpexe_import_candidates where owner_team_id = $1`, [o.teamId]))
    + JSON.stringify(await q(`select * from training_load.gpexe_import_checks where owner_team_id = $1`, [o.teamId]))
    + JSON.stringify(await q(`select * from training_load.source_connection_audit`));
  const everything = stored + responses.join("\n") + logLines.slice(logBefore).join("\n");
  assert.ok(!everything.includes(fp), "the fingerprint is nowhere");
  assert.ok(!everything.includes("hidden_metric_marker_v33"), "no unconsumed metric is stored, returned or logged");
  const columns = (await q(`select column_name from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_candidates'`)).map((r) => r.column_name);
  assert.ok(!columns.some((n) => /fingerprint/.test(n)));
});

test("11. static guard: the finalization's withdrawal and supersede statements compare last_seen_check_id with IS DISTINCT FROM, the withdrawal names only pending / blocked rows and the exact UTC day window, the check row is locked before the candidates and the team try-lock last, and the run itself changes no other row", async () => {
  const svc = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeImportService.js"), "utf8");
  const fin = svc.slice(svc.indexOf("async function finalizeCheck("), svc.indexOf("export async function approveCandidate("));
  assert.ok(fin.length > 1000);
  const withdrawal = fin.slice(fin.indexOf("// 3. A session of the window"), fin.indexOf("// 4. What was superseded"));
  assert.match(withdrawal, /status in \('pending', 'blocked'\) and last_seen_check_id is distinct from \$2/);
  assert.match(withdrawal, /\(session_started_at at time zone 'UTC'\)::date between \$3::date and \$4::date/);
  assert.match(withdrawal, /superseded_by_check_id = \$2/);
  assert.doesNotMatch(withdrawal, /'imported'/);
  const supersede = fin.slice(fin.indexOf("// 2. Older content"), fin.indexOf("// 3. A session of the window"));
  assert.match(supersede, /c\.last_seen_check_id is distinct from \$2/);
  const order = ["for update`", "hold_gpexe_team_lock", "// 1. Seen again", "// 5. The publication."].map((s) => fin.indexOf(s));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), "check row and candidates locked, then the team try-lock, then the writes, then the publication");
  assert.match(fin, /where id = \$1 and owner_team_id = \$2 for update/);
  const record = svc.slice(svc.indexOf("async function recordCandidate("), svc.indexOf("// Candidates\n") > 0 ? svc.indexOf("// Candidates\n") : svc.indexOf("function snapshotState("));
  assert.doesNotMatch(record, /set status = 'superseded'/, "the run supersedes nothing");
  assert.doesNotMatch(record, /superseded_by_candidate_id = null/, "the run restores nothing");
});

const waitingOn = async (pattern) => until(async () => (await q(
  `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like $1`, [pattern]))[0].n > 0);

test("12. the batch route refuses every non-actionable candidate with candidate_not_actionable and no reviewAgain: one of a running check, one withdrawn by a check, one not_observed; nothing is approved", async () => {
  const o = await boundOrg();
  src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, 40001, D1)]);
  assert.equal((await runCheck(o)).status, "succeeded");
  const half = sessionOf(o.sourceTeamId, 40002, D1);
  src.serve(o.sourceTeamId, [half]);
  src.state.faults.drillPlayers["40002"] = (index) => (index === 0 ? structuredClone(half.details.drills["0"].players) : {});
  assert.equal((await runCheck(o)).status, "succeeded");
  delete src.state.faults.drillPlayers["40002"];
  src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, 40003, D1), sessionOf(o.sourceTeamId, 40004, D1)]);
  const held = gate();
  src.state.gates.athletes["40004"] = held;
  const run = await startCheck(o);
  try {
    await until(async () => held.reached && (await candidates(o.teamId)).some((c) => c.sid === "40003"));
    const rows = await bySession(o.teamId);
    const ids = [rows["40003"][0].id, rows["40001"][0].id, rows["40002"][0].id];
    assert.deepEqual([rows["40001"][0].status, rows["40001"][0].by_check !== null, rows["40002"][0].effect], ["superseded", true, "not_observed"]);
    const hashes = await q(`select id, preview_hash from training_load.gpexe_import_candidates where id = any($1::uuid[])`, [ids]);
    const previewHashes = Object.fromEntries(hashes.map((h) => [h.id, h.preview_hash]));
    process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
    let r;
    try {
      r = await api(`/gpexe/teams/${o.teamId}/imports`, { method: "POST", cookie: o.padmin.cookie, body: { candidateIds: ids, previewHashes } });
    } finally {
      delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
    }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.results.map((x) => [x.candidateId, x.outcome, x.code, "reviewAgain" in x]), ids.map((id) => [id, "refused", "candidate_not_actionable", false]));
    assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_approvals where owner_team_id = $1`, [o.teamId]))[0].n, 0);
  } finally {
    held.release();
  }
  await run.done.p;
});

test("13. a stall inside the finalization is bounded: the server ends the idle transaction (idle_in_transaction_session_timeout 5 s), the team import lock is free again within the bound, and nothing of the check is published or withdrawn", async () => {
  const o = await boundOrg();
  src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, 41001, D1)]);
  assert.equal((await runCheck(o)).status, "succeeded");
  src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, 41002, D1)]);
  const entered = gate();
  // The production bound is 5 s (CHECK_FINALIZE_IDLE_TIMEOUT_MS); a 1 s bound and a 4 s stall keep the margin wide under load.
  assert.equal(importer.CHECK_FINALIZE_IDLE_TIMEOUT_MS, 5_000);
  importer.setCheckFinalizeForTests({ idleTimeoutMs: 1_000, beforeCommit: async () => { entered.release(); await new Promise((r) => setTimeout(r, 4_000)); } });
  const run = await startCheck(o);
  await entered.p;
  const stalledAt = Date.now();
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  let freedAfter = null;
  try {
    for (let i = 0; i < 300 && freedAfter === null; i += 1) {
      await holder.query("begin");
      const ok = (await holder.query(`select pg_try_advisory_xact_lock(hashtextextended('gpexe-import-team:' || $1::text, 21)) as ok`, [o.teamId])).rows[0].ok;
      await holder.query("rollback");
      if (ok) freedAfter = Date.now() - stalledAt;
      else await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await holder.end();
  }
  assert.ok(freedAfter !== null && freedAfter < 3_500, `the team lock was freed by the server within the bound (${freedAfter} ms), before the stalled code went on`);
  await run.done.p;
  const row = await checkRow(run.id);
  assert.equal(row.status, "failed");
  assert.match(row.error_code, /^check_finalize_(failed|outcome_unknown)$/);
  const rows = await bySession(o.teamId);
  assert.deepEqual([rows["41001"][0].status, rows["41001"][0].by_check], ["pending", null], "nothing withdrawn");
  assert.ok(!actionable(await summaryOf(o, rows["41002"][0].id)), "nothing published");
});

test("14. a COMMIT still in flight when its bound runs out: the outcome is unknown, the conditional 'failed' write waits for the old transaction and matches no row, and the check ends succeeded with its withdrawal - a late COMMIT is never overwritten", async () => {
  const o = await boundOrg();
  src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, 42001, D1)]);
  assert.equal((await runCheck(o)).status, "succeeded");
  const KEY = 33_424_242;
  await q(`create function training_load.test_v33_hold_commit() returns trigger language plpgsql as $$ begin perform pg_advisory_lock(${KEY}); perform pg_advisory_unlock(${KEY}); return null; end $$`);
  await q(`create constraint trigger test_v33_hold_commit after update on training_load.gpexe_import_checks deferrable initially deferred
             for each row when (new.status = 'succeeded' and new.owner_team_id = '${o.teamId}') execute function training_load.test_v33_hold_commit()`);
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query(`select pg_advisory_lock(${KEY})`);
    importer.setCheckFinalizeForTests({ commitBoundMs: 300 });
    src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, 42002, D1)]);
    const run = await startCheck(o);
    // The COMMIT waits in the deferred trigger; the bound runs out; the run's 'failed' write then waits on the check row.
    await waitingOn("%set status = 'failed'%");
    assert.equal((await checkRow(run.id)).status, "running");
    await holder.query(`select pg_advisory_unlock(${KEY})`);
    await run.done.p;
    const row = await checkRow(run.id);
    assert.deepEqual([row.status, row.error_code], ["succeeded", null], "the late COMMIT stands");
    const rows = await bySession(o.teamId);
    assert.deepEqual([rows["42001"][0].status, rows["42001"][0].by_check], ["superseded", run.id]);
    assert.ok(actionable(await summaryOf(o, rows["42002"][0].id)));
  } finally {
    await holder.end();
    await q(`drop trigger if exists test_v33_hold_commit on training_load.gpexe_import_checks`);
    await q(`drop function if exists training_load.test_v33_hold_commit()`);
  }
});

test("15. on the legacy path a drill answer the guard cannot compare ends the check as drill_set_incomplete, like the binding path: a coach reads no word about the comparison, nothing is recorded", async () => {
  const o = await org();
  const odd = sessionOf(o.sourceTeamId, 43001, D1);
  odd.details.drills["1"].players = JSON.parse('{"101": {"tot_burst_events": {"unit": "number", "value": 2}, "m": {"constructor": 1}}}');
  legacyFake(o.sourceTeamId, [odd]);
  const row = await runCheck(o);
  assert.deepEqual([row.status, row.error_code], ["failed", "drill_set_incomplete"], JSON.stringify(row));
  assert.equal((await candidates(o.teamId)).length, 0);
  const coach = (await api(`/gpexe/teams/${o.teamId}/checks/${row.id}`, { cookie: o.coach.cookie })).body.check;
  assert.equal(coach.error.code, "drill_set_incomplete");
  assert.doesNotMatch(JSON.stringify(coach), /compar|fingerprint|constructor/i);
});

test("16. an approval and the finalization on the same candidate, through the real routes: (a) an approval holding the candidate makes the finalization end as check_finalize_busy - the approval imports, nothing is withdrawn or published; (b) a finalization holding the candidate makes the approval wait and then refuse it as candidate_not_actionable - no approval row", async () => {
  const o = await boundOrg();
  src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, 44001, D1)]);
  assert.equal((await runCheck(o)).status, "succeeded");
  const [x] = await candidates(o.teamId);
  // (a) The check is held at its list; the approval of x starts and is held after its locks; the list (now empty) goes on.
  src.serve(o.sourceTeamId, []);
  const list = gate();
  src.state.gates.list = list;
  const run = await startCheck(o);
  await until(async () => list.reached);
  const approved = gate();
  const releaseApproval = gate();
  importer.setApprovalObserver(async () => { approved.release(); await releaseApproval.p; });
  const approving = approve(o, x.id);
  try {
    await approved.p;
    list.release();
    await run.done.p;
    const row = await checkRow(run.id);
    assert.deepEqual([row.status, row.error_code], ["failed", "check_finalize_busy"], JSON.stringify(row));
  } finally {
    list.release();
    releaseApproval.release();
  }
  const a = await approving;
  importer.setApprovalObserver(null);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal((await candidates(o.teamId)).find((c) => c.id === x.id).status, "imported");
  delete src.state.gates.list;
  // (b) A new pending candidate y; the next check (which no longer lists it) is held before its COMMIT; an approval of y waits on y's row, then is refused.
  src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, 44002, D1)]);
  assert.equal((await runCheck(o)).status, "succeeded");
  const y = (await bySession(o.teamId))["44002"][0];
  src.serve(o.sourceTeamId, []);
  const atCommit = gate();
  const goCommit = gate();
  importer.setCheckFinalizeForTests({ idleTimeoutMs: 60_000, beforeCommit: async () => { atCommit.release(); await goCommit.p; } });
  const run2 = await startCheck(o);
  await atCommit.p;
  const refusing = approve(o, y.id);
  try {
    await waitingOn("%from training_load.gpexe_import_candidates where id = $1 and owner_team_id = $2 for update%");
  } finally {
    goCommit.release();
  }
  await run2.done.p;
  assert.equal((await checkRow(run2.id)).status, "succeeded");
  const refused = await refusing;
  assert.deepEqual([refused.status, refused.body.error], [409, "candidate_not_actionable"], JSON.stringify(refused.body));
  const yNow = (await candidates(o.teamId)).find((c) => c.id === y.id);
  assert.deepEqual([yNow.status, yNow.by_check], ["superseded", run2.id]);
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_approvals where candidate_id = $1`, [y.id]))[0].n, 0);
});

test("17. the finalization re-validates the run's facts under the team lock: a binding ended or a connection that left verified after the last read fails the check with the precise code (administrator) and publishes or withdraws nothing", async () => {
  for (const change of ["binding_ended", "connection_not_usable"]) {
    const o = await boundOrg();
    src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, change === "binding_ended" ? 45001 : 45101, D1)]);
    assert.equal((await runCheck(o)).status, "succeeded");
    src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, change === "binding_ended" ? 45002 : 45102, D1)]);
    const bindingRow = (await q(`select b.id as binding_id, b.connection_id from training_load.source_team_bindings b where b.team_id = $1 and b.state = 'active'`, [o.teamId]))[0];
    importer.setCheckFinalizeForTests({
      beforeLocks: async () => {
        if (change === "binding_ended") {
          const r = await api(`/sources/gpexe/connections/${bindingRow.connection_id}/bindings/${bindingRow.binding_id}/unbind`, { method: "POST", cookie: o.cadmin.cookie, body: { requestKey: crypto.randomUUID(), reason: "test: ended during the check", expected: { teamId: o.teamId, sourceTeamId: o.sourceTeamId } } });
          assert.equal(r.status, 200, JSON.stringify(r.body));
        } else {
          await q(`update training_load.source_credential_connections set state = 'needs_reconnect', last_error_code = 'source_auth_rejected', last_error_at = now() where id = $1`, [bindingRow.connection_id]);
        }
      },
    });
    const row = await runCheck(o);
    importer.setCheckFinalizeForTests({});
    assert.deepEqual([row.status, row.error_code], ["failed", change], JSON.stringify(row));
    const rows = await bySession(o.teamId);
    const older = rows[String(change === "binding_ended" ? 45001 : 45101)][0];
    const newer = rows[String(change === "binding_ended" ? 45002 : 45102)][0];
    assert.deepEqual([older.status, older.by_check], ["pending", null], `${change}: nothing withdrawn`);
    assert.ok(!actionable(await summaryOf(o, newer.id)), `${change}: nothing published`);
    const coach = (await api(`/gpexe/teams/${o.teamId}/checks/${row.id}`, { cookie: o.coach.cookie })).body.check;
    assert.equal(coach.error.code, "source_connection_unavailable");
  }
});

test("18. the client-side statement bound: a finalization statement without an answer within its bound closes the connection and ends the check as check_finalize_failed - before the server's own lock_timeout (which would read check_finalize_busy) - and nothing is published or withdrawn", async () => {
  const o = await boundOrg();
  src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, 46001, D1)]);
  assert.equal((await runCheck(o)).status, "succeeded");
  const [c1] = await candidates(o.teamId);
  assert.equal(importer.CHECK_FINALIZE_STATEMENT_BOUND_MS, 12_000);
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    src.serve(o.sourceTeamId, [sessionOf(o.sourceTeamId, 46002, D1)]);
    // The candidate rows' lock statement waits on the holder; its 300 ms client bound runs out long before the 2 s lock_timeout.
    importer.setCheckFinalizeForTests({ statementBoundMs: 300, beforeLocks: async () => { await holder.query("begin"); await holder.query(`select id from training_load.gpexe_import_candidates where id = $1 for update`, [c1.id]); } });
    const started = Date.now();
    const row = await runCheck(o);
    const took = Date.now() - started;
    assert.deepEqual([row.status, row.error_code], ["failed", "check_finalize_failed"], JSON.stringify(row));
    assert.ok(logLines.some((l) => l.includes(`check ${row.id} finalization ended as check_finalize_failed`)), "the code is logged, never a message");
    await holder.query("rollback");
    const rows = await bySession(o.teamId);
    assert.deepEqual([rows["46001"][0].status, rows["46001"][0].by_check], ["pending", null], "nothing withdrawn");
    assert.ok(!actionable(await summaryOf(o, rows["46002"][0].id)), "nothing published");
    void took;
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
});

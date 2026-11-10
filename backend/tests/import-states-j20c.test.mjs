// J20-C (migration v61): the attendance states of an import, saved right after its approval by the same user through
// POST /api/training-load/gpexe/teams/:teamId/approvals/:approvalId/states. The roster bulk command bound to the approval
// (origin 'import', origin_approval_id): the undo removes them as the import's own (v60); the window is
// training_load.import_states_window(). Through the real server on a disposable database; GPEXE is the fake server3 source;
// the import is the real approval.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle as makeFixtureBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding } from "./support/mapped-world.mjs";

const makeBundle = (options) => makeFixtureBundle({ detailsDrills: [0, 1], ...options });


if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const D1 = "2026-09-14";
let src;
let connections;
let resolver;
let db;
let admin;
let server;
let apiBase;
let service;
let undoService;
let createSession;
let appPool;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "j20c", migrations: GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")) }); // every migration but the error-tracking one (an injected failure would be recorded as a row)
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  process.env.SOURCE_CREDENTIAL_KEYS = (await import("../src/sourceCredentialCrypto.js")).generateKeyEntry(1);
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  undoService = await import("../src/gpexeSessionUndoService.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  src = createFakeSource();
  connections.setSourceFetchForTests(src.fetchImpl);
  resolver.setImportSourceFetchForTests(src.fetchImpl);
  service.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a bound team"); });
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  service?.setGpexeClientFactory(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS; else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_SWITCH === undefined) delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  else process.env.GPEXE_IMPORT_APPLY_ENABLED = ORIGINAL_SWITCH;
});

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load/gpexe${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

async function makeUser(label) {
  return (await admin.query(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${Math.random().toString(16).slice(2)}@test.local`, label])).rows[0].id;
}
async function setWorkspace(userId, type, scopeId) {
  await admin.query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [userId, type, scopeId],
  );
}
async function coachOf(teamId, label = "coach") {
  const id = await makeUser(label);
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}
async function platformAdmin() {
  const id = await makeUser("platform admin");
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}
async function clubAdminOf(clubId) {
  const id = await makeUser("club admin");
  await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await setWorkspace(id, "club", clubId);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}

function cleanBundle({ sessionId, hour = 8, ids = [101, 102], updatedOn = "2026-09-14T20:18:09.337", distance101 = null }) {
  const byId = Object.fromEntries(standardAthletes().map((a) => [a.id, a]));
  const athletes = ids.map((id, i) => {
    const a = structuredClone(byId[id]);
    a.tracks = [sessionId * 10 + i];
    for (const part of a.parts) delete part.track;
    return a;
  });
  if (distance101 !== null) athletes.find((a) => a.id === 101)?.parts.forEach((p) => { if (p.drill === null) p.distance = distance101; });
  return makeBundle({ sessionId, gpexeTeamId: 77, start: `2026-09-14T${String(hour).padStart(2, "0")}:08:12`, updatedOn, athletes });
}

let nextGpexeTeamId = 7000;
async function setupTeam() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A101", "B102", "C103", "D", "E", "F105"] });
  const [a, b, c] = org.athleteIds;
  // The roster counts a membership only from its start: the pilot org adds athletes "now", after the sessions imported here.
  await admin.query(`delete from public.athlete_memberships where team_id = $1`, [org.teamId]);
  for (const athleteId of org.athleteIds) {
    await admin.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athleteId, org.clubId, org.teamId]);
  }
  const coach = await coachOf(org.teamId);
  const padmin = await platformAdmin();
  const cadmin = await clubAdminOf(org.clubId);
  const sourceTeamId = String(nextGpexeTeamId++);
  assert.equal((await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } })).status, 200);
  src.show(sourceTeamId);
  const { bindingId } = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId });
  await enableTeamImportSwitch(admin, org.teamId);
  await activateBinding(admin, bindingId);
  for (const [gpexeAthleteId, athleteId] of [["101", a], ["102", b], ["103", c]]) {
    assert.equal((await api(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId, athleteId } })).status, 201);
  }
  return { ...org, coach, padmin, cadmin, sourceTeamId, bindingId };
}

async function checkNow(team, bundles) {
  src.serve(team.sourceTeamId, bundles);
  const started = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: { from: D1, to: D1 } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 200; i += 1) {
    const r = await api(`/teams/${team.teamId}/checks/${started.body.check.id}`, { cookie: team.coach.cookie });
    if (r.body.check?.status !== "running") {
      assert.equal(r.body.check.status, "succeeded", JSON.stringify(r.body.check));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("check did not finish");
}

async function listFor(team, { cookie = team.padmin.cookie, includeSuperseded = false } = {}) {
  return (await api(`/teams/${team.teamId}/candidates${includeSuperseded ? "?includeSuperseded=true" : ""}`, { cookie })).body.candidates;
}

async function withSwitchOn(fn) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await fn();
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
    service.setApprovalObserver(null);
    service.setApprovalCommitForTests(null);
  }
}

// One session found, reviewed and imported through the real batch approval. Returns the imported candidate.
async function importSession(team, sessionId, { hour = 8 } = {}) {
  await checkNow(team, [cleanBundle({ sessionId, hour })]);
  const cand = (await listFor(team)).find((c) => c.gpexeTeamSessionId === String(sessionId) && c.status === "pending");
  assert.ok(cand, "a pending candidate");
  const imported = await withSwitchOn(async () => api(`/teams/${team.teamId}/imports`, {
    method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } },
  }));
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.body.results[0].outcome, "imported", imported.text);
  const approval = (await admin.query(`select id, metric_event_id, activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0];
  return { approvalId: approval.id, candidateId: cand.id, sessionId: String(sessionId), eventId: approval.metric_event_id, activityId: approval.activity_id, previewHash: cand.previewHash };
}

const undoPath = (team, id) => `/teams/${team.teamId}/candidates/${id}/undo-import`;
const previewPath = (team, id) => `/teams/${team.teamId}/candidates/${id}/undo-preview`;
const key = () => crypto.randomUUID();
const undo = (team, s, { cookie = team.padmin.cookie, requestKey = key(), reason = "wrong athlete link", expected = { eventId: s.eventId } } = {}) =>
  api(undoPath(team, s.candidateId), { method: "POST", cookie, body: { requestKey, reason, expected } });

async function counts(teamId) {
  const one = async (sql) => (await admin.query(sql, sql.includes("$1") ? [teamId] : [])).rows[0].n;
  return {
    events: await one(`select count(*)::int n from training_load.metric_events where owner_team_id = $1`),
    participants: await one(`select count(*)::int n from training_load.metric_event_participants p join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`),
    occasions: await one(`select count(*)::int n from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`),
    values: await one(`select count(*)::int n from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`),
    provenance: await one(`select count(*)::int n from training_load.metric_value_source_provenance`),
    bindings: await one(`select count(*)::int n from training_load.metric_event_source_bindings b join training_load.metric_events e on e.id = b.event_id where e.owner_team_id = $1`),
    activities: await one(`select count(*)::int n from training.activities where owner_team_id = $1`),
    observations: await one(`select count(*)::int n from training.activity_source_observations`),
    log: await one(`select count(*)::int n from training_load.import_deletion_log where owner_team_id = $1`),
    requests: await one(`select count(*)::int n from training_load.gpexe_session_undo_requests where owner_team_id = $1`),
  };
}

async function allRowCounts() {
  const tables = (await admin.query(
    `select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema in ('training_load', 'training', 'public', 'calendar') and table_type = 'BASE TABLE' order by 1`,
  )).rows.map((r) => r.name);
  const out = {};
  for (const name of tables) out[name] = (await admin.query(`select count(*)::int as n from ${name}`)).rows[0].n;
  return out;
}

// ---------------------------------------------------------------------------
// J20-C helpers
// ---------------------------------------------------------------------------
const V61 = "migrations_v2/202611101200_training_load_v61_import_states_approval.sql";
const RUNBOOK = (name) => new URL(`../../docs/runbooks/${name}`, import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function newClient() {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  return c;
}
const undoWith = (team, s, { cookie = team.padmin.cookie, requestKey = key(), reason = "wrong athlete link", fingerprint } = {}) =>
  api(undoPath(team, s.candidateId), {
    method: "POST", cookie,
    body: { requestKey, reason, expected: { eventId: s.eventId }, ...(fingerprint === undefined ? {} : { laterRosterFingerprint: fingerprint }) },
  });
const preview = (team, s, cookie = team.padmin.cookie) => api(previewPath(team, s.candidateId), { cookie });

// The roster of the imported activity, as the coach's Roster tab reads it.
async function rosterOf(team, s, cookie = team.coach.cookie) {
  const r = await fetch(`${apiBase}/api/training-activity/${s.activityId}/roster`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
// A Roster-tab change through the real route (origin 'roster', whatever the body says).
async function rosterChange(team, s, athleteId, { kind = "did_not_participate", reasonKey = "illness", expectedDecisionId = null, cookie = team.coach.cookie, extra = {} } = {}) {
  const r = await fetch(`${apiBase}/api/training-activity/${s.activityId}/roster/${athleteId}/decision`, {
    method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ kind, ...(kind === "did_not_participate" ? { reasonKey } : {}), expectedDecisionId, requestKey: key(), ...extra }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function rosterRows(activityId) {
  const q = async (sql) => (await admin.query(sql, [activityId])).rows[0].n;
  return {
    decisions: await q(`select count(*)::int n from training.activity_athlete_decisions where activity_id = $1`),
    requests: await q(`select count(*)::int n from training.activity_roster_requests where activity_id = $1`),
    completions: await q(`select count(*)::int n from training.activity_completions where activity_id = $1`),
    completionLog: await q(`select count(*)::int n from training.activity_completion_log where activity_id = $1`),
  };
}
const needingState = async (team, s) => (await rosterOf(team, s)).athletes.filter((a) => a.group === "needs_state").map((a) => a.athleteId);


const sliceTo = (needle) => GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes(needle)) + 1);
const withoutV61 = () => GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes("v61_import_states")));
// The request read the session before it waited for the undo; after the undo it has no participant left (v44's gate).
const EXPECT_AFTER_UNDO = [409, "roster_not_applicable"];
const statesPath = (team, approvalId) => `/teams/${team.teamId}/approvals/${approvalId}/states`;
const states = (team, s, athleteIds, { cookie = team.padmin.cookie, requestKey = key(), kind = "participated_no_values", reasonKey, approvalId = s.approvalId, expected = {} } = {}) =>
  api(statesPath(team, approvalId), {
    method: "POST", cookie,
    body: { requestKey, kind, ...(reasonKey ? { reasonKey } : {}), athletes: athleteIds.map((athleteId) => ({ athleteId, expectedDecisionId: expected[athleteId] ?? null })) },
  });
const importRequests = async (activityId) => (await admin.query(
  `select id, origin, origin_approval_id, performed_by_user_id from training.activity_roster_requests where activity_id = $1 and origin = 'import'`, [activityId])).rows;
// Moves an approval back in time (the approvals are append-only: the test turns the triggers off for this one write).
async function ageApproval(approvalId, minutes) {
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  await admin.query(`update training_load.gpexe_import_approvals set approved_at = approved_at - make_interval(mins => $2) where id = $1`, [approvalId, minutes]);
  await admin.query("commit");
}
// A raw import-origin request (with its decisions) the way the route writes it, for the database's own rules.
async function rawImportRequest(team, s, athleteIds, { by = team.padmin, basis = "platform_admin", approvalId = s.approvalId, createdAt = null, client = admin } = {}) {
  const requestId = crypto.randomUUID();
  await client.query("begin");
  try {
    await client.query(
      `insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, decided_by_user_id, decided_by_basis)
       select $1, x, $2, $3, 'participated_no_values', $4, $6 from unnest($5::uuid[]) x`,
      [s.activityId, team.teamId, requestId, by.id, athleteIds, basis]);
    await client.query(
      `insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin, origin_approval_id, created_at)
       values ($1, $2, gen_random_uuid(), repeat('a', 64), 'decide_bulk', $3, '{}'::jsonb, 'import', $4, coalesce($5::timestamptz, now()))`,
      [requestId, s.activityId, by.id, approvalId, createdAt]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

test("1. the states of an import: saved by the approver as the import's own (origin import, the approval named); the undo removes them without a question", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9701);
  const need = await needingState(team, s);
  assert.ok(need.length >= 2, "athletes without device data need a state");
  const r = await states(team, s, need.slice(0, 2));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.body.decisions.length, 2);
  const reqs = await importRequests(s.activityId);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].origin_approval_id, s.approvalId);
  assert.equal(reqs[0].performed_by_user_id, team.padmin.id);
  const roster = await rosterOf(team, s);
  for (const id of need.slice(0, 2)) assert.notEqual(roster.athletes.find((a) => a.athleteId === id).group, "needs_state");
  const p = (await preview(team, s)).body.undoPreview.rosterWork;
  assert.equal(p.importWritten.decisions, 2);
  assert.equal(p.laterWork.total, 0);
  const done = await undoWith(team, s);
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(await rosterRows(s.activityId), { decisions: 0, requests: 0, completions: 0, completionLog: 0 });
});

test("2. idempotency: the same key and body replays the saved answer; the same key with another body, or on the plain bulk route, is request_key_reused; one request row", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9702);
  const [x, y] = await needingState(team, s);
  const requestKey = key();
  const first = await states(team, s, [x], { requestKey });
  assert.equal(first.status, 200, first.text);
  const again = await states(team, s, [x], { requestKey });
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.body, first.body);
  const other = await states(team, s, [y], { requestKey });
  assert.deepEqual([other.status, other.body.error], [409, "request_key_reused"], other.text);
  const plain = await fetch(`${apiBase}/api/training-activity/${s.activityId}/roster/decisions`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: team.padmin.cookie },
    body: JSON.stringify({ requestKey, kind: "participated_no_values", athletes: [{ athleteId: x, expectedDecisionId: null }] }),
  });
  assert.deepEqual([plain.status, (await plain.json()).error], [409, "request_key_reused"], "the same key on the plain route: another request (the origin is in the hash)");
  const coachPlain = await fetch(`${apiBase}/api/training-activity/${s.activityId}/roster/decisions`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: team.coach.cookie },
    body: JSON.stringify({ requestKey, kind: "participated_no_values", athletes: [{ athleteId: y, expectedDecisionId: null }] }),
  });
  assert.equal(coachPlain.status, 409, "the coach's plain request with the same key: request_key_reused (another user's key)");
  assert.equal((await importRequests(s.activityId)).length, 1);
});

test("3. who: another user (the coach, the club admin), another team's approval, a missing one and a malformed id are the identical 404; nothing written", async () => {
  const team = await setupTeam();
  const other = await setupTeam();
  const s = await importSession(team, 9703);
  const o = await importSession(other, 9704);
  const [x] = await needingState(team, s);
  const bodies = [];
  for (const [cookie, approvalId] of [[team.coach.cookie, s.approvalId], [team.cadmin.cookie, s.approvalId], [team.padmin.cookie, o.approvalId],
    [team.padmin.cookie, crypto.randomUUID()], [team.padmin.cookie, "not-a-uuid"]]) {
    const r = await states(team, s, [x], { cookie, approvalId });
    assert.equal(r.status, 404, `${approvalId} ${r.text}`);
    assert.equal(r.headers.get("cache-control"), "no-store", "every answer, the 404 included");
    bodies.push(r.text);
  }
  assert.equal(new Set(bodies).size, 1, "byte-identical 404 bodies");
  assert.equal((await rosterRows(s.activityId)).requests, 0);
});

test("4. the rights are checked at the time of this request, not taken from the import: an approver who lost the right meanwhile gets the identical 404; the import stands", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9705);
  const [x] = await needingState(team, s);
  await admin.query(`update public.user_global_roles set is_active = false where user_id = $1 and role = 'platform_admin'`, [team.padmin.id]);
  try {
    const r = await states(team, s, [x]);
    assert.equal(r.status, 404, r.text);
  } finally {
    await admin.query(`update public.user_global_roles set is_active = true where user_id = $1 and role = 'platform_admin'`, [team.padmin.id]);
  }
  assert.equal((await rosterRows(s.activityId)).requests, 0);
  assert.equal((await admin.query(`select status from training_load.gpexe_import_candidates where id = $1`, [s.candidateId])).rows[0].status, "imported");
  assert.equal((await states(team, s, [x])).status, 200, "with the right back, the same request goes through");
});

test("5. the window: after it a new key is 409 import_states_window_closed (nothing written), the saved key still replays; the database refuses a late raw request", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9706);
  const [x, y] = await needingState(team, s);
  const requestKey = key();
  const first = await states(team, s, [x], { requestKey });
  assert.equal(first.status, 200, first.text);
  assert.equal((await admin.query(`select extract(epoch from training_load.import_states_window())::int s`)).rows[0].s, 1800, "30 minutes");
  await ageApproval(s.approvalId, 31);
  const late = await states(team, s, [y]);
  assert.deepEqual([late.status, late.body.error], [409, "import_states_window_closed"], late.text);
  const sameBodyNewKey = await states(team, s, [x], { expected: {} });
  assert.deepEqual([sameBodyNewKey.status, sameBodyNewKey.body.error], [409, "import_states_window_closed"], "the same body with a new key after the window");
  const replay = await states(team, s, [x], { requestKey });
  assert.equal(replay.status, 200, replay.text);
  assert.deepEqual(replay.body, first.body);
  assert.equal((await importRequests(s.activityId)).length, 1);
  await assert.rejects(rawImportRequest(team, s, [y]), (e) => e.code === "23514" && /outside the import states window/.test(e.message));
  // A writer that backdates created_at into the window is still measured by the server's time.
  const inside = (await admin.query(`select (approved_at + interval '1 minute')::text t from training_load.gpexe_import_approvals where id = $1`, [s.approvalId])).rows[0].t;
  await assert.rejects(rawImportRequest(team, s, [y], { createdAt: inside }), (e) => e.code === "23514" && /outside the import states window/.test(e.message));
  // Before the approval (an approval moved into the future): refused too.
  const t2 = await importSession(team, 9707, { hour: 10 });
  const [z] = await needingState(team, t2);
  await ageApproval(t2.approvalId, -10);
  await assert.rejects(rawImportRequest(team, t2, [z]), (e) => e.code === "23514" && /outside the import states window/.test(e.message));
});

test("6. the athletes: a left-out athlete (a subset import) gets a state; an athlete with measured values does not; one off the roster is refused by the route and by the database", async () => {
  const team = await setupTeam();
  await checkNow(team, [cleanBundle({ sessionId: 9708 })]);
  const cand = (await listFor(team)).find((c) => c.gpexeTeamSessionId === "9708" && c.status === "pending");
  const sub = await api(`/teams/${team.teamId}/candidates/${cand.id}/preview`, { method: "POST", cookie: team.padmin.cookie, body: { excludedAthleteIds: ["102"] } });
  assert.equal(sub.status, 200, sub.text);
  const approved = await withSwitchOn(() => api(`/teams/${team.teamId}/candidates/${cand.id}/approve`, {
    method: "POST", cookie: team.padmin.cookie, body: { previewHash: cand.previewHash, subsetHash: sub.body.subset.subsetHash, excludedAthleteIds: ["102"] },
  }));
  assert.equal(approved.status, 200, approved.text);
  const row = (await admin.query(`select id, metric_event_id, activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0];
  const s = { approvalId: row.id, candidateId: cand.id, eventId: row.metric_event_id, activityId: row.activity_id };
  const [a101, b102] = team.athleteIds;
  const leftOut = await states(team, s, [b102]);
  assert.equal(leftOut.status, 200, leftOut.text);
  const measured = await states(team, s, [a101]);
  assert.deepEqual([measured.status, measured.body.error, measured.body.failed?.[0]?.error], [409, "bulk_conflict", "measured_record_exists"], measured.text);
  // An athlete of the team whose membership starts after the session: not on its roster.
  const late = (await admin.query(`insert into public.athletes (first_name, last_name, full_name, display_name) values ('Late','Joiner','Late Joiner','Late Joiner') returning id`)).rows[0].id;
  await admin.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2027-01-01T00:00:00Z')`, [late, team.clubId, team.teamId]);
  const off = await states(team, s, [late]);
  assert.deepEqual([off.status, off.body.error, off.body.failed?.[0]?.error], [409, "bulk_conflict", "not_on_roster"], off.text);
  // The database: the decision trigger (v25) refuses it first; v61's own rule is proven with that trigger off for one rolled-back write.
  await assert.rejects(rawImportRequest(team, s, [late]), (e) => e.code === "P0001" && /not on the roster/.test(e.message));
  await admin.query("begin");
  try {
    await admin.query("alter table training.activity_athlete_decisions disable trigger activity_athlete_decisions_check");
    const requestId = crypto.randomUUID();
    await admin.query(
      `insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, decided_by_user_id, decided_by_basis)
       values ($1, $2, $3, $4, 'participated_no_values', $5, 'platform_admin')`, [s.activityId, late, team.teamId, requestId, team.padmin.id]);
    await assert.rejects(admin.query(
      `insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin, origin_approval_id)
       values ($1, $2, gen_random_uuid(), repeat('a', 64), 'decide_bulk', $3, '{}'::jsonb, 'import', $4)`, [requestId, s.activityId, team.padmin.id, s.approvalId]),
      (e) => e.code === "23514" && /origin import names an athlete who is not on the roster/.test(e.message));
  } finally {
    await admin.query("rollback");
  }
  assert.equal((await importRequests(s.activityId)).length, 1);
});

test("7. the database binds the request to the named approval: none, another user's, another session's approval are 23514", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9709);
  const t = await importSession(team, 9710, { hour: 11 });
  const [x] = await needingState(team, s);
  // An import-origin request that names no approval: the guard (it runs before the CHECK) refuses it.
  await assert.rejects(admin.query(
    `insert into training.activity_roster_requests (activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin)
     values ($1, gen_random_uuid(), repeat('a', 64), 'decide', $2, '{}'::jsonb, 'import')`, [s.activityId, team.padmin.id]),
    (e) => e.code === "23514" && /needs an approval of this session/.test(e.message));
  await assert.rejects(admin.query(
    `insert into training.activity_roster_requests (activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin_approval_id)
     values ($1, gen_random_uuid(), repeat('a', 64), 'decide', $2, '{}'::jsonb, $3)`, [s.activityId, team.padmin.id, s.approvalId]),
    /activity_roster_requests_origin_approval_check/);
  await assert.rejects(rawImportRequest(team, s, [x], { by: team.coach, basis: "team_coach" }), (e) => e.code === "23514" && /same user/.test(e.message));
  await assert.rejects(rawImportRequest(team, s, [x], { approvalId: t.approvalId }), (e) => e.code === "23514" && /same user/.test(e.message));
  await rawImportRequest(team, s, [x]);
  assert.equal((await importRequests(s.activityId)).length, 1);
});

test("8. a lost answer: the import stands, the states' COMMIT answer is lost (503 outcome_unknown); Check result with the same key replays and writes once", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9711);
  const [x, y] = await needingState(team, s);
  const commands = await import("../src/activityRosterCommands.js");
  const requestKey = key();
  commands.setRosterCommandTestHooks({
    commit: async (client) => { await client.query("commit"); throw new Error("the answer was lost"); },
    checkFault: async () => { throw new Error("the check was lost too"); },
  });
  let lost;
  try {
    lost = await states(team, s, [x, y], { requestKey });
  } finally {
    commands.setRosterCommandTestHooks(null);
  }
  assert.deepEqual([lost.status, lost.body.error], [503, "outcome_unknown"], lost.text);
  const check = await states(team, s, [x, y], { requestKey });
  assert.equal(check.status, 200, check.text);
  assert.equal(check.body.decisions.length, 2);
  assert.equal((await importRequests(s.activityId)).length, 1);
  assert.equal((await rosterRows(s.activityId)).decisions, 2);
});

test("9. lock order with the undo: a states request in flight holds the team's import lock; the undo waits, then removes the states without a question", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9712);
  const [x] = await needingState(team, s);
  const commands = await import("../src/activityRosterCommands.js");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const inside = new Promise((resolve) => { reached = resolve; });
  commands.setRosterCommandTestHooks({ beforeCommit: async () => { reached(); await gate; } });
  try {
    const st = states(team, s, [x]);
    await inside;
    let settled = false;
    const u = undoWith(team, s).finally(() => { settled = true; });
    await sleep(400);
    assert.equal(settled, false, "the undo waits for the states' team lock");
    release();
    assert.equal((await st).status, 200);
    const answer = await u;
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.body.undo.rosterWork.importWritten.decisions, 1);
  } finally {
    commands.setRosterCommandTestHooks(null);
    release();
  }
  assert.deepEqual(await rosterRows(s.activityId), { decisions: 0, requests: 0, completions: 0, completionLog: 0 });
});

test("10. lock order the other way: an undo in flight holds the lock; the states request waits and then writes nothing", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9713);
  const [x] = await needingState(team, s);
  const c = await newClient();
  try {
    await c.query("begin");
    await c.query(`select * from training_load.undo_imported_session($1, $2, $3, gen_random_uuid(), 'j20c order test', $4)`,
      [team.padmin.id, team.teamId, s.candidateId, s.eventId]);
    let settled = false;
    const st = states(team, s, [x]).finally(() => { settled = true; });
    await sleep(400);
    assert.equal(settled, false, "the states request waits for the undo's team lock");
    await c.query("commit");
    const answer = await st;
    assert.deepEqual([answer.status, answer.body.error], EXPECT_AFTER_UNDO, answer.text);
    assert.ok(!/40P01|deadlock/i.test(answer.text));
  } finally {
    await c.end();
  }
  assert.deepEqual(await rosterRows(s.activityId), { decisions: 0, requests: 0, completions: 0, completionLog: 0 });
  // After the undo, a new request: the session is gone, the identical 404.
  const after = await states(team, s, [x]);
  assert.deepEqual([after.status, after.body.error], [404, "notFound"], after.text);
});

test("14. the import's right and the roster's agree in every reachable workspace: a platform admin who asks for a club workspace without that club's role works from the platform workspace, imports and saves the states", async () => {
  const team = await setupTeam();
  await setWorkspace(team.padmin.id, "club", team.clubId);
  try {
    const s = await importSession(team, 9716);
    const [x] = await needingState(team, s);
    const r = await states(team, s, [x]);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.decisions[0].decidedBy.basis, "platform_admin");
  } finally {
    await setWorkspace(team.padmin.id, "platform", null);
  }
});

test("11. the body is the roster bulk's: no athletes, 61 athletes, a duplicate and a bad key are 400; a later kind is 409 kind_not_available; nothing written", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9714);
  const [x] = await needingState(team, s);
  const send = (body) => api(statesPath(team, s.approvalId), { method: "POST", cookie: team.padmin.cookie, body });
  for (const body of [
    { requestKey: key(), kind: "participated_no_values", athletes: [] },
    { requestKey: key(), kind: "participated_no_values", athletes: Array.from({ length: 61 }, () => ({ athleteId: crypto.randomUUID(), expectedDecisionId: null })) },
    { requestKey: key(), kind: "participated_no_values", athletes: [{ athleteId: x, expectedDecisionId: null }, { athleteId: x, expectedDecisionId: null }] },
    { requestKey: "nope", kind: "participated_no_values", athletes: [{ athleteId: x, expectedDecisionId: null }] },
  ]) {
    const r = await send(body);
    assert.equal(r.status, 400, r.text);
  }
  const later = await send({ requestKey: key(), kind: "estimated", athletes: [{ athleteId: x, expectedDecisionId: null }] });
  assert.deepEqual([later.status, later.body.error], [409, "kind_not_available"], later.text);
  assert.equal((await rosterRows(s.activityId)).requests, 0);
});

async function booleansOf(client, sql) {
  const results = [].concat(await client.query(sql));
  const out = [];
  for (const res of results) for (const row of res.rows) for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") out.push([k, v]);
  return out;
}
async function catalogOf(client) {
  const tables = ["activity_roster_requests", "activity_athlete_decisions", "activity_completions", "activity_completion_log", "import_deletion_log"];
  const triggers = (await client.query(
    `select c.relname || '.' || t.tgname || ' :: ' || pg_get_triggerdef(t.oid) as d from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname = any($1) and not t.tgisinternal order by 1`, [tables])).rows.map((r) => r.d);
  const constraints = (await client.query(
    `select c.relname || '.' || conname || ' :: ' || pg_get_constraintdef(k.oid) as d from pg_constraint k join pg_class c on c.oid = k.conrelid where c.relname = any($1) order by 1`, [tables])).rows.map((r) => r.d);
  const columns = (await client.query(
    `select table_name || '.' || column_name || ' ' || data_type || ' ' || coalesce(column_default, '') || ' ' || is_nullable as d from information_schema.columns
      where table_schema in ('training', 'training_load') and table_name = any($1) order by table_name, ordinal_position`, [tables])).rows.map((r) => r.d);
  const functions = (await client.query(
    `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(p.prosrc) || ' ' || pg_get_function_result(p.oid) as d
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('training_load', 'training') order by 1`)).rows.map((r) => r.d);
  const comments = (await client.query(
    `select obj_description(p.oid, 'pg_proc') d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = 'undo_imported_session'`)).rows.map((r) => r.d);
  return { triggers, constraints, columns, functions, comments };
}

test("12. migration v61: the preflight passes on v60, the post-check on v61, the rollback restores v60 exactly, refuses with an import-origin request, and the migration applies again", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "j20crb", migrations: withoutV61() });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    const pre = await booleansOf(client, fs.readFileSync(RUNBOOK("import-states-v61-preflight.sql"), "utf8"));
    assert.ok(pre.length >= 10, `the preflight returned its booleans (${pre.length})`);
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok on a v60 database");
    const v60Catalog = await catalogOf(client);
    await applyGpexeTestMigrations(rb.url, sliceTo("v61_import_states"));
    const post = await booleansOf(client, fs.readFileSync(RUNBOOK("import-states-v61-postcheck.sql"), "utf8"));
    assert.ok(post.length >= 9, `the post-check returned its booleans (${post.length})`);
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok on a v61 database");
    const v61Catalog = await catalogOf(client);
    assert.notDeepEqual(v61Catalog, v60Catalog);
    const bodies = (await client.query(`select md5(p.prosrc) m from pg_proc p where p.proname in ('protect_activity_roster_request_v61', 'import_states_window')`)).rows.map((r) => r.m);
    assert.equal(bodies.length, 2);
    for (const m of bodies) {
      assert.match(fs.readFileSync(RUNBOOK("import-states-v61-postcheck.sql"), "utf8"), new RegExp(m));
      assert.match(fs.readFileSync(RUNBOOK("import-states-v61-rollback.sql"), "utf8"), new RegExp(m));
    }
    const rollback = fs.readFileSync(RUNBOOK("import-states-v61-rollback.sql"), "utf8");
    await client.query(rollback);
    assert.deepEqual(await catalogOf(client), v60Catalog, "the rollback restores the v60 catalog exactly");
    assert.equal((await client.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V61])).rows[0].n, 0);
    await applyGpexeTestMigrations(rb.url, sliceTo("v61_import_states"));
    assert.deepEqual(await catalogOf(client), v61Catalog, "re-applied: the same catalog");
    // Refused (nothing changed) once an import-origin request exists (here: on the main test database, written through the route).
  } finally {
    await client.end();
    await rb.drop();
  }
  const team = await setupTeam();
  const s = await importSession(team, 9715);
  const [x] = await needingState(team, s);
  assert.equal((await states(team, s, [x])).status, 200);
  const before = await catalogOf(admin);
  const c = await newClient();
  try {
    await assert.rejects(c.query(fs.readFileSync(RUNBOOK("import-states-v61-rollback.sql"), "utf8")), /v61 rollback refused: an import-origin roster request exists/);
    await c.query("rollback").catch(() => {});
  } finally {
    await c.end();
  }
  assert.deepEqual(await catalogOf(admin), before, "the refused rollback changed nothing");
});

test("13. the md5 gate: v61 refuses to run, changing nothing, when v60's guard is not the one in force", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "j20cgate", migrations: withoutV61() });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    const src = (await client.query(`select pg_get_functiondef('training.protect_activity_roster_request_v60()'::regprocedure) d`)).rows[0].d;
    await client.query(src.replace("activity_roster_requests is append-only", "activity_roster_requests is append only"));
    const before = await catalogOf(client);
    await assert.rejects(applyGpexeTestMigrations(rb.url, sliceTo("v61_import_states")), /v61_import_states_approval\.sql" \(SQLSTATE 23514\)/);
    const refusal = await client.query(`select 1 from pg_proc where proname = 'protect_activity_roster_request_v61'`);
    assert.equal(refusal.rowCount, 0);
    assert.deepEqual(await catalogOf(client), before);
  } finally {
    await client.end();
    await rb.drop();
  }
});

// v76 (2026-11-17): an imported session may be deleted (undone) by whoever may import it - the approval right's four
// bases and its mode rule, derived again in the database under the undo's locks; the team's switch being off does not
// remove it. The deletion log records the basis, and its insert trigger derives it again (a row cannot name a basis its
// user does not hold). The activity route finds the import behind a session for the calendar and Activities.
// Disposable databases only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
// This suite pins v60 as the last migration (its rollback tests need that); later migrations (v61, J20-C) have their own suites.
const UP_TO_V60 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes("v60_undo_roster_work")) + 1);
// v62: every check, preview and approval reads the team's session time zone, so the main database carries v62 as well; the v60
// rollback checks below hide v62's record for their run (its later-migration gate would refuse first) and put it back.
const V62_FILE = "202611111200_training_load_v62_team_session_timezone.sql";
// MT-B: the preview reads v67's track choices, so v67 is applied too (test 0 hides its record with v62's).
const V67_FILE = "202611131200_training_load_v67_gpexe_track_choices.sql";
// MT-D: and v68 (the preview reads the scale); test 0 hides its record too.
const V68_FILE = "202611131300_training_load_v68_track_choice_scale.sql";
const V63_FILE = "202611121000_training_load_v63_metric_value_estimates.sql"; // the undo body v76 replaces is v63's
const V76_FILE = "202611171000_training_load_v76_undo_by_importer.sql";
const MAIN_MIGRATIONS = [...UP_TO_V60.filter((m) => !m.includes("app_error_events")), V62_FILE, V63_FILE, V67_FILE, V68_FILE, V76_FILE];
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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "undo76", migrations: MAIN_MIGRATIONS }); // through v60, plus v62 (the importer reads it); not the error-tracking one (an injected failure would be recorded as a row)
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
async function importSession(team, sessionId, { hour = 8, cookie = team.padmin.cookie } = {}) {
  await checkNow(team, [cleanBundle({ sessionId, hour })]);
  const cand = (await listFor(team)).find((c) => c.gpexeTeamSessionId === String(sessionId) && c.status === "pending");
  assert.ok(cand, "a pending candidate");
  const imported = await withSwitchOn(async () => api(`/teams/${team.teamId}/imports`, {
    method: "POST", cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } },
  }));
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.body.results[0].outcome, "imported", imported.text);
  const approval = (await admin.query(`select metric_event_id, activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0];
  return { candidateId: cand.id, sessionId: String(sessionId), eventId: approval.metric_event_id, activityId: approval.activity_id, previewHash: cand.previewHash };
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
// O1 helpers
// ---------------------------------------------------------------------------
const V60 = "migrations_v2/202611101000_training_load_v60_undo_roster_work.sql";
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
// The states J20-C's flow writes after an import: one request with origin 'import' by the approving user, its decisions.
async function writeImportStates(team, s, athleteIds, { by = team.padmin, basis = "platform_admin", kind = "participated_no_values", origin = "import", client = admin, createdAt = null } = {}) {
  const requestId = crypto.randomUUID();
  await client.query("begin");
  try {
    await client.query(
      `insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, decided_by_user_id, decided_by_basis)
       select $1, x, $2, $3, $4, $5, $7 from unnest($6::uuid[]) x`,
      [s.activityId, team.teamId, requestId, kind, by.id, athleteIds, basis]);
    await client.query(
      `insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin, created_at)
       values ($1, $2, gen_random_uuid(), encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'decide_bulk', $3, '{}'::jsonb, $4, coalesce($5::timestamptz, now()))`,
      [requestId, s.activityId, by.id, origin, createdAt]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  return requestId;
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
// ---------------------------------------------------------------------------
// v76 helpers
// ---------------------------------------------------------------------------
const statusOf = async (team, cookie) => api(`/teams/${team.teamId}/status`, { cookie });
const importUndoPath = (team, activityId) => `/teams/${team.teamId}/activities/${activityId}/import-undo`;
async function grantTo(team, user) {
  const r = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: user.id, reason: "imports for the team" } });
  assert.equal(r.status, 201, r.text);
  return r.body.grant.id;
}
async function revokeGrant(team, grantId) {
  const r = await api(`/teams/${team.teamId}/approvers/${grantId}/revoke`, { method: "POST", cookie: team.padmin.cookie, body: { reason: "no longer imports" } });
  assert.equal(r.status, 200, r.text);
}
const setMode = (team, mode, enabled = true) => enableTeamImportSwitch(admin, team.teamId, team.padmin.id, { mode, enabled });
const logOf = async (eventId) => (await admin.query(`select deleted_by_user_id, authorized_via from training_load.import_deletion_log where event_id = $1`, [eventId])).rows;
// The identical 404 of every route of the undo for a caller without the right: the preview, the undo, the activity read.
async function allHidden(team, s, cookie, label) {
  const p = await api(previewPath(team, s.candidateId), { cookie });
  const u = await undo(team, s, { cookie });
  const a = await api(importUndoPath(team, s.activityId), { cookie });
  for (const [name, r] of [["preview", p], ["undo", u], ["activity", a]]) assert.equal(r.status, 404, `${label}: ${name} ${r.text}`);
  assert.equal(p.text, a.text, `${label}: the identical 404`);
}
async function clubAdminInTeamWorkspace(team) {
  // A club's admin opens the team from the club; the approval's club_admin basis is the same in either workspace.
  return clubAdminOf(team.clubId);
}

// ---------------------------------------------------------------------------
// Who may undo
// ---------------------------------------------------------------------------
test("1. pilot mode: a platform admin undoes (basis platform_admin); a coach and the club admin without a grant get the identical 404 everywhere and no status flag; nothing removed", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 7601);
  assert.equal((await statusOf(team, team.padmin.cookie)).body.viewer.undoImport, true);
  for (const [who, cookie] of [["coach", team.coach.cookie], ["club admin", team.cadmin.cookie]]) {
    const st = await statusOf(team, cookie);
    if (st.status === 200) assert.equal("undoImport" in st.body.viewer, false, `${who}: no flag`);
    const rowsBefore = await allRowCounts();
    await allHidden(team, s, cookie, who);
    assert.deepEqual(await allRowCounts(), rowsBefore, `${who}: nothing removed`);
  }
  const done = await undo(team, s);
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(await logOf(s.eventId), [{ deleted_by_user_id: team.padmin.id, authorized_via: "platform_admin" }]);
});

test("2. a coach with an approver grant (pilot mode) sees the flag, finds the import from the session, reads the preview and undoes it; the log names the coach with basis team_grant", async () => {
  const team = await setupTeam();
  await grantTo(team, team.coach);
  const s = await importSession(team, 7602, { cookie: team.coach.cookie });
  assert.equal((await statusOf(team, team.coach.cookie)).body.viewer.undoImport, true);
  const found = await api(importUndoPath(team, s.activityId), { cookie: team.coach.cookie });
  assert.deepEqual([found.status, found.body], [200, { importUndo: { candidateId: s.candidateId } }], found.text);
  assert.equal(found.headers.get("cache-control"), "no-store");
  assert.equal((await api(previewPath(team, s.candidateId), { cookie: team.coach.cookie })).status, 200);
  const done = await undo(team, s, { cookie: team.coach.cookie });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(await logOf(s.eventId), [{ deleted_by_user_id: team.coach.id, authorized_via: "team_grant" }]);
  assert.equal((await counts(team.teamId)).events, 0);
});

test("3. mode team: the club's admin (basis club_admin) and the team's coach (basis team_coach) each undo an import a platform admin made", async () => {
  const team = await setupTeam();
  await setMode(team, "team");
  const s1 = await importSession(team, 7603, { hour: 8 });
  const s2 = await importSession(team, 7604, { hour: 10 });
  const cadmin = await clubAdminInTeamWorkspace(team);
  for (const cookie of [cadmin.cookie, team.coach.cookie]) assert.equal((await statusOf(team, cookie)).body.viewer.undoImport, true);
  const a = await undo(team, s1, { cookie: cadmin.cookie });
  assert.equal(a.status, 200, a.text);
  const b = await undo(team, s2, { cookie: team.coach.cookie });
  assert.equal(b.status, 200, b.text);
  assert.deepEqual(await logOf(s1.eventId), [{ deleted_by_user_id: cadmin.id, authorized_via: "club_admin" }]);
  assert.deepEqual(await logOf(s2.eventId), [{ deleted_by_user_id: team.coach.id, authorized_via: "team_coach" }]);
});

test("4. the team's switch off does not remove the right: in mode team the coach may no longer import but still undoes; in pilot mode a granted coach the same", async () => {
  const team = await setupTeam();
  await setMode(team, "team");
  const s = await importSession(team, 7605);
  await setMode(team, "team", false);
  const st = (await statusOf(team, team.coach.cookie)).body;
  assert.equal(st.teamImportSwitch.enabled, false);
  assert.equal(st.viewer.canApprove, false, "the switch off: no import");
  assert.equal(st.viewer.undoImport, true, "but the undo stays");
  const done = await undo(team, s, { cookie: team.coach.cookie });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(await logOf(s.eventId), [{ deleted_by_user_id: team.coach.id, authorized_via: "team_coach" }]);

  const team2 = await setupTeam();
  await grantTo(team2, team2.coach);
  const s2 = await importSession(team2, 7606);
  await setMode(team2, "pilot", false);
  const done2 = await undo(team2, s2, { cookie: team2.coach.cookie });
  assert.equal(done2.status, 200, done2.text);
  assert.deepEqual(await logOf(s2.eventId), [{ deleted_by_user_id: team2.coach.id, authorized_via: "team_grant" }]);
});

test("5. everyone else gets the identical 404, nothing removed: another club's admin, an admin of both clubs in the other club's workspace, a user with no role, the athlete, and anyone once the team is archived", async () => {
  const team = await setupTeam();
  await setMode(team, "team");
  const s = await importSession(team, 7607);
  const other = await createGpexePilotOrg(admin, { athleteNames: ["Z1"] });
  const otherAdmin = await clubAdminOf(other.clubId);
  const both = await clubAdminOf(team.clubId);
  await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [both.id, other.clubId]);
  await setWorkspace(both.id, "club", other.clubId);
  const nobodyId = await makeUser("nobody");
  const nobody = { id: nobodyId, cookie: `optimove_session=${await createSession(nobodyId)}` };
  const athleteUserId = await makeUser("athlete");
  await admin.query(`update public.athletes set user_id = $1 where id = $2`, [athleteUserId, team.athleteIds[0]]);
  const athlete = { id: athleteUserId, cookie: `optimove_session=${await createSession(athleteUserId)}` };
  const rowsBefore = await allRowCounts();
  for (const [who, u] of [["another club's admin", otherAdmin], ["admin of both, other workspace", both], ["no role", nobody], ["athlete", athlete]]) {
    await allHidden(team, s, u.cookie, who);
  }
  await admin.query(`update public.teams set is_active = false where id = $1`, [team.teamId]);
  try {
    for (const [who, cookie] of [["coach", team.coach.cookie], ["platform admin", team.padmin.cookie]]) await allHidden(team, s, cookie, `archived team, ${who}`);
  } finally {
    await admin.query(`update public.teams set is_active = true where id = $1`, [team.teamId]);
  }
  assert.deepEqual(await allRowCounts(), rowsBefore, "nothing removed");
});

test("6. a coach whose grant is revoked after the import and before the undo: the identical 404, no flag; the platform admin still undoes", async () => {
  const team = await setupTeam();
  const grantId = await grantTo(team, team.coach);
  const s = await importSession(team, 7608, { cookie: team.coach.cookie });
  await revokeGrant(team, grantId);
  assert.equal("undoImport" in (await statusOf(team, team.coach.cookie)).body.viewer, false);
  const rowsBefore = await allRowCounts();
  await allHidden(team, s, team.coach.cookie, "revoked coach");
  assert.deepEqual(await allRowCounts(), rowsBefore);
  assert.equal((await undo(team, s)).status, 200);
});

test("7. coach A undoes a session coach B imported (the same right); the log names A; A cannot forge a log row with basis platform_admin", async () => {
  const team = await setupTeam();
  await setMode(team, "team");
  const coachA = await coachOf(team.teamId, "coach A");
  const s = await importSession(team, 7609, { cookie: team.coach.cookie });
  const approval = (await admin.query(`select approved_by_user_id, approval_basis from training_load.gpexe_import_approvals where candidate_id = $1`, [s.candidateId])).rows[0];
  assert.deepEqual([approval.approved_by_user_id, approval.approval_basis], [team.coach.id, "team_coach"], "B imported it");
  const done = await undo(team, s, { cookie: coachA.cookie });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(await logOf(s.eventId), [{ deleted_by_user_id: coachA.id, authorized_via: "team_coach" }]);

  const real = (await admin.query(`select * from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0];
  const forge = (basis) => admin.query(
    `insert into training_load.import_deletion_log (deleted_by_user_id, authorized_via, reason, event_id, source_system, source_connection_id, source_external_id, owner_team_id, occurred_date, removed_counts, removed_total)
     values ($1, $2, 'forged', gen_random_uuid(), $3, $4, $5, $6, $7, $8, $9)`,
    [coachA.id, basis, real.source_system, real.source_connection_id, real.source_external_id, real.owner_team_id, real.occurred_date, real.removed_counts, real.removed_total]);
  await assert.rejects(forge("platform_admin"), (e) => e.code === "42501" && /may not undo an imported session on that basis/.test(e.message));
  await assert.rejects(forge("team_grant"), (e) => e.code === "42501" && /on that basis/.test(e.message), "a grant A does not hold");
  assert.equal((await admin.query(`select count(*)::int n from training_load.import_deletion_log where reason = 'forged'`)).rows[0].n, 0);
});

// ---------------------------------------------------------------------------
// The activity route
// ---------------------------------------------------------------------------
test("8. the import behind a session: the imported activity and its canonical alias find the candidate; a session that is not imported, another team's, a bad id and an undone one get the identical 404", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 7610, { hour: 8 });
  const ok = await api(importUndoPath(team, s.activityId), { cookie: team.padmin.cookie });
  assert.deepEqual([ok.status, ok.body], [200, { importUndo: { candidateId: s.candidateId } }], ok.text);

  const manual = (await admin.query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, started_at, origin, owner_scope, owner_team_id, created_by_user_id)
     values ('training_session','hand made','2026-09-14','Europe/Sarajevo','2026-09-14T12:00:00Z','manual','team',$1,$2) returning id`, [team.teamId, team.padmin.id])).rows[0].id;
  const team2 = await setupTeam();
  const s2 = await importSession(team2, 7611);
  const missing = await api(importUndoPath(team, crypto.randomUUID()), { cookie: team.padmin.cookie });
  assert.equal(missing.status, 404);
  for (const [label, id] of [["manual", manual], ["another team's", s2.activityId], ["not a uuid", "x1"]]) {
    const r = await api(importUndoPath(team, id), { cookie: team.padmin.cookie });
    assert.deepEqual([r.status, r.text], [404, missing.text], label);
  }
  // The canonical session of a merge finds the import through its alias set (the undo itself is then refused as entangled).
  const s3 = await importSession(team, 7612, { hour: 10 });
  const canonical = (await admin.query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, started_at, origin, owner_scope, owner_team_id, created_by_user_id)
     values ('training_session','merged session','2026-09-14','Europe/Sarajevo','2026-09-14T08:08:12Z','manual','team',$1,$2) returning id`, [team.teamId, team.padmin.id])).rows[0].id;
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  await admin.query(`update training.activities set superseded_by_activity_id = $2, lifecycle_state = 'superseded' where id = $1`, [s3.activityId, canonical]);
  await admin.query("commit");
  const viaAlias = await api(importUndoPath(team, canonical), { cookie: team.padmin.cookie });
  assert.deepEqual([viaAlias.status, viaAlias.body], [200, { importUndo: { candidateId: s3.candidateId } }], viaAlias.text);
  const entangled = await undo(team, s3);
  assert.deepEqual([entangled.status, entangled.body.error], [409, "entangled_activity"]);
  assert.equal(entangled.body.message, "This session was merged with another session, so its imported data cannot be deleted here. Ask a platform administrator to delete it.");

  assert.equal((await undo(team, s)).status, 200);
  const gone = await api(importUndoPath(team, s.activityId), { cookie: team.padmin.cookie });
  assert.deepEqual([gone.status, gone.text], [404, missing.text], "an undone import is not offered again");
});

// ---------------------------------------------------------------------------
// What the coach sees and what stays
// ---------------------------------------------------------------------------
test("9. a coach's preview names the later roster change: the athlete's and the staff member's names, as an administrator's", async () => {
  const team = await setupTeam();
  await setMode(team, "team");
  const s = await importSession(team, 7613);
  const coachA = await coachOf(team.teamId, "coach A");
  const [x] = await needingState(team, s);
  const change = await rosterChange(team, s, x);
  assert.equal(change.status, 200, JSON.stringify(change.body));
  const p = await preview(team, s, coachA.cookie);
  assert.equal(p.status, 200, p.text);
  const item = p.body.undoPreview.rosterWork.laterWork.list[0];
  assert.equal(item.byUserId, team.coach.id);
  assert.ok(typeof item.athleteName === "string" && item.athleteName.length > 0, "the athlete's name");
  assert.equal(item.byName, "coach", "the staff member's name");
  const done = await undoWith(team, s, { cookie: coachA.cookie, fingerprint: p.body.undoPreview.rosterWork.laterWork.fingerprint });
  assert.equal(done.status, 200, done.text);
});

test("10. after a coach's undo the athlete's \"My training\" has no recorded session and her RPE stays untouched", async () => {
  const team = await setupTeam();
  await setMode(team, "team");
  const s = await importSession(team, 7614);
  const results = await import("../src/trainingActivityResults.js");
  const linked = (await admin.query(`select athlete_id from training.activity_participants where activity_id = $1 order by athlete_id limit 1`, [s.activityId])).rows[0].athlete_id;
  assert.equal(await results.athleteHasRecordedSessions(linked), true);
  await admin.query(
    `insert into training_load.session_feedback (athlete_id, source, logical_session_id, session_date, plan_name, rpe, duration_minutes, athlete_note) values ($1, 'planned', gen_random_uuid(), '2026-09-14', 'Week plan', 7, 75, 'hard')`, [linked]);
  const feedback = async () => (await admin.query(`select to_jsonb(f) j from training_load.session_feedback f where athlete_id = $1 order by id`, [linked])).rows.map((r) => r.j);
  const before = await feedback();
  assert.equal(before.length, 1);
  const done = await undo(team, s, { cookie: team.coach.cookie });
  assert.equal(done.status, 200, done.text);
  assert.equal(await results.athleteHasRecordedSessions(linked), false, "the row is gone from My training");
  assert.equal((await admin.query(`select count(*)::int n from training.activities where id = $1`, [s.activityId])).rows[0].n, 0);
  assert.deepEqual(await feedback(), before, "session_feedback is untouched");
});

test("11. the plain sentences: a calendar link names the next step; a hand-entered result and a merge send to a platform administrator; a coach sees no code in them", async () => {
  const team = await setupTeam();
  await setMode(team, "team");
  const s = await importSession(team, 7615);
  const typeId = (await admin.query(`select id from calendar.event_types limit 1`)).rows[0].id;
  await admin.query("begin");
  await admin.query(`alter table calendar.events disable trigger user`);
  const eventId = (await admin.query(
    `insert into calendar.events (owner_scope, owner_team_id, event_type_id, title, day, timezone, created_by_user_id)
     values ('team', $1, $2, 'Match day', '2026-09-14', 'Europe/Sarajevo', $3) returning id`, [team.teamId, typeId, team.padmin.id])).rows[0].id;
  await admin.query(`alter table calendar.events enable trigger user`);
  await admin.query("commit");
  await admin.query(`insert into calendar.event_activity_links (event_id, activity_id, linked_by_user_id) values ($1, $2, $3)`, [eventId, s.activityId, team.padmin.id]);
  const r = await undo(team, s, { cookie: team.coach.cookie });
  assert.deepEqual([r.status, r.body.error], [409, "calendar_link_exists"], r.text);
  assert.equal(r.body.message, "This session is attached to a calendar event. Remove it from the calendar event first, then delete it again.");
  const svc = fs.readFileSync(new URL("../src/gpexeSessionUndoService.js", import.meta.url), "utf8");
  assert.ok(svc.includes("Some results of this session were entered by hand, so its imported data cannot be deleted here. Ask a platform administrator to delete it."));
  for (const m of [r.body.message]) assert.doesNotMatch(m, /[a-z]+_[a-z_]+/, "no code in the sentence");
});

// ---------------------------------------------------------------------------
// Locks and races
// ---------------------------------------------------------------------------
test("12. recorded SQL order of the right: users, then the role rows (platform admin, grant, club admin, team coach), the switch row last; the undo derives the right before the team lock", async () => {
  const body = (await admin.query(`select prosrc from pg_proc where proname = 'lock_gpexe_session_undo_right'`)).rows[0].prosrc;
  const at = (needle) => { const i = body.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const order = [at("from public.users"), at("from public.user_global_roles"), at("from training_load.gpexe_import_approvers"), at("from public.user_club_roles"), at("from public.user_team_roles"), body.lastIndexOf("gpexe_team_import_switch")];
  assert.deepEqual([...order].sort((a, b) => a - b), order, "users first, the switch row last");
  assert.ok(!/gpexe_team_import_switch[\s\S]*enabled/.test(body.slice(body.lastIndexOf("from training_load.gpexe_team_import_switch"))) || !/\benabled\b/.test(body), "the switch's on/off is not read");
  const undoBody = (await admin.query(`select prosrc from pg_proc where proname = 'undo_imported_session'`)).rows[0].prosrc;
  assert.ok(undoBody.indexOf("lock_gpexe_session_undo_right") < undoBody.indexOf("gpexe-import-team:"), "the right before the team lock");
  assert.doesNotMatch(undoBody, /is not an active platform admin|'platform_admin'::text|authorized_via[^;]*'platform_admin'/, "no hard-coded basis left");
});

test("13. an approval and an undo of the same team serialize on the team's import lock: both wait for it, then both finish (one import, one undo)", async () => {
  const team = await setupTeam();
  await setMode(team, "team");
  const s = await importSession(team, 7616, { hour: 8 });
  await checkNow(team, [cleanBundle({ sessionId: 7617, hour: 12 })]);
  const cand = (await listFor(team)).find((c) => c.gpexeTeamSessionId === "7617" && c.status === "pending");
  const holder = await newClient();
  try {
    await holder.query("begin");
    await holder.query(`select pg_advisory_xact_lock(hashtextextended('gpexe-import-team:' || $1::text, 21))`, [team.teamId]);
    process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
    const undoing = undo(team, s, { cookie: team.coach.cookie });
    const approving = api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.coach.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } } });
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i += 1) {
      await sleep(50);
      waiting = (await admin.query(`select count(*)::int n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`)).rows[0].n;
    }
    assert.equal(waiting, 2, "both wait for the team's lock");
    await holder.query("commit");
    const [u, a] = await Promise.all([undoing, approving]);
    assert.equal(u.status, 200, u.text);
    assert.equal(a.status, 200, a.text);
    assert.equal(a.body.results[0].outcome, "imported", a.text);
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  assert.equal((await counts(team.teamId)).events, 1, "the undone session gone, the new one imported");
  assert.equal((await logOf(s.eventId)).length, 1);
});

test("13b. the database's own right, without the route in front: each basis and each refusal of lock_gpexe_session_undo_right, the undo function itself refuses a revoked grant", async () => {
  const team = await setupTeam();
  const right = async (userId) => {
    const c = await newClient();
    try {
      await c.query("begin");
      return (await c.query(`select training_load.lock_gpexe_session_undo_right($1, $2) b`, [userId, team.teamId])).rows[0].b;
    } catch (e) {
      if (e.code === "42501" && /may not undo an imported session/.test(e.message)) return "refused";
      throw e;
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
  };
  const granted = await coachOf(team.teamId, "granted");
  const grantId = await grantTo(team, granted);
  const otherTeam = await setupTeam();
  const foreignCoach = await coachOf(otherTeam.teamId, "foreign");
  // Pilot mode (setupTeam's switch): only the platform admin and the granted coach.
  assert.deepEqual(
    [await right(team.padmin.id), await right(granted.id), await right(team.coach.id), await right(team.cadmin.id), await right(foreignCoach.id), await right(otherTeam.cadmin.id)],
    ["platform_admin", "team_grant", "refused", "refused", "refused", "refused"]);
  // Mode team: the club's admin and the team's coach too; never another team's coach or another club's admin.
  await setMode(team, "team");
  assert.deepEqual(
    [await right(team.coach.id), await right(team.cadmin.id), await right(foreignCoach.id), await right(otherTeam.cadmin.id)],
    ["team_coach", "club_admin", "refused", "refused"]);
  // The switch off keeps every basis.
  await setMode(team, "team", false);
  assert.deepEqual([await right(team.coach.id), await right(team.cadmin.id), await right(granted.id)], ["team_coach", "club_admin", "team_grant"]);
  // Pilot again, the grant revoked: refused; a disabled account and a revoked platform role: refused.
  await setMode(team, "pilot");
  await revokeGrant(team, grantId);
  assert.equal(await right(granted.id), "refused", "a revoked grant");
  const padmin2 = await platformAdmin();
  await admin.query(`update public.user_global_roles set is_active = false where user_id = $1`, [padmin2.id]);
  assert.equal(await right(padmin2.id), "refused", "a revoked platform role");
  const padmin3 = await platformAdmin();
  await admin.query(`update public.users set is_active = false where id = $1`, [padmin3.id]);
  assert.equal(await right(padmin3.id), "refused", "a disabled account");
  // The undo function itself, called directly with the revoked coach: 42501 and nothing removed.
  const s = await importSession(team, 7619);
  const rowsBefore = await allRowCounts();
  await assert.rejects(
    admin.query(`select * from training_load.undo_imported_session($1, $2, $3, gen_random_uuid(), 'direct', $4, null)`, [granted.id, team.teamId, s.candidateId, s.eventId]),
    (e) => e.code === "42501");
  assert.deepEqual(await allRowCounts(), rowsBefore);
});

test("13c. the mode lowered to pilot while the right waits on the switch row: the right re-reads it under its lock and refuses the club's admin and the team's coach", async () => {
  const team = await setupTeam();
  await setMode(team, "team");
  for (const user of [team.cadmin, team.coach]) {
    const holder = await newClient();
    const caller = await newClient();
    try {
      // The holder lowers the mode the way the sanctioned switch write does, and keeps its transaction open.
      await holder.query("begin");
      await holder.query("select set_config('optimove.team_import_tx', txid_current()::text, true)");
      await holder.query(`update training_load.gpexe_team_import_switch set mode = 'pilot', changed_by_user_id = $2, change_reason = 'lowered', changed_at = now() where owner_team_id = $1`, [team.teamId, team.padmin.id]);
      await holder.query(
        `insert into training_load.gpexe_team_import_switch_history (owner_team_id, enabled, mode, changed_by_user_id, basis, change_reason) values ($1, true, 'pilot', $2, 'platform_admin', 'lowered')`,
        [team.teamId, team.padmin.id]);
      await caller.query("begin");
      const pending = caller.query(`select training_load.lock_gpexe_session_undo_right($1, $2) b`, [user.id, team.teamId]).then((r) => r.rows[0].b, (e) => (e.code === "42501" ? "refused" : Promise.reject(e)));
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        await sleep(30);
        waiting = (await admin.query(`select count(*)::int n from pg_locks where not granted and pid = $1`, [caller.processID])).rows[0].n > 0;
      }
      assert.ok(waiting, "the right waits on the switch row (its peek saw mode team)");
      await holder.query("commit");
      assert.equal(await pending, "refused", "re-read under the lock: pilot");
    } finally {
      await caller.query("rollback").catch(() => {});
      await holder.query("rollback").catch(() => {});
      await caller.end();
      await holder.end();
    }
    await setMode(team, "team");
  }
});

// ---------------------------------------------------------------------------
// The migration, its preflight, post-check and rollback
// ---------------------------------------------------------------------------
const V76_PATH = `migrations_v2/${V76_FILE}`;
const beforeV76 = () => GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("v76"));
// The disposable world does not run the error-tracking migrations; production has v73 recorded, which the preflight reads.
const V73_PATH = "migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql";
async function recordV73(client) {
  const sum = crypto.createHash("sha256").update(fs.readFileSync(new URL(`../../${V73_PATH}`, import.meta.url))).digest("hex");
  await client.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ($1, $2, 'test')`, [V73_PATH, sum]);
}
async function booleansOf(client, sql) {
  const results = [].concat(await client.query(sql));
  const out = [];
  for (const res of results) for (const row of res.rows) for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") out.push([k, v]);
  return out;
}
async function catalogOf(client) {
  const constraints = (await client.query(
    `select conname || ' :: ' || pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'training_load.import_deletion_log'::regclass order by 1`)).rows.map((r) => r.d);
  const triggers = (await client.query(
    `select t.tgname || ' :: ' || pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::text d from pg_trigger t where t.tgrelid = 'training_load.import_deletion_log'::regclass and not t.tgisinternal order by 1`)).rows.map((r) => r.d);
  const functions = (await client.query(
    `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(p.prosrc) || ' ' || coalesce(obj_description(p.oid, 'pg_proc'), '') d
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('training_load', 'training') order by 1`)).rows.map((r) => r.d);
  const migrations = (await client.query(`select migration_name from public.schema_migrations order by 1`)).rows.map((r) => r.migration_name);
  return { constraints, triggers, functions, migrations };
}

test("14. migration v76: the preflight passes before it, the post-check after it, the rollback restores the catalog before v76 exactly, and v76 applies again", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v76rb", migrations: beforeV76() });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    await recordV73(client);
    const pre = await booleansOf(client, fs.readFileSync(RUNBOOK("undo-by-importer-v76-preflight.sql"), "utf8"));
    assert.ok(pre.length >= 12, `the preflight returned its booleans (${pre.length})`);
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok before v76");
    const before = await catalogOf(client);
    await applyGpexeTestMigrations(rb.url, GPEXE_TEST_MIGRATIONS);
    const post = await booleansOf(client, fs.readFileSync(RUNBOOK("undo-by-importer-v76-postcheck.sql"), "utf8"));
    assert.ok(post.length >= 9, `the post-check returned its booleans (${post.length})`);
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok after v76");
    const after = await catalogOf(client);
    assert.notDeepEqual(after, before);
    // The post-check and the rollback name the bodies in force.
    for (const fn of ["undo_imported_session", "validate_import_deletion_log_v60", "lock_gpexe_session_undo_right"]) {
      const m = (await client.query(`select md5(prosrc) m from pg_proc where proname = $1`, [fn])).rows[0].m;
      assert.match(fs.readFileSync(RUNBOOK("undo-by-importer-v76-postcheck.sql"), "utf8"), new RegExp(m), fn);
      assert.match(fs.readFileSync(RUNBOOK("undo-by-importer-v76-rollback.sql"), "utf8"), new RegExp(m), fn);
    }
    await client.query(fs.readFileSync(RUNBOOK("undo-by-importer-v76-rollback.sql"), "utf8"));
    assert.deepEqual(await catalogOf(client), before, "the rollback restores the catalog before v76 exactly");
    await applyGpexeTestMigrations(rb.url, GPEXE_TEST_MIGRATIONS);
    assert.deepEqual(await catalogOf(client), after, "re-applied: the same catalog");
  } finally {
    await client.end();
    await rb.drop();
  }
});

test("15. the rollback refuses, changing nothing, once a deletion log row names another basis, and under a later migration; the migration refuses over a replaced body", async () => {
  // In the suite's own database: a coach's undo leaves a team_coach row.
  const team = await setupTeam();
  await setMode(team, "team");
  const s = await importSession(team, 7618);
  assert.equal((await undo(team, s, { cookie: team.coach.cookie })).status, 200);
  const sql = fs.readFileSync(RUNBOOK("undo-by-importer-v76-rollback.sql"), "utf8");
  const c1 = await newClient();
  try {
    const before = await catalogOf(c1);
    await assert.rejects(c1.query(sql), /v76 rollback refused: a deletion log row names a basis other than platform_admin/);
    await c1.query("rollback").catch(() => {});
    assert.deepEqual(await catalogOf(c1), before, "nothing changed");
  } finally {
    await c1.end();
  }

  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v76gate", migrations: beforeV76() });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    for (const fn of ["training_load.undo_imported_session", "training_load.validate_import_deletion_log_v60"]) {
      const original = (await client.query(`select pg_get_functiondef(to_regproc($1)) d`, [fn])).rows[0].d;
      await client.query(original.replace(/\$function\$\s*\n/, "$function$\n-- changed\n"));
      await assert.rejects(client.query(fs.readFileSync(new URL(`../../${V76_PATH}`, import.meta.url), "utf8")), /v76 refused: the body in force of/, fn);
      assert.equal((await client.query(`select to_regprocedure('training_load.lock_gpexe_session_undo_right(uuid,uuid)') is null as n`)).rows[0].n, true, "a refused run changes nothing");
      await client.query(original);
    }
    await applyGpexeTestMigrations(rb.url, GPEXE_TEST_MIGRATIONS);
    await client.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912310000_later.sql', repeat('0', 64), 'test')`);
    const before = await catalogOf(client);
    await assert.rejects(client.query(fs.readFileSync(RUNBOOK("undo-by-importer-v76-rollback.sql"), "utf8")), /later migrations are applied/);
    await client.query("rollback").catch(() => {});
    assert.deepEqual(await catalogOf(client), before);
  } finally {
    await client.end();
    await rb.drop();
  }
});

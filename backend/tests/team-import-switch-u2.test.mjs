// U2 (v56): the import switch per team. Through the real server on disposable databases; GPEXE is the fake
// server3 source; the environment switch is turned on inside this process only, for the tests that import.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { makeBundle as makeFixtureBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding } from "./support/mapped-world.mjs";
import fs from "node:fs";
import { createGpexeDisposableDb as createDb2, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

// v33 (the drill-parameter guard): a session with two or more drills is
// importable only when at least two drill answers are non-empty and pairwise
// distinct, so these sessions carry both drills' details.
const makeBundle = (options) => makeFixtureBundle({ detailsDrills: [0, 1], ...options });

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
// 9-B: a candidate is importable only through the team's binding and its
// mapping activations (J17 section 3), so every team here is bound to its
// GPEXE team through the real Connect / Bind routes and its sessions are
// served by the fake server3 source.
const D1 = "2026-09-14";
let src;
let connections;
let resolver;

let db;
let admin;
let server;
let apiBase;
let service;
let createSession;
let appPool;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "u2sw" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  process.env.SOURCE_CREDENTIAL_KEYS = (await import("../src/sourceCredentialCrypto.js")).generateKeyEntry(1);
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
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

async function api(path, { method = "GET", body, cookie, raw } = {}) {
  const res = await fetch(`${apiBase}/api/training-load/gpexe${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
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

async function clubAdminOf(clubId, label = "club admin") {
  const id = await makeUser(label);
  await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await setWorkspace(id, "club", clubId);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}

async function platformAdmin() {
  const id = await makeUser("platform admin");
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}

// A session whose athletes are all linked, in the team and need no manual
// step (a clean "Ready" candidate), unless `ids` names 104 (never linked).
// Each session gets its own start time and track ids.
function cleanBundle({ sessionId, hour = 8, ids = [101, 102], distance101 = 3000, updatedOn = "2026-09-14T20:18:09.337" }) {
  const byId = Object.fromEntries(standardAthletes().map((a) => [a.id, a]));
  byId[104] = { ...structuredClone(byId[102]), id: 104 };
  const athletes = ids.map((id, i) => {
    const a = structuredClone(byId[id]);
    a.tracks = [sessionId * 10 + i];
    for (const part of a.parts) delete part.track;
    return a;
  });
  athletes.find((a) => a.id === 101)?.parts.forEach((p) => { if (p.drill === null) p.distance = distance101; });
  return makeBundle({ sessionId, gpexeTeamId: 77, start: `2026-09-14T${String(hour).padStart(2, "0")}:08:12`, updatedOn, athletes });
}

let nextGpexeTeamId = 5000;
async function setupTeam({ switchOn = false } = {}) {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A101", "B102", "C103", "D", "E", "F105"] });
  const [a, b, c, , , f] = org.athleteIds;
  const coach = await coachOf(org.teamId);
  const padmin = await platformAdmin();
  const cadmin = await clubAdminOf(org.clubId);
  const sourceTeamId = String(nextGpexeTeamId++);
  assert.equal((await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } })).status, 200);
  src.show(sourceTeamId);
  const { bindingId } = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId });
  if (switchOn) await enableTeamImportSwitch(admin, org.teamId);
  await activateBinding(admin, bindingId);
  for (const [gpexeAthleteId, athleteId] of [["101", a], ["102", b], ["103", c], ["105", f]]) {
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

// The current candidate id of each GPEXE session id.
async function candidateIds(team) {
  const list = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  // Newest first: the first row of a session is its current candidate.
  const ids = {};
  for (const c of list) ids[c.gpexeTeamSessionId] ??= c.id;
  return ids;
}

// The list as the coach sees it: id -> previewHash.
async function listedHashes(team) {
  const list = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  return Object.fromEntries(list.map((c) => [c.id, c.previewHash]));
}

// A batch as the screen would send it: each id with the preview hash the
// list shows right now (or `hashes`, a list read earlier). An id the list
// does not show gets a well-formed hash of zeros.
async function batch(team, ids, cookie = team.padmin.cookie, hashes = null) {
  const seen = hashes ?? await listedHashes(team);
  const previewHashes = Object.fromEntries(ids.map((id) => [id, seen[id] ?? "0".repeat(64)]));
  return api(`/teams/${team.teamId}/imports`, { method: "POST", cookie, body: { candidateIds: ids, previewHashes } });
}

async function withSwitchOn(fn) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await fn();
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
    service.setApprovalObserver(null);
    service.setApprovalCommitForTests(null);
    service.setUncertainCommitCheckForTests({});
  }
}


// ---------------------------------------------------------------------------
// helpers of this suite
// ---------------------------------------------------------------------------

const dayOf = async (offset) => (await admin.query(`select (current_date + $1::int)::text as d`, [offset])).rows[0].d;
const recordPrereq = (padmin, kind, recordedOn, note) => api("/import-prerequisites", { method: "POST", cookie: padmin.cookie, body: { kind, recordedOn, ...(note !== undefined ? { note } : {}) } });
const putSwitch = (team, who, body) => api(`/teams/${team.teamId}/import-switch`, { method: "PUT", cookie: who.cookie, body });
const getSwitch = (team, who) => api(`/teams/${team.teamId}/import-switch`, { cookie: who.cookie });
const switchRow = async (teamId) => (await admin.query(`select enabled, mode from training_load.gpexe_team_import_switch where owner_team_id = $1`, [teamId])).rows[0] ?? null;
const historyOf = async (teamId) => (await admin.query(`select enabled, mode, basis from training_load.gpexe_team_import_switch_history where owner_team_id = $1 order by changed_at, id`, [teamId])).rows;

// Sessions of one day, one check; returns sessionId -> { id, hash }.
async function readyCandidates(team, sessionIds) {
  await checkNow(team, sessionIds.map((sessionId, i) => cleanBundle({ sessionId, hour: 6 + i * 2 })));
  const ids = await candidateIds(team);
  const hashes = await listedHashes(team);
  return Object.fromEntries(sessionIds.map((s) => [s, { id: ids[String(s)], hash: hashes[ids[String(s)]] }]));
}
const approve = (team, who, candidate) => api(`/teams/${team.teamId}/candidates/${candidate.id}/approve`, { method: "POST", cookie: who.cookie, body: { previewHash: candidate.hash } });
const approvalsOf = async (candidateId) => (await admin.query(`select approval_basis, approved_by_user_id, approver_grant_id from training_load.gpexe_import_approvals where candidate_id = $1`, [candidateId])).rows;
const eventsOf = async (teamId) => (await admin.query(`select count(*)::int as n from training_load.metric_events where owner_team_id = $1`, [teamId])).rows[0].n;

let platform;   // the platform admin who records the shared prerequisites
let gateTeam;   // the team whose switch the gate and role tests move

// ---------------------------------------------------------------------------
// 1. The gate: the conditions are read inside the database, at the moment of turning on
// ---------------------------------------------------------------------------

test("1. the gate: turning a team on needs a backup within 2 days and a restore probe within 35 days, judged by the database; nothing is written on a refusal; turning off needs no condition", async () => {
  gateTeam = await setupTeam();
  platform = gateTeam.padmin;
  const t = gateTeam;
  // No record at all.
  let r = await putSwitch(t, t.padmin, { enabled: true, reason: "pilot start" });
  assert.deepEqual([r.status, r.body.error, r.body.details], [409, "team_import_condition_unmet", undefined]);
  assert.match(r.body.message, /backup/i);
  assert.equal(await switchRow(t.teamId), null, "a refusal writes no row");
  assert.deepEqual(await historyOf(t.teamId), []);
  // A backup of 3 days ago is too old; of 2 days ago is accepted by the backup condition.
  assert.equal((await recordPrereq(t.padmin, "backup", await dayOf(-3))).status, 201);
  r = await putSwitch(t, t.padmin, { enabled: true, reason: "pilot start" });
  assert.deepEqual([r.status, r.body.error], [409, "team_import_condition_unmet"]);
  assert.match(r.body.message, /backup/i);
  assert.equal((await recordPrereq(t.padmin, "backup", await dayOf(-2))).status, 201);
  r = await putSwitch(t, t.padmin, { enabled: true, reason: "pilot start" });
  assert.deepEqual([r.status, r.body.error], [409, "team_import_condition_unmet"]);
  assert.match(r.body.message, /restore probe/i, "the backup passes at 2 days; the probe is the next condition");
  // A probe of 36 days ago is too old; 35 days ago passes.
  assert.equal((await recordPrereq(t.padmin, "restore_probe", await dayOf(-36))).status, 201);
  r = await putSwitch(t, t.padmin, { enabled: true, reason: "pilot start" });
  assert.deepEqual([r.status, r.body.error], [409, "team_import_condition_unmet"]);
  assert.equal((await recordPrereq(t.padmin, "restore_probe", await dayOf(-35))).status, 201);
  r = await putSwitch(t, t.padmin, { enabled: true, reason: "pilot start" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.importSwitch.enabled, r.body.importSwitch.mode], [true, "pilot"]);
  assert.deepEqual(await switchRow(t.teamId), { enabled: true, mode: "pilot" });
  assert.deepEqual(await historyOf(t.teamId), [{ enabled: true, mode: "pilot", basis: "platform_admin" }]);
  // A record is validated: no future date, not older than 400 days, a known kind, a real date, a bounded note.
  for (const [kind, on, note] of [["backup", await dayOf(1), undefined], ["backup", await dayOf(-401), undefined], ["nope", await dayOf(0), undefined], ["backup", "2026-13-40", undefined], ["backup", "yesterday", undefined], ["backup", await dayOf(0), "x".repeat(301)]]) {
    const bad = await recordPrereq(t.padmin, kind, on, note);
    assert.equal(bad.status, 400, `${kind} ${on}: ${bad.text}`);
  }
  // Off: no condition, a reason is still required.
  assert.equal((await putSwitch(t, t.padmin, { enabled: false })).status, 400);
  assert.equal((await putSwitch(t, t.padmin, { enabled: false, reason: "   " })).status, 400);
  r = await putSwitch(t, t.padmin, { enabled: false, reason: "pause the pilot" });
  assert.deepEqual([r.status, r.body.importSwitch.enabled], [200, false]);
  assert.deepEqual((await historyOf(t.teamId)).map((h) => h.enabled), [true, false]);
  // On again (the records are still inside their windows).
  assert.equal((await putSwitch(t, t.padmin, { enabled: true, reason: "pilot resumes" })).status, 200);
});

test("2. team mode: moving a team from pilot to team needs the two recorded attestations as well; only a platform admin moves it", async () => {
  const t = gateTeam;
  let r = await putSwitch(t, t.padmin, { enabled: true, mode: "team", reason: "end of the pilot" });
  assert.deepEqual([r.status, r.body.error], [409, "team_import_condition_unmet"]);
  assert.match(r.body.message, /wrongly linked/i);
  assert.deepEqual(await switchRow(t.teamId), { enabled: true, mode: "pilot" }, "a refusal changes nothing");
  assert.equal((await recordPrereq(t.padmin, "wrong_link_procedure", await dayOf(0), "U5 procedure")).status, 201);
  r = await putSwitch(t, t.padmin, { enabled: true, mode: "team", reason: "end of the pilot" });
  assert.deepEqual([r.status, r.body.error], [409, "team_import_condition_unmet"]);
  assert.match(r.body.message, /archived/i);
  assert.equal((await recordPrereq(t.padmin, "archived_team_check_stop", await dayOf(0))).status, 201);
  r = await putSwitch(t, t.padmin, { enabled: true, mode: "team", reason: "end of the pilot" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.importSwitch.enabled, r.body.importSwitch.mode], [true, "team"]);
  // A club admin does not move the mode, in either direction.
  assert.deepEqual([(await putSwitch(t, t.cadmin, { enabled: true, mode: "pilot", reason: "back to pilot?" })).status], [403]);
  assert.deepEqual(await switchRow(t.teamId), { enabled: true, mode: "team" });
  assert.deepEqual((await historyOf(t.teamId)).map((h) => h.mode), ["pilot", "pilot", "pilot", "team"]);
});

// ---------------------------------------------------------------------------
// 3. Who may turn it on or off, and who may read it
// ---------------------------------------------------------------------------

test("3. role matrix of the switch route: platform admin; the club's admin (off always, on only in team mode, never the mode); a coach; another club's admin; a revoked role", async () => {
  const t = gateTeam; // mode team, on
  const other = await setupTeam();
  // The club's admin, in the club workspace.
  let r = await putSwitch(t, t.cadmin, { enabled: false, reason: "club pauses imports" });
  assert.deepEqual([r.status, r.body.importSwitch.enabled, r.body.importSwitch.mode], [200, false, "team"]);
  r = await putSwitch(t, t.cadmin, { enabled: true, reason: "club resumes imports" });
  assert.deepEqual([r.status, r.body.importSwitch.enabled], [200, true], "team mode: the club admin may turn on");
  assert.deepEqual((await historyOf(t.teamId)).slice(-2).map((h) => h.basis), ["club_admin", "club_admin"]);
  // A pilot-mode team: the club admin may turn it off but not on.
  assert.deepEqual([(await putSwitch(other, other.cadmin, { enabled: true, reason: "no" })).status], [403]);
  assert.equal(await switchRow(other.teamId), null);
  assert.equal((await putSwitch(other, other.cadmin, { enabled: false, reason: "keep it off" })).status, 200);
  // A coach changes nothing; sees only the state.
  assert.equal((await putSwitch(t, t.coach, { enabled: false, reason: "coach" })).status, 403);
  // Another club's admin and a coach of another team: the identical 404.
  assert.equal((await putSwitch(t, other.cadmin, { enabled: false, reason: "foreign" })).status, 404);
  assert.equal((await putSwitch(t, other.coach, { enabled: false, reason: "foreign" })).status, 404);
  assert.equal((await getSwitch(t, other.cadmin)).status, 404);
  assert.equal((await putSwitch({ teamId: "00000000-0000-0000-0000-000000000000" }, t.padmin, { enabled: false, reason: "x" })).status, 404);
  assert.deepEqual(await switchRow(t.teamId), { enabled: true, mode: "team" }, "no refusal changed the row");
  // A malformed body is a 400 and writes nothing.
  for (const body of [{}, { enabled: "yes", reason: "x" }, { enabled: true, mode: "other", reason: "x" }, { enabled: true, reason: 5 }, { enabled: true, reason: "x".repeat(501) }, { enabled: true, reason: "bad\u0007char" }]) {
    const bad = await putSwitch(t, t.padmin, body);
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
  // The reads.
  const asCoach = (await getSwitch(t, t.coach)).body.importSwitch;
  assert.deepEqual([asCoach.enabled, asCoach.mode, asCoach.canManage, asCoach.conditions, asCoach.history], [true, "team", false, undefined, undefined], "a coach sees the state, not the dates or the history");
  const asClub = (await getSwitch(t, t.cadmin)).body.importSwitch;
  assert.deepEqual([asClub.canManage, asClub.canChangeMode, asClub.canRecordPrerequisites], [true, false, false]);
  assert.equal(asClub.conditions.length, 4);
  assert.ok(asClub.conditions.every((c) => c.met === true));
  assert.ok(asClub.history.length >= 4);
  assert.ok(asClub.history.every((h) => h.reason === undefined) && asClub.reason === undefined, "a platform administrator's free-text reasons are not shown to the club admin");
  const asPlatform = (await getSwitch(t, t.padmin)).body.importSwitch;
  assert.deepEqual([asPlatform.canManage, asPlatform.canChangeMode, asPlatform.canRecordPrerequisites], [true, true, true]);
  assert.ok(asPlatform.history.every((h) => typeof h.reason === "string"));
  // A revoked club role is a 404 on the next request.
  await admin.query(`update public.user_club_roles set is_active = false where user_id = $1`, [t.cadmin.id]);
  assert.equal((await putSwitch(t, t.cadmin, { enabled: false, reason: "revoked" })).status, 404);
  await admin.query(`update public.user_club_roles set is_active = true where user_id = $1`, [t.cadmin.id]);
});

test("4. the prerequisite records are the platform's: a club admin, a coach and a user without a role get the 404; the stored note is bounded", async () => {
  const t = gateTeam;
  for (const who of [t.cadmin, t.coach]) {
    const r = await recordPrereq(who, "backup", await dayOf(0));
    assert.equal(r.status, 404, r.text);
  }
  const before = (await admin.query(`select count(*)::int as n from training_load.gpexe_import_prerequisite_records`)).rows[0].n;
  assert.equal((await recordPrereq(t.padmin, "backup", await dayOf(0), "  Supabase daily backup, checked  ")).status, 201);
  const row = (await admin.query(`select note, recorded_by_user_id from training_load.gpexe_import_prerequisite_records order by recorded_at desc limit 1`)).rows[0];
  assert.deepEqual([row.note, row.recorded_by_user_id], ["Supabase daily backup, checked", t.padmin.id]);
  assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_import_prerequisite_records`)).rows[0].n, before + 1);
});

// ---------------------------------------------------------------------------
// 5-6. Approving: both switches, and the bases
// ---------------------------------------------------------------------------

test("5. pilot mode: with the environment switch on and the team's off nothing is imported (409, the list says why); in pilot mode only a platform admin or an explicit grant approves", async () => {
  const team = await setupTeam();
  const c = await readyCandidates(team, [9101, 9102, 9103]);
  await withSwitchOn(async () => {
    // The team's switch is off (no row): the right is not the problem, the switch is.
    let r = await approve(team, team.padmin, c[9101]);
    assert.deepEqual([r.status, r.body.error], [409, "team_import_switch_off"]);
    assert.deepEqual(await approvalsOf(c[9101].id), []);
    assert.equal(await eventsOf(team.teamId), 0);
    const list = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
    assert.ok(list.every((x) => x.approvalBlockers.includes("team_import_switch_off")), "every candidate says the team's switch is off");
    // A person without any right still gets the 403, not the switch's 409.
    r = await approve(team, team.coach, c[9101]);
    assert.deepEqual([r.status, r.body.error], [403, "not_an_approver"]);
    // Pilot mode, on.
    await enableTeamImportSwitch(admin, team.teamId, null, { mode: "pilot" });
    const listOn = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
    assert.ok(listOn.every((x) => !x.approvalBlockers.includes("team_import_switch_off")));
    for (const who of [team.coach, team.cadmin]) {
      const st = (await api(`/teams/${team.teamId}/status`, { cookie: who.cookie })).body;
      assert.deepEqual([st.viewer.canApprove, st.viewer.approvalBasis], [false, null], "pilot mode: the status does not offer approving to a coach or the club admin");
      const refused = await approve(team, who, c[9101]);
      assert.deepEqual([refused.status, refused.body.error], [403, "not_an_approver"], "pilot mode: a team coach and the club admin do not approve");
    }
    const ok = await approve(team, team.padmin, c[9101]);
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await approvalsOf(c[9101].id))[0].approval_basis, "platform_admin");
    // An explicit grant stays valid in pilot mode.
    const grant = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: team.coach.id, reason: "approves GPEXE imports" } });
    assert.equal(grant.status, 201, grant.text);
    const viaGrant = await approve(team, team.coach, c[9102]);
    assert.equal(viaGrant.status, 200, viaGrant.text);
    const [row] = await approvalsOf(c[9102].id);
    assert.deepEqual([row.approval_basis, row.approver_grant_id], ["team_grant", grant.body.grant.id]);
    // The environment switch is the master: with it off nothing is imported even for a team that is on.
  });
  const off = await approve(team, team.padmin, c[9103]);
  assert.deepEqual([off.status, off.body.error], [409, "import_switch_off"]);
  assert.deepEqual(await approvalsOf(c[9103].id), []);
});

test("6. team mode: the club's admin and the team's coaches approve, each with their own basis; a coach of another team and a club admin of another club do not; the status says who can approve", async () => {
  const team = await setupTeam();
  const foreign = await setupTeam({ switchOn: true });
  const c = await readyCandidates(team, [9201, 9202, 9203]);
  await enableTeamImportSwitch(admin, team.teamId, null, { mode: "team" });
  await withSwitchOn(async () => {
    const statusOf = async (who) => (await api(`/teams/${team.teamId}/status`, { cookie: who.cookie })).body;
    assert.deepEqual([(await statusOf(team.coach)).viewer.canApprove, (await statusOf(team.coach)).viewer.approvalBasis], [true, "team_coach"]);
    assert.deepEqual([(await statusOf(team.cadmin)).viewer.canApprove, (await statusOf(team.cadmin)).viewer.approvalBasis], [true, "club_admin"]);
    assert.deepEqual((await statusOf(team.coach)).teamImportSwitch, { enabled: true, mode: "team" });
    const byClub = await approve(team, team.cadmin, c[9201]);
    assert.equal(byClub.status, 200, byClub.text);
    assert.equal((await approvalsOf(c[9201].id))[0].approval_basis, "club_admin");
    const byCoach = await approve(team, team.coach, c[9202]);
    assert.equal(byCoach.status, 200, byCoach.text);
    const [coachRow] = await approvalsOf(c[9202].id);
    assert.deepEqual([coachRow.approval_basis, coachRow.approved_by_user_id, coachRow.approver_grant_id], ["team_coach", team.coach.id, null]);
    // Not these: another team's coach and another club's admin (the route's own 404 comes first).
    for (const who of [foreign.coach, foreign.cadmin]) {
      const r = await approve(team, who, c[9203]);
      assert.equal(r.status, 404, `${who.id}: ${r.text}`);
    }
    // A coach whose role was ended: the 403/404, nothing imported.
    await admin.query(`update public.user_team_roles set is_active = false where user_id = $1`, [team.coach.id]);
    const gone = await approve(team, team.coach, c[9203]);
    assert.ok([403, 404].includes(gone.status), gone.text);
    await admin.query(`update public.user_team_roles set is_active = true where user_id = $1`, [team.coach.id]);
    assert.deepEqual(await approvalsOf(c[9203].id), []);
    // The switch off: the same people are refused with the switch's own 409.
    await enableTeamImportSwitch(admin, team.teamId, null, { mode: "team", enabled: false });
    for (const who of [team.cadmin, team.coach, team.padmin]) {
      const r = await approve(team, who, c[9203]);
      assert.deepEqual([r.status, r.body.error], [409, "team_import_switch_off"]);
    }
    assert.deepEqual(await approvalsOf(c[9203].id), []);
  });
});

// ---------------------------------------------------------------------------
// 7. Switch-off is effective at once
// ---------------------------------------------------------------------------

test("7. an approval already inside its transaction finishes on the switch it held; the off waits for it; the next approval is refused", async () => {
  const team = await setupTeam({ switchOn: true });
  const c = await readyCandidates(team, [9301, 9302]);
  await withSwitchOn(async () => {
    let off = null;
    service.setApprovalObserver(({ candidateId }) => {
      if (candidateId !== c[9301].id) return;
      // Inside the approval's transaction (the switch row is held FOR SHARE): the off is sent now, not awaited.
      off = putSwitch(team, team.padmin, { enabled: false, reason: "stop imports now" });
    });
    const r = await approve(team, team.padmin, c[9301]);
    assert.equal(r.status, 200, r.text);
    const offResult = await off;
    assert.equal(offResult.status, 200, offResult.text);
    assert.equal((await switchRow(team.teamId)).enabled, false);
    const [row] = await approvalsOf(c[9301].id);
    assert.equal(row.approval_basis, "platform_admin", "the approval that held the switch stands");
    const next = await approve(team, team.padmin, c[9302]);
    assert.deepEqual([next.status, next.body.error], [409, "team_import_switch_off"]);
    assert.deepEqual(await approvalsOf(c[9302].id), []);
  });
});

test("8. an approval waiting for the switch row while an off commits does not pass: it is refused, nothing is written", async () => {
  const team = await setupTeam({ switchOn: true });
  const c = await readyCandidates(team, [9401]);
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await withSwitchOn(async () => {
      // The off writer's position: the switch row locked FOR UPDATE, not yet committed.
      await holder.query("begin");
      await holder.query(`select 1 from training_load.gpexe_team_import_switch where owner_team_id = $1 for update`, [team.teamId]);
      let settled = false;
      const approval = approve(team, team.padmin, c[9401]).then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(settled, false, "the approval waits behind the switch row's writer");
      await holder.query(`select set_config('optimove.team_import_tx', txid_current()::text, true)`);
      await holder.query(`update training_load.gpexe_team_import_switch set enabled = false, change_reason = 'off' where owner_team_id = $1`, [team.teamId]);
      await holder.query("commit");
      const r = await approval;
      assert.deepEqual([r.status, r.body.error], [409, "team_import_switch_off"]);
      assert.deepEqual(await approvalsOf(c[9401].id), []);
      assert.equal(await eventsOf(team.teamId), 0);
      assert.equal((await admin.query(`select status from training_load.gpexe_import_candidates where id = $1`, [c[9401].id])).rows[0].status, "pending");
    });
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
});

test("9. a batch stops at the candidate where the switch turned off: the ones before stay imported, the rest are not attempted", async () => {
  const team = await setupTeam({ switchOn: true });
  const c = await readyCandidates(team, [9501, 9502, 9503]);
  const asked = [c[9501].id, c[9502].id, c[9503].id];
  const hashes = await listedHashes(team);
  await withSwitchOn(async () => {
    let off = null;
    service.setApprovalObserver(({ candidateId }) => {
      if (candidateId === c[9501].id) off = putSwitch(team, team.padmin, { enabled: false, reason: "stop the batch" });
    });
    const r = await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.padmin.cookie, body: { candidateIds: asked, previewHashes: Object.fromEntries(asked.map((id) => [id, hashes[id]])) } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await off).status, 200);
    assert.deepEqual(r.body.results.map((x) => [x.candidateId, x.outcome, x.code]), [
      [asked[0], "imported", null],
      [asked[1], "refused", "team_import_switch_off"],
      [asked[2], "not_attempted", null],
    ]);
    assert.equal(await eventsOf(team.teamId), 1);
  });
  // The batch route itself, before any candidate, with the switch off.
  await withSwitchOn(async () => {
    const r = await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [asked[2]], previewHashes: { [asked[2]]: hashes[asked[2]] } } });
    assert.deepEqual([r.status, r.body.error], [409, "team_import_switch_off"]);
  });
});

// ---------------------------------------------------------------------------
// 10. Condition 5: a running check stops when its team is archived
// ---------------------------------------------------------------------------

test("10. condition 5, through the real flow: a team archived while its check runs - the check ends without a candidate, a staged row or an import", async () => {
  const team = await setupTeam({ switchOn: true });
  src.serve(team.sourceTeamId, [cleanBundle({ sessionId: 9601, hour: 8 })]);
  let release;
  src.state.gates.list = { reached: false, p: new Promise((resolve) => { release = resolve; }) };
  try {
    const started = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: { from: D1, to: D1 } });
    assert.equal(started.status, 202, started.text);
    const checkId = started.body.check.id;
    for (let i = 0; i < 200 && !src.state.gates.list.reached; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(src.state.gates.list.reached, true, "the check reached the source's session list");
    await admin.query(`update public.teams set is_active = false where id = $1`, [team.teamId]);
    release();
    let check = null;
    for (let i = 0; i < 300; i += 1) {
      check = (await admin.query(`select status, error_code from training_load.gpexe_import_checks where id = $1`, [checkId])).rows[0];
      if (check.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(check.status, "failed", JSON.stringify(check));
    assert.ok(["team_not_available", "team_club_changed"].includes(check.error_code), `the check ended with ${check.error_code}`);
    assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_import_candidates where owner_team_id = $1`, [team.teamId])).rows[0].n, 0);
    assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_import_check_observations where owner_team_id = $1`, [team.teamId])).rows[0].n, 0);
    assert.equal(await eventsOf(team.teamId), 0);
    // And the archived team's routes are the same 404 as a missing one.
    assert.equal((await getSwitch(team, team.padmin)).status, 404);
    assert.equal((await putSwitch(team, team.padmin, { enabled: false, reason: "archived" })).status, 404);
  } finally {
    src.state.gates.list = null;
    release?.();
  }
});

// ---------------------------------------------------------------------------
// 11. Direct SQL: the tables are written only by their functions
// ---------------------------------------------------------------------------

test("11. the database refuses every write that does not come from the sanctioned function in the same transaction; rows are never deleted", async () => {
  const t = gateTeam;
  const refuse = async (sql, params, code) => {
    await admin.query("begin");
    try {
      await assert.rejects(admin.query(sql, params), (e) => { assert.equal(e.code, code, e.message); return true; });
    } finally {
      await admin.query("rollback");
    }
  };
  const sw = `insert into training_load.gpexe_team_import_switch (owner_team_id, enabled, mode, changed_by_user_id, change_reason) values ($1, true, 'team', $2, 'raw')`;
  const other = await setupTeam();
  await refuse(sw, [other.teamId, other.padmin.id], "42501");
  await refuse(`update training_load.gpexe_team_import_switch set enabled = true where owner_team_id = $1`, [t.teamId], "42501");
  await refuse(`insert into training_load.gpexe_import_prerequisite_records (kind, recorded_on, recorded_by_user_id) values ('backup', current_date, $1)`, [t.padmin.id], "42501");
  await refuse(`insert into training_load.gpexe_team_import_switch_history (owner_team_id, enabled, mode, changed_by_user_id, basis, change_reason) values ($1, true, 'team', $2, 'platform_admin', 'raw')`, [t.teamId, t.padmin.id], "42501");
  // A marker of another transaction (a session-level SET) is no marker.
  await admin.query(`select set_config('optimove.team_import_tx', '1', false)`);
  await refuse(sw, [other.teamId, other.padmin.id], "42501");
  await admin.query(`select set_config('optimove.team_import_tx', '', false)`);
  // With the marker, a delete / truncate / history update is still refused.
  await admin.query("begin");
  try {
    await admin.query(`select set_config('optimove.team_import_tx', txid_current()::text, true)`);
    await assert.rejects(admin.query(`delete from training_load.gpexe_team_import_switch where owner_team_id = $1`, [t.teamId]), (e) => e.code === "23514");
  } finally { await admin.query("rollback"); }
  await refuse(`truncate training_load.gpexe_team_import_switch`, [], "23514");
  await refuse(`truncate training_load.gpexe_import_prerequisite_records`, [], "23514");
  await refuse(`delete from training_load.gpexe_import_prerequisite_records`, [], "23514");
  for (const sql of [`update training_load.gpexe_team_import_switch_history set change_reason = 'edited'`, `update training_load.gpexe_import_prerequisite_records set note = 'edited'`]) {
    await admin.query("begin");
    try {
      await admin.query(`select set_config('optimove.team_import_tx', txid_current()::text, true)`);
      await assert.rejects(admin.query(sql), (e) => e.code === "23514");
    } finally { await admin.query("rollback"); }
  }
  // The function itself: a user without a role, a deactivated user, an archived team.
  const stranger = await makeUser("stranger");
  for (const [actor, team] of [[stranger, t.teamId], ["00000000-0000-0000-0000-000000000000", t.teamId]]) {
    await assert.rejects(admin.query(`select * from training_load.set_team_import_switch($1, $2, false, null, 'x')`, [actor, team]), (e) => e.code === "42501");
    await assert.rejects(admin.query(`select training_load.record_import_prerequisite($1, 'backup', current_date, null)`, [actor]), (e) => e.code === "42501");
  }
  await admin.query(`update public.users set is_active = false where id = $1`, [t.padmin.id]);
  await assert.rejects(admin.query(`select * from training_load.set_team_import_switch($1, $2, false, null, 'x')`, [t.padmin.id, t.teamId]), (e) => e.code === "42501");
  await admin.query(`update public.users set is_active = true where id = $1`, [t.padmin.id]);
  // The approval insert: a club_admin / team_coach basis only in team mode with the switch on.
  const pilotTeam = await setupTeam({ switchOn: true });
  const cand = await readyCandidates(pilotTeam, [9701]);
  const row = (await admin.query(`select gpexe_team_session_id, bundle_hash, preview_hash from training_load.gpexe_import_candidates where id = $1`, [cand[9701].id])).rows[0];
  const insertApproval = (userId, basis) => admin.query(
    `insert into training_load.gpexe_import_approvals (candidate_id, owner_team_id, gpexe_team_session_id, bundle_hash, preview_hash, approved_by_user_id, approval_basis, approver_grant_id, changes_to_imported, changes_accepted, metric_event_id, import_counts)
     values ($1,$2,$3,$4,$5,$6,$7,null,0,false,gen_random_uuid(),'{}')`,
    [cand[9701].id, pilotTeam.teamId, row.gpexe_team_session_id, row.bundle_hash, row.preview_hash, userId, basis]);
  await assert.rejects(insertApproval(pilotTeam.cadmin.id, "club_admin"), (e) => e.code === "42501", "pilot mode: the club admin is no approver");
  await assert.rejects(insertApproval(pilotTeam.coach.id, "team_coach"), (e) => e.code === "42501", "pilot mode: the coach is no approver");
});

// ---------------------------------------------------------------------------
// 12. Migration: preflight, post-check, rollback rehearsal
// ---------------------------------------------------------------------------

const RUNBOOK = (name) => new URL(`../../docs/runbooks/${name}`, import.meta.url);
const V56 = "migrations_v2/202611041400_training_load_v56_team_import_switch.sql";
const V54_APPROVER_MD5 = "9c3bf3edeb1dcca9c5516b77c30e86ee";

async function booleansOf(client, sql) {
  const results = [].concat(await client.query(sql));
  const out = [];
  for (const res of results) for (const row of res.rows) for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") out.push([k, v]);
  return out;
}
const approverMd5 = async (client) => (await client.query(`select md5(p.prosrc) as m from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver'`)).rows[0].m;

test("12. migration v56: the preflight passes on v54, the post-check on v56, the rollback refuses with any recorded fact and otherwise restores v54 exactly, and the migration applies again", async () => {
  // v57 (U5) sorts after v56; this rehearsal is about v56 being the last migration, so it stops there.
  const UPTO_V56 = GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("v57"));
  const withoutV56 = UPTO_V56.filter((m) => !m.includes("v56"));
  const rb = await createDb2({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "u2rb", migrations: withoutV56 });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    const { applyGpexeTestMigrations } = await import("./_gpexe-disposable-db.mjs");
    const preflight = fs.readFileSync(RUNBOOK("team-import-switch-v56-preflight.sql"), "utf8");
    const pre = await booleansOf(client, preflight);
    assert.ok(pre.length >= 10, "the preflight returned its booleans");
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok on a v54 database");
    assert.equal(await approverMd5(client), V54_APPROVER_MD5);
    await applyGpexeTestMigrations(rb.url, UPTO_V56);
    assert.notEqual(await approverMd5(client), V54_APPROVER_MD5);
    const postcheck = fs.readFileSync(RUNBOOK("team-import-switch-v56-postcheck.sql"), "utf8");
    const post = await booleansOf(client, postcheck);
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok on a v56 database");
    const newMd5 = await approverMd5(client);
    assert.match(postcheck, new RegExp(newMd5), "the post-check names the body in force");
    assert.match(fs.readFileSync(RUNBOOK("team-import-switch-v56-rollback.sql"), "utf8"), new RegExp(newMd5));
    // The rollback refuses, changing nothing, once a fact exists.
    const rollback = fs.readFileSync(RUNBOOK("team-import-switch-v56-rollback.sql"), "utf8");
    const user = (await client.query(`insert into public.users (email, full_name, display_name) values ('rb@test.local','rb','rb') returning id`)).rows[0].id;
    await client.query("begin");
    await client.query(`select set_config('optimove.team_import_tx', txid_current()::text, true)`);
    await client.query(`insert into training_load.gpexe_import_prerequisite_records (kind, recorded_on, recorded_by_user_id) values ('backup', current_date, $1)`, [user]);
    await client.query("commit");
    await assert.rejects(client.query(rollback), /v56 rollback refused: a switch row, a history row or a prerequisite record exists/);
    await client.query("rollback");
    assert.equal(await approverMd5(client), newMd5, "a refused rollback changes nothing");
    assert.equal((await client.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V56])).rows[0].n, 1);
  } finally {
    await client.end();
    await rb.drop();
  }
  // A clean database: apply -> rollback -> v54 exactly -> apply again.
  const rb2 = await createDb2({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "u2rb2", migrations: UPTO_V56 });
  const c2 = new pg.Client({ connectionString: rb2.url });
  await c2.connect();
  try {
    const { applyGpexeTestMigrations } = await import("./_gpexe-disposable-db.mjs");
    const newMd5 = await approverMd5(c2);
    await c2.query(fs.readFileSync(RUNBOOK("team-import-switch-v56-rollback.sql"), "utf8"));
    assert.equal(await approverMd5(c2), V54_APPROVER_MD5, "the v54 body is back byte for byte");
    assert.equal((await c2.query(`select to_regclass('training_load.gpexe_team_import_switch') as t`)).rows[0].t, null);
    const checkDef = (await c2.query(`select pg_get_constraintdef(c.oid) as d from pg_constraint c where c.conname = 'gpexe_import_approvals_approval_basis_check'`)).rows[0].d;
    assert.match(checkDef, /platform_admin.*team_grant/);
    assert.doesNotMatch(checkDef, /club_admin|team_coach/, "the original CHECK is back");
    assert.equal((await c2.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V56])).rows[0].n, 0);
    await applyGpexeTestMigrations(rb2.url, UPTO_V56);
    assert.equal(await approverMd5(c2), newMd5, "re-applied: the same body");
  } finally {
    await c2.end();
    await rb2.drop();
  }
});

test("13. the migration file is the one the runner reads: a unique prefix, the md5 gate on v54's body, and no code reads the environment variable for the team switch", async () => {
  const dir = new URL("../../migrations_v2/", import.meta.url);
  const names = fs.readdirSync(dir).filter((n) => n.endsWith(".sql"));
  const prefixes = names.map((n) => n.slice(0, 12));
  assert.equal(new Set(prefixes).size, prefixes.length, "migration prefixes are unique");
  const sql = fs.readFileSync(new URL("202611041400_training_load_v56_team_import_switch.sql", dir), "utf8");
  assert.match(sql, /9c3bf3edeb1dcca9c5516b77c30e86ee/);
  const svc = fs.readFileSync(new URL("../src/teamImportSwitchService.js", import.meta.url), "utf8");
  assert.doesNotMatch(svc, /GPEXE_IMPORT_APPLY_ENABLED/, "the team switch is independent of the environment's master switch");
});

test("14. a club admin's right is verified again against the team's club once the team row is locked: a team moved to another club between the two is refused (42501), nothing is written", async () => {
  // Unbound teams (a bound team cannot be moved at all - v27 guard); the move is a plain update.
  const a = await createGpexePilotOrg(admin, { athleteNames: [] });
  const b = await createGpexePilotOrg(admin, { athleteNames: [] });
  a.cadmin = await clubAdminOf(a.clubId);
  await enableTeamImportSwitch(admin, a.teamId, null, { mode: "team", enabled: true });
  const mover = new pg.Client({ connectionString: db.url });
  const caller = new pg.Client({ connectionString: db.url });
  await mover.connect();
  await caller.connect();
  try {
    // The move is held uncommitted: the function reads the old club for the basis, then waits for the team row.
    await mover.query("begin");
    await mover.query(`update public.teams set club_id = $1 where id = $2`, [b.clubId, a.teamId]);
    await caller.query("begin");
    await caller.query("set local lock_timeout = '10s'");
    const call = caller.query(`select * from training_load.set_team_import_switch($1, $2, false, null, 'race')`, [a.cadmin.id, a.teamId]).then(() => null, (e) => e);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await mover.query("commit");
    const error = await call;
    assert.ok(error && error.code === "42501", `refused with 42501, got ${error?.code}: ${error?.message}`);
    await caller.query("rollback");
    assert.equal((await switchRow(a.teamId)).enabled, true, "nothing was written");
  } finally {
    await mover.query("rollback").catch(() => {});
    await caller.query("rollback").catch(() => {});
    await mover.end();
    await caller.end();
    await admin.query(`update public.teams set club_id = $1 where id = $2`, [a.clubId, a.teamId]);
  }
});

test("15. the first write of a team is serialized: a club admin racing a platform admin's first (team-mode) write cannot leave the mode at pilot", async () => {
  const a = await createGpexePilotOrg(admin, { athleteNames: [] });
  a.cadmin = await clubAdminOf(a.clubId);
  const platformUser = gateTeam.padmin;
  const c1 = new pg.Client({ connectionString: db.url });
  const c2 = new pg.Client({ connectionString: db.url });
  await c1.connect();
  await c2.connect();
  try {
    await c1.query("begin");
    await c1.query(`select * from training_load.set_team_import_switch($1, $2, true, 'team', 'first write')`, [platformUser.id, a.teamId]);
    await c2.query("begin");
    await c2.query("set local lock_timeout = '10s'");
    const second = c2.query(`select * from training_load.set_team_import_switch($1, $2, false, null, 'club races')`, [a.cadmin.id, a.teamId]).then(() => null, (e) => e);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await c1.query("commit");
    const error = await second;
    await c2.query(error ? "rollback" : "commit");
    assert.equal((await switchRow(a.teamId)).mode, "team", `the mode stays team (second call: ${error ? error.code : "ok"})`);
  } finally {
    await c1.query("rollback").catch(() => {});
    await c2.query("rollback").catch(() => {});
    await c1.end();
    await c2.end();
  }
});

test("16. a COMMIT that gets no answer in time is an unknown outcome (503 outcome_unknown), never \"nothing was changed\"; the connection is dropped", async () => {
  const sw = await import("../src/teamImportSwitchService.js");
  const t = gateTeam;
  sw.setCommitBoundForTests(200, () => new Promise(() => {}));
  try {
    const r = await putSwitch(t, t.padmin, { enabled: true, reason: "commit never answers" });
    assert.deepEqual([r.status, r.body.error], [503, "outcome_unknown"]);
    assert.doesNotMatch(r.body.message, /Nothing was changed/);
  } finally {
    sw.setCommitBoundForTests(null, null);
  }
});

test("17. lowering the mode of a team that is already on needs no fresh backup; turning a team on, or moving it to team mode, still does", async () => {
  const fresh = await createDb2({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "u2cond", migrations: GPEXE_TEST_MIGRATIONS });
  const k = new pg.Client({ connectionString: fresh.url });
  await k.connect();
  try {
    const o = await createGpexePilotOrg(k, { athleteNames: [] });
    const pid = (await k.query(`insert into public.users (email, full_name, display_name) values ('pa@test.local','pa','pa') returning id`)).rows[0].id;
    await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [pid]);
    await enableTeamImportSwitch(k, o.teamId, pid, { mode: "team", enabled: true });
    // No backup record exists at all.
    const lower = await k.query(`select * from training_load.set_team_import_switch($1, $2, true, 'pilot', 'back to pilot')`, [pid, o.teamId]);
    assert.equal(lower.rows[0].mode, "pilot");
    await assert.rejects(k.query(`select * from training_load.set_team_import_switch($1, $2, true, 'team', 'to team')`, [pid, o.teamId]), (e) => e.code === "55000" && /condition:backup/.test(e.message));
    await k.query(`select * from training_load.set_team_import_switch($1, $2, false, null, 'off')`, [pid, o.teamId]);
    await assert.rejects(k.query(`select * from training_load.set_team_import_switch($1, $2, true, null, 'on')`, [pid, o.teamId]), (e) => e.code === "55000");
  } finally {
    await k.end();
    await fresh.drop();
  }
});

// Follow-ups of the Nezavisni revizor's review of PR #369 (L1, I1).

test("18. (L1) a club admin acting in a TEAM workspace cannot change the switch (403), and the row stays as it was", async () => {
  const t = gateTeam; // mode team, on (test 3)
  const before = await switchRow(t.teamId);
  // A team workspace is valid for a user only with a role in that team: the club admin is also a coach of it here.
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [t.cadmin.id, t.teamId]);
  await setWorkspace(t.cadmin.id, "team", t.teamId);
  try {
    const r = await putSwitch(t, t.cadmin, { enabled: false, reason: "from the team workspace" });
    assert.equal(r.status, 403, r.text);
    assert.deepEqual(await switchRow(t.teamId), before, "nothing was written");
    // The read still works there (state and mode only for a non-manager view of the route).
    assert.equal((await getSwitch(t, t.cadmin)).body.importSwitch.canManage, false);
  } finally {
    await setWorkspace(t.cadmin.id, "club", t.clubId);
    await admin.query(`delete from public.user_team_roles where user_id = $1 and team_id = $2`, [t.cadmin.id, t.teamId]);
  }
});

test("19. (I1) the approver sees the mode lowered to pilot between its unlocked peek and its FOR SHARE lock: the club admin's basis is refused with team_import_pilot_mode, nothing is written", async () => {
  const o = await createGpexePilotOrg(admin, { athleteNames: [] });
  o.cadmin = await clubAdminOf(o.clubId);
  await enableTeamImportSwitch(admin, o.teamId, null, { mode: "team", enabled: true });
  const holder = new pg.Client({ connectionString: db.url });
  const caller = new pg.Client({ connectionString: db.url });
  await holder.connect();
  await caller.connect();
  try {
    // The mode change is held uncommitted: the committed row still says 'team' for the peek.
    await holder.query("begin");
    await holder.query(`select set_config('optimove.team_import_tx', txid_current()::text, true)`);
    await holder.query(`update training_load.gpexe_team_import_switch set mode = 'pilot', change_reason = 'lowered' where owner_team_id = $1`, [o.teamId]);
    await caller.query("begin");
    await caller.query("set local lock_timeout = '10s'");
    const call = caller.query(`select * from training_load.lock_gpexe_import_approver($1, $2)`, [o.cadmin.id, o.teamId]).then((r) => ({ rows: r.rows }), (e) => ({ error: e }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    await holder.query("commit");
    const result = await call;
    assert.ok(result.error, `refused, got ${JSON.stringify(result.rows)}`);
    assert.equal(result.error.code, "55000");
    assert.match(result.error.message, /team_import_pilot_mode/);
    await caller.query("rollback");
  } finally {
    await holder.query("rollback").catch(() => {});
    await caller.query("rollback").catch(() => {});
    await holder.end();
    await caller.end();
  }
});

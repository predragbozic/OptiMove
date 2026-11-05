// U5 (J19-U5, migration v57): the in-app undo of one imported GPEXE session. Through the real server on a disposable
// database; GPEXE is the fake server3 source; the import is the real approval (batch route), so every undo here removes
// a session the real importer wrote, mapping provenance included.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "undou5" });
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

function cleanBundle({ sessionId, hour = 8, ids = [101, 102], updatedOn = "2026-09-14T20:18:09.337" }) {
  const byId = Object.fromEntries(standardAthletes().map((a) => [a.id, a]));
  const athletes = ids.map((id, i) => {
    const a = structuredClone(byId[id]);
    a.tracks = [sessionId * 10 + i];
    for (const part of a.parts) delete part.track;
    return a;
  });
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

test("1. a platform admin undoes an imported session: everything it wrote is gone, one log row and one request row exist, and the session comes back as a fresh Ready candidate", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9101);
  const before = await counts(team.teamId);
  assert.equal(before.events, 1);
  assert.ok(before.values > 0 && before.provenance > 0 && before.occasions > 0 && before.activities === 1, JSON.stringify(before));
  assert.equal(before.bindings, 1);

  const r = await undo(team, s);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const u = r.body.undo;
  assert.equal(u.replayed, false);
  assert.equal(u.eventId, s.eventId);
  assert.equal(u.offeredAgain, true);
  assert.equal(u.previewRefreshed, true);
  assert.ok(u.removedTotal > 0 && u.removedCounts.metric_events === 1 && u.removedCounts.metric_values === before.values);

  const after = await counts(team.teamId);
  assert.deepEqual([after.events, after.participants, after.occasions, after.values, after.bindings, after.activities], [0, 0, 0, 0, 0, 0]);
  assert.equal(after.provenance, 0);
  assert.equal(after.log, 1);
  assert.equal(after.requests, 1);

  const log = (await admin.query(`select * from training_load.import_deletion_log where owner_team_id = $1`, [team.teamId])).rows[0];
  assert.equal(log.event_id, s.eventId);
  assert.equal(log.deleted_by_user_id, team.padmin.id);
  assert.equal(log.authorized_via, "platform_admin");
  assert.equal(log.reason, "wrong athlete link");
  assert.equal(log.removed_total, u.removedTotal);
  assert.deepEqual(log.removed_counts, u.removedCounts);

  // The old candidate stays 'imported' as history, marked undone; the approval row is untouched.
  const old = (await admin.query(`select status, imported_at, import_undone_at, import_undone_request_id from training_load.gpexe_import_candidates where id = $1`, [s.candidateId])).rows[0];
  assert.equal(old.status, "imported");
  assert.ok(old.imported_at && old.import_undone_at && old.import_undone_request_id);
  assert.equal((await admin.query(`select count(*)::int n from training_load.gpexe_import_approvals where candidate_id = $1`, [s.candidateId])).rows[0].n, 1);

  // A fresh pending candidate of the same content, with its preview recomputed.
  const fresh = (await admin.query(`select * from training_load.gpexe_import_candidates where id = $1`, [u.newCandidateId])).rows[0];
  assert.deepEqual([fresh.status, fresh.gpexe_team_session_id, fresh.import_undone_at], ["pending", s.sessionId, null]);
  assert.equal(fresh.bundle_hash, (await admin.query(`select bundle_hash from training_load.gpexe_import_candidates where id = $1`, [s.candidateId])).rows[0].bundle_hash);
  assert.ok(fresh.preview_hash && fresh.preview);

  // The default list shows the fresh one, not the undone history; the history is behind includeSuperseded.
  const list = await listFor(team);
  assert.deepEqual(list.map((c) => [c.id, c.status]), [[u.newCandidateId, "pending"]]);
  assert.equal(list[0].importUndoneAt, null);
  const all = await listFor(team, { includeSuperseded: true });
  const history = all.find((c) => c.id === s.candidateId);
  assert.ok(history.importUndoneAt && history.approvalBlockers.includes("import_undone") && !history.approvalBlockers.includes("already_imported"));

  // The session imports again, as new data, under the current links.
  const again = await withSwitchOn(async () => api(`/teams/${team.teamId}/imports`, {
    method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [u.newCandidateId], previewHashes: { [u.newCandidateId]: list[0].previewHash } },
  }));
  assert.equal(again.body.results[0].outcome, "imported", again.text);
  assert.equal((await counts(team.teamId)).events, 1);
});

test("2. the preview shows exactly what the undo would remove and keeps nothing", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9102);
  const rowsBefore = await allRowCounts();
  const r = await api(previewPath(team, s.candidateId), { cookie: team.padmin.cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.body.undoPreview.eventId, s.eventId);
  assert.equal(r.body.undoPreview.wouldOfferAgain, true);
  assert.deepEqual(await allRowCounts(), rowsBefore, "nothing is kept: no row of any table changed");
  const real = await undo(team, s);
  assert.deepEqual(real.body.undo.removedCounts, r.body.undoPreview.removedCounts, "the preview's counts are the undo's counts");
});

test("3. a replay of the same request answers the saved outcome; the same key with another reason is request_key_reused; a new key on an undone import is already_undone", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9103);
  const requestKey = key();
  const first = await undo(team, s, { requestKey });
  assert.equal(first.status, 200, first.text);
  const rowsAfterFirst = await allRowCounts();
  const replay = await undo(team, s, { requestKey });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.body.undo.replayed, true);
  for (const k of ["eventId", "deletionLogId", "removedTotal", "newCandidateId"]) assert.equal(replay.body.undo[k], first.body.undo[k], k);
  assert.deepEqual(replay.body.undo.removedCounts, first.body.undo.removedCounts);
  assert.deepEqual(await allRowCounts(), rowsAfterFirst, "a replay writes nothing");
  const reused = await undo(team, s, { requestKey, reason: "another reason" });
  assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"]);
  const again = await undo(team, s, { requestKey: key() });
  assert.deepEqual([again.status, again.body.error], [409, "already_undone"]);
  assert.deepEqual(await allRowCounts(), rowsAfterFirst);
});

test("4. only an active platform admin reaches the undo; everyone else gets the identical 404 (preview and undo)", async () => {
  const team = await setupTeam();
  const other = await setupTeam();
  const s = await importSession(team, 9104);
  const missing = await api(undoPath(team, crypto.randomUUID()), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "x" } });
  assert.equal(missing.status, 404);
  const padminInTeam = await platformAdmin();
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [padminInTeam.id, team.teamId]);
  await setWorkspace(padminInTeam.id, "team", team.teamId);
  const foreign = await importSession(other, 9105);
  const rowsBefore = await allRowCounts();
  const outsiders = {
    coach: team.coach.cookie,
    clubAdmin: team.cadmin.cookie,
    otherTeamCoach: other.coach.cookie,
    anonymous: null,
  };
  for (const [who, cookie] of Object.entries(outsiders)) {
    const post = await undo(team, s, { cookie });
    const get = await api(previewPath(team, s.candidateId), { cookie });
    if (who === "anonymous") { assert.deepEqual([post.status, get.status], [401, 401], who); continue; }
    assert.deepEqual([post.status, post.text], [404, missing.text], `${who} POST`);
    assert.deepEqual([get.status, get.text], [404, missing.text], `${who} GET`);
  }
  // A platform admin in a team workspace, and a malformed id.
  const inTeam = await undo(team, s, { cookie: padminInTeam.cookie });
  assert.deepEqual([inTeam.status, inTeam.text], [404, missing.text]);
  const bad = await api(`/teams/${team.teamId}/candidates/not-a-uuid/undo-import`, { method: "POST", cookie: team.padmin.cookie, body: {} });
  assert.deepEqual([bad.status, bad.text], [404, missing.text]);
  // A candidate of another team through this team's route.
  const cross = await undo(team, foreign);
  assert.deepEqual([cross.status, cross.text], [404, missing.text]);
  assert.deepEqual(await allRowCounts(), rowsBefore, "no refusal wrote anything");
  assert.equal((await counts(team.teamId)).events, 1);
});

test("5. a role revoked before the call is the same 404 and writes nothing", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9106);
  const revoked = await platformAdmin();
  await admin.query(`update public.user_global_roles set is_active = false where user_id = $1`, [revoked.id]);
  const inactiveUser = await platformAdmin();
  await admin.query(`update public.users set is_active = false where id = $1`, [inactiveUser.id]);
  const rowsBefore = await allRowCounts();
  const r = await undo(team, s, { cookie: revoked.cookie });
  assert.equal(r.status, 404);
  const r2 = await undo(team, s, { cookie: inactiveUser.cookie });
  assert.ok([401, 404].includes(r2.status), `inactive user: ${r2.status}`);
  assert.deepEqual(await allRowCounts(), rowsBefore);
});

test("6. the request body is checked before anything is locked: key, reason, expected event", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9107);
  const rowsBefore = await allRowCounts();
  for (const [name, body] of [
    ["no key", { reason: "x", expected: { eventId: s.eventId } }],
    ["key not a uuid", { requestKey: "abc", reason: "x" }],
    ["no reason", { requestKey: key() }],
    ["blank reason", { requestKey: key(), reason: "   " }],
    ["long reason", { requestKey: key(), reason: "x".repeat(501) }],
    ["control character", { requestKey: key(), reason: "a\u0007b" }],
    ["expected event not a uuid", { requestKey: key(), reason: "x", expected: { eventId: "nope" } }],
  ]) {
    const r = await api(undoPath(team, s.candidateId), { method: "POST", cookie: team.padmin.cookie, body });
    assert.deepEqual([name, r.status, r.body.error], [name, 400, "invalid_request"]);
  }
  const wrong = await undo(team, s, { expected: { eventId: crypto.randomUUID() } });
  assert.deepEqual([wrong.status, wrong.body.error], [409, "event_mismatch"]);
  assert.deepEqual(await allRowCounts(), rowsBefore);
});

test("7. a pending candidate, a superseded one and a candidate of nothing imported cannot be undone", async () => {
  const team = await setupTeam();
  await checkNow(team, [cleanBundle({ sessionId: 9108 })]);
  const pending = (await listFor(team))[0];
  const rowsBefore = await allRowCounts();
  const r = await api(undoPath(team, pending.id), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "x" } });
  assert.deepEqual([r.status, r.body.error], [409, "candidate_not_imported"]);
  assert.deepEqual(await allRowCounts(), rowsBefore);
});

test("8. refusals: coach roster work, a calendar link, a hand-corrected value - each names what to do, nothing is removed, every protection is intact", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9109);
  const rowsBefore = await allRowCounts();

  // Roster work: a coach states that an unmeasured athlete did not take part.
  const roster = await fetch(`${apiBase}/api/training-activity/${s.activityId}/roster`, { headers: { Cookie: team.coach.cookie } });
  assert.equal(roster.status, 200, await roster.clone().text());
  const rosterBody = await roster.json();
  const needing = rosterBody.athletes.find((a) => a.group === "needs_state");
  assert.ok(needing, `an athlete who needs a state: ${JSON.stringify(rosterBody.athletes.map((a) => a.group))}`);
  const put = await fetch(`${apiBase}/api/training-activity/${s.activityId}/roster/${needing.athleteId}/decision`, {
    method: "PUT", headers: { "Content-Type": "application/json", Cookie: team.coach.cookie },
    body: JSON.stringify({ kind: "participated_no_values", expectedDecisionId: null, requestKey: key() }),
  });
  assert.equal(put.status, 200, await put.text());
  const afterRoster = await allRowCounts();
  const blockedRoster = await undo(team, s);
  assert.deepEqual([blockedRoster.status, blockedRoster.body.error], [409, "roster_decisions_exist"]);
  assert.ok(blockedRoster.body.rosterWork.decisions >= 1);
  assert.match(blockedRoster.body.message, /roster/);
  assert.deepEqual(await allRowCounts(), afterRoster);
  assert.notDeepEqual(afterRoster, rowsBefore, "the coach's decision is real data");
  assert.equal((await counts(team.teamId)).events, 1);
});

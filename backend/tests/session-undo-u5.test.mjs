// U5 (J19-U5, migration v57): the in-app undo of one imported GPEXE session. Through the real server on a disposable
// database; GPEXE is the fake server3 source; the import is the real approval (batch route), so every undo here removes
// a session the real importer wrote, mapping provenance included.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
// This suite pins v60 as the last migration (its rollback tests need that); later migrations (v61, J20-C) have their own suites.
const UP_TO_V60 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes("v60_undo_roster_work")) + 1);
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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "undou5", migrations: UP_TO_V60.filter((m) => !m.includes("app_error_events")) }); // everything but the error-tracking migration (it would record test 19's injected 500 as a row): the approval writes v59 columns, so v57 is no longer the last migration here (tests 20 and 22 keep their own v56/v57 slices)
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
  assert.deepEqual(u.undoneCandidateIds, [s.candidateId]);
  assert.equal(u.offeredAgain, true);
  assert.equal(u.previewReady, true);
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

test("7. a pending candidate and a superseded one cannot be undone", async () => {
  const team = await setupTeam();
  await checkNow(team, [cleanBundle({ sessionId: 9108 })]);
  const pending = (await listFor(team))[0];
  const rowsBefore = await allRowCounts();
  const r = await api(undoPath(team, pending.id), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "x" } });
  assert.deepEqual([r.status, r.body.error], [409, "candidate_not_imported"]);
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  await admin.query(`update training_load.gpexe_import_candidates set status = 'superseded', superseded_by_check_id = last_seen_check_id where id = $1`, [pending.id]);
  await admin.query("commit");
  const sup = await api(undoPath(team, pending.id), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "x" } });
  assert.deepEqual([sup.status, sup.body.error], [409, "candidate_not_imported"]);
  assert.deepEqual(await allRowCounts(), rowsBefore);
});

test("8. coach roster work after the import (v60, O1): the undo asks for a confirmation of the listed changes and removes nothing without it", async () => {
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
  assert.deepEqual([blockedRoster.status, blockedRoster.body.error], [409, "roster_work_needs_confirmation"]);
  assert.ok(blockedRoster.body.rosterWork.laterWork.decisions >= 1);
  assert.match(blockedRoster.body.message, /attendance/);
  assert.deepEqual(await allRowCounts(), afterRoster);
  assert.notDeepEqual(afterRoster, rowsBefore, "the coach's decision is real data");
  assert.equal((await counts(team.teamId)).events, 1);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function newClient() {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  return c;
}

test("9. a calendar link on the session's activity refuses the undo and says what to remove", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9110);
  const typeId = (await admin.query(`select id from calendar.event_types limit 1`)).rows[0].id;
  // The calendar's own commands write an event with its request, change and target rows; this suite only needs the link, so
  // the event is inserted with the table's user triggers off (the table owner may) and they are switched on again at once.
  await admin.query("begin");
  await admin.query(`alter table calendar.events disable trigger user`);
  const eventId = (await admin.query(
    `insert into calendar.events (owner_scope, owner_team_id, event_type_id, title, day, timezone, created_by_user_id)
     values ('team', $1, $2, 'Match day', '2026-09-14', 'Europe/Sarajevo', $3) returning id`,
    [team.teamId, typeId, team.padmin.id],
  )).rows[0].id;
  await admin.query(`alter table calendar.events enable trigger user`);
  await admin.query("commit");
  await admin.query(`insert into calendar.event_activity_links (event_id, activity_id, linked_by_user_id) values ($1, $2, $3)`, [eventId, s.activityId, team.padmin.id]);
  const rowsBefore = await allRowCounts();
  const preview = await api(previewPath(team, s.candidateId), { cookie: team.padmin.cookie });
  assert.deepEqual([preview.status, preview.body.error], [409, "calendar_link_exists"]);
  const r = await undo(team, s);
  assert.deepEqual([r.status, r.body.error, r.body.calendarLinks], [409, "calendar_link_exists", 1]);
  assert.match(r.body.message, /calendar event/);
  assert.deepEqual(await allRowCounts(), rowsBefore);
  assert.equal((await counts(team.teamId)).events, 1);
});

test("10. outside the function every protected row stays protected; the marker is true only inside its transaction", async () => {
  const team = await setupTeam();
  const s1 = await importSession(team, 9111);
  const s2 = await importSession(team, 9112, { hour: 10 });
  const raw = async (sql, params = []) => {
    const c = await newClient();
    try {
      await c.query("begin");
      try { await c.query(sql, params); return { ok: true }; } catch (error) { return { ok: false, code: error.code, message: error.message }; }
      finally { await c.query("rollback").catch(() => {}); }
    } finally { await c.end(); }
  };
  const refusedRaw = [
    ["metric_values", `delete from training_load.metric_values where id = (select id from training_load.metric_values limit 1)`, /immutable row/],
    ["bindings", `delete from training_load.metric_event_source_bindings where event_id = $1`, /immutable and cannot be deleted/],
    ["provenance", `delete from training_load.metric_value_source_provenance where metric_value_id = (select id from training_load.metric_values limit 1)`, /append-only/],
    ["candidate (imported)", `delete from training_load.gpexe_import_candidates where id = $1`, /never deleted/],
  ];
  for (const [name, sql, re] of refusedRaw) {
    const r = await raw(sql, name === "bindings" ? [s1.eventId] : name.startsWith("candidate") ? [s1.candidateId] : []);
    assert.equal(r.ok, false, `${name} is refused without the function`);
    assert.match(r.message, re, name);
  }
  // A session-level marker set in an EARLIER transaction never satisfies the check.
  const c = await newClient();
  try {
    await c.query(`select set_config('optimove.session_undo_tx', txid_current()::text, false)`);
    await assert.rejects(c.query(`delete from training_load.metric_values where id = (select id from training_load.metric_values limit 1)`), /immutable row/);
    await assert.rejects(c.query(`delete from training_load.metric_event_source_bindings where event_id = $1`, [s1.eventId]), /immutable and cannot be deleted/);
    assert.equal((await c.query(`select training_load.session_undo_marker_ok() ok`)).rows[0].ok, false);
  } finally { await c.end(); }
  // Inside the function's transaction the marker is on while it runs and OFF again when it returns: a statement after the
  // call, in the same transaction, is refused (nothing of session 2 can be deleted on its coattails).
  const t = await newClient();
  try {
    await t.query("begin");
    await t.query("select set_config('lock_timeout','5s',true)");
    const out = (await t.query(`select * from training_load.undo_imported_session($1, $2, $3, $4, 'raw call', null)`, [team.padmin.id, team.teamId, s1.candidateId, key()])).rows[0];
    assert.equal(out.replayed, false);
    assert.equal((await t.query(`select training_load.session_undo_marker_ok() ok`)).rows[0].ok, false, "the marker is off after the call");
    await assert.rejects(t.query(`delete from training_load.metric_event_source_bindings where event_id = $1`, [s2.eventId]), /immutable and cannot be deleted/);
    await t.query("rollback");
  } finally { await t.end(); }
  assert.equal((await counts(team.teamId)).events, 2, "the rolled-back call kept nothing");
});

test("11. the observations trigger: a DELETE passes only under the marker, an UPDATE never", async () => {
  const c = await newClient();
  try {
    await c.query("begin");
    await c.query(`create temp table obs (id uuid primary key default gen_random_uuid(), activity_id uuid, athlete_id uuid, source_connection_id uuid,
      kind text, reason_code text, observed_at timestamptz, adapter_ref text, resolved_at timestamptz)`);
    await c.query(`create trigger activity_source_observations_append_only before update or delete on obs for each row execute function training.protect_activity_source_observation_v57()`);
    await c.query(`insert into obs (activity_id) values (gen_random_uuid())`);
    const refused = async (sql, re) => {
      await c.query("savepoint s");
      await assert.rejects(c.query(sql), re);
      await c.query("rollback to savepoint s");
    };
    await refused(`delete from obs`, /removed only by the undo of its import/);
    await refused(`update obs set resolved_at = null`, /only resolved, once/);
    await c.query(`select set_config('optimove.session_undo_tx', txid_current()::text, true)`);
    assert.equal((await c.query(`delete from obs`)).rowCount, 1);
    await c.query(`insert into obs (activity_id) values (gen_random_uuid())`);
    await refused(`update obs set resolved_at = null`, /only resolved, once/);
    await c.query("rollback");
  } finally { await c.end(); }
});

test("12. the candidate guard: undone columns are set once, only under the marker, only on an imported row", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9113);
  await checkNow(team, [cleanBundle({ sessionId: 9114, hour: 11 })]);
  const pending = (await listFor(team)).find((c) => c.gpexeTeamSessionId === "9114");
  const bad = async (sql, params, re) => {
    const c = await newClient();
    try { await assert.rejects(c.query(sql, params), re); } finally { await c.end(); }
  };
  const fakeReq = crypto.randomUUID();
  await bad(`update training_load.gpexe_import_candidates set import_undone_at = now(), import_undone_request_id = $2 where id = $1`, [s.candidateId, fakeReq], (e) => e.code === "42501");
  await bad(`update training_load.gpexe_import_candidates set import_undone_at = now() where id = $1`, [s.candidateId], (e) => e.code === "42501");
  await bad(`update training_load.gpexe_import_candidates set import_undone_at = now(), import_undone_request_id = $2 where id = $1`, [pending.id, fakeReq], (e) => /only an imported candidate can be undone|violates check/.test(e.message));
  // Even under a forged marker in its own transaction the request must exist (the deferred foreign key).
  const forged = await newClient();
  try {
    await forged.query("begin");
    await forged.query(`select set_config('optimove.session_undo_tx', txid_current()::text, true)`);
    await forged.query(`update training_load.gpexe_import_candidates set import_undone_at = now(), import_undone_request_id = $2 where id = $1`, [s.candidateId, fakeReq]);
    await assert.rejects(forged.query("commit"), (e) => e.code === "23503");
  } finally { await forged.end(); }
  await bad(`insert into training_load.gpexe_import_candidates (owner_team_id, gpexe_team_session_id, bundle_hash, raw_expires_at, status, first_seen_check_id, last_seen_check_id, import_undone_at, import_undone_request_id)
             select owner_team_id, '1', repeat('a', 64), now(), 'imported', first_seen_check_id, last_seen_check_id, now(), $2 from training_load.gpexe_import_candidates where id = $1`, [s.candidateId, fakeReq], (e) => true);
  const done = await undo(team, s);
  assert.equal(done.status, 200, done.text);
  await bad(`update training_load.gpexe_import_candidates set import_undone_at = null, import_undone_request_id = null where id = $1`, [s.candidateId], /final|violates check/);
  await bad(`delete from training_load.gpexe_import_candidates where id = $1`, [s.candidateId], /never deleted/);
  await bad(`update training_load.gpexe_import_candidates set status = 'pending', imported_at = null where id = $1`, [s.candidateId], /violates check|final/);
});

test("13. the request record is append-only and written only by the function", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9115);
  const r = await undo(team, s);
  assert.equal(r.status, 200, r.text);
  const bad = async (sql, params, code) => {
    const c = await newClient();
    try { await assert.rejects(c.query(sql, params), (e) => [].concat(code).includes(e.code), sql); } finally { await c.end(); }
  };
  await bad(`update training_load.gpexe_session_undo_requests set reason = 'edited'`, [], "23514");
  await bad(`delete from training_load.gpexe_session_undo_requests`, [], "23514");
  // A foreign key from the candidates makes PostgreSQL refuse TRUNCATE itself (0A000); the guard trigger is the second line.
  await bad(`truncate training_load.gpexe_session_undo_requests`, [], ["0A000", "23514"]);
  await bad(`insert into training_load.gpexe_session_undo_requests (requested_by_user_id, request_key, request_hash, owner_team_id, candidate_id, event_id, deletion_log_id, reason, removed_counts, removed_total)
             select requested_by_user_id, gen_random_uuid(), request_hash, owner_team_id, candidate_id, event_id, deletion_log_id, reason, removed_counts, removed_total from training_load.gpexe_session_undo_requests`, [], "42501");
  // The deletion log stays append-only too.
  await bad(`delete from training_load.import_deletion_log`, [], "P0001");
});

test("14. an expired snapshot is not offered again; the next search then writes the candidate the normal way; a search after an offered-again undo adds no duplicate", async () => {
  const team = await setupTeam();
  const gone = await importSession(team, 9116);
  await admin.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 hour' where id = $1`, [gone.candidateId]);
  const r = await undo(team, gone);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.undo.offeredAgain, r.body.undo.newCandidateId], [false, null]);
  assert.deepEqual((await listFor(team)).filter((c) => c.gpexeTeamSessionId === "9116"), [], "nothing is listed until the next search");
  await checkNow(team, [cleanBundle({ sessionId: 9116 })]);
  const next = (await listFor(team)).filter((c) => c.gpexeTeamSessionId === "9116");
  assert.deepEqual(next.map((c) => c.status), ["pending"], "the next search writes a fresh pending candidate through the normal path");

  const kept = await importSession(team, 9117, { hour: 10 });
  const k = await undo(team, kept);
  assert.equal(k.body.undo.offeredAgain, true);
  const before = (await admin.query(`select count(*)::int n from training_load.gpexe_import_candidates where owner_team_id = $1 and gpexe_team_session_id = '9117'`, [team.teamId])).rows[0].n;
  await checkNow(team, [cleanBundle({ sessionId: 9117, hour: 10 })]);
  const after = (await admin.query(`select count(*)::int n from training_load.gpexe_import_candidates where owner_team_id = $1 and gpexe_team_session_id = '9117'`, [team.teamId])).rows[0].n;
  assert.equal(after, before, "the same content seen again refreshes the offered candidate, no duplicate");
  const live = await listFor(team);
  assert.equal(live.filter((c) => c.gpexeTeamSessionId === "9117").length, 1);
  assert.equal(live.find((c) => c.gpexeTeamSessionId === "9117").id, k.body.undo.newCandidateId);
});

test("15. the undone import can be neither approved by id nor in a batch", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9118);
  const u = await undo(team, s);
  assert.equal(u.status, 200, u.text);
  await withSwitchOn(async () => {
    const single = await api(`/teams/${team.teamId}/candidates/${s.candidateId}/approve`, { method: "POST", cookie: team.padmin.cookie, body: { previewHash: s.previewHash } });
    assert.deepEqual([single.status, single.body.error], [409, "import_undone"]);
    const batch = await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [s.candidateId], previewHashes: { [s.candidateId]: s.previewHash } } });
    assert.equal(batch.status, 200, batch.text);
    assert.deepEqual([batch.body.results[0].outcome, batch.body.results[0].code], ["refused", "import_undone"]);
  });
  assert.equal((await counts(team.teamId)).events, 0);
});

test("16. an import of the same team and an undo wait for each other, in both orders, and both finish", async () => {
  const team = await setupTeam();
  const s1 = await importSession(team, 9119);
  await checkNow(team, [cleanBundle({ sessionId: 9120, hour: 10 })]);
  const second = (await listFor(team)).find((c) => c.gpexeTeamSessionId === "9120");
  const approve = () => withSwitchOn(() => api(`/teams/${team.teamId}/imports`, {
    method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [second.id], previewHashes: { [second.id]: second.previewHash } },
  }));
  // (a) the undo holds the team lock until released; the approval waits.
  let release; const hold = new Promise((r) => { release = r; });
  let reached; const reachedP = new Promise((r) => { reached = r; });
  undoService.setUndoBeforeCommitForTests(async () => { reached(); await hold; });
  try {
    const undoP = undo(team, s1);
    await reachedP;
    let approved = false;
    const approveP = approve().then((r) => { approved = true; return r; });
    await sleep(600);
    assert.equal(approved, false, "the approval waits for the undo");
    release();
    const [u, a] = await Promise.all([undoP, approveP]);
    assert.equal(u.status, 200, u.text);
    assert.equal(a.body.results[0].outcome, "imported", a.text);
  } finally { undoService.setUndoBeforeCommitForTests(null); }
  // (b) an approval holds the team lock; the undo waits.
  const s3 = await importSession(team, 9121, { hour: 12 });
  await checkNow(team, [cleanBundle({ sessionId: 9122, hour: 14 })]);
  const fourth = (await listFor(team)).find((c) => c.gpexeTeamSessionId === "9122");
  let release2; const hold2 = new Promise((r) => { release2 = r; });
  let reached2; const reached2P = new Promise((r) => { reached2 = r; });
  service.setApprovalObserver(async () => { reached2(); await hold2; });
  try {
    const approveP = withSwitchOn(() => api(`/teams/${team.teamId}/imports`, {
      method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [fourth.id], previewHashes: { [fourth.id]: fourth.previewHash } },
    }));
    await reached2P;
    let undone = false;
    const undoP = undo(team, s3).then((r) => { undone = true; return r; });
    await sleep(600);
    assert.equal(undone, false, "the undo waits for the approval");
    release2();
    const [a, u] = await Promise.all([approveP, undoP]);
    assert.equal(a.body.results[0].outcome, "imported", a.text);
    assert.equal(u.status, 200, u.text);
  } finally { service.setApprovalObserver(null); }
});

test("17. two undos of the same import at once: exactly one removes it, the other is already_undone; a revocation in either order never deadlocks", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9123);
  const [x, y] = await Promise.all([undo(team, s), undo(team, s)]);
  const outcomes = [x, y].map((r) => [r.status, r.body.error ?? "ok"]).sort();
  assert.deepEqual(outcomes, [[200, "ok"], [409, "already_undone"]]);
  assert.equal((await counts(team.teamId)).log, 1);

  // A revocation that already holds the user row and then revokes the role: the undo waits, then is the identical 404.
  const t2 = await setupTeam();
  const s2 = await importSession(t2, 9124);
  const victim = await platformAdmin();
  const rev = await newClient();
  try {
    await rev.query("begin");
    await rev.query(`select 1 from public.users where id = $1 for update`, [victim.id]);
    const waiting = undo(t2, s2, { cookie: victim.cookie });
    await sleep(500);
    await rev.query(`update public.user_global_roles set is_active = false where user_id = $1`, [victim.id]);
    await rev.query("commit");
    const r = await waiting;
    assert.equal(r.status, 404, r.text);
  } finally { await rev.end(); }
  assert.equal((await counts(t2.teamId)).events, 1);

  // The other order: the undo holds its shares; the revocation waits for it and the undo succeeds whole.
  const t3 = await setupTeam();
  const s3 = await importSession(t3, 9125);
  let release; const hold = new Promise((r) => { release = r; });
  let reached; const reachedP = new Promise((r) => { reached = r; });
  undoService.setUndoBeforeCommitForTests(async () => { reached(); await hold; });
  try {
    const undoP = undo(t3, s3);
    await reachedP;
    const rev2 = await newClient();
    try {
      await rev2.query("begin");
      await rev2.query("set local lock_timeout = '10s'");
      let revoked = false;
      const revoking = rev2.query(`update public.users set is_active = false where id = $1`, [t3.padmin.id]).then(() => { revoked = true; });
      await sleep(500);
      assert.equal(revoked, false, "the revocation waits for the undo's share lock");
      release();
      const r = await undoP;
      assert.equal(r.status, 200, r.text);
      await revoking;
      await rev2.query("commit");
    } finally { await rev2.end(); }
  } finally { undoService.setUndoBeforeCommitForTests(null); }
});

test("18. an unanswered COMMIT is outcome_unknown; repeating the same request returns what the first one did", async () => {
  const team = await setupTeam();
  // (a) the COMMIT reaches the server, the answer is lost: the repeat replays the saved outcome.
  const a = await importSession(team, 9126);
  const keyA = key();
  undoService.setUndoCommitBoundForTests(100, async (client) => { await client.query("commit"); await new Promise(() => {}); });
  try {
    const lost = await undo(team, a, { requestKey: keyA });
    assert.deepEqual([lost.status, lost.body.error, lost.body.retrySameRequest], [503, "outcome_unknown", true]);
  } finally { undoService.setUndoCommitBoundForTests(null); }
  const replay = await undo(team, a, { requestKey: keyA });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.body.undo.replayed, true);
  assert.equal((await counts(team.teamId)).events, 0);
  // (b) the COMMIT never reaches the server (the connection is dropped): the repeat does the undo.
  const b = await importSession(team, 9127, { hour: 10 });
  const keyB = key();
  undoService.setUndoCommitBoundForTests(100, async () => { await new Promise(() => {}); });
  try {
    const lost = await undo(team, b, { requestKey: keyB });
    assert.deepEqual([lost.status, lost.body.error], [503, "outcome_unknown"]);
  } finally { undoService.setUndoCommitBoundForTests(null); }
  const events = (await counts(team.teamId)).events;
  assert.equal(events, 1, "nothing was removed by the dropped COMMIT");
  const redo = await undo(team, b, { requestKey: keyB });
  assert.equal(redo.status, 200, redo.text);
  assert.equal(redo.body.undo.replayed, false);
  // (c) the connection dies during the COMMIT (an error without a SQLSTATE): never a plain 500 - the outcome is unknown.
  const c = await importSession(team, 9137, { hour: 12 });
  const keyC = key();
  undoService.setUndoCommitBoundForTests(5000, async (client) => { await client.query("commit"); throw new Error("Connection terminated unexpectedly"); });
  try {
    const lost = await undo(team, c, { requestKey: keyC });
    assert.deepEqual([lost.status, lost.body.error, lost.body.retrySameRequest], [503, "outcome_unknown", true]);
  } finally { undoService.setUndoCommitBoundForTests(null); }
  const replayC = await undo(team, c, { requestKey: keyC });
  assert.deepEqual([replayC.status, replayC.body.undo?.replayed], [200, true], "the COMMIT had reached the server: the repeat returns what it did");
  // (d) an explicit PostgreSQL error answer to COMMIT does say the undo did not happen.
  const d = await importSession(team, 9138, { hour: 14 });
  undoService.setUndoCommitBoundForTests(5000, async () => { throw Object.assign(new Error("deferred constraint"), { code: "23503" }); });
  try {
    const refused = await undo(team, d);
    assert.notEqual(refused.body.error, "outcome_unknown");
  } finally { undoService.setUndoCommitBoundForTests(null); }
});

test("19. a failure at the last step (the request insert), after the removal and the log row, rolls the whole call back; a second call with the same key in one transaction replays", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9128);
  const rowsBefore = await allRowCounts();
  await admin.query(`create or replace function public.u5_fail() returns trigger as $$ begin raise exception 'u5 injected failure' using errcode = 'XX999'; end; $$ language plpgsql`);
  await admin.query(`create trigger u5_fail_t before insert on training_load.gpexe_session_undo_requests for each row execute function public.u5_fail()`);
  try {
    const r = await undo(team, s);
    assert.equal(r.status, 500, r.text);
  } finally {
    await admin.query(`drop trigger u5_fail_t on training_load.gpexe_session_undo_requests`);
    await admin.query(`drop function public.u5_fail()`);
  }
  assert.deepEqual(await allRowCounts(), rowsBefore, "the removal, the log row and the candidate mark were all rolled back");
  assert.equal((await counts(team.teamId)).events, 1);
  const c = await newClient();
  try {
    await c.query("begin");
    await c.query("select set_config('lock_timeout','5s',true)");
    const k = key();
    const one = (await c.query(`select * from training_load.undo_imported_session($1,$2,$3,$4,'twice',null)`, [team.padmin.id, team.teamId, s.candidateId, k])).rows[0];
    const two = (await c.query(`select * from training_load.undo_imported_session($1,$2,$3,$4,'twice',null)`, [team.padmin.id, team.teamId, s.candidateId, k])).rows[0];
    assert.deepEqual([one.replayed, two.replayed, two.deletion_log_id], [false, true, one.deletion_log_id]);
    await c.query("rollback");
  } finally { await c.end(); }
  assert.deepEqual(await allRowCounts(), rowsBefore);
});

// ---------------------------------------------------------------------------
// Migration: preflight, post-check, rollback rehearsal, the md5 gate
// ---------------------------------------------------------------------------
const RUNBOOK = (name) => new URL(`../../docs/runbooks/${name}`, import.meta.url);
const V57 = "migrations_v2/202611051000_training_load_v57_session_undo.sql";

async function booleansOf(client, sql) {
  const results = [].concat(await client.query(sql));
  const out = [];
  for (const res of results) for (const row of res.rows) for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") out.push([k, v]);
  return out;
}

// The catalog facts the rollback must restore exactly.
async function catalogOf(client) {
  const triggers = (await client.query(
    `select c.relname || '.' || t.tgname || ' :: ' || pg_get_triggerdef(t.oid) as d from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname in ('gpexe_import_candidates', 'metric_values', 'metric_event_source_bindings', 'metric_value_source_provenance', 'activity_source_observations')
        and not t.tgisinternal order by 1`)).rows.map((r) => r.d);
  const constraints = (await client.query(
    `select conname || ' :: ' || pg_get_constraintdef(oid) as d from pg_constraint where conrelid = 'training_load.gpexe_import_candidates'::regclass order by 1`)).rows.map((r) => r.d);
  const columns = (await client.query(
    `select column_name || ' ' || data_type as d from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_candidates' order by ordinal_position`)).rows.map((r) => r.d);
  const indexes = (await client.query(`select indexdef as d from pg_indexes where schemaname = 'training_load' and tablename = 'gpexe_import_candidates' order by 1`)).rows.map((r) => r.d);
  const functions = (await client.query(
    `select n.nspname || '.' || p.proname || ' ' || md5(p.prosrc) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('training_load', 'training') order by 1`)).rows.map((r) => r.d);
  return { triggers, constraints, columns, indexes, functions };
}

test("20. migration v57: the preflight passes on v56, the post-check on v57, the rollback restores v56 exactly (catalog identical) and refuses once an undo exists, and the migration applies again", async () => {
  const withoutV57 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes("v57")));
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "u5rb", migrations: withoutV57 });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  let v56Catalog;
  try {
    const pre = await booleansOf(client, fs.readFileSync(RUNBOOK("session-undo-v57-preflight.sql"), "utf8"));
    assert.ok(pre.length >= 18, `the preflight returned its booleans (${pre.length})`);
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok on a v56 database");
    v56Catalog = await catalogOf(client);
    await applyGpexeTestMigrations(rb.url, GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((x) => x.includes("v57")) + 1));
    const post = await booleansOf(client, fs.readFileSync(RUNBOOK("session-undo-v57-postcheck.sql"), "utf8"));
    assert.ok(post.length >= 18, `the post-check returned its booleans (${post.length})`);
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok on a v57 database");
    // The post-check and the rollback name the bodies in force.
    const bodies = (await client.query(`select md5(p.prosrc) m from pg_proc p where p.proname in ('undo_imported_session', 'session_undo_scope', 'protect_gpexe_import_candidate_v57')`)).rows.map((r) => r.m);
    for (const m of bodies) {
      assert.match(fs.readFileSync(RUNBOOK("session-undo-v57-postcheck.sql"), "utf8"), new RegExp(m));
      assert.match(fs.readFileSync(RUNBOOK("session-undo-v57-rollback.sql"), "utf8"), new RegExp(m));
    }
    assert.notDeepEqual(await catalogOf(client), v56Catalog);
    // A clean rollback restores the v56 catalog exactly, and the migration applies again to the same result.
    const v57Catalog = await catalogOf(client);
    await client.query(fs.readFileSync(RUNBOOK("session-undo-v57-rollback.sql"), "utf8"));
    assert.deepEqual(await catalogOf(client), v56Catalog, "the rollback restores the v56 catalog exactly");
    assert.equal((await client.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V57])).rows[0].n, 0);
    await applyGpexeTestMigrations(rb.url, GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((x) => x.includes("v57")) + 1));
    assert.deepEqual(await catalogOf(client), v57Catalog, "re-applied: the same catalog");
  } finally {
    await client.end();
    await rb.drop();
  }
});

test("21. the rollback refuses, changing nothing, once an undo exists, under a later migration, or when a body was replaced; the migration refuses to run over a changed original body", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9130);
  const rollback = fs.readFileSync(RUNBOOK("session-undo-v57-rollback.sql"), "utf8");
  const c = await newClient();
  // 1. an undo exists. It is made while v60 is in force (the service calls v60's function); then v60 is rolled back for real (its
  // own rollback, rehearsed in session-undo-roster-o1.test.mjs), so the v57 rollback below meets v57's bodies, and v60 is applied
  // again at the end.
  const u = await undo(team, s);
  assert.equal(u.status, 200, u.text);
  await c.query(fs.readFileSync(RUNBOOK("undo-roster-work-v60-rollback.sql"), "utf8"));
  const before = await catalogOf(admin);
  // v59 (and later) are applied on this database, which the v57 rollback refuses first; the checks below are about its own refusals, so the
  // later records are hidden for the test and put back at the end.
  await c.query(`create temp table u5_saved_migrations as select * from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > $1`.replace("$1", `'${V57}'`));
  await c.query(`delete from public.schema_migrations where migration_name in (select migration_name from u5_saved_migrations)`);
  try {
    await assert.rejects(c.query(rollback), /v57 rollback refused: an undo was made/);
    await c.query("rollback").catch(() => {});
    assert.equal((await c.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V57])).rows[0].n, 1);
    // 2. a later migration is recorded
    await c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) select 'migrations_v2/202611051100_later.sql', checksum, runner_version from public.schema_migrations limit 1`);
    await assert.rejects(c.query(rollback), /later migrations are applied/);
    await c.query("rollback").catch(() => {});
    await c.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/202611051100_later.sql'`);
    // 3. a body replaced - inside a transaction that is rolled back, so the shared database keeps v57's functions
    await c.query("begin");
    await c.query(`create or replace function training_load.session_undo_marker_ok() returns boolean as 'select true' language sql`);
    assert.notDeepEqual(await catalogOf(c), before);
    await c.query(`create or replace function training_load.session_undo_scope(p_event uuid) returns jsonb as 'select null::jsonb' language sql`);
    await c.query("savepoint s");
    await assert.rejects(c.query(rollback), /body in force of training_load\.session_undo_scope is not v57's/);
    await c.query("rollback");
    assert.deepEqual((await catalogOf(c)).functions, (await catalogOf(admin)).functions, "the replaced bodies were rolled back");
  } finally {
    await c.query(`insert into public.schema_migrations select * from u5_saved_migrations`).catch(() => {});
    await c.end();
    await applyGpexeTestMigrations(db.url, UP_TO_V60.filter((m) => !m.includes("app_error_events")));
  }
  assert.equal((await admin.query(`select count(*)::int n from public.schema_migrations where migration_name like '%v60%'`)).rows[0].n, 1, "v60 is in force again");
});

test("22. the md5 gate: the migration refuses to run when an original body it copies has changed", async () => {
  const withoutV57 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes("v57")));
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "u5gate", migrations: withoutV57 });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    for (const [fn, replacement] of [
      ["training_load.protect_gpexe_import_candidate", `create or replace function training_load.protect_gpexe_import_candidate() returns trigger as 'begin return new; end' language plpgsql`],
      ["training_load.forbid_update_delete", `create or replace function training_load.forbid_update_delete() returns trigger as 'begin return old; end' language plpgsql`],
    ]) {
      const original = (await client.query(`select pg_get_functiondef(to_regproc($1)) d`, [fn])).rows[0].d;
      await client.query(replacement);
      await assert.rejects(client.query(fs.readFileSync(new URL(`../../${V57}`, import.meta.url), "utf8")), /v57 refused: the body in force of/);
      assert.equal((await client.query(`select to_regclass('training_load.gpexe_session_undo_requests') t`)).rows[0].t, null, "a refused run changes nothing");
      await client.query(original);
    }
    assert.equal((await client.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V57])).rows[0].n, 0);
    await applyGpexeTestMigrations(rb.url, GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((x) => x.includes("v57")) + 1));
    assert.equal((await client.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V57])).rows[0].n, 1);
  } finally {
    await client.end();
    await rb.drop();
  }
});

// ---------------------------------------------------------------------------
// The function's own rights and the CLI's refusals, proven on the function
// ---------------------------------------------------------------------------
test("23. called directly, the function checks the right itself: an inactive user, a club admin, an unknown user and a platform admin of nothing are refused (42501) and nothing is written", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9131);
  const inactive = await platformAdmin();
  await admin.query(`update public.users set is_active = false where id = $1`, [inactive.id]);
  const rowsBefore = await allRowCounts();
  const c = await newClient();
  try {
    for (const [name, actor] of [["inactive user with an active platform role", inactive.id], ["club admin only", team.cadmin.id], ["coach", team.coach.id], ["unknown user", crypto.randomUUID()]]) {
      await assert.rejects(
        c.query(`select * from training_load.undo_imported_session($1, $2, $3, $4, 'direct', null)`, [actor, team.teamId, s.candidateId, key()]),
        (e) => e.code === "42501", name);
    }
    await assert.rejects(c.query(`select * from training_load.undo_imported_session(null, $1, $2, $3, 'direct', null)`, [team.teamId, s.candidateId, key()]), (e) => e.code === "22023");
    await assert.rejects(c.query(`select * from training_load.undo_imported_session($1, $2, $3, $4, '  ', null)`, [team.padmin.id, team.teamId, s.candidateId, key()]), /session_undo:invalid_reason/);
    // A candidate of another team through this team's id is not found, whoever asks.
    const other = await setupTeam();
    await assert.rejects(c.query(`select * from training_load.undo_imported_session($1, $2, $3, $4, 'x', null)`, [team.padmin.id, other.teamId, s.candidateId, key()]), /session_undo:candidate_not_found/);
  } finally { await c.end(); }
  const rowsAfter = await allRowCounts();
  // setupTeam of `other` added rows of its own; the imported session itself is untouched.
  assert.equal(rowsAfter["training_load.metric_events"], rowsBefore["training_load.metric_events"]);
  assert.equal(rowsAfter["training_load.import_deletion_log"], rowsBefore["training_load.import_deletion_log"]);
  assert.equal(rowsAfter["training_load.gpexe_session_undo_requests"], rowsBefore["training_load.gpexe_session_undo_requests"]);
});

test("24. the CLI's refusals hold in the function: another event's link, a reparented activity, two events for one session, a manual correction", async () => {
  const team = await setupTeam();
  const refused = async (s, code, who = team) => {
    const rowsBefore = await allRowCounts();
    const r = await undo(who, s);
    assert.deepEqual([r.status, r.body.error], [409, code], r.text);
    assert.deepEqual(await allRowCounts(), rowsBefore, `${code}: nothing changed`);
  };
  const otherEventRow = async (name) => (await admin.query(
    `insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_team_id, event_timezone_snapshot)
     values ($1,'2026-09-14','2026-09-14T18:08:12Z','session','team',$2,'Europe/Sarajevo') returning id`, [name, team.teamId])).rows[0].id;

  // another event is linked to the activity (no participant link)
  const a = await importSession(team, 9132);
  const foreign = await otherEventRow("another event");
  await admin.query(
    `insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
     values ($1,$2,'manual','confirmed',$3,now(),$3)`, [a.activityId, foreign, team.padmin.id]);
  await refused(a, "other_event_link");

  // a reparented activity
  const b = await importSession(team, 9133, { hour: 10 });
  const target = (await admin.query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, started_at, origin, owner_scope, owner_team_id, created_by_user_id)
     values ('training_session','coach plan','2026-09-14','Europe/Sarajevo','2026-09-14T18:08:12Z','manual','team',$1,$2) returning id`, [team.teamId, team.padmin.id])).rows[0].id;
  const participantId = (await admin.query(`select id from training.activity_participants where activity_id = $1 order by id limit 1`, [b.activityId])).rows[0].id;
  await admin.query(
    `insert into training.activity_participant_reparent_log (activity_participant_id, from_activity_id, to_activity_id, component_strategy, reason, performed_by_user_id)
     values ($1,$2,$3,'keep','coach moved it',$4)`, [participantId, b.activityId, target, team.padmin.id]);
  await refused(b, "entangled_activity");

  // two events carry the same GPEXE session (v20 allows it once the first connection is no longer active; the fixture is a
  // state no route builds, so the v50 triggers are off for that one statement, in its own transaction)
  const t2 = await setupTeam();
  const c = await importSession(t2, 9134, { hour: 12 });
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  await admin.query(`update training_load.metric_source_connections set state = 'inactive' where owner_team_id = $1 and source_system = 'gpexe'`, [t2.teamId]);
  await admin.query("commit");
  const second = (await admin.query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1) returning id`, [t2.teamId])).rows[0].id;
  await admin.query(
    `insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_team_id, source_connection_id, source_external_id, event_timezone_snapshot)
     values ('re-imported','2026-09-14','2026-09-14T18:08:12Z','session','team',$1,$2,'team_session:9134','Europe/Sarajevo')`, [t2.teamId, second]);
  await refused(c, "two_events_for_session", t2);

  // a hand-corrected value
  const d = await importSession(team, 9135, { hour: 14 });
  const identity = (await admin.query(
    `select si.id, si.current_occasion_id from training_load.metric_source_identities si
       join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
      where p.event_id = $1 and si.source_external_id like 'athlete_session:%:full' order by si.id limit 1`, [d.eventId])).rows[0];
  const values = (await admin.query(
    `select metric_definition_id, metric_definition_version_id, value_numeric::float8 as value from training_load.metric_values where occasion_id = $1`, [identity.current_occasion_id]))
    .rows.map((v) => ({ metricDefinitionId: v.metric_definition_id, metricDefinitionVersionId: v.metric_definition_version_id, value: v.value }));
  const { correctImportedOccasionManually } = await import("../src/trainingLoadMetricsMeasurements.js");
  const req = { user: { id: team.coach.id }, authz: { platformRoles: [], clubRoles: [], teamRoles: [{ role: "team_coach", teamId: team.teamId }], managedTeamIds: [] } };
  const scopeCtx = { type: "team", teamId: team.teamId, ownerContext: { ownerScope: "team", ownerTeamId: team.teamId, ownerClubId: null, ownerUserId: null } };
  const manual = await correctImportedOccasionManually(req, scopeCtx, { requestKey: `undo-${key()}`, sourceIdentityId: identity.id, expectedCurrentOccasionId: identity.current_occasion_id, values });
  assert.equal(manual.error, undefined, JSON.stringify(manual));
  await refused(d, "manual_occasion");
});

test("25. a candidate whose last sighting is not a succeeded check is not offered again", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9136);
  // A state no route builds (a finished check's status is final): the user triggers are off for this one statement.
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  await admin.query(`update training_load.gpexe_import_checks set status = 'failed', error_code = 'source_unavailable' where id = (select last_seen_check_id from training_load.gpexe_import_candidates where id = $1)`, [s.candidateId]);
  await admin.query("commit");
  const r = await undo(team, s);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.undo.offeredAgain, r.body.undo.newCandidateId], [false, null]);
  assert.deepEqual((await listFor(team)).filter((c) => c.gpexeTeamSessionId === "9136"), []);
});

test("26. lock order (the rule of .claude/rules/migrations.md): inside the function the users row precedes the role row, which precedes the team lock, the request read, the candidate, the event and the activities, and no lock is taken after the first write", async () => {
  const body = (await admin.query(`select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = 'undo_imported_session'`)).rows[0].prosrc;
  const at = (needle) => {
    const i = body.indexOf(needle);
    assert.ok(i >= 0, `the function takes: ${needle}`);
    return i;
  };
  const order = [
    "from public.users u where u.id = p_actor and u.is_active = true for share",
    "from public.user_global_roles r where r.user_id = p_actor",
    "pg_advisory_xact_lock(hashtextextended('gpexe-import-team:'",
    "from training_load.gpexe_session_undo_requests q",
    "order by c.id for update",
    "from training_load.metric_events e where e.id = v_event_id for update",
    "perform 1 from training.activities a where a.id = any(v_act) order by a.id for update",
  ].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the locks are taken in the documented order");
  const firstWrite = at("perform set_config('optimove.session_undo_tx'");
  assert.ok(order.every((i) => i < firstWrite), "every lock is taken before the first write");
  const afterFirstWrite = body.slice(firstWrite);
  assert.doesNotMatch(afterFirstWrite, /\bfor (update|share|no key update)\b|pg_advisory|\block table\b/i, "no locking clause after the first write");
  // The rights rows are read one statement at a time, users first: no statement locks both.
  assert.doesNotMatch(body, /for share of u, r|for update of u, r/i);
});

test("27. a replay through another team's route is the identical 404, not the saved answer", async () => {
  const a = await setupTeam();
  const b = await setupTeam();
  const s = await importSession(a, 9139);
  const requestKey = key();
  const first = await undo(a, s, { requestKey });
  assert.equal(first.status, 200, first.text);
  const rowsBefore = await allRowCounts();
  const via = await api(undoPath(b, s.candidateId), { method: "POST", cookie: b.padmin.cookie, body: { requestKey, reason: "wrong athlete link", expected: { eventId: s.eventId } } });
  assert.deepEqual([via.status, via.body.error], [404, "notFound"]);
  // The same acting admin: the same user reaching team B.
  const sameAdmin = await api(undoPath(b, s.candidateId), { method: "POST", cookie: a.padmin.cookie, body: { requestKey, reason: "wrong athlete link", expected: { eventId: s.eventId } } });
  assert.equal(sameAdmin.status, 404, sameAdmin.text);
  // Called directly with the admin of A and B's team id: the function itself refuses.
  const c = await newClient();
  try {
    await assert.rejects(c.query(`select * from training_load.undo_imported_session($1,$2,$3,$4,'wrong athlete link',$5)`, [a.padmin.id, b.teamId, s.candidateId, requestKey, s.eventId]), /session_undo:candidate_not_found/);
  } finally { await c.end(); }
  assert.deepEqual(await allRowCounts(), rowsBefore);
});

test("28. an undo aimed at a candidate an approval is holding is refused before it can wait for it: no deadlock, the approval finishes", async () => {
  const team = await setupTeam();
  await checkNow(team, [cleanBundle({ sessionId: 9140 })]);
  const x = (await listFor(team)).find((c) => c.gpexeTeamSessionId === "9140");
  let release; const hold = new Promise((r) => { release = r; });
  let reached; const reachedP = new Promise((r) => { reached = r; });
  service.setApprovalObserver(async () => { reached(); await hold; });
  try {
    const approveP = withSwitchOn(() => api(`/teams/${team.teamId}/imports`, {
      method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [x.id], previewHashes: { [x.id]: x.previewHash } },
    }));
    await reachedP;
    const started = Date.now();
    const r = await api(undoPath(team, x.id), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "misdirected" } });
    assert.deepEqual([r.status, r.body.error], [409, "candidate_not_imported"]);
    assert.ok(Date.now() - started < 3000, "refused at once, without waiting for the approval's locks");
    release();
    const a = await approveP;
    assert.equal(a.body.results[0].outcome, "imported", a.text);
  } finally { service.setApprovalObserver(null); }
});

test("29. newer content for the session already published: the old snapshot is not offered again", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9141);
  // GPEXE changed the session; a search publishes the new content as a pending candidate beside the imported one.
  await checkNow(team, [cleanBundle({ sessionId: 9141, updatedOn: "2026-09-14T21:30:00.000" })]);
  const live = (await listFor(team)).filter((c) => c.gpexeTeamSessionId === "9141" && c.status !== "imported");
  assert.equal(live.length, 1, "the newer content is a live candidate");
  const r = await undo(team, s);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.undo.offeredAgain, r.body.undo.newCandidateId], [false, null]);
  const after = (await listFor(team)).filter((c) => c.gpexeTeamSessionId === "9141");
  assert.deepEqual(after.map((c) => c.id), [live[0].id], "exactly one live candidate remains: the newer one");
});

// A session changed in GPEXE and approved again (acceptChanges) writes into the SAME event (one event per session, v20).
async function importTwoVersions(team, sessionId) {
  const a = await importSession(team, sessionId);
  await checkNow(team, [cleanBundle({ sessionId, distance101: 3500, updatedOn: "2026-09-14T21:30:00.000" })]);
  const b = (await listFor(team)).find((c) => c.gpexeTeamSessionId === String(sessionId) && c.status === "pending");
  assert.ok(b, "the changed content is a pending candidate");
  const approved = await withSwitchOn(() => api(`/teams/${team.teamId}/candidates/${b.id}/approve`, {
    method: "POST", cookie: team.padmin.cookie, body: { previewHash: b.previewHash, acceptChanges: true },
  }));
  assert.equal(approved.status, 200, approved.text);
  const eventB = (await admin.query(`select metric_event_id from training_load.gpexe_import_approvals where candidate_id = $1`, [b.id])).rows[0].metric_event_id;
  assert.equal(eventB, a.eventId, "both approvals wrote into one event");
  return { a, b: { candidateId: b.id, previewHash: b.previewHash } };
}

test("30. two approved versions of one session share an event: undoing either undoes both, ends in the same state, and offers only the newest content", async () => {
  for (const which of ["older", "newer"]) {
    const team = await setupTeam();
    const { a, b } = await importTwoVersions(team, which === "older" ? 9150 : 9151);
    const hashOf = async (id) => (await admin.query(`select bundle_hash from training_load.gpexe_import_candidates where id = $1`, [id])).rows[0].bundle_hash;
    const preview = await api(previewPath(team, which === "older" ? a.candidateId : b.candidateId), { cookie: team.padmin.cookie });
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual([...preview.body.undoPreview.undoneCandidateIds].sort(), [a.candidateId, b.candidateId].sort(), "the scope names both candidates");
    const target = which === "older" ? a : { ...b, eventId: a.eventId };
    const requestKey = key();
    const r = await undo(team, target, { requestKey });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([...r.body.undo.undoneCandidateIds].sort(), [a.candidateId, b.candidateId].sort());
    assert.equal((await counts(team.teamId)).events, 0);
    const rows = (await admin.query(`select id, status, import_undone_at is not null as undone from training_load.gpexe_import_candidates where owner_team_id = $1 and gpexe_team_session_id = $2 order by id`, [team.teamId, which === "older" ? "9150" : "9151"])).rows;
    const undone = rows.filter((x) => x.undone).map((x) => x.id).sort();
    assert.deepEqual(undone, [a.candidateId, b.candidateId].sort(), `${which}: both are marked undone`);
    const live = rows.filter((x) => !x.undone);
    assert.deepEqual(live.map((x) => x.status), ["pending"], `${which}: exactly one pending candidate remains`);
    assert.equal(live[0].id, r.body.undo.newCandidateId);
    assert.equal(await hashOf(live[0].id), await hashOf(b.candidateId), `${which}: it carries the NEWER content`);
    // The other candidate is not undoable again; a replay of the same request answers; the key with another reason is reused.
    const other = which === "older" ? b : a;
    const again = await undo(team, { candidateId: other.candidateId, eventId: a.eventId }, { requestKey: key() });
    assert.deepEqual([again.status, again.body.error], [409, "already_undone"]);
    const replay = await undo(team, target, { requestKey });
    assert.deepEqual([replay.status, replay.body.undo?.replayed, replay.body.undo?.undoneCandidateIds?.length], [200, true, 2]);
    const reused = await undo(team, target, { requestKey, reason: "something else" });
    assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"]);
    // The history keeps one log row for the event and one request row naming both candidates.
    const c = await counts(team.teamId);
    assert.deepEqual([c.log, c.requests], [1, 1]);
  }
});

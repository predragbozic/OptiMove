// O1 (J20 section 5.3, migration v60): the undo of an imported session is always possible, whatever roster work exists. Through the real
// server on a disposable database (the u5 world: the fake server3 source, the real batch approval); the roster states the J20 flow will
// write (origin 'import') are inserted raw, a coach's work goes through the real roster routes.
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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "undov60", migrations: GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")) }); // everything but the error-tracking migration (it would record test 19's injected 500 as a row): the approval writes v59 columns, so v57 is no longer the last migration here (tests 20 and 22 keep their own v56/v57 slices)
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function newClient() {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  return c;
}
const RUNBOOK = (name) => new URL(`../../docs/runbooks/${name}`, import.meta.url);
const V60 = "migrations_v2/202611091200_training_load_v60_session_undo_roster_work.sql";
const V60_FILE = new URL(`../../${V60}`, import.meta.url);
const rosterApi = (path, { method = "GET", body, cookie } = {}) => fetch(`${apiBase}/api/training-activity/${path}`, {
  method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
});

// The athletes of the session's roster that need a state (not measured), in a stable order.
async function needing(team, s) {
  const res = await rosterApi(`${s.activityId}/roster`, { cookie: team.coach.cookie });
  assert.equal(res.status, 200);
  return (await res.json()).athletes.filter((a) => a.group === "needs_state").map((a) => a.athleteId).sort();
}

// A coach's own decision through the real roster route.
async function coachDecides(team, s, athleteId, { kind = "participated_no_values", expectedDecisionId = null } = {}) {
  const res = await rosterApi(`${s.activityId}/roster/${athleteId}/decision`, { method: "PUT", cookie: team.coach.cookie, body: { kind, expectedDecisionId, requestKey: key() } });
  assert.equal(res.status, 200, await res.clone().text());
  return res;
}

// What the J20 states step will write: ONE request of origin 'import' by the approver, and its decisions. Raw (J20-C is not built).
async function importStates(team, s, athleteIds, { by = team.padmin.id, createdAt = null, kind = "participated_no_values", origin = "import" } = {}) {
  const c = await newClient();
  const requestId = crypto.randomUUID();
  try {
    await c.query("begin");
    await c.query(
      `insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin${createdAt ? ", created_at" : ""})
       values ($1, $2, $3, $4, 'decide_bulk', $5, '{}'::jsonb, $6${createdAt ? ", $7" : ""})`,
      [requestId, s.activityId, key(), "a".repeat(64), by, origin, ...(createdAt ? [createdAt] : [])],
    );
    for (const athleteId of athleteIds) {
      await c.query(
        `insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, decided_by_user_id, decided_by_basis)
         values ($1, $2, $3, $4, $5, $6, 'platform_admin')`, [s.activityId, athleteId, team.teamId, requestId, kind, by],
      );
    }
    await c.query("commit");
    return requestId;
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  } finally {
    await c.end();
  }
}

const rosterRows = async (activityId) => ({
  decisions: (await admin.query(`select count(*)::int n from training.activity_athlete_decisions where activity_id = $1`, [activityId])).rows[0].n,
  requests: (await admin.query(`select count(*)::int n from training.activity_roster_requests where activity_id = $1`, [activityId])).rows[0].n,
  completions: (await admin.query(`select count(*)::int n from training.activity_completions where activity_id = $1`, [activityId])).rows[0].n,
  log: (await admin.query(`select count(*)::int n from training.activity_completion_log where activity_id = $1`, [activityId])).rows[0].n,
});
const ZERO = { decisions: 0, requests: 0, completions: 0, log: 0 };
const preview = async (team, s) => (await api(previewPath(team, s.candidateId), { cookie: team.padmin.cookie }));

test("1. states written by the import flow (origin 'import') never block the undo and go with the session; the log records them", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9201);
  const [x, y] = await needing(team, s);
  await importStates(team, s, [x, y]);
  assert.deepEqual((await rosterRows(s.activityId)).decisions, 2);
  const p = await preview(team, s);
  assert.equal(p.status, 200, p.text);
  assert.deepEqual([p.body.undoPreview.rosterWork.importWritten.decisions, p.body.undoPreview.rosterWork.later.decisions], [2, 0]);
  assert.deepEqual(await rosterRows(s.activityId), { ...ZERO, decisions: 2, requests: 1, log: (await rosterRows(s.activityId)).log, completions: (await rosterRows(s.activityId)).completions }, "the preview kept nothing");
  const r = await undo(team, s);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await rosterRows(s.activityId), ZERO, "all four roster tables are empty for the session");
  assert.equal(r.body.undo.removedCounts.activity_athlete_decisions, 2);
  assert.equal(r.body.undo.removedCounts.activity_roster_requests, 1);
  const log = (await admin.query(`select roster_work_removed w, deleted_by_user_id from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0];
  assert.equal(log.w.importWritten.decisions, 2);
  assert.equal(log.w.later.decisions, 0);
  assert.equal(log.w.laterConfirmed, false);
  assert.equal(log.w.confirmedByUserId, team.padmin.id);
  assert.equal(log.deleted_by_user_id, team.padmin.id);
});

test("2. a coach's later decision: the undo is refused without the confirmation (nothing removed), the preview lists it, the confirmation removes it, the log holds both", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9202);
  const [x, y, z] = await needing(team, s);
  await importStates(team, s, [x]);
  await coachDecides(team, s, y);
  const rowsBefore = await allRowCounts();
  const refused = await undo(team, s);
  assert.deepEqual([refused.status, refused.body.error], [409, "roster_work_needs_confirmation"]);
  assert.equal(refused.body.rosterWork.later.decisions, 1);
  assert.equal(refused.body.rosterWork.importWritten.decisions, 1);
  assert.match(refused.body.rosterWork.fingerprint, /^[0-9a-f]{32}$/);
  assert.deepEqual(await allRowCounts(), rowsBefore, "a refusal removes nothing");
  const p = (await preview(team, s)).body.undoPreview;
  assert.equal(p.rosterWork.laterDecisions.length, 1);
  assert.equal(p.rosterWork.laterDecisions[0].athleteId, y);
  assert.equal(p.rosterWork.laterDecisions[0].athleteName, (await admin.query(`select coalesce(nullif(display_name, ''), full_name) n from public.athletes where id = $1`, [y])).rows[0].n);
  assert.deepEqual(Object.keys(p.rosterWork.laterDecisions[0]).sort(), ["athleteId", "athleteName", "decidedAt", "decidedByUserId", "kind", "reasonCode"]);
  assert.equal(p.rosterWork.fingerprint, refused.body.rosterWork.fingerprint, "the preview and the refusal carry the same fingerprint");
  const ok = await api(undoPath(team, s.candidateId), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "wrong links", expected: { eventId: s.eventId }, confirmRosterFingerprint: p.rosterWork.fingerprint } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(await rosterRows(s.activityId), ZERO);
  assert.equal(ok.body.undo.rosterWork.later.decisions, 1);
  const w = (await admin.query(`select roster_work_removed w from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0].w;
  assert.equal(w.laterConfirmed, true);
  assert.equal(w.laterDecisionsTotal, 1);
  assert.deepEqual(w.laterDecisions.map((d) => d.athleteId), [y]);
  assert.equal(w.importWritten.decisions, 1);
  assert.ok(z, "a third athlete exists");
});

test("3. a later decision that supersedes an import-origin one makes the whole chain later work", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9203);
  const [x] = await needing(team, s);
  await importStates(team, s, [x]);
  const current = (await admin.query(`select id from training.activity_athlete_decisions where activity_id = $1 and athlete_id = $2 and superseded_by_decision_id is null`, [s.activityId, x])).rows[0].id;
  const reasonKey = (await admin.query(`select key from training.participation_reasons where is_active order by key limit 1`)).rows[0].key;
  const res = await rosterApi(`${s.activityId}/roster/${x}/decision`, { method: "PUT", cookie: team.coach.cookie, body: { kind: "did_not_participate", reasonKey, expectedDecisionId: current, requestKey: key() } });
  assert.equal(res.status, 200, await res.clone().text());
  const work = (await preview(team, s)).body.undoPreview.rosterWork;
  assert.deepEqual([work.importWritten.decisions, work.later.decisions], [0, 2], "both decisions of the chain are later work");
  assert.equal(work.importWritten.requests, 1);
  assert.equal(work.later.requests, 1);
});

test("4. the confirmation is a compare-and-set: a list that changed after the preview removes nothing; a fingerprint without later work is refused", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9204);
  const [x, y] = await needing(team, s);
  await coachDecides(team, s, x);
  const fp = (await preview(team, s)).body.undoPreview.rosterWork.fingerprint;
  await coachDecides(team, s, y);
  const rowsBefore = await allRowCounts();
  const stale = await api(undoPath(team, s.candidateId), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "x", expected: { eventId: s.eventId }, confirmRosterFingerprint: fp } });
  assert.deepEqual([stale.status, stale.body.error], [409, "roster_work_changed"]);
  assert.deepEqual(await allRowCounts(), rowsBefore, "nothing was removed");
  const fresh = (await preview(team, s)).body.undoPreview.rosterWork.fingerprint;
  assert.notEqual(fresh, fp);
  const ok = await api(undoPath(team, s.candidateId), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "x", expected: { eventId: s.eventId }, confirmRosterFingerprint: fresh } });
  assert.equal(ok.status, 200, ok.text);
  // a session without later work: a fingerprint that does not match the (empty) list is refused too
  const s2 = await importSession(team, 9205);
  const bogus = await api(undoPath(team, s2.candidateId), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "x", expected: { eventId: s2.eventId }, confirmRosterFingerprint: "0".repeat(32) } });
  assert.deepEqual([bogus.status, bogus.body.error], [409, "roster_work_changed"]);
  assert.equal((await counts(team.teamId)).events, 1);
});

test("5. 'preview' is the read-only call's marker: the route refuses it, and the function with it removes nothing once rolled back", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9206);
  const [x] = await needing(team, s);
  await coachDecides(team, s, x);
  for (const bad of ["preview", "short", "G".repeat(32), 5, {}]) {
    const r = await api(undoPath(team, s.candidateId), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "x", confirmRosterFingerprint: bad } });
    assert.deepEqual([r.status, r.body.error], [400, "invalid_request"], String(bad));
  }
  const rowsBefore = await allRowCounts();
  const c = await newClient();
  try {
    await c.query("begin");
    const row = (await c.query(`select * from training_load.undo_imported_session($1, $2, $3, $4, 'preview', null, 'preview')`, [team.padmin.id, team.teamId, s.candidateId, key()])).rows[0];
    assert.equal(row.roster_work.later.decisions, 1);
    await c.query("rollback");
  } finally { await c.end(); }
  assert.deepEqual(await allRowCounts(), rowsBefore);
});

test("6. the old six-argument function is gone and the backend calls the seven-argument one", async () => {
  assert.equal((await admin.query(`select to_regprocedure('training_load.undo_imported_session(uuid,uuid,uuid,uuid,text,uuid)') as f`)).rows[0].f, null);
  assert.ok((await admin.query(`select to_regprocedure('training_load.undo_imported_session(uuid,uuid,uuid,uuid,text,uuid,text)') as f`)).rows[0].f);
  const source = fs.readFileSync(new URL("../src/gpexeSessionUndoService.js", import.meta.url), "utf8");
  assert.match(source, /undo_imported_session\(\$1, \$2, \$3, \$4, \$5, \$6, \$7\)/);
  assert.match(source, /undo_imported_session\(\$1, \$2, \$3, gen_random_uuid\(\), 'preview', null, 'preview'\)/);
  assert.doesNotMatch(source, /roster_decisions_exist/);
});

test("7. origin 'import' is accepted only for the approver's own request made after the approval; the plain roster routes never write it", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9207);
  const [x, y, z] = await needing(team, s);
  // not the approver
  await assert.rejects(importStates(team, s, [x], { by: team.coach.id }), (e) => e.code === "23514" && /import-origin request needs/.test(e.message));
  // made before the approval
  await assert.rejects(importStates(team, s, [x], { createdAt: "2020-01-01T00:00:00Z" }), (e) => e.code === "23514");
  // another team's session: the approver of THIS team has no approval for that activity
  const other = await setupTeam();
  const so = await importSession(other, 9208);
  // The approver's approval of ANOTHER session does not open this one: the request must hang on an activity linked to an event he approved.
  const c0 = await newClient();
  try {
    await assert.rejects(
      c0.query(`insert into training.activity_roster_requests (activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin) values ($1, $2, $3, 'decide_bulk', $4, '{}'::jsonb, 'import')`,
        [so.activityId, key(), "a".repeat(64), team.padmin.id]),
      (e) => e.code === "23514" && /import-origin request needs/.test(e.message));
    // ...while the same insert for a session he did approve passes (rolled back here).
    await c0.query("begin");
    await c0.query(`insert into training.activity_roster_requests (activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin) values ($1, $2, $3, 'decide_bulk', $4, '{}'::jsonb, 'import')`,
      [s.activityId, key(), "a".repeat(64), team.padmin.id]);
    await c0.query("rollback");
  } finally { await c0.end(); }
  // the plain routes write 'roster'
  await coachDecides(team, s, y);
  assert.deepEqual((await admin.query(`select distinct origin from training.activity_roster_requests where activity_id = $1`, [s.activityId])).rows.map((r) => r.origin), ["roster"]);
  // a well-formed import-origin request passes
  await importStates(team, s, [z]);
  assert.deepEqual((await admin.query(`select origin from training.activity_roster_requests where activity_id = $1 order by origin`, [s.activityId])).rows.map((r) => r.origin), ["import", "roster"]);
  // the closed set
  await assert.rejects(importStates(team, s, [x], { origin: "coach" }), (e) => e.code === "23514");
});

test("8. the four roster tables stay append-only outside the undo: no DELETE, UPDATE or TRUNCATE passes, a session-level setting is no key", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9209);
  const [x] = await needing(team, s);
  await importStates(team, s, [x]);
  await coachDecides(team, s, (await needing(team, s))[0]);
  await admin.query(`insert into training.activity_completions (activity_id, owner_team_id, status, revision) select null, null, 'not_complete', 0 where false`);
  const c = await newClient();
  try {
    await c.query(`select set_config('optimove.session_undo_tx', txid_current()::text, false)`);
    for (const table of ["activity_athlete_decisions", "activity_roster_requests", "activity_completion_log", "activity_completions"]) {
      for (const sql of [`delete from training.${table}`, `truncate training.${table}`]) {
        await c.query("begin");
        await assert.rejects(c.query(sql), /append-only|never deleted|refused|truncate/i, `${sql}`);
        await c.query("rollback");
      }
    }
    await c.query("begin");
    await assert.rejects(c.query(`update training.activity_roster_requests set origin = 'import'`), /append-only/);
    await c.query("rollback");
    await c.query("begin");
    await assert.rejects(c.query(`update training.activity_athlete_decisions set note = 'x'`), /only gets superseded|append-only/);
    await c.query("rollback");
  } finally { await c.end(); }
  assert.equal((await rosterRows(s.activityId)).requests, 2);
});

test("9. the deletion log's roster_work_removed has a closed, bounded shape and names the administrator who ran the undo", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9210);
  const [x] = await needing(team, s);
  await coachDecides(team, s, x);
  const fp = (await preview(team, s)).body.undoPreview.rosterWork.fingerprint;
  const done = await api(undoPath(team, s.candidateId), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "log shape", expected: { eventId: s.eventId }, confirmRosterFingerprint: fp } });
  assert.equal(done.status, 200, done.text);
  const row = (await admin.query(`select * from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0];
  const base = structuredClone(row.roster_work_removed);
  const insert = async (work, { actor = row.deleted_by_user_id } = {}) => {
    const c = await newClient();
    try {
      await c.query(
        `insert into training_load.import_deletion_log (deleted_by_user_id, authorized_via, reason, event_id, source_system, source_connection_id, source_external_id, owner_team_id, occurred_date, removed_counts, removed_total, roster_work_removed)
         values ($1, 'platform_admin', 'shape test', gen_random_uuid(), $2, $3, $4, $5, $6, '{"x":1}'::jsonb, 1, $7)`,
        [actor, row.source_system, row.source_connection_id, row.source_external_id, row.owner_team_id, row.occurred_date, work === null ? null : JSON.stringify(work)],
      );
    } finally { await c.end(); }
  };
  await insert(base);
  await insert(null);
  const cases = {
    "an extra key": { ...base, note: "free text" },
    "a missing key": (() => { const w = structuredClone(base); delete w.laterConfirmed; return w; })(),
    "another administrator confirmed": { ...base, confirmedByUserId: team.coach.id },
    "a note in a listed decision": { ...base, laterDecisions: [{ ...base.laterDecisions[0], note: "private" }] },
    "a name instead of an id": { ...base, laterDecisions: [{ ...base.laterDecisions[0], athleteId: "Ana" }] },
    "a kind outside the closed set": { ...base, laterDecisions: [{ ...base.laterDecisions[0], kind: "whatever" }] },
    "a free-text reason code": { ...base, laterDecisions: [{ ...base.laterDecisions[0], reasonCode: "Ana was ill, see note" }] },
    "a list longer than its total": { ...base, laterDecisions: [base.laterDecisions[0], base.laterDecisions[0]] },
    "more than 500 listed": { ...base, laterDecisionsTotal: 501, later: { ...base.later, decisions: 501 }, laterDecisions: Array.from({ length: 501 }, () => base.laterDecisions[0]) },
    "a count that is not a number": { ...base, later: { ...base.later, decisions: "1" } },
    "not an object": [],
  };
  for (const [name, work] of Object.entries(cases)) await assert.rejects(insert(work), (e) => e.code === "23514", name);
  await assert.rejects(insert(base, { actor: team.coach.id }), (e) => e.code === "42501" || e.code === "23514", "a coach cannot write the log");
});

test("10. undo and a roster Change serialise on the team import lock: whichever comes second sees the first, in both orders", async () => {
  for (const decisionFirst of [true, false]) {
    const team = await setupTeam();
    const s = await importSession(team, decisionFirst ? 9211 : 9212);
    const [x] = await needing(team, s);
    const holder = await newClient();
    await holder.query("begin");
    await holder.query(`select pg_advisory_xact_lock(hashtextextended('gpexe-import-team:' || lower($1::text), 21))`, [team.teamId]);
    const waiting = async () => (await admin.query(`select count(*)::int n from pg_locks where locktype = 'advisory' and not granted`)).rows[0].n;
    const decide = () => rosterApi(`${s.activityId}/roster/${x}/decision`, { method: "PUT", cookie: team.coach.cookie, body: { kind: "participated_no_values", expectedDecisionId: null, requestKey: key() } });
    const doUndo = () => undo(team, s);
    const first = decisionFirst ? decide() : doUndo();
    for (let i = 0; i < 100 && (await waiting()) < 1; i += 1) await sleep(50);
    const second = decisionFirst ? doUndo() : decide();
    for (let i = 0; i < 100 && (await waiting()) < 2; i += 1) await sleep(50);
    await holder.query("commit");
    await holder.end();
    const [a, b] = await Promise.all([first, second]);
    const decisionRes = decisionFirst ? a : b;
    const undoRes = decisionFirst ? b : a;
    const rows = await rosterRows(s.activityId);
    if (decisionFirst) {
      assert.equal(decisionRes.status, 200);
      assert.deepEqual([undoRes.status, undoRes.body.error], [409, "roster_work_needs_confirmation"], "the undo saw the coach's decision");
      assert.equal(rows.decisions, 1);
    } else {
      assert.equal(undoRes.status, 200, undoRes.text);
      assert.notEqual(decisionRes.status, 200, "the coach's decision found the session gone");
      assert.deepEqual(rows, ZERO, "no roster row survives the undo");
    }
  }
});

test("11. the roster work of a whole alias set is classified together (the function over two activities)", async () => {
  const team = await setupTeam();
  const s1 = await importSession(team, 9213);
  const s2 = await importSession(team, 9214);
  const [x] = await needing(team, s1);
  const [, y] = await needing(team, s2);
  await importStates(team, s1, [x]);
  await coachDecides(team, s2, y);
  const w = (await admin.query(`select training_load.session_undo_roster_work($1::uuid[]) as w`, [[s1.activityId, s2.activityId]])).rows[0].w;
  assert.deepEqual([w.importWritten.decisions, w.importWritten.requests, w.later.decisions, w.later.requests], [1, 1, 1, 1]);
  assert.equal(w.laterDecisionsTotal, 1);
  const again = (await admin.query(`select training_load.session_undo_roster_work($1::uuid[]) as w`, [[s2.activityId, s1.activityId]])).rows[0].w;
  assert.equal(again.fingerprint, w.fingerprint, "the fingerprint does not depend on the order of the set");
  assert.equal((await admin.query(`select training_load.session_undo_roster_work('{}'::uuid[]) as w`)).rows[0].w.later.decisions, 0);
});

test("12. a replay of a confirmed undo answers the saved outcome, with the roster counts from the log", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9215);
  const [x] = await needing(team, s);
  await coachDecides(team, s, x);
  const fp = (await preview(team, s)).body.undoPreview.rosterWork.fingerprint;
  const k = key();
  const body = { requestKey: k, reason: "replay", expected: { eventId: s.eventId }, confirmRosterFingerprint: fp };
  const one = await api(undoPath(team, s.candidateId), { method: "POST", cookie: team.padmin.cookie, body });
  const two = await api(undoPath(team, s.candidateId), { method: "POST", cookie: team.padmin.cookie, body });
  assert.deepEqual([one.status, two.status, two.body.undo.replayed], [200, 200, true]);
  assert.equal(two.body.undo.rosterWork.later.decisions, 1);
  assert.equal((await counts(team.teamId)).log, 1);
});

test("15. a completion the coach confirmed after the import is later work (with its log); the confirmed undo removes the completion, its log and every state", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9217);
  const all = await needing(team, s);
  await importStates(team, s, all);
  const read = await (await rosterApi(`${s.activityId}/roster`, { cookie: team.coach.cookie })).json();
  const done = await rosterApi(`${s.activityId}/roster/complete`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), expectedRevision: read.completion?.revision ?? 0, expectedFingerprint: read.rosterFingerprint } });
  assert.equal(done.status, 200, await done.clone().text());
  const rows = await rosterRows(s.activityId);
  assert.equal(rows.completions, 1);
  assert.ok(rows.log >= 1);
  const w = (await preview(team, s)).body.undoPreview.rosterWork;
  assert.equal(w.importWritten.decisions, all.length);
  assert.equal(w.importWritten.completions, 0);
  assert.deepEqual([w.later.completions, w.later.completionLog >= 1, w.later.decisions, w.later.requests], [1, true, 0, 1]);
  const refused = await undo(team, s);
  assert.deepEqual([refused.status, refused.body.error], [409, "roster_work_needs_confirmation"], "the completion alone needs the confirmation");
  const ok = await api(undoPath(team, s.candidateId), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "completion", expected: { eventId: s.eventId }, confirmRosterFingerprint: w.fingerprint } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(await rosterRows(s.activityId), ZERO);
  assert.ok(ok.body.undo.removedCounts.activity_completions === 1 && ok.body.undo.removedCounts.activity_completion_log >= 1);
  const logged = (await admin.query(`select roster_work_removed w from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0].w;
  assert.deepEqual([logged.later.completions, logged.later.decisions, logged.laterConfirmed], [1, 0, true]);
});

test("16. the fingerprint covers the completion too: a Complete after the preview changes it, and the old fingerprint removes nothing", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9218);
  const all = await needing(team, s);
  await importStates(team, s, all);
  const first = (await preview(team, s)).body.undoPreview.rosterWork;
  assert.equal(first.later.completions, 0);
  const read = await (await rosterApi(`${s.activityId}/roster`, { cookie: team.coach.cookie })).json();
  const done = await rosterApi(`${s.activityId}/roster/complete`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), expectedRevision: read.completion?.revision ?? 0, expectedFingerprint: read.rosterFingerprint } });
  assert.equal(done.status, 200, await done.clone().text());
  const rowsBefore = await allRowCounts();
  const stale = await api(undoPath(team, s.candidateId), { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "x", expected: { eventId: s.eventId }, confirmRosterFingerprint: first.fingerprint } });
  assert.deepEqual([stale.status, stale.body.error], [409, "roster_work_changed"]);
  assert.deepEqual(await allRowCounts(), rowsBefore);
});

// ---------------------------------------------------------------------------
// The migration: preflight, post-check, rollback rehearsal, the md5 gates
// ---------------------------------------------------------------------------
async function booleansOf(client, sql) {
  const results = [].concat(await client.query(sql));
  const out = [];
  for (const res of results) for (const row of res.rows) for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") out.push([k, v]);
  return out;
}
async function catalogOf(client) {
  const rel = ["activity_roster_requests", "activity_athlete_decisions", "activity_completions", "activity_completion_log", "import_deletion_log"];
  const triggers = (await client.query(
    `select c.relname || '.' || t.tgname || ' :: ' || pg_get_triggerdef(t.oid) as d from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname = any($1) and not t.tgisinternal order by 1`, [rel])).rows.map((r) => r.d);
  const constraints = (await client.query(
    `select c.relname || '.' || k.conname || ' :: ' || pg_get_constraintdef(k.oid) as d from pg_constraint k join pg_class c on c.oid = k.conrelid where c.relname = any($1) order by 1`, [rel])).rows.map((r) => r.d);
  const columns = (await client.query(
    `select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') as d from information_schema.columns
      where table_schema in ('training', 'training_load') and table_name = any($1) order by 1`, [rel])).rows.map((r) => r.d);
  const functions = (await client.query(
    `select n.nspname || '.' || p.proname || '/' || p.pronargs || ' ' || md5(p.prosrc) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('training_load', 'training') order by 1`)).rows.map((r) => r.d);
  return { triggers, constraints, columns, functions };
}

test("13. migration v60: the preflight passes on v59, the post-check on v60, the rollback restores v59 exactly and refuses once import-written work or a removal is on record, and v60 applies again", async () => {
  const idx = GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes("v60"));
  assert.ok(idx > 0);
  const upToV59 = GPEXE_TEST_MIGRATIONS.slice(0, idx);
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v60rb", migrations: upToV59 });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    const pre = await booleansOf(client, fs.readFileSync(RUNBOOK("session-undo-roster-work-v60-preflight.sql"), "utf8"));
    assert.ok(pre.length >= 15, `the preflight returned its booleans (${pre.length})`);
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok on a v59 database");
    const v59Catalog = await catalogOf(client);
    await applyGpexeTestMigrations(rb.url, GPEXE_TEST_MIGRATIONS.slice(0, idx + 1));
    const post = await booleansOf(client, fs.readFileSync(RUNBOOK("session-undo-roster-work-v60-postcheck.sql"), "utf8"));
    assert.ok(post.length >= 15, `the post-check returned its booleans (${post.length})`);
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok on a v60 database");
    const preAfter = await booleansOf(client, fs.readFileSync(RUNBOOK("session-undo-roster-work-v60-preflight.sql"), "utf8"));
    assert.ok(preAfter.some(([, v]) => v === false), "the preflight no longer passes once v60 is applied");
    const v60Catalog = await catalogOf(client);
    assert.notDeepEqual(v60Catalog, v59Catalog);
    const rollback = fs.readFileSync(RUNBOOK("session-undo-roster-work-v60-rollback.sql"), "utf8");
    await client.query(rollback);
    assert.deepEqual(await catalogOf(client), v59Catalog, "the rollback restores the v59 catalog exactly");
    assert.equal((await client.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V60])).rows[0].n, 0);
    await applyGpexeTestMigrations(rb.url, GPEXE_TEST_MIGRATIONS.slice(0, idx + 1));
    assert.deepEqual(await catalogOf(client), v60Catalog, "re-applied: the same catalog");
    // a second rollback attempt on a database where the body was replaced refuses
    await client.query("begin");
    await client.query(`create or replace function training_load.session_undo_roster_work(p_alias uuid[]) returns jsonb as 'select null::jsonb' language sql`);
    await assert.rejects(client.query(rollback), /body in force of training_load\.session_undo_roster_work is not v60's/);
    await client.query("rollback");
    // later migration recorded
    await client.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) select 'migrations_v2/202611091300_later.sql', checksum, runner_version from public.schema_migrations limit 1`);
    await assert.rejects(client.query(rollback), /later migrations are applied/);
    await client.query("rollback").catch(() => {});
    await client.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/202611091300_later.sql'`);
  } finally {
    await client.end();
    await rb.drop();
  }
});

test("14. the rollback refuses (changing nothing) once import-written roster work or a removal of roster work is on record; the migration refuses to run over a changed original body", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9216);
  const [x] = await needing(team, s);
  await importStates(team, s, [x]);
  const rollback = fs.readFileSync(RUNBOOK("session-undo-roster-work-v60-rollback.sql"), "utf8");
  const c = await newClient();
  try {
    await assert.rejects(c.query(rollback), /import-written roster work or a removal of roster work is on record/);
    await c.query("rollback").catch(() => {});
    assert.equal((await c.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V60])).rows[0].n, 1);
    assert.ok((await c.query(`select to_regprocedure('training_load.undo_imported_session(uuid,uuid,uuid,uuid,text,uuid,text)') as f`)).rows[0].f, "still v60");
  } finally { await c.end(); }
  const r = await undo(team, s);
  assert.equal(r.status, 200, r.text);
  const c2 = await newClient();
  try {
    await assert.rejects(c2.query(rollback), /import-written roster work or a removal of roster work is on record/, "the log row of the removal keeps it forward-only");
  } finally { await c2.end(); }

  // the md5 gate of the migration itself
  const idx = GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes("v60"));
  const gate = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v60gate", migrations: GPEXE_TEST_MIGRATIONS.slice(0, idx) });
  const g = new pg.Client({ connectionString: gate.url });
  await g.connect();
  try {
    for (const [fn, replacement] of [
      ["training.protect_activity_completion_log", `create or replace function training.protect_activity_completion_log() returns trigger as 'begin return new; end' language plpgsql`],
      ["training_load.validate_import_deletion_log", `create or replace function training_load.validate_import_deletion_log() returns trigger as 'begin return new; end' language plpgsql`],
      ["training_load.session_undo_scope", `create or replace function training_load.session_undo_scope(p_event uuid) returns jsonb as 'select null::jsonb' language sql`],
    ]) {
      const original = (await g.query(`select pg_get_functiondef(to_regproc($1)) d`, [fn])).rows[0].d;
      await g.query(replacement);
      await assert.rejects(g.query(fs.readFileSync(V60_FILE, "utf8")), /v60 refused: the body in force of/);
      assert.equal((await g.query(`select count(*)::int n from information_schema.columns where table_name = 'activity_roster_requests' and column_name = 'origin'`)).rows[0].n, 0, "a refused run changes nothing");
      await g.query(original);
    }
  } finally {
    await g.end();
    await gate.drop();
  }
});

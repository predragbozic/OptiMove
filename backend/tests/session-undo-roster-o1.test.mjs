// O1 of J20 (migration v60): the undo of an imported session also removes its roster work. What the import itself wrote
// (requests with origin 'import') never blocks; later roster work is removed only with a confirmation of exactly the list
// the administrator saw (its fingerprint, compared under the team's import lock). Through the real server on a disposable
// database; GPEXE is the fake server3 source; the import is the real approval. J20-C's states route does not exist yet, so
// the states the import flow writes are written here the way that route will: one request with origin 'import' by the
// approving user, in one transaction with its decisions.
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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "undoo1", migrations: GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")) }); // every migration but the error-tracking one (an injected failure would be recorded as a row)
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

test("0. (first: it needs a database without import-origin rows) the rollback refuses, changing nothing, after an import-origin request, after a log row with roster work, under a later migration, and over a replaced body", async () => {
  const rollback = fs.readFileSync(RUNBOOK("undo-roster-work-v60-rollback.sql"), "utf8");
  const before = await catalogOf(admin);
  const c = await newClient();
  const attempt = async (pattern) => {
    await assert.rejects(c.query(rollback), pattern);
    await c.query("rollback").catch(() => {});
    assert.deepEqual(await catalogOf(c), before, "nothing changed");
  };
  try {
    // An undo without roster work does not hold the rollback back; the checks run in this order.
    const team = await setupTeam();
    const s = await importSession(team, 9617);
    const [x] = await needingState(team, s);
    await c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) select 'migrations_v2/209912312359_later.sql', checksum, runner_version from public.schema_migrations limit 1`);
    await attempt(/later migrations are applied/);
    await c.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/209912312359_later.sql'`);
    await writeImportStates(team, s, [x]);
    await attempt(/an import-origin roster request exists/);
    // the undo removes that request; its log row now carries roster work
    assert.equal((await undoWith(team, s)).status, 200);
    assert.equal((await c.query(`select count(*)::int n from training.activity_roster_requests where origin = 'import'`)).rows[0].n, 0);
    await attempt(/a deletion log row records roster work/);
    // a replaced body, inside a transaction that is rolled back
    await c.query("begin");
    await c.query(`create or replace function training_load.session_undo_roster_work(p_alias uuid[]) returns jsonb as 'select null::jsonb' language sql`);
    await c.query("savepoint s");
    await assert.rejects(c.query(rollback), /body in force of training_load\.session_undo_roster_work is not v60's/);
    await c.query("rollback");
    assert.deepEqual(await catalogOf(c), before);
  } finally {
    await c.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/209912312359_later.sql'`).catch(() => {});
    await c.end();
  }
});

// ---------------------------------------------------------------------------
// The undo with roster work
// ---------------------------------------------------------------------------
test("1. states the import wrote never block: the preview lists them apart, the undo removes them without a confirmation, and the log records them", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9601);
  const athletes = (await needingState(team, s)).slice(0, 2);
  assert.equal(athletes.length, 2, "two athletes without device data");
  await writeImportStates(team, s, athletes);
  const before = await rosterRows(s.activityId);
  assert.deepEqual([before.decisions, before.requests, before.completions, before.completionLog], [2, 1, 1, 1]);

  const p = await preview(team, s);
  assert.equal(p.status, 200, p.text);
  const rw = p.body.undoPreview.rosterWork;
  assert.deepEqual(rw.importWritten, { decisions: 2, requests: 1, completions: 1, completionLog: 1, total: 5 });
  assert.equal(rw.laterWork.total, 0);
  assert.deepEqual(rw.laterWork.list, []);
  assert.equal(rw.laterWork.fingerprint, null);
  assert.equal(p.body.undoPreview.needsRosterConfirmation, false);
  assert.deepEqual(await rosterRows(s.activityId), before, "the preview keeps nothing");

  const u = await undoWith(team, s);
  assert.equal(u.status, 200, u.text);
  assert.deepEqual(u.body.undo.rosterWork.importWritten, rw.importWritten);
  const counts = u.body.undo.removedCounts;
  assert.deepEqual([counts.activity_athlete_decisions, counts.activity_roster_requests, counts.activity_completions, counts.activity_completion_log], [2, 1, 1, 1]);
  assert.deepEqual(await rosterRows(s.activityId), { decisions: 0, requests: 0, completions: 0, completionLog: 0 });
  const log = (await admin.query(`select roster_work_removed, removed_counts from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0];
  assert.deepEqual(log.roster_work_removed, {
    import_written: { decisions: 2, requests: 1, completions: 1, completion_log: 1 },
    later: { decisions: 0, requests: 0, completions: 0, completion_log: 0 },
    later_list: [], later_fingerprint: null, confirmed_by: null,
  });
  assert.deepEqual(log.removed_counts, counts);
});

test("2. an undo without any roster work writes no roster_work_removed and still lists the four tables at zero", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9602);
  const u = await undoWith(team, s);
  assert.equal(u.status, 200, u.text);
  const c = u.body.undo.removedCounts;
  assert.deepEqual([c.activity_athlete_decisions, c.activity_roster_requests, c.activity_completions, c.activity_completion_log], [0, 0, 0, 0]);
  assert.equal(u.body.undo.rosterWork.importWritten.total + u.body.undo.rosterWork.laterWork.total, 0);
  assert.equal((await admin.query(`select roster_work_removed from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0].roster_work_removed, null);
});

test("3. J20 states and a colleague's later change: refused without the confirmation (nothing removed), refused with a stale fingerprint, done with the listed one; the log holds both", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9603);
  const [x, y] = await needingState(team, s);
  await writeImportStates(team, s, [x, y]);
  // The coach changes one of the import's states in the Roster tab.
  const current = (await rosterOf(team, s)).athletes.find((a) => a.athleteId === x);
  const change = await rosterChange(team, s, x, { expectedDecisionId: current.decision.id });
  assert.equal(change.status, 200, JSON.stringify(change.body));
  const origins = (await admin.query(`select origin, count(*)::int n from training.activity_roster_requests where activity_id = $1 group by origin order by origin`, [s.activityId])).rows;
  assert.deepEqual(origins, [{ origin: "import", n: 1 }, { origin: "roster", n: 1 }], "the Roster tab's request is 'roster'");

  const p = await preview(team, s);
  assert.equal(p.status, 200, p.text);
  const rw = p.body.undoPreview.rosterWork;
  assert.equal(p.body.undoPreview.needsRosterConfirmation, true);
  assert.deepEqual([rw.importWritten.decisions, rw.importWritten.requests], [2, 1]);
  assert.deepEqual([rw.laterWork.decisions, rw.laterWork.requests], [1, 1]);
  assert.ok(rw.laterWork.completionLog >= 1);
  assert.equal(rw.laterWork.list.length, 1);
  const item = rw.laterWork.list[0];
  assert.deepEqual([item.athleteId, item.kind, item.reasonCode, item.byUserId], [x, "did_not_participate", "illness", team.coach.id]);
  assert.ok(item.athleteName && item.byName, "names for the administrator");
  assert.match(rw.laterWork.fingerprint, /^[0-9a-f]{64}$/);

  const rowsBefore = await allRowCounts();
  const plain = await undoWith(team, s);
  assert.deepEqual([plain.status, plain.body.error], [409, "roster_work_needs_confirmation"], plain.text);
  assert.equal(plain.body.rosterWork.laterWork.fingerprint, rw.laterWork.fingerprint);
  assert.equal(plain.body.rosterWork.laterWork.list[0].byName, item.byName);
  assert.deepEqual(await allRowCounts(), rowsBefore, "nothing was removed without the confirmation");

  const stale = await undoWith(team, s, { fingerprint: "0".repeat(64) });
  assert.deepEqual([stale.status, stale.body.error], [409, "roster_work_changed"], stale.text);
  assert.deepEqual(await allRowCounts(), rowsBefore, "nothing was removed with another fingerprint");

  const done = await undoWith(team, s, { fingerprint: rw.laterWork.fingerprint });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(await rosterRows(s.activityId), { decisions: 0, requests: 0, completions: 0, completionLog: 0 });
  assert.equal((await counts(team.teamId)).events, 0);
  const log = (await admin.query(`select roster_work_removed, deleted_by_user_id from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0];
  assert.equal(log.roster_work_removed.import_written.decisions, 2);
  assert.equal(log.roster_work_removed.later.decisions, 1);
  assert.equal(log.roster_work_removed.later_fingerprint, rw.laterWork.fingerprint);
  assert.equal(log.roster_work_removed.confirmed_by, team.padmin.id);
  assert.deepEqual(Object.keys(log.roster_work_removed.later_list[0]).sort(), ["at", "athlete", "by", "kind", "reason_code"]);
  assert.equal(log.roster_work_removed.later_list[0].by, team.coach.id);
});

test("4. only Roster-tab work: the coach's states are later work (the bounded list), and a complete counts as an entry of its own", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9604);
  const need = await needingState(team, s);
  for (const athleteId of need) assert.equal((await rosterChange(team, s, athleteId, { kind: "participated_no_values" })).status, 200);
  const roster = await rosterOf(team, s);
  const complete = await fetch(`${apiBase}/api/training-activity/${s.activityId}/roster/complete`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: team.coach.cookie },
    body: JSON.stringify({ requestKey: key(), expectedRevision: roster.completion.revision, expectedFingerprint: roster.rosterFingerprint }),
  });
  assert.equal(complete.status, 200, await complete.text());
  const p = await preview(team, s);
  const later = p.body.undoPreview.rosterWork.laterWork;
  assert.equal(p.body.undoPreview.rosterWork.importWritten.total, 0);
  assert.equal(later.decisions, need.length);
  assert.equal(later.requests, need.length + 1);
  assert.equal(later.list.length, need.length + 1);
  assert.equal(later.changes, need.length + 1, "the server's change count: every decision and the complete");
  assert.deepEqual(later.list.filter((i) => i.kind === "complete").map((i) => i.athleteId), [null]);
  const done = await undoWith(team, s, { fingerprint: later.fingerprint });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(await rosterRows(s.activityId), { decisions: 0, requests: 0, completions: 0, completionLog: 0 });
});

test("5. the list in the answer and the log is bounded at 60 while the counts and the fingerprint cover every later row", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9605);
  const [x] = await needingState(team, s);
  // 61 later decisions of one athlete, each superseding the previous (the chain is later work end to end).
  let current = null;
  for (let i = 0; i < 61; i += 1) {
    const r = await rosterChange(team, s, x, { kind: i % 2 ? "participated_no_values" : "did_not_participate", expectedDecisionId: current });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    current = (await admin.query(`select id from training.activity_athlete_decisions where activity_id = $1 and athlete_id = $2 and superseded_by_decision_id is null`, [s.activityId, x])).rows[0].id;
  }
  const p = await preview(team, s);
  const later = p.body.undoPreview.rosterWork.laterWork;
  assert.equal(later.decisions, 61);
  assert.equal(later.list.length, 60);
  assert.equal(later.changes, 61, "the count covers the rows past the list");
  const done = await undoWith(team, s, { fingerprint: later.fingerprint });
  assert.equal(done.status, 200, done.text);
  const log = (await admin.query(`select roster_work_removed r from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0].r;
  assert.equal(log.later.decisions, 61);
  assert.equal(log.later_list.length, 60);
});

test("6. a change between the preview and the confirmed undo: roster_work_changed, nothing removed; the new preview's fingerprint undoes", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9606);
  const [x, y] = await needingState(team, s);
  assert.equal((await rosterChange(team, s, x)).status, 200);
  const first = (await preview(team, s)).body.undoPreview.rosterWork.laterWork.fingerprint;
  assert.equal((await rosterChange(team, s, y, { kind: "participated_no_values" })).status, 200);
  const rowsBefore = await allRowCounts();
  const r = await undoWith(team, s, { fingerprint: first });
  assert.deepEqual([r.status, r.body.error], [409, "roster_work_changed"], r.text);
  assert.equal(r.body.rosterWork.laterWork.decisions, 2);
  assert.notEqual(r.body.rosterWork.laterWork.fingerprint, first);
  assert.deepEqual(await allRowCounts(), rowsBefore);
  const again = await undoWith(team, s, { fingerprint: r.body.rosterWork.laterWork.fingerprint });
  assert.equal(again.status, 200, again.text);
});

test("7. the request body: a fingerprint that is not 64 lowercase hex is 400 before anything is locked; a fingerprint sent while there is no later work is roster_work_changed, nothing removed", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9607);
  for (const fingerprint of ["abc", "A".repeat(64), 12, true, { x: 1 }]) {
    const r = await undoWith(team, s, { fingerprint });
    assert.deepEqual([r.status, r.body.error], [400, "invalid_request"], `${JSON.stringify(fingerprint)} ${r.text}`);
  }
  // The confirmation is the fingerprint itself: a list it confirms that is not there (no later work at all) is refused.
  const before = await rosterRows(s.activityId);
  const stray = await undoWith(team, s, { fingerprint: "a".repeat(64) });
  assert.deepEqual([stray.status, stray.body.error], [409, "roster_work_changed"], stray.text);
  assert.deepEqual(await rosterRows(s.activityId), before);
  assert.equal((await admin.query(`select count(*)::int n from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0].n, 0);
  // The function itself: a fingerprint that is not hex is 22023.
  await assert.rejects(admin.query(`select * from training_load.undo_imported_session($1, $2, $3, gen_random_uuid(), 'x', null, 'zz')`,
    [team.padmin.id, team.teamId, s.candidateId]), (e) => e.code === "22023");
  // Without a fingerprint the undo of a session without later work goes through.
  const ok = await undoWith(team, s);
  assert.equal(ok.status, 200, ok.text);
});

test("8. a replay of a confirmed undo answers the saved outcome with its roster work; the same key without the confirmation is request_key_reused", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9608);
  const [x] = await needingState(team, s);
  await writeImportStates(team, s, [x]);
  const [y] = (await needingState(team, s));
  assert.equal((await rosterChange(team, s, y)).status, 200);
  const fp = (await preview(team, s)).body.undoPreview.rosterWork.laterWork.fingerprint;
  const requestKey = key();
  const first = await undoWith(team, s, { requestKey, fingerprint: fp });
  assert.equal(first.status, 200, first.text);
  const replay = await undoWith(team, s, { requestKey, fingerprint: fp });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.body.undo.replayed, true);
  assert.deepEqual(replay.body.undo.rosterWork, first.body.undo.rosterWork);
  const reused = await undoWith(team, s, { requestKey });
  assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"], reused.text);
});

// ---------------------------------------------------------------------------
// The origin rule
// ---------------------------------------------------------------------------
test("9. origin 'import' is accepted only for an approval of this session by the same user, before the request; the plain roster routes never write it", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9609);
  const [x, y, z] = await needingState(team, s);
  const refused = async (fn, why) => {
    await assert.rejects(fn, (e) => e.code === "23514" && /origin import needs an approval/.test(e.message), why);
  };
  // another user (the coach approved nothing)
  await refused(writeImportStates(team, s, [x], { by: team.coach, basis: "team_coach" }), "the coach did not approve this import");
  // before the approval
  await refused(writeImportStates(team, s, [x], { createdAt: "2020-01-01T00:00:00Z" }), "a request older than the approval");
  // a team activity no approval wrote into
  const plain = (await admin.query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, started_at, origin, owner_scope, owner_team_id, created_by_user_id)
     values ('training_session','coach plan','2026-09-14','Europe/Sarajevo','2026-09-14T18:08:12Z','manual','team',$1,$2) returning id`, [team.teamId, team.padmin.id])).rows[0].id;
  await refused(admin.query(
    `insert into training.activity_roster_requests (activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin)
     values ($1, gen_random_uuid(), repeat('a', 64), 'decide', $2, '{}'::jsonb, 'import')`, [plain, team.padmin.id]), "an activity without an approval");
  // only a decide or decide_bulk may be import-origin (J20-C writes states, nothing else)
  for (const operation of ["complete", "reopen", "clear"]) {
    await assert.rejects(admin.query(
      `insert into training.activity_roster_requests (activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin)
       values ($1, gen_random_uuid(), repeat('a', 64), $2, $3, '{}'::jsonb, 'import')`, [s.activityId, operation, team.padmin.id]),
      (e) => e.code === "23514" && /only a decide or decide_bulk/.test(e.message), operation);
  }
  // the right user, after the approval, on this session: accepted
  await writeImportStates(team, s, [y]);
  // the plain route: whatever the body says, the request is 'roster'
  const change = await rosterChange(team, s, z, { extra: { origin: "import" } });
  assert.equal(change.status, 200, JSON.stringify(change.body));
  const rows = (await admin.query(`select origin, performed_by_user_id from training.activity_roster_requests where activity_id = $1 order by created_at`, [s.activityId])).rows;
  assert.deepEqual(rows.map((r) => r.origin), ["import", "roster"]);
  assert.equal(rows[1].performed_by_user_id, team.coach.id);
  // an unknown origin is the CHECK's
  await assert.rejects(admin.query(
    `insert into training.activity_roster_requests (activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin)
     values ($1, gen_random_uuid(), repeat('a', 64), 'decide', $2, '{}'::jsonb, 'csv')`, [s.activityId, team.padmin.id]), /activity_roster_requests_origin_check/);
});

test("10. alias set: an import-origin request on the canonical activity of a merged session is accepted; the undo of a merged session stays refused (entangled), nothing removed", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9610);
  const canonical = (await admin.query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, started_at, origin, owner_scope, owner_team_id, created_by_user_id)
     values ('training_session','merged session','2026-09-14','Europe/Sarajevo','2026-09-14T06:08:12Z','manual','team',$1,$2) returning id`, [team.teamId, team.padmin.id])).rows[0].id;
  // A merge is a state no route of this test builds in one step; the imported activity is pointed at the canonical one with the
  // activity triggers off for that one statement, in its own transaction.
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  await admin.query(`update training.activities set superseded_by_activity_id = $2, lifecycle_state = 'superseded' where id = $1`, [s.activityId, canonical]);
  await admin.query("commit");
  await admin.query(
    `insert into training.activity_roster_requests (activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin)
     values ($1, gen_random_uuid(), repeat('b', 64), 'decide', $2, '{}'::jsonb, 'import')`, [canonical, team.padmin.id]);
  const rowsBefore = await allRowCounts();
  const r = await undoWith(team, s);
  assert.deepEqual([r.status, r.body.error], [409, "entangled_activity"], r.text);
  assert.deepEqual(await allRowCounts(), rowsBefore);
});

// ---------------------------------------------------------------------------
// The guards outside the undo
// ---------------------------------------------------------------------------
test("11. outside the undo every roster row stays protected: DELETE, UPDATE and TRUNCATE are refused, and a session-level marker does not open them", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9611);
  const [x] = await needingState(team, s);
  await writeImportStates(team, s, [x]);
  const c = await newClient();
  try {
    for (const [table, pattern] of [
      ["training.activity_athlete_decisions", /append-only; a decision is superseded, never deleted/],
      ["training.activity_completion_log", /activity_completion_log is append-only \(DELETE refused\)/],
      ["training.activity_completions", /completion of activity .* is never deleted/],
      ["training.activity_roster_requests", /activity_roster_requests is append-only \(DELETE refused\)/],
    ]) {
      await assert.rejects(c.query(`delete from ${table} where activity_id = $1`, [s.activityId]), pattern, table);
      await c.query("begin");
      await c.query(`select set_config('optimove.session_undo_tx', txid_current()::text, false)`);
      await c.query("commit");
      await assert.rejects(c.query(`delete from ${table} where activity_id = $1`, [s.activityId]), pattern, `${table}: a marker of another transaction`);
      await c.query(`select set_config('optimove.session_undo_tx', '', false)`);
      await assert.rejects(c.query(`truncate ${table} cascade`), /keeps history; TRUNCATE refused/, `${table}: TRUNCATE`);
    }
    await c.query("begin");
    await c.query(`select set_config('optimove.session_undo_tx', txid_current()::text, true)`);
    await assert.rejects(c.query(`update training.activity_roster_requests set origin = 'roster' where activity_id = $1`, [s.activityId]), /append-only \(UPDATE refused\)/, "an UPDATE stays refused under the marker");
    await c.query("rollback");
  } finally {
    await c.end();
  }
  assert.deepEqual(await rosterRows(s.activityId), { decisions: 1, requests: 1, completions: 1, completionLog: 1 });
});

test("12. the deletion log's closed shape: a note, a 61-entry list, later work without its confirmer or with another one, empty counts and a stray key are refused", async () => {
  const team = await setupTeam();
  const conn = (await admin.query(`select id from training_load.metric_source_connections order by id limit 1`)).rows[0].id;
  const zero = { decisions: 0, requests: 0, completions: 0, completion_log: 0 };
  const entry = { athlete: crypto.randomUUID(), kind: "did_not_participate", reason_code: "illness", by: team.coach.id, at: "2026-11-10T10:00:00.123+00:00" };
  const good = { import_written: zero, later: { ...zero, decisions: 1 }, later_list: [entry], later_fingerprint: "c".repeat(64), confirmed_by: team.padmin.id };
  const insert = (rw) => admin.query(
    `insert into training_load.import_deletion_log (deleted_by_user_id, authorized_via, reason, event_id, source_system, source_connection_id, source_external_id,
       owner_team_id, occurred_date, removed_counts, removed_total, roster_work_removed)
     values ($1, 'platform_admin', 'shape test', gen_random_uuid(), 'gpexe', $2, 'team_session:1', $3, '2026-09-14', '{"metric_events":1}', 1, $4)`,
    [team.padmin.id, conn, team.teamId, rw === undefined ? null : JSON.stringify(rw)]);
  for (const [why, rw] of [
    ["a note in an entry", { ...good, later_list: [{ ...entry, note: "free text" }] }],
    ["61 entries", { ...good, later: { ...zero, decisions: 61 }, later_list: Array.from({ length: 61 }, () => entry) }],
    ["later work without its confirmer", { ...good, confirmed_by: null }],
    ["later work confirmed by another user", { ...good, confirmed_by: team.coach.id }],
    ["later work without a fingerprint", { ...good, later_fingerprint: null }],
    ["nothing removed", { ...good, later: zero, later_list: [], later_fingerprint: null, confirmed_by: null }],
    ["a stray key", { ...good, extra: 1 }],
    ["an unknown kind", { ...good, later_list: [{ ...entry, kind: "deleted" }] }],
    ["a non-integer count", { ...good, later: { ...zero, decisions: 1.5 } }],
    ["entries without later work", { ...good, import_written: { ...zero, decisions: 1 }, later: zero, later_fingerprint: null, confirmed_by: null }],
  ]) {
    await assert.rejects(insert(rw), (e) => e.code === "23514" && /closed shape/.test(e.message), why);
  }
  await insert(good);
  await insert(undefined);
  await assert.rejects(admin.query(`update training_load.import_deletion_log set roster_work_removed = null where reason = 'shape test'`), /append-only/);
});

// ---------------------------------------------------------------------------
// Concurrency: an undo and a roster command of the same team wait for each other, in both orders
// ---------------------------------------------------------------------------
test("13. undo first: a Roster-tab change waits for the undo's team lock and then finds no session; nothing of it is written", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9613);
  const [x, y] = await needingState(team, s);
  assert.equal((await rosterChange(team, s, x)).status, 200);
  const fp = (await preview(team, s)).body.undoPreview.rosterWork.laterWork.fingerprint;
  const c = await newClient();
  try {
    await c.query("begin");
    const r = (await c.query(`select * from training_load.undo_imported_session($1, $2, $3, gen_random_uuid(), 'o1 order test', $4, $5)`,
      [team.padmin.id, team.teamId, s.candidateId, s.eventId, fp])).rows[0];
    assert.equal(r.removed_counts.activity_athlete_decisions, 1);
    let settled = false;
    const change = rosterChange(team, s, y).finally(() => { settled = true; });
    await sleep(400);
    assert.equal(settled, false, "the roster command waits for the team's import lock");
    await c.query("commit");
    const answer = await change;
    // The command found the activity before it waited; after the undo's COMMIT the session has no participant left, so
    // v44's gate answers that it has no roster (a definite refusal, never a write).
    assert.deepEqual([answer.status, answer.body?.error], [409, "roster_not_applicable"], JSON.stringify(answer));
    assert.ok(!/40P01|deadlock/i.test(JSON.stringify(answer.body)));
  } finally {
    await c.end();
  }
  assert.deepEqual(await rosterRows(s.activityId), { decisions: 0, requests: 0, completions: 0, completionLog: 0 });
});

test("14. roster first: the undo waits for the command's team lock, sees its change, and refuses the stale confirmation; the fresh one undoes", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9614);
  const [x, y] = await needingState(team, s);
  assert.equal((await rosterChange(team, s, x)).status, 200);
  const fp = (await preview(team, s)).body.undoPreview.rosterWork.laterWork.fingerprint;
  const commands = await import("../src/activityRosterCommands.js");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const inside = new Promise((resolve) => { reached = resolve; });
  commands.setRosterCommandTestHooks({ beforeCommit: async () => { reached(); await gate; } });
  try {
    const change = rosterChange(team, s, y);
    await inside;
    let settled = false;
    const u = undoWith(team, s, { fingerprint: fp }).finally(() => { settled = true; });
    await sleep(400);
    assert.equal(settled, false, "the undo waits for the roster command's team lock");
    release();
    assert.equal((await change).status, 200);
    const answer = await u;
    assert.deepEqual([answer.status, answer.body.error], [409, "roster_work_changed"], answer.text);
    assert.equal(answer.body.rosterWork.laterWork.decisions, 2);
  } finally {
    commands.setRosterCommandTestHooks(null);
    release();
  }
  assert.equal((await rosterRows(s.activityId)).decisions, 2);
  const fresh = (await preview(team, s)).body.undoPreview.rosterWork.laterWork.fingerprint;
  assert.equal((await undoWith(team, s, { fingerprint: fresh })).status, 200);
});

// ---------------------------------------------------------------------------
// The function, the migration and its runbooks
// ---------------------------------------------------------------------------
test("15. the signature: the six-argument v57 function is gone, the seven-argument one is the only one, and the service calls it with seven arguments", async () => {
  const rows = (await admin.query(
    `select pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'training_load' and p.proname = 'undo_imported_session'`)).rows;
  assert.deepEqual(rows.map((r) => r.a), ["p_actor uuid, p_team uuid, p_candidate uuid, p_request_key uuid, p_reason text, p_expected_event uuid, p_later_roster_fingerprint text"]);
  assert.equal((await admin.query(`select to_regprocedure('training_load.undo_imported_session(uuid,uuid,uuid,uuid,text,uuid)') r`)).rows[0].r, null);
  const source = fs.readFileSync(new URL("../src/gpexeSessionUndoService.js", import.meta.url), "utf8");
  assert.equal(source.split("training_load.undo_imported_session(").length - 1, 2, "two calls");
  assert.ok(source.includes("undo_imported_session($1, $2, $3, gen_random_uuid(), 'preview', null, $4)"), "the preview: seven arguments");
  assert.ok(source.includes("undo_imported_session($1, $2, $3, $4, $5, $6, $7)"), "the undo: seven arguments");
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
const sliceTo = (needle) => GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes(needle)) + 1);
const withoutV60 = () => GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes("v60")));

test("16. migration v60: the preflight passes on v59, the post-check on v60, the rollback restores v59 exactly (catalog identical) and the migration applies again", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "o1rb", migrations: withoutV60() });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    const pre = await booleansOf(client, fs.readFileSync(RUNBOOK("undo-roster-work-v60-preflight.sql"), "utf8"));
    assert.ok(pre.length >= 10, `the preflight returned its booleans (${pre.length})`);
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok on a v59 database");
    const v59Catalog = await catalogOf(client);
    await applyGpexeTestMigrations(rb.url, sliceTo("v60"));
    const post = await booleansOf(client, fs.readFileSync(RUNBOOK("undo-roster-work-v60-postcheck.sql"), "utf8"));
    assert.ok(post.length >= 10, `the post-check returned its booleans (${post.length})`);
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok on a v60 database");
    const v60Catalog = await catalogOf(client);
    assert.notDeepEqual(v60Catalog, v59Catalog);
    // The post-check and the rollback name the v60 bodies in force.
    const bodies = (await client.query(`select md5(p.prosrc) m from pg_proc p where p.proname in ('undo_imported_session', 'session_undo_scope', 'session_undo_roster_work', 'session_undo_roster_log_ok')`)).rows.map((r) => r.m);
    assert.equal(bodies.length, 4);
    for (const m of bodies) {
      assert.match(fs.readFileSync(RUNBOOK("undo-roster-work-v60-postcheck.sql"), "utf8"), new RegExp(m));
      assert.match(fs.readFileSync(RUNBOOK("undo-roster-work-v60-rollback.sql"), "utf8"), new RegExp(m));
    }
    await client.query(fs.readFileSync(RUNBOOK("undo-roster-work-v60-rollback.sql"), "utf8"));
    assert.deepEqual(await catalogOf(client), v59Catalog, "the rollback restores the v59 catalog exactly");
    assert.equal((await client.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V60])).rows[0].n, 0);
    await applyGpexeTestMigrations(rb.url, sliceTo("v60"));
    assert.deepEqual(await catalogOf(client), v60Catalog, "re-applied: the same catalog");
  } finally {
    await client.end();
    await rb.drop();
  }
});

test("18. the md5 gate: the migration refuses to run, changing nothing, when a body it replaces is not the one it expects", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "o1gate", migrations: withoutV60() });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    for (const fn of ["training_load.session_undo_scope", "training.protect_activity_roster_request", "training_load.validate_import_deletion_log", "training.check_activity_athlete_decision"]) {
      const original = (await client.query(`select pg_get_functiondef(to_regproc($1)) d`, [fn])).rows[0].d;
      const changed = original.replace(/\$function\$\s*\n/, "$function$\n-- changed\n");
      assert.notEqual(changed, original);
      await client.query(changed);
      await assert.rejects(client.query(fs.readFileSync(new URL(`../../${V60}`, import.meta.url), "utf8")), /v60 refused: the body in force of/, fn);
      assert.equal((await client.query(`select count(*)::int n from information_schema.columns where table_name = 'activity_roster_requests' and column_name = 'origin'`)).rows[0].n, 0, "a refused run changes nothing");
      await client.query(original);
    }
    await applyGpexeTestMigrations(rb.url, sliceTo("v60"));
    assert.equal((await client.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V60])).rows[0].n, 1);
  } finally {
    await client.end();
    await rb.drop();
  }
});

test("19. lock order: the roster rows are removed after the marker (the first write), and no locking clause follows it", async () => {
  const body = (await admin.query(`select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = 'undo_imported_session'`)).rows[0].prosrc;
  const firstWrite = body.indexOf("perform set_config('optimove.session_undo_tx'");
  const lastLock = body.lastIndexOf("for update");
  assert.ok(firstWrite > 0 && lastLock > 0 && lastLock < firstWrite);
  const removal = body.indexOf("delete from training.activity_athlete_decisions");
  assert.ok(removal > firstWrite, "the roster rows go under the marker");
  const order = ["delete from training.activity_athlete_decisions", "delete from training.activity_completion_log", "delete from training.activity_completions",
    "delete from training.activity_roster_requests", "delete from training.activities "].map((n) => body.indexOf(n));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "decisions -> completion log -> completions -> requests -> activities");
  assert.doesNotMatch(body.slice(firstWrite), /\bfor (update|share|no key update)\b|pg_advisory|\block table\b/i);
  // The confirmation check runs after every lock and before the first write.
  const check = body.indexOf("roster_work_needs_confirmation");
  assert.ok(check > lastLock && check < firstWrite);
});

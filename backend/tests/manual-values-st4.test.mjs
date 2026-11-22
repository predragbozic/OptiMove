// ST-4 (docs/ai/session-type-plan.md section 7, 13 Q3): manual values on the roster - an entry for an athlete without a
// device record, a correction of a measured value, the restore of the measured values - migration v88's provenance table
// and guards, the roster's states, and the undo that removes manual values only after a confirmation that lists them.
// Disposable databases; the imports are the real approvals through the routes.
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

const MIGRATIONS = GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events"));
const V88_FILE = "202611221300_training_load_v88_manual_values.sql";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const ORIGINAL_ESTIMATES = process.env.ESTIMATES_ENABLED;
const ORIGINAL_FLAG = process.env.MANUAL_VALUES_ENABLED;
const D1 = "2026-09-14";
let src;
let connections;
let resolver;
let db;
let admin;
let server;
let apiBase;
let service;
let manual;
let createSession;
let appPool;

before(async () => {
  assert.equal(MIGRATIONS[MIGRATIONS.length - 1], V88_FILE, "v88 is the last migration of this suite");
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "st4", migrations: MIGRATIONS });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  delete process.env.MANUAL_VALUES_ENABLED;
  process.env.ESTIMATES_ENABLED = "true";
  process.env.SOURCE_CREDENTIAL_KEYS = (await import("../src/sourceCredentialCrypto.js")).generateKeyEntry(1);
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  manual = await import("../src/manualValueService.js");
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
  manual?.setManualValueTestHooks(null);
  service?.setGpexeClientFactory(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  const restore = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  restore("SOURCE_CREDENTIAL_KEYS", ORIGINAL_KEYS);
  restore("ESTIMATES_ENABLED", ORIGINAL_ESTIMATES);
  restore("MANUAL_VALUES_ENABLED", ORIGINAL_FLAG);
  restore("GPEXE_IMPORT_APPLY_ENABLED", ORIGINAL_SWITCH);
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

async function call(base, path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const api = (path, opts) => call("/api/training-load/gpexe", path, opts);
const tapi = (path, opts) => call("/api/training-activity", path, opts);

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

function athleteSpec(id) {
  const std = Object.fromEntries(standardAthletes().map((a) => [a.id, a]));
  if (std[id]) return structuredClone(std[id]);
  const a = structuredClone(std[102]);
  a.id = id;
  a.parts = a.parts.map((p) => ({ ...p, time: 1300, distance: 1800 }));
  return a;
}
function bundleOf({ sessionId, hour = 10, ids, distances = {} }) {
  const athletes = ids.map((id, i) => {
    const a = athleteSpec(id);
    if (distances[id] !== undefined) a.parts = a.parts.map((p) => ({ ...p, distance: distances[id] }));
    a.tracks = [sessionId * 10 + i];
    for (const part of a.parts) delete part.track;
    return a;
  });
  return makeFixtureBundle({ detailsDrills: [0, 1], sessionId, gpexeTeamId: 77, start: `2026-09-14T${String(hour).padStart(2, "0")}:08:12`, updatedOn: "2026-09-14T20:18:09.337", athletes });
}

let nextGpexeTeamId = 8400;
// Ana (101), Bea (102), Cil (104) have device records; Eva and Fil are on the roster without one.
async function setupTeam() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["Ana", "Bea", "Cil", "Dan", "Eva", "Fil"] });
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
  const [a, b, c] = org.athleteIds;
  for (const [gpexeAthleteId, athleteId] of [["101", a], ["102", b], ["104", c]]) {
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

async function importSession(team, bundle) {
  await checkNow(team, [bundle]);
  const list = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates;
  const cand = list.find((c) => c.gpexeTeamSessionId === String(bundle.teamSession.id) && c.status === "pending");
  assert.ok(cand, "a pending candidate");
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  let r;
  try {
    r = await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } } });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.results[0].outcome, "imported", r.text);
  const approval = (await admin.query(`select metric_event_id, activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0];
  return { candidateId: cand.id, eventId: String(approval.metric_event_id), activityId: String(approval.activity_id) };
}

const key = () => crypto.randomUUID();
const [ANA, BEA, CIL, , EVA, FIL] = [0, 1, 2, 3, 4, 5];
const form = (s, athleteId, cookie) => tapi(`/${s.activityId}/manual-values?athleteId=${athleteId}`, { cookie });
const saveValues = (s, body, cookie) => tapi(`/${s.activityId}/manual-values`, { method: "POST", cookie, body: { requestKey: key(), ...body } });
const restore = (s, body, cookie) => tapi(`/${s.activityId}/manual-values/restore`, { method: "POST", cookie, body: { requestKey: key(), ...body } });
const roster = async (s, cookie) => (await tapi(`/${s.activityId}/roster`, { cookie })).body;
const rowOf = (r, athleteId) => r.athletes.find((a) => a.athleteId === String(athleteId));

const writes = async (teamId) => (await admin.query(
  `select (select count(*) from training_load.metric_manual_values)::int as provenance,
          (select count(*) from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id
            join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1)::int as occasions,
          (select count(*) from training_load.metric_event_participants p join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1)::int as participants`,
  [teamId],
)).rows[0];

let world;
async function sessionWorld() {
  if (world) return world;
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9701, ids: [101, 102, 104] }));
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  const time = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE time min %'`)).rows[0].id);
  world = { team, s, distance, time };
  return world;
}

async function needsState(activityId) {
  return (await admin.query(`select athlete_id from training.activity_roster_needs_state($1)`, [activityId])).rows.map((r) => String(r.athlete_id));
}

test("1. the flag off ('false'): the form, the save and the restore are the identical 404 for everyone; nothing is written; the roster does not offer them", async () => {
  const { team, s, distance } = await sessionWorld();
  const before = await writes(team.teamId);
  process.env.MANUAL_VALUES_ENABLED = "false";
  try {
    const f = await form(s, team.athleteIds[EVA], team.coach.cookie);
    const w = await saveValues(s, { athleteId: team.athleteIds[EVA], values: [{ metricDefinitionId: distance, value: 1000 }] }, team.coach.cookie);
    const r = await restore(s, { athleteId: team.athleteIds[ANA], expectedOccasionId: crypto.randomUUID() }, team.coach.cookie);
    for (const x of [f, w, r]) assert.deepEqual([x.status, x.body], [404, { error: "notFound" }]);
    // A malformed body too: the flag is checked before anything of the request.
    for (const body of [{}, { athleteId: "x" }, { requestKey: "bad" }]) {
      for (const path of ["/manual-values", "/manual-values/restore"]) {
        const x = await tapi(`/${s.activityId}${path}`, { method: "POST", cookie: team.coach.cookie, body });
        assert.deepEqual([x.status, x.body], [404, { error: "notFound" }], `${path} ${JSON.stringify(body)}`);
      }
    }
    assert.equal((await roster(s, team.coach.cookie)).viewer.manualValues, undefined);
  } finally {
    delete process.env.MANUAL_VALUES_ENABLED;
  }
  assert.equal((await roster(s, team.coach.cookie)).viewer.manualValues, true, "on by default");
  assert.deepEqual(await writes(team.teamId), before);
});

test("2. the audience: the team's coach, the club's admin and a platform admin; another team's coach, a coach in another workspace and a user without a role get the identical 404 and write nothing", async () => {
  const { team, s, distance } = await sessionWorld();
  for (const who of [team.coach, team.cadmin, team.padmin]) {
    const r = await form(s, team.athleteIds[EVA], who.cookie);
    assert.equal(r.status, 200, r.text);
  }
  const other = await createGpexePilotOrg(admin, { athleteNames: ["Zed"] });
  const foreign = await coachOf(other.teamId, "foreign");
  const wrongWorkspace = await coachOf(team.teamId, "elsewhere");
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [wrongWorkspace.id, other.teamId]);
  await setWorkspace(wrongWorkspace.id, "team", other.teamId);
  const nobody = { cookie: `optimove_session=${await createSession(await makeUser("nobody"))}` };
  const missing = await tapi(`/${crypto.randomUUID()}/manual-values?athleteId=${team.athleteIds[EVA]}`, { cookie: team.coach.cookie });
  assert.deepEqual([missing.status, missing.body], [404, { error: "notFound" }]);
  const before = await writes(team.teamId);
  for (const who of [foreign, wrongWorkspace, nobody]) {
    const f = await form(s, team.athleteIds[EVA], who.cookie);
    const w = await saveValues(s, { athleteId: team.athleteIds[EVA], values: [{ metricDefinitionId: distance, value: 1000 }] }, who.cookie);
    const r = await restore(s, { athleteId: team.athleteIds[ANA], expectedOccasionId: crypto.randomUUID() }, who.cookie);
    for (const x of [f, w, r]) assert.deepEqual([x.status, x.body], [404, { error: "notFound" }]);
  }
  assert.deepEqual(await writes(team.teamId), before, "nothing was written");
  // A revoked role: the identical 404.
  const revoked = await coachOf(team.teamId, "revoked");
  await admin.query(`update public.user_team_roles set is_active = false where user_id = $1`, [revoked.id]);
  for (const x of [await form(s, team.athleteIds[EVA], revoked.cookie), await saveValues(s, { athleteId: team.athleteIds[EVA], values: [{ metricDefinitionId: distance, value: 1 }] }, revoked.cookie)]) {
    assert.deepEqual([x.status, x.body], [404, { error: "notFound" }]);
  }
  // Another team's athlete answers exactly like an unknown one; another club's variable like an unknown one.
  const foreignAthlete = other.athleteIds[0];
  const a1 = await saveValues(s, { athleteId: foreignAthlete, values: [{ metricDefinitionId: distance, value: 1 }] }, team.coach.cookie);
  const a2 = await saveValues(s, { athleteId: crypto.randomUUID(), values: [{ metricDefinitionId: distance, value: 1 }] }, team.coach.cookie);
  assert.deepEqual([a1.status, a1.body.error], [409, "athlete_not_on_roster"]);
  assert.deepEqual([a1.status, a1.body], [a2.status, a2.body]);
  const clubVar = (await admin.query(
    `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id)
     values ('st4_other_club_' || substr(md5(random()::text), 1, 8), 'Other club variable', 'club', $1) returning id`, [other.clubId],
  )).rows[0].id;
  const v1 = await saveValues(s, { athleteId: team.athleteIds[EVA], values: [{ metricDefinitionId: String(clubVar), value: 1 }] }, team.coach.cookie);
  const v2 = await saveValues(s, { athleteId: team.athleteIds[EVA], values: [{ metricDefinitionId: crypto.randomUUID(), value: 1 }] }, team.coach.cookie);
  assert.deepEqual([v1.status, v1.body.error], [409, "variable_not_in_session"]);
  assert.deepEqual([v1.status, v1.body], [v2.status, v2.body]);
  assert.deepEqual(await writes(team.teamId), before, "still nothing was written");
});

test("3. an entry for an athlete without a device record: a manual occasion of its own with its provenance (who, when, on which right); the roster says Manual values, by whom; the athlete no longer needs a state; a replay answers the same and a reused key with another body is refused", async () => {
  const { team, s, distance } = await sessionWorld();
  const eva = team.athleteIds[EVA];
  assert.ok((await needsState(s.activityId)).includes(eva), "before: Eva needs a state");
  const f = await form(s, eva, team.coach.cookie);
  assert.equal(f.status, 200, f.text);
  assert.equal(f.body.mode, "entry");
  assert.equal(f.body.expectedOccasionId, null);
  assert.ok(f.body.variables.some((v) => v.metricDefinitionId === distance && v.editable && v.value === null));
  const body = { requestKey: key(), athleteId: eva, values: [{ metricDefinitionId: distance, value: 2345.5 }], note: "no vest today" };
  const w = await tapi(`/${s.activityId}/manual-values`, { method: "POST", cookie: team.coach.cookie, body });
  assert.equal(w.status, 201, w.text);
  assert.equal(w.body.kind, "entry");
  assert.equal(w.body.activityId, s.activityId);
  assert.deepEqual(w.body.enteredBy, { userId: String(team.coach.id), basis: "team_coach" });
  assert.deepEqual(w.body.values.map((v) => [v.metricDefinitionId, v.value]), [[distance, 2345.5]]);
  const occ = (await admin.query(`select entry_method, source_identity_id, recorded_by_user_id from training_load.metric_measurement_occasions where id = $1`, [w.body.occasionId])).rows[0];
  assert.deepEqual([occ.entry_method, occ.source_identity_id, String(occ.recorded_by_user_id)], ["manual", null, String(team.coach.id)], "a manual occasion, never a source value");
  const prov = (await admin.query(`select kind, entered_by_basis, note from training_load.metric_manual_values where occasion_id = $1`, [w.body.occasionId])).rows[0];
  assert.deepEqual(prov, { kind: "entry", entered_by_basis: "team_coach", note: "no vest today" });
  const row = rowOf(await roster(s, team.coach.cookie), eva);
  assert.equal(row.state, "manual_values");
  assert.equal(row.group, "done");
  assert.equal(row.manual.kind, "entry");
  assert.equal(row.manual.enteredBy.name, "coach");
  assert.ok(!(await needsState(s.activityId)).includes(eva), "after: Eva has a state (v88's needs-state)");
  // The replay and a reused key.
  const before = await writes(team.teamId);
  const again = await tapi(`/${s.activityId}/manual-values`, { method: "POST", cookie: team.coach.cookie, body });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, w.body);
  const reused = await tapi(`/${s.activityId}/manual-values`, { method: "POST", cookie: team.coach.cookie, body: { ...body, values: [{ metricDefinitionId: distance, value: 1 }] } });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, "request_key_reused");
  assert.deepEqual(await writes(team.teamId), before);
  // A replay is authorised again: once the author's role is revoked, the same request is the identical 404, not the answer.
  await admin.query(`update public.user_team_roles set is_active = false where user_id = $1`, [team.coach.id]);
  try {
    const afterRevoke = await tapi(`/${s.activityId}/manual-values`, { method: "POST", cookie: team.coach.cookie, body });
    assert.deepEqual([afterRevoke.status, afterRevoke.body], [404, { error: "notFound" }]);
  } finally {
    await admin.query(`update public.user_team_roles set is_active = true where user_id = $1`, [team.coach.id]);
  }
});

test("4. (after 3) a second entry supersedes the first (kept as history, named as replaced) and carries over the values it does not name; a stale expectedOccasionId writes nothing (values_changed); a variable the session does not measure is refused", async () => {
  const { team, s, distance, time } = await sessionWorld();
  const eva = team.athleteIds[EVA];
  const f = await form(s, eva, team.cadmin.cookie);
  assert.equal(f.body.mode, "entry");
  const firstId = f.body.expectedOccasionId;
  assert.ok(firstId);
  const stale = await saveValues(s, { athleteId: eva, expectedOccasionId: null, values: [{ metricDefinitionId: distance, value: 9 }] }, team.cadmin.cookie);
  assert.deepEqual([stale.status, stale.body.error], [409, "values_changed"]);
  const unknownVar = await saveValues(s, { athleteId: eva, expectedOccasionId: firstId, values: [{ metricDefinitionId: crypto.randomUUID(), value: 9 }] }, team.cadmin.cookie);
  assert.deepEqual([unknownVar.status, unknownVar.body.error], [409, "variable_not_in_session"]);
  const w = await saveValues(s, { athleteId: eva, expectedOccasionId: firstId, values: [{ metricDefinitionId: distance, value: 2400 }] }, team.cadmin.cookie);
  assert.equal(w.status, 201, w.text);
  assert.equal(w.body.replacedOccasionId, firstId);
  assert.equal(w.body.enteredBy.basis, "club_admin");
  const old = (await admin.query(`select superseded_by_occasion_id from training_load.metric_measurement_occasions where id = $1`, [firstId])).rows[0];
  assert.equal(String(old.superseded_by_occasion_id), w.body.occasionId, "the first entry is kept, superseded");
  const row = rowOf(await roster(s, team.coach.cookie), eva);
  assert.equal(row.manual.enteredBy.basis, "club_admin");
  assert.deepEqual(row.values.filter((v) => v.entryMethod === "manual").map((v) => v.value), [2400]);
  // Two values, then a later entry naming only one: the other is carried over, never lost.
  const both = await saveValues(s, { athleteId: eva, expectedOccasionId: w.body.occasionId, values: [{ metricDefinitionId: time, value: 41 }] }, team.cadmin.cookie);
  assert.equal(both.status, 201, both.text);
  assert.deepEqual(both.body.values.map((v) => [v.metricDefinitionId, v.value]).sort(), [[distance, 2400], [time, 41]].sort());
  const one = await saveValues(s, { athleteId: eva, expectedOccasionId: both.body.occasionId, values: [{ metricDefinitionId: distance, value: 2500 }] }, team.cadmin.cookie);
  assert.equal(one.status, 201, one.text);
  assert.deepEqual(one.body.values.map((v) => [v.metricDefinitionId, v.value]).sort(), [[distance, 2500], [time, 41]].sort(), "time carried over");
});

test("5. an entry replaces an estimate of the same variable (v63's M3); the estimate stays as history", async () => {
  const { team, s, distance } = await sessionWorld();
  const fil = team.athleteIds[FIL];
  const est = await tapi(`/${s.activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), athleteId: fil, method: "team_average" } });
  assert.equal(est.status, 201, est.text);
  const estDistance = est.body.estimates.find((e) => e.metricDefinitionId === distance);
  assert.ok(estDistance, "a distance estimate");
  const f = await form(s, fil, team.coach.cookie);
  assert.equal(f.body.mode, "entry");
  assert.equal(f.body.variables.find((v) => v.metricDefinitionId === distance).estimatedValue, estDistance.value);
  const w = await saveValues(s, { athleteId: fil, values: [{ metricDefinitionId: distance, value: 1999 }] }, team.coach.cookie);
  assert.equal(w.status, 201, w.text);
  const sup = (await admin.query(`select superseded_by_occasion_id from training_load.metric_measurement_occasions where id = $1`, [estDistance.occasionId])).rows[0];
  assert.equal(String(sup.superseded_by_occasion_id), w.body.occasionId);
  assert.equal(rowOf(await roster(s, team.coach.cookie), fil).state, "manual_values");
});

test("6. a correction of a measured value: the measured occasion is kept as superseded, the manual one is the record's current occasion with every other value copied; the roster shows Measured, corrected, with the measured value; nothing_changed and a variable outside the record are refused", async () => {
  const { team, s, distance } = await sessionWorld();
  const ana = team.athleteIds[ANA];
  const f = await form(s, ana, team.padmin.cookie);
  assert.equal(f.status, 200, f.text);
  assert.equal(f.body.mode, "correction");
  assert.equal(f.body.canRestore, false);
  const measuredId = f.body.expectedOccasionId;
  const dist = f.body.variables.find((v) => v.metricDefinitionId === distance);
  assert.equal(dist.value, dist.measuredValue);
  const same = await saveValues(s, { athleteId: ana, expectedOccasionId: measuredId, values: [{ metricDefinitionId: distance, value: dist.value }] }, team.padmin.cookie);
  assert.deepEqual([same.status, same.body.error], [409, "nothing_changed"]);
  const outside = await saveValues(s, { athleteId: ana, expectedOccasionId: measuredId, values: [{ metricDefinitionId: crypto.randomUUID(), value: 1 }] }, team.padmin.cookie);
  assert.deepEqual([outside.status, outside.body.error], [409, "variable_not_in_record"]);
  const before = (await admin.query(`select count(*)::int n from training_load.metric_values where occasion_id = $1 and not is_derived`, [measuredId])).rows[0].n;
  const w = await saveValues(s, { athleteId: ana, expectedOccasionId: measuredId, values: [{ metricDefinitionId: distance, value: dist.value + 111 }] }, team.padmin.cookie);
  assert.equal(w.status, 201, w.text);
  assert.equal(w.body.kind, "correction");
  assert.equal(w.body.enteredBy.basis, "platform_admin");
  assert.equal(w.body.values.find((v) => v.metricDefinitionId === distance).measuredValue, dist.value);
  const occ = (await admin.query(
    `select o.entry_method, o.source_identity_id, si.current_occasion_id, m.superseded_by_occasion_id as measured_superseded_by, m.entry_method as measured_method
       from training_load.metric_measurement_occasions o
       join training_load.metric_source_identities si on si.id = o.source_identity_id
       join training_load.metric_measurement_occasions m on m.id = $2
      where o.id = $1`, [w.body.occasionId, measuredId])).rows[0];
  assert.equal(occ.entry_method, "manual");
  assert.equal(String(occ.current_occasion_id), w.body.occasionId, "the record's current occasion");
  assert.equal(String(occ.measured_superseded_by), w.body.occasionId, "the measured occasion is kept, superseded");
  assert.equal(occ.measured_method, "api_import");
  assert.equal((await admin.query(`select count(*)::int n from training_load.metric_values where occasion_id = $1 and not is_derived`, [w.body.occasionId])).rows[0].n, before, "every value copied");
  // Every semantic column is carried over (a whole-session GPEXE value is source_rollup / complete), and a value the coach
  // did not change keeps its stored text exactly.
  const differs = (await admin.query(
    `select a.metric_definition_id, (a.value_numeric::text = b.value_numeric::text) as same_value
       from training_load.metric_values a
       join training_load.metric_values b on b.metric_definition_id = a.metric_definition_id and b.occasion_id = $2 and not b.is_derived
      where a.occasion_id = $1 and not a.is_derived
        and ((a.aggregation_role, a.coverage, a.metric_definition_version_id, a.unit_at_capture)
               is distinct from (b.aggregation_role, b.coverage, b.metric_definition_version_id, b.unit_at_capture)
             or (a.metric_definition_id <> $3 and a.value_numeric::text is distinct from b.value_numeric::text))`,
    [w.body.occasionId, measuredId, distance])).rows;
  assert.deepEqual(differs, [], "role, coverage, version, unit and untouched values are the measured ones");
  assert.ok((await admin.query(`select count(*)::int n from training_load.metric_values where occasion_id = $1 and aggregation_role = 'source_rollup'`, [measuredId])).rows[0].n > 0, "the measured whole-session values are source_rollup");
  const row = rowOf(await roster(s, team.coach.cookie), ana);
  assert.equal(row.state, "measured");
  assert.ok(row.flags.includes("corrected"));
  assert.equal(row.manual.kind, "correction");
  const v = row.values.find((x) => x.entryMethod === "manual" && x.value === dist.value + 111);
  assert.equal(v.measuredValue, dist.value);
  assert.ok(!(await needsState(s.activityId)).includes(ana), "a corrected athlete keeps a state");
});

test("7. (after 6) the restore: only after a correction; the new manual occasion holds exactly the measured values (v88 refuses anything else, even by a raw write); a restore of a restore is nothing_to_restore", async () => {
  const { team, s, distance } = await sessionWorld();
  const ana = team.athleteIds[ANA];
  const f = await form(s, ana, team.coach.cookie);
  assert.equal(f.body.canRestore, true);
  const stale = await restore(s, { athleteId: ana, expectedOccasionId: crypto.randomUUID() }, team.coach.cookie);
  assert.deepEqual([stale.status, stale.body.error], [409, "values_changed"]);
  const r = await restore(s, { athleteId: ana, expectedOccasionId: f.body.expectedOccasionId }, team.coach.cookie);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.kind, "restore");
  for (const v of r.body.values) assert.equal(v.value, v.measuredValue);
  const measuredOf = (await admin.query(`select measured_occasion_id from training_load.metric_manual_values where occasion_id = $1`, [r.body.occasionId])).rows[0].measured_occasion_id;
  const restoredDiffers = (await admin.query(
    `(select metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, aggregation_role, coverage
        from training_load.metric_values where occasion_id = $1 and not is_derived
      except
      select metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, aggregation_role, coverage
        from training_load.metric_values where occasion_id = $2 and not is_derived)`, [r.body.occasionId, measuredOf])).rows;
  assert.deepEqual(restoredDiffers, [], "the restore holds the measured values with every semantic column");
  const row = rowOf(await roster(s, team.coach.cookie), ana);
  assert.equal(row.state, "measured");
  assert.ok(!row.flags.includes("corrected"));
  assert.equal(row.manual.kind, "restore");
  const again = await form(s, ana, team.coach.cookie);
  assert.equal(again.body.canRestore, false);
  const twice = await restore(s, { athleteId: ana, expectedOccasionId: again.body.expectedOccasionId }, team.coach.cookie);
  assert.deepEqual([twice.status, twice.body.error], [409, "nothing_to_restore"]);
  // A raw "restore" whose values differ from the measured ones is refused by the database.
  const prov = (await admin.query(`select measured_occasion_id from training_load.metric_manual_values where occasion_id = $1`, [r.body.occasionId])).rows[0];
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('optimove.manual_value_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.coach.id]);
    const cur = (await client.query(`select o.id, o.event_participant_id, o.source_identity_id from training_load.metric_measurement_occasions o where o.id = $1`, [r.body.occasionId])).rows[0];
    const occ = (await client.query(
      `insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, source_identity_id, recorded_by_user_id, supersedes_occasion_id)
       values ($1, 'manual', $2, $3, $4) returning id`, [cur.event_participant_id, cur.source_identity_id, team.coach.id, cur.id])).rows[0].id;
    await client.query(
      `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture)
       select $1, metric_definition_id, metric_definition_version_id, case when metric_definition_id = $2 then value_numeric + 1 else value_numeric end, unit_at_capture
         from training_load.metric_values where occasion_id = $3 and not is_derived`, [occ, distance, cur.id]);
    await client.query(`update training_load.metric_measurement_occasions set superseded_by_occasion_id = $1 where id = $2`, [occ, cur.id]);
    await client.query(`update training_load.metric_source_identities set current_occasion_id = $1 where id = $2`, [occ, cur.source_identity_id]);
    await assert.rejects(
      client.query(`insert into training_load.metric_manual_values (occasion_id, kind, replaced_occasion_id, measured_occasion_id, entered_by_user_id, entered_by_basis, request_key, request_hash)
                    values ($1, 'restore', $2, $3, $4, 'team_coach', gen_random_uuid(), repeat('a', 64))`, [occ, cur.id, prov.measured_occasion_id, team.coach.id]),
      /a restore holds exactly the measured values/);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
});

test("7b. (after 7) v88's guard: a correction must rest on a measured (imported) occasion of the same record - a raw correction whose measured occasion is a manual one is refused", async () => {
  const { team } = await sessionWorld();
  const ana = team.athleteIds[ANA];
  const rows = (await admin.query(
    `select m.kind, o.id, o.source_identity_id, o.event_participant_id
       from training_load.metric_manual_values m
       join training_load.metric_measurement_occasions o on o.id = m.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
      where p.athlete_id = $1 order by m.entered_at`, [ana])).rows;
  const correction = rows.find((r) => r.kind === "correction");
  const restored = rows.find((r) => r.kind === "restore");
  assert.ok(correction && restored, "test 6 corrected and test 7 restored Ana");
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('optimove.manual_value_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.coach.id]);
    const occ = (await client.query(
      `insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, source_identity_id, recorded_by_user_id, supersedes_occasion_id)
       values ($1, 'manual', $2, $3, $4) returning id`, [restored.event_participant_id, restored.source_identity_id, team.coach.id, restored.id])).rows[0].id;
    await client.query(`update training_load.metric_source_identities set current_occasion_id = $1 where id = $2`, [occ, restored.source_identity_id]);
    await assert.rejects(client.query(
      `insert into training_load.metric_manual_values (occasion_id, kind, replaced_occasion_id, measured_occasion_id, entered_by_user_id, entered_by_basis, request_key, request_hash)
       values ($1, 'correction', $2, $3, $4, 'team_coach', gen_random_uuid(), repeat('a', 64))`, [occ, restored.id, correction.id, team.coach.id]),
      /a correction rests on a measured occasion of the same record/);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
});

test("8. (after 3) v88's guards: a provenance row without the acting user, a forged author, an UPDATE or DELETE outside the undo, a value added to an occasion that has its provenance, and a roster manual occasion without its provenance row by COMMIT are all refused", async () => {
  const { team, s, distance } = await sessionWorld();
  const row = (await admin.query(`select occasion_id from training_load.metric_manual_values limit 1`)).rows[0];
  assert.ok(distance);
  await assert.rejects(admin.query(
    `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric)
     select $1, d.id, d.current_version_id, 1 from training_load.metric_definitions d
      where d.owner_scope = 'system' and d.current_version_id is not null
        and not exists (select 1 from training_load.metric_values v where v.occasion_id = $1 and v.metric_definition_id = d.id) limit 1`,
    [row.occasion_id]), /takes no further values/);
  await assert.rejects(admin.query(`update training_load.metric_manual_values set note = 'x' where occasion_id = $1`, [row.occasion_id]), /append-only/);
  await assert.rejects(admin.query(`delete from training_load.metric_manual_values where occasion_id = $1`, [row.occasion_id]), /append-only/);
  await assert.rejects(admin.query(`truncate training_load.metric_manual_values`));
  const eva = team.athleteIds[EVA];
  const participant = (await admin.query(`select p.id from training_load.metric_event_participants p where p.event_id = $1 and p.athlete_id = $2`, [s.eventId, eva])).rows[0].id;
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    // No acting user.
    await client.query("begin");
    const occ1 = (await client.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1, 'manual', $2) returning id`, [participant, team.coach.id])).rows[0].id;
    await assert.rejects(client.query(`insert into training_load.metric_manual_values (occasion_id, kind, entered_by_user_id, entered_by_basis, request_key, request_hash) values ($1, 'entry', $2, 'team_coach', gen_random_uuid(), repeat('a', 64))`, [occ1, team.coach.id]), /no acting user/);
    await client.query("rollback");
    // A forged author: the acting user is another user.
    await client.query("begin");
    await client.query(`select set_config('optimove.manual_value_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.cadmin.id]);
    const occ2 = (await client.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1, 'manual', $2) returning id`, [participant, team.coach.id])).rows[0].id;
    await assert.rejects(client.query(`insert into training_load.metric_manual_values (occasion_id, kind, entered_by_user_id, entered_by_basis, request_key, request_hash) values ($1, 'entry', $2, 'team_coach', gen_random_uuid(), repeat('a', 64))`, [occ2, team.coach.id]), /the author must be the acting user/);
    await client.query("rollback");
    // The occasion's author is not the provenance's author (the acting user wrote it as another coach): refused.
    await client.query("begin");
    await client.query(`select set_config('optimove.manual_value_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.coach.id]);
    const occ3 = (await client.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1, 'manual', $2) returning id`, [participant, team.cadmin.id])).rows[0].id;
    await assert.rejects(client.query(`insert into training_load.metric_manual_values (occasion_id, kind, entered_by_user_id, entered_by_basis, request_key, request_hash) values ($1, 'entry', $2, 'team_coach', gen_random_uuid(), repeat('a', 64))`, [occ3, team.coach.id]), /the author must be the acting user/);
    await client.query("rollback");
    // A manual occasion while the acting user is set, without its provenance row: refused at COMMIT.
    await client.query("begin");
    await client.query(`select set_config('optimove.manual_value_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.coach.id]);
    await client.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1, 'manual', $2)`, [participant, team.coach.id]);
    await assert.rejects(client.query("commit"), /needs its provenance row/);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
});

test("9. the team's import lock: while an import or a check holds it, a save answers try_again and writes nothing", async () => {
  const { team, s, distance } = await sessionWorld();
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  const before = await writes(team.teamId);
  try {
    await holder.query("begin");
    await holder.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`gpexe-import-team:${String(team.teamId).toLowerCase()}`]);
    const f = await form(s, team.athleteIds[EVA], team.coach.cookie);
    const w = await saveValues(s, { athleteId: team.athleteIds[EVA], expectedOccasionId: f.body.expectedOccasionId, values: [{ metricDefinitionId: distance, value: 5 }] }, team.coach.cookie);
    assert.deepEqual([w.status, w.body.error], [409, "try_again"]);
  } finally {
    await holder.query("rollback");
    await holder.end();
  }
  assert.deepEqual(await writes(team.teamId), before);
});

function recordSql() {
  const recorded = [];
  manual.setManualValueTestHooks({
    beforeTeamLock: ({ client }) => {
      const original = client.query.bind(client);
      client.query = (text, ...rest) => { recorded.push(typeof text === "string" ? text : text?.text ?? ""); return original(text, ...rest); };
    },
  });
  return recorded;
}
const isWriteSql = (q) => /^\s*(insert|update|delete)\b/i.test(q);
const isLockSql = (q) => /pg_(try_)?advisory_xact_lock|\bfor (update|share|key share|no key update)\b/i.test(q);

test("10b. lock order (the recorded SQL of an entry over an earlier entry): the team lock, the alias set, the request lock and the earlier entry's lock come before the first write, and no locking clause follows the first write", async () => {
  const { team, s, distance } = await sessionWorld();
  const fil = team.athleteIds[FIL];
  const f = await form(s, fil, team.coach.cookie);
  assert.ok(f.body.expectedOccasionId, "Fil has an entry (test 5)");
  const recorded = recordSql();
  let w;
  try {
    w = await saveValues(s, { athleteId: fil, expectedOccasionId: f.body.expectedOccasionId, values: [{ metricDefinitionId: distance, value: 2001 }] }, team.coach.cookie);
  } finally {
    manual.setManualValueTestHooks(null);
  }
  assert.equal(w.status, 201, w.text);
  const firstWrite = recorded.findIndex(isWriteSql);
  const idx = (re) => recorded.findIndex((q) => re.test(q));
  const order = [idx(/pg_try_advisory_xact_lock/), idx(/for key share/i), idx(/manual-value-request/), idx(/metric_measurement_occasions where id = \$1 for update/)];
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order[order.length - 1] < firstWrite, "every lock before the first write");
  assert.deepEqual(recorded.slice(firstWrite).filter(isLockSql), [], "no locking clause after the first write");
});

test("10. lock order (the recorded SQL of a correction): rights, the team lock, the alias set, the request lock and the record's lock are all taken before the first write, and no locking clause follows the first write", async () => {
  const { team, s, distance } = await sessionWorld();
  const bea = team.athleteIds[BEA];
  const f = await form(s, bea, team.coach.cookie);
  const recorded = [];
  manual.setManualValueTestHooks({
    beforeTeamLock: ({ client }) => {
      const original = client.query.bind(client);
      client.query = (text, ...rest) => { recorded.push(typeof text === "string" ? text : text?.text ?? ""); return original(text, ...rest); };
    },
  });
  let w;
  try {
    w = await saveValues(s, { athleteId: bea, expectedOccasionId: f.body.expectedOccasionId, values: [{ metricDefinitionId: distance, value: 4321 }] }, team.coach.cookie);
  } finally {
    manual.setManualValueTestHooks(null);
  }
  assert.equal(w.status, 201, w.text);
  const isWrite = (q) => /^\s*(insert|update|delete)\b/i.test(q);
  const isLock = (q) => /pg_(try_)?advisory_xact_lock|\bfor (update|share|key share|no key update)\b/i.test(q);
  const firstWrite = recorded.findIndex(isWrite);
  assert.ok(firstWrite > 0, "a write was recorded");
  const lockIdx = (re) => recorded.findIndex((q) => re.test(q));
  const order = [lockIdx(/pg_try_advisory_xact_lock/), lockIdx(/for key share/i), lockIdx(/manual-value-request/), lockIdx(/metric_source_identities where id = \$1 for update/)];
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "team lock -> alias set -> request -> record");
  assert.ok(order[order.length - 1] < firstWrite, "every lock before the first write");
  assert.deepEqual(recorded.slice(firstWrite).filter(isLock), [], "no locking clause after the first write");
});

test("11. the undo of a session with manual values: refused without a confirmation (listing them, with names), refused with a stale one, done with the right one; the provenance rows go with the session and the deletion log records what was confirmed", async () => {
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9702, ids: [101, 102, 104] }));
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  const eva = team.athleteIds[EVA];
  const first = await saveValues(s, { athleteId: eva, values: [{ metricDefinitionId: distance, value: 1400 }] }, team.coach.cookie);
  assert.equal(first.status, 201, first.text);
  // A second entry replaces the first: the first stays as history, and history is in the undo's fingerprint.
  const entry = await saveValues(s, { athleteId: eva, expectedOccasionId: first.body.occasionId, values: [{ metricDefinitionId: distance, value: 1500 }] }, team.coach.cookie);
  assert.equal(entry.status, 201, entry.text);
  const ana = team.athleteIds[ANA];
  const f = await form(s, ana, team.coach.cookie);
  const corr = await saveValues(s, { athleteId: ana, expectedOccasionId: f.body.expectedOccasionId, values: [{ metricDefinitionId: distance, value: 1 }] }, team.coach.cookie);
  assert.equal(corr.status, 201, corr.text);
  // Later roster work too (a state set after the import): the preview needs BOTH confirmations, and gets them.
  const fil = team.athleteIds[FIL];
  const decided = await tapi(`/${s.activityId}/roster/${fil}/decision`, { method: "PUT", cookie: team.coach.cookie, body: { requestKey: key(), kind: "participated_no_values", expectedDecisionId: null } });
  assert.ok([200, 201].includes(decided.status), decided.text);

  const preview = await api(`/teams/${team.teamId}/candidates/${s.candidateId}/undo-preview`, { cookie: team.padmin.cookie });
  assert.equal(preview.status, 200, preview.text);
  const mv = preview.body.undoPreview.manualValues;
  assert.equal(preview.body.undoPreview.needsManualConfirmation, true);
  assert.equal(preview.body.undoPreview.needsRosterConfirmation, true);
  const rosterFp = preview.body.undoPreview.rosterWork.laterWork.fingerprint;
  assert.match(rosterFp, /^[0-9a-f]{64}$/);
  assert.equal((await admin.query(`select count(*)::int n from training_load.metric_events where id = $1`, [s.eventId])).rows[0].n, 1, "the preview removed nothing");
  // The count is every manual occasion the undo removes (Eva's replaced entry too); the list is the current ones.
  assert.equal(mv.count, 3);
  assert.equal(mv.list.length, 2);
  assert.deepEqual(mv.list.map((i) => [i.athleteName, i.kind, i.byName]).sort(), [["Ana", "correction", "coach"], ["Eva", "entry", "coach"]]);
  assert.match(mv.fingerprint, /^[0-9a-f]{64}$/);
  const everyManual = (await admin.query(
    `select o.id::text as id from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id
      where p.event_id = $1 and o.entry_method = 'manual' order by o.id`, [s.eventId])).rows.map((r) => r.id);
  assert.ok(everyManual.includes(String(first.body.occasionId)), "the replaced entry is kept");
  assert.equal(mv.fingerprint, crypto.createHash("sha256").update(everyManual.join(",")).digest("hex"), "the fingerprint covers every manual occasion, history included");
  assert.equal((await admin.query(`select count(*)::int n from training_load.metric_manual_values`)).rows[0].n > 0, true, "the preview wrote and removed nothing");

  const undo = (extra) => api(`/teams/${team.teamId}/candidates/${s.candidateId}/undo-import`, {
    method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "wrong session", expected: { eventId: s.eventId }, laterRosterFingerprint: rosterFp, ...extra },
  });
  const unconfirmed = await undo({});
  assert.deepEqual([unconfirmed.status, unconfirmed.body.error], [409, "manual_values_need_confirmation"]);
  assert.equal(unconfirmed.body.manualValues.count, 3);
  assert.equal(unconfirmed.body.manualValues.fingerprint, mv.fingerprint);
  const wrong = await undo({ manualValuesFingerprint: "0".repeat(64) });
  assert.deepEqual([wrong.status, wrong.body.error], [409, "manual_values_changed"]);
  const bad = await undo({ manualValuesFingerprint: "not hex" });
  assert.equal(bad.status, 400);
  assert.equal((await admin.query(`select count(*)::int n from training_load.metric_events where id = $1`, [s.eventId])).rows[0].n, 1, "nothing removed");

  const done = await undo({ manualValuesFingerprint: mv.fingerprint });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.undo.manualValues.count, 3);
  assert.equal(done.body.undo.removedCounts.metric_manual_values, 3);
  assert.equal((await admin.query(`select count(*)::int n from training_load.metric_events where id = $1`, [s.eventId])).rows[0].n, 0);
  const log = (await admin.query(`select manual_values_removed from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0].manual_values_removed;
  assert.equal(log.count, 3);
  assert.equal(log.fingerprint, mv.fingerprint);
  assert.equal(log.confirmed_by, String(team.padmin.id));
  assert.equal(log.list.length, 2);
  // A confirmation of a session that holds no manual values is refused (the list it confirmed is gone).
  const s2 = await importSession(team, bundleOf({ sessionId: 9703, hour: 12, ids: [101, 102] }));
  const extra = await api(`/teams/${team.teamId}/candidates/${s2.candidateId}/undo-import`, {
    method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "wrong session", expected: { eventId: s2.eventId }, manualValuesFingerprint: mv.fingerprint },
  });
  assert.deepEqual([extra.status, extra.body.error], [409, "manual_values_changed"]);
  const plain = await api(`/teams/${team.teamId}/candidates/${s2.candidateId}/undo-import`, {
    method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "wrong session", expected: { eventId: s2.eventId } },
  });
  assert.equal(plain.status, 200, plain.text);
  assert.equal(plain.body.undo.manualValues.count, 0);
  assert.equal((await admin.query(`select manual_values_removed from training_load.import_deletion_log where event_id = $1`, [s2.eventId])).rows[0].manual_values_removed, null);
});

test("16. the undo refuses a session whose manual value left a Metrics-screen write request before it asks for any confirmation (never a list to confirm that is then refused anyway)", async () => {
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9706, hour: 16, ids: [101, 102] }));
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  const entry = await saveValues(s, { athleteId: team.athleteIds[EVA], values: [{ metricDefinitionId: distance, value: 900 }] }, team.coach.cookie);
  assert.equal(entry.status, 201, entry.text);
  await admin.query(
    `insert into training_load.metric_write_requests (request_key, requested_by_user_id, operation_kind, owner_scope, owner_team_id, request_content_hash, result_occasion_id)
     values (gen_random_uuid()::text, $1, 'correct_occasion', 'team', $2, repeat('a', 64), $3)`,
    [team.coach.id, team.teamId, entry.body.occasionId]);
  const preview = await api(`/teams/${team.teamId}/candidates/${s.candidateId}/undo-preview`, { cookie: team.padmin.cookie });
  assert.deepEqual([preview.status, preview.body.error], [409, "manual_write_request_exists"]);
  assert.equal(preview.body.manualValues, undefined, "no list to confirm");
  const undone = await api(`/teams/${team.teamId}/candidates/${s.candidateId}/undo-import`, {
    method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "wrong session", expected: { eventId: s.eventId } },
  });
  assert.deepEqual([undone.status, undone.body.error], [409, "manual_write_request_exists"]);
});

test("18. v88's 'removal' kind (no writer yet): an empty occasion of the same athlete ends an entry and the athlete needs a state again; a removal with a value, of an occasion that is no entry, or of another athlete is refused; a later entry follows a removal", async () => {
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9708, hour: 18, ids: [101, 102] }));
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  const eva = team.athleteIds[EVA];
  const entry = await saveValues(s, { athleteId: eva, values: [{ metricDefinitionId: distance, value: 700 }] }, team.coach.cookie);
  assert.equal(entry.status, 201, entry.text);
  const participantOf = async (athleteId) => (await admin.query(`select id from training_load.metric_event_participants where event_id = $1 and athlete_id = $2`, [s.eventId, athleteId])).rows[0]?.id;
  const evaParticipant = await participantOf(eva);
  const asActor = async (fn) => {
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      await c.query("begin");
      await c.query(`select set_config('optimove.manual_value_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.coach.id]);
      return await fn(c);
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
  };
  const removal = (c, participant, replaced) => c.query(
    `with o as (insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id, supersedes_occasion_id)
                values ($1, 'manual', $2, $3) returning id),
          s as (update training_load.metric_measurement_occasions set superseded_by_occasion_id = (select id from o) where id = $3)
     insert into training_load.metric_manual_values (occasion_id, kind, replaced_occasion_id, entered_by_user_id, entered_by_basis, request_key, request_hash)
     select id, 'removal', $3, $2, 'team_coach', gen_random_uuid(), repeat('b', 64) from o returning occasion_id`,
    [participant, team.coach.id, replaced]);
  // A valid removal, committed: the athlete has no roster value again.
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    await c.query("begin");
    await c.query(`select set_config('optimove.manual_value_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.coach.id]);
    await removal(c, evaParticipant, entry.body.occasionId);
    await c.query("commit");
  } finally {
    await c.end();
  }
  assert.ok((await needsState(s.activityId)).includes(eva), "after a removal the athlete needs a state again");
  // Refusals: the removal of something that is no entry (a measured occasion of another athlete).
  const ana = team.athleteIds[ANA];
  const anaMeasured = (await admin.query(
    `select o.id from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id
      where p.event_id = $1 and p.athlete_id = $2 and o.segment_id is null and o.superseded_by_occasion_id is null and o.entry_method = 'api_import'`, [s.eventId, ana])).rows[0].id;
  await asActor(async (cl) => {
    await assert.rejects(removal(cl, await participantOf(ana), anaMeasured), /a removal is an empty occasion that ends an entry|guard|superseded/);
  });
  // A later entry follows the removal through the service.
  const f = await form(s, eva, team.coach.cookie);
  assert.equal(f.body.mode, "entry");
  assert.ok(f.body.expectedOccasionId, "the removal is the current occasion");
  const again = await saveValues(s, { athleteId: eva, expectedOccasionId: f.body.expectedOccasionId, values: [{ metricDefinitionId: distance, value: 710 }] }, team.coach.cookie);
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.body.values.map((v) => v.value), [710], "nothing of the removed entry is carried over");
  assert.ok(!(await needsState(s.activityId)).includes(eva));
});

test("19. fail closed until the re-import question: a check that brings device data for an athlete who holds a roster entry blocks the session (manual_values_conflict, the athlete named), the approval imports nothing and both values never stand side by side", async () => {
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9706, ids: [101, 102] }));
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  const cil = team.athleteIds[CIL];
  const entry = await saveValues(s, { athleteId: cil, values: [{ metricDefinitionId: distance, value: 1111 }] }, team.coach.cookie);
  assert.equal(entry.status, 201, entry.text);
  // A second athlete with an entry whom GPEXE also sends: every such athlete is named, not only the first.
  const dan = team.athleteIds[3];
  assert.equal((await api(`/teams/${team.teamId}/athlete-links`, { method: "POST", cookie: team.coach.cookie, body: { gpexeAthleteId: "105", athleteId: dan } })).status, 201);
  assert.equal((await saveValues(s, { athleteId: dan, values: [{ metricDefinitionId: distance, value: 999 }] }, team.coach.cookie)).status, 201);
  const occasionsOfCil = async () => (await admin.query(
    `select o.entry_method from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id
      where p.event_id = $1 and p.athlete_id = $2 order by o.created_at`, [s.eventId, cil])).rows.map((r) => r.entry_method);
  assert.deepEqual(await occasionsOfCil(), ["manual"]);

  await checkNow(team, [bundleOf({ sessionId: 9706, ids: [101, 102, 104, 105] })]);
  const list = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates;
  const cand = list.find((c) => c.gpexeTeamSessionId === "9706" && c.id !== s.candidateId);
  assert.ok(cand, "the session's candidate");
  assert.equal(cand.blockedSourceCode, "manual_values_conflict", JSON.stringify(cand));
  const one = await api(`/teams/${team.teamId}/candidates/${cand.id}`, { cookie: team.padmin.cookie });
  const blocked = one.body.candidate?.preview?.blocked ?? one.body.preview?.blocked;
  assert.equal(blocked?.code, "manual_values_conflict", one.text.slice(0, 400));
  assert.deepEqual(blocked.athleteIds, [String(cil), String(dan)].sort(), "every athlete with an entry is named");
  // The approval imports nothing.
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    const r = await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } } });
    assert.notEqual(r.body.results?.[0]?.outcome, "imported", r.text);
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
  assert.deepEqual(await occasionsOfCil(), ["manual"], "no device record beside the entry");
  const f = await form(s, cil, team.coach.cookie);
  assert.equal(f.body.mode, "entry", "the entry can still be changed on the roster");
  const changed = await saveValues(s, { athleteId: cil, expectedOccasionId: f.body.expectedOccasionId, values: [{ metricDefinitionId: distance, value: 1222 }] }, team.coach.cookie);
  assert.equal(changed.status, 201, changed.text);
  const effective = (await admin.query(
    `select count(*)::int n from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id
      where p.event_id = $1 and p.athlete_id = $2 and o.superseded_by_occasion_id is null`, [s.eventId, cil])).rows[0].n;
  assert.equal(effective, 1, "one effective occasion for the athlete");
});

test("19b. fail closed for a roster correction too: GPEXE sending OTHER values for a corrected athlete blocks the session (the athlete named) and replaces nothing; the SAME measured values are simply unchanged and block nothing", async () => {
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9707, ids: [101, 102] }));
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  const ana = team.athleteIds[ANA];
  const f = await form(s, ana, team.coach.cookie);
  const corr = await saveValues(s, { athleteId: ana, expectedOccasionId: f.body.expectedOccasionId, values: [{ metricDefinitionId: distance, value: 4321 }] }, team.coach.cookie);
  assert.equal(corr.status, 201, corr.text);
  const candidateOf = async (exclude) => {
    const list = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates;
    return list.find((c) => c.gpexeTeamSessionId === "9707" && !exclude.includes(c.id));
  };
  // Bea's values change, Ana's are GPEXE's measured ones again: nothing to choose for Ana, nothing blocked.
  await checkNow(team, [bundleOf({ sessionId: 9707, ids: [101, 102], distances: { 102: 2500 } })]);
  const plain = await candidateOf([s.candidateId]);
  assert.ok(plain, "a candidate for the changed session");
  assert.equal(plain.blockedSourceCode, null, JSON.stringify(plain));
  // Ana's GPEXE values change: her correction would be replaced, so the session waits.
  await checkNow(team, [bundleOf({ sessionId: 9707, ids: [101, 102], distances: { 101: 2600 } })]);
  const cand = await candidateOf([s.candidateId, plain.id]);
  assert.ok(cand, "a candidate for Ana's changed values");
  assert.equal(cand.blockedSourceCode, "manual_values_conflict", JSON.stringify(cand));
  const one = await api(`/teams/${team.teamId}/candidates/${cand.id}`, { cookie: team.padmin.cookie });
  const blocked = one.body.candidate?.preview?.blocked ?? one.body.preview?.blocked;
  assert.deepEqual(blocked?.athleteIds, [String(ana)], one.text.slice(0, 400));
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    const r = await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } } });
    assert.notEqual(r.body.results?.[0]?.outcome, "imported", r.text);
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
  const current = (await admin.query(
    `select o.id, o.entry_method from training_load.metric_source_identities si join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id
      where o.id = $1`, [corr.body.occasionId])).rows;
  assert.equal(current.length, 1, "the correction is still the record's current occasion");
});

test("19c. a removal ends the block: once the entry is ended by a 'removal', the same check imports that athlete's device data", async () => {
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9709, hour: 14, ids: [101, 102] }));
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  const cil = team.athleteIds[CIL];
  const entry = await saveValues(s, { athleteId: cil, values: [{ metricDefinitionId: distance, value: 1111 }] }, team.coach.cookie);
  assert.equal(entry.status, 201, entry.text);
  const participant = (await admin.query(`select id from training_load.metric_event_participants where event_id = $1 and athlete_id = $2`, [s.eventId, cil])).rows[0].id;
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    await c.query("begin");
    await c.query(`select set_config('optimove.manual_value_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.coach.id]);
    await c.query(
      `with o as (insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id, supersedes_occasion_id)
                  values ($1, 'manual', $2, $3) returning id),
            u as (update training_load.metric_measurement_occasions set superseded_by_occasion_id = (select id from o) where id = $3)
       insert into training_load.metric_manual_values (occasion_id, kind, replaced_occasion_id, entered_by_user_id, entered_by_basis, request_key, request_hash)
       select id, 'removal', $3, $2, 'team_coach', gen_random_uuid(), repeat('b', 64) from o`,
      [participant, team.coach.id, entry.body.occasionId]);
    await c.query("commit");
  } finally {
    await c.end();
  }
  await checkNow(team, [bundleOf({ sessionId: 9709, hour: 14, ids: [101, 102, 104] })]);
  const cand = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates.find((x) => x.gpexeTeamSessionId === "9709" && x.id !== s.candidateId);
  assert.ok(cand, "a candidate");
  assert.equal(cand.blockedSourceCode, null, JSON.stringify(cand));
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    const r = await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } } });
    assert.equal(r.body.results?.[0]?.outcome, "imported", r.text);
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
  const methods = (await admin.query(
    `select o.entry_method from training_load.metric_measurement_occasions o where o.event_participant_id = $1 and o.segment_id is null and o.superseded_by_occasion_id is null`, [participant])).rows.map((r) => r.entry_method).sort();
  assert.deepEqual(methods, ["api_import", "manual"], "the device record, beside the removal's empty occasion (no value)");
  assert.equal((await admin.query(`select count(*)::int n from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id
      where o.event_participant_id = $1 and o.entry_method = 'manual' and o.superseded_by_occasion_id is null`, [participant])).rows[0].n, 0, "the removal holds no value");
});

test("17. a session with manual values and a calendar link: the undo refuses calendar_link_exists before it asks to confirm the manual values", async () => {
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9707, hour: 17, ids: [101, 102] }));
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  const entry = await saveValues(s, { athleteId: team.athleteIds[EVA], values: [{ metricDefinitionId: distance, value: 800 }] }, team.coach.cookie);
  assert.equal(entry.status, 201, entry.text);
  const typeId = (await admin.query(`select id from calendar.event_types limit 1`)).rows[0].id;
  // The event is inserted with the table's user triggers off (the table owner may), as session-undo-u5 test 9 does.
  await admin.query("begin");
  await admin.query(`alter table calendar.events disable trigger user`);
  const eventId = (await admin.query(
    `insert into calendar.events (owner_scope, owner_team_id, event_type_id, title, day, timezone, created_by_user_id)
     values ('team', $1, $2, 'Training', '2026-09-14', 'Europe/Sarajevo', $3) returning id`,
    [team.teamId, typeId, team.padmin.id],
  )).rows[0].id;
  await admin.query(`alter table calendar.events enable trigger user`);
  await admin.query("commit");
  await admin.query(`insert into calendar.event_activity_links (event_id, activity_id, linked_by_user_id) values ($1, $2, $3)`, [eventId, s.activityId, team.padmin.id]);
  const undone = await api(`/teams/${team.teamId}/candidates/${s.candidateId}/undo-import`, {
    method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "wrong session", expected: { eventId: s.eventId } },
  });
  assert.deepEqual([undone.status, undone.body.error], [409, "calendar_link_exists"]);
  assert.equal(undone.body.manualValues, undefined, "no list to confirm");
});

test("15. the COMMIT outcome: a COMMIT whose answer is lost after it committed answers 201 (verified by the request key) and a repeat replays it; a COMMIT the server refused answers 500 with nothing saved; an unknown outcome found nowhere answers 503 outcome_unknown, and the same key then writes once", async () => {
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9705, hour: 14, ids: [101, 102, 104] }));
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  const rowsOf = async (k) => (await admin.query(`select count(*)::int n from training_load.metric_manual_values where request_key = $1`, [k])).rows[0].n;
  const post = (body) => tapi(`/${s.activityId}/manual-values`, { method: "POST", cookie: team.coach.cookie, body });

  // (a) Committed, then the answer is lost: verified by the key on a new connection.
  const a = { requestKey: key(), athleteId: team.athleteIds[EVA], values: [{ metricDefinitionId: distance, value: 1111 }] };
  manual.setManualValueTestHooks({ commit: async (client) => { await client.query("commit"); throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); } });
  let r;
  try { r = await post(a); } finally { manual.setManualValueTestHooks(null); }
  assert.equal(r.status, 201, r.text);
  assert.equal(await rowsOf(a.requestKey), 1);
  const again = await post(a);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, r.body, "the replay answers what was saved");
  assert.equal(await rowsOf(a.requestKey), 1);

  // (b) The server refused the COMMIT itself: nothing was saved.
  const b = { requestKey: key(), athleteId: team.athleteIds[FIL], values: [{ metricDefinitionId: distance, value: 2222 }] };
  manual.setManualValueTestHooks({
    commit: async (client) => { await client.query("rollback"); throw new pg.DatabaseError("could not serialize access", 0, "error"); },
  });
  try {
    const refused = await post(b);
    assert.deepEqual([refused.status, refused.body.error], [500, "internal_error"]);
  } finally { manual.setManualValueTestHooks(null); }
  assert.equal(await rowsOf(b.requestKey), 0);

  // (c) No answer and nothing found within the check: not confirmed, never "not saved"; the same key then writes once.
  const c = { requestKey: key(), athleteId: team.athleteIds[FIL], values: [{ metricDefinitionId: distance, value: 3333 }] };
  manual.setManualValueTestHooks({
    commit: async (client) => { await client.query("rollback"); return new Promise(() => {}); },
    commitTimeoutMs: 50, checkTimeoutMs: 2000,
  });
  try {
    const unknown = await post(c);
    assert.deepEqual([unknown.status, unknown.body.error], [503, "outcome_unknown"]);
  } finally { manual.setManualValueTestHooks(null); }
  assert.equal(await rowsOf(c.requestKey), 0);
  const retried = await post(c);
  assert.equal(retried.status, 201, retried.text);
  assert.equal(await rowsOf(c.requestKey), 1);
  assert.equal((await post(c)).status, 200);
  assert.equal(await rowsOf(c.requestKey), 1);
});

// ---------------------------------------------------------------------------
// The migration, its preflight, post-check and rollback
// ---------------------------------------------------------------------------
const RUNBOOK = (name) => new URL(`../../docs/runbooks/${name}`, import.meta.url);
const readRunbook = (name) => fs.readFileSync(RUNBOOK(name), "utf8");
const BEFORE_V88 = MIGRATIONS.filter((m) => m !== V88_FILE);
async function booleansOf(client, sql) {
  const results = [].concat(await client.query(sql));
  const out = [];
  for (const res of results) for (const row of res.rows) for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") out.push([k, v]);
  return out;
}
async function catalogOf(client) {
  const rels = ["training_load.import_deletion_log", "training_load.gpexe_import_approvals", "training_load.metric_measurement_occasions"];
  const constraints = (await client.query(
    `select conrelid::regclass::text || '.' || conname || ' :: ' || pg_get_constraintdef(oid) d from pg_constraint
      where conrelid = any($1::regclass[]) order by 1`, [rels])).rows.map((r) => r.d);
  const columns = (await client.query(
    `select attrelid::regclass::text || '.' || attname || ' ' || format_type(atttypid, atttypmod) || ' ' || attnotnull::text d from pg_attribute
      where attrelid = any($1::regclass[]) and attnum > 0 and not attisdropped order by 1`, [rels])).rows.map((r) => r.d);
  const triggers = (await client.query(
    `select tgrelid::regclass::text || '.' || tgname || ' :: ' || pg_get_triggerdef(oid) || ' ' || tgenabled::text d from pg_trigger
      where tgrelid = any($1::regclass[]) and not tgisinternal order by 1`, [rels])).rows.map((r) => r.d);
  const functions = (await client.query(
    `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(p.prosrc) || ' '
            || pg_get_function_result(p.oid) || ' ' || coalesce(obj_description(p.oid, 'pg_proc'), '') d
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('training_load', 'training') order by 1`)).rows.map((r) => r.d);
  const tables = (await client.query(
    `select n.nspname || '.' || c.relname d from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('training_load', 'training') and c.relkind in ('r', 'i') order by 1`)).rows.map((r) => r.d);
  const migrations = (await client.query(`select migration_name from public.schema_migrations order by 1`)).rows.map((r) => r.migration_name);
  return { constraints, columns, triggers, functions, tables, migrations };
}

test("13. migration v88: the preflight passes before it, the post-check after it, the rollback restores the catalog before v88 exactly, and v88 applies again", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v88rb", migrations: BEFORE_V88 });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    const pre = await booleansOf(client, readRunbook("manual-values-v88-preflight.sql"));
    assert.ok(pre.length >= 12, `the preflight returned its booleans (${pre.length})`);
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok before v88");
    const before = await catalogOf(client);
    await applyGpexeTestMigrations(rb.url, MIGRATIONS);
    const post = await booleansOf(client, readRunbook("manual-values-v88-postcheck.sql"));
    assert.ok(post.length >= 16, `the post-check returned its booleans (${post.length})`);
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok after v88");
    const after = await catalogOf(client);
    assert.notDeepEqual(after, before);
    for (const fn of ["undo_imported_session", "session_undo_scope", "activity_roster_needs_state", "validate_metric_manual_value", "session_undo_manual_log_ok", "forbid_value_after_manual_provenance"]) {
      const m = (await client.query(`select md5(prosrc) m from pg_proc where proname = $1`, [fn])).rows[0].m;
      assert.match(readRunbook("manual-values-v88-rollback.sql"), new RegExp(m), `the rollback names ${fn}'s body in force`);
    }
    await client.query(readRunbook("manual-values-v88-rollback.sql"));
    assert.deepEqual(await catalogOf(client), before, "the rollback restores the catalog before v88 exactly");
    await applyGpexeTestMigrations(rb.url, MIGRATIONS);
    assert.deepEqual(await catalogOf(client), after, "re-applied: the same catalog");
  } finally {
    await client.end();
    await rb.drop();
  }
});

test("14. the rollback refuses, changing nothing, once v88's data is used and under a later migration; the migration refuses over a replaced body", async () => {
  // This suite's own database holds provenance rows and a logged manual removal (tests 3-11).
  const sql = readRunbook("manual-values-v88-rollback.sql");
  const c1 = new pg.Client({ connectionString: db.url });
  await c1.connect();
  try {
    const before = await catalogOf(c1);
    await assert.rejects(c1.query(sql), /v88 rollback refused: a manual value was written on a roster/);
    await c1.query("rollback").catch(() => {});
    assert.deepEqual(await catalogOf(c1), before, "nothing changed");
  } finally {
    await c1.end();
  }
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v88gate", migrations: BEFORE_V88 });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    for (const fn of ["training_load.undo_imported_session", "training_load.session_undo_scope", "training.activity_roster_needs_state"]) {
      const original = (await client.query(`select pg_get_functiondef(to_regproc($1)) d`, [fn])).rows[0].d;
      await client.query(original.replace(/\$function\$\s*\n/, "$function$\n-- changed\n"));
      await assert.rejects(client.query(fs.readFileSync(new URL(`../../migrations_v2/${V88_FILE}`, import.meta.url), "utf8")), /v88 refused: the body in force of/, fn);
      assert.equal((await client.query(`select to_regclass('training_load.metric_manual_values') is null as n`)).rows[0].n, true, "a refused run changes nothing");
      await client.query(original);
    }
    await applyGpexeTestMigrations(rb.url, MIGRATIONS);
    await client.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912310000_later.sql', repeat('0', 64), 'test')`);
    const before = await catalogOf(client);
    await assert.rejects(client.query(readRunbook("manual-values-v88-rollback.sql")), /later migrations are applied/);
    await client.query("rollback").catch(() => {});
    assert.deepEqual(await catalogOf(client), before);
  } finally {
    await client.end();
    await rb.drop();
  }
});

test("12. the deletion log's manual shape is closed: a forged list, another confirmer or a short fingerprint is refused by its CHECK", async () => {
  const ok = { count: 1, list: [{ at: "2026-09-14T10:00:00Z", athlete: crypto.randomUUID(), by: crypto.randomUUID(), kind: "entry", values: 1 }], fingerprint: "a".repeat(64), confirmed_by: null };
  const user = crypto.randomUUID();
  const check = async (value) => (await admin.query(`select training_load.session_undo_manual_log_ok($1::jsonb, $2::uuid) as ok`, [JSON.stringify(value), user])).rows[0].ok;
  assert.equal(await check({ ...ok, confirmed_by: user }), true);
  assert.equal(await check({ ...ok, confirmed_by: crypto.randomUUID() }), false, "another confirmer");
  assert.equal(await check({ ...ok, confirmed_by: user, fingerprint: "abc" }), false);
  assert.equal(await check({ ...ok, confirmed_by: user, count: 0 }), false);
  assert.equal(await check({ ...ok, confirmed_by: user, list: [{ ...ok.list[0], name: "x" }] }), false, "an extra key (a name) is refused");
  assert.equal(await check({ ...ok, confirmed_by: user, list: [{ ...ok.list[0], kind: "imported" }] }), false);
  assert.equal(await check({ ...ok, confirmed_by: user, extra: 1 }), false);
});

test("20. a typed value outside its variable version's limits is refused with value_out_of_range naming the limits (the service's check before any write; v13's trigger stays the backstop); a value inside them passes", async () => {
  const def = (await admin.query(`select id, current_version_id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0];
  const unit = (await admin.query(`select unit from training_load.metric_definition_versions where id = $1`, [def.current_version_id])).rows[0].unit;
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    await client.query("begin");
    // A bounded version (not made current: an active mapping pins the current one), rolled back afterwards.
    const bounded = (await client.query(
      `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, min_value, max_value)
       select $1, max(version_number) + 1, $2, 'numeric', 0, 50000 from training_load.metric_definition_versions where metric_definition_id = $1 returning id`,
      [def.id, unit])).rows[0].id;
    const unbounded = def.current_version_id;
    const refusal = async (value) => {
      try {
        await manual.assertWithinLimits(client, [{ versionId: unbounded, value: 1e8 }, { versionId: bounded, value }]);
        return null;
      } catch (error) {
        return [error.status, error.code, error.message];
      }
    };
    const over = await refusal(60000);
    assert.equal(over?.[1], "value_out_of_range", JSON.stringify(over));
    assert.equal(over[0], 409);
    assert.match(over[2], /between 0 and 50000/);
    assert.equal((await refusal(-1))?.[1], "value_out_of_range");
    assert.equal(await refusal(42000), null, "inside the limits; an unbounded version takes any value");
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
});

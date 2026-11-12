// 6b-B (phase 5b): the estimate proposal and save routes, migration v64 (the request key, the estimate participant's time zone),
// the import writer's re-snapshot and the preview's list of replaced estimates. Disposable databases; the imports are the real
// approvals through the routes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle as makeFixtureBundle, standardAthletes, TZ } from "./_gpexe-fixtures.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding } from "./support/mapped-world.mjs";

const V64_FILE = "202611121200_training_load_v64_metric_estimate_requests.sql";
// Every migration but the error-tracking one (an injected failure would be recorded as a row); v64 last.
const MAIN_MIGRATIONS = GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events"));
const UP_TO_V63 = MAIN_MIGRATIONS.filter((m) => m !== V64_FILE);
const OTHER_TZ = "America/New_York";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const ORIGINAL_FLAG = process.env.ESTIMATES_ENABLED;
const D1 = "2026-09-14";
let src;
let connections;
let resolver;
let db;
let admin;
let server;
let apiBase;
let service;
let estimates;
let createSession;
let appPool;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "est6bb", migrations: MAIN_MIGRATIONS });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  process.env.ESTIMATES_ENABLED = "true";
  process.env.SOURCE_CREDENTIAL_KEYS = (await import("../src/sourceCredentialCrypto.js")).generateKeyEntry(1);
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  estimates = await import("../src/metricEstimateService.js");
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
  estimates?.setEstimateTestHooks(null);
  service?.setGpexeClientFactory(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS; else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
  if (ORIGINAL_FLAG === undefined) delete process.env.ESTIMATES_ENABLED; else process.env.ESTIMATES_ENABLED = ORIGINAL_FLAG;
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

// GPEXE athletes: 101 and 102 are the fixture's; 104 and 105 are clean copies of 102 with their own numbers (105 trains 25 min,
// 2500 m: 100 m per minute).
function athleteSpec(id) {
  const std = Object.fromEntries(standardAthletes().map((a) => [a.id, a]));
  if (std[id]) return structuredClone(std[id]);
  const a = structuredClone(std[102]);
  a.id = id;
  const whole = id === 105 ? { time: 1500, distance: 2500 } : { time: 1300, distance: 1800 };
  a.parts = a.parts.map((p) => ({ ...p, ...whole }));
  return a;
}
function bundleOf({ sessionId, hour = 10, ids, zones = {}, updatedOn = "2026-09-14T20:18:09.337" }) {
  const athletes = ids.map((id, i) => {
    const a = athleteSpec(id);
    a.tracks = [sessionId * 10 + i];
    for (const part of a.parts) delete part.track;
    return a;
  });
  const bundle = makeFixtureBundle({ detailsDrills: [0, 1], sessionId, gpexeTeamId: 77, start: `2026-09-14T${String(hour).padStart(2, "0")}:08:12`, updatedOn, athletes });
  for (const [athleteId, zone] of Object.entries(zones)) {
    for (const track of Object.values(bundle.tracks)) if (String(track.athlete) === String(athleteId)) track.timezone = zone;
  }
  return bundle;
}

let nextGpexeTeamId = 8000;
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
  const [a, b, c, d] = org.athleteIds;
  for (const [gpexeAthleteId, athleteId] of [["101", a], ["102", b], ["104", c], ["105", d]]) {
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

async function pendingCandidate(team, sessionId) {
  const list = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates;
  return list.find((c) => c.gpexeTeamSessionId === String(sessionId) && c.status === "pending");
}

async function approve(team, cand) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await api(`/teams/${team.teamId}/imports`, {
      method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } },
    });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}

async function importSession(team, bundle) {
  await checkNow(team, [bundle]);
  const cand = await pendingCandidate(team, bundle.teamSession.id);
  assert.ok(cand, "a pending candidate");
  const r = await approve(team, cand);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.results[0].outcome, "imported", r.text);
  const approval = (await admin.query(`select metric_event_id, activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0];
  return { candidateId: cand.id, eventId: approval.metric_event_id, activityId: String(approval.activity_id) };
}

const key = () => crypto.randomUUID();
const proposal = (team, s, athleteId, { cookie = team.coach.cookie, extra = "" } = {}) =>
  tapi(`/${s.activityId}/estimates/proposal?athleteId=${athleteId}${extra}`, { cookie });
const save = (team, s, body, { cookie = team.coach.cookie } = {}) =>
  tapi(`/${s.activityId}/estimates`, { method: "POST", cookie, body: { requestKey: key(), ...body } });

async function estimateRows(teamId) {
  return (await admin.query(
    `select e.method, e.basis, e.request_key, e.request_hash, e.estimated_by_user_id, o.id as occasion_id, o.superseded_by_occasion_id,
            p.athlete_id, p.athlete_timezone_snapshot, v.metric_definition_id, v.value_numeric::float8 as value
       from training_load.metric_value_estimates e
       join training_load.metric_measurement_occasions o on o.id = e.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events ev on ev.id = p.event_id
       join training_load.metric_values v on v.id = e.metric_value_id
      where ev.owner_team_id = $1 order by e.estimated_at, v.metric_definition_id`,
    [teamId],
  )).rows;
}
const writes = async (teamId) => (await admin.query(
  `select (select count(*) from training_load.metric_value_estimates)::int as estimates,
          (select count(*) from training_load.metric_event_participants p join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1)::int as participants,
          (select count(*) from training.activity_participant_metric_participant_links)::int as links`,
  [teamId],
)).rows[0];

// A team with three earlier sessions in which Dan (105) trained, and the target session without Dan.
let world;
async function historyWorld() {
  if (world) return world;
  const team = await setupTeam();
  for (const [sessionId, hour] of [[9601, 6], [9602, 7], [9603, 8]]) await importSession(team, bundleOf({ sessionId, hour, ids: [101, 102, 104, 105] }));
  const s = await importSession(team, bundleOf({ sessionId: 9610, hour: 10, ids: [101, 102, 104] }));
  const time = (await admin.query(`select key from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE time min %'`)).rows[0].key;
  const distance = (await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id;
  const maxSpeed = (await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE max speed %'`)).rows[0].id;
  estimates.setEstimateTestHooks({ durationKey: time });
  world = { team, s, timeKey: time, distance: String(distance), maxSpeed: String(maxSpeed) };
  return world;
}
const [ANA, BEA, CIL, DAN, EVA] = [0, 1, 2, 3, 4];

test("1. the flag off: both routes are the identical 404 for everyone, nothing is read or written", async () => {
  const { team, s } = await historyWorld();
  const before = await writes(team.teamId);
  process.env.ESTIMATES_ENABLED = "false";
  try {
    const p = await proposal(team, s, team.athleteIds[DAN]);
    const w = await save(team, s, { athleteId: team.athleteIds[DAN], method: "team_average" });
    const none = await tapi(`/${crypto.randomUUID()}/estimates/proposal?athleteId=${team.athleteIds[DAN]}`, { cookie: team.coach.cookie });
    assert.deepEqual([p.status, p.body], [404, { error: "notFound" }]);
    assert.deepEqual([w.status, w.body], [404, { error: "notFound" }]);
    assert.deepEqual([none.status, none.body], [404, { error: "notFound" }]);
  } finally {
    process.env.ESTIMATES_ENABLED = "true";
  }
  assert.deepEqual(await writes(team.teamId), before);
});

test("2. the audience: the team's coach, the club's admin and a platform admin in the right workspace; another team's coach, a coach in another workspace and a user without a role get the identical 404", async () => {
  const { team, s } = await historyWorld();
  for (const who of [team.coach, team.cadmin, team.padmin]) {
    const r = await proposal(team, s, team.athleteIds[DAN], { cookie: who.cookie });
    assert.equal(r.status, 200, r.text);
  }
  const other = await createGpexePilotOrg(admin, { athleteNames: ["Zed"] });
  const foreign = await coachOf(other.teamId, "foreign");
  // A coach of both teams whose active workspace is the other team.
  const wrongWorkspace = await coachOf(team.teamId, "elsewhere");
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [wrongWorkspace.id, other.teamId]);
  await setWorkspace(wrongWorkspace.id, "team", other.teamId);
  const nobody = { cookie: `optimove_session=${await createSession(await makeUser("nobody"))}` };
  const missing = await tapi(`/${crypto.randomUUID()}/estimates/proposal?athleteId=${team.athleteIds[DAN]}`, { cookie: team.coach.cookie });
  const before = await writes(team.teamId);
  for (const who of [foreign, wrongWorkspace, nobody]) {
    const p = await proposal(team, s, team.athleteIds[DAN], { cookie: who.cookie });
    const w = await save(team, s, { athleteId: team.athleteIds[DAN], method: "team_average" }, { cookie: who.cookie });
    assert.deepEqual([p.status, p.body], [missing.status, missing.body]);
    assert.deepEqual([w.status, w.body], [404, { error: "notFound" }]);
  }
  assert.deepEqual(await writes(team.teamId), before, "nothing was written");
});

test("3. the proposal: the session's variables (a max variable is not estimable, the measured athlete's are measured_exists), the three methods' numbers and why one cannot run; it writes nothing", async () => {
  const { team, s, distance, maxSpeed } = await historyWorld();
  const before = await writes(team.teamId);
  const r = await proposal(team, s, team.athleteIds[DAN]);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.activityId, s.activityId);
  assert.equal(r.body.athleteName, "Dan");
  // The median of Ana (40 min), Bea (20 min) and Cil (21.67 min).
  assert.deepEqual(r.body.minutes, { default: 21.7, used: 21.7 });
  const v = Object.fromEntries(r.body.variables.map((x) => [x.metricDefinitionId, x]));
  assert.equal(v[maxSpeed].estimable, false);
  assert.equal(v[maxSpeed].reason, "not_estimable");
  assert.equal(v[distance].estimable, true);
  const ta = Object.fromEntries(r.body.methods.team_average.values.map((x) => [x.metricDefinitionId, x]));
  assert.equal(r.body.methods.team_average.available, true);
  assert.deepEqual(ta[distance], { metricDefinitionId: distance, value: round3((3000 + 1500 + 1800) / 3), reason: null, basis: { athletes: 3 } });
  assert.equal(ta[maxSpeed], undefined, "only estimable variables get a value");
  const pr = Object.fromEntries(r.body.methods.proportional.values.map((x) => [x.metricDefinitionId, x]));
  assert.deepEqual(pr[distance], { metricDefinitionId: distance, value: 2170, reason: null, basis: { minutes: 21.7, ratePerMinute: 100, sessions: 3 } });
  assert.equal(r.body.methods.copy_athlete.reason, "choose_source");
  assert.deepEqual(r.body.methods.copy_athlete.sources.map((x) => x.name).sort(), ["Ana", "Bea", "Cil"]);
  // The coach's own minutes and a source athlete.
  const r2 = await proposal(team, s, team.athleteIds[DAN], { extra: `&minutes=30&sourceAthleteId=${team.athleteIds[BEA]}` });
  assert.equal(r2.status, 200, r2.text);
  assert.deepEqual(r2.body.minutes, { default: 21.7, used: 30 });
  assert.equal(r2.body.methods.proportional.values.find((x) => x.metricDefinitionId === distance).value, 3000);
  assert.equal(r2.body.methods.copy_athlete.values.find((x) => x.metricDefinitionId === distance).value, 1500);
  // Eva has no history: proportional cannot run, and says why.
  const r3 = await proposal(team, s, team.athleteIds[EVA]);
  assert.equal(r3.body.methods.proportional.available, false);
  assert.equal(r3.body.methods.proportional.reason, "too_few_sessions");
  // Ana was measured: every variable is measured_exists or not estimable.
  const r4 = await proposal(team, s, team.athleteIds[ANA]);
  assert.equal(r4.body.variables.every((x) => !x.estimable), true);
  assert.equal(r4.body.methods.team_average.available, false);
  // Refusals.
  assert.equal((await proposal(team, s, "not-a-uuid")).body.error, "invalid_athlete");
  assert.equal((await proposal(team, s, team.athleteIds[DAN], { extra: "&minutes=0" })).body.error, "invalid_minutes");
  assert.equal((await proposal(team, s, team.athleteIds[DAN], { extra: "&minutes=601" })).body.error, "invalid_minutes");
  const stranger = (await admin.query(`insert into public.athletes (full_name, display_name, device_timezone) values ('X','X','Europe/Sarajevo') returning id`)).rows[0].id;
  assert.deepEqual([(await proposal(team, s, stranger)).status, (await proposal(team, s, stranger)).body.error], [409, "athlete_not_on_roster"]);
  assert.equal((await proposal(team, s, team.athleteIds[DAN], { extra: `&sourceAthleteId=${team.athleteIds[EVA]}` })).body.methods.copy_athlete.reason, "copy_source_not_usable");
  assert.deepEqual(await writes(team.teamId), before, "the proposal wrote nothing");
});
const round3 = (x) => Math.round(x * 1000) / 1000;

test("4. the save (team_average): one occasion per variable with its provenance, the request key and hash on every row, the participant in the event's zone with its confirmed activity link; the canonical reader shows the estimate", async () => {
  const { team, s, distance, maxSpeed } = await historyWorld();
  const requestKey = key();
  const r = await save(team, s, { requestKey, athleteId: team.athleteIds[DAN], method: "team_average", note: "  left early  " });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.activityId, s.activityId);
  assert.equal(r.body.athleteId, team.athleteIds[DAN]);
  assert.equal(r.body.method, "team_average");
  assert.equal(r.body.note, "left early");
  assert.equal(r.body.estimates.some((e) => e.metricDefinitionId === maxSpeed), false, "a max variable is never estimated");
  const dist = r.body.estimates.find((e) => e.metricDefinitionId === distance);
  assert.deepEqual([dist.value, dist.unit, dist.basis], [round3((3000 + 1500 + 1800) / 3), "m", { athletes: 3 }]);
  const rows = (await estimateRows(team.teamId)).filter((x) => x.request_key === requestKey);
  assert.equal(rows.length, r.body.estimates.length);
  assert.equal(new Set(rows.map((x) => x.occasion_id)).size, rows.length, "one occasion per variable");
  assert.equal(new Set(rows.map((x) => x.request_hash)).size, 1, "one hash per save");
  assert.equal(rows.every((x) => x.estimated_by_user_id === team.coach.id && x.athlete_timezone_snapshot === TZ), true);
  const link = (await admin.query(
    `select ap.participation_status, l.link_status from training_load.metric_event_participants p
       join training.activity_participant_metric_participant_links l on l.metric_event_participant_id = p.id
       join training.activity_participants ap on ap.id = l.activity_participant_id
      where p.event_id = $1 and p.athlete_id = $2 and ap.activity_id = $3`,
    [s.eventId, team.athleteIds[DAN], s.activityId],
  )).rows;
  assert.equal(link.length, 1);
  assert.equal(link[0].link_status, "confirmed");
  const facts = (await admin.query(`select detail from training.canonical_activity_results($1) where athlete_id = $2 and fact_kind = 'metric_value'`, [s.activityId, team.athleteIds[DAN]])).rows;
  assert.ok(facts.length >= rows.length);
  assert.equal(facts.every((f) => f.detail.entryMethod === "estimate"), true);
});

test("5. the request key: the same key and body is the saved answer again (200, nothing written); the same key with another body is request_key_reused (nothing written); a refusal leaves the key free", async () => {
  const { team, s } = await historyWorld();
  const requestKey = key();
  const body = { requestKey, athleteId: team.athleteIds[EVA], method: "copy_athlete", sourceAthleteId: team.athleteIds[ANA] };
  const first = await tapi(`/${s.activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body });
  assert.equal(first.status, 201, first.text);
  const before = await writes(team.teamId);
  const again = await tapi(`/${s.activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body);
  const reused = await tapi(`/${s.activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body: { ...body, sourceAthleteId: team.athleteIds[BEA] } });
  assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"]);
  const reusedNote = await tapi(`/${s.activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body: { ...body, note: "other" } });
  assert.equal(reusedNote.body.error, "request_key_reused");
  assert.deepEqual(await writes(team.teamId), before, "nothing was written");
  // A refusal (nothing to estimate for a measured athlete) writes nothing, and its key can be used for a real save.
  const free = key();
  const refused = await save(team, s, { requestKey: free, athleteId: team.athleteIds[ANA], method: "team_average" });
  assert.deepEqual([refused.status, refused.body.error], [409, "nothing_to_estimate"]);
  assert.deepEqual(await writes(team.teamId), before);
  const later = await save(team, s, { requestKey: free, athleteId: team.athleteIds[EVA], method: "team_average" });
  assert.equal(later.status, 201, later.text);
});

test("6. the stable refusals, each writing nothing: the body (400s), an athlete off the roster, a copy source that is not usable, proportional without history; the database guards one hash per (author, key)", async () => {
  const { team, s } = await historyWorld();
  // An estimate of this test's own (the database part below reads it).
  assert.equal((await save(team, s, { athleteId: team.athleteIds[EVA], method: "team_average" })).status, 201);
  const before = await writes(team.teamId);
  const dan = team.athleteIds[DAN];
  const cases = [
    [{ requestKey: "x", athleteId: dan, method: "team_average" }, 400, "invalid_request_key"],
    [{ athleteId: "x", method: "team_average" }, 400, "invalid_athlete"],
    [{ athleteId: dan, method: "guess" }, 400, "invalid_method"],
    [{ athleteId: dan, method: "proportional", minutes: 0 }, 400, "invalid_minutes"],
    [{ athleteId: dan, method: "proportional", minutes: 601 }, 400, "invalid_minutes"],
    [{ athleteId: dan, method: "team_average", minutes: 30 }, 400, "invalid_minutes"],
    [{ athleteId: dan, method: "copy_athlete" }, 400, "invalid_source_athlete"],
    [{ athleteId: dan, method: "copy_athlete", sourceAthleteId: dan }, 400, "invalid_source_athlete"],
    [{ athleteId: dan, method: "team_average", sourceAthleteId: team.athleteIds[ANA] }, 400, "invalid_source_athlete"],
    [{ athleteId: dan, method: "team_average", note: "a​b" }, 400, "invalid_note"],
    [{ athleteId: dan, method: "team_average", note: "x".repeat(501) }, 400, "invalid_note"],
    [{ athleteId: dan, method: "copy_athlete", sourceAthleteId: team.athleteIds[EVA] }, 409, "copy_source_not_usable"],
    [{ athleteId: team.athleteIds[EVA], method: "proportional", minutes: 30 }, 409, "nothing_to_estimate"],
  ];
  for (const [body, status, error] of cases) {
    const r = await save(team, s, body);
    assert.deepEqual([r.status, r.body.error], [status, error], JSON.stringify(body));
  }
  const stranger = (await admin.query(`insert into public.athletes (full_name, display_name, device_timezone) values ('Y','Y','Europe/Sarajevo') returning id`)).rows[0].id;
  assert.deepEqual([(await save(team, s, { athleteId: stranger, method: "team_average" })).body.error], ["athlete_not_on_roster"]);
  assert.deepEqual(await writes(team.teamId), before, "nothing was written");
  // The database: a second row of an (author, key) with another hash is refused.
  const row = (await admin.query(`select e.*, o.event_participant_id from training_load.metric_value_estimates e join training_load.metric_measurement_occasions o on o.id = e.occasion_id order by e.estimated_at desc limit 1`)).rows[0];
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    await c.query("begin");
    await c.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [row.estimated_by_user_id]);
    const def = (await c.query(`select v.metric_definition_id, v.metric_definition_version_id from training_load.metric_values v where v.id = $1`, [row.metric_value_id])).rows[0];
    const occ = (await c.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'estimate',$2) returning id`, [row.event_participant_id, row.estimated_by_user_id])).rows[0].id;
    const val = (await c.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1,$2,$3,1) returning id`, [occ, def.metric_definition_id, def.metric_definition_version_id])).rows[0].id;
    await assert.rejects(
      c.query(`insert into training_load.metric_value_estimates (metric_value_id, occasion_id, method, basis, estimated_by_user_id, request_key, request_hash) values ($1,$2,'team_average','{"athletes":3}',$3,$4,$5)`,
        [val, occ, row.estimated_by_user_id, row.request_key, "0".repeat(64)]),
      /estimate: a request key names one request/,
    );
    await c.query("rollback");
    // Both request columns are required.
    for (const cols of [["request_hash"], ["request_key"]]) {
      await c.query("begin");
      await c.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [row.estimated_by_user_id]);
      const o2 = (await c.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'estimate',$2) returning id`, [row.event_participant_id, row.estimated_by_user_id])).rows[0].id;
      const v2 = (await c.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1,$2,$3,1) returning id`, [o2, def.metric_definition_id, def.metric_definition_version_id])).rows[0].id;
      const withKey = cols[0] === "request_hash";
      await assert.rejects(
        c.query(`insert into training_load.metric_value_estimates (metric_value_id, occasion_id, method, basis, estimated_by_user_id, ${withKey ? "request_key" : "request_hash"}) values ($1,$2,'team_average','{"athletes":3}',$3,$4)`,
          [v2, o2, row.estimated_by_user_id, withKey ? crypto.randomUUID() : "b".repeat(64)]),
        new RegExp(`null value in column "${cols[0]}"`),
      );
      await c.query("rollback");
    }
  } finally {
    await c.end();
  }
});

test("7. a new estimate replaces the old one (rule 7): the earlier occasions of the same variables are superseded, the history is kept; proportional with the coach's minutes stores them in the basis", async () => {
  const { team, s, distance } = await historyWorld();
  const first = await save(team, s, { athleteId: team.athleteIds[DAN], method: "copy_athlete", sourceAthleteId: team.athleteIds[BEA] });
  assert.equal(first.status, 201, first.text);
  const second = await save(team, s, { athleteId: team.athleteIds[DAN], method: "proportional", minutes: 45 });
  assert.equal(second.status, 201, second.text);
  const dist = second.body.estimates.find((e) => e.metricDefinitionId === distance);
  assert.deepEqual([dist.value, dist.basis], [4500, { minutes: 45, ratePerMinute: 100, sessions: 3 }]);
  const rows = await estimateRows(team.teamId);
  const firstOcc = first.body.estimates.find((e) => e.metricDefinitionId === distance).occasionId;
  const firstRow = rows.find((x) => x.occasion_id === firstOcc);
  assert.equal(firstRow.superseded_by_occasion_id, dist.occasionId, "the earlier estimate is superseded by the new one");
  const effective = rows.filter((x) => x.athlete_id === team.athleteIds[DAN] && x.metric_definition_id === distance && x.superseded_by_occasion_id === null);
  assert.equal(effective.length, 1);
});

test("8. the team's import lock is taken without a wait: while an import (or a check) holds it, the save answers 409 try_again and writes nothing", async () => {
  const { team, s } = await historyWorld();
  const before = await writes(team.teamId);
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`gpexe-import-team:${team.teamId.toLowerCase()}`]);
    const r = await save(team, s, { athleteId: team.athleteIds[EVA], method: "team_average" });
    assert.deepEqual([r.status, r.body.error], [409, "try_again"]);
    await holder.query("rollback");
  } finally {
    await holder.end();
  }
  assert.deepEqual(await writes(team.teamId), before);
});

test("9. the COMMIT outcome: a COMMIT whose answer is lost but that committed is found by its key (201, verifiedAfterCommitError); one that did not commit is 503 outcome_unknown, nothing written, and the same key saves once later", async () => {
  const { team, s } = await historyWorld();
  const lostKey = key();
  estimates.setEstimateTestHooks({ durationKey: world.timeKey, commit: async (client) => { await client.query("commit"); throw new Error("answer lost"); } });
  let r;
  try {
    r = await save(team, s, { requestKey: lostKey, athleteId: team.athleteIds[EVA], method: "team_average" });
  } finally {
    estimates.setEstimateTestHooks({ durationKey: world.timeKey });
  }
  assert.equal(r.status, 201, r.text);
  assert.equal((await estimateRows(team.teamId)).filter((x) => x.request_key === lostKey).length, r.body.estimates.length);
  const before = await writes(team.teamId);
  const unknownKey = key();
  estimates.setEstimateTestHooks({ durationKey: world.timeKey, commit: async (client) => { await client.query("rollback"); throw new Error("answer lost"); } });
  try {
    r = await save(team, s, { requestKey: unknownKey, athleteId: team.athleteIds[EVA], method: "team_average" });
  } finally {
    estimates.setEstimateTestHooks({ durationKey: world.timeKey });
  }
  assert.deepEqual([r.status, r.body.error], [503, "outcome_unknown"]);
  assert.deepEqual(await writes(team.teamId), before, "nothing was written");
  const retry = await save(team, s, { requestKey: unknownKey, athleteId: team.athleteIds[EVA], method: "team_average" });
  assert.equal(retry.status, 201, retry.text);
  const replay = await save(team, s, { requestKey: unknownKey, athleteId: team.athleteIds[EVA], method: "team_average" });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, retry.body);
});

test("10. Q2: an estimate participant takes the athlete's own zone when the import brings the athlete's data; the estimate is superseded, the preview lists it apart (never acceptChanges); with a real value the zone stays frozen", async () => {
  const team = await setupTeam();
  // The team's zone lets a session whose units report two zones through (v62).
  await admin.query(`insert into training_load.gpexe_team_session_timezones (owner_team_id, timezone, set_by_user_id, reason) values ($1,$2,$3,'test')`, [team.teamId, TZ, team.padmin.id]);
  const s = await importSession(team, bundleOf({ sessionId: 9701, ids: [101, 102, 104] }));
  // Without an estimate the preview carries no supersededEstimates key at all (an existing preview hash stays as it was).
  const firstPreview = (await api(`/teams/${team.teamId}/candidates/${s.candidateId}`, { cookie: team.padmin.cookie })).body.candidate.preview;
  assert.equal(Object.hasOwn(firstPreview, "supersededEstimates"), false);
  const saved = await save(team, s, { athleteId: team.athleteIds[DAN], method: "team_average" });
  assert.equal(saved.status, 201, saved.text);
  // Dan's real data arrives, from a unit in another zone.
  await checkNow(team, [bundleOf({ sessionId: 9701, ids: [101, 102, 104, 105], zones: { 105: OTHER_TZ }, updatedOn: "2026-09-15T09:00:00.000" })]);
  const cand = await pendingCandidate(team, 9701);
  assert.ok(cand, "the changed session is a pending candidate");
  const detail = (await api(`/teams/${team.teamId}/candidates/${cand.id}`, { cookie: team.padmin.cookie })).body.candidate;
  assert.equal(detail.preview.status, "ready", JSON.stringify(detail.preview.blocked));
  const listed = detail.preview.supersededEstimates;
  assert.ok(Array.isArray(listed) && listed.length === saved.body.estimates.length, "the preview lists the estimates it replaces");
  assert.equal(listed.every((e) => e.athleteId === team.athleteIds[DAN]), true);
  assert.equal(detail.preview.changesToImported.some((c) => c.athleteId === team.athleteIds[DAN]), false, "never under acceptChanges");
  const r = await approve(team, cand);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.results[0].outcome, "imported", r.text);
  const p = (await admin.query(`select athlete_timezone_snapshot from training_load.metric_event_participants where event_id = $1 and athlete_id = $2`, [s.eventId, team.athleteIds[DAN]])).rows[0];
  assert.equal(p.athlete_timezone_snapshot, OTHER_TZ, "the participant took the athlete's own zone");
  const rows = (await estimateRows(team.teamId)).filter((x) => x.athlete_id === team.athleteIds[DAN]);
  assert.equal(rows.every((x) => x.superseded_by_occasion_id !== null), true, "every estimate of a variable the import measured is superseded");

  // With a real value on the participant (a coach's manual value), the zone stays frozen: the import is refused.
  const s2 = await importSession(team, bundleOf({ sessionId: 9702, ids: [101, 102, 104] }));
  assert.equal((await save(team, s2, { athleteId: team.athleteIds[DAN], method: "team_average" })).status, 201);
  const p2 = (await admin.query(`select id from training_load.metric_event_participants where event_id = $1 and athlete_id = $2`, [s2.eventId, team.athleteIds[DAN]])).rows[0].id;
  const anyDef = (await admin.query(`select v.metric_definition_id, v.metric_definition_version_id from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id join training_load.metric_event_participants p on p.id = o.event_participant_id where p.event_id = $1 and o.entry_method = 'api_import' and o.segment_id is null limit 1`, [s2.eventId])).rows[0];
  // a manual value of a variable that has no estimate (a drill-free definition of its own)
  const own = (await admin.query(`insert into training_load.metric_definitions (key, label, owner_scope, owner_user_id) values ($1,'Manual','user',$2) returning id`, [`man_${crypto.randomBytes(3).toString("hex")}`, team.coach.id])).rows[0].id;
  const ownVer = (await admin.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, value_type, unit, daily_aggregation_method) values ($1,1,'numeric','m','sum') returning id`, [own])).rows[0].id;
  await admin.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'session')`, [own]);
  assert.ok(anyDef);
  const mo = (await admin.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'manual',$2) returning id`, [p2, team.coach.id])).rows[0].id;
  await admin.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1,$2,$3,5)`, [mo, own, ownVer]);
  await checkNow(team, [bundleOf({ sessionId: 9702, ids: [101, 102, 104, 105], zones: { 105: OTHER_TZ }, updatedOn: "2026-09-15T09:00:00.000" })]);
  const cand2 = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates.find((c) => c.gpexeTeamSessionId === "9702" && c.status !== "imported" && c.status !== "superseded");
  assert.ok(cand2);
  const detail2 = (await api(`/teams/${team.teamId}/candidates/${cand2.id}`, { cookie: team.padmin.cookie })).body.candidate;
  assert.equal(detail2.preview.status, "blocked");
  assert.equal(detail2.preview.blocked.code, "participant_timezone_changed");
});

test("11. v64's participant guard in the database: the zone of a participant whose every occasion is an estimate may change (and only the zone); with a real occasion, or another field, it may not", async () => {
  const { team, s } = await historyWorld();
  // Dan's participant holds estimates only (this test's own save).
  assert.equal((await save(team, s, { athleteId: team.athleteIds[DAN], method: "team_average" })).status, 201);
  const est = (await admin.query(
    `select p.id from training_load.metric_event_participants p where p.event_id = $1 and p.athlete_id = $2`, [s.eventId, team.athleteIds[DAN]],
  )).rows[0].id;
  const real = (await admin.query(
    `select p.id from training_load.metric_event_participants p where p.event_id = $1 and p.athlete_id = $2`, [s.eventId, team.athleteIds[ANA]],
  )).rows[0].id;
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    await c.query("begin");
    await c.query(`update training_load.metric_event_participants set athlete_timezone_snapshot = $2 where id = $1`, [est, OTHER_TZ]);
    await c.query("rollback");
    await c.query("begin");
    await assert.rejects(c.query(`update training_load.metric_event_participants set athlete_timezone_snapshot = null where id = $1`, [est]), /identity\/snapshot fields are immutable/);
    await c.query("rollback");
    await c.query("begin");
    await assert.rejects(c.query(`update training_load.metric_event_participants set athlete_timezone_snapshot = $2, linked_plan_name_snapshot = 'x' where id = $1`, [est, OTHER_TZ]), /identity\/snapshot fields are immutable/);
    await c.query("rollback");
    await c.query("begin");
    await assert.rejects(c.query(`update training_load.metric_event_participants set athlete_timezone_snapshot = $2 where id = $1`, [real, OTHER_TZ]), /identity\/snapshot fields are immutable/);
    await c.query("rollback");
    // A real occasion with no source identity (a coach's manual value) beside the estimates freezes the zone too.
    const own = (await admin.query(`insert into training_load.metric_definitions (key, label, owner_scope, owner_user_id) values ($1,'Manual 11','user',$2) returning id`, [`m11_${crypto.randomBytes(3).toString("hex")}`, team.coach.id])).rows[0].id;
    const ownVer = (await admin.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, value_type, unit, daily_aggregation_method) values ($1,1,'numeric','m','sum') returning id`, [own])).rows[0].id;
    await admin.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'session')`, [own]);
    await c.query("begin");
    const mo = (await c.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'manual',$2) returning id`, [est, team.coach.id])).rows[0].id;
    await c.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1,$2,$3,5)`, [mo, own, ownVer]);
    await assert.rejects(c.query(`update training_load.metric_event_participants set athlete_timezone_snapshot = $2 where id = $1`, [est, OTHER_TZ]), /identity\/snapshot fields are immutable/);
    await c.query("rollback");
  } finally {
    await c.end();
  }
});

async function catalogOf(client) {
  const q = async (sql) => (await client.query(sql)).rows.map((r) => r.d);
  return {
    columns: await q(`select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable d from information_schema.columns
                       where table_schema = 'training_load' and table_name = 'metric_value_estimates' order by 1`),
    constraints: await q(`select conname || ' :: ' || pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'training_load.metric_value_estimates'::regclass order by 1`),
    indexes: await q(`select indexname || ' :: ' || indexdef d from pg_indexes where schemaname = 'training_load' and tablename = 'metric_value_estimates' order by 1`),
    functions: await q(`select n.nspname || '.' || p.proname || ' ' || md5(p.prosrc) d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('training_load', 'training') order by 1`),
    triggers: await q(`select c.relname || '.' || t.tgname || ' :: ' || pg_get_triggerdef(t.oid) d from pg_trigger t join pg_class c on c.oid = t.tgrelid
                        where c.relname in ('metric_value_estimates', 'metric_event_participants') and not t.tgisinternal order by 1`),
  };
}
async function booleansOf(client, sql) {
  const results = [].concat(await client.query(sql));
  const out = [];
  for (const res of results) for (const row of res.rows) for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") out.push([k, v]);
  return out;
}
const RUNBOOK = (name) => new URL(`../../docs/runbooks/${name}`, import.meta.url);

test("12. migration v64: the preflight passes on v63, the post-check on v64; the rollback restores v63 exactly and refuses once an estimate exists; the migration applies again; it refuses over a changed body, without v63, or with a row in the table", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "est64rb", migrations: UP_TO_V63 });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    const pre = await booleansOf(client, fs.readFileSync(RUNBOOK("metric-value-estimates-v64-preflight.sql"), "utf8"));
    assert.ok(pre.length >= 8, `the preflight returned its booleans (${pre.length})`);
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok on a v63 database");
    const v63Catalog = await catalogOf(client);
    // The md5 gate.
    const src64 = (await client.query(`select pg_get_functiondef('training_load.protect_participant_identity_once_measured()'::regprocedure) d`)).rows[0].d;
    await client.query(src64.replace("$function$\ndeclare", "$function$\n-- changed\ndeclare"));
    await assert.rejects(applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS), /v64_metric_estimate_requests\.sql" \(SQLSTATE 23514\)/);
    await client.query(src64);
    assert.deepEqual(await catalogOf(client), v63Catalog, "nothing of v64 was applied");
    await applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS);
    const post = await booleansOf(client, fs.readFileSync(RUNBOOK("metric-value-estimates-v64-postcheck.sql"), "utf8"));
    assert.ok(post.length >= 9, `the post-check returned its booleans (${post.length})`);
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok on a v64 database");
    const v64Catalog = await catalogOf(client);
    assert.notDeepEqual(v64Catalog, v63Catalog);
    await client.query(fs.readFileSync(RUNBOOK("metric-value-estimates-v64-rollback.sql"), "utf8"));
    assert.deepEqual(await catalogOf(client), v63Catalog, "the rollback restores the v63 catalog exactly");
    assert.equal((await client.query(`select count(*)::int n from public.schema_migrations where migration_name like '%v64%'`)).rows[0].n, 0);
    await applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS);
    assert.deepEqual(await catalogOf(client), v64Catalog, "re-applied: the same catalog");
    // Once an estimate exists the rollback refuses and changes nothing.
    const u = (await client.query(`insert into public.users (email, full_name, display_name) values ('rb64@test.local','R','R') returning id`)).rows[0].id;
    const ath = (await client.query(`insert into public.athletes (full_name, display_name, device_timezone) values ('R','R','Europe/Sarajevo') returning id`)).rows[0].id;
    const ev = (await client.query(`insert into training_load.metric_events (owner_scope, owner_user_id, scope_level, occurred_date) values ('user',$1,'session','2026-09-14') returning id`, [u])).rows[0].id;
    const p = (await client.query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Sarajevo') returning id`, [ev, ath])).rows[0].id;
    await client.query("begin");
    await client.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [u]);
    const defId = (await client.query(`insert into training_load.metric_definitions (key, label, owner_scope, owner_user_id) values ('rb64_sum','RB sum','user',$1) returning id`, [u])).rows[0].id;
    const verId = (await client.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, value_type, unit, daily_aggregation_method) values ($1,1,'numeric','m','sum') returning id`, [defId])).rows[0].id;
    await client.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'session')`, [defId]);
    const o = (await client.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'estimate',$2) returning id`, [p, u])).rows[0].id;
    const v = (await client.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1,$2,$3,1) returning id`, [o, defId, verId])).rows[0].id;
    await client.query(`insert into training_load.metric_value_estimates (metric_value_id, occasion_id, method, basis, estimated_by_user_id, request_key, request_hash) values ($1,$2,'team_average','{"athletes":3}',$3,$4,$5)`, [v, o, u, crypto.randomUUID(), "a".repeat(64)]);
    await client.query("commit");
    await assert.rejects(client.query(fs.readFileSync(RUNBOOK("metric-value-estimates-v64-rollback.sql"), "utf8")), /v64 rollback refused: an estimate exists/);
    await client.query("rollback").catch(() => {});
    assert.deepEqual(await catalogOf(client), v64Catalog, "the refused rollback changed nothing");
  } finally {
    await client.end();
    await rb.drop();
  }
  // Without v63, or with a row already in v63's table, v64 refuses and applies nothing.
  const without = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "est64no63", migrations: UP_TO_V63.filter((m) => !m.includes("v63_metric_value_estimates")) });
  try {
    const c = new pg.Client({ connectionString: without.url });
    await c.connect();
    try {
      const sql = fs.readFileSync(new URL(`../../migrations_v2/${V64_FILE}`, import.meta.url), "utf8");
      await assert.rejects(c.query(sql), /v64 refused: v63 \(metric_value_estimates\) is not applied/);
    } finally {
      await c.end();
    }
  } finally {
    await without.drop();
  }
});

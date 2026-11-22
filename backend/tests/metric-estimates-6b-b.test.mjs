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
// Through v64 only: a later migration (v65 and after) is not part of this suite's rehearsal, which expects v64 last.
const MAIN_MIGRATIONS = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V64_FILE) + 1).filter((m) => !m.includes("app_error_events"));
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
  // MT-B: the preview reads v67's track choices, so the suite's main database carries v67 too (the v64 rehearsal of test 12
  // keeps MAIN_MIGRATIONS, ending at v64).
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "est6bb", migrations: [...MAIN_MIGRATIONS, "202611131200_training_load_v67_gpexe_track_choices.sql", "202611131300_training_load_v68_track_choice_scale.sql", "202611131310_training_load_v69_scale_recording_estimates.sql"] }); // MT-D: v68 and v69 too (the preview reads the scale)
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
async function activityParticipant(activityId, athleteId) {
  const r = (await admin.query(`select timezone_snapshot tz, local_date::text as "day" from training.activity_participants where activity_id = $1 and athlete_id = $2`, [activityId, athleteId])).rows[0];
  return r ? { tz: r.tz, day: r.day } : null;
}
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
  // The panel's line: the day of each session Own average used (newest first; this world's three are on one day) and the
  // type it compares with.
  const days = r.body.methods.proportional.sessionDays;
  assert.equal(days.length, 3, JSON.stringify(days));
  assert.ok(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), JSON.stringify(days));
  assert.deepEqual(days, [...days].sort().reverse());
  assert.deepEqual(r.body.methods.proportional.comparesWith, { key: "training_session", label: "Training session", types: [{ key: "training_session", label: "Training session" }] });
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
  assert.deepEqual(r3.body.methods.proportional.sessionDays, []);
  // The days themselves (code review LOW): one entry per session across variables, two sessions on one day stay two,
  // newest first. The world above has every session on one day, so the order and the dedup are proven here.
  assert.deepEqual(estimates.proportionalDays([
    { usedSessions: [{ id: "e1", day: "2026-11-12" }, { id: "e2", day: "2026-11-17" }, { id: "e3", day: "2026-11-17" }] },
    { usedSessions: [{ id: "e1", day: "2026-11-12" }, { id: "e3", day: "2026-11-17" }, { id: "e4", day: "2026-11-14" }] },
    { usedSessions: [] },
  ]), ["2026-11-17", "2026-11-17", "2026-11-14", "2026-11-12"]);
  // Ana was measured: every variable is measured_exists or not estimable.
  const r4 = await proposal(team, s, team.athleteIds[ANA]);
  assert.equal(r4.body.variables.every((x) => !x.estimable), true);
  assert.equal(r4.body.methods.team_average.available, false);
  // Refusals.
  assert.equal((await proposal(team, s, "not-a-uuid")).body.error, "invalid_athlete");
  assert.equal((await proposal(team, s, team.athleteIds[DAN], { extra: "&minutes=0" })).body.error, "invalid_minutes");
  assert.equal((await proposal(team, s, team.athleteIds[DAN], { extra: "&minutes=601" })).body.error, "invalid_minutes");
  // The bounds hold after rounding to 2 decimals: 0.004 is 0.
  assert.equal((await proposal(team, s, team.athleteIds[DAN], { extra: "&minutes=0.004" })).body.error, "invalid_minutes");
  const stranger = (await admin.query(`insert into public.athletes (full_name, display_name, device_timezone) values ('X','X','Europe/Sarajevo') returning id`)).rows[0].id;
  assert.deepEqual([(await proposal(team, s, stranger)).status, (await proposal(team, s, stranger)).body.error], [409, "athlete_not_on_roster"]);
  assert.equal((await proposal(team, s, team.athleteIds[DAN], { extra: `&sourceAthleteId=${team.athleteIds[EVA]}` })).body.methods.copy_athlete.reason, "copy_source_not_usable");
  assert.deepEqual(await writes(team.teamId), before, "the proposal wrote nothing");
});
const round3 = (x) => Math.round(x * 1000) / 1000;

test("4. the save (team_average): one occasion per variable with its provenance, the request key and hash on every row, the participant in the event's zone with its confirmed activity link; the canonical reader shows the estimate", async () => {
  const { team, s, distance, maxSpeed } = await historyWorld();
  // Dan's own zone differs from the event's: the participant must take the event's.
  await admin.query(`update public.athletes set device_timezone = $2 where id = $1`, [team.athleteIds[DAN], OTHER_TZ]);
  const eventZone = (await admin.query(`select event_timezone_snapshot z from training_load.metric_events where id = $1`, [s.eventId])).rows[0].z;
  assert.notEqual(eventZone, OTHER_TZ);
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
  assert.equal(rows.every((x) => x.estimated_by_user_id === team.coach.id && x.athlete_timezone_snapshot === eventZone), true, "the participant is in the event's zone, not the athlete's own");
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
    [{ athleteId: dan, method: "proportional", minutes: 0.004 }, 400, "invalid_minutes"],
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
  const s = await importSession(team, bundleOf({ sessionId: 9701, hour: 1, ids: [101, 102, 104] }));
  // Without an estimate the preview carries no supersededEstimates key at all (an existing preview hash stays as it was).
  const firstPreview = (await api(`/teams/${team.teamId}/candidates/${s.candidateId}`, { cookie: team.padmin.cookie })).body.candidate.preview;
  assert.equal(Object.hasOwn(firstPreview, "supersededEstimates"), false);
  const saved = await save(team, s, { athleteId: team.athleteIds[DAN], method: "team_average" });
  assert.equal(saved.status, 201, saved.text);
  // Dan's real data arrives, from a unit in another zone.
  const actBefore = await activityParticipant(s.activityId, team.athleteIds[DAN]);
  assert.deepEqual([actBefore.tz, actBefore.day], [TZ, "2026-09-14"], "the estimate participant is in the event's zone and day");
  await checkNow(team, [bundleOf({ sessionId: 9701, hour: 1, ids: [101, 102, 104, 105], zones: { 105: OTHER_TZ }, updatedOn: "2026-09-15T09:00:00.000" })]);
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
  // Both layers equal a direct import of the same session: the activity participant took the zone and its day (the 13th in
  // New York at 01:08 UTC).
  const direct = await setupTeam();
  await admin.query(`insert into training_load.gpexe_team_session_timezones (owner_team_id, timezone, set_by_user_id, reason) values ($1,$2,$3,'test')`, [direct.teamId, TZ, direct.padmin.id]);
  const d = await importSession(direct, bundleOf({ sessionId: 9711, hour: 1, ids: [101, 102, 104, 105], zones: { 105: OTHER_TZ } }));
  const viaEstimate = await activityParticipant(s.activityId, team.athleteIds[DAN]);
  const viaDirect = await activityParticipant(d.activityId, direct.athleteIds[DAN]);
  assert.deepEqual([viaEstimate.tz, viaEstimate.day], [viaDirect.tz, viaDirect.day]);
  assert.deepEqual([viaEstimate.tz, viaEstimate.day], [OTHER_TZ, "2026-09-13"], "the day changed with the zone");
  const directMetric = (await admin.query(`select athlete_timezone_snapshot z from training_load.metric_event_participants where event_id = $1 and athlete_id = $2`, [d.eventId, direct.athleteIds[DAN]])).rows[0].z;
  assert.equal(p.athlete_timezone_snapshot, directMetric);
  const rows = (await estimateRows(team.teamId)).filter((x) => x.athlete_id === team.athleteIds[DAN]);
  assert.equal(rows.every((x) => x.superseded_by_occasion_id !== null), true, "every estimate of a variable the import measured is superseded");

  // With a real value on the participant (a coach's manual value), the zone stays frozen: the import is refused.
  const s2 = await importSession(team, bundleOf({ sessionId: 9702, hour: 1, ids: [101, 102, 104] }));
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
  const act2Before = await activityParticipant(s2.activityId, team.athleteIds[DAN]);
  await checkNow(team, [bundleOf({ sessionId: 9702, hour: 1, ids: [101, 102, 104, 105], zones: { 105: OTHER_TZ }, updatedOn: "2026-09-15T09:00:00.000" })]);
  const cand2 = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates.find((c) => c.gpexeTeamSessionId === "9702" && c.status !== "imported" && c.status !== "superseded");
  assert.ok(cand2);
  const detail2 = (await api(`/teams/${team.teamId}/candidates/${cand2.id}`, { cookie: team.padmin.cookie })).body.candidate;
  assert.equal(detail2.preview.status, "blocked");
  assert.equal(detail2.preview.blocked.code, "participant_timezone_changed");
  // Neither layer moved.
  assert.deepEqual(await activityParticipant(s2.activityId, team.athleteIds[DAN]), act2Before);
  assert.equal((await admin.query(`select athlete_timezone_snapshot z from training_load.metric_event_participants where id = $1`, [p2])).rows[0].z, TZ);
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
    // v1's guard: the activity participant follows only the metric participant's zone, to the day materialize computes.
    const ap = (await admin.query(`select ap.id from training.activity_participants ap join training.activity_participant_metric_participant_links l on l.activity_participant_id = ap.id where l.metric_event_participant_id = $1`, [est])).rows[0].id;
    const dayIn = async (zone) => (await admin.query(`select coalesce((occurred_instant at time zone $2)::date, occurred_date)::text d from training_load.metric_events where id = $1`, [s.eventId, zone])).rows[0].d;
    const immutable = /immutable once load-bearing/;
    await c.query("begin");
    await assert.rejects(c.query(`update training.activity_participants set timezone_snapshot = $2, local_date = $3 where id = $1`, [ap, OTHER_TZ, await dayIn(OTHER_TZ)]), immutable, "not before the metric participant moved");
    await c.query("rollback");
    await c.query("begin");
    await c.query(`update training_load.metric_event_participants set athlete_timezone_snapshot = $2 where id = $1`, [est, OTHER_TZ]);
    await assert.rejects(c.query(`update training.activity_participants set timezone_snapshot = $2, local_date = date '2001-01-01' where id = $1`, [ap, OTHER_TZ]), immutable, "not to another day");
    await c.query("rollback");
    await c.query("begin");
    await c.query(`update training_load.metric_event_participants set athlete_timezone_snapshot = $2 where id = $1`, [est, OTHER_TZ]);
    await c.query(`update training.activity_participants set timezone_snapshot = $2, local_date = $3 where id = $1`, [ap, OTHER_TZ, await dayIn(OTHER_TZ)]);
    await c.query("rollback");
    await c.query("begin");
    // The metric participant moves first (estimates only), then a real occasion arrives: the activity participant may not follow.
    await c.query(`update training_load.metric_event_participants set athlete_timezone_snapshot = $2 where id = $1`, [est, OTHER_TZ]);
    const mo2 = (await c.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'manual',$2) returning id`, [est, team.coach.id])).rows[0].id;
    await c.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1,$2,$3,5)`, [mo2, own, ownVer]);
    await assert.rejects(c.query(`update training.activity_participants set timezone_snapshot = $2, local_date = $3 where id = $1`, [ap, OTHER_TZ, await dayIn(OTHER_TZ)]), immutable, "not with a real occasion");
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
    const guardSrc = (await client.query(`select pg_get_functiondef('training_load.validate_metric_value_estimate()'::regprocedure) d`)).rows[0].d;
    await client.query(guardSrc.replace("$function$\ndeclare", "$function$\n-- changed\ndeclare"));
    await assert.rejects(applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS), /v64_metric_estimate_requests\.sql" \(SQLSTATE 23514\)/);
    await client.query(guardSrc);
    assert.deepEqual(await catalogOf(client), v63Catalog, "nothing of v64 was applied over the changed guard either");
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
  // A row already in v63's table: v64 refuses and applies nothing.
  const withRow = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "est64row", migrations: UP_TO_V63 });
  try {
    const c = new pg.Client({ connectionString: withRow.url });
    await c.connect();
    try {
      const u = (await c.query(`insert into public.users (email, full_name, display_name) values ('row64@test.local','R','R') returning id`)).rows[0].id;
      const ath = (await c.query(`insert into public.athletes (full_name, display_name, device_timezone) values ('R','R','Europe/Sarajevo') returning id`)).rows[0].id;
      const ev = (await c.query(`insert into training_load.metric_events (owner_scope, owner_user_id, scope_level, occurred_date) values ('user',$1,'session','2026-09-14') returning id`, [u])).rows[0].id;
      const p = (await c.query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Sarajevo') returning id`, [ev, ath])).rows[0].id;
      await c.query("begin");
      await c.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [u]);
      const defId = (await c.query(`insert into training_load.metric_definitions (key, label, owner_scope, owner_user_id) values ('row64_sum','Row sum','user',$1) returning id`, [u])).rows[0].id;
      const verId = (await c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, value_type, unit, daily_aggregation_method) values ($1,1,'numeric','m','sum') returning id`, [defId])).rows[0].id;
      await c.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'session')`, [defId]);
      const o = (await c.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'estimate',$2) returning id`, [p, u])).rows[0].id;
      const v = (await c.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1,$2,$3,1) returning id`, [o, defId, verId])).rows[0].id;
      await c.query(`insert into training_load.metric_value_estimates (metric_value_id, occasion_id, method, basis, estimated_by_user_id) values ($1,$2,'team_average','{"athletes":3}',$3)`, [v, o, u]);
      await c.query("commit");
      const sql = fs.readFileSync(new URL(`../../migrations_v2/${V64_FILE}`, import.meta.url), "utf8");
      await assert.rejects(c.query(sql), /v64 refused: metric_value_estimates already holds a row/);
      assert.equal((await c.query(`select count(*)::int n from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_value_estimates' and column_name = 'request_key'`)).rows[0].n, 0);
    } finally {
      await c.end();
    }
  } finally {
    await withRow.drop();
  }
  // Without v63, v64 refuses and applies nothing.
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

// A team whose session's units report two zones: the event takes the team's zone (v62), Europe/Berlin here.
let berlin;
async function berlinWorld() {
  if (berlin) return berlin;
  const team = await setupTeam();
  await admin.query(`insert into training_load.gpexe_team_session_timezones (owner_team_id, timezone, set_by_user_id, reason) values ($1,'Europe/Berlin',$2,'test')`, [team.teamId, team.padmin.id]);
  const s = await importSession(team, bundleOf({ sessionId: 9801, ids: [101, 102, 104], zones: { 102: OTHER_TZ } }));
  berlin = { team, s };
  return berlin;
}

test("13. Q2 with v62: in a session whose units report two zones the event is in the team's zone, and the estimate participant takes that zone (not the athlete's own, not a fixture default)", async () => {
  const { team, s } = await berlinWorld();
  assert.equal((await admin.query(`select event_timezone_snapshot z from training_load.metric_events where id = $1`, [s.eventId])).rows[0].z, "Europe/Berlin");
  await admin.query(`update public.athletes set device_timezone = $2 where id = $1`, [team.athleteIds[DAN], OTHER_TZ]);
  const r = await save(team, s, { athleteId: team.athleteIds[DAN], method: "team_average" });
  assert.equal(r.status, 201, r.text);
  const p = (await admin.query(`select athlete_timezone_snapshot z from training_load.metric_event_participants where event_id = $1 and athlete_id = $2`, [s.eventId, team.athleteIds[DAN]])).rows[0];
  assert.equal(p.z, "Europe/Berlin");
});

test("14. one key, two teams at once: a platform admin's two saves with one requestKey and different bodies on two teams' sessions are decided one after the other - the second is request_key_reused, never a second hash or a 500", async () => {
  const a = await historyWorld();
  const b = await berlinWorld();
  const padmin = a.team.padmin;
  const requestKey = key();
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  let reached;
  const atCommit = new Promise((resolve) => { reached = resolve; });
  let calls = 0;
  estimates.setEstimateTestHooks({
    durationKey: a.timeKey,
    beforeCommit: async () => { calls += 1; if (calls === 1) { reached(); await paused; } },
  });
  try {
    const first = save(a.team, a.s, { requestKey, athleteId: a.team.athleteIds[EVA], method: "team_average" }, { cookie: padmin.cookie });
    await atCommit;
    const second = save(b.team, b.s, { requestKey, athleteId: b.team.athleteIds[DAN], method: "team_average" }, { cookie: padmin.cookie });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.status, 201, r1.text);
    assert.deepEqual([r2.status, r2.body.error], [409, "request_key_reused"], r2.text);
  } finally {
    release();
    estimates.setEstimateTestHooks({ durationKey: a.timeKey });
  }
  const hashes = (await admin.query(`select count(distinct request_hash)::int n from training_load.metric_value_estimates where request_key = $1`, [requestKey])).rows[0].n;
  assert.equal(hashes, 1);
});

test("15. v64's guard serialises one (author, key) in the database: a second transaction with another hash waits for the first and is then refused", async () => {
  // Two events of two teams (the occasion trigger locks the event row, so one event would serialise them anyway): only the
  // guard's (author, key) lock orders the two transactions.
  const { team, s } = await historyWorld();
  const other = await berlinWorld();
  assert.equal((await save(team, s, { athleteId: team.athleteIds[EVA], method: "team_average" })).status, 201);
  assert.equal((await save(other.team, other.s, { athleteId: other.team.athleteIds[DAN], method: "team_average" }, { cookie: other.team.padmin.cookie })).status, 201);
  const partOf = async (eventId, athleteId) => (await admin.query(
    `select id from training_load.metric_event_participants where event_id = $1 and athlete_id = $2`, [eventId, athleteId])).rows[0].id;
  const parts = [await partOf(s.eventId, team.athleteIds[EVA]), await partOf(other.s.eventId, other.team.athleteIds[DAN])];
  const def = (await admin.query(
    `select v.metric_definition_id d, v.metric_definition_version_id ver from training_load.metric_value_estimates e join training_load.metric_values v on v.id = e.metric_value_id order by e.estimated_at desc limit 1`,
  )).rows[0];
  const k = key();
  const write = async (c, participantId, hash) => {
    await c.query("begin");
    await c.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.coach.id]);
    const o = (await c.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'estimate',$2) returning id`, [participantId, team.coach.id])).rows[0].id;
    const v = (await c.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1,$2,$3,1) returning id`, [o, def.d, def.ver])).rows[0].id;
    return c.query(`insert into training_load.metric_value_estimates (metric_value_id, occasion_id, method, basis, estimated_by_user_id, request_key, request_hash) values ($1,$2,'team_average','{"athletes":3}',$3,$4,$5)`, [v, o, team.coach.id, k, hash]);
  };
  const ca = new pg.Client({ connectionString: db.url });
  const cb = new pg.Client({ connectionString: db.url });
  await ca.connect();
  await cb.connect();
  try {
    await write(ca, parts[0], "a".repeat(64));
    let settled = false;
    const pending = write(cb, parts[1], "b".repeat(64)).then(() => "ok", (e) => e.message).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false, "the second waits for the first");
    await ca.query("commit");
    assert.match(await pending, /a request key names one request/);
    await cb.query("rollback");
  } finally {
    await ca.end();
    await cb.end();
  }
  assert.equal((await admin.query(`select count(distinct request_hash)::int n from training_load.metric_value_estimates where request_key = $1`, [k])).rows[0].n, 1);
});

test("16. the undo after an estimate saved through the route: not blocked, estimates_removed in the log (UNKNOWN 15); on a roster already Complete the estimate's link turns it to needs_review, and the undo then asks for the roster confirmation (I2)", async () => {
  const team = await setupTeam();
  const undoBody = (s, extra = {}) => ({ requestKey: key(), reason: "wrong athlete link", expected: { eventId: s.eventId }, ...extra });
  const undoPath = (s) => `/teams/${team.teamId}/candidates/${s.candidateId}/undo-import`;
  const estimatesRemoved = async (s) => (await admin.query(`select removed_counts from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0]?.removed_counts?.estimates_removed;

  // A plain session: the estimate never blocks the undo.
  const plain = await importSession(team, bundleOf({ sessionId: 9901, ids: [101, 102, 104] }));
  const saved = await save(team, plain, { athleteId: team.athleteIds[DAN], method: "team_average" });
  assert.equal(saved.status, 201, saved.text);
  const u = await api(undoPath(plain), { method: "POST", cookie: team.padmin.cookie, body: undoBody(plain) });
  assert.equal(u.status, 200, u.text);
  assert.equal(await estimatesRemoved(plain), saved.body.estimates.length);
  assert.equal((await admin.query(`select count(*)::int n from training_load.metric_value_estimates e join training_load.metric_measurement_occasions o on o.id = e.occasion_id join training_load.metric_event_participants p on p.id = o.event_participant_id where p.event_id = $1`, [plain.eventId])).rows[0].n, 0);

  // A Complete roster: the estimate's activity link is a roster change (needs_review), so the undo asks for the confirmation.
  const s = await importSession(team, bundleOf({ sessionId: 9902, ids: [101, 102, 104] }));
  const rosterOf = async () => (await tapi(`/${s.activityId}/roster`, { cookie: team.coach.cookie })).body;
  let roster = await rosterOf();
  for (const a of roster.athletes.filter((x) => x.group === "needs_state")) {
    const r = await tapi(`/${s.activityId}/roster/${a.athleteId}/decision`, { method: "PUT", cookie: team.coach.cookie, body: { kind: "participated_no_values", expectedDecisionId: null, requestKey: key() } });
    assert.equal(r.status, 200, r.text);
  }
  roster = await rosterOf();
  const done = await tapi(`/${s.activityId}/roster/complete`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), expectedRevision: roster.completion.revision, expectedFingerprint: roster.rosterFingerprint } });
  assert.equal(done.status, 200, done.text);
  assert.equal((await rosterOf()).completion.status, "complete");
  assert.equal((await save(team, s, { athleteId: team.athleteIds[DAN], method: "team_average" })).status, 201);
  assert.equal((await rosterOf()).completion.status, "needs_review", "the estimate's link is a roster change");
  const asked = await api(undoPath(s), { method: "POST", cookie: team.padmin.cookie, body: undoBody(s) });
  assert.deepEqual([asked.status, asked.body.error], [409, "roster_work_needs_confirmation"], asked.text);
  const fingerprint = asked.body.rosterWork.laterWork.fingerprint;
  const confirmed = await api(undoPath(s), { method: "POST", cookie: team.padmin.cookie, body: undoBody(s, { laterRosterFingerprint: fingerprint }) });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.ok(await estimatesRemoved(s) > 0);
});

// 6b-C1 (contract rule 10, section 8): the label of an estimated value on the Roster read and the Activities read.
const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LABEL_KEYS = {
  proportional: ["estimatedAt", "estimatedBy", "method", "minutes", "sessionCount"],
  team_average: ["athleteCount", "estimatedAt", "estimatedBy", "method"],
  copy_athlete: ["estimatedAt", "estimatedBy", "method", "sourceAthleteName"],
};
async function athleteUser(athleteId, label) {
  const id = await makeUser(label);
  await admin.query(`update public.athletes set user_id = $2 where id = $1`, [athleteId, id]);
  await setWorkspace(id, "athlete", athleteId);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}

test("17. 6b-C1: each estimated value carries its label (method, basis, author, date) on the Roster read and the Activities read, in closed fields with no id; a measured value is unchanged; a copy source is named only to a reader the answer already names it to (an athlete reading their own results gets the method only); a replaced estimate shows no label; the audiences are unchanged", async () => {
  const team = await setupTeam();
  for (const [sessionId, hour] of [[9701, 6], [9702, 7], [9703, 8]]) await importSession(team, bundleOf({ sessionId, hour, ids: [101, 102, 104, 105] }));
  const s = await importSession(team, bundleOf({ sessionId: 9710, hour: 10, ids: [101, 102, 104] }));
  const timeKey = (await admin.query(`select key from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE time min %'`)).rows[0].key;
  estimates.setEstimateTestHooks({ durationKey: timeKey });
  const [ana, , , dan, eva, fil] = team.athleteIds;
  try {
    assert.equal((await save(team, s, { athleteId: dan, method: "proportional", minutes: 40 })).status, 201);
    assert.equal((await save(team, s, { athleteId: eva, method: "copy_athlete", sourceAthleteId: ana })).status, 201);
    assert.equal((await save(team, s, { athleteId: fil, method: "team_average" })).status, 201);
    // Rule 7: a second estimate of Fil replaces the first; only the current one shows.
    assert.equal((await save(team, s, { athleteId: fil, method: "team_average", note: "again" })).status, 201);
  } finally {
    estimates.setEstimateTestHooks({ durationKey: world?.timeKey ?? timeKey });
  }
  const coachName = "coach";
  const checkLabel = (label, method, where) => {
    assert.ok(label, `${where}: a label`);
    assert.deepEqual(Object.keys(label).sort(), LABEL_KEYS[method], `${where}: closed fields`);
    assert.equal(label.method, method);
    assert.equal(label.estimatedBy, coachName, `${where}: the author's name`);
    assert.ok(!Number.isNaN(Date.parse(label.estimatedAt)), `${where}: a date`);
    assert.ok(!UUID_IN.test(JSON.stringify(label)), `${where}: no id in the label`);
  };

  // The Roster read (coach, team workspace).
  const roster = await tapi(`/${s.activityId}/roster`, { cookie: team.coach.cookie });
  assert.equal(roster.status, 200, roster.text);
  const rowOf = (id) => roster.body.athletes.find((a) => a.athleteId === id);
  for (const [id, method] of [[dan, "proportional"], [eva, "copy_athlete"], [fil, "team_average"]]) {
    const values = rowOf(id).values;
    assert.ok(values.length > 0 && values.every((v) => v.entryMethod === "estimate"), `${method}: estimate values`);
    for (const v of values) checkLabel(v.estimate, method, `roster ${method}`);
  }
  assert.equal(rowOf(dan).values[0].estimate.minutes, 40);
  assert.equal(rowOf(dan).values[0].estimate.sessionCount, 3);
  assert.equal(rowOf(fil).values[0].estimate.athleteCount, 3);
  assert.equal(rowOf(eva).values[0].estimate.sourceAthleteName, rowOf(ana).name, "the copy source by the roster's own name");
  const filTime = rowOf(fil).values.filter((v) => v.metricKey === timeKey);
  assert.equal(filTime.length, 1, "a replaced estimate is not shown (rule 7)");
  for (const v of rowOf(ana).values) assert.ok(!("estimate" in v), "a measured value has no estimate field");
  assert.deepEqual(Object.keys(rowOf(ana).values[0]).sort(), ["entryMethod", "label", "metricKey", "shortLabel", "unit", "value", "valueText"], "a measured value keeps exactly its fields");
  assert.deepEqual(roster.body.viewer, { basis: "team_coach", estimates: true }, "the action is offered while the flag is on");
  process.env.ESTIMATES_ENABLED = "false";
  try {
    assert.deepEqual((await tapi(`/${s.activityId}/roster`, { cookie: team.coach.cookie })).body.viewer, { basis: "team_coach" }, "flag off: the viewer is as before");
  } finally {
    process.env.ESTIMATES_ENABLED = "true";
  }
  // The state stays: an estimate is not measured.
  assert.notEqual(rowOf(dan).state, "measured");

  // The Activities read (coach, club admin, platform admin): the same labels on the facts.
  for (const who of [team.coach, team.cadmin, team.padmin]) {
    const read = await tapi(`/${s.activityId}`, { cookie: who.cookie });
    assert.equal(read.status, 200, read.text);
    const est = read.body.facts.filter((f) => f.detail?.entryMethod === "estimate");
    assert.ok(est.length > 0);
    for (const f of est) {
      const method = String(f.athleteId) === String(dan) ? "proportional" : String(f.athleteId) === String(eva) ? "copy_athlete" : "team_average";
      checkLabel(f.estimate, method, `activities ${method}`);
      if (method === "copy_athlete") assert.equal(f.estimate.sourceAthleteName, read.body.athleteNamesById[ana]);
    }
    for (const f of read.body.facts.filter((x) => x.detail?.entryMethod !== "estimate")) assert.ok(!("estimate" in f), "no estimate field on another fact");
  }

  // An athlete sees only what was really measured (owner, 2026-11-16): no estimate on her side - no value, no label,
  // no method, no name of its variable, no trace that one exists - on every read her session can reach.
  const day = (await admin.query(`select occurred_local_date::text d from training.activities where id = $1`, [s.activityId])).rows[0].d;
  const mapi = (path, opts) => call("/api/training-load/metrics", path, opts);
  const estimateOccasions = async (athleteId) => (await admin.query(
    `select o.id from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id
      where p.athlete_id = $1 and o.entry_method = 'estimate'`, [athleteId])).rows.map((r) => String(r.id));
  const TRACES = ["estimate", "copy_athlete", "proportional", "team_average", "estimatedBy", "estimatedAt", "entryMethod"];
  const evaUser = await athleteUser(eva, "eva athlete");
  const own = await tapi(`/${s.activityId}`, { cookie: evaUser.cookie });
  let selfReads = 0;
  const coachRead = await tapi(`/${s.activityId}`, { cookie: team.coach.cookie });
  assert.equal(coachRead.status, 200, coachRead.text);
  for (const [id, method, label, user] of [[eva, "copy_athlete", "eva athlete", evaUser], [dan, "proportional", "dan athlete", null], [fil, "team_average", "fil athlete", null]]) {
    const self = user ?? await athleteUser(id, label);
    // (c) The coach still reads her estimate, with its label.
    const coachFacts = coachRead.body.facts.filter((f) => String(f.athleteId) === String(id) && f.detail.entryMethod === "estimate");
    assert.ok(coachFacts.length > 0 && coachFacts.every((f) => f.estimate?.method === method), `${method}: the coach's read is unchanged`);
    // (a) She was not in the recording: her place in this session exists ONLY because the coach estimated her. The
    // session is not hers to see - the identical 404 of a missing one - and is in neither her list nor her calendars,
    // so nothing tells her that an estimate was made.
    const detail = await tapi(`/${s.activityId}`, { cookie: self.cookie });
    const missingActivity = await tapi(`/${crypto.randomUUID()}`, { cookie: self.cookie });
    assert.deepEqual([detail.status, detail.text], [404, missingActivity.text], `${method}: the session answers as a missing one`);
    const rows = (await call("/api/training-activity", `?dateFrom=${day}&dateTo=${day}`, { cookie: self.cookie })).body.rows.filter((r) => r.activityId === s.activityId);
    assert.deepEqual(rows, [], `${method}: not in her list`);
    const items = (await call("/api/training-load", `/calendar?dateFrom=${day}&dateTo=${day}`, { cookie: self.cookie })).body.days.flatMap((d) => d.items).filter((i) => i.activityId === s.activityId);
    assert.deepEqual(items, [], `${method}: not in her training calendar`);
    // Metrics Core: her results hold no estimate, and an estimate's own occasion answers as one that does not exist.
    const results = await mapi(`/results?dateFrom=${day}&dateTo=${day}`, { cookie: self.cookie });
    assert.equal(results.status, 200, results.text);
    for (const trace of TRACES.filter((t) => t !== "entryMethod")) assert.ok(!results.text.includes(trace), `${method}: results carry no "${trace}"`);
    const occasions = await estimateOccasions(id);
    assert.ok(occasions.length > 0);
    const missing = await mapi(`/occasions/${crypto.randomUUID()}`, { cookie: self.cookie });
    for (const occasionId of occasions) {
      assert.ok(!results.text.includes(occasionId), "not among her results");
      for (const path of [`/occasions/${occasionId}`, `/occasions/${occasionId}/history`]) {
        const res = await mapi(path, { cookie: self.cookie });
        const none = await mapi(path.replace(occasionId, "00000000-0000-4000-8000-000000000000"), { cookie: self.cookie });
        assert.deepEqual([res.status, res.text], [none.status, none.text], `${method}: ${path.includes("history") ? "history" : "occasion"} identical to a missing one`);
      }
      // The coach still opens it.
      assert.equal((await mapi(`/occasions/${occasionId}`, { cookie: team.coach.cookie })).status, 200);
    }
    assert.equal(missing.status, 404);
    selfReads += 1;
  }
  assert.equal(selfReads, 3);
  // (b) An estimate beside a value a coach then entered by hand as a measurement, on the same variable of the same
  // session: she gets the measured value alone (a hand-entered measurement is a measured value); the coach reads both.
  const distanceDef = (await admin.query(`select d.id, d.current_version_id as version from training_load.metric_definitions d where d.owner_scope = 'system' and d.label like 'GPEXE total distance %'`)).rows[0];
  const danEstimateOnDistance = coachRead.body.facts.filter((f) => String(f.athleteId) === String(dan) && f.detail.entryMethod === "estimate" && f.detail.metricDefinitionId === String(distanceDef.id));
  assert.equal(danEstimateOnDistance.length, 1, "the fixture: Dan has an estimate of the distance");
  const byHand = await mapi("/events", { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), occurredDate: day, scopeLevel: "session", activityId: s.activityId,
    participants: [{ athleteId: dan, timezone: "UTC", values: [{ metricDefinitionId: distanceDef.id, metricDefinitionVersionId: distanceDef.version, value: 4321.5 }] }] } });
  assert.equal(byHand.status, 201, byHand.text);
  const danBoth = await tapi(`/${s.activityId}`, { cookie: (await athleteUser(dan, "dan measured")).cookie });
  assert.equal(danBoth.status, 200, danBoth.text);
  assert.deepEqual(danBoth.body.facts.filter((f) => f.factKind === "metric_value").map((f) => [f.detail.metricDefinitionId, Number(f.detail.valueNumeric)]), [[String(distanceDef.id), 4321.5]]);
  assert.deepEqual([danBoth.body.recordedBy, danBoth.body.myAttendance, Object.keys(danBoth.body.variableNamesById)], ["coach", "participated", [String(distanceDef.id)]]);
  for (const trace of TRACES) assert.ok(!danBoth.text.includes(trace), `beside a measured value: no "${trace}"`);
  assert.ok(!danBoth.text.includes(String(Number(danEstimateOnDistance[0].detail.valueNumeric))) || Number(danEstimateOnDistance[0].detail.valueNumeric) === 4321.5, "not the estimated number");
  const coachBoth = await tapi(`/${s.activityId}`, { cookie: team.coach.cookie });
  const danForCoach = coachBoth.body.facts.filter((f) => String(f.athleteId) === String(dan) && f.detail.metricDefinitionId === String(distanceDef.id)).map((f) => f.detail.entryMethod).sort();
  assert.deepEqual(danForCoach, ["estimate", "manual"], "the coach reads both, the estimate with its label");
  // "My training": the participation an estimate made is not hers. Fil has nothing else: no entry.
  // Dan was measured in the earlier sessions: he has one. Eva, like Fil, has only an estimate.
  const filUser = await athleteUser(fil, "fil again");
  const selfOf = async (cookie) => (await tapi("/self", { cookie })).body;
  const measuredElsewhere = async (athleteId) => (await admin.query(
    `select count(*)::int n from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id
      where p.athlete_id = $1 and o.entry_method <> 'estimate' and o.superseded_by_occasion_id is null`, [athleteId])).rows[0].n;
  assert.equal(await measuredElsewhere(fil), 0, "the fixture: Fil has only estimates");
  assert.deepEqual(await selfOf(filUser.cookie), { hasRecordedSessions: false });
  assert.ok((await measuredElsewhere(dan)) > 0, "the fixture: Dan was measured in the earlier sessions");
  assert.deepEqual(await selfOf((await athleteUser(dan, "dan again")).cookie), { hasRecordedSessions: true });
  assert.equal(await measuredElsewhere(eva), 0, "the fixture: Eva has only an estimate");
  assert.deepEqual(await selfOf(evaUser.cookie), { hasRecordedSessions: false });
  const anaName = (await admin.query(`select coalesce(nullif(display_name, ''), full_name) as n from public.athletes where id = $1`, [ana])).rows[0].n;
  assert.ok(!own.text.includes(anaName), "the copy source's name never reaches the athlete");
  // The other direction: Ana, the source, reading her own results learns nothing of Eva's estimate.
  const anaUser = await athleteUser(ana, "ana athlete");
  const source = await tapi(`/${s.activityId}`, { cookie: anaUser.cookie });
  assert.equal(source.status, 200, source.text);
  // Her own facts only (an athlete's answer names no athlete: athlete-own-results.test.mjs).
  assert.ok(source.body.facts.some((f) => f.factKind === "metric_value"), "Ana's own facts are there");
  assert.ok(!source.text.includes(String(dan)) && !source.text.includes(String(fil)), "no other athlete's fact");
  assert.ok(source.body.facts.every((f) => !("estimate" in f) && f.detail?.entryMethod !== "estimate"), "no estimate in the source's answer");
  const evaName = (await admin.query(`select coalesce(nullif(display_name, ''), full_name) as n from public.athletes where id = $1`, [eva])).rows[0].n;
  assert.ok(!source.text.includes(evaName) && !source.text.includes(String(eva)), "the source never learns who copied from them");

  // A source athlete who left the team after the session: named as the roster names them (still on that day's roster).
  await admin.query(`update public.athlete_memberships set status = 'archived', ends_at = now() where athlete_id = $1 and team_id = $2`, [ana, team.teamId]).catch(async () => {
    await admin.query(`update public.athlete_memberships set status = 'archived' where athlete_id = $1 and team_id = $2`, [ana, team.teamId]);
  });
  const after = await tapi(`/${s.activityId}/roster`, { cookie: team.coach.cookie });
  assert.equal(after.status, 200, after.text);
  const anaAfter = after.body.athletes.find((a) => a.athleteId === ana) ?? after.body.recordedOutsideRoster?.find((a) => a.athleteId === ana);
  const evaAfter = after.body.athletes.find((a) => a.athleteId === eva);
  assert.ok(anaAfter, "the source is still in the answer");
  assert.equal(evaAfter.values[0].estimate.sourceAthleteName, anaAfter.name, "named exactly as this answer names them");

  // The audiences are unchanged: another team's coach and a missing activity get the identical 404 on both reads.
  const other = await setupTeam();
  for (const path of [`/${s.activityId}/roster`]) {
    const foreign = await tapi(path, { cookie: other.coach.cookie });
    const missing = await tapi(path.replace(s.activityId, "00000000-0000-4000-8000-000000000000"), { cookie: other.coach.cookie });
    assert.deepEqual([foreign.status, foreign.text], [missing.status, missing.text], `${path}: identical`);
    assert.equal(foreign.status, 404);
    assert.ok(!foreign.text.includes("estimate"));
  }
  const foreignRead = await tapi(`/${s.activityId}`, { cookie: other.coach.cookie });
  const missingRead = await tapi(`/00000000-0000-4000-8000-000000000000`, { cookie: other.coach.cookie });
  assert.deepEqual([foreignRead.status, foreignRead.text], [missingRead.status, missingRead.text], "activities read: identical");
});

test("17z. the invariant: every athlete read answers as if no estimate had ever been written - byte for byte, before and after the coach estimates her", async () => {
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9731, hour: 10, ids: [101, 102, 104] }));
  const day = (await admin.query(`select occurred_local_date::text d from training.activities where id = $1`, [s.activityId])).rows[0].d;
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  const { runDashboardBatchQuery } = await import("../src/trainingLoadDashboardQuery.js");
  const [absent, present] = [team.athleteIds[EVA], team.athleteIds[5]];
  // `present` took part without a device: a participant of the session with no value. `absent` is not in it at all.
  await admin.query(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status, merge_status)
     select a.id, $2, a.occurred_local_date, a.timezone_snapshot, 'participated', 'canonical' from training.activities a where a.id = $1`, [s.activityId, present]);
  const users = { absent: await athleteUser(absent, "absent athlete"), present: await athleteUser(present, "present athlete") };
  const readsOf = async (athleteId, cookie) => {
    const get = async (base, path) => { const res = await call(base, path, { cookie }); return `${res.status} ${res.text}`; };
    const dashboards = await runDashboardBatchQuery(
      { dataWorkspaceType: "athlete", dataWorkspaceScopeId: null, dataWorkspaceUserId: null, athleteWorkspaceAthleteId: athleteId, dateFrom: day, dateTo: day },
      [...["all_with_conflicts", "estimate", "manual", "api_import"].map((sourcePolicy) => ({ widgetId: "w", seriesId: sourcePolicy, metricDefinitionId: distance, dataScopeLevel: "session", groupBy: "athlete", analyticalAggregation: "sum", sourcePolicy, sourceConnectionId: null })),
        { widgetId: "w", seriesId: "count", builtInSeriesKey: "session_count", dataScopeLevel: "day", groupBy: "athlete", analyticalAggregation: "sum" },
        { widgetId: "w", seriesId: "last", builtInSeriesKey: "last_session_date", dataScopeLevel: "day", groupBy: "athlete", analyticalAggregation: "last" }],
    );
    return {
      detail: await get("/api/training-activity", `/${s.activityId}`),
      list: await get("/api/training-activity", `?dateFrom=${day}&dateTo=${day}`),
      calendar: await get("/api/training-load", `/calendar?dateFrom=${day}&dateTo=${day}`),
      self: await get("/api/training-activity", "/self"),
      results: await get("/api/training-load/metrics", `/results?dateFrom=${day}&dateTo=${day}`),
      dashboards: JSON.stringify(dashboards),
    };
  };
  const before = { absent: await readsOf(absent, users.absent.cookie), present: await readsOf(present, users.present.cookie) };
  // What each sees before any estimate: the absent athlete nothing; the present one her session, with nothing recorded.
  assert.ok(before.absent.detail.startsWith("404 "), before.absent.detail);
  assert.ok(before.present.detail.startsWith("200 ") && before.present.list.includes(s.activityId) && before.present.calendar.includes(s.activityId), "her session, before");
  assert.ok(!before.absent.list.includes(s.activityId) && !before.absent.calendar.includes(s.activityId));
  assert.equal(before.absent.self, `200 ${JSON.stringify({ hasRecordedSessions: false })}`);
  assert.equal(before.present.self, `200 ${JSON.stringify({ hasRecordedSessions: true })}`, "she took part in a recorded session");
  assert.ok(before.present.dashboards.includes(present) && !before.absent.dashboards.includes(absent), "her session counts on her dashboard; the absent athlete has none");

  // The coach estimates both (two methods), and reads both estimates.
  assert.equal((await save(team, s, { athleteId: absent, method: "team_average" })).status, 201);
  assert.equal((await save(team, s, { athleteId: present, method: "copy_athlete", sourceAthleteId: team.athleteIds[ANA] })).status, 201);
  const coachRead = await tapi(`/${s.activityId}`, { cookie: team.coach.cookie });
  for (const id of [absent, present]) assert.ok(coachRead.body.facts.some((f) => String(f.athleteId) === String(id) && f.detail.entryMethod === "estimate" && f.estimate), "the coach reads the estimate");

  const after = { absent: await readsOf(absent, users.absent.cookie), present: await readsOf(present, users.present.cookie) };
  for (const who of ["absent", "present"]) {
    for (const read of Object.keys(before[who])) assert.equal(after[who][read], before[who][read], `${who} athlete, ${read}: identical before and after the estimate`);
  }
  // And a second estimate (a replacement) changes nothing either.
  assert.equal((await save(team, s, { athleteId: present, method: "team_average", note: "again" })).status, 201);
  assert.deepEqual(await readsOf(present, users.present.cookie), before.present);
});

test("17y. what an athlete's reads rest on: an estimate's participant row and its occasions are written in one transaction (same created_at, same xmin); through a merged-away session nothing is written at all", async () => {
  // The rows an estimate wrote for one athlete in one session: her activity participant row(s) and the estimate's occasions.
  const written = async (activityId, athleteId) => ({
    participants: (await admin.query(
      `select ap.id, ap.activity_id, ap.created_at, ap.xmin::text as xmin from training.activity_participants ap
        where ap.athlete_id = $2 and training.resolve_canonical_activity_id(ap.activity_id) = training.resolve_canonical_activity_id($1)`, [activityId, athleteId])).rows,
    occasions: (await admin.query(
      `select o.id, o.created_at, o.xmin::text as xmin, o.entry_method
         from training.activity_participants ap
         join training.activity_participant_metric_participant_links l on l.activity_participant_id = ap.id and l.link_status = 'confirmed'
         join training_load.metric_measurement_occasions o on o.event_participant_id = l.metric_event_participant_id
        where ap.athlete_id = $2 and training.resolve_canonical_activity_id(ap.activity_id) = training.resolve_canonical_activity_id($1)`, [activityId, athleteId])).rows,
  });
  const sameTransaction = (rows, what) => {
    assert.equal(rows.participants.length, 1, `${what}: one participant row`);
    assert.ok(rows.occasions.length > 0 && rows.occasions.every((o) => o.entry_method === "estimate"), `${what}: only the estimate's occasions`);
    const p = rows.participants[0];
    for (const o of rows.occasions) {
      assert.equal(new Date(o.created_at).getTime(), new Date(p.created_at).getTime(), `${what}: the same created_at (what athleteOwnParticipationSql compares)`);
      assert.equal(o.xmin, p.xmin, `${what}: written by the same transaction`);
    }
  };
  const hiddenFor = async (athleteId, activityId, what) => {
    const me = await athleteUser(athleteId, `${what} athlete`);
    const res = await tapi(`/${activityId}`, { cookie: me.cookie });
    const missing = await tapi(`/${crypto.randomUUID()}`, { cookie: me.cookie });
    assert.deepEqual([res.status, res.text], [404, missing.text], `${what}: the session is not hers`);
    assert.deepEqual((await tapi("/self", { cookie: me.cookie })).body, { hasRecordedSessions: false }, what);
  };

  // 1. An athlete who was not in the recording.
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9741, hour: 10, ids: [101, 102, 104] }));
  const absent = team.athleteIds[EVA];
  assert.deepEqual((await written(s.activityId, absent)).participants, [], "before: she has no participant row");
  assert.equal((await save(team, s, { athleteId: absent, method: "team_average" })).status, 201);
  sameTransaction(await written(s.activityId, absent), "not in the recording");
  await hiddenFor(absent, s.activityId, "not in the recording");

  // 2. The same through a merged-away session: the recording's session was merged into another one, and the coach
  // estimates an absent athlete on the surviving session.
  const other = await setupTeam();
  const imported = await importSession(other, bundleOf({ sessionId: 9742, hour: 10, ids: [101, 102, 104] }));
  const columns = (await admin.query(`select string_agg(quote_ident(column_name), ',') as c from information_schema.columns where table_schema = 'training' and table_name = 'activities' and column_name <> 'id' and is_generated = 'NEVER'`)).rows[0].c;
  const survivor = String((await admin.query(`insert into training.activities (${columns}) select ${columns} from training.activities where id = $1 returning id`, [imported.activityId])).rows[0].id);
  await admin.query("begin");
  await admin.query(`select set_config('training.allow_supersede_write', 'on', true)`);
  await admin.query(`update training.activities set superseded_by_activity_id = $2, lifecycle_state = 'superseded' where id = $1`, [imported.activityId, survivor]);
  await admin.query("commit");
  const absent2 = other.athleteIds[EVA];
  // Today such an estimate cannot be written at all: the recording's event is linked to the merged-away session, and
  // the database refuses a participant link on another one (the whole save rolls back; the coach is told nothing
  // was saved). So no participant row exists for her - there is nothing an athlete read could show. Pinned as it is:
  // if this save ever starts to succeed, the rows it writes must pass sameTransaction() here before it ships.
  const saved = await save(other, { activityId: survivor }, { athleteId: absent2, method: "team_average" });
  assert.deepEqual([saved.status, saved.body.error], [500, "internal_error"], saved.text);
  const rows = await written(survivor, absent2);
  assert.deepEqual([rows.participants, rows.occasions], [[], []], "nothing was written for her, on either session");
  await hiddenFor(absent2, survivor, "through a merged-away session");
  await hiddenFor(absent2, imported.activityId, "through a merged-away session, by the old id");
});

test("18. 6b-D: the dashboards leave an estimate out under every policy - all sources and calculated values included - and show it only under 'estimate', which shows estimates alone", async () => {
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9721, hour: 10, ids: [101, 102, 104] }));
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  const dan = team.athleteIds[DAN];
  const r = await save(team, s, { athleteId: dan, method: "team_average" });
  assert.equal(r.status, 201, r.text);
  const estimated = r.body.estimates.find((e) => e.metricDefinitionId === distance).value;
  const { runDashboardBatchQuery } = await import("../src/trainingLoadDashboardQuery.js");
  const day = (await admin.query(`select occurred_local_date::text d from training.activities where id = $1`, [s.activityId])).rows[0].d;
  const run = async (sourcePolicy, sourceConnectionId = null) => {
    const [result] = await runDashboardBatchQuery(
      { dataWorkspaceType: "team", dataWorkspaceScopeId: team.teamId, dateFrom: day, dateTo: day },
      [{ widgetId: "w", seriesId: sourcePolicy, metricDefinitionId: distance, dataScopeLevel: "session", groupBy: "athlete", analyticalAggregation: "sum", sourcePolicy, sourceConnectionId }],
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    return result.data.current;
  };
  const measured = [team.athleteIds[ANA], team.athleteIds[BEA], team.athleteIds[CIL]].sort();
  assert.deepEqual((await run("all_with_conflicts")).map((x) => x.athleteId).sort(), measured, "all sources: the measured athletes, as before; not the estimate");
  assert.deepEqual((await run("api_import")).map((x) => x.athleteId).sort(), measured, "API import only: the measured athletes");
  // An estimate carries its event's connection, so 'source_connection' is the one policy whose own filter it would pass.
  const conn = (await admin.query(`select source_connection_id c from training_load.metric_events where id = $1`, [s.eventId])).rows[0].c;
  assert.ok(conn, "the imported event names its connection");
  assert.deepEqual((await run("source_connection", conn)).map((x) => x.athleteId).sort(), measured, "One connected source: the measured athletes; never the estimate");
  for (const policy of ["derived", "manual", "csv_import"]) {
    assert.ok(!(await run(policy)).some((x) => x.athleteId === dan), `${policy}: the estimate is left out`);
  }
  assert.deepEqual((await run("estimate")).map((x) => [x.athleteId, Number(x.value)]), [[dan, estimated]], "estimate: the estimate alone");
  // An athlete's own dashboards read only what was really measured: under no policy - 'estimate' included - is her
  // estimate shown; a measured athlete's own value is still hers.
  const asAthlete = async (athleteId, sourcePolicy) => {
    const [result] = await runDashboardBatchQuery(
      { dataWorkspaceType: "athlete", dataWorkspaceScopeId: null, dataWorkspaceUserId: null, athleteWorkspaceAthleteId: athleteId, dateFrom: day, dateTo: day },
      [{ widgetId: "w", seriesId: sourcePolicy, metricDefinitionId: distance, dataScopeLevel: "session", groupBy: "athlete", analyticalAggregation: "sum", sourcePolicy, sourceConnectionId: null }],
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    return result.data.current;
  };
  for (const policy of ["estimate", "all_with_conflicts", "manual", "api_import", "derived"]) assert.deepEqual(await asAthlete(dan, policy), [], `athlete, ${policy}: no estimate`);
  // Once he also has a measured value in that session (entered by hand, on another variable) the session is his to
  // see - and his estimate of the distance still is not, under any policy.
  const timeDef = (await admin.query(`select d.id, d.current_version_id as version from training_load.metric_definitions d where d.owner_scope = 'system' and d.label like 'GPEXE time min %'`)).rows[0];
  const byHand = await call("/api/training-load/metrics", "/events", { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), occurredDate: day, scopeLevel: "session", activityId: s.activityId,
    participants: [{ athleteId: dan, timezone: "UTC", values: [{ metricDefinitionId: timeDef.id, metricDefinitionVersionId: timeDef.version, value: 33 }] }] } });
  assert.equal(byHand.status, 201, byHand.text);
  for (const policy of ["estimate", "all_with_conflicts", "manual", "api_import"]) assert.deepEqual(await asAthlete(dan, policy), [], `athlete with a measured value, ${policy}: still no estimate of the distance`);
  assert.deepEqual((await run("estimate")).map((x) => x.athleteId), [dan], "the coach's dashboard still shows it");
  assert.deepEqual((await asAthlete(team.athleteIds[ANA], "all_with_conflicts")).map((x) => x.athleteId), [team.athleteIds[ANA]], "a measured value is still hers");
  assert.deepEqual(await asAthlete(team.athleteIds[ANA], "estimate"), []);
});

test("18b. 6b-D: the series routes take 'estimate' - a new series and a change of an existing one store it, with no connection", async () => {
  const team = await setupTeam();
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  const dapi = (path, opts) => call("/api/training-load/dashboards", path, { cookie: team.coach.cookie, ...opts });
  const made = await dapi("", { method: "POST", body: { name: "Estimates" } });
  assert.equal(made.status, 201, made.text);
  const dashboard = made.body.dashboard;
  const widget = await dapi(`/${dashboard.id}/widgets`, { method: "POST", body: { expectedDashboardRevision: dashboard.revision, widgetType: "table", title: "W", widgetOrder: 1, x: 0, y: 0, width: 6, height: 4, mobileOrder: 1 } });
  assert.equal(widget.status, 201, widget.text);
  const seriesBody = (order, sourcePolicy) => ({ expectedWidgetRevision: order, seriesOrder: order, metricDefinitionId: distance, dataScopeLevel: "session", analyticalAggregation: "sum", sourcePolicy });
  const created = await dapi(`/${dashboard.id}/widgets/${widget.body.widgetId}/series`, { method: "POST", body: seriesBody(1, "estimate") });
  assert.equal(created.status, 201, created.text);
  const other = await dapi(`/${dashboard.id}/widgets/${widget.body.widgetId}/series`, { method: "POST", body: seriesBody(2, "all_with_conflicts") });
  assert.equal(other.status, 201, other.text);
  const changed = await dapi(`/${dashboard.id}/widgets/${widget.body.widgetId}/series/${other.body.seriesId}`, { method: "PATCH", body: { expectedWidgetRevision: other.body.widgetRevision, sourcePolicy: "estimate" } });
  assert.equal(changed.status, 200, changed.text);
  const stored = (await admin.query(`select source_policy, source_connection_id from training_load.dashboard_widget_series where widget_id = $1 order by series_order`, [widget.body.widgetId])).rows;
  assert.deepEqual(stored, [{ source_policy: "estimate", source_connection_id: null }, { source_policy: "estimate", source_connection_id: null }]);
});

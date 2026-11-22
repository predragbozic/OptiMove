// v87: the estimate method position_average (docs/ai/athlete-positions-plan.md). The mean of the measured values of the
// athletes of the same position in this session - the team average's rule (at least 3 athletes, no minutes). Without a
// position, or with too few athletes of it, the method is not available and says why; it is never replaced by another.
// Disposable database (the calendar fixture's migrations plus v87); the imports are real approvals through the routes;
// invented people only.
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
import { calendarMigrations } from "./support/calendar-fixture.mjs";

const V87 = "202611221200_athletes_v87_positions.sql";
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
let labels;
let createSession;
let appPool;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "pos87est", migrations: [...calendarMigrations(), V87] });
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
  labels = await import("../src/estimateLabels.js");
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

async function call(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const api = (path, opts) => call(`/api/training-load/gpexe${path}`, opts);
const tapi = (path, opts) => call(`/api/training-activity${path}`, opts);

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
async function withRole(label, sql, params, workspace) {
  const id = await makeUser(label);
  await admin.query(sql, [id, ...params]);
  await setWorkspace(id, ...workspace);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}

// GPEXE athletes 101 and 102 are the fixture's; 104 and 106 are copies of 102 (1300 s, 1800 m); 105 trains 1500 s, 2500 m.
function athleteSpec(id) {
  const std = Object.fromEntries(standardAthletes().map((a) => [a.id, a]));
  if (std[id]) return structuredClone(std[id]);
  const a = structuredClone(std[102]);
  a.id = id;
  const whole = id === 105 ? { time: 1500, distance: 2500 } : { time: 1300, distance: 1800 };
  a.parts = a.parts.map((p) => ({ ...p, ...whole }));
  return a;
}
function bundleOf({ sessionId, hour = 10, ids }) {
  const athletes = ids.map((id, i) => {
    const a = athleteSpec(id);
    a.tracks = [sessionId * 10 + i];
    for (const part of a.parts) delete part.track;
    return a;
  });
  return makeFixtureBundle({ detailsDrills: [0, 1], sessionId, gpexeTeamId: 77, start: `2026-09-14T${String(hour).padStart(2, "0")}:08:12`, updatedOn: "2026-09-14T20:18:09.337", athletes });
}

// Ana 101, Bea 102, Cil 104, Dan (the target, no data), Eva 105, Fil 106.
const [ANA, BEA, CIL, DAN, EVA, FIL] = [0, 1, 2, 3, 4, 5];
async function setupTeam() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["Ana", "Bea", "Cil", "Dan", "Eva", "Fil"] });
  await admin.query(`delete from public.athlete_memberships where team_id = $1`, [org.teamId]);
  for (const athleteId of org.athleteIds) {
    await admin.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athleteId, org.clubId, org.teamId]);
  }
  const coach = await withRole("coach", `insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [org.teamId], ["team", org.teamId]);
  const padmin = await withRole("platform admin", `insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [], ["platform", null]);
  const sourceTeamId = "8801";
  assert.equal((await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } })).status, 200);
  src.show(sourceTeamId);
  const { bindingId } = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId });
  await enableTeamImportSwitch(admin, org.teamId);
  await activateBinding(admin, bindingId);
  const ids = org.athleteIds;
  for (const [gpexeAthleteId, athleteId] of [["101", ids[ANA]], ["102", ids[BEA]], ["104", ids[CIL]], ["105", ids[EVA]], ["106", ids[FIL]]]) {
    assert.equal((await api(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId, athleteId } })).status, 201);
  }
  return { ...org, coach, padmin, sourceTeamId };
}

async function importSession(team, bundle) {
  src.serve(team.sourceTeamId, [bundle]);
  const started = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: { from: D1, to: D1 } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 200; i += 1) {
    const r = await api(`/teams/${team.teamId}/checks/${started.body.check.id}`, { cookie: team.coach.cookie });
    if (r.body.check?.status !== "running") {
      assert.equal(r.body.check.status, "succeeded", JSON.stringify(r.body.check));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const cand = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates
    .find((c) => c.gpexeTeamSessionId === String(bundle.teamSession.id) && c.status === "pending");
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
  const approval = (await admin.query(`select activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0];
  return { activityId: String(approval.activity_id) };
}

const key = () => crypto.randomUUID();
const proposal = (team, s, athleteId) => tapi(`/${s.activityId}/estimates/proposal?athleteId=${athleteId}`, { cookie: team.coach.cookie });
const save = (team, s, body) => tapi(`/${s.activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), ...body } });
// The coach sets a position through the v87 route (team workspace, team_coach basis).
async function setPosition(team, athleteIdx, name) {
  const athleteId = team.athleteIds[athleteIdx];
  const positionId = name ? (await admin.query(`select id from public.sport_positions where owner_scope = 'system' and name = $1`, [name])).rows[0].id : null;
  const current = (await admin.query(`select public.athlete_position_in_force($1, $2) as p`, [athleteId, team.clubId])).rows[0].p;
  const r = await call(`/api/positions/athletes/${athleteId}`, { method: "PUT", cookie: team.coach.cookie, body: { requestKey: key(), positionId, expectedPositionId: current } });
  assert.equal(r.status, 200, r.text);
  return positionId;
}
const round3 = (x) => Math.round(x * 1000) / 1000;
const writes = async () => (await admin.query(`select count(*)::int as n from training_load.metric_value_estimates`)).rows[0].n;

let world;
async function positionWorld() {
  if (world) return world;
  const team = await setupTeam();
  const s = await importSession(team, bundleOf({ sessionId: 9710, ids: [101, 102, 104, 105, 106] }));
  const distance = String((await admin.query(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`)).rows[0].id);
  // The measured whole-session distance of each athlete, as the estimate reads it.
  const measured = new Map((await admin.query(
    `select p.athlete_id, v.value_numeric::float8 as value
       from training_load.metric_event_participants p
       join training_load.metric_measurement_occasions o on o.event_participant_id = p.id
       join training_load.metric_values v on v.occasion_id = o.id
      where v.metric_definition_id = $1 and o.segment_id is null and o.entry_method = 'api_import' and o.superseded_by_occasion_id is null`,
    [distance],
  )).rows.map((r) => [String(r.athlete_id), Number(r.value)]));
  world = { team, s, distance, measured };
  return world;
}
const valueOf = (view, def) => view.values.find((x) => x.metricDefinitionId === def);

test("1. no position: position_average is not available with no_position; the team average stays available, never offered in its place; the save refuses with nothing written", async () => {
  const { team, s, distance } = await positionWorld();
  const before = await writes();
  const r = await proposal(team, s, team.athleteIds[DAN]);
  assert.equal(r.status, 200, r.text);
  const pa = r.body.methods.position_average;
  assert.equal(pa.available, false);
  assert.equal(pa.reason, "no_position");
  assert.equal(pa.position, null);
  assert.ok(pa.values.every((v) => v.value === null && v.reason === "no_position"));
  assert.equal(r.body.methods.team_average.available, true, "the team average is its own method");
  assert.notEqual(valueOf(r.body.methods.team_average, distance).value, null);
  const w = await save(team, s, { athleteId: team.athleteIds[DAN], method: "position_average" });
  assert.deepEqual([w.status, w.body.error], [409, "no_position"]);
  assert.equal(await writes(), before);
});

test("2. too few athletes of the position: two measured midfielders are not enough (at least 3); the reason names it and nothing is saved", async () => {
  const { team, s } = await positionWorld();
  await setPosition(team, DAN, "Midfielder");
  await setPosition(team, BEA, "Midfielder");
  await setPosition(team, CIL, "Midfielder");
  const before = await writes();
  const r = await proposal(team, s, team.athleteIds[DAN]);
  const pa = r.body.methods.position_average;
  assert.deepEqual([pa.available, pa.reason, pa.position?.name], [false, "too_few_athletes_in_position", "Midfielder"]);
  const w = await save(team, s, { athleteId: team.athleteIds[DAN], method: "position_average" });
  assert.deepEqual([w.status, w.body.error, w.body.reasons], [409, "nothing_to_estimate", ["too_few_athletes_in_position"]]);
  assert.equal(await writes(), before);
});

test("3. the position average: the mean of the three measured forwards (not the team's five); the target and other positions are left out; the save stores the basis with the position and its label names it", async () => {
  const { team, s, distance, measured } = await positionWorld();
  const forward = await setPosition(team, DAN, "Forward");
  for (const idx of [ANA, EVA, FIL]) await setPosition(team, idx, "Forward");
  const r = await proposal(team, s, team.athleteIds[DAN]);
  const pa = r.body.methods.position_average;
  assert.equal(pa.available, true, JSON.stringify(pa));
  assert.deepEqual(pa.position, { id: forward, name: "Forward" });
  const forwards = [ANA, EVA, FIL].map((i) => measured.get(String(team.athleteIds[i])));
  const all = [ANA, BEA, CIL, EVA, FIL].map((i) => measured.get(String(team.athleteIds[i])));
  assert.ok(forwards.every(Number.isFinite) && all.every(Number.isFinite), "every athlete was measured");
  const expected = round3(forwards.reduce((a, b) => a + b, 0) / 3);
  assert.deepEqual(valueOf(pa, distance), { metricDefinitionId: distance, value: expected, reason: null, basis: { athletes: 3, positionId: forward } });
  assert.notEqual(expected, round3(all.reduce((a, b) => a + b, 0) / 5), "the world tells the two methods apart");
  assert.equal(valueOf(r.body.methods.team_average, distance).value, round3(all.reduce((a, b) => a + b, 0) / 5));
  const w = await save(team, s, { athleteId: team.athleteIds[DAN], method: "position_average" });
  assert.equal(w.status, 201, w.text);
  assert.equal(w.body.method, "position_average");
  const saved = w.body.estimates.find((e) => e.metricDefinitionId === distance);
  assert.deepEqual([saved.value, saved.basis], [expected, { athletes: 3, positionId: forward }]);
  // The label: the method, the athlete count and the position's name.
  const map = await labels.readEstimateLabels(admin, [saved.occasionId]);
  const label = labels.estimateLabelFor(map.get(saved.occasionId), () => null);
  assert.deepEqual([label.method, label.athleteCount, label.positionName], ["position_average", 3, "Forward"]);
  // A later change of Dan's position does not change the saved estimate.
  await setPosition(team, DAN, "Goalkeeper");
  const row = (await admin.query(`select basis from training_load.metric_value_estimates where occasion_id = $1`, [saved.occasionId])).rows[0];
  assert.deepEqual(row.basis, { athletes: 3, positionId: forward });
});

test("4. the database: the method CHECK takes position_average; its basis is exactly athletes >= 3 and a positionId uuid; the other branches are unchanged", async () => {
  const ok = async (method, basis) => (await admin.query(`select training_load.estimate_basis_ok($1, $2::jsonb) as ok`, [method, JSON.stringify(basis)])).rows[0].ok;
  const id = crypto.randomUUID();
  assert.equal(await ok("position_average", { athletes: 3, positionId: id }), true);
  assert.equal(await ok("position_average", { athletes: 2, positionId: id }), false);
  assert.equal(await ok("position_average", { athletes: 3 }), false);
  assert.equal(await ok("position_average", { athletes: 3, positionId: "x" }), false);
  assert.equal(await ok("position_average", { athletes: 3, positionId: id, extra: 1 }), false);
  assert.equal(await ok("position_average", { athletes: "3", positionId: id }), false);
  assert.equal(await ok("team_average", { athletes: 3 }), true);
  assert.equal(await ok("team_average", { athletes: 3, positionId: id }), false);
  assert.equal(await ok("other", { athletes: 3 }), false);
  const def = (await admin.query(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'metric_value_estimates_method_check'`)).rows[0].d;
  assert.match(def, /position_average/);
  const guard = (await admin.query(`select prosrc from pg_proc where proname = 'validate_metric_value_estimate'`)).rows[0].prosrc;
  assert.match(guard, /new\.method in \('copy_athlete', 'team_average', 'position_average'\)/);
});

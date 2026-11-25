// Calculated variables, step 2b (J21, C141-C148), through the real routes: a check and the batch approval write HMLD beside its
// inputs; the in-app undo removes the calculated values with the rest of the session in its own transaction (C148), and the
// fresh candidate it leaves imports them again; the estimates neither propose nor write a calculated variable.
// HMLD = power zone distance 25-60 + 60-75 + 75+. Disposable optimove_tests_gpexe_* databases only; a fake GPEXE source.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding, ensureMappedSystem } from "./support/mapped-world.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const ORIGINAL_FLAG = process.env.ESTIMATES_ENABLED;
const D1 = "2026-09-14";
const ZONES = ["gpexe_power_zone_25_60_distance", "gpexe_power_zone_60_75_distance", "gpexe_power_zone_75_plus_distance"];
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
let world;
let hmld;

before(async () => {
  // Every migration but the error-tracking one (an injected failure would be recorded as a row).
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "calc2b_routes", roleRead: true, migrations: GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")) });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  process.env.ESTIMATES_ENABLED = "true";
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
  const pa = await platformAdmin();
  world = await ensureMappedSystem(admin, { platformAdminId: pa.id });
  const variables = await import("../src/canonicalVariableAdminService.js");
  hmld = (await variables.createVariable({
    ctx: { userId: String(pa.id), basis: "platform_admin", owner: { scope: "system", clubId: null } },
    body: { requestKey: crypto.randomUUID(), label: "High metabolic load distance", unit: "m", levels: ["session", "drill"],
      calculation: { kind: "sum", inputs: ZONES.map((z) => world[z].variableId) } },
  })).variable;
});

after(async () => {
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
  if (ORIGINAL_SWITCH === undefined) delete process.env.GPEXE_IMPORT_APPLY_ENABLED; else process.env.GPEXE_IMPORT_APPLY_ENABLED = ORIGINAL_SWITCH;
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
const key = () => crypto.randomUUID();

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
async function platformAdmin() {
  const id = await makeUser("platform admin");
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}
async function coachOf(teamId) {
  const id = await makeUser("coach");
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}

let nextGpexeTeamId = 7700;
async function setupTeam() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A101", "B102", "C103", "Dan"] });
  await admin.query(`delete from public.athlete_memberships where team_id = $1`, [org.teamId]);
  for (const athleteId of org.athleteIds) {
    await admin.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athleteId, org.clubId, org.teamId]);
  }
  const coach = await coachOf(org.teamId);
  const padmin = await platformAdmin();
  const sourceTeamId = String(nextGpexeTeamId++);
  assert.equal((await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } })).status, 200);
  src.show(sourceTeamId);
  const { bindingId } = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId });
  await enableTeamImportSwitch(admin, org.teamId);
  await activateBinding(admin, bindingId);
  const [a, b, c] = org.athleteIds;
  for (const [gpexeAthleteId, athleteId] of [["101", a], ["102", b], ["103", c]]) {
    assert.equal((await api(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId, athleteId } })).status, 201);
  }
  return { ...org, coach, padmin, sourceTeamId, bindingId };
}

function bundleOf(team, sessionId) {
  const athletes = standardAthletes().filter((x) => [101, 102].includes(x.id)).map((x, i) => {
    const a = structuredClone(x);
    a.tracks = [sessionId * 10 + i];
    for (const part of a.parts) delete part.track;
    return a;
  });
  return makeBundle({ sessionId, gpexeTeamId: Number(team.sourceTeamId), start: "2026-09-14T08:08:12", updatedOn: "2026-09-14T20:18:09.337", detailsDrills: [0, 1], athletes });
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
const pending = async (team, sessionId) => (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates
  .find((c) => c.gpexeTeamSessionId === String(sessionId) && c.status === "pending");
async function approve(team, cand) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    const r = await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.results[0].outcome, "imported", r.text);
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
  const approval = (await admin.query(`select metric_event_id, activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0];
  return { candidateId: cand.id, eventId: String(approval.metric_event_id), activityId: String(approval.activity_id) };
}
async function importSession(team, sessionId) {
  await checkNow(team, [bundleOf(team, sessionId)]);
  const cand = await pending(team, sessionId);
  assert.ok(cand, "a pending candidate");
  return approve(team, cand);
}

// The team's values: inputs (not derived) and calculated (derived) per occasion.
async function teamValues(teamId) {
  return (await admin.query(
    `select o.id as occasion, v.metric_definition_id::text as def, v.value_numeric::float8 as value, v.is_derived, v.aggregation_role as role
       from training_load.metric_values v
       join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events e on e.id = p.event_id
      where e.owner_team_id = $1`,
    [teamId],
  )).rows;
}
function assertSums(rows) {
  const byOccasion = new Map();
  for (const r of rows) {
    if (!byOccasion.has(r.occasion)) byOccasion.set(r.occasion, []);
    byOccasion.get(r.occasion).push(r);
  }
  let calculated = 0;
  for (const values of byOccasion.values()) {
    const inputs = ZONES.map((z) => values.find((v) => !v.is_derived && v.def === String(world[z].variableId)));
    const derived = values.filter((v) => v.is_derived && v.def === String(hmld.id));
    if (inputs.some((v) => !v)) { assert.equal(derived.length, 0); continue; }
    assert.equal(derived.length, 1);
    assert.equal(derived[0].value, inputs.reduce((s, v) => s + v.value, 0));
    assert.equal(derived[0].role, "derived_rollup");
    calculated += 1;
  }
  return calculated;
}

test("1. a check and the batch approval write HMLD beside its inputs on every occasion that has all three; the undo removes the calculated values with the session (C148), and the fresh candidate imports them again", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9801);
  const first = await teamValues(team.teamId);
  const calculated = assertSums(first);
  assert.ok(calculated >= 2, `HMLD on the two athletes' sessions at least (${calculated})`);

  // The preview of the imported candidate named it (the review shows it).
  const detail = await api(`/teams/${team.teamId}/candidates/${s.candidateId}`, { cookie: team.padmin.cookie });
  assert.equal(detail.status, 200, detail.text);
  const entries = (detail.body.candidate?.preview?.athletes ?? []).flatMap((a) => a.results ?? []).flatMap((r) => r.calculated ?? []);
  assert.ok(entries.some((e) => e.metricDefinitionId === String(hmld.id) && Number(e.value) > 0), "the review lists HMLD with its value");

  const undone = await api(`/teams/${team.teamId}/candidates/${s.candidateId}/undo-import`, {
    method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "wrong athlete link", expected: { eventId: s.eventId } },
  });
  assert.equal(undone.status, 200, undone.text);
  assert.deepEqual(await teamValues(team.teamId), [], "no value, calculated or not, is left");
  const log = (await admin.query(`select removed_total::int n from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0];
  assert.ok(log && log.n >= first.length, "the deletion log counts the calculated values too");

  const again = await pending(team, 9801);
  assert.ok(again, "the undo leaves a fresh candidate");
  await approve(team, again);
  assert.equal(assertSums(await teamValues(team.teamId)), calculated, "the re-import writes the same calculated values");
});

test("2. the estimates for an athlete without GPS data neither propose nor write a calculated variable: its inputs are proposed and saved, HMLD is not", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9811);
  const dan = team.athleteIds[3];
  const source = team.athleteIds[0];
  const r = await tapi(`/${s.activityId}/estimates/proposal?athleteId=${dan}&sourceAthleteId=${source}`, { cookie: team.coach.cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.variables.some((v) => String(v.metricDefinitionId ?? v.id) === String(hmld.id)), false, "HMLD is not a variable of the proposal");
  const proposed = new Set(r.body.methods.copy_athlete.values.map((x) => String(x.metricDefinitionId)));
  for (const z of ZONES) assert.ok(proposed.has(String(world[z].variableId)), `${z} is proposed`);
  assert.equal(proposed.has(String(hmld.id)), false, "HMLD is not proposed");
  for (const method of Object.values(r.body.methods)) {
    for (const v of method.values ?? []) assert.notEqual(String(v.metricDefinitionId), String(hmld.id));
  }

  const saved = await tapi(`/${s.activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), athleteId: dan, method: "copy_athlete", sourceAthleteId: source } });
  assert.equal(saved.status, 201, saved.text);
  const estimated = (await admin.query(
    `select v.metric_definition_id::text as def, v.is_derived from training_load.metric_value_estimates e join training_load.metric_values v on v.id = e.metric_value_id
      join training_load.metric_measurement_occasions o on o.id = e.occasion_id join training_load.metric_event_participants p on p.id = o.event_participant_id
     where p.athlete_id = $1`,
    [dan],
  )).rows;
  assert.ok(estimated.length > 0);
  assert.equal(estimated.some((x) => x.def === String(hmld.id) || x.is_derived), false, "no estimate of HMLD");
  const danDerived = (await admin.query(
    `select count(*)::int n from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id
      join training_load.metric_event_participants p on p.id = o.event_participant_id where p.athlete_id = $1 and v.is_derived`,
    [dan],
  )).rows[0].n;
  assert.equal(danDerived, 0, "an estimate does not compute HMLD from estimated inputs");
});

test("3. a coach's correction of an imported occasion carries its inputs only: the new occasion gets HMLD again from the corrected inputs in the same transaction; a correction that names HMLD is refused, nothing written", async () => {
  const team = await setupTeam();
  await importSession(team, 9821);
  const identity = (await admin.query(
    `select si.id, si.current_occasion_id from training_load.metric_source_identities si
       join training_load.metric_source_connections c on c.id = si.source_connection_id
      where c.owner_team_id = $1 and si.source_external_id like 'athlete_session:%:full'
        and exists (select 1 from training_load.metric_values v where v.occasion_id = si.current_occasion_id and v.metric_definition_id = $2)
      order by si.source_external_id limit 1`, [team.teamId, hmld.id])).rows[0];
  assert.ok(identity, "an imported session occasion with HMLD");
  const old = (await admin.query(
    `select metric_definition_id::text as def, metric_definition_version_id::text as ver, value_numeric::float8 as value, is_derived
       from training_load.metric_values where occasion_id = $1`, [identity.current_occasion_id])).rows;
  const oldHmld = old.find((v) => v.is_derived).value;
  const first = String(world[ZONES[0]].variableId);
  const inputs = old.filter((v) => !v.is_derived).map((v) => ({ metricDefinitionId: v.def, metricDefinitionVersionId: v.ver, value: v.def === first ? v.value + 100 : v.value }));
  const correct = (values) => call("/api/training-load/metrics", "/occasions/imported-correction", {
    method: "POST", cookie: team.coach.cookie,
    body: { requestKey: key(), sourceIdentityId: identity.id, expectedCurrentOccasionId: identity.current_occasion_id, values },
  });

  const named = await correct([...inputs, { metricDefinitionId: String(hmld.id), metricDefinitionVersionId: String(hmld.currentVersion.id), value: 1 }]);
  assert.equal(named.status, 409, named.text);
  assert.equal(named.body.code ?? named.body.error, "calculated_variable_not_entered", named.text);
  assert.equal((await admin.query(`select current_occasion_id from training_load.metric_source_identities where id = $1`, [identity.id])).rows[0].current_occasion_id, identity.current_occasion_id);

  const ok = await correct(inputs);
  assert.equal(ok.status, 201, ok.text);
  const now = (await admin.query(`select current_occasion_id from training_load.metric_source_identities where id = $1`, [identity.id])).rows[0].current_occasion_id;
  assert.notEqual(now, identity.current_occasion_id);
  const after = (await admin.query(
    `select metric_definition_id::text as def, value_numeric::float8 as value, is_derived, computed_by_ref from training_load.metric_values where occasion_id = $1`, [now])).rows;
  const derived = after.filter((v) => v.is_derived);
  assert.equal(derived.length, 1);
  assert.equal(derived[0].value, oldHmld + 100, "HMLD from the corrected inputs");
  assert.equal(derived[0].computed_by_ref.inputValueIds.length, 3);
  assert.equal(after.filter((v) => !v.is_derived).length, inputs.length, "the inputs as corrected, nothing added");
});

test("4. a dashboard series of HMLD reads its calculated values under every aggregation-role policy, equal to the sum of its inputs' series per athlete and day; an input's series is unchanged (its session values stay out of standalone_only)", async () => {
  const team = await setupTeam();
  await importSession(team, 9831);
  const { runDashboardBatchQuery } = await import("../src/trainingLoadDashboardQuery.js");
  const run = async (metricDefinitionId, aggregationRolePolicy) => {
    const [result] = await runDashboardBatchQuery(
      { dataWorkspaceType: "team", dataWorkspaceScopeId: team.teamId, dateFrom: D1, dateTo: D1 },
      [{ widgetId: "w", seriesId: "s", metricDefinitionId: String(metricDefinitionId), dataScopeLevel: "session", aggregationRolePolicy,
        coveragePolicy: "complete_and_partial", sourcePolicy: "all_with_conflicts", groupBy: "day", analyticalAggregation: "sum" }],
      { queryRunner: (sql, params) => admin.query(sql, params) },
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    return Object.fromEntries(result.data.current.map((r) => [r.athleteId, r.value]));
  };
  const inputs = await Promise.all(ZONES.map((z) => run(world[z].variableId, "standalone_and_source_rollup")));
  const expected = {};
  for (const byAthlete of inputs) for (const [athleteId, value] of Object.entries(byAthlete)) expected[athleteId] = (expected[athleteId] ?? 0) + Number(value);
  assert.equal(Object.keys(expected).length, 2, "both athletes have inputs");
  for (const policy of ["standalone_only", "standalone_and_source_rollup", "all_including_derived"]) {
    const got = await run(hmld.id, policy);
    assert.deepEqual(Object.fromEntries(Object.entries(got).map(([a, v]) => [a, Number(v)])), expected, `HMLD under ${policy}`);
  }
  // An input's session values are source_rollup: standalone_only leaves them out, exactly as before calculated variables.
  assert.deepEqual(await run(world[ZONES[0]].variableId, "standalone_only"), {});
  // Any other derived_rollup value keeps the policy's rule: only all_including_derived reads it.
  const variables = await import("../src/canonicalVariableAdminService.js");
  const plain = (await variables.createVariable({
    ctx: { userId: String(team.padmin.id), basis: "platform_admin", owner: { scope: "system", clubId: null } },
    body: { requestKey: key(), label: `Other derived total ${key().slice(0, 8)}`, unit: "m", levels: ["session"], dailyAggregationMethod: "sum" },
  })).variable;
  const occasion = (await admin.query(
    `select o.id from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events e on e.id = p.event_id
      where e.owner_team_id = $1 and o.segment_id is null and o.superseded_by_occasion_id is null limit 1`, [team.teamId])).rows[0].id;
  await admin.query(
    `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, is_derived, aggregation_role, coverage, computed_by_ref)
     values ($1,$2,$3,7,'m',true,'derived_rollup','complete','{"rollup":"an older derived total"}')`, [occasion, plain.id, plain.currentVersion.id]);
  assert.deepEqual(await run(plain.id, "standalone_only"), {});
  assert.deepEqual(await run(plain.id, "standalone_and_source_rollup"), {});
  assert.equal(Object.values(await run(plain.id, "all_including_derived")).map(Number).join(), "7");
});

// ---- The athlete never sees a calculated value (the Rukovodilac's step-1 decision; the owner's rule that an athlete sees only
// what was really measured). Each read through its real route, against the coach's read of the same data as the control.
async function athleteUserOf(athleteId) {
  const id = await makeUser("athlete self");
  await admin.query(`update public.athletes set user_id = $2 where id = $1`, [athleteId, id]);
  await setWorkspace(id, "athlete", athleteId);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}
const mapi = (path, opts) => call("/api/training-load/metrics", path, opts);
const dapi = (path, opts) => call("/api/training-load/dashboards", path, opts);

test("5. an athlete's own reads carry no calculated value, name or unit - the activity detail, an occasion, the results and her own dashboards - while the coach's reads of the same data do", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9841);
  const athleteId = team.athleteIds[0];
  const athlete = await athleteUserOf(athleteId);
  const first = String(world[ZONES[0]].variableId);
  const H = String(hmld.id);
  const occasion = (await admin.query(
    `select o.id from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
      where p.athlete_id = $1 and v.metric_definition_id = $2 and o.segment_id is null and o.superseded_by_occasion_id is null`, [athleteId, H])).rows[0].id;

  // The activity detail.
  const coachDetail = await tapi(`/${s.activityId}`, { cookie: team.coach.cookie });
  assert.equal(coachDetail.status, 200, coachDetail.text);
  assert.ok(coachDetail.body.facts.some((f) => f.factKind === "metric_value" && f.detail.metricDefinitionId === H), "the coach sees HMLD");
  const mine = await tapi(`/${s.activityId}`, { cookie: athlete.cookie });
  assert.equal(mine.status, 200, mine.text);
  const myDefs = mine.body.facts.filter((f) => f.factKind === "metric_value").map((f) => f.detail.metricDefinitionId);
  assert.ok(myDefs.includes(first), "her measured input is there");
  assert.equal(myDefs.includes(H), false, "no calculated value");
  assert.equal(H in (mine.body.variableNamesById ?? {}), false, "no name or unit of it");
  assert.equal(mine.text.includes(H) || mine.text.includes(hmld.label), false, "no trace of it anywhere in her answer");

  // One occasion.
  const coachOcc = await mapi(`/occasions/${occasion}`, { cookie: team.coach.cookie });
  assert.equal(coachOcc.status, 200, coachOcc.text);
  assert.ok(coachOcc.text.includes(H), "the coach's occasion read holds HMLD");
  const myOcc = await mapi(`/occasions/${occasion}`, { cookie: athlete.cookie });
  assert.equal(myOcc.status, 200, myOcc.text);
  assert.ok(myOcc.text.includes(first));
  assert.equal(myOcc.text.includes(H) || myOcc.text.includes(hmld.label), false, "her occasion read holds no calculated value");

  // The results.
  const myResults = await mapi(`/results?dateFrom=${D1}&dateTo=${D1}`, { cookie: athlete.cookie });
  assert.equal(myResults.status, 200, myResults.text);
  assert.ok(myResults.text.includes(first));
  assert.equal(myResults.text.includes(H) || myResults.text.includes(hmld.label), false, "her results hold no calculated value");
  const coachResults = await mapi(`/results?dateFrom=${D1}&dateTo=${D1}`, { cookie: team.coach.cookie });
  assert.ok(coachResults.text.includes(H), "the coach's results hold HMLD");

  // Her own dashboard, under the widest role policy: the calculated series is empty; the input's is not. The coach's is not.
  const board = async (who, defs) => {
    const made = await dapi("", { method: "POST", cookie: who.cookie, body: { name: `Board ${key().slice(0, 6)}` } });
    assert.equal(made.status, 201, made.text);
    const widget = await dapi(`/${made.body.dashboard.id}/widgets`, { method: "POST", cookie: who.cookie, body: {
      expectedDashboardRevision: made.body.dashboard.revision, widgetType: "table", title: "t", widgetOrder: 0, x: 0, y: 0, width: 6, height: 4, mobileOrder: 0 } });
    assert.equal(widget.status, 201, widget.text);
    const addSeries = (def, revision, order) => dapi(`/${made.body.dashboard.id}/widgets/${widget.body.widgetId}/series`, { method: "POST", cookie: who.cookie, body: {
      expectedWidgetRevision: revision, seriesOrder: order, metricDefinitionId: def, dataScopeLevel: "session", analyticalAggregation: "sum",
      aggregationRolePolicy: "all_including_derived" } });
    let revision = 1;
    const refused = {};
    for (const [i, def] of defs.entries()) {
      const added = await addSeries(def, revision, i);
      if (added.status === 404) { refused[def] = added.text; continue; }
      assert.equal(added.status, 201, added.text);
      revision += 1;
    }
    const read = await dapi(`/${made.body.dashboard.id}/query`, { method: "POST", cookie: who.cookie, body: { dateFrom: D1, dateTo: D1 } });
    assert.equal(read.status, 200, read.text);
    return { series: read.body.widgets[0].series.map((x) => x.data.current), text: read.text, refused, foreign: (await addSeries(crypto.randomUUID(), revision, 9)).text };
  };
  // Her own dashboard cannot take the calculated variable: the same 404 as a variable that does not exist (PR 3); her input
  // series reads her value, and her answer names nothing of it.
  const hers = await board(athlete, [H, first]);
  assert.deepEqual(Object.keys(hers.refused), [H], "the calculated series is refused");
  assert.equal(hers.refused[H], hers.foreign, "exactly like a variable that does not exist");
  assert.equal(hers.series.length, 1);
  assert.ok(hers.series[0].length > 0, "her input series has her value");
  assert.equal(hers.text.includes(H) || hers.text.includes(hmld.label), false);
  const coachs = await board(team.coach, [H, first]);
  assert.deepEqual(coachs.refused, {});
  assert.ok(coachs.series[0].length > 0, "the coach's calculated series reads it");
  // And the query itself, should an athlete dashboard ever hold such a series: the athlete workspace drops the values.
  const { runDashboardBatchQuery } = await import("../src/trainingLoadDashboardQuery.js");
  const [direct] = await runDashboardBatchQuery(
    { dataWorkspaceType: "athlete", athleteWorkspaceAthleteId: athleteId, dateFrom: D1, dateTo: D1 },
    [{ widgetId: "w", seriesId: "s", metricDefinitionId: H, dataScopeLevel: "session", aggregationRolePolicy: "all_including_derived",
      coveragePolicy: "complete_and_partial", sourcePolicy: "all_with_conflicts", groupBy: "day", analyticalAggregation: "sum" }],
    { queryRunner: (sql, params) => admin.query(sql, params) },
  );
  assert.equal(direct.status, "ok", JSON.stringify(direct));
  assert.deepEqual(direct.data.current, [], "an athlete workspace's query holds no calculated value");
});

test("6. an input value in another unit is never added (the Independent's LOW-1): no calculated value is written, and the review names the input as missing", async () => {
  const team = await setupTeam();
  const first = String(world[ZONES[0]].variableId);
  // The importer writes each value in its variable's unit, so the case is made by hand: one input value's unit_at_capture is
  // changed in place, with the guards off (an input re-pointed to an older version of another unit would read this way).
  await checkNow(team, [bundleOf(team, 9851)]);
  const cand = await pending(team, 9851);
  const imported = await approve(team, cand);
  const occasion = (await admin.query(
    `select o.id from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
      where p.event_id = $1 and v.metric_definition_id = $2 and o.segment_id is null limit 1`, [imported.eventId, String(hmld.id)])).rows[0].id;
  const { writeCalculatedValues, calculatedForOccasions } = await import("../src/calculatedValues.js");
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(`delete from training_load.metric_values where occasion_id = $1 and is_derived`, [occasion]);
    await client.query(`update training_load.metric_values set unit_at_capture = 'km' where occasion_id = $1 and metric_definition_id = $2`, [occasion, first]);
    await client.query("set local session_replication_role = origin");
    const written = await writeCalculatedValues(client, { occasionId: occasion, level: "full", ownerTeamId: team.teamId });
    assert.deepEqual(written, [], "an input in km is not added to metres");
    const entries = (await calculatedForOccasions(client, { occasions: [{ occasionId: occasion, level: "full" }], ownerTeamId: team.teamId })).get(String(occasion));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].value, null);
    assert.deepEqual(entries[0].missingInputs.map((m) => m.metricDefinitionId), [first], "the review names the input in the other unit");
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
});

test("7. an athlete's catalog never lists a calculated variable (no label, no picker entry), and reading it answers like a missing one; the coach's catalog lists it", async () => {
  const team = await setupTeam();
  const athlete = await athleteUserOf(team.athleteIds[1]);
  const H = String(hmld.id);
  const listed = async (who) => {
    const all = [];
    let qs = "limit=100";
    for (let page = 0; page < 20; page += 1) {
      const r = await mapi(`/definitions?${qs}`, { cookie: who.cookie });
      assert.equal(r.status, 200, r.text);
      all.push(...r.body.rows);
      if (!r.body.nextCursor) break;
      qs = `limit=100&cursorLabel=${encodeURIComponent(r.body.nextCursor.label)}&cursorId=${r.body.nextCursor.id}`;
    }
    return all;
  };
  const coachRows = await listed(team.coach);
  assert.ok(coachRows.some((r) => String(r.id) === H), "the coach's catalog lists HMLD");
  // ... and says it is calculated (a dashboard says from when it has values); an ordinary variable is not.
  assert.equal(coachRows.find((r) => String(r.id) === H).calculated, true);
  assert.equal(coachRows.find((r) => String(r.id) === String(world[ZONES[0]].variableId)).calculated, false);
  const herRows = await listed(athlete);
  assert.ok(herRows.some((r) => String(r.id) === String(world[ZONES[0]].variableId)), "her catalog lists the system inputs");
  assert.equal(herRows.some((r) => String(r.id) === H || r.label === hmld.label), false, "no calculated variable in her catalog");
  const series = await mapi(`/definitions?limit=100&purpose=dashboardSeries&search=${encodeURIComponent("High metabolic")}`, { cookie: athlete.cookie });
  assert.equal(series.status, 200);
  assert.deepEqual(series.body.rows, [], "nor in her dashboard picker");
  const missing = crypto.randomUUID();
  for (const suffix of ["", "/versions"]) {
    const one = await mapi(`/definitions/${H}${suffix}`, { cookie: athlete.cookie });
    const none = await mapi(`/definitions/${missing}${suffix}`, { cookie: athlete.cookie });
    assert.equal(one.status, 404, one.text);
    assert.equal(one.text, none.text, `reading it${suffix} answers exactly like a missing one`);
    assert.equal((await mapi(`/definitions/${H}${suffix}`, { cookie: team.coach.cookie })).status, 200, "the coach reads it");
  }
});

test("8. Source fields' plain row: each field says which teams it is in use for, within the caller's audience - a platform admin every team, a club's admin its own club's teams only, another club's admin none", async () => {
  const team = await setupTeam();
  const teamName = (await admin.query(`select name from public.teams where id = $1`, [team.teamId])).rows[0].name;
  const clubAdmin = async (clubId) => {
    const id = await makeUser("club admin");
    await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
    await setWorkspace(id, "club", clubId);
    return { id, cookie: `optimove_session=${await createSession(id)}` };
  };
  const own = await clubAdmin(team.clubId);
  const otherClub = (await admin.query(`insert into public.clubs (name) values ($1) returning id`, [`Other club ${key().slice(0, 6)}`])).rows[0].id;
  const other = await clubAdmin(otherClub);
  const fieldsOf = async (who) => {
    const r = await call("/api/training-load/sources/metrics", "/fields", { cookie: who.cookie });
    assert.equal(r.status, 200, r.text);
    return r.body.fields;
  };
  const zoneField = String((await admin.query(`select source_metric_definition_id as id from training_load.source_metric_mapping_activations where team_id = $1 and ended_at is null limit 1`, [team.teamId])).rows[0].id);
  const used = (fields) => fields.find((f) => String(f.id) === zoneField).inUse;
  const platformView = used(await fieldsOf(team.padmin));
  assert.ok(platformView.count >= 1 && platformView.teams.includes(teamName), JSON.stringify(platformView));
  const ownView = used(await fieldsOf(own));
  assert.ok(ownView.teams.includes(teamName), "the team's own club admin sees it");
  assert.ok(ownView.count <= platformView.count);
  const otherView = await fieldsOf(other);
  assert.deepEqual(used(otherView), { teams: [], count: 0 }, "another club's admin learns nothing of this team");
  assert.equal(JSON.stringify(otherView).includes(teamName), false);
});

test("9. nothing else tells an athlete a calculated variable exists (the security review of PR 3): hiding or unhiding it answers like a missing one and writes nothing, a structure link to it is left out of her links, and a template cloned into her workspace leaves its series unresolved instead of binding it (the clone's batch resolution)", async () => {
  const team = await setupTeam();
  const athlete = await athleteUserOf(team.athleteIds[2]);
  const H = String(hmld.id);
  const missing = crypto.randomUUID();
  for (const method of ["POST", "DELETE"]) {
    const one = await mapi(`/definitions/${H}/hide`, { method, cookie: athlete.cookie });
    const none = await mapi(`/definitions/${missing}/hide`, { method, cookie: athlete.cookie });
    assert.equal(one.status, 404, one.text);
    assert.equal(one.text, none.text, `${method} hide answers exactly like a missing one`);
  }
  assert.equal((await admin.query(`select count(*)::int as n from training_load.metric_definition_hidden where user_id = $1`, [athlete.id])).rows[0].n, 0, "no hidden row");
  // The coach may still hide it (and show it again).
  assert.equal((await mapi(`/definitions/${H}/hide`, { method: "POST", cookie: team.coach.cookie })).status, 200);
  assert.equal((await mapi(`/definitions/${H}/hide`, { method: "DELETE", cookie: team.coach.cookie })).status, 200);

  // A system category holding HMLD and one of its inputs.
  const pa = await platformAdmin();
  const sapi = (path, opts) => call("/api/training-load/sources/metrics", path, opts);
  const cat = await sapi("/classification/categories", { method: "POST", cookie: pa.cookie, body: { requestKey: key(), name: `Load ${key().slice(0, 6)}` } });
  assert.equal(cat.status, 201, cat.text);
  const categoryId = cat.body.category?.id ?? cat.body.node?.id ?? cat.body.id;
  assert.ok(categoryId, cat.text);
  for (const variableId of [H, String(world[ZONES[0]].variableId)]) {
    const made = await sapi("/classification/links", { method: "POST", cookie: pa.cookie, body: { requestKey: key(), variableId, categoryId } });
    assert.equal(made.status, 201, made.text);
  }
  const links = async (who) => (await mapi(`/structure-links?categoryId=${categoryId}`, { cookie: who.cookie })).body.rows.map((r) => String(r.metric_definition_id));
  assert.deepEqual((await links(athlete)).sort(), [String(world[ZONES[0]].variableId)], "her links leave the calculated variable out");
  assert.deepEqual((await links(team.coach)).sort(), [H, String(world[ZONES[0]].variableId)].sort(), "the coach's hold both");

  // A template cloned into her workspace: the clone resolves each portable series by its key hints in one batch
  // (cloneDashboard); HMLD's hint stays unresolved in her workspace, the input's resolves; a team's resolves both. (The
  // clone route itself needs v71, outside this suite's migrations; the batch is the part PR 3 changed.)
  const { resolveTemplateSeriesBatchForWorkspace } = await import("../src/trainingLoadDashboardWidgets.js");
  const keys = Object.fromEntries((await admin.query(`select id::text, key from training_load.metric_definitions where id = any($1::uuid[])`,
    [[H, String(world[ZONES[0]].variableId)]])).rows.map((r) => [r.id, r.key]));
  const specs = [{ sourceSeriesId: "calc", hints: [{ key: keys[H] }] }, { sourceSeriesId: "input", hints: [{ key: keys[String(world[ZONES[0]].variableId)] }] }];
  const runner = (sql, params) => admin.query(sql, params);
  const hers = await resolveTemplateSeriesBatchForWorkspace(runner, specs, { dataWorkspaceType: "athlete", dataWorkspaceScopeId: team.athleteIds[2], ownerUserId: athlete.id });
  assert.equal(hers.get("calc").status, "unresolved", "her clone never binds HMLD");
  assert.deepEqual(hers.get("input"), { status: "resolved", candidateIds: [String(world[ZONES[0]].variableId)] });
  const coachs = await resolveTemplateSeriesBatchForWorkspace(runner, specs, { dataWorkspaceType: "team", dataWorkspaceScopeId: team.teamId, ownerUserId: team.coach.id });
  assert.deepEqual(coachs.get("calc"), { status: "resolved", candidateIds: [H] }, "a team's clone binds it");
});

// v79: a ratio and a difference, made through the admin API over the mapped world's measured variables and HMLD.
let v79Vars = null;
async function v79Variables() {
  if (v79Vars) return v79Vars;
  const variables = await import("../src/canonicalVariableAdminService.js");
  const pa = await platformAdmin();
  const ctx = { userId: String(pa.id), basis: "platform_admin", owner: { scope: "system", clubId: null } };
  const create = async (label, unit, calculation) => (await variables.createVariable({ ctx,
    body: { requestKey: key(), label, unit, levels: ["session", "drill"], calculation } })).variable;
  const id = (name) => String(world[name].variableId);
  v79Vars = {
    perMin: await create("Metres per minute", "m/min", { kind: "ratio", inputs: [id("gpexe_total_distance"), id("gpexe_time_min")], scale: 1 }),
    share: await create("HMLD share of distance", "%", { kind: "ratio", inputs: [String(hmld.id), id("gpexe_total_distance")], scale: 100 }),
    rest: await create("Distance below HMLD", "m", { kind: "difference", inputs: [id("gpexe_total_distance"), String(hmld.id)] }),
  };
  return v79Vars;
}

test("10. v79: an athlete never sees a ratio or a difference - her catalog, one of them, its versions, hide, her activity detail and results, her own board - each answering like a missing id; the coach's reads hold them", async () => {
  const { perMin, share, rest } = await v79Variables();
  const team = await setupTeam();
  const s = await importSession(team, 9851);
  const athlete = await athleteUserOf(team.athleteIds[0]);
  const ids = [perMin, share, rest].map((v) => String(v.id));
  const labels = [perMin, share, rest].map((v) => v.label);
  // The coach's activity detail holds the new values (they were written at import).
  const coachDetail = await tapi(`/${s.activityId}`, { cookie: team.coach.cookie });
  assert.equal(coachDetail.status, 200, coachDetail.text);
  for (const id of ids) assert.ok(coachDetail.body.facts.some((f) => f.factKind === "metric_value" && f.detail.metricDefinitionId === id), `the coach sees ${id}`);
  // Hers holds none, nor a name or a unit.
  const mine = await tapi(`/${s.activityId}`, { cookie: athlete.cookie });
  assert.equal(mine.status, 200, mine.text);
  for (const [i, id] of ids.entries()) assert.equal(mine.text.includes(id) || mine.text.includes(labels[i]), false, `no trace of ${labels[i]} in her activity`);
  const myResults = await mapi(`/results?dateFrom=${D1}&dateTo=${D1}`, { cookie: athlete.cookie });
  assert.equal(myResults.status, 200, myResults.text);
  for (const [i, id] of ids.entries()) assert.equal(myResults.text.includes(id) || myResults.text.includes(labels[i]), false, `no trace of ${labels[i]} in her results`);
  // Her catalog: listed nowhere; a read, its versions and hide answer like a missing id.
  const list = await mapi("/definitions?limit=100", { cookie: athlete.cookie });
  assert.equal(list.status, 200);
  for (const id of ids) assert.equal(list.body.rows.some((r) => String(r.id) === id), false);
  const missing = crypto.randomUUID();
  for (const id of ids) {
    for (const [suffix, method] of [["", "GET"], ["/versions", "GET"], ["/hide", "POST"]]) {
      const one = await mapi(`/definitions/${id}${suffix}`, { method, cookie: athlete.cookie });
      const none = await mapi(`/definitions/${missing}${suffix}`, { method, cookie: athlete.cookie });
      assert.equal(one.status, 404, one.text);
      assert.equal(one.text, none.text, `${suffix || "read"} answers like a missing id`);
    }
  }
  // Her own board refuses each like a missing variable (the athlete's 404 comes before the ratio's 409: nothing tells her).
  const made = await dapi("", { method: "POST", cookie: athlete.cookie, body: { name: `Mine ${key().slice(0, 6)}` } });
  assert.equal(made.status, 201, made.text);
  const widget = await dapi(`/${made.body.dashboard.id}/widgets`, { method: "POST", cookie: athlete.cookie, body: {
    expectedDashboardRevision: made.body.dashboard.revision, widgetType: "table", title: "t", widgetOrder: 0, x: 0, y: 0, width: 6, height: 4, mobileOrder: 0 } });
  const series = (def) => dapi(`/${made.body.dashboard.id}/widgets/${widget.body.widgetId}/series`, { method: "POST", cookie: athlete.cookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 0, metricDefinitionId: def, dataScopeLevel: "session", analyticalAggregation: "max" } });
  const foreign = (await series(crypto.randomUUID())).text;
  for (const id of ids) {
    const r = await series(id);
    assert.equal(r.status, 404, r.text);
    assert.equal(r.text, foreign, "exactly like a variable that does not exist");
  }
});

test("11. v79: a coach's dashboard refuses invalid ratio aggregations and takes a difference; the database refuses totalling or averaging a ratio and 'ratio' on anything else; the query never adds or averages a ratio", async () => {
  const { perMin, rest } = await v79Variables();
  const team = await setupTeam();
  await importSession(team, 9852);
  const made = await dapi("", { method: "POST", cookie: team.coach.cookie, body: { name: `Board ${key().slice(0, 6)}` } });
  assert.equal(made.status, 201, made.text);
  const widget = await dapi(`/${made.body.dashboard.id}/widgets`, { method: "POST", cookie: team.coach.cookie, body: {
    expectedDashboardRevision: made.body.dashboard.revision, widgetType: "table", title: "t", widgetOrder: 0, x: 0, y: 0, width: 6, height: 4, mobileOrder: 0 } });
  assert.equal(widget.status, 201, widget.text);
  const series = (def, revision, agg = "sum") => dapi(`/${made.body.dashboard.id}/widgets/${widget.body.widgetId}/series`, { method: "POST", cookie: team.coach.cookie,
    body: { expectedWidgetRevision: revision, seriesOrder: 0, metricDefinitionId: def, dataScopeLevel: "session", analyticalAggregation: agg, aggregationRolePolicy: "all_including_derived" } });
  for (const agg of ["sum", "avg"]) {
    const refused = await series(String(perMin.id), 1, agg);
    assert.equal(refused.status, 409, refused.text);
    assert.deepEqual(refused.body, { error: "aggregation_not_allowed", message: "This metric cannot be totalled or averaged. Choose Ratio, Highest or Latest." });
  }
  const difference = await series(String(rest.id), 1);
  assert.equal(difference.status, 201, difference.text);
  // The database's backstop, under any writer: re-pointing that series at the ratio is refused while it totals or averages.
  const seriesId = (await admin.query(`select s.id from training_load.dashboard_widget_series s where s.widget_id = $1`, [widget.body.widgetId])).rows[0].id;
  const tryUpdate = async (sql, params) => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query("begin");
      await c.query(sql, params);
      return null;
    } catch (error) {
      return error;
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
  };
  for (const agg of ["sum", "avg"]) {
    const err = await tryUpdate(`update training_load.dashboard_widget_series set metric_definition_id = $2, analytical_aggregation = $3 where id = $1`, [seriesId, perMin.id, agg]);
    assert.match(err?.message ?? "", /a ratio is not totalled or averaged/);
  }
  assert.equal(await tryUpdate(`update training_load.dashboard_widget_series set metric_definition_id = $2, analytical_aggregation = 'max' where id = $1`, [seriesId, perMin.id]), null, "max of a ratio is allowed");
  const notRatio = await tryUpdate(`update training_load.dashboard_widget_series set analytical_aggregation = 'ratio' where id = $1`, [seriesId]);
  assert.match(notRatio?.message ?? "", /the aggregation ratio is only for a calculated ratio/);
  // The query pools stored inputs for ratio and refuses sum/avg.
  const { runDashboardBatchQuery } = await import("../src/trainingLoadDashboardQuery.js");
  for (const agg of ["sum", "avg", "ratio"]) {
    const [r] = await runDashboardBatchQuery(
      { dataWorkspaceType: "team", dataWorkspaceScopeId: team.teamId, dateFrom: D1, dateTo: D1 },
      [{ widgetId: "w", seriesId: "s", metricDefinitionId: String(perMin.id), dataScopeLevel: "component", aggregationRolePolicy: "all_including_derived",
        coveragePolicy: "complete_and_partial", sourcePolicy: "all_with_conflicts", groupBy: "cohort", analyticalAggregation: agg }],
      { queryRunner: (sql, params) => admin.query(sql, params) },
    );
    if (agg === "ratio") assert.equal(r.status, "ok", JSON.stringify(r));
    else assert.deepEqual(r, { widgetId: "w", seriesId: "s", status: "error", error: "aggregation_not_allowed" });
  }
  // Highest stays a stored ratio of one session (never a sum of them).
  const [highest] = await runDashboardBatchQuery(
    { dataWorkspaceType: "team", dataWorkspaceScopeId: team.teamId, dateFrom: D1, dateTo: D1 },
    [{ widgetId: "w", seriesId: "s", metricDefinitionId: String(perMin.id), dataScopeLevel: "session", aggregationRolePolicy: "all_including_derived",
      coveragePolicy: "complete_and_partial", sourcePolicy: "all_with_conflicts", groupBy: "athlete", analyticalAggregation: "max" }],
    { queryRunner: (sql, params) => admin.query(sql, params) },
  );
  assert.equal(highest.status, "ok", JSON.stringify(highest));
  const stored = (await admin.query(`select value_numeric::float8 as v from training_load.metric_values where metric_definition_id = $1`, [perMin.id])).rows.map((x) => x.v);
  for (const row of highest.data.current.filter((x) => x.value !== null && !x.error)) assert.ok(stored.includes(Number(row.value)), `${row.value} is a stored ratio`);
  // The Simple builder lists and loads ratios as well as differences.
  const { createSimpleCapabilityReader } = await import("../src/dashboardSimple/capabilities.js");
  const reader = createSimpleCapabilityReader({ query: (sql, params) => admin.query(sql, params), canManageDashboardRow: () => true, dataWorkspaceMatches: () => true });
  const req = { user: { id: team.coach.id } };
  const listed = async (search) => (await reader.listMetrics({ req, dataWorkspace: null, dashboardId: made.body.dashboard.id, search })).metrics.map((m) => String(m.id));
  assert.deepEqual(await listed(perMin.label), [String(perMin.id)], "ratio is available in the simple builder");
  assert.deepEqual(await listed(rest.label), [String(rest.id)], "the difference is there");
  assert.equal((await reader.load({ req, dataWorkspace: null, dashboardId: made.body.dashboard.id, metricRef: { kind: "metric", metricDefinitionId: String(perMin.id) } })).metric.calculation.kind, "ratio");
  // A bare ratio hint without an explicit compatible aggregation/policy stays unresolved.
  const { resolveTemplateSeriesBatchForWorkspace } = await import("../src/trainingLoadDashboardWidgets.js");
  const keyOf = async (d) => (await admin.query(`select key from training_load.metric_definitions where id = $1`, [d])).rows[0].key;
  const resolved = await resolveTemplateSeriesBatchForWorkspace((sql, params) => admin.query(sql, params),
    [{ sourceSeriesId: "ratio", hints: [{ key: await keyOf(perMin.id) }] }, { sourceSeriesId: "difference", hints: [{ key: await keyOf(rest.id) }] }],
    { dataWorkspaceType: "team", dataWorkspaceScopeId: team.teamId, ownerUserId: team.coach.id });
  assert.equal(resolved.get("ratio").status, "unresolved");
  assert.deepEqual(resolved.get("difference"), { status: "resolved", candidateIds: [String(rest.id)] });
});

test("12. v79: a staff definition answer says how a variable is calculated - kind, scale for a ratio, its inputs in the formula's order by name and unit - and how a dashboard may combine it; a measured one says calculation null; an input the viewer may not read keeps its place with nothing named", async () => {
  const { perMin, share, rest } = await v79Variables();
  const team = await setupTeam();
  const named = async (id) => {
    const r = (await admin.query(
      `select d.id::text as id, d.label, d.short_label, dv.unit from training_load.metric_definitions d
         join training_load.metric_definition_versions dv on dv.id = d.current_version_id where d.id = $1`, [id])).rows[0];
    return { definitionId: r.id, name: r.label, shortName: r.short_label ?? null, unit: r.unit ?? null };
  };
  const id = (name) => String(world[name].variableId);
  const expected = {
    [String(perMin.id)]: { calculation: { kind: "ratio", scale: 1, inputs: [await named(id("gpexe_total_distance")), await named(id("gpexe_time_min"))] },
      allowedAggregations: ["ratio", "max", "last", "none"] },
    [String(share.id)]: { calculation: { kind: "ratio", scale: 100, inputs: [await named(String(hmld.id)), await named(id("gpexe_total_distance"))] },
      allowedAggregations: ["ratio", "max", "last", "none"] },
    [String(rest.id)]: { calculation: { kind: "difference", inputs: [await named(id("gpexe_total_distance")), await named(String(hmld.id))] },
      allowedAggregations: ["sum", "avg", "max", "last", "none"] },
    [String(hmld.id)]: { calculation: { kind: "sum", inputs: await Promise.all(ZONES.map((z) => named(id(z)))) },
      allowedAggregations: ["sum", "avg", "max", "last", "none"] },
    [id("gpexe_total_distance")]: { calculation: null, allowedAggregations: ["sum", "avg", "max", "last", "none"] },
  };
  // The coach's list (with and without the dashboard picker's purpose) and GET one: the same fields, the existing names kept.
  for (const purpose of ["", "&purpose=dashboardSeries"]) {
    const seen = new Map();
    let cursor = "";
    for (let page = 0; page < 20; page += 1) {
      const list = await mapi(`/definitions?limit=100${purpose}${cursor}`, { cookie: team.coach.cookie });
      assert.equal(list.status, 200, list.text);
      for (const row of list.body.rows) seen.set(String(row.id), row);
      if (!list.body.nextCursor) break;
      cursor = `&cursorLabel=${encodeURIComponent(list.body.nextCursor.label)}&cursorId=${list.body.nextCursor.id}`;
    }
    for (const [defId, want] of Object.entries(expected)) {
      const row = seen.get(defId);
      assert.ok(row, `${defId} listed${purpose}`);
      assert.deepEqual({ calculation: row.calculation, allowedAggregations: row.allowedAggregations }, want, `list${purpose} ${defId}`);
      assert.ok(row.current_version_id && row.daily_aggregation_method, "current_version_id and daily_aggregation_method as before");
    }
    assert.equal(seen.get(String(perMin.id)).daily_aggregation_method, "ratio");
    assert.equal(seen.get(String(rest.id)).daily_aggregation_method, "sum");
  }
  for (const [defId, want] of Object.entries(expected)) {
    const one = await mapi(`/definitions/${defId}`, { cookie: team.coach.cookie });
    assert.equal(one.status, 200, one.text);
    assert.deepEqual({ calculation: one.body.row.calculation, allowedAggregations: one.body.row.allowedAggregations }, want, `GET ${defId}`);
  }
  // An input the viewer may not read (here: another club's variable, and a viewer with no role) keeps its place, unnamed.
  const otherClub = (await admin.query(`insert into public.clubs (name) values ($1) returning id`, [`Other ${key().slice(0, 6)}`])).rows[0].id;
  const { withCalculationsForTest } = await import("../src/trainingLoadMetricsCatalog.js");
  const withCalculationsForTestLater = (viewer, inputId) => withCalculationsForTest(viewer, [{ id: "x", value_type: "numeric",
    calculation: { kind: "ratio", scale: 100, inputs: [String(inputId), String(hmld.id)] } }]);
  // A real variable with a current version (the database's guards off on this disposable database only), so only the
  // visibility rule can leave it unnamed.
  const raw = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await raw.connect();
  let hidden;
  try {
    await raw.query("begin");
    await raw.query("set local session_replication_role = replica");
    hidden = (await raw.query(
      `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id) values ($1, 'Their secret', 'club', $2) returning id`,
      [`secret_${key().slice(0, 8)}`, otherClub])).rows[0].id;
    const version = (await raw.query(
      `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method)
       values ($1, 1, 'm', 'numeric', 'sum') returning id`, [hidden])).rows[0].id;
    await raw.query(`update training_load.metric_definitions set current_version_id = $2 where id = $1`, [hidden, version]);
    await raw.query("commit");
  } finally {
    await raw.end();
  }
  // A platform administrator reads it, named: the row is real.
  const padmin = { user: { id: crypto.randomUUID() }, authz: { platformRoles: ["platform_admin"], clubRoles: [], teamRoles: [], managedTeamIds: [] } };
  const [seenByAdmin] = await withCalculationsForTestLater(padmin, hidden);
  assert.equal(seenByAdmin.calculation.inputs[0].name, "Their secret");
  const nobody = { user: { id: crypto.randomUUID() }, authz: { platformRoles: [], clubRoles: [], teamRoles: [], managedTeamIds: [] } };
  const [shaped] = await withCalculationsForTest(nobody, [{ id: "x", value_type: "numeric",
    calculation: { kind: "ratio", scale: 100, inputs: [String(hidden), String(hmld.id)] } }]);
  assert.deepEqual(shaped.calculation, { kind: "ratio", scale: 100, inputs: [
    { definitionId: null, name: null, shortName: null, unit: null }, await named(String(hmld.id))] });
  assert.equal(JSON.stringify(shaped).includes(String(hidden)) || JSON.stringify(shaped).includes("Their secret"), false);
});

test("13. v79: the preview names why a calculation with every input wrote nothing - a denominator of 0, a difference below 0 - and nothing for a value written", async () => {
  const { calculatedForOccasions } = await import("../src/calculatedValues.js");
  const { perMin, rest } = await v79Variables();
  const team = await setupTeam();
  await importSession(team, 9853);
  const occ = (await admin.query(
    `select o.id::text as id from training_load.metric_events e
       join training_load.metric_event_participants p on p.event_id = e.id
       join training_load.metric_measurement_occasions o on o.event_participant_id = p.id
       join training_load.metric_values v on v.occasion_id = o.id and v.metric_definition_id = $2
      where e.owner_team_id = $1 and o.segment_id is null limit 1`, [team.teamId, perMin.id])).rows[0].id;
  const valueOf = async (defId) => (await admin.query(
    `select value_numeric from training_load.metric_values where occasion_id = $1 and metric_definition_id = $2`, [occ, defId])).rows[0]?.value_numeric;
  const reasons = async (client) => {
    const entries = (await calculatedForOccasions(client, { occasions: [{ occasionId: occ, level: "full" }], ownerTeamId: team.teamId })).get(occ) ?? [];
    return Object.fromEntries(entries.filter((e) => [String(perMin.id), String(rest.id)].includes(e.metricDefinitionId)).map((e) => [e.metricDefinitionId, e.reason]));
  };
  assert.ok(await valueOf(perMin.id) !== undefined && await valueOf(rest.id) !== undefined, "both written at import");
  assert.deepEqual(await reasons(admin), { [String(perMin.id)]: null, [String(rest.id)]: null });
  // Inside a rolled-back transaction: the inputs changed and the calculated values removed, as an import that wrote none.
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query(`delete from training_load.metric_values where occasion_id = $1 and metric_definition_id = any($2::uuid[])`, [occ, [perMin.id, rest.id]]);
    const id = (name) => String(world[name].variableId);
    const setValue = (defId, v) => c.query(`update training_load.metric_values set value_numeric = $3 where occasion_id = $1 and metric_definition_id = $2`, [occ, defId, v]);
    await setValue(id("gpexe_time_min"), 0);
    await setValue(id("gpexe_total_distance"), 1);
    assert.deepEqual(await reasons(c), { [String(perMin.id)]: "denominator_zero", [String(rest.id)]: "below_zero" });
    await setValue(id("gpexe_time_min"), -2);
    assert.equal((await reasons(c))[String(perMin.id)], "denominator_negative");
    await setValue(id("gpexe_time_min"), 2);
    await setValue(id("gpexe_total_distance"), -1);
    assert.equal((await reasons(c))[String(perMin.id)], "numerator_negative");
  } finally {
    await c.query("rollback").catch(() => {});
    await c.end();
  }
});

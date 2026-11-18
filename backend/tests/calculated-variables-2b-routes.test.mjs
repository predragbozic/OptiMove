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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "calc2b_routes", migrations: GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")) });
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

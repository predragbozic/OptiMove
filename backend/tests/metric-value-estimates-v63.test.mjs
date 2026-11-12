// v63 (phase 5b, 6b-A): estimated values. The capture kind, the provenance table and its guards (M1, M2), the supersede of
// an estimate by a later whole-session value (M3), the session undo that removes and logs estimates, the dashboards' policy word,
// and the migration's preflight / rollback rehearsal. Disposable databases; the import is the real approval through the routes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
const V63_FILE = "202611121000_training_load_v63_metric_value_estimates.sql";
// Every migration but the error-tracking one (an injected failure would be recorded as a row); v63 last.
const MAIN_MIGRATIONS = GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events"));
const UP_TO_V62 = MAIN_MIGRATIONS.filter((m) => m !== V63_FILE);
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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "est63", migrations: MAIN_MIGRATIONS });
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


const RUNBOOK = (name) => new URL(`../../docs/runbooks/${name}`, import.meta.url);

// The facts of one imported event: its participants by athlete, and one variable of each daily aggregation it carries.
async function eventFacts(s) {
  const parts = (await admin.query(`select id, athlete_id from training_load.metric_event_participants where event_id = $1`, [s.eventId])).rows;
  const defs = (await admin.query(
    `select distinct v.metric_definition_id def, v.metric_definition_version_id ver, dv.daily_aggregation_method agg
       from training_load.metric_values v
       join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_definition_versions dv on dv.id = v.metric_definition_version_id
      where p.event_id = $1 and o.segment_id is null and dv.value_type = 'numeric'`, [s.eventId])).rows;
  const of = (agg) => defs.find((d) => d.agg === agg);
  return { participant: Object.fromEntries(parts.map((p) => [p.athlete_id, p.id])), sum: of("sum"), max: of("max"), defs };
}

// The participant an estimate adds for an athlete the import did not record (6b-B does this with the activity link).
async function participantFor(s, athleteId) {
  const r = await admin.query(
    `insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Sarajevo')
     on conflict (event_id, athlete_id) do update set event_id = excluded.event_id returning id`, [s.eventId, athleteId]);
  return r.rows[0].id;
}

async function newClient() {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  return c;
}

// One estimate written the way 6b-B will: the acting user set for this transaction, the occasion, its one value, its provenance.
async function writeEstimate(client, { participantId, def, actor, value = 1000, method = "team_average", basis = { athletes: 3 }, setActor = true, provenance = true, keepOpen = false }) {
  await client.query("begin");
  try {
    if (setActor) await client.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [actor]);
    const occ = (await client.query(
      `insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'estimate',$2) returning id`,
      [participantId, actor])).rows[0].id;
    const val = (await client.query(
      `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1,$2,$3,$4) returning id`,
      [occ, def.def, def.ver, value])).rows[0].id;
    if (provenance) {
      await client.query(
        `insert into training_load.metric_value_estimates (metric_value_id, occasion_id, method, basis, estimated_by_user_id) values ($1,$2,$3,$4,$5)`,
        [val, occ, method, JSON.stringify(basis), actor]);
    }
    if (!keepOpen) await client.query("commit");
    return { occ, val };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

// A measured whole-session value written the way the import writes one with no source identity (an api_import occasion).
async function writeMeasured(client, { participantId, def, value = 2000, conflict = null }) {
  const occ = (await client.query(
    `insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, import_conflict_status) values ($1,'api_import',$2) returning id`,
    [participantId, conflict])).rows[0].id;
  await client.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1,$2,$3,$4)`, [occ, def.def, def.ver, value]);
  return occ;
}

const effective = async (occ) => (await admin.query(`select superseded_by_occasion_id s from training_load.metric_measurement_occasions where id = $1`, [occ])).rows[0].s === null;
const code = (p) => p.then(() => "ok", (e) => `${e.code}:${e.message}`);

let world;
async function imported() {
  if (!world) {
    const team = await setupTeam();
    const s = await importSession(team, 9101);
    world = { team, s, facts: await eventFacts(s) };
  }
  return world;
}

test("1. M1: an estimate is its own capture kind - standalone, not derived, not_applicable, no computed_by_ref - written with its provenance under the acting user", async () => {
  const { team, s, facts } = await imported();
  assert.ok(facts.sum && facts.max, "the imported event carries a sum and a max variable");
  const c = await newClient();
  try {
    const pc = await participantFor(s, team.athleteIds[2]);
    const { occ, val } = await writeEstimate(c, { participantId: pc, def: facts.sum, actor: team.coach.id, value: 4321 });
    const row = (await admin.query(
      `select o.entry_method, o.segment_id, o.recorded_by_user_id, v.is_derived, v.aggregation_role, v.coverage, v.computed_by_ref, v.value_numeric::text n,
              e.method, e.basis, e.estimated_by_user_id
         from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id
         join training_load.metric_value_estimates e on e.metric_value_id = v.id where v.id = $1`, [val])).rows[0];
    assert.deepEqual([row.entry_method, row.segment_id, row.is_derived, row.aggregation_role, row.coverage, row.computed_by_ref, row.n, row.method],
      ["estimate", null, false, "standalone", "not_applicable", null, "4321", "team_average"]);
    assert.equal(row.recorded_by_user_id, team.coach.id);
    assert.equal(row.estimated_by_user_id, team.coach.id);
    assert.deepEqual(row.basis, { athletes: 3 });
    assert.ok(await effective(occ));
  } finally {
    await c.end();
  }
});

test("2. the guards: no acting user or another user (42501); a segment or a source on the occasion, a second value, a max variable, a derived value, a bad basis, a method the variable refuses, no provenance by COMMIT (23514); nothing written", async () => {
  const { team, s, facts } = await imported();
  const pc = await participantFor(s, team.athleteIds[3]);
  const c = await newClient();
  const before = (await admin.query(`select count(*)::int n from training_load.metric_value_estimates`)).rows[0].n;
  try {
    assert.match(await code(writeEstimate(c, { participantId: pc, def: facts.sum, actor: team.coach.id, setActor: false })), /^42501:estimate: no acting user/);
    // the acting user is another user than the author
    await c.query("begin");
    await c.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.padmin.id]);
    assert.match(await code(c.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'estimate',$2)`, [pc, team.coach.id])), /^42501:estimate: the author/);
    await c.query("rollback");
    // a setting from another transaction is refused
    await c.query(`select set_config('optimove.estimate_actor', $1 || ':1', false)`, [team.coach.id]);
    await c.query("begin");
    assert.match(await code(c.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'estimate',$2)`, [pc, team.coach.id])), /^42501/);
    await c.query("rollback");
    await c.query(`select set_config('optimove.estimate_actor', '', false)`);
    // shape of the occasion
    await c.query("begin");
    await c.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.coach.id]);
    const seg = (await admin.query(`select id from training_load.metric_event_segments where event_id = $1 limit 1`, [s.eventId])).rows[0]?.id;
    if (seg) assert.match(await code(c.query(`insert into training_load.metric_measurement_occasions (event_participant_id, segment_id, entry_method, recorded_by_user_id) values ($1,$2,'estimate',$3)`, [pc, seg, team.coach.id])), /^23514:estimate: an estimate occasion is a whole-session/);
    await c.query("rollback");
    // a max variable cannot be estimated
    assert.match(await code(writeEstimate(c, { participantId: pc, def: facts.max, actor: team.coach.id })), /^23514:estimate: this variable cannot be estimated/);
    // a derived value
    await c.query("begin");
    await c.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.coach.id]);
    let occ = (await c.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'estimate',$2) returning id`, [pc, team.coach.id])).rows[0].id;
    assert.match(await code(c.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, is_derived) values ($1,$2,$3,1,true)`, [occ, facts.sum.def, facts.sum.ver])), /^23514:estimate: an estimated value is a standalone/);
    await c.query("rollback");
    // a second value on the same estimate occasion
    await c.query("begin");
    await c.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.coach.id]);
    occ = (await c.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'estimate',$2) returning id`, [pc, team.coach.id])).rows[0].id;
    await c.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1,$2,$3,1)`, [occ, facts.sum.def, facts.sum.ver]);
    const other = facts.defs.find((d) => d.def !== facts.sum.def && d.agg === "sum");
    if (other) assert.match(await code(c.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1,$2,$3,1)`, [occ, other.def, other.ver])), /^23514:estimate: an estimate occasion holds one value/);
    await c.query("rollback");
    // a basis that is not the method's closed shape, and a method outside the list
    assert.match(await code(writeEstimate(c, { participantId: pc, def: facts.sum, actor: team.coach.id, method: "team_average", basis: { athletes: 2 } })), /^23514:.*basis_shape/);
    assert.match(await code(writeEstimate(c, { participantId: pc, def: facts.sum, actor: team.coach.id, method: "proportional", basis: { minutes: 75, ratePerMinute: 80, sessions: 4, extra: 1 } })), /^23514:.*basis_shape/);
    assert.match(await code(writeEstimate(c, { participantId: pc, def: facts.sum, actor: team.coach.id, method: "copy_athlete", basis: { sourceAthleteId: "not-a-uuid" } })), /^23514:.*basis_shape/);
    // no provenance row by COMMIT
    assert.match(await code(writeEstimate(c, { participantId: pc, def: facts.sum, actor: team.coach.id, provenance: false })), /^23514:estimate: an estimated value needs its provenance row/);
    assert.equal((await admin.query(`select count(*)::int n from training_load.metric_value_estimates`)).rows[0].n, before, "nothing was written");
    assert.equal((await admin.query(`select count(*)::int n from training_load.metric_measurement_occasions where event_participant_id = $1`, [pc])).rows[0].n, 0);
  } finally {
    await c.end();
  }
});

test("2b. the method a variable allows: avg takes copy_athlete and team_average, never proportional; sum takes all three", async () => {
  const { team, s, facts } = await imported();
  // An avg variable: the sum variable's definition with a new version that averages (the guard reads the value's version).
  const avgVer = (await admin.query(
    `insert into training_load.metric_definition_versions (metric_definition_id, version_number, value_type, unit, daily_aggregation_method)
     select metric_definition_id, (select coalesce(max(version_number), 0) + 1 from training_load.metric_definition_versions where metric_definition_id = $1), value_type, unit, 'avg'
       from training_load.metric_definition_versions where id = $2 returning id`, [facts.sum.def, facts.sum.ver])).rows[0]?.id;
  assert.ok(avgVer, "an avg version of the variable exists for this test");
  const avg = { def: facts.sum.def, ver: avgVer };
  const c = await newClient();
  try {
    const p1 = await participantFor(s, team.athleteIds[4]);
    assert.match(await code(writeEstimate(c, { participantId: p1, def: avg, actor: team.coach.id, method: "proportional", basis: { minutes: 60, ratePerMinute: 50, sessions: 3 } })), /^23514:estimate: this method is not allowed/);
    assert.equal(await code(writeEstimate(c, { participantId: p1, def: avg, actor: team.coach.id, method: "copy_athlete", basis: { sourceAthleteId: team.athleteIds[0] } })), "ok");
  } finally {
    await c.end();
  }
});

test("3. M2: an estimate is never written for a variable that has an effective measured whole-session value for that athlete; another variable can be", async () => {
  const { team, s, facts } = await imported();
  const pa = facts.participant[team.athleteIds[0]];
  assert.ok(pa, "athlete A was recorded by the import");
  const c = await newClient();
  try {
    assert.match(await code(writeEstimate(c, { participantId: pa, def: facts.sum, actor: team.coach.id })), /^23514:estimate_measured_exists$/);
  } finally {
    await c.end();
  }
});

test("4. M3: a later measured whole-session value supersedes the estimate of the same variable; another variable, a drill value or a flagged value leaves it; a second estimate supersedes the first", async () => {
  const { team, s, facts } = await imported();
  const other = facts.defs.find((d) => d.def !== facts.sum.def && d.agg === "sum");
  const c = await newClient();
  try {
    const p = await participantFor(s, team.athleteIds[5]);
    const first = await writeEstimate(c, { participantId: p, def: facts.sum, actor: team.coach.id });
    const second = await writeEstimate(c, { participantId: p, def: facts.sum, actor: team.coach.id, value: 1100 });
    assert.equal(await effective(first.occ), false, "the second estimate supersedes the first");
    assert.ok(await effective(second.occ));
    if (other) {
      await c.query("begin");
      await writeMeasured(c, { participantId: p, def: other });
      await c.query("commit");
      assert.ok(await effective(second.occ), "a measured value of another variable leaves the estimate");
    }
    await c.query("begin");
    await writeMeasured(c, { participantId: p, def: facts.sum, conflict: "needs_review" });
    await c.query("commit");
    assert.ok(await effective(second.occ), "a value flagged for review is not effective and leaves the estimate");
    await c.query("begin");
    const measured = await writeMeasured(c, { participantId: p, def: facts.sum });
    await c.query("commit");
    assert.equal(await effective(second.occ), false, "the measured value supersedes the estimate");
    assert.equal((await admin.query(`select superseded_by_occasion_id s from training_load.metric_measurement_occasions where id = $1`, [second.occ])).rows[0].s, measured);
    // and now no new estimate of that variable
    assert.match(await code(writeEstimate(c, { participantId: p, def: facts.sum, actor: team.coach.id })), /^23514:estimate_measured_exists$/);
  } finally {
    await c.end();
  }
});

test("4b. what v13 allows on the supersede column: any path may set it on a measured occasion (corrections), but an estimate occasion is superseded once, only by a whole-session occasion of the same athlete, and never gets a conflict status", async () => {
  const { team, s, facts } = await imported();
  const c = await newClient();
  try {
    const athlete = (await admin.query(`insert into public.athletes (full_name, display_name, device_timezone) values ('Zq Rev','Zq Rev','Europe/Sarajevo') returning id`)).rows[0].id;
    const p = await participantFor(s, athlete);
    const otherP = facts.participant[team.athleteIds[0]];
    const e = await writeEstimate(c, { participantId: p, def: facts.sum, actor: team.coach.id });
    const set = (col, val, id = e.occ) => code(admin.query(`update training_load.metric_measurement_occasions set ${col} = $1 where id = $2`, [val, id]));
    // another athlete's occasion, a drill occasion, itself, a conflict status, a supersedes pointer: refused
    const otherOcc = (await admin.query(`select id from training_load.metric_measurement_occasions where event_participant_id = $1 and segment_id is null limit 1`, [otherP])).rows[0].id;
    assert.match(await set("superseded_by_occasion_id", otherOcc), /^23514:estimate: an estimate is superseded only by a whole-session value of the same athlete/);
    const drill = (await admin.query(`select id from training_load.metric_measurement_occasions where segment_id is not null limit 1`)).rows[0]?.id;
    if (drill) assert.match(await set("superseded_by_occasion_id", drill), /^23514:estimate: an estimate is superseded only by/);
    assert.match(await set("superseded_by_occasion_id", e.occ), /^23514:estimate: an estimate is superseded only by/);
    assert.match(await set("import_conflict_status", "needs_review"), /^23514:estimate: an estimate occasion has no conflict status/);
    assert.match(await set("supersedes_occasion_id", otherOcc), /^23514:estimate: an estimate occasion has no conflict status and supersedes nothing/);
    assert.ok(await effective(e.occ), "nothing was changed");
    // a whole-session occasion of the same athlete: allowed once (the trigger's own path), never re-pointed
    await c.query("begin");
    const m1 = await writeMeasured(c, { participantId: p, def: facts.defs.find((d) => d.def !== facts.sum.def && d.agg === "sum") ?? facts.max });
    await c.query("commit");
    assert.equal(await set("superseded_by_occasion_id", m1), "ok", "the same athlete's whole-session occasion: allowed");
    await c.query("begin");
    const m2 = await writeMeasured(c, { participantId: p, def: facts.max });
    await c.query("commit");
    assert.match(await set("superseded_by_occasion_id", m2), /^23514:estimate: an estimate is superseded once/);
    // a measured occasion keeps what v13 allows (the revision fields stay updatable by any path; its identity stays frozen)
    assert.equal(await set("superseded_by_occasion_id", null, m2), "ok");
    assert.match(await set("entry_method", "estimate", m2), /immutable/);
  } finally {
    await c.end();
  }
});

test("5. M3 lock order, both orders: an import writing the athlete's value and an estimate save serialize on the participant; whoever commits first wins, the other is refused or superseded, and nothing deadlocks", async () => {
  const { team, s, facts } = await imported();
  const athlete = (await admin.query(`insert into public.athletes (full_name, display_name, device_timezone) values ('Zq Late','Zq Late','Europe/Sarajevo') returning id`)).rows[0].id;
  // (a) the measured value first (its transaction holds the participant), the estimate waits, then is refused
  const p1 = await participantFor(s, athlete);
  const imp = await newClient();
  const est = await newClient();
  try {
    await imp.query("begin");
    await writeMeasured(imp, { participantId: p1, def: facts.sum });
    const waiting = code(writeEstimate(est, { participantId: p1, def: facts.sum, actor: team.coach.id }));
    await new Promise((r) => setTimeout(r, 300));
    const blocked = (await admin.query(`select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).rows[0].n;
    assert.ok(blocked >= 1, "the estimate waits on the import's participant lock");
    await imp.query("commit");
    assert.match(await waiting, /^23514:estimate_measured_exists$/);
    // (b) the estimate first, then the measured value supersedes it
    const athlete2 = (await admin.query(`insert into public.athletes (full_name, display_name, device_timezone) values ('Zq Late2','Zq Late2','Europe/Sarajevo') returning id`)).rows[0].id;
    const p2 = await participantFor(s, athlete2);
    const e = await writeEstimate(est, { participantId: p2, def: facts.sum, actor: team.coach.id, keepOpen: true });
    const importing = (async () => { await imp.query("begin"); const o = await writeMeasured(imp, { participantId: p2, def: facts.sum }); await imp.query("commit"); return o; })();
    await new Promise((r) => setTimeout(r, 300));
    await est.query("commit");
    const measured = await importing;
    assert.equal((await admin.query(`select superseded_by_occasion_id s from training_load.metric_measurement_occasions where id = $1`, [e.occ])).rows[0].s, measured);
  } finally {
    await imp.end();
    await est.end();
  }
});

test("6. the provenance table is append-only: UPDATE and DELETE are refused outside the session undo, TRUNCATE always", async () => {
  const { team, s, facts } = await imported();
  const c = await newClient();
  try {
    const p = await participantFor(s, team.athleteIds[2]);
    const any = (await admin.query(`select id from training_load.metric_value_estimates limit 1`)).rows[0]?.id
      ?? (await (async () => { const w = await writeEstimate(c, { participantId: p, def: facts.sum, actor: team.coach.id }); return (await admin.query(`select id from training_load.metric_value_estimates where metric_value_id = $1`, [w.val])).rows[0].id; })());
    assert.match(await code(admin.query(`update training_load.metric_value_estimates set note = 'x' where id = $1`, [any])), /^23514:metric_value_estimates is append-only/);
    assert.match(await code(admin.query(`delete from training_load.metric_value_estimates where id = $1`, [any])), /^23514:metric_value_estimates is append-only/);
    assert.match(await code(admin.query(`truncate training_load.metric_value_estimates`)), /^(23514|P0001)/);
    assert.match(await code(admin.query(`update training_load.metric_measurement_occasions set entry_method = 'manual' where entry_method = 'estimate'`)), /immutable/);
  } finally {
    await c.end();
  }
});

test("7. the session undo lists the estimates in its preview, removes them with the session and logs them; they never block", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9201);
  const facts = await eventFacts(s);
  const c = await newClient();
  try {
    const p = await participantFor(s, team.athleteIds[2]);
    await writeEstimate(c, { participantId: p, def: facts.sum, actor: team.coach.id });
  } finally {
    await c.end();
  }
  const scope = (await admin.query(`select training_load.session_undo_scope($1) s`, [s.eventId])).rows[0].s;
  assert.deepEqual([scope.estimateOccasionCount, scope.estimateValueCount, scope.manualOccasionCount], [1, 1, 0]);
  const r = await undo(team, s);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.undo.removedCounts.metric_value_estimates, 1, JSON.stringify(r.body));
  const log = (await admin.query(`select removed_counts from training_load.import_deletion_log where event_id = $1`, [s.eventId])).rows[0];
  assert.equal(log.removed_counts.metric_value_estimates, 1);
  assert.equal((await admin.query(`select count(*)::int n from training_load.metric_measurement_occasions where entry_method = 'estimate' and event_participant_id = $1`, [s.eventId])).rows[0].n, 0);
  assert.equal((await admin.query(
    `select count(*)::int n from training_load.metric_value_estimates e join training_load.metric_measurement_occasions o on o.id = e.occasion_id
      join training_load.metric_event_participants p on p.id = o.event_participant_id where p.event_id = $1`, [s.eventId])).rows[0].n, 0);
});

test("8. the dashboards' series policy takes 'estimate' (6b-D shows estimates only under it)", async () => {
  const def = (await admin.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'dashboard_widget_series_source_policy_check'`)).rows[0].d;
  assert.match(def, /'estimate'/);
  assert.match(def, /'all_with_conflicts'/);
});

// The catalog facts the rollback must restore exactly.
async function catalogOf(client) {
  const q = async (sql) => (await client.query(sql)).rows.map((r) => r.d);
  return {
    triggers: await q(`select c.relname || '.' || t.tgname || ' :: ' || pg_get_triggerdef(t.oid) d from pg_trigger t join pg_class c on c.oid = t.tgrelid
                        where c.relname in ('metric_values', 'metric_measurement_occasions', 'dashboard_widget_series') and not t.tgisinternal order by 1`),
    constraints: await q(`select conrelid::regclass::text || '.' || conname || ' :: ' || pg_get_constraintdef(oid) d from pg_constraint
                           where conrelid in ('training_load.metric_measurement_occasions'::regclass, 'training_load.dashboard_widget_series'::regclass, 'training_load.metric_values'::regclass) order by 1`),
    tables: await q(`select table_schema || '.' || table_name d from information_schema.tables where table_schema in ('training_load', 'training') order by 1`),
    functions: await q(`select n.nspname || '.' || p.proname || ' ' || md5(p.prosrc) d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('training_load', 'training') order by 1`),
  };
}

test("9. migration v63: the preflight passes on v62, the post-check on v63; the rollback restores v62 exactly and refuses once an estimate exists; the migration applies again; it refuses over a changed undo body or without v62", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "est63rb", migrations: UP_TO_V62 });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    const pre = await booleansOf(client, fs.readFileSync(RUNBOOK("metric-value-estimates-v63-preflight.sql"), "utf8"));
    assert.ok(pre.length >= 6, `the preflight returned its booleans (${pre.length})`);
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok on a v62 database");
    const v62Catalog = await catalogOf(client);
    // The md5 gate: a changed undo body refuses the migration, and nothing is applied.
    const undoSrc = (await client.query(`select pg_get_functiondef('training_load.session_undo_scope(uuid)'::regprocedure) d`)).rows[0].d;
    await client.query(undoSrc.replace("$function$\ndeclare", "$function$\n-- changed\ndeclare"));
    // The runner reports the refusal by its SQLSTATE (the message stays in the server log); nothing of v63 is applied.
    await assert.rejects(applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS), /v63_metric_value_estimates\.sql" \(SQLSTATE 23514\)/);
    await client.query(undoSrc);
    assert.deepEqual(await catalogOf(client), v62Catalog, "nothing of v63 was applied");
    await applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS);
    const post = await booleansOf(client, fs.readFileSync(RUNBOOK("metric-value-estimates-v63-postcheck.sql"), "utf8"));
    assert.ok(post.length >= 6, `the post-check returned its booleans (${post.length})`);
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok on a v63 database");
    const v63Catalog = await catalogOf(client);
    assert.notDeepEqual(v63Catalog, v62Catalog);
    await client.query(fs.readFileSync(RUNBOOK("metric-value-estimates-v63-rollback.sql"), "utf8"));
    assert.deepEqual(await catalogOf(client), v62Catalog, "the rollback restores the v62 catalog exactly");
    await applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS);
    assert.deepEqual(await catalogOf(client), v63Catalog, "re-applied: the same catalog");
    // Once an estimate exists the rollback refuses and changes nothing (an occasion row is enough).
    const u = (await client.query(`insert into public.users (email, full_name, display_name) values ('rb63@test.local','R','R') returning id`)).rows[0].id;
    const ath = (await client.query(`insert into public.athletes (full_name, display_name, device_timezone) values ('R','R','Europe/Sarajevo') returning id`)).rows[0].id;
    const ev = (await client.query(`insert into training_load.metric_events (owner_scope, owner_user_id, scope_level, occurred_date) values ('user',$1,'session','2026-09-14') returning id`, [u])).rows[0].id;
    {
      const p = (await client.query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Sarajevo') returning id`, [ev, ath])).rows[0].id;
      await client.query("begin");
      await client.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [u]);
      await client.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'estimate',$2)`, [p, u]);
      await client.query("commit");
      await assert.rejects(client.query(fs.readFileSync(RUNBOOK("metric-value-estimates-v63-rollback.sql"), "utf8")), /v63 rollback refused: an estimate exists/);
      await client.query("rollback").catch(() => {});
      assert.deepEqual(await catalogOf(client), v63Catalog, "the refused rollback changed nothing");
    }
  } finally {
    await client.end();
    await rb.drop();
  }
});

test("10. v63 refuses to run without v62's table (the order: #493 first)", async () => {
  const withoutV62 = UP_TO_V62.filter((m) => !m.includes("v62_team_session_timezone"));
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "est63no62", migrations: withoutV62 });
  try {
    await assert.rejects(applyGpexeTestMigrations(rb.url, [...withoutV62, V63_FILE]), /v63_metric_value_estimates\.sql" \(SQLSTATE 23514\)/);
    const c = new pg.Client({ connectionString: rb.url });
    await c.connect();
    try {
      assert.equal((await c.query(`select to_regclass('training_load.metric_value_estimates') t`)).rows[0].t, null, "nothing of v63 was applied");
      // Run directly, the gate names its reason.
      const sql = fs.readFileSync(new URL(`../../migrations_v2/${V63_FILE}`, import.meta.url), "utf8");
      await assert.rejects(c.query(sql), /v63 refused: v62 \(the team session time zone\) is not applied/);
    } finally {
      await c.end();
    }
  } finally {
    await rb.drop();
  }
});
async function booleansOf(client, sql) {
  const results = [].concat(await client.query(sql));
  const out = [];
  for (const res of results) for (const row of res.rows) for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") out.push([k, v]);
  return out;
}

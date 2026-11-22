// ST-3 (docs/ai/session-type-plan.md sections 3, 5, 6, 10 and 16; migration v88): a session's type changed after the
// import, an athlete's own type in a session, the effective type in the estimates (Own average in history with D7,
// Team average, Copy), the derived mark on a saved estimate, and the merge / reparent rule. The real app over HTTP on a
// disposable database; the sessions are real imports through the routes. Invented people only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle as makeFixtureBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding } from "./support/mapped-world.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL = { url: process.env.DATABASE_URL, apply: process.env.GPEXE_IMPORT_APPLY_ENABLED, keys: process.env.SOURCE_CREDENTIAL_KEYS, flag: process.env.ESTIMATES_ENABLED };
const D1 = "2026-09-14";
const NOT_FOUND = { error: "notFound" };
let src;
let connections;
let resolver;
let db;
let admin;
let server;
let apiBase;
let service;
let estimates;
let typeService;
let createSession;
let appPool;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL.url, label: "st3", migrations: GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")) });
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
  typeService = await import("../src/activityTypeChangeService.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  src = createFakeSource();
  connections.setSourceFetchForTests(src.fetchImpl);
  resolver.setImportSourceFetchForTests(src.fetchImpl);
  service.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a bound team"); });
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app pool is on the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  typeService?.setTypeChangeTestHooks(null);
  estimates?.setEstimateTestHooks(null);
  service?.setGpexeClientFactory(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  for (const [name, value] of [["SOURCE_CREDENTIAL_KEYS", ORIGINAL.keys], ["ESTIMATES_ENABLED", ORIGINAL.flag], ["GPEXE_IMPORT_APPLY_ENABLED", ORIGINAL.apply]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL.url;
});

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
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
  return (await q(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label.replace(/\s+/g, "-")}-${crypto.randomBytes(4).toString("hex")}@test.local`, label]))[0].id;
}
async function setWorkspace(userId, type, scopeId) {
  await q(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [userId, type, scopeId],
  );
}
const withCookie = async (id) => ({ id, cookie: `optimove_session=${await createSession(id)}` });
async function coachOf(teamId, label = "coach") {
  const id = await makeUser(label);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return withCookie(id);
}
async function platformAdmin() {
  const id = await makeUser("platform admin");
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return withCookie(id);
}
async function clubAdminOf(clubId) {
  const id = await makeUser("club admin");
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await setWorkspace(id, "club", clubId);
  return withCookie(id);
}

// GPEXE athletes: 101 and 102 are the fixture's; 104 and 105 are clean copies of 102 (105 trains 25 min, 2500 m).
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
  return makeFixtureBundle({ detailsDrills: [0, 1], sessionId, gpexeTeamId: 77, start: `${D1}T${String(hour).padStart(2, "0")}:08:12`, updatedOn: `${D1}T20:18:09.337`, athletes });
}

let nextGpexeTeamId = 8800;
async function setupTeam() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["Ana", "Bea", "Cil", "Dan", "Eva", "Fil"] });
  await q(`delete from public.athlete_memberships where team_id = $1`, [org.teamId]);
  for (const athleteId of org.athleteIds) {
    await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athleteId, org.clubId, org.teamId]);
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
async function importSession(team, bundle) {
  src.serve(team.sourceTeamId, [bundle]);
  const started = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: { from: D1, to: D1 } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; ; i += 1) {
    const r = await api(`/teams/${team.teamId}/checks/${started.body.check.id}`, { cookie: team.coach.cookie });
    if (r.body.check?.status !== "running") {
      assert.equal(r.body.check.status, "succeeded", JSON.stringify(r.body.check));
      break;
    }
    assert.ok(i < 200, "the check finished");
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
  const approval = (await q(`select metric_event_id, activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id]))[0];
  return { candidateId: cand.id, eventId: approval.metric_event_id, activityId: String(approval.activity_id) };
}

const [ANA, BEA, CIL, DAN, EVA] = [0, 1, 2, 3, 4];
// One team: three earlier sessions with Dan (9801-9803), the target without Dan (9810), and a session with everyone (9820).
let world;
async function theWorld() {
  if (world) return world;
  const team = await setupTeam();
  const past = [];
  for (const [sessionId, hour] of [[9801, 6], [9802, 7], [9803, 8]]) past.push(await importSession(team, bundleOf({ sessionId, hour, ids: [101, 102, 104, 105] })));
  const target = await importSession(team, bundleOf({ sessionId: 9810, hour: 10, ids: [101, 102, 104] }));
  const full = await importSession(team, bundleOf({ sessionId: 9820, hour: 12, ids: [101, 102, 104, 105] }));
  const time = (await q(`select key from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE time min %'`))[0].key;
  const distance = String((await q(`select id from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE total distance %'`))[0].id);
  estimates.setEstimateTestHooks({ durationKey: time });
  world = { team, past, target, full, distance };
  return world;
}

const setType = (s, activityTypeKey, { cookie, reason, requestKey = key() } = {}) =>
  tapi(`/${s.activityId}/type`, { method: "POST", cookie, body: { activityTypeKey, requestKey, ...(reason === undefined ? {} : { reason }) } });
const setAthleteType = (s, athleteId, activityTypeKey, { cookie, reason, requestKey = key() } = {}) =>
  tapi(`/${s.activityId}/roster/${athleteId}/type`, { method: "PUT", cookie, body: { activityTypeKey, requestKey, ...(reason === undefined ? {} : { reason }) } });
const sessionType = async (s) => (await q(`select activity_type_key from training.activities where id = $1`, [s.activityId]))[0].activity_type_key;
const participantOf = async (s, athleteId) => (await q(`select id from training.activity_participants where activity_id = $1 and athlete_id = $2`, [s.activityId, athleteId]))[0]?.id ?? null;
const exceptionsOf = async (s, athleteId) => q(
  `select x.activity_type_key as key, x.end_cause as cause, x.ended_at is null as live, x.reason, x.set_by_basis as basis
     from training.participant_activity_types x join training.activity_participants ap on ap.id = x.participant_id
    where ap.activity_id = $1 and ap.athlete_id = $2 order by x.set_at, x.id`, [s.activityId, athleteId]);
const counts = async () => (await q(
  `select (select count(*) from training.participant_activity_types)::int as exceptions,
          (select count(*) from training.activity_type_requests)::int as requests,
          (select count(*) from training.activity_field_correction_log)::int as corrections`))[0];
const effective = async (participantId) => (await q(`select training.effective_activity_type($1) as t`, [participantId]))[0].t;
const rosterAthlete = async (team, s, athleteId) => (await tapi(`/${s.activityId}/roster`, { cookie: team.coach.cookie })).body.athletes.find((a) => a.athleteId === athleteId);
const proposal = (team, s, athleteId, extra = "") => tapi(`/${s.activityId}/estimates/proposal?athleteId=${athleteId}${extra}`, { cookie: team.coach.cookie });
// Puts a session back to Full training and clears every exception in it (through the routes), so tests do not lean on each other.
async function reset(team, ...sessions) {
  for (const s of sessions) {
    for (const row of await q(`select ap.athlete_id from training.participant_activity_types x join training.activity_participants ap on ap.id = x.participant_id where ap.activity_id = $1 and x.ended_at is null`, [s.activityId])) {
      assert.equal((await setAthleteType(s, row.athlete_id, null, { cookie: team.coach.cookie })).status, 200);
    }
    assert.equal((await setType(s, "training_session", { cookie: team.coach.cookie })).status, 200);
  }
}
// A raw client on the disposable database, for the guards (writes outside the routes).
async function raw(fn) {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    await c.end();
  }
}
const asActor = (c, userId) => c.query(`select set_config('optimove.session_type_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [userId]);
async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return `${error.code} ${error.message}`;
  }
  return "no refusal";
}

// ---------------------------------------------------------------------------
// The session's type
// ---------------------------------------------------------------------------
test("1. the audience: the team's coach, the club's admin and a platform admin change a session's type and an athlete's; everyone else gets the identical 404 and writes nothing", async () => {
  const { team, full } = await theWorld();
  const ana = team.athleteIds[ANA];
  for (const [who, type] of [[team.coach, "match"], [team.cadmin, "friendly_match"], [team.padmin, "training_session"]]) {
    const r = await setType(full, type, { cookie: who.cookie });
    assert.equal(r.status, 200, r.text);
    assert.equal(await sessionType(full), type);
    const a = await setAthleteType(full, ana, "rtp_session", { cookie: who.cookie });
    assert.equal(a.status, 200, a.text);
    assert.equal((await setAthleteType(full, ana, null, { cookie: who.cookie })).status, 200);
  }
  assert.deepEqual((await q(`select basis from training.activity_type_requests where activity_id = $1 and operation = 'session_type' order by created_at`, [full.activityId])).map((r) => r.basis),
    ["team_coach", "club_admin", "platform_admin"], "the basis is the path of the active workspace");

  const other = await createGpexePilotOrg(admin, { athleteNames: ["Zed"] });
  const foreign = await coachOf(other.teamId, "foreign coach");
  const wrongWorkspace = await coachOf(team.teamId, "coach elsewhere");
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [wrongWorkspace.id, other.teamId]);
  await setWorkspace(wrongWorkspace.id, "team", other.teamId);
  const otherClubAdmin = await clubAdminOf(other.clubId);
  const nobody = await withCookie(await makeUser("nobody"));
  const athleteUserId = await makeUser("athlete account");
  await q(`update public.athletes set user_id = $1 where id = $2`, [athleteUserId, ana]);
  await setWorkspace(athleteUserId, "athlete", null);
  const athlete = await withCookie(athleteUserId);
  const missing = await tapi(`/${crypto.randomUUID()}/type`, { method: "POST", cookie: team.coach.cookie, body: { activityTypeKey: "match", requestKey: key() } });
  assert.deepEqual([missing.status, missing.body], [404, NOT_FOUND]);
  const before = await counts();
  for (const who of [foreign, wrongWorkspace, otherClubAdmin, nobody, athlete]) {
    const s = await setType(full, "match", { cookie: who.cookie });
    const a = await setAthleteType(full, ana, "rtp_session", { cookie: who.cookie });
    assert.deepEqual([s.status, s.body, a.status, a.body], [404, NOT_FOUND, 404, NOT_FOUND]);
  }
  assert.equal((await setType(full, "match", {})).status, 401);
  assert.deepEqual(await counts(), before, "nothing was written");
  assert.equal(await sessionType(full), "training_session");
});

test("2. a session's type: changed through the correction function (who, why), one request row; the same type again changes nothing; the replay; a reused key; a type not offered", async () => {
  const { team, full } = await theWorld();
  await reset(team, full);
  const before = await counts();
  const k = key();
  const r = await setType(full, "match", { cookie: team.coach.cookie, reason: "It was the cup game", requestKey: k });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body, { activityId: full.activityId, activityTypeKey: "match", previousActivityTypeKey: "training_session", changed: true, endedExceptionAthleteIds: [] });
  assert.equal(await sessionType(full), "match");
  const log = (await q(`select old_values ->> 'activity_type_key' as old, new_values ->> 'activity_type_key' as new, reason, performed_by_user_id,
                               old_values - 'activity_type_key' = new_values - 'activity_type_key' as rest_unchanged
                          from training.activity_field_correction_log where activity_id = $1 order by changed_at desc, id limit 1`, [full.activityId]))[0];
  assert.deepEqual(log, { old: "training_session", new: "match", reason: "It was the cup game", performed_by_user_id: team.coach.id, rest_unchanged: true });
  const request = (await q(`select operation, old_type_key, new_type_key, reason, basis, athlete_id from training.activity_type_requests where request_key = $1`, [k]))[0];
  assert.deepEqual(request, { operation: "session_type", old_type_key: "training_session", new_type_key: "match", reason: "It was the cup game", basis: "team_coach", athlete_id: null });
  assert.deepEqual(await counts(), { exceptions: before.exceptions, requests: before.requests + 1, corrections: before.corrections + 1 });

  // The replay answers the saved outcome and writes nothing, even after the type moved on.
  const after1 = await counts();
  const replay = await setType(full, "match", { cookie: team.coach.cookie, reason: "It was the cup game", requestKey: k });
  assert.deepEqual([replay.status, replay.body], [200, r.body]);
  const reused = await setType(full, "friendly_match", { cookie: team.coach.cookie, requestKey: k });
  assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"]);
  // Another user's request with the same key is its own request, never this one's answer.
  const same = await setType(full, "match", { cookie: team.cadmin.cookie, requestKey: k });
  assert.deepEqual([same.status, same.body.changed], [200, false], "the same type again: 200, nothing changed");
  assert.deepEqual(await counts(), after1, "a replay, a reused key and the same type wrote nothing");
  // The replay is answered only to a caller who still holds the right: a coach whose role was revoked gets the 404.
  const leaving = await coachOf(team.teamId, "leaving coach");
  const lk = key();
  assert.equal((await setType(full, "friendly_match", { cookie: leaving.cookie, requestKey: lk })).status, 200);
  await q(`update public.user_team_roles set is_active = false where user_id = $1`, [leaving.id]);
  const gone = await setType(full, "friendly_match", { cookie: leaving.cookie, requestKey: lk });
  assert.deepEqual([gone.status, gone.body], [404, NOT_FOUND]);
  assert.equal((await setType(full, "match", { cookie: team.coach.cookie })).status, 200);
  const after2 = await counts();
  assert.deepEqual(after2, { ...after1, requests: after1.requests + 2, corrections: after1.corrections + 2 });
  // A key that changed nothing stays free.
  const freeKey = key();
  assert.equal((await setType(full, "match", { cookie: team.coach.cookie, requestKey: freeKey })).body.changed, false);
  assert.equal((await setType(full, "training_session", { cookie: team.coach.cookie, requestKey: freeKey })).body.changed, true);

  // Not offered: unknown, archived, another club's - one answer, nothing written.
  const otherClub = (await q(`insert into public.clubs (name) values ('St3 other club') returning id`))[0].id;
  await raw(async (c) => {
    const pa = team.padmin.id;
    await c.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [pa, otherClub]);
    await c.query("begin");
    await asActor(c, pa);
    await c.query(`insert into training.activity_types (key, label, owner_scope, owner_club_id, created_by_user_id) values ('c_0000beef_gym', 'Gym', 'club', $1, $2)`, [otherClub, pa]);
    await c.query(`insert into training.activity_type_changes (type_key, action, new_label, performed_by_user_id, basis, request_key, request_hash) values ('c_0000beef_gym', 'create', 'Gym', $1, 'club_admin', gen_random_uuid(), $2)`, [pa, "c".repeat(64)]);
    await c.query("commit");
  });
  const mark = await counts();
  const answers = [];
  for (const type of ["no_such_type", "testing_session", "c_0000beef_gym"]) {
    const s = await setType(full, type, { cookie: team.coach.cookie });
    const a = await setAthleteType(full, team.athleteIds[ANA], type, { cookie: team.coach.cookie });
    answers.push(JSON.stringify([s.status, s.body, a.status, a.body]));
  }
  assert.equal(new Set(answers).size, 1, answers.join("\n"));
  assert.match(answers[0], /^\[409,\{"error":"session_type_not_offered"/);
  // Bad bodies: 400 before any database work.
  for (const [body, code] of [[{ activityTypeKey: "match" }, "invalid_request_key"], [{ activityTypeKey: "Match!", requestKey: key() }, "invalid_session_type"],
    [{ requestKey: key() }, "invalid_session_type"], [{ activityTypeKey: "match", requestKey: key(), reason: 5 }, "invalid_reason"],
    [{ activityTypeKey: "match", requestKey: key(), reason: "x".repeat(301) }, "invalid_reason"]]) {
    const b = await tapi(`/${full.activityId}/type`, { method: "POST", cookie: team.coach.cookie, body });
    assert.deepEqual([b.status, b.body.error], [400, code], JSON.stringify(body));
  }
  assert.equal((await tapi(`/${full.activityId}/roster/${team.athleteIds[ANA]}/type`, { method: "PUT", cookie: team.coach.cookie, body: { requestKey: key() } })).body.error, "invalid_session_type");
  assert.deepEqual(await counts(), mark, "a refusal wrote nothing");
  assert.equal(await sessionType(full), "training_session");
});

// ---------------------------------------------------------------------------
// The athlete's own type
// ---------------------------------------------------------------------------
test("3. an athlete's exception: set, replaced, cleared - the history kept; the effective type follows it; the same type as the session is refused; an athlete without a record has none", async () => {
  const { team, full, target } = await theWorld();
  await reset(team, full);
  const ana = team.athleteIds[ANA];
  const participant = await participantOf(full, ana);
  assert.equal(await effective(participant), "training_session");

  const set = await setAthleteType(full, ana, "rtp_session", { cookie: team.coach.cookie, reason: "Back from injury" });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.body, {
    activityId: full.activityId, athleteId: ana, sessionTypeKey: "training_session", exceptionTypeKey: "rtp_session",
    effectiveTypeKey: "rtp_session", previousExceptionTypeKey: null, changed: true,
  });
  assert.equal(await effective(participant), "rtp_session");
  const row = await rosterAthlete(team, full, ana);
  assert.equal(row.sessionType.effectiveKey, "rtp_session");
  assert.deepEqual({ ...row.sessionType.exception, setAt: null }, { activityTypeKey: "rtp_session", reason: "Back from injury", setBy: "coach", setAt: null });
  assert.equal(row.sessionType.endedException, null);
  assert.equal((await rosterAthlete(team, full, team.athleteIds[BEA])).sessionType.effectiveKey, "training_session", "the others keep the session's type");

  const same = await setAthleteType(full, ana, "training_session", { cookie: team.coach.cookie });
  assert.deepEqual([same.status, same.body.error], [409, "same_as_session"]);
  assert.equal((await setAthleteType(full, ana, "rtp_session", { cookie: team.coach.cookie })).body.changed, false, "the same exception again changes nothing");

  const replaced = await setAthleteType(full, ana, "compensation_session", { cookie: team.cadmin.cookie });
  assert.deepEqual([replaced.body.previousExceptionTypeKey, replaced.body.exceptionTypeKey], ["rtp_session", "compensation_session"]);
  const cleared = await setAthleteType(full, ana, null, { cookie: team.coach.cookie });
  assert.deepEqual([cleared.body.exceptionTypeKey, cleared.body.effectiveTypeKey, cleared.body.changed], [null, "training_session", true]);
  assert.equal((await setAthleteType(full, ana, null, { cookie: team.coach.cookie })).body.changed, false, "nothing to clear: 200, nothing written");
  assert.deepEqual((await exceptionsOf(full, ana)).slice(-2), [
    { key: "rtp_session", cause: "replaced", live: false, reason: "Back from injury", basis: "team_coach" },
    { key: "compensation_session", cause: "cleared", live: false, reason: null, basis: "club_admin" },
  ], "nothing is deleted: both rows stay, ended");
  assert.equal(await effective(participant), "training_session");

  // The session's type becomes an athlete's exception: that exception ends, and the answer names the athlete.
  assert.equal((await setAthleteType(full, ana, "match", { cookie: team.coach.cookie })).status, 200);
  assert.equal((await setAthleteType(full, team.athleteIds[BEA], "rtp_session", { cookie: team.coach.cookie })).status, 200);
  const changed = await setType(full, "match", { cookie: team.coach.cookie });
  assert.deepEqual(changed.body.endedExceptionAthleteIds, [ana]);
  assert.deepEqual((await exceptionsOf(full, ana)).at(-1), { key: "match", cause: "same_as_session", live: false, reason: null, basis: "team_coach" });
  assert.equal((await exceptionsOf(full, team.athleteIds[BEA])).at(-1).live, true, "another athlete's different exception stays");

  // No record in the session: Dan was not in the target's recording; Eva has no GPEXE record at all.
  const before = await counts();
  for (const athleteId of [team.athleteIds[DAN], team.athleteIds[EVA], crypto.randomUUID()]) {
    const r = await setAthleteType(target, athleteId, "rtp_session", { cookie: team.coach.cookie });
    assert.deepEqual([r.status, r.body.error], [409, "athlete_has_no_record"]);
  }
  assert.equal((await setAthleteType(target, "not-a-uuid", "rtp_session", { cookie: team.coach.cookie })).status, 404);
  assert.deepEqual(await counts(), before);
  await reset(team, full);
});

test("4. the database guards, whoever writes: the acting user and the decider's right, the type offered and not the session's, an exception only ends, nothing is deleted", async () => {
  const { team, full } = await theWorld();
  await reset(team, full);
  const participant = await participantOf(full, team.athleteIds[CIL]);
  const stranger = await makeUser("stranger");
  const insert = (c, { user = team.coach.id, basis = "team_coach", type = "rtp_session" } = {}) => c.query(
    `insert into training.participant_activity_types (participant_id, activity_type_key, set_by_user_id, set_by_basis) values ($1, $2, $3, $4) returning id`, [participant, type, user, basis]);
  await raw(async (c) => {
    assert.match(await refusal(insert(c)), /^42501 session type: no acting user/);
    const attempt = async (expect, actor, options) => {
      await c.query("begin");
      await asActor(c, actor);
      assert.match(await refusal(insert(c, options)), expect);
      await c.query("rollback");
    };
    await attempt(/^42501 /, stranger, { user: stranger });
    await attempt(/^42501 .*names the acting user/, team.coach.id, { user: stranger });
    await attempt(/^42501 /, team.coach.id, { basis: "club_admin" });
    await attempt(/^23514 participant_type_same_as_session$/, team.coach.id, { type: "training_session" });
    await attempt(/^23514 participant_type_not_offered$/, team.coach.id, { type: "testing_session" });
    await attempt(/^23514 participant_type_not_offered$/, team.coach.id, { type: "c_0000beef_gym" });

    // A valid row, then: a second live one, a change, an end without the user, a merge-style end outside a merge, a delete.
    await c.query("begin");
    await asActor(c, team.coach.id);
    const id = (await insert(c)).rows[0].id;
    await c.query("commit");
    const again = async (expect, sql, params = [id], actor = team.coach.id) => {
      await c.query("begin");
      if (actor) await asActor(c, actor);
      assert.match(await refusal(c.query(sql, params)), expect, sql);
      await c.query("rollback");
    };
    await c.query("begin");
    await asActor(c, team.coach.id);
    assert.match(await refusal(insert(c, { type: "match" })), /^23505 /, "one live exception per participant");
    await c.query("rollback");
    await again(/^23514 .*only ever ends/, `update training.participant_activity_types set activity_type_key = 'match' where id = $1`);
    await again(/^23514 .*only ever ends/, `update training.participant_activity_types set reason = 'changed' where id = $1`);
    await again(/^42501 .*names the acting user/, `update training.participant_activity_types set ended_at = now(), ended_by_user_id = $2, end_cause = 'cleared' where id = $1`, [id, stranger]);
    await again(/^42501 .*may not decide/, `update training.participant_activity_types set ended_at = now(), ended_by_user_id = $2, end_cause = 'cleared' where id = $1`, [id, stranger], stranger);
    await again(/^42501 .*only a merge or a reparent/, `update training.participant_activity_types set ended_at = now(), end_cause = 'merge' where id = $1`);
    await again(/^23514 .*never deleted/, `delete from training.participant_activity_types where id = $1`);
    await again(/^23514 .*never truncated/, `truncate training.participant_activity_types`, []);
    await again(/^23514 .*append-only/, `update training.activity_type_requests set reason = 'x'`, []);
    await again(/^23514 .*append-only/, `delete from training.activity_type_requests`, []);
    await again(/^23514 .*never deleted/, `delete from training.activity_field_correction_log`, []);
    // A participant never goes while it holds an exception (a foreign key of its own, or the exception's delete guard).
    await again(/^23(503|514) /, `delete from training.activity_participants where id = $1`, [participant], null);

    // A request row: the acting user, on the claimed basis.
    const request = (user, basis) => c.query(
      `insert into training.activity_type_requests (activity_id, operation, old_type_key, new_type_key, performed_by_user_id, basis, request_key, request_hash, result)
       values ($1, 'session_type', 'training_session', 'match', $2, $3, gen_random_uuid(), $4, '{}')`, [full.activityId, user, basis, "a".repeat(64)]);
    await c.query("begin");
    await asActor(c, stranger);
    assert.match(await refusal(request(stranger, "team_coach")), /^42501 /);
    await c.query("rollback");
    await c.query("begin");
    await asActor(c, team.coach.id);
    assert.match(await refusal(request(team.coach.id, "platform_admin")), /^42501 /);
    await c.query("rollback");

    // An ended exception never changes again; an archive of the type waits for an exception write in flight.
    await c.query("begin");
    await asActor(c, team.coach.id);
    await c.query(`update training.participant_activity_types set ended_at = now(), ended_by_user_id = $2, end_cause = 'cleared' where id = $1`, [id, team.coach.id]);
    await c.query("commit");
    await again(/^23514 .*ends once/, `update training.participant_activity_types set ended_at = now(), ended_by_user_id = $2, end_cause = 'cleared' where id = $1`, [id, team.coach.id]);
    await c.query("begin");
    await asActor(c, team.coach.id);
    await insert(c, { type: "compensation_session" });
    await raw(async (other) => {
      assert.match(await refusal(other.query(`select 1 from training.activity_types where key = 'compensation_session' for update nowait`)), /^55P03 /, "the type row is held FOR SHARE by the write in flight");
    });
    await c.query("rollback");
  });
  assert.deepEqual(await exceptionsOf(full, team.athleteIds[CIL]), [{ key: "rtp_session", cause: "cleared", live: false, reason: null, basis: "team_coach" }]);
});

// ---------------------------------------------------------------------------
// Merge and reparent
// ---------------------------------------------------------------------------
// A hand-made team session of the same team with one or two participants (no metric link, so a reparent may move them).
async function manualSession(team, athleteIds, day = "2026-09-20") {
  const activityId = String((await q(
    `insert into training.activities (activity_type_key, occurred_local_date, timezone_snapshot, owner_scope, owner_team_id, origin, lifecycle_state)
     values ('training_session', $2, 'UTC', 'team', $1, 'manual', 'confirmed') returning id`, [team.teamId, day]))[0].id);
  const participants = [];
  for (const athleteId of athleteIds) {
    participants.push((await q(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot) values ($1, $2, $3, 'UTC') returning id`, [activityId, athleteId, day]))[0].id);
  }
  return { activityId, participants };
}

test("5. a merge ends the merged participant's exception and the canonical one keeps its own; a reparent ends the exception; the roster names what was ended", async () => {
  const { team } = await theWorld();
  const [ana, bea, cil] = team.athleteIds;
  // Merge: Ana in two sessions, an exception in each; Bea keeps the source session alive.
  const a = await manualSession(team, [ana, bea]);
  const b = await manualSession(team, [ana, cil]);
  assert.equal((await setAthleteType(a, ana, "rtp_session", { cookie: team.coach.cookie })).status, 200);
  assert.equal((await setAthleteType(b, ana, "compensation_session", { cookie: team.coach.cookie })).status, 200);
  await q(`select training.merge_activity_participants($1, $2, $3, 'the same session')`, [a.participants[0], b.participants[0], team.coach.id]);
  const rows = await q(`select participant_id, activity_type_key as key, end_cause as cause, ended_by_user_id as by, ended_at is null as live
                          from training.participant_activity_types where participant_id = any($1::uuid[]) order by set_at`, [[a.participants[0], b.participants[0]]]);
  assert.deepEqual(rows, [
    { participant_id: a.participants[0], key: "rtp_session", cause: "merge", by: team.coach.id, live: false },
    { participant_id: b.participants[0], key: "compensation_session", cause: null, by: null, live: true },
  ]);
  assert.equal(await effective(a.participants[0]), "compensation_session", "the merged participant resolves to the canonical one's type");
  // A merge whose canonical participant has no exception: the merged one's still ends, and the type is the session's.
  const c1 = await manualSession(team, [ana, bea]);
  const c2 = await manualSession(team, [ana, cil]);
  assert.equal((await setAthleteType(c1, ana, "rtp_session", { cookie: team.coach.cookie })).status, 200);
  await q(`select training.merge_activity_participants($1, $2, $3, 'again')`, [c1.participants[0], c2.participants[0], team.coach.id]);
  assert.equal(await effective(c1.participants[0]), "training_session");
  assert.equal((await q(`select end_cause from training.participant_activity_types where participant_id = $1`, [c1.participants[0]]))[0].end_cause, "merge");

  // Reparent: Bea moves from one session to another; her exception belonged to the session she left.
  const from = await manualSession(team, [bea, cil]);
  const to = await manualSession(team, [ana]);
  assert.equal((await setAthleteType(from, bea, "rtp_session", { cookie: team.coach.cookie })).status, 200);
  await q(`select training.reparent_activity_participant($1, $2, $3, 'wrong session')`, [from.participants[0], to.activityId, team.coach.id]);
  assert.deepEqual(await q(`select activity_type_key as key, end_cause as cause, ended_at is null as live from training.participant_activity_types where participant_id = $1`, [from.participants[0]]),
    [{ key: "rtp_session", cause: "reparent", live: false }]);
  const row = await rosterAthlete(team, to, bea);
  assert.equal(row.sessionType.effectiveKey, "training_session");
  assert.equal(row.sessionType.exception, null);
  assert.deepEqual({ ...row.sessionType.endedException, endedAt: null }, { activityTypeKey: "rtp_session", cause: "reparent", endedAt: null }, "the roster says an exception was ended under the coach");
  // A new exception can be set in the new session, and the mark goes.
  assert.equal((await setAthleteType(to, bea, "rtp_session", { cookie: team.coach.cookie })).status, 200);
  assert.equal((await rosterAthlete(team, to, bea)).sessionType.endedException, null);
});

test("6. a merge against an exception write on the same participant, started in both orders: one consistent state, no deadlock; the write's recorded lock order", async () => {
  const { team } = await theWorld();
  const [ana, bea, cil] = team.athleteIds;
  const live = async (participantId) => (await q(`select count(*)::int as n from training.participant_activity_types where participant_id = $1 and ended_at is null`, [participantId]))[0].n;

  // Order 1: the merge holds its locks first; the exception write waits, then meets the merged state.
  {
    const a = await manualSession(team, [ana, bea]);
    const b = await manualSession(team, [ana, cil]);
    let write;
    await raw(async (c) => {
      await c.query("begin");
      await c.query(`select training.merge_activity_participants($1, $2, $3, 'order 1')`, [a.participants[0], b.participants[0], team.coach.id]);
      write = setAthleteType(a, ana, "rtp_session", { cookie: team.coach.cookie });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await c.query("commit");
    });
    const r = await write;
    assert.deepEqual([r.status, r.body.error], [409, "athlete_has_no_record"], r.text);
    assert.equal(await live(a.participants[0]), 0, "no exception on the merged participant");
  }
  // Order 2: the exception write holds its locks (paused before its COMMIT); the merge waits, then ends the exception.
  {
    const a = await manualSession(team, [ana, bea]);
    const b = await manualSession(team, [ana, cil]);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let reached;
    const atCommit = new Promise((resolve) => { reached = resolve; });
    typeService.setTypeChangeTestHooks({ beforeCommit: async () => { reached(); await held; } });
    const write = setAthleteType(a, ana, "rtp_session", { cookie: team.coach.cookie });
    await atCommit;
    typeService.setTypeChangeTestHooks(null);
    const merge = raw((c) => c.query(`select training.merge_activity_participants($1, $2, $3, 'order 2')`, [a.participants[0], b.participants[0], team.coach.id]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    assert.equal((await write).status, 200);
    await merge;
    assert.deepEqual(await q(`select activity_type_key as key, end_cause as cause from training.participant_activity_types where participant_id = $1`, [a.participants[0]]),
      [{ key: "rtp_session", cause: "merge" }], "the write committed, then the merge ended it");
  }
  // A session merged away entirely: the write answers the current id, and writes nothing.
  {
    const a = await manualSession(team, [ana]);
    const b = await manualSession(team, [ana, cil]);
    await q(`select training.merge_activity_participants($1, $2, $3, 'whole session')`, [a.participants[0], b.participants[0], team.coach.id]);
    const r = await setAthleteType(a, ana, "rtp_session", { cookie: team.coach.cookie });
    assert.deepEqual([r.status, r.body.error, r.body.canonicalActivityId], [409, "activity_superseded", b.activityId]);
    const s = await setType(a, "match", { cookie: team.coach.cookie });
    assert.deepEqual([s.status, s.body.error, s.body.canonicalActivityId], [409, "activity_superseded", b.activityId]);
  }

  // The recorded order of an exception write that replaces a live one: the rights, the request key, the activity, the
  // participant, the exception row, the end, the new row, the request row.
  const s = await manualSession(team, [bea, cil]);
  assert.equal((await setAthleteType(s, bea, "rtp_session", { cookie: team.coach.cookie })).status, 200);
  const seen = [];
  typeService.setTypeChangeTestHooks({
    beforeLocks: ({ client }) => {
      const original = client.query.bind(client);
      client.query = (...args) => {
        seen.push(typeof args[0] === "string" ? args[0] : args[0]?.text ?? "");
        return original(...args);
      };
    },
  });
  try {
    assert.equal((await setAthleteType(s, bea, "compensation_session", { cookie: team.coach.cookie })).status, 200);
  } finally {
    typeService.setTypeChangeTestHooks(null);
  }
  const at = (pattern) => {
    const i = seen.findIndex((sql) => pattern.test(sql));
    assert.ok(i >= 0, `${pattern} was sent:\n${seen.join("\n---\n")}`);
    return i;
  };
  const order = [
    at(/training\.lock_activity_decider/), at(/pg_advisory_xact_lock/), at(/from training\.activity_type_requests where performed_by_user_id/),
    at(/from training\.activities where id = \$1 for update/), at(/from training\.activity_participants where activity_id = \$1 and athlete_id = \$2 .* for update/s),
    at(/from training\.participant_activity_types where participant_id = \$1 and ended_at is null for update/), at(/update training\.participant_activity_types set ended_at/),
    at(/insert into training\.participant_activity_types/), at(/insert into training\.activity_type_requests/), at(/set constraints all immediate/),
  ];
  assert.deepEqual(order, [...order].sort((x, y) => x - y), `the locks are taken in the stated order: ${order.join(", ")}`);
});

// ---------------------------------------------------------------------------
// The estimates
// ---------------------------------------------------------------------------
test("7. Own average counts a past session only when the athlete's effective type there is comparable: the session's type, the athlete's exception, and D7 in one direction only", async () => {
  const { team, past, target, distance } = await theWorld();
  await reset(team, target, ...past);
  const dan = team.athleteIds[DAN];
  const own = async () => {
    const r = await proposal(team, target, dan);
    assert.equal(r.status, 200, r.text);
    return r.body.methods.proportional;
  };
  let p = await own();
  assert.equal(p.values.find((v) => v.metricDefinitionId === distance).basis.sessions, 3);
  assert.deepEqual(p.comparesWith, { key: "training_session", label: "Full training", types: [{ key: "training_session", label: "Full training" }] });

  // One past session corrected to another type leaves the average (a correction fixes the record).
  assert.equal((await setType(past[0], "rtp_session", { cookie: team.coach.cookie })).status, 200);
  assert.deepEqual([(await own()).available, (await own()).reason], [false, "too_few_sessions"]);
  // Dan's own exception in that session brings it back; another athlete's exception there changes nothing for Dan.
  assert.equal((await setAthleteType(past[0], dan, "training_session", { cookie: team.coach.cookie })).status, 200);
  assert.equal((await own()).available, true, "the athlete's exception in the past session counts");
  await reset(team, past[0]);
  assert.equal((await setAthleteType(past[1], dan, "rtp_session", { cookie: team.coach.cookie })).status, 200);
  assert.equal((await own()).reason, "too_few_sessions", "an exception in a past session takes it out");
  await reset(team, past[1]);
  assert.equal((await setAthleteType(past[1], team.athleteIds[ANA], "rtp_session", { cookie: team.coach.cookie })).status, 200);
  assert.equal((await own()).available, true);
  await reset(team, past[1]);

  // D7: a friendly counts friendlies and games; a game counts only games.
  assert.equal((await setType(target, "friendly_match", { cookie: team.coach.cookie })).status, 200);
  assert.equal((await own()).reason, "too_few_sessions", "a friendly does not count trainings");
  assert.equal((await setType(past[0], "match", { cookie: team.coach.cookie })).status, 200);
  assert.equal((await setType(past[1], "match", { cookie: team.coach.cookie })).status, 200);
  assert.equal((await setType(past[2], "friendly_match", { cookie: team.coach.cookie })).status, 200);
  p = await own();
  assert.equal(p.values.find((v) => v.metricDefinitionId === distance).basis.sessions, 3, "two games and a friendly count toward a friendly");
  assert.deepEqual(p.comparesWith, { key: "friendly_match", label: "Friendly game", types: [{ key: "friendly_match", label: "Friendly game" }, { key: "match", label: "Game" }] });
  assert.equal((await setType(target, "match", { cookie: team.coach.cookie })).status, 200);
  p = await own();
  assert.deepEqual([p.available, p.reason], [false, "too_few_sessions"], "a game counts only games: two, not the friendly");
  assert.deepEqual(p.comparesWith.types, [{ key: "match", label: "Game" }]);
  // The save computes what the proposal shows.
  const refused = await tapi(`/${target.activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), athleteId: dan, method: "proportional", minutes: 30 } });
  assert.deepEqual([refused.status, refused.body.error], [409, "nothing_to_estimate"]);
  await reset(team, target, ...past);
});

test("8. Team average and Copy take only athletes of the target's effective type; a saved estimate keeps its value and is marked once the athlete's type changed", async () => {
  const { team, target, distance } = await theWorld();
  await reset(team, target);
  const [ana, bea, cil, dan] = team.athleteIds;
  const estimatesOf = async () => (await q(`select count(*)::int as n from training_load.metric_value_estimates`))[0].n;
  let r = await proposal(team, target, dan);
  assert.equal(r.body.methods.team_average.values.find((v) => v.metricDefinitionId === distance).basis.athletes, 3);
  assert.deepEqual(r.body.methods.copy_athlete.otherTypeSources, []);

  // Bea did RTP in this session: two athletes of Dan's type are left.
  assert.equal((await setAthleteType(target, bea, "rtp_session", { cookie: team.coach.cookie })).status, 200);
  r = await proposal(team, target, dan, `&sourceAthleteId=${bea}`);
  assert.deepEqual([r.body.methods.team_average.available, r.body.methods.team_average.reason], [false, "too_few_same_type"]);
  assert.deepEqual(r.body.methods.copy_athlete.sources.map((s) => s.name).sort(), ["Ana", "Cil"]);
  assert.deepEqual(r.body.methods.copy_athlete.otherTypeSources, [{ athleteId: bea, name: "Bea", activityTypeKey: "rtp_session", activityTypeLabel: "RTP" }]);
  assert.deepEqual([r.body.methods.copy_athlete.available, r.body.methods.copy_athlete.reason], [false, "source_type_differs"]);
  const before = await estimatesOf();
  const save = (body) => tapi(`/${target.activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), athleteId: dan, ...body } });
  const copy = await save({ method: "copy_athlete", sourceAthleteId: bea });
  assert.deepEqual([copy.status, copy.body.error], [409, "source_type_differs"]);
  const average = await save({ method: "team_average" });
  assert.deepEqual([average.status, average.body.error, average.body.reasons], [409, "nothing_to_estimate", ["too_few_same_type"]]);
  assert.equal(await estimatesOf(), before, "a refused save wrote nothing");

  // With Bea back, the estimate is saved; then Dan's own type changes: the value stays, the mark says what it was.
  await reset(team, target);
  const saved = await save({ method: "team_average" });
  assert.equal(saved.status, 201, saved.text);
  const value = saved.body.estimates.find((e) => e.metricDefinitionId === distance).value;
  const danValues = async () => (await rosterAthlete(team, target, dan)).values.filter((v) => v.entryMethod === "estimate");
  assert.ok((await danValues()).length > 0 && (await danValues()).every((v) => v.estimate.calculatedWhenType === undefined), "no mark while the type is the one it was saved under");
  assert.equal((await setAthleteType(target, dan, "rtp_session", { cookie: team.coach.cookie })).status, 200, "Dan has a record now (the estimate), so an exception");
  let marked = await danValues();
  assert.ok(marked.every((v) => JSON.stringify(v.estimate.calculatedWhenType) === JSON.stringify({ key: "training_session", label: "Full training" })), JSON.stringify(marked));
  assert.equal((await q(`select v.value_numeric::float8 as value from training_load.metric_value_estimates e join training_load.metric_values v on v.id = e.metric_value_id
                          join training_load.metric_measurement_occasions o on o.id = e.occasion_id where v.metric_definition_id = $1 and o.superseded_by_occasion_id is null`, [distance]))[0].value, value, "the saved value is not recalculated");
  // The panel now works with Dan's own type: nobody else did RTP here.
  r = await proposal(team, target, dan);
  assert.equal(r.body.methods.proportional.comparesWith.key, "rtp_session");
  assert.deepEqual(r.body.methods.copy_athlete.sources, []);
  assert.deepEqual(r.body.methods.copy_athlete.otherTypeSources.map((s) => s.name).sort(), ["Ana", "Bea", "Cil"]);
  // Cleared: the type is again the one the estimate was saved under, and the mark goes.
  assert.equal((await setAthleteType(target, dan, null, { cookie: team.coach.cookie })).status, 200);
  assert.ok((await danValues()).every((v) => v.estimate.calculatedWhenType === undefined));
  // The session's type changes: every estimate saved before is marked; one saved after is not.
  assert.equal((await setType(target, "match", { cookie: team.coach.cookie })).status, 200);
  marked = await danValues();
  assert.ok(marked.every((v) => v.estimate.calculatedWhenType?.key === "training_session"), JSON.stringify(marked));
  assert.equal((await save({ method: "team_average" })).status, 201);
  assert.ok((await danValues()).every((v) => v.estimate.calculatedWhenType === undefined), "a new estimate under the new type carries no mark");
  assert.ok(ana && cil);
});

// ---------------------------------------------------------------------------
// The COMMIT outcome and the undo
// ---------------------------------------------------------------------------
test("9. the COMMIT outcome: an answer lost after a commit is found by its key (200); one that did not commit is 503 outcome_unknown, nothing written, and the same key writes once later", async () => {
  const { team, full } = await theWorld();
  await reset(team, full);
  const k1 = key();
  typeService.setTypeChangeTestHooks({ commit: async (client) => { await client.query("commit"); throw new Error("answer lost"); } });
  let r;
  try {
    r = await setType(full, "match", { cookie: team.coach.cookie, requestKey: k1 });
  } finally {
    typeService.setTypeChangeTestHooks(null);
  }
  assert.deepEqual([r.status, r.body.activityTypeKey, r.body.changed], [200, "match", true], r.text);
  assert.equal(await sessionType(full), "match");

  const k2 = key();
  const before = await counts();
  typeService.setTypeChangeTestHooks({ commit: async (client) => { await client.query("rollback"); throw new Error("answer lost"); } });
  try {
    r = await setAthleteType(full, team.athleteIds[ANA], "rtp_session", { cookie: team.coach.cookie, requestKey: k2 });
  } finally {
    typeService.setTypeChangeTestHooks(null);
  }
  assert.deepEqual([r.status, r.body.error], [503, "outcome_unknown"], r.text);
  assert.deepEqual(await counts(), before, "nothing was written");
  r = await setAthleteType(full, team.athleteIds[ANA], "rtp_session", { cookie: team.coach.cookie, requestKey: k2 });
  assert.deepEqual([r.status, r.body.changed], [200, true]);
  const again = await setAthleteType(full, team.athleteIds[ANA], "rtp_session", { cookie: team.coach.cookie, requestKey: k2 });
  assert.deepEqual(again.body, r.body, "the same key replays");
  assert.deepEqual(await counts(), { ...before, exceptions: before.exceptions + 1, requests: before.requests + 1 });
  await reset(team, full);
});

test("10. the undo of an imported session whose type was changed and that holds an exception: not blocked; the session's type history and exceptions go with it", async () => {
  const { team } = await theWorld();
  const s = await importSession(team, bundleOf({ sessionId: 9830, hour: 14, ids: [101, 102, 104] }));
  assert.equal((await setType(s, "match", { cookie: team.coach.cookie })).status, 200);
  assert.equal((await setAthleteType(s, team.athleteIds[ANA], "rtp_session", { cookie: team.coach.cookie })).status, 200);
  const rowsOf = async () => (await q(
    `select (select count(*) from training.activity_type_requests where activity_id = $1)::int as requests,
            (select count(*) from training.activity_field_correction_log where activity_id = $1)::int as corrections,
            (select count(*) from training.participant_activity_types x join training.activity_participants ap on ap.id = x.participant_id where ap.activity_id = $1)::int as exceptions`, [s.activityId]))[0];
  assert.deepEqual(await rowsOf(), { requests: 2, corrections: 1, exceptions: 1 });
  const u = await api(`/teams/${team.teamId}/candidates/${s.candidateId}/undo-import`, {
    method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "wrong athlete link", expected: { eventId: s.eventId } },
  });
  assert.equal(u.status, 200, u.text);
  assert.equal((await q(`select count(*)::int as n from training.activities where id = $1`, [s.activityId]))[0].n, 0);
  assert.deepEqual(await rowsOf(), { requests: 0, corrections: 0, exceptions: 0 });
});

// Central calendar K1a: GET /api/calendar (the read-only, source-neutral
// read) and the club's view of its teams' activities (owner decision D8).
// Plan: docs/ai/central-calendar-k1-plan.md.
//
// Everything runs on ONE disposable database (optimove_tests_gpexe_calendar_*):
// the GPEXE legacy scaffold, the Tests v42 files (for test schedules), the
// training_load / training files through v44 plus v6 (event_type) and v8
// ('dates' schedules), through the real runner; dropped at the end. Nothing
// touches OPTIMOVE or any persistent database. The real Express app is
// driven over HTTP with real session cookies; an athlete's RPE goes through
// the real POST /api/training-load/sessions/:id/rpe.
//
// Dates are relative to the real UTC day, because `today` (the caller's
// date) may lie at most 2 days from the server's: PAST = today - 2 (a day
// that passed, and still an accepted `today`), FUTURE = today + 1.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes, TZ as GPEXE_TZ } from "./_gpexe-fixtures.mjs";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { importGpexePlan } from "../src/gpexeImportWriter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

// The Tests v42 files the Tests weekly suite applies (phase 3, the
// notification link, needs public.app_notifications and is not needed here).
const TESTS_MIGRATIONS = [
  "202608220900_tests_v42_schema.sql",
  "202608221000_tests_v42_seed_wellness_fms.sql",
  "202608240900_tests_v42_phase1_scheduling_execution.sql",
  "202608250900_tests_v42_presentation_metadata.sql",
  "202608250901_tests_v42_supersede_generated_column_fix.sql",
  "202608260900_tests_v42_occurrence_generation_lock_fix.sql",
  "202608300900_tests_v42_phase4_assignment_timezone_window.sql",
];
// The external-schedule columns the calendar reads that the GPEXE list
// leaves out (v7, the notification rules, needs public.app_notifications
// and is not needed here).
const EXTRA_TRAINING_LOAD_MIGRATIONS = [
  "202609011200_training_load_v6_external_schedule_event_type.sql",
  "202609030900_training_load_v8_specific_dates_group.sql",
];
const MIGRATIONS = [...TESTS_MIGRATIONS, ...GPEXE_TEST_MIGRATIONS, ...EXTRA_TRAINING_LOAD_MIGRATIONS].sort();
const WELLNESS_TEST_VERSION_ID = "7a386bd1-d25e-4651-9012-e76d9dc32559";

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const TODAY = new Date().toISOString().slice(0, 10);
const PAST = addDays(TODAY, -2);
const FUTURE = addDays(TODAY, 1);
const FROM = addDays(TODAY, -7);
const TO = addDays(TODAY, 7);
const GPEXE_DAY = "2026-09-14";

let db;
let admin;
let server;
let apiBase;
let appPool;
let createSession;
let materialize;

const uid = () => crypto.randomBytes(4).toString("hex");
async function q(sql, params = []) {
  return (await admin.query(sql, params)).rows;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function makeClub(label = "Club") {
  return (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} ${uid()}`]))[0].id;
}
async function makeTeam(clubId, label = "Team") {
  return (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} ${uid()}`]))[0].id;
}
async function makeUser(label) {
  return (await q(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${uid()}@test.local`, label]))[0].id;
}
async function setWorkspace(userId, type, scopeId) {
  await q(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [userId, type, scopeId],
  );
}
async function withCookie(id) {
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}
async function coachOf(teamId, label = "coach") {
  const id = await makeUser(label);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return withCookie(id);
}
async function clubAdminOf(clubId, label = "club admin") {
  const id = await makeUser(label);
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await setWorkspace(id, "club", clubId);
  return withCookie(id);
}
async function platformAdmin(label = "platform admin") {
  const id = await makeUser(label);
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return withCookie(id);
}
async function privateCoach(label = "private coach") {
  const id = await makeUser(label);
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [id]);
  await setWorkspace(id, "private_coach", null);
  return withCookie(id);
}
async function addMembership({ athleteId, clubId, teamId = null, type = teamId ? "team" : "club", startsAt = "2026-01-01T00:00:00Z" }) {
  await q(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,$4,'active',$5)`,
    [athleteId, clubId, teamId, type, startsAt],
  );
}
// An athlete with an account (athlete workspace) and, when a team is given,
// an active club and team membership since 2026-01-01.
async function makeAthlete(name, { clubId = null, teamId = null, tz = "UTC" } = {}) {
  const userId = await makeUser(name);
  const athleteId = (await q(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,$2,$2,$3) returning id`, [userId, name, tz]))[0].id;
  if (clubId) await addMembership({ athleteId, clubId, type: "club" });
  if (clubId && teamId) await addMembership({ athleteId, clubId, teamId });
  await setWorkspace(userId, "athlete", null);
  return { name, userId, athleteId, ...(await withCookie(userId)) };
}
function ownerColumns(owner) {
  return {
    owner_scope: owner.scope,
    owner_user_id: owner.scope === "user" ? owner.userId : null,
    owner_club_id: owner.scope === "club" ? owner.clubId : null,
    owner_team_id: owner.scope === "team" ? owner.teamId : null,
  };
}
async function makePlan({ athleteId, coachUserId, owner, batchId = null, weekStart = FROM }) {
  const planId = (await q(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, week_start, is_active, is_edit_draft, builder_batch_id)
     values ('weekly',$1,$2,'Week',$3,$4,true,false,$5) returning id`,
    [coachUserId, athleteId, "active", weekStart, batchId],
  ))[0].id;
  const o = ownerColumns(owner);
  await q(
    `insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_user_id, owner_club_id, owner_team_id) values ($1,$2,$3,$4,$5)`,
    [planId, o.owner_scope, o.owner_user_id, o.owner_club_id, o.owner_team_id],
  );
  return planId;
}
async function makeSession({ planId, date, name = "Team training", amPm = "PM", bta = "T", order = 1, time = "18:00", rpeEnabled = true, tlEnabled = true }) {
  const dayId = (await q(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [planId, date]))[0].id;
  const logicalSessionId = crypto.randomUUID();
  const sessionId = (await q(
    `insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order, session_time, rpe_enabled, training_load_enabled, logical_session_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [dayId, name, amPm, bta, order, time, rpeEnabled, tlEnabled, logicalSessionId],
  ))[0].id;
  return { sessionId, logicalSessionId, dayId };
}
async function enablePlannedRpe(owner) {
  const o = ownerColumns(owner);
  await q(
    `insert into training_load.planned_rpe_workspace_settings (owner_scope, owner_user_id, owner_club_id, owner_team_id, enabled, enabled_at) values ($1,$2,$3,$4,true,'2000-01-01T00:00:00Z')`,
    [o.owner_scope, o.owner_user_id, o.owner_club_id, o.owner_team_id],
  );
}
// A team with a coach, planned RPE on, and n athletes each with an account
// and one planned session on `date` from one Builder batch.
async function teamWithBatch(label, { n = 3, date = PAST, rpeEnabled = true, withRpeSetting = true, clubId = null } = {}) {
  const club = clubId || await makeClub(`${label} club`);
  const teamId = await makeTeam(club, label);
  const coach = await coachOf(teamId, `${label} coach`);
  if (withRpeSetting) await enablePlannedRpe({ scope: "team", teamId });
  const batchId = crypto.randomUUID();
  const athletes = [];
  for (let i = 0; i < n; i += 1) {
    const athlete = await makeAthlete(`${label} ${String.fromCharCode(65 + i)}`, { clubId: club, teamId });
    const planId = await makePlan({ athleteId: athlete.athleteId, coachUserId: coach.id, owner: { scope: "team", teamId }, batchId });
    const session = await makeSession({ planId, date, rpeEnabled });
    athletes.push({ ...athlete, planId, ...session });
  }
  return { clubId: club, teamId, coach, athletes, batchId, date };
}
async function submitRpe(athlete, { rpe = 7, durationMinutes = 75 } = {}) {
  const res = await api(`/api/training-load/sessions/${athlete.sessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe, durationMinutes } });
  assert.equal(res.status, 201, res.text);
  return (await q(
    `select a.id, a.owner_scope, a.origin
       from training.activity_participant_session_links l
       join training.activity_participants ap on ap.id = l.activity_participant_id
       join training.activities a on a.id = ap.activity_id
      where l.logical_session_id = $1 and l.link_status = 'confirmed'`,
    [athlete.logicalSessionId],
  ))[0];
}
async function makeActivity({ owner, origin = "manual", name = "Session", date = PAST, startedAt = `${date}T16:00:00Z`, tz = "UTC" }) {
  const o = ownerColumns(owner);
  return (await q(
    `insert into training.activities (name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_user_id, owner_club_id, owner_team_id, origin, lifecycle_state)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed') returning id`,
    [name, date, startedAt, tz, o.owner_scope, o.owner_user_id, o.owner_club_id, o.owner_team_id, origin],
  ))[0].id;
}
async function addParticipant(activityId, athleteId, date = PAST, tz = "UTC") {
  return (await q(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,$3,$4,'participated') returning id`,
    [activityId, athleteId, date, tz],
  ))[0].id;
}
async function makeExternalSchedule({ owner, createdBy, kind = "one_time", startDate = PAST, endDate = null, recurrence = null, eventName = "Away match", status = "active", targets = [] }) {
  const o = ownerColumns(owner);
  const id = (await q(
    `insert into training_load.external_schedules (schedule_kind, timezone, start_date, end_date, recurrence_rule, opens_time, closes_time, status, event_name, event_type, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ($1,'UTC',$2,$3,$4,'17:00','23:59',$5,$6,'match',$7,$8,$9,$10,$11) returning id`,
    [kind, startDate, endDate, recurrence ? JSON.stringify(recurrence) : null, status, eventName, createdBy, o.owner_scope, o.owner_user_id, o.owner_club_id, o.owner_team_id],
  ))[0].id;
  for (const t of targets) {
    await q(
      `insert into training_load.external_schedule_targets (schedule_id, target_kind, target_athlete_id, target_team_id, target_club_id) values ($1,$2,$3,$4,$5)`,
      [id, t.kind, t.kind === "athlete" ? t.id : null, t.kind === "team" ? t.id : null, t.kind === "club" ? t.id : null],
    );
  }
  return id;
}
async function makeExternalOccurrence(scheduleId, date, status = "closed") {
  return (await q(
    `insert into training_load.external_schedule_occurrences (schedule_id, scheduled_date, opens_at, closes_at, status) values ($1,$2,$3,$4,$5) returning id`,
    [scheduleId, date, `${date}T17:00:00Z`, `${date}T23:59:00Z`, status],
  ))[0].id;
}
async function makeExternalAssignment(occurrenceId, athleteId, date, status = "pending") {
  // v4's checks: a completed assignment carries completed_at (and may carry started_at).
  const completedAt = status === "completed" ? `${date}T18:30:00Z` : null;
  return (await q(
    `insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at, status, started_at, completed_at)
     values ($1,$2,'UTC',$3,$4,$5,$6,$7,$7) returning id`,
    [occurrenceId, athleteId, date, `${date}T17:00:00Z`, `${date}T23:59:00Z`, status, completedAt],
  ))[0].id;
}
async function externalFeedback(athleteId, assignmentId, date) {
  await q(
    `insert into training_load.session_feedback (athlete_id, session_date, external_assignment_id, source, event_name, rpe, duration_minutes) values ($1,$2,$3,'scheduled_external','Away match',6,60)`,
    [athleteId, date, assignmentId],
  );
}
async function makeTestSchedule({ owner, createdBy, kind = "one_time", startDate = PAST, endDate = null, recurrence = null, status = "active", targets = [] }) {
  const o = ownerColumns(owner);
  const id = (await q(
    `insert into tests.test_schedules (test_version_id, schedule_kind, timezone, start_date, end_date, recurrence_rule, opens_time, closes_time, status, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ($1,$2,'UTC',$3,$4,$5,'07:00','09:00',$6,$7,$8,$9,$10,$11) returning id`,
    [WELLNESS_TEST_VERSION_ID, kind, startDate, endDate, recurrence ? JSON.stringify(recurrence) : null, status, createdBy, o.owner_scope, o.owner_user_id, o.owner_club_id, o.owner_team_id],
  ))[0].id;
  for (const t of targets) {
    await q(
      `insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id, target_team_id, target_club_id) values ($1,$2,$3,$4,$5)`,
      [id, t.kind, t.kind === "athlete" ? t.id : null, t.kind === "team" ? t.id : null, t.kind === "club" ? t.id : null],
    );
  }
  return id;
}
async function makeTestOccurrence(scheduleId, date, status = "closed") {
  return (await q(
    `insert into tests.test_schedule_occurrences (schedule_id, scheduled_date, opens_at, closes_at, status, snapshot_test_version_id) values ($1,$2,$3,$4,$5,$6) returning id`,
    [scheduleId, date, `${date}T07:00:00Z`, `${date}T09:00:00Z`, status, WELLNESS_TEST_VERSION_ID],
  ))[0].id;
}
async function makeTestAssignment(occurrenceId, athleteId, date, status = "pending") {
  return (await q(
    `insert into tests.test_assignments (occurrence_id, athlete_id, snapshot_test_version_id, status, timezone, local_scheduled_date, opens_at, closes_at, completed_at)
     values ($1,$2,$3,$4,'UTC',$5,$6,$7,$8) returning id`,
    [occurrenceId, athleteId, WELLNESS_TEST_VERSION_ID, status, date, `${date}T07:00:00Z`, `${date}T09:00:00Z`, status === "completed" ? `${date}T08:00:00Z` : null],
  ))[0].id;
}

// GPEXE: a team with athletes 101-103 as OptiMove athletes (Sarajevo time,
// members since 2026-01-01) and the writer's direct import of one session of
// 2026-09-14 (the roster suite's fixture).
async function gpexeTeam(label = "GPEXE") {
  const clubId = await makeClub(`${label} club`);
  const teamId = await makeTeam(clubId, label);
  const ids = {};
  const members = {};
  for (const g of [101, 102, 103]) {
    const athlete = await makeAthlete(`${label} ${g}`, { clubId, teamId, tz: GPEXE_TZ });
    ids[g] = athlete.athleteId;
    members[g] = athlete;
  }
  const userId = await makeUser(`${label} importer`);
  return { clubId, teamId, ids, members, userId };
}
function bundleFor(sessionId) {
  const athletes = standardAthletes().map((a) => {
    const copy = structuredClone(a);
    copy.tracks = copy.tracks.map((t, i) => sessionId * 10 + (copy.id - 100) * 2 + i);
    copy.parts = copy.parts.map((p) => {
      const part = { ...p };
      if (part.track !== undefined) part.track = copy.tracks[a.tracks.indexOf(p.track)];
      return part;
    });
    return copy;
  });
  // One track for 103 as well, so every athlete is measured without a manual check.
  const a103 = athletes.find((a) => a.id === 103);
  a103.tracks = [a103.tracks[0]];
  a103.parts = [{ drill: null, time: 1500, distance: 1700, maxV: 5, power: [1500, 100, 80, 20, 0], acc: 5, dec: 5 }];
  return makeBundle({ sessionId, gpexeTeamId: 77, start: `${GPEXE_DAY}T18:08:12`, athletes, detailsDrills: [0, 1] });
}
async function importDirect(team, bundle) {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    return await importGpexePlan(client, buildGpexeImportPlan(bundle), {
      ownerTeamId: team.teamId, performedByUserId: team.userId, athleteIdByGpexeId: team.ids, batchFilename: "calendar test",
    });
  } finally {
    await client.end();
  }
}
// A roster decision the way 5a2 writes one (decision, then the request row).
async function insertDecision({ activityId, athleteId, teamId, userId, kind = "did_not_participate", reasonKey = "illness" }) {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    await client.query("begin");
    const requestId = crypto.randomUUID();
    await client.query(
      `insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, reason_key, decided_by_user_id, decided_by_basis)
       values ($1,$2,$3,$4,$5,$6,$7,'team_coach')`,
      [activityId, athleteId, teamId, requestId, kind, reasonKey, userId],
    );
    await client.query(
      `insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result)
       values ($1,$2,$3,$4,'decide',$5,'{"ok":true}')`,
      [requestId, activityId, crypto.randomUUID(), "a".repeat(64), userId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function api(pathname, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const calendar = (cookie, { from = FROM, to = TO, extra = "" } = {}) => api(`/api/calendar?from=${from}&to=${to}${extra}`, { cookie });
const itemsOn = (res, date) => (res.body.days?.find((d) => d.date === date) || { items: [] }).items;
const allItems = (res) => (res.body.days || []).flatMap((d) => d.items);
const ofKind = (items, kind) => items.filter((i) => i.kind === kind);
async function rowCounts(tables) {
  const out = {};
  for (const t of tables) out[t] = (await q(`select count(*)::int as n from ${t}`))[0].n;
  return out;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "calendar", migrations: MIGRATIONS });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  // The legacy scaffold carries only the plans.* columns the app reads; the
  // Builder batch column (create_builder_schema.sql) is added here for this
  // suite's own database.
  await admin.query(`alter table plans.plans add column if not exists builder_batch_id uuid`);
  assert.ok((await q(`select to_regproc('training.activity_has_roster') as f`))[0].f, "v44 is applied");
  assert.ok((await q(`select to_regclass('tests.test_schedules') as t`))[0].t, "the Tests schema is applied");

  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  materialize = await import("../src/trainingActivityMaterialize.js");
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app pool is on the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

// ---------------------------------------------------------------------------
// Input and access
// ---------------------------------------------------------------------------
test("1. input: dates, the 62-day cap, today's drift, kinds, include and ids are checked before any read; no login is 401", async () => {
  const { coach } = await teamWithBatch("in", { n: 1 });
  assert.equal((await api(`/api/calendar?from=${FROM}&to=${TO}`)).status, 401);
  assert.equal((await api(`/api/calendar?to=${TO}`, { cookie: coach.cookie })).status, 400, "from missing");
  assert.equal((await api(`/api/calendar?from=2026-02-30&to=${TO}`, { cookie: coach.cookie })).status, 400, "not a real date");
  assert.equal((await calendar(coach.cookie, { from: TO, to: FROM })).status, 400, "to before from");
  assert.equal((await calendar(coach.cookie, { from: FROM, to: addDays(FROM, 62) })).status, 200, "62 days is the cap");
  assert.equal((await calendar(coach.cookie, { from: FROM, to: addDays(FROM, 63) })).status, 400, "63 days is over it");
  assert.equal((await api(`/api/calendar?from=9999-12-01&to=9999-12-31`, { cookie: coach.cookie })).status, 400, "a year outside 2000-2100 is refused, never a 500 from the day walk");
  assert.equal((await api(`/api/calendar?from=1999-12-30&to=2000-01-02`, { cookie: coach.cookie })).status, 400);
  assert.equal((await calendar(coach.cookie, { extra: "&today=nope" })).status, 400);
  assert.equal((await calendar(coach.cookie, { extra: `&today=${addDays(TODAY, 3)}` })).status, 400, "3 days away is refused");
  assert.equal((await calendar(coach.cookie, { extra: `&today=${addDays(TODAY, -2)}` })).status, 200, "2 days away is accepted");
  assert.equal((await calendar(coach.cookie, { extra: "&kinds=planned,meeting" })).status, 400);
  assert.equal((await calendar(coach.cookie, { extra: "&kinds=planned,test" })).status, 200);
  assert.equal((await calendar(coach.cookie, { extra: "&include=everything" })).status, 400);
  assert.equal((await calendar(coach.cookie, { extra: "&teamIds=not-a-uuid" })).status, 400);
  const ok = await calendar(coach.cookie);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.from, FROM);
  assert.equal(ok.body.to, TO);
  assert.equal(ok.body.today, TODAY);
  assert.equal(ok.body.days.length, 15);
  assert.deepEqual(ok.body.workspace.type, "team");
});

// ---------------------------------------------------------------------------
// Grouping, expects and status (D13-D15)
// ---------------------------------------------------------------------------
test("2. a 3-athlete batch with 2 RPE results is ONE planned card: RPE 2/3, the two activities folded in, awaiting entry after the day", async () => {
  const team = await teamWithBatch("g2");
  const [a, b] = team.athletes;
  const actA = await submitRpe(a);
  const actB = await submitRpe(b);
  assert.equal(actA.owner_scope, "team");
  assert.equal(actA.origin, "planned_session");

  const res = await calendar(team.coach.cookie, { extra: "&include=athletes" });
  assert.equal(res.status, 200, res.text);
  const items = itemsOn(res, PAST);
  assert.equal(items.length, 1, JSON.stringify(items));
  const card = items[0];
  assert.equal(card.kind, "planned");
  assert.equal(card.title, "Team training");
  assert.deepEqual(card.slot, { amPm: "PM", bta: "T", order: 1 });
  assert.equal(card.startTime, "18:00");
  assert.equal(card.athleteCount, 3);
  assert.deepEqual([...card.athleteIds].sort(), team.athletes.map((x) => x.athleteId).sort());
  assert.deepEqual(card.teamIds, [team.teamId]);
  assert.deepEqual(card.expects, ["rpe"]);
  assert.deepEqual(card.rpe, { asked: 3, submitted: 2 });
  assert.equal(card.status, "awaiting_entry");
  assert.equal(card.attendance, null, "a planned group carries no roster in K1");
  assert.deepEqual([...card.links.activityIds].sort(), [actA.id, actB.id].sort(), "both RPE activities fold into the group");
  assert.deepEqual([...card.links.planIds].sort(), team.athletes.map((x) => x.planId).sort());
  assert.equal(card.links.logicalSessionIds.length, 3);
  assert.deepEqual(card.athletes.map((x) => x.rpe).sort(), ["missing", "submitted", "submitted"]);
  assert.ok(card.athletes.every((x) => x.name && x.planId && x.sessionId), "per-athlete rows carry the drill-in ids");
  assert.equal(ofKind(allItems(res), "activity").length, 0, "no activity card beside the group");
  assert.deepEqual(res.body.teams.map((t) => t.teamId), [team.teamId]);
  assert.equal(res.body.teams[0].athleteCount, 3);
  const withoutAthletes = await calendar(team.coach.cookie);
  assert.equal(itemsOn(withoutAthletes, PAST)[0].athletes, undefined, "per-athlete rows only on include=athletes");
});

test("3. today decides awaiting entry: with today on the day the same card is planned; a fully answered group is done; a future day is planned", async () => {
  const team = await teamWithBatch("g3", { n: 2 });
  await submitRpe(team.athletes[0]);
  const onTheDay = await calendar(team.coach.cookie, { extra: `&today=${PAST}` });
  assert.equal(itemsOn(onTheDay, PAST)[0].status, "planned");
  await submitRpe(team.athletes[1]);
  const after = await calendar(team.coach.cookie);
  assert.equal(itemsOn(after, PAST)[0].status, "done");
  assert.deepEqual(itemsOn(after, PAST)[0].rpe, { asked: 2, submitted: 2 });

  const future = await teamWithBatch("g3f", { n: 2, date: FUTURE });
  const res = await calendar(future.coach.cookie);
  assert.equal(itemsOn(res, FUTURE)[0].status, "planned");
  assert.deepEqual(itemsOn(res, FUTURE)[0].rpe, { asked: 2, submitted: 0 });
});

test("4. expects is derived: rpe_enabled off, or the workspace switch off, asks nothing (status none); a plan outside a batch is a group of one; one batch, two slots, two cards in slot order", async () => {
  const noRpe = await teamWithBatch("g4a", { n: 2, rpeEnabled: false });
  let res = await calendar(noRpe.coach.cookie);
  let card = itemsOn(res, PAST)[0];
  assert.deepEqual(card.expects, []);
  assert.equal(card.rpe, null);
  assert.equal(card.status, "none");

  const noSwitch = await teamWithBatch("g4b", { n: 2, withRpeSetting: false });
  res = await calendar(noSwitch.coach.cookie);
  card = itemsOn(res, PAST)[0];
  assert.deepEqual(card.expects, [], "rpe_enabled without the workspace switch is not a request (the submit route refuses it too)");
  assert.equal(card.status, "none");

  const solo = await teamWithBatch("g4c", { n: 1 });
  const extraPlan = await makePlan({ athleteId: solo.athletes[0].athleteId, coachUserId: solo.coach.id, owner: { scope: "team", teamId: solo.teamId } });
  await makeSession({ planId: extraPlan, date: PAST, name: "Morning run", amPm: "AM", bta: "B", order: 1, time: "07:30" });
  res = await calendar(solo.coach.cookie);
  const items = itemsOn(res, PAST);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Morning run", "AM before PM");
  assert.equal(items[0].key.startsWith(`planned:${extraPlan}:`), true, "a plan outside a batch is keyed by its plan id");
  assert.equal(items[1].key.startsWith(`planned:${solo.batchId}:`), true);
});

// ---------------------------------------------------------------------------
// Workspaces (D6-D8)
// ---------------------------------------------------------------------------
test("5. club workspace (D8): the club admin sees the team's planned card with its activities and the team in `teams`; another club's admin sees nothing of it", async () => {
  const team = await teamWithBatch("w5");
  const act = await submitRpe(team.athletes[0]);
  const admin1 = await clubAdminOf(team.clubId, "w5 admin");
  const res = await calendar(admin1.cookie);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.workspace.type, "club");
  const items = itemsOn(res, PAST);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].links.activityIds, [act.id], "the team-owned RPE activity is readable from the club workspace");
  assert.deepEqual(items[0].teamIds, [team.teamId]);
  assert.deepEqual(res.body.teams.map((t) => t.teamId), [team.teamId]);

  const other = await teamWithBatch("w5o", { n: 1 });
  const admin2 = await clubAdminOf(other.clubId, "w5 other admin");
  const res2 = await calendar(admin2.cookie);
  const items2 = allItems(res2);
  assert.equal(items2.length, 1, "only the own club's card");
  assert.equal(items2[0].athleteIds[0], other.athletes[0].athleteId);
  assert.deepEqual(res2.body.teams.map((t) => t.teamId), [other.teamId]);
  const filtered = await calendar(admin2.cookie, { extra: `&teamIds=${team.teamId}` });
  assert.equal(allItems(filtered).length, 0, "another club's team id filters to nothing, never to an error");
  assert.equal(filtered.status, 200);
});

test("6. team coach (D6) sees only own team's athletes of a batch that spans two teams; a club member outside any team is read by the club, not the team", async () => {
  const clubId = await makeClub("w6 club");
  const teamX = await makeTeam(clubId, "w6 X");
  const teamY = await makeTeam(clubId, "w6 Y");
  const coachX = await coachOf(teamX, "w6 coach X");
  const coachY = await coachOf(teamY, "w6 coach Y");
  const batchId = crypto.randomUUID();
  const ax = await makeAthlete("w6 ax", { clubId, teamId: teamX });
  const ay = await makeAthlete("w6 ay", { clubId, teamId: teamY });
  const clubOnly = await makeAthlete("w6 club only", { clubId });
  for (const athlete of [ax, ay, clubOnly]) {
    const planId = await makePlan({ athleteId: athlete.athleteId, coachUserId: coachX.id, owner: { scope: "club", clubId }, batchId });
    await makeSession({ planId, date: PAST, rpeEnabled: false });
  }
  const resX = await calendar(coachX.cookie);
  assert.deepEqual(itemsOn(resX, PAST)[0].athleteIds, [ax.athleteId]);
  const resY = await calendar(coachY.cookie);
  assert.deepEqual(itemsOn(resY, PAST)[0].athleteIds, [ay.athleteId]);
  const admin1 = await clubAdminOf(clubId, "w6 admin");
  const resC = await calendar(admin1.cookie);
  assert.equal(itemsOn(resC, PAST)[0].athleteCount, 3, "the club reads club members and team members alike");
  assert.deepEqual(itemsOn(resC, PAST)[0].teamIds.sort(), [teamX, teamY].sort(), "an athlete of each team puts the card in both teams");
});

test("7. private coach (D7): own athletes only — of a team batch they see one athlete and no team-owned activity; their own plan's activity is theirs", async () => {
  const team = await teamWithBatch("w7");
  await submitRpe(team.athletes[0]);
  const pc = await privateCoach("w7 pc");
  await q(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1,$2,'coach',true)`, [pc.id, team.athletes[0].athleteId]);
  const res = await calendar(pc.cookie);
  assert.equal(res.status, 200, res.text);
  const card = itemsOn(res, PAST)[0];
  assert.deepEqual(card.athleteIds, [team.athletes[0].athleteId], "teammates are never listed");
  assert.deepEqual(card.rpe, { asked: 1, submitted: 1 }, "RPE counts come from session_feedback, scoped to the own athlete");
  assert.deepEqual(card.links.activityIds, [], "a team-owned activity is not readable by a private coach");
  assert.deepEqual(card.teamIds, [], "no team of a club the private coach does not manage");
  assert.deepEqual(res.body.teams, []);

  const own = await makeAthlete("w7 own");
  await q(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1,$2,'coach',true)`, [pc.id, own.athleteId]);
  await enablePlannedRpe({ scope: "user", userId: pc.id });
  const planId = await makePlan({ athleteId: own.athleteId, coachUserId: pc.id, owner: { scope: "user", userId: pc.id } });
  const session = await makeSession({ planId, date: PAST, name: "Private session" });
  const act = await submitRpe({ ...own, ...session });
  assert.equal(act.owner_scope, "user");
  const res2 = await calendar(pc.cookie);
  const mine = itemsOn(res2, PAST).find((i) => i.title === "Private session");
  assert.deepEqual(mine.links.activityIds, [act.id]);
  assert.equal(mine.status, "done");
});

test("8. athlete workspace: own rows only, filters ignored, no teams; platform admin: every club", async () => {
  const team = await teamWithBatch("w8");
  const act = await submitRpe(team.athletes[0]);
  const res = await calendar(team.athletes[0].cookie, { extra: `&teamIds=${team.teamId}&athleteIds=${team.athletes[1].athleteId}&include=athletes` });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.workspace.type, "athlete");
  const card = itemsOn(res, PAST)[0];
  assert.deepEqual(card.athleteIds, [team.athletes[0].athleteId], "self only, whatever the filters say");
  assert.deepEqual(card.links.activityIds, [act.id]);
  assert.deepEqual(card.rpe, { asked: 1, submitted: 1 });
  assert.equal(card.status, "done");
  assert.deepEqual(res.body.teams, []);
  const other = await calendar(team.athletes[1].cookie);
  assert.deepEqual(itemsOn(other, PAST)[0].rpe, { asked: 1, submitted: 0 });
  assert.equal(itemsOn(other, PAST)[0].status, "awaiting_entry");

  const pa = await platformAdmin("w8 pa");
  const all = await calendar(pa.cookie, { extra: `&athleteIds=${team.athletes.map((x) => x.athleteId).join(",")}` });
  assert.equal(all.status, 200, all.text);
  assert.equal(itemsOn(all, PAST)[0].athleteCount, 3);
  assert.equal(all.body.workspace.type, "platform");
});

// ---------------------------------------------------------------------------
// Activity cards: self-report, imported, coach-made
// ---------------------------------------------------------------------------
test("9. a self-report activity on its own (kinds=activity) is done or none, never awaiting entry", async () => {
  const team = await teamWithBatch("a9", { n: 1 });
  const act = await submitRpe(team.athletes[0]);
  const res = await calendar(team.coach.cookie, { extra: "&kinds=activity" });
  const items = itemsOn(res, PAST);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "activity");
  assert.equal(items[0].key, `activity:${act.id}`);
  assert.equal(items[0].origin, "planned_session");
  assert.deepEqual(items[0].expects, ["rpe"]);
  assert.deepEqual(items[0].rpe, { asked: 1, submitted: 1 });
  assert.equal(items[0].status, "done");
  assert.equal(items[0].attendance, null, "v44: a self-report activity has no roster");
  assert.deepEqual(items[0].links.logicalSessionIds, [team.athletes[0].logicalSessionId]);
  // The coach's own materialization of one external assignment (no RPE yet)
  // is a self-report activity too: never awaiting.
  const coachOnly = await coachOf(team.teamId, "a9 coach 2");
  const scheduleId = await makeExternalSchedule({ owner: { scope: "team", teamId: team.teamId }, createdBy: coachOnly.id, targets: [{ kind: "team", id: team.teamId }] });
  const occurrenceId = await makeExternalOccurrence(scheduleId, PAST);
  const assignmentId = await makeExternalAssignment(occurrenceId, team.athletes[0].athleteId, PAST);
  const client = await appPool.connect();
  try {
    await client.query("begin");
    await materialize.materializeNaturalKeyActivity(client, {
      logicalSessionId: null, externalAssignmentId: assignmentId, athleteId: team.athletes[0].athleteId, localDate: PAST, timezone: "UTC", startInstant: null,
      sessionName: "Away match", ownerScope: "team", ownerIds: { teamId: team.teamId }, performedBy: coachOnly.id,
    });
    await client.query("commit");
  } finally {
    client.release();
  }
  const res2 = await calendar(team.coach.cookie, { extra: "&kinds=activity" });
  const ext = itemsOn(res2, PAST).find((i) => i.origin === "external_assignment");
  assert.ok(ext, "the external self-report activity is listed on its own");
  assert.deepEqual(ext.rpe, { asked: 1, submitted: 0 });
  assert.equal(ext.status, "none", "an unmet expectation on a self-report activity is never awaiting entry");
});

test("10. a GPEXE import is its own card: expects device_data, attendance x/y from the roster (v44), awaiting while a member needs a state, done after the decision; the club admin reads it too (D8)", async () => {
  const team = await gpexeTeam("a10");
  const coach = await coachOf(team.teamId, "a10 coach");
  const late = await makeAthlete("a10 no device", { clubId: team.clubId, teamId: team.teamId, tz: GPEXE_TZ });
  const result = await importDirect(team, bundleFor(5101));
  const activityId = result.activityId || (await q(`select id from training.activities where owner_team_id = $1 and origin in ('api_import','source_import') order by created_at desc limit 1`, [team.teamId]))[0].id;
  assert.ok(activityId, "the import materialized a team activity");

  const res = await calendar(coach.cookie, { from: GPEXE_DAY, to: GPEXE_DAY, extra: "&include=athletes" });
  assert.equal(res.status, 200, res.text);
  const items = itemsOn(res, GPEXE_DAY);
  assert.equal(items.length, 1, JSON.stringify(items));
  const card = items[0];
  assert.equal(card.kind, "activity");
  assert.equal(card.key, `activity:${activityId}`);
  assert.ok(["api_import", "source_import"].includes(card.origin), card.origin);
  assert.deepEqual(card.expects, ["device_data"]);
  assert.equal(card.rpe, null);
  assert.deepEqual(card.teamIds, [team.teamId]);
  assert.equal(card.athleteCount, 3, "the three measured athletes are the participants");
  assert.deepEqual(card.attendance, { roster: 4, present: 3, needsState: 1 }, "the roster is the team on that day; the fourth member needs a state");
  assert.equal(card.status, "awaiting_entry", "a roster with a measured source still needs a state");
  // The start as the writer stored it, in the activity's own time zone
  // (the fixture's naive "18:08:12" is kept as a UTC instant by the import).
  const storedStart = (await q(`select to_char(started_at at time zone timezone_snapshot, 'HH24:MI') as t, timezone_snapshot from training.activities where id = $1`, [activityId]))[0];
  assert.equal(storedStart.timezone_snapshot, GPEXE_TZ);
  assert.equal(card.startTime, storedStart.t, "the start in the activity's own time zone");
  assert.equal(card.athletes.length, 3);

  await insertDecision({ activityId, athleteId: late.athleteId, teamId: team.teamId, userId: coach.id });
  const after = await calendar(coach.cookie, { from: GPEXE_DAY, to: GPEXE_DAY });
  assert.deepEqual(itemsOn(after, GPEXE_DAY)[0].attendance, { roster: 4, present: 3, needsState: 0 });
  assert.equal(itemsOn(after, GPEXE_DAY)[0].status, "done");

  const clubAdmin = await clubAdminOf(team.clubId, "a10 admin");
  const clubView = await calendar(clubAdmin.cookie, { from: GPEXE_DAY, to: GPEXE_DAY });
  assert.equal(itemsOn(clubView, GPEXE_DAY)[0]?.key, `activity:${activityId}`, "D8: the club sees its team's imported session");
  const detail = await api(`/api/training-activity/${activityId}`, { cookie: clubAdmin.cookie });
  assert.equal(detail.status, 200, "D8: the click opens the detail");
});

test("11. a coach-made team activity without measured values: attendance shown, nothing expected, status none; a club-owned activity has no roster", async () => {
  const team = await teamWithBatch("a11", { n: 2 });
  const manual = await makeActivity({ owner: { scope: "team", teamId: team.teamId }, origin: "manual", name: "Video session", date: FUTURE });
  await addParticipant(manual, team.athletes[0].athleteId, FUTURE);
  await addParticipant(manual, team.athletes[1].athleteId, FUTURE);
  const res = await calendar(team.coach.cookie, { extra: "&kinds=activity" });
  const card = itemsOn(res, FUTURE)[0];
  assert.equal(card.key, `activity:${manual}`);
  assert.deepEqual(card.expects, []);
  assert.equal(card.status, "none");
  assert.equal(card.athleteCount, 2);
  assert.deepEqual(card.attendance, { roster: 2, present: 0, needsState: 2 }, "the roster exists (manual team activity) but no measured source asks for states");
  assert.equal(card.startTime, "16:00");

  const admin1 = await clubAdminOf(team.clubId, "a11 admin");
  const clubAct = await makeActivity({ owner: { scope: "club", clubId: team.clubId }, origin: "manual", name: "Club meeting", date: PAST });
  const res2 = await calendar(admin1.cookie, { extra: "&kinds=activity" });
  const meeting = itemsOn(res2, PAST).find((i) => i.key === `activity:${clubAct}`);
  assert.ok(meeting, "the club's own activity");
  assert.equal(meeting.attendance, null, "no roster outside a team-owned activity");
  assert.equal(meeting.status, "none");
  assert.ok(itemsOn(res2, FUTURE).some((i) => i.key === `activity:${manual}`), "D8: the team's activity is there as well");
});

// ---------------------------------------------------------------------------
// External and test schedules
// ---------------------------------------------------------------------------
test("12. external: one card per schedule and day with RPE x/y and the folded activity; a projected future day is planned; a past day without an occurrence is not_opened; a cancelled schedule is cancelled", async () => {
  const team = await teamWithBatch("e12", { n: 2 });
  const [a, b] = team.athletes;
  const scheduleId = await makeExternalSchedule({ owner: { scope: "team", teamId: team.teamId }, createdBy: team.coach.id, targets: [{ kind: "team", id: team.teamId }] });
  const occurrenceId = await makeExternalOccurrence(scheduleId, PAST);
  const asgA = await makeExternalAssignment(occurrenceId, a.athleteId, PAST, "completed");
  await makeExternalAssignment(occurrenceId, b.athleteId, PAST);
  await externalFeedback(a.athleteId, asgA, PAST);
  const client = await appPool.connect();
  let folded;
  try {
    await client.query("begin");
    folded = await materialize.materializeNaturalKeyActivity(client, {
      logicalSessionId: null, externalAssignmentId: asgA, athleteId: a.athleteId, localDate: PAST, timezone: "UTC", startInstant: null,
      sessionName: "Away match", ownerScope: "team", ownerIds: { teamId: team.teamId }, performedBy: team.coach.id,
    });
    await client.query("commit");
  } finally {
    client.release();
  }
  const res = await calendar(team.coach.cookie, { extra: "&kinds=external,activity&include=athletes" });
  assert.equal(res.status, 200, res.text);
  const items = itemsOn(res, PAST);
  assert.equal(items.length, 1, JSON.stringify(items));
  const card = items[0];
  assert.equal(card.kind, "external");
  assert.equal(card.key, `external:${scheduleId}:${PAST}`);
  assert.equal(card.title, "Away match");
  assert.equal(card.eventType, "match");
  assert.equal(card.startTime, "17:00");
  assert.deepEqual(card.expects, ["rpe"]);
  assert.deepEqual(card.rpe, { asked: 2, submitted: 1 });
  assert.equal(card.status, "awaiting_entry");
  assert.equal(card.projected, false);
  assert.deepEqual(card.links.activityIds, [folded.activityId], "the assignment's activity folds into the card");
  assert.equal(card.links.externalOccurrenceId, occurrenceId);
  assert.deepEqual(card.athletes.map((x) => x.rpe).sort(), ["missing", "submitted"]);
  assert.deepEqual(card.teamIds, [team.teamId]);

  // A daily schedule from today for four days, no occurrence yet: projected.
  const daily = await makeExternalSchedule({
    owner: { scope: "team", teamId: team.teamId }, createdBy: team.coach.id, kind: "recurring", startDate: TODAY, endDate: addDays(TODAY, 3),
    recurrence: { version: 1, freq: "daily" }, eventName: "Camp", targets: [{ kind: "team", id: team.teamId }],
  });
  // A one-time schedule of a day that passed, never generated: not opened.
  const missed = await makeExternalSchedule({ owner: { scope: "team", teamId: team.teamId }, createdBy: team.coach.id, startDate: addDays(PAST, -1), eventName: "Friendly", targets: [{ kind: "team", id: team.teamId }] });
  // A cancelled schedule with an occurrence: cancelled.
  const cancelled = await makeExternalSchedule({ owner: { scope: "team", teamId: team.teamId }, createdBy: team.coach.id, startDate: FUTURE, eventName: "Cancelled match", status: "cancelled", targets: [{ kind: "team", id: team.teamId }] });
  const cancelledOcc = await makeExternalOccurrence(cancelled, FUTURE, "cancelled");
  await makeExternalAssignment(cancelledOcc, a.athleteId, FUTURE, "cancelled");

  const res2 = await calendar(team.coach.cookie, { extra: "&kinds=external" });
  for (let i = 0; i <= 3; i += 1) {
    const day = addDays(TODAY, i);
    const camp = itemsOn(res2, day).find((it) => it.key === `external:${daily}:${day}`);
    assert.ok(camp, `the camp is projected on ${day}`);
    assert.equal(camp.projected, true);
    assert.equal(camp.status, "planned");
    assert.equal(camp.rpe, null);
    assert.equal(camp.athleteCount, 2, "the team's members today");
  }
  assert.equal(itemsOn(res2, addDays(TODAY, 4)).some((it) => it.key.startsWith(`external:${daily}:`)), false, "nothing after end_date");
  // The filter narrows a projected day too: one athlete of the team keeps the
  // card with that athlete alone; an outsider's id leaves no card.
  const narrowed = await calendar(team.coach.cookie, { extra: `&kinds=external&athleteIds=${a.athleteId}` });
  const narrowedCamp = itemsOn(narrowed, TODAY).find((it) => it.key === `external:${daily}:${TODAY}`);
  assert.deepEqual(narrowedCamp.athleteIds, [a.athleteId]);
  const outsider = await makeAthlete("e12 outsider", { clubId: team.clubId });
  const none = await calendar(team.coach.cookie, { extra: `&kinds=external&athleteIds=${outsider.athleteId}` });
  assert.equal(itemsOn(none, TODAY).some((it) => it.key === `external:${daily}:${TODAY}`), false, "a projected day with nobody in the filter is not shown");
  const friendly = itemsOn(res2, addDays(PAST, -1)).find((it) => it.key === `external:${missed}:${addDays(PAST, -1)}`);
  assert.equal(friendly.status, "not_opened");
  const cancelledCard = itemsOn(res2, FUTURE).find((it) => it.key === `external:${cancelled}:${FUTURE}`);
  assert.equal(cancelledCard.status, "cancelled");
  assert.equal(cancelledCard.cancelled, true);
  // A projected schedule is read by target as well as by owner: a club-owned
  // schedule targeting the team is on the team coach's calendar.
  const admin1 = await clubAdminOf(team.clubId, "e12 admin");
  const clubSchedule = await makeExternalSchedule({ owner: { scope: "club", clubId: team.clubId }, createdBy: admin1.id, startDate: FUTURE, eventName: "Club day", targets: [{ kind: "team", id: team.teamId }] });
  const res3 = await calendar(team.coach.cookie, { extra: "&kinds=external" });
  assert.ok(itemsOn(res3, FUTURE).some((it) => it.key === `external:${clubSchedule}:${FUTURE}`), "targeted at the team: on the team's calendar");
});

test("13. test schedules: results x/y, awaiting entry until every result is in, done afterwards; projected and not opened days; the title is the test's name", async () => {
  const team = await teamWithBatch("t13", { n: 2 });
  const [a, b] = team.athletes;
  const scheduleId = await makeTestSchedule({ owner: { scope: "team", teamId: team.teamId }, createdBy: team.coach.id, targets: [{ kind: "team", id: team.teamId }] });
  const occurrenceId = await makeTestOccurrence(scheduleId, PAST);
  await makeTestAssignment(occurrenceId, a.athleteId, PAST, "completed");
  const asgB = await makeTestAssignment(occurrenceId, b.athleteId, PAST);
  const res = await calendar(team.coach.cookie, { extra: "&kinds=test&include=athletes" });
  assert.equal(res.status, 200, res.text);
  const card = itemsOn(res, PAST)[0];
  assert.equal(card.kind, "test");
  assert.equal(card.key, `test:${scheduleId}:${PAST}`);
  assert.equal(card.title, "WELLNESS");
  assert.equal(card.startTime, "07:00");
  assert.deepEqual(card.expects, ["test_result"]);
  assert.deepEqual(card.results, { expected: 2, completed: 1 });
  assert.equal(card.status, "awaiting_entry");
  assert.equal(card.links.testOccurrenceId, occurrenceId);
  assert.deepEqual(card.athletes.map((x) => x.result).sort(), ["completed", "missing"]);
  await q(`update tests.test_assignments set status = 'completed', completed_at = now() where id = $1`, [asgB]);
  const done = await calendar(team.coach.cookie, { extra: "&kinds=test" });
  assert.equal(itemsOn(done, PAST)[0].status, "done");

  const future = await makeTestSchedule({ owner: { scope: "team", teamId: team.teamId }, createdBy: team.coach.id, startDate: FUTURE, targets: [{ kind: "team", id: team.teamId }] });
  const missed = await makeTestSchedule({ owner: { scope: "team", teamId: team.teamId }, createdBy: team.coach.id, startDate: addDays(PAST, -2), targets: [{ kind: "athlete", id: a.athleteId }] });
  const res2 = await calendar(team.coach.cookie, { extra: "&kinds=test" });
  const futureCard = itemsOn(res2, FUTURE).find((it) => it.key === `test:${future}:${FUTURE}`);
  assert.equal(futureCard.status, "planned");
  assert.equal(futureCard.projected, true);
  assert.equal(futureCard.athleteCount, 2);
  const missedCard = itemsOn(res2, addDays(PAST, -2)).find((it) => it.key === `test:${missed}:${addDays(PAST, -2)}`);
  assert.equal(missedCard.status, "not_opened");
  assert.deepEqual(missedCard.athleteIds, [a.athleteId]);
});

// ---------------------------------------------------------------------------
// No write on read
// ---------------------------------------------------------------------------
test("14. the read generates nothing: an active schedule whose current occurrence is missing stays missing after GET /api/calendar, while the Training Load calendar creates it", async () => {
  const team = await teamWithBatch("nw14", { n: 2 });
  await makeExternalSchedule({ owner: { scope: "team", teamId: team.teamId }, createdBy: team.coach.id, startDate: TODAY, eventName: "Today's match", targets: [{ kind: "team", id: team.teamId }] });
  await makeTestSchedule({ owner: { scope: "team", teamId: team.teamId }, createdBy: team.coach.id, startDate: TODAY, targets: [{ kind: "team", id: team.teamId }] });
  const tables = ["training_load.external_schedule_occurrences", "training_load.external_assignments", "tests.test_schedule_occurrences", "tests.test_assignments", "training.activities", "training_load.session_feedback"];
  const before = await rowCounts(tables);
  const res = await calendar(team.coach.cookie);
  assert.equal(res.status, 200, res.text);
  assert.ok(itemsOn(res, TODAY).some((it) => it.kind === "external" && it.projected), "the day is projected, not generated");
  assert.ok(itemsOn(res, TODAY).some((it) => it.kind === "test" && it.projected));
  assert.deepEqual(await rowCounts(tables), before, "no row of any schedule, assignment, activity or result table changed");

  // The control: the Training Load calendar writes on read.
  const tl = await api(`/api/training-load/calendar?dateFrom=${TODAY}&dateTo=${TODAY}`, { cookie: team.coach.cookie });
  assert.equal(tl.status, 200, tl.text);
  const afterTl = await rowCounts(tables);
  assert.ok(afterTl["training_load.external_schedule_occurrences"] > before["training_load.external_schedule_occurrences"], "the control generated the occurrence");

  // And statically: neither calendar module imports an occurrence generator.
  for (const file of ["calendarQuery.js", "calendarAccess.js", "routes/calendar.js"]) {
    const source = (await fsp.readFile(path.resolve(__dirname, "../src", file), "utf8")).replace(/\/\/.*$/gm, "");
    assert.equal(/^import\b[^\n]*OccurrenceService/m.test(source), false, `${file} must not import an occurrence service`);
    assert.equal(/\bensureCurrent[A-Za-z]*Occurrence/.test(source), false, `${file} must not call a generator`);
    assert.equal(/\b(insert|update|delete)\s+(into\s+)?[a-z_]+\./i.test(source), false, `${file} holds no write statement`);
  }
  // The published-weekly-plan rule is shared, not copied: the calendar
  // imports WEEKLY_PLAN_SESSION_FILTER_SQL from trainingLoadAccess.js.
  const querySource = await fsp.readFile(path.resolve(__dirname, "../src/calendarQuery.js"), "utf8");
  assert.equal(/p\.plan_type = 'weekly'/.test(querySource), false, "calendarQuery.js carries no copy of the weekly-plan rule");
  assert.match(querySource, /import \{ WEEKLY_PLAN_SESSION_FILTER_SQL \} from "\.\/trainingLoadAccess\.js"/);
});

// ---------------------------------------------------------------------------
// D8 on the Activities list and the detail
// ---------------------------------------------------------------------------
test("15. D8 contract: the club admin reads a team activity (detail 200, roster 200, listed by /api/training-activity and the TL calendar); another club's admin, an archived team and a write get the same 404 as a missing id", async () => {
  const team = await teamWithBatch("d8", { n: 2 });
  const act = await submitRpe(team.athletes[0]);
  const gpexe = await gpexeTeam("d8g");
  const imported = await importDirect(gpexe, bundleFor(5201));
  const importedId = imported.activityId || (await q(`select id from training.activities where owner_team_id = $1 order by created_at desc limit 1`, [gpexe.teamId]))[0].id;
  const admin1 = await clubAdminOf(team.clubId, "d8 admin");
  const gAdmin = await clubAdminOf(gpexe.clubId, "d8g admin");

  const detail = await api(`/api/training-activity/${act.id}`, { cookie: admin1.cookie });
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.canonicalActivityId, act.id);
  const rosterRes = await api(`/api/training-activity/${importedId}/roster`, { cookie: gAdmin.cookie });
  assert.equal(rosterRes.status, 200, rosterRes.text);
  const list = await api(`/api/training-activity?dateFrom=${PAST}&dateTo=${PAST}`, { cookie: admin1.cookie });
  assert.equal(list.status, 200, list.text);
  assert.ok(list.body.rows.some((r) => r.activityId === act.id), "the Activities list shows the team's activity to the club");
  const tl = await api(`/api/training-load/calendar?dateFrom=${PAST}&dateTo=${PAST}`, { cookie: admin1.cookie });
  assert.equal(tl.status, 200, tl.text);
  assert.ok(tl.body.days[0].items.some((i) => i.kind === "activity" && i.activityId === act.id), "the Training Load calendar shows it too");

  const foreign = await api(`/api/training-activity/${act.id}`, { cookie: gAdmin.cookie });
  const missing = await api(`/api/training-activity/${crypto.randomUUID()}`, { cookie: gAdmin.cookie });
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(foreign.text, missing.text, "another club's admin cannot tell a team activity from a missing one");
  const foreignList = await api(`/api/training-activity?dateFrom=${PAST}&dateTo=${PAST}`, { cookie: gAdmin.cookie });
  assert.equal(foreignList.body.rows.some((r) => r.activityId === act.id), false);
  const foreignCal = await calendar(gAdmin.cookie);
  assert.equal(allItems(foreignCal).some((i) => i.links.activityIds?.includes(act.id)), false);

  // A write stays a write: the club admin cannot reparent the team's participant (404 as before D8).
  const participantId = (await q(`select id from training.activity_participants where activity_id = $1`, [act.id]))[0].id;
  const target = await makeActivity({ owner: { scope: "team", teamId: team.teamId }, origin: "manual", name: "Target", date: PAST });
  const write = await api(`/api/training-activity/participants/${participantId}/reparent`, { method: "POST", cookie: admin1.cookie, body: { toActivityId: target } });
  assert.equal(write.status, 404, write.text);

  // The team's own coach reads as before D8.
  const teamCoach = await api(`/api/training-activity/${act.id}`, { cookie: team.coach.cookie });
  assert.equal(teamCoach.status, 200, "the team's own coach is unchanged by D8");

  // An archived team is not read by the club: the detail answers the
  // missing-id 404 and the calendars leave it out. (Its coach loses the team
  // workspace itself, as before: workspace.js offers no archived team.)
  await q(`update public.teams set is_active = false where id = $1`, [team.teamId]);
  const archived = await api(`/api/training-activity/${act.id}`, { cookie: admin1.cookie });
  assert.equal(archived.status, 404);
  assert.equal(archived.text, missing.text);
  const archivedCal = await calendar(admin1.cookie, { extra: "&kinds=activity" });
  assert.equal(allItems(archivedCal).some((i) => i.key === `activity:${act.id}`), false);
  const archivedList = await api(`/api/training-activity?dateFrom=${PAST}&dateTo=${PAST}`, { cookie: admin1.cookie });
  assert.equal(archivedList.body.rows.some((r) => r.activityId === act.id), false, "the Activities list leaves the archived team out as well");
});

// ---------------------------------------------------------------------------
// The athlete workspace on a shared activity (security review F1)
// ---------------------------------------------------------------------------
test("17. athlete workspace on a shared team activity: own participation only — no teammate id, name, RPE or roster anywhere in the answer", async () => {
  const team = await gpexeTeam("a17");
  await importDirect(team, bundleFor(5301));
  const self = team.members[101];
  const res = await calendar(self.cookie, { from: GPEXE_DAY, to: GPEXE_DAY, extra: "&kinds=activity&include=athletes" });
  assert.equal(res.status, 200, res.text);
  const items = itemsOn(res, GPEXE_DAY);
  assert.equal(items.length, 1, JSON.stringify(items));
  const card = items[0];
  assert.deepEqual(card.athleteIds, [self.athleteId]);
  assert.equal(card.athleteCount, 1);
  assert.deepEqual(card.athletes.map((x) => x.athleteId), [self.athleteId]);
  assert.equal(card.attendance, null, "the roster is the coach's view");
  assert.equal(card.rpe, null);
  assert.deepEqual(card.expects, ["device_data"]);
  assert.equal(card.status, "done");
  for (const g of [102, 103]) {
    assert.equal(res.text.includes(team.members[g].name), false, `teammate ${g}'s name is nowhere in the answer`);
    assert.equal(res.text.includes(team.members[g].athleteId), false, `teammate ${g}'s id is nowhere in the answer`);
  }
  // The coach sees all three (the control).
  const coach = await coachOf(team.teamId, "a17 coach");
  const coachView = await calendar(coach.cookie, { from: GPEXE_DAY, to: GPEXE_DAY, extra: "&kinds=activity" });
  assert.equal(itemsOn(coachView, GPEXE_DAY)[0].athleteCount, 3);

  // A coach-made team activity with two athletes: each sees only themself.
  const pair = await teamWithBatch("a17b", { n: 2 });
  const [a, b] = pair.athletes;
  const manual = await makeActivity({ owner: { scope: "team", teamId: pair.teamId }, origin: "manual", name: "Video session", date: FUTURE });
  await addParticipant(manual, a.athleteId, FUTURE);
  await addParticipant(manual, b.athleteId, FUTURE);
  const aView = await calendar(a.cookie, { extra: "&kinds=activity&include=athletes" });
  const aCard = itemsOn(aView, FUTURE).find((it) => it.key === `activity:${manual}`);
  assert.deepEqual(aCard.athleteIds, [a.athleteId]);
  assert.equal(aView.text.includes(b.name), false);
  assert.equal(aView.text.includes(b.athleteId), false);
  assert.equal(aCard.attendance, null);

  // The RPE counts and the link ids are self-scoped as well: one team
  // activity on the batch day with both participants, each linked
  // (confirmed) to their own planned session, B with an RPE result — A's
  // card asks 1 (own), carries only A's logical session, and B's logical
  // session id is nowhere in the answer.
  const shared = await makeActivity({ owner: { scope: "team", teamId: pair.teamId }, origin: "manual", name: "Shared", date: PAST });
  for (const athlete of [a, b]) {
    const participantId = await addParticipant(shared, athlete.athleteId, PAST);
    await q(
      `insert into training.activity_participant_session_links (activity_participant_id, athlete_id, logical_session_id, link_method, link_status, confirmed_at)
       values ($1,$2,$3,'manual','confirmed',now())`,
      [participantId, athlete.athleteId, athlete.logicalSessionId],
    );
  }
  await q(
    `insert into training_load.session_feedback (athlete_id, session_date, logical_session_id, source, rpe, duration_minutes) values ($1,$2,$3,'planned',5,50)`,
    [b.athleteId, PAST, b.logicalSessionId],
  );
  const aShared = await calendar(a.cookie, { extra: "&kinds=activity" });
  const sharedCard = itemsOn(aShared, PAST).find((it) => it.key === `activity:${shared}`);
  assert.ok(sharedCard, "A is a participant, so A reads the activity");
  assert.deepEqual(sharedCard.rpe, { asked: 1, submitted: 0 }, "RPE counted for A alone, B's result not counted");
  assert.deepEqual(sharedCard.links.logicalSessionIds, [a.logicalSessionId]);
  assert.equal(aShared.text.includes(b.logicalSessionId), false, "B's logical session id is nowhere in A's answer");
  const coachShared = await calendar(pair.coach.cookie, { extra: "&kinds=activity" });
  assert.deepEqual(itemsOn(coachShared, PAST).find((it) => it.key === `activity:${shared}`).rpe, { asked: 2, submitted: 1 }, "the coach sees both (the control)");
});

// ---------------------------------------------------------------------------
// Access negatives and the multi-role account (security review F2, F3)
// ---------------------------------------------------------------------------
test("18. one account with four roles: each active workspace reads its own scope and nothing of the others", async () => {
  const A = await teamWithBatch("mr-a", { n: 2 });
  const B = await teamWithBatch("mr-b", { n: 2 });
  const E = await teamWithBatch("mr-e", { n: 1 });
  const userId = await makeUser("multi role");
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [userId, A.clubId]);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [userId, B.teamId]);
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [userId]);
  const P = await makeAthlete("mr-p");
  await q(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1,$2,'coach',true)`, [userId, P.athleteId]);
  const pPlan = await makePlan({ athleteId: P.athleteId, coachUserId: userId, owner: { scope: "user", userId } });
  await makeSession({ planId: pPlan, date: PAST, name: "Private", rpeEnabled: false });
  const selfAthleteId = (await q(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,'Multi self','Multi self','UTC') returning id`, [userId]))[0].id;
  await addMembership({ athleteId: selfAthleteId, clubId: E.clubId, type: "club" });
  await addMembership({ athleteId: selfAthleteId, clubId: E.clubId, teamId: E.teamId });
  const selfPlan = await makePlan({ athleteId: selfAthleteId, coachUserId: E.coach.id, owner: { scope: "team", teamId: E.teamId }, batchId: E.batchId });
  await makeSession({ planId: selfPlan, date: PAST });
  const user = await withCookie(userId);
  const idsOf = (res) => [...new Set(allItems(res).flatMap((i) => i.athleteIds))].sort();

  await setWorkspace(userId, "club", A.clubId);
  let res = await calendar(user.cookie);
  assert.equal(res.body.workspace.type, "club");
  assert.deepEqual(idsOf(res), A.athletes.map((x) => x.athleteId).sort(), "the club workspace: club A only");

  await setWorkspace(userId, "team", B.teamId);
  res = await calendar(user.cookie);
  assert.equal(res.body.workspace.type, "team");
  assert.deepEqual(idsOf(res), B.athletes.map((x) => x.athleteId).sort(), "the team workspace: team B only");

  await setWorkspace(userId, "private_coach", null);
  res = await calendar(user.cookie);
  assert.equal(res.body.workspace.type, "private_coach");
  assert.deepEqual(idsOf(res), [P.athleteId], "the private workspace: the own athlete only");

  await setWorkspace(userId, "athlete", null);
  res = await calendar(user.cookie);
  assert.equal(res.body.workspace.type, "athlete");
  assert.deepEqual(idsOf(res), [selfAthleteId], "the athlete workspace: self only");
  assert.equal(itemsOn(res, PAST)[0].athleteCount, 1, "the team E batch card shows one athlete, not the teammate");
});

test("19. negatives: team X's coach against team Y's activity of the same club; a foreign athleteIds filter; a schedule of another club by target", async () => {
  const clubId = await makeClub("n19 club");
  const teamX = await makeTeam(clubId, "n19 X");
  const teamY = await makeTeam(clubId, "n19 Y");
  const coachX = await coachOf(teamX, "n19 coach X");
  const coachY = await coachOf(teamY, "n19 coach Y");
  const ax = await makeAthlete("n19 ax", { clubId, teamId: teamX });
  const ay = await makeAthlete("n19 ay", { clubId, teamId: teamY });
  const actY = await makeActivity({ owner: { scope: "team", teamId: teamY }, origin: "manual", name: "Y session", date: PAST });
  await addParticipant(actY, ay.athleteId, PAST);
  const planX = await makePlan({ athleteId: ax.athleteId, coachUserId: coachX.id, owner: { scope: "team", teamId: teamX } });
  await makeSession({ planId: planX, date: PAST, rpeEnabled: false });

  const missing = await api(`/api/training-activity/${crypto.randomUUID()}`, { cookie: coachX.cookie });
  const foreign = await api(`/api/training-activity/${actY}`, { cookie: coachX.cookie });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.text, missing.text, "another team's activity of the same club reads as missing to a team coach");
  assert.equal((await api(`/api/training-activity/${actY}`, { cookie: coachY.cookie })).status, 200);
  const listX = await api(`/api/training-activity?dateFrom=${PAST}&dateTo=${PAST}`, { cookie: coachX.cookie });
  assert.equal(listX.body.rows.some((r) => r.activityId === actY), false);
  const calX = await calendar(coachX.cookie, { extra: "&kinds=activity" });
  assert.equal(allItems(calX).some((i) => i.key === `activity:${actY}`), false);
  assert.ok(allItems(await calendar(coachY.cookie, { extra: "&kinds=activity" })).some((i) => i.key === `activity:${actY}`));

  const filtered = await calendar(coachX.cookie, { extra: `&athleteIds=${ay.athleteId}` });
  assert.equal(filtered.status, 200);
  assert.equal(allItems(filtered).length, 0, "a foreign athlete id narrows to nothing, never widens and never errors");

  const otherClub = await makeClub("n19 other");
  const otherTeam = await makeTeam(otherClub, "n19 other team");
  const otherAdmin = await clubAdminOf(otherClub, "n19 other admin");
  const invisible = await makeExternalSchedule({ owner: { scope: "club", clubId: otherClub }, createdBy: otherAdmin.id, startDate: FUTURE, eventName: "Other club day", targets: [{ kind: "team", id: otherTeam }] });
  const addressed = await makeExternalSchedule({ owner: { scope: "club", clubId: otherClub }, createdBy: otherAdmin.id, startDate: FUTURE, eventName: "Guest match", targets: [{ kind: "athlete", id: ax.athleteId }] });
  const resX = await calendar(coachX.cookie, { extra: "&kinds=external" });
  assert.equal(allItems(resX).some((i) => i.key === `external:${invisible}:${FUTURE}`), false, "a schedule of another club that targets nobody of mine stays invisible");
  const guest = itemsOn(resX, FUTURE).find((i) => i.key === `external:${addressed}:${FUTURE}`);
  assert.ok(guest, "a schedule that targets my athlete directly is on my calendar");
  assert.deepEqual(guest.athleteIds, [ax.athleteId]);
  assert.deepEqual(guest.teamIds, [teamX]);
});

test("20. decision 4 (membership): a private coach's plan for a club athlete is on the club's and the team's calendar; the athlete's own projected schedule days are on the athlete's calendar", async () => {
  const team = await teamWithBatch("d4", { n: 1 });
  const athlete = team.athletes[0];
  const pc = await privateCoach("d4 pc");
  await q(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1,$2,'coach',true)`, [pc.id, athlete.athleteId]);
  const privatePlan = await makePlan({ athleteId: athlete.athleteId, coachUserId: pc.id, owner: { scope: "user", userId: pc.id } });
  await makeSession({ planId: privatePlan, date: FUTURE, name: "Private extra", rpeEnabled: false });
  const admin1 = await clubAdminOf(team.clubId, "d4 admin");
  for (const viewer of [admin1, team.coach]) {
    const res = await calendar(viewer.cookie);
    const card = itemsOn(res, FUTURE).find((i) => i.title === "Private extra");
    assert.ok(card, "the plan is read by the athlete's membership, whoever made it");
    assert.deepEqual(card.athleteIds, [athlete.athleteId]);
  }

  const teamSchedule = await makeExternalSchedule({ owner: { scope: "team", teamId: team.teamId }, createdBy: team.coach.id, startDate: FUTURE, eventName: "Team match", targets: [{ kind: "team", id: team.teamId }] });
  const clubTest = await makeTestSchedule({ owner: { scope: "club", clubId: team.clubId }, createdBy: admin1.id, startDate: FUTURE, targets: [{ kind: "club", id: team.clubId }] });
  const otherTeam = await makeTeam(team.clubId, "d4 other");
  const otherSchedule = await makeExternalSchedule({ owner: { scope: "team", teamId: otherTeam }, createdBy: team.coach.id, startDate: FUTURE, eventName: "Other team match", targets: [{ kind: "team", id: otherTeam }] });
  const res = await calendar(athlete.cookie, { extra: "&kinds=external,test" });
  assert.equal(res.status, 200, res.text);
  const match = itemsOn(res, FUTURE).find((i) => i.key === `external:${teamSchedule}:${FUTURE}`);
  assert.ok(match, "a projected day of a schedule targeting the athlete's team");
  assert.equal(match.projected, true);
  assert.deepEqual(match.athleteIds, [athlete.athleteId], "self only");
  assert.equal(match.status, "planned");
  assert.ok(itemsOn(res, FUTURE).some((i) => i.key === `test:${clubTest}:${FUTURE}`), "a test targeting the athlete's club");
  assert.equal(itemsOn(res, FUTURE).some((i) => i.key === `external:${otherSchedule}:${FUTURE}`), false, "another team's schedule is not the athlete's");
  assert.deepEqual(res.body.teams, []);
});

test("21. small rules: an external day whose only assignment is excused expects nothing; the self-report predicate follows v44's roster answer; the slot order of an item without a slot", async () => {
  const team = await teamWithBatch("s21", { n: 1 });
  const scheduleId = await makeExternalSchedule({ owner: { scope: "team", teamId: team.teamId }, createdBy: team.coach.id, targets: [{ kind: "team", id: team.teamId }] });
  const occurrenceId = await makeExternalOccurrence(scheduleId, PAST);
  await makeExternalAssignment(occurrenceId, team.athletes[0].athleteId, PAST, "excused");
  const res = await calendar(team.coach.cookie, { extra: "&kinds=external" });
  const card = itemsOn(res, PAST).find((i) => i.key === `external:${scheduleId}:${PAST}`);
  assert.deepEqual(card.expects, []);
  assert.deepEqual(card.rpe, { asked: 0, submitted: 0 });
  assert.equal(card.status, "none");

  const { isSelfReportCard, sortKey } = await import("../src/calendarQuery.js");
  assert.equal(isSelfReportCard({ origin: "planned_session" }, 1, false), true);
  assert.equal(isSelfReportCard({ origin: "planned_session" }, 1, true), false, "v44 says it has a roster (measured values): not a self-report card");
  assert.equal(isSelfReportCard({ origin: "planned_session" }, 2, false), false);
  assert.equal(isSelfReportCard({ origin: "manual" }, 1, false), false);
  const before = (x, y) => JSON.stringify(sortKey(x)) < JSON.stringify(sortKey(y));
  const amSlot = { slot: { amPm: "AM", bta: "T", order: 1 }, startTime: "08:00", title: "AM training", key: "a" };
  const earlyNoSlot = { slot: null, startTime: "07:30", title: "GPEXE", key: "b" };
  const afternoonNoSlot = { slot: null, startTime: "13:00", title: "GPEXE", key: "c" };
  const pmSlot = { slot: { amPm: "PM", bta: "B", order: 1 }, startTime: null, title: "PM warm-up", key: "d" };
  assert.ok(before(earlyNoSlot, amSlot), "a 07:30 start without a slot sorts among the AM items, before the AM/T slot");
  assert.ok(before(amSlot, afternoonNoSlot), "a 13:00 start without a slot sorts among the PM items");
  assert.ok(before(pmSlot, afternoonNoSlot), "PM/Before precedes a PM item without a slot (Training rank)");
});

// ---------------------------------------------------------------------------
// Bounded statements
// ---------------------------------------------------------------------------
test("16. the number of SQL statements does not depend on the number of items", async () => {
  const small = await teamWithBatch("q16s", { n: 1 });
  const large = await teamWithBatch("q16l", { n: 4 });
  for (const athlete of large.athletes) {
    for (let i = 2; i <= 3; i += 1) await makeSession({ planId: athlete.planId, date: addDays(PAST, i - 2 + 1), name: `Session ${i}`, order: i });
  }
  await submitRpe(large.athletes[0]);
  await submitRpe(large.athletes[1]);
  const original = appPool.query;
  let count = 0;
  appPool.query = function counted(...args) {
    count += 1;
    return original.apply(this, args);
  };
  try {
    count = 0;
    assert.equal((await calendar(small.coach.cookie)).status, 200);
    const smallCount = count;
    count = 0;
    const res = await calendar(large.coach.cookie);
    assert.equal(res.status, 200);
    assert.equal(ofKind(allItems(res), "planned").length, 3, "three days of sessions, one card each");
    assert.equal(count, smallCount, `the same number of statements for 1 and for 12 sessions (${smallCount})`);
  } finally {
    appPool.query = original;
  }
});

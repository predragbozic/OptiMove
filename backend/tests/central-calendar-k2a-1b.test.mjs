// Central calendar K2a-1b: the planned groups of D16b, attaching and detaching
// planned sessions and activities to an event, the alignment of D20 (option
// A) through the one shared flag function, the event card's rolled-up counts
// and the lock order against the Builder. Plan: docs/ai/central-calendar-k2a-plan.md
// (sections 2, 3.2, 4.3 and 11).
//
// Everything runs on ONE disposable database (optimove_tests_gpexe_k2ab_*):
// the GPEXE legacy scaffold, the Tests v42 files, the training_load /
// training / calendar files through v49 plus v6 / v8, through the real
// runner; dropped at the end. Nothing touches OPTIMOVE or any persistent
// database. The real Express app is driven over HTTP with real session
// cookies.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const V49 = "202610311000_calendar_v49_events.sql";
const TESTS_MIGRATIONS = [
  "202608220900_tests_v42_schema.sql",
  "202608221000_tests_v42_seed_wellness_fms.sql",
  "202608240900_tests_v42_phase1_scheduling_execution.sql",
  "202608250900_tests_v42_presentation_metadata.sql",
  "202608250901_tests_v42_supersede_generated_column_fix.sql",
  "202608260900_tests_v42_occurrence_generation_lock_fix.sql",
  "202608300900_tests_v42_phase4_assignment_timezone_window.sql",
];
const EXTRA_TRAINING_LOAD_MIGRATIONS = [
  "202609011200_training_load_v6_external_schedule_event_type.sql",
  "202609030900_training_load_v8_specific_dates_group.sql",
];
const MIGRATIONS = [...TESTS_MIGRATIONS, ...GPEXE_TEST_MIGRATIONS, ...EXTRA_TRAINING_LOAD_MIGRATIONS].sort();
const WELLNESS_TEST_VERSION_ID = "7a386bd1-d25e-4651-9012-e76d9dc32559";
const TZ = "Europe/Belgrade";

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

let db;
let admin;
let server;
let apiBase;
let appPool;
let createSession;
let eventService;

const uid = () => crypto.randomBytes(4).toString("hex");
const newKey = () => crypto.randomUUID();
async function q(sql, params = []) {
  return (await admin.query(sql, params)).rows;
}

// ---------------------------------------------------------------------------
// Fixtures (the K1a suite's helpers)
// ---------------------------------------------------------------------------
async function makeClub(label = "Club") {
  const id = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} ${uid()}`]))[0].id;
  await q(`select calendar.seed_club_event_types($1)`, [id]);
  return id;
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
  return (await q(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,$4,'active',$5) returning id`,
    [athleteId, clubId, teamId, type, startsAt],
  ))[0].id;
}
async function archiveMembership(membershipId, archivedAt) {
  await q(`update public.athlete_memberships set status = 'archived', archived_at = $2, updated_at = now() where id = $1`, [membershipId, archivedAt]);
}
async function teamMembershipId(athleteId, teamId) {
  return (await q(`select id from public.athlete_memberships where athlete_id = $1 and team_id = $2 and membership_type = 'team'`, [athleteId, teamId]))[0].id;
}
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
async function makeExternalSchedule({ owner, createdBy, startDate = PAST, eventName = "Away match", status = "active", targets = [] }) {
  const o = ownerColumns(owner);
  const id = (await q(
    `insert into training_load.external_schedules (schedule_kind, timezone, start_date, end_date, recurrence_rule, opens_time, closes_time, status, event_name, event_type, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ('one_time','UTC',$1,null,null,'17:00','23:59',$2,$3,'match',$4,$5,$6,$7,$8) returning id`,
    [startDate, status, eventName, createdBy, o.owner_scope, o.owner_user_id, o.owner_club_id, o.owner_team_id],
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
async function makeTestSchedule({ owner, createdBy, startDate = PAST, status = "active", targets = [] }) {
  const o = ownerColumns(owner);
  const id = (await q(
    `insert into tests.test_schedules (test_version_id, schedule_kind, timezone, start_date, end_date, recurrence_rule, opens_time, closes_time, status, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ($1,'one_time','UTC',$2,null,null,'07:00','09:00',$3,$4,$5,$6,$7,$8) returning id`,
    [WELLNESS_TEST_VERSION_ID, startDate, status, createdBy, o.owner_scope, o.owner_user_id, o.owner_club_id, o.owner_team_id],
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
const eventCards = (res, eventId) => ofKind(allItems(res), "event").filter((i) => i.eventId === eventId || i.links?.eventId === eventId);
// The statements of a runbook SQL file (comment lines dropped, split at the
// statement ends), each run as the owner would run a block.
async function runbookBlocks(client, file) {
  const text = await fsp.readFile(path.resolve(__dirname, "../../docs/runbooks", file), "utf8");
  const statements = text.split(/\r?\n/).filter((line) => !line.trim().startsWith("--")).join("\n")
    .split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  const rows = [];
  for (const statement of statements) rows.push((await client.query(statement)).rows[0]);
  return rows;
}
async function rowDigests(tables) {
  const out = {};
  for (const t of tables) {
    const r = (await q(`select count(*)::int as n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as d from ${t} x`))[0];
    out[t] = `${r.n}:${r.d}`;
  }
  return out;
}
const typesOf = (cookie) => api("/api/calendar/events/types", { cookie });
const createEvent = (cookie, body) => api("/api/calendar/events", { method: "POST", cookie, body: { requestKey: newKey(), timezone: TZ, ...body } });
const patchEvent = (cookie, id, body) => api(`/api/calendar/events/${id}`, { method: "PATCH", cookie, body: { requestKey: newKey(), ...body } });
const cancelEvent = (cookie, id, body = {}) => api(`/api/calendar/events/${id}/cancel`, { method: "POST", cookie, body: { requestKey: newKey(), ...body } });
const getEvent = (cookie, id) => api(`/api/calendar/events/${id}`, { cookie });
async function typeOf(cookie, kind) {
  const res = await typesOf(cookie);
  assert.equal(res.status, 200, res.text);
  return res.body.types.find((t) => t.kind === kind);
}

// A club with two teams, their coaches, the club's admin, two athletes in
// team 1 (members since 2026-01-01), one in team 2.
async function clubFixture(label) {
  const clubId = await makeClub(`${label} club`);
  const team1 = await makeTeam(clubId, `${label} T1`);
  const team2 = await makeTeam(clubId, `${label} T2`);
  const clubAdmin = await clubAdminOf(clubId, `${label} admin`);
  const coach1 = await coachOf(team1, `${label} coach 1`);
  const coach2 = await coachOf(team2, `${label} coach 2`);
  const a1 = await makeAthlete(`${label} A1`, { clubId, teamId: team1 });
  const a2 = await makeAthlete(`${label} A2`, { clubId, teamId: team1 });
  const a3 = await makeAthlete(`${label} A3`, { clubId, teamId: team2 });
  return { clubId, team1, team2, clubAdmin, coach1, coach2, a1, a2, a3 };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "k2ab", migrations: MIGRATIONS });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  await admin.query(`alter table plans.plans add column if not exists builder_batch_id uuid`);
  // The scaffold's public.clubs carries only the columns the calendar reads;
  // POST /api/organization/clubs (test 14) writes the real table's columns.
  await admin.query(`alter table public.clubs
    add column if not exists short_name text, add column if not exists logo_url text, add column if not exists city text,
    add column if not exists country text, add column if not exists updated_at timestamptz not null default now()`);
  assert.ok((await q(`select to_regclass('calendar.events') as t`))[0].t, "v49 is applied");
  assert.ok((await q(`select to_regclass('tests.test_schedules') as t`))[0].t, "the Tests schema is applied");

  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  eventService = await import("../src/calendarEventService.js");
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app pool is on the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (appPool) await appPool.end().catch(() => {});
  if (admin) await admin.end().catch(() => {});
  if (db) await db.drop();
});


// ---------------------------------------------------------------------------
// K2a-1b fixtures: weekly plans (the K1a suite's helpers)
// ---------------------------------------------------------------------------
async function makePlan({ athleteId, coachUserId, owner, batchId = null, weekStart = FROM, status = "active", editSourcePlanId = null }) {
  const planId = (await q(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, week_start, is_active, is_edit_draft, edit_source_plan_id, builder_batch_id)
     values ('weekly',$1,$2,'Week',$3,$4,true,$5,$6,$7) returning id`,
    [coachUserId, athleteId, status, weekStart, Boolean(editSourcePlanId), editSourcePlanId, batchId],
  ))[0].id;
  if (owner) {
    const o = ownerColumns(owner);
    await q(
      `insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_user_id, owner_club_id, owner_team_id) values ($1,$2,$3,$4,$5)`,
      [planId, o.owner_scope, o.owner_user_id, o.owner_club_id, o.owner_team_id],
    );
  }
  return planId;
}
async function makeSession({ planId, date, name = "Team training", amPm = "PM", bta = "T", order = 1, time = "18:00", rpeEnabled = true, tlEnabled = true, logicalSessionId = crypto.randomUUID() }) {
  const dayId = (await q(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [planId, date]))[0].id;
  const sessionId = (await q(
    `insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order, session_time, rpe_enabled, training_load_enabled, logical_session_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [dayId, name, amPm, bta, order, time, rpeEnabled && tlEnabled, tlEnabled, logicalSessionId],
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
async function submitRpe(athlete, sessionId, { rpe = 7, durationMinutes = 75 } = {}) {
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe, durationMinutes } });
  assert.equal(res.status, 201, res.text);
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
  await q(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,$3,$4,'participated')`,
    [activityId, athleteId, date, tz],
  );
}
// One plan and one session per athlete, the same day, slot and name.
async function plansFor(athletes, { owner, coachUserId, date = PAST, name = "Team training", amPm = "PM", bta = "T", order = 1, time = "18:00", rpeEnabled = true, tlEnabled = true, batchId = null }) {
  const out = [];
  for (const athlete of athletes) {
    const planId = await makePlan({ athleteId: athlete.athleteId, coachUserId, owner, batchId });
    const session = await makeSession({ planId, date, name, amPm, bta, order, time, rpeEnabled, tlEnabled });
    out.push({ athlete, planId, ...session });
  }
  return out;
}
// A club with team X (three athletes) and team Y (two), the coaches, the
// club's admin; planned RPE on for team X and the club.
async function squad(label) {
  const clubId = await makeClub(`${label} club`);
  const teamX = await makeTeam(clubId, `${label} X`);
  const teamY = await makeTeam(clubId, `${label} Y`);
  const clubAdmin = await clubAdminOf(clubId, `${label} admin`);
  const coachX = await coachOf(teamX, `${label} coach X`);
  const coachY = await coachOf(teamY, `${label} coach Y`);
  const x = [];
  for (const n of ["X1", "X2", "X3"]) x.push(await makeAthlete(`${label} ${n}`, { clubId, teamId: teamX }));
  const y = [];
  for (const n of ["Y1", "Y2"]) y.push(await makeAthlete(`${label} ${n}`, { clubId, teamId: teamY }));
  await enablePlannedRpe({ scope: "team", teamId: teamX });
  await enablePlannedRpe({ scope: "club", clubId });
  return { clubId, teamX, teamY, clubAdmin, coachX, coachY, x, y };
}
const plannedOn = (res, date) => ofKind(itemsOn(res, date), "planned");
const attachSessions = (cookie, eventId, body) => api(`/api/calendar/events/${eventId}/sessions`, { method: "POST", cookie, body: { requestKey: newKey(), ...body } });
const detachSessions = (cookie, eventId, body) => api(`/api/calendar/events/${eventId}/sessions/detach`, { method: "POST", cookie, body: { requestKey: newKey(), ...body } });
const alignSessions = (cookie, eventId, body) => api(`/api/calendar/events/${eventId}/sessions/align`, { method: "POST", cookie, body: { requestKey: newKey(), ...body } });
const attachActivity = (cookie, eventId, body) => api(`/api/calendar/events/${eventId}/activities`, { method: "POST", cookie, body: { requestKey: newKey(), ...body } });
const detachActivity = (cookie, eventId, body) => api(`/api/calendar/events/${eventId}/activities/detach`, { method: "POST", cookie, body: { requestKey: newKey(), ...body } });
const NOT_FOUND = JSON.stringify({ error: "notFound", message: "Not found." });
async function teamEvent(s, { title = "Team training", day = PAST, endDay, expects, kind = "training" } = {}) {
  const type = await typeOf(s.coachX.cookie, kind);
  const res = await createEvent(s.coachX.cookie, { eventTypeId: type.id, title, day, endDay, expects, targets: [{ kind: "team", id: s.teamX }] });
  assert.equal(res.status, 201, res.text);
  return res.body.event;
}
async function clubEvent(s, { title = "Club training", day = PAST, endDay, expects, kind = "training", targets } = {}) {
  const type = await typeOf(s.clubAdmin.cookie, kind);
  const res = await createEvent(s.clubAdmin.cookie, { eventTypeId: type.id, title, day, endDay, expects, targets: targets || [{ kind: "club", id: s.clubId }] });
  assert.equal(res.status, 201, res.text);
  return res.body.event;
}
async function countingStatements(run) {
  const original = appPool.query;
  let count = 0;
  appPool.query = function counted(...args) {
    count += 1;
    return original.apply(this, args);
  };
  try {
    await run();
  } finally {
    appPool.query = original;
  }
  return count;
}
const flagsOf = async (sessionId) => (await q(`select rpe_enabled, training_load_enabled from plans.plan_sessions where id = $1`, [sessionId]))[0];
const liveLinks = async (eventId) => (await q(`select count(*)::int as n from calendar.event_session_links where event_id = $1 and ended_at is null`, [eventId]))[0].n;

// ---------------------------------------------------------------------------
// D16b — the planned groups
// ---------------------------------------------------------------------------
test("1. D16b: 17 plans made one by one with one owner, day, slot and name are ONE card of 17 athletes; the title is the most common spelling; another name, another slot and a plan without a resolved owner are cards of their own; the key carries no id", async () => {
  const clubId = await makeClub("d16 club");
  const teamId = await makeTeam(clubId, "d16 team");
  const coach = await coachOf(teamId, "d16 coach");
  await enablePlannedRpe({ scope: "team", teamId });
  const athletes = [];
  for (let i = 0; i < 17; i += 1) athletes.push(await makeAthlete(`d16 A${String(i).padStart(2, "0")}`, { clubId, teamId }));
  const spellings = [...Array(10).fill("Team training"), ...Array(4).fill("  team training "), ...Array(3).fill("TEAM TRAINING ")];
  const owner = { scope: "team", teamId };
  const sessions = [];
  for (let i = 0; i < 17; i += 1) sessions.push(...await plansFor([athletes[i]], { owner, coachUserId: coach.id, name: spellings[i] }));
  let res = await calendar(coach.cookie, { extra: "&kinds=planned" });
  let cards = plannedOn(res, PAST);
  assert.equal(cards.length, 1, "one card, not seventeen");
  assert.equal(cards[0].athleteCount, 17);
  assert.equal(cards[0].title, "Team training");
  assert.equal(cards[0].startTime, "18:00");
  assert.deepEqual(cards[0].rpe, { asked: 17, submitted: 0 });
  for (const forbidden of [teamId, clubId, coach.id, ...sessions.map((x) => x.planId)]) assert.equal(cards[0].key.includes(forbidden), false, "the key carries no owner or plan id");
  // One session at another time: the card shows no time.
  await q(`update plans.plan_sessions set session_time = '18:30' where id = $1`, [sessions[0].sessionId]);
  res = await calendar(coach.cookie, { extra: "&kinds=planned" });
  assert.equal(plannedOn(res, PAST)[0].startTime, null, "different times: the slot words, never a wrong time");
  // Another name, another slot: their own cards.
  await plansFor([athletes[0]], { owner, coachUserId: coach.id, name: "Recovery" });
  await plansFor([athletes[1]], { owner, coachUserId: coach.id, name: "Team training", amPm: "AM" });
  // A plan without a resolved owner, and one without an ownership row: groups of one.
  const unresolvedA = await makePlan({ athleteId: athletes[2].athleteId, coachUserId: coach.id, owner: null });
  await q(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope) values ($1, 'unresolved')`, [unresolvedA]);
  await makeSession({ planId: unresolvedA, date: PAST, name: "Legacy" });
  const unresolvedB = await makePlan({ athleteId: athletes[3].athleteId, coachUserId: coach.id, owner: null });
  await q(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope) values ($1, 'unresolved')`, [unresolvedB]);
  await makeSession({ planId: unresolvedB, date: PAST, name: "Legacy" });
  res = await calendar(coach.cookie, { extra: "&kinds=planned" });
  cards = plannedOn(res, PAST);
  const titles = cards.map((c) => `${c.title}|${c.slot.amPm}|${c.athleteCount}`).sort();
  assert.deepEqual(titles, ["Legacy|PM|1", "Legacy|PM|1", "Recovery|PM|1", "Team training|AM|1", "Team training|PM|17"].sort());
});

test("2. D16b over the scope: a team's and the club's plans of one name are two cards; team X's coach sees only X's athletes of a club group and nothing of Y; the athlete sees own rows; RPE x/y counts only the sessions that ask", async () => {
  const s = await squad("own");
  const club = { scope: "club", clubId: s.clubId };
  const clubPlans = [
    ...await plansFor(s.x, { owner: club, coachUserId: s.clubAdmin.id }),
    ...await plansFor(s.y, { owner: club, coachUserId: s.clubAdmin.id }),
  ];
  // One club session that does not ask RPE: the group mixes rpe_enabled.
  await q(`update plans.plan_sessions set rpe_enabled = false where id = $1`, [clubPlans[4].sessionId]);
  await plansFor(s.x, { owner: { scope: "team", teamId: s.teamX }, coachUserId: s.coachX.id });
  await submitRpe(s.x[0], clubPlans[0].sessionId);

  const byAdmin = plannedOn(await calendar(s.clubAdmin.cookie, { extra: "&kinds=planned" }), PAST);
  assert.equal(byAdmin.length, 2, "the club's group and team X's group");
  const adminClub = byAdmin.find((c) => c.athleteCount === 5);
  assert.ok(adminClub, "the club group holds X's and Y's athletes");
  assert.deepEqual(adminClub.rpe, { asked: 4, submitted: 1 }, "x/y over the four sessions that ask");

  const xRes = await calendar(s.coachX.cookie, { extra: "&kinds=planned&include=athletes" });
  const byX = plannedOn(xRes, PAST);
  assert.equal(byX.length, 2);
  assert.ok(byX.every((c) => c.athleteCount === 3));
  for (const forbidden of [...s.y.map((a) => a.athleteId), ...s.y.map((a) => a.name)]) {
    assert.equal(xRes.text.includes(forbidden), false, `team X's coach never sees ${forbidden}`);
  }
  const byY = plannedOn(await calendar(s.coachY.cookie, { extra: "&kinds=planned" }), PAST);
  assert.equal(byY.length, 1, "team Y's coach: the club group with Y's athletes only");
  assert.equal(byY[0].athleteCount, 2);
  assert.equal(byY[0].rpe.asked, 1, "Y2's session does not ask");

  const athleteRes = await calendar(s.x[1].cookie, { extra: "&include=athletes" });
  const own = plannedOn(athleteRes, PAST);
  assert.equal(own.length, 2);
  assert.ok(own.every((c) => c.athleteCount === 1 && c.athleteIds[0] === s.x[1].athleteId));
  for (const other of [s.x[0], s.x[2], ...s.y]) assert.equal(athleteRes.text.includes(other.athleteId), false);
});

test("3. a wide range is the union of its days, for planned groups and for an event with linked groups; the statement count does not depend on the size of a group or on the number of links", async () => {
  const s = await squad("wide");
  const club = { scope: "club", clubId: s.clubId };
  const d1 = addDays(PAST, -1);
  const day1 = await plansFor([...s.x, ...s.y], { owner: club, coachUserId: s.clubAdmin.id, date: d1 });
  const day2 = await plansFor([...s.x, ...s.y], { owner: club, coachUserId: s.clubAdmin.id, date: PAST });
  const ev = await clubEvent(s, { day: d1, endDay: PAST });
  const attached = await attachSessions(s.clubAdmin.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [...day1, ...day2].filter((x) => s.x.includes(x.athlete)).map((x) => x.logicalSessionId) });
  assert.equal(attached.status, 200, attached.text);
  for (const viewer of [s.coachX, s.coachY, s.clubAdmin]) {
    const wide = await calendar(viewer.cookie, { from: addDays(d1, -1), to: addDays(PAST, 1), extra: "&include=athletes" });
    for (const day of [d1, PAST]) {
      const single = await calendar(viewer.cookie, { from: day, to: day, extra: "&include=athletes" });
      const shape = (items) => items.map((i) => `${i.kind}|${i.key}|${[...(i.athleteIds || [])].sort().join(",")}|${JSON.stringify(i.rpe)}`).sort();
      assert.deepEqual(shape(itemsOn(wide, day)), shape(itemsOn(single, day)), `wide == the day ${day}`);
    }
  }
  // Statements: a group of one against a group of six, and one link against many.
  const solo = await squad("stmt1");
  await plansFor([solo.x[0]], { owner: { scope: "club", clubId: solo.clubId }, coachUserId: solo.clubAdmin.id });
  const soloEvent = await clubEvent(solo);
  const one = await attachSessions(solo.clubAdmin.cookie, soloEvent.id, { expectedRevision: 1, logicalSessionIds: (await plansFor([solo.x[1]], { owner: { scope: "club", clubId: solo.clubId }, coachUserId: solo.clubAdmin.id })).map((x) => x.logicalSessionId) });
  assert.equal(one.status, 200, one.text);
  const small = await countingStatements(async () => assert.equal((await calendar(solo.clubAdmin.cookie)).status, 200));
  const big = await squad("stmt2");
  await plansFor([...big.x, ...big.y], { owner: { scope: "club", clubId: big.clubId }, coachUserId: big.clubAdmin.id });
  const bigEvent = await clubEvent(big);
  const many = await attachSessions(big.clubAdmin.cookie, bigEvent.id, { expectedRevision: 1, logicalSessionIds: (await plansFor([...big.x, ...big.y], { owner: { scope: "club", clubId: big.clubId }, coachUserId: big.clubAdmin.id, name: "Second" })).map((x) => x.logicalSessionId) });
  assert.equal(many.status, 200, many.text);
  const large = await countingStatements(async () => assert.equal((await calendar(big.clubAdmin.cookie)).status, 200));
  assert.equal(large, small, `the same number of statements for one and for five plans per group and link set (${small})`);
});

// ---------------------------------------------------------------------------
// Attaching planned sessions (plan 2.1 (a), 2.2, 2.3)
// ---------------------------------------------------------------------------
test("4. attach: a group folds under its event — RPE x/y, per-athlete states, the RPE activity, the plans; requestKey replay and reuse, a stale revision, an idempotent re-attach; the athlete keeps their own card", async () => {
  const s = await squad("att");
  const team = { scope: "team", teamId: s.teamX };
  const group = await plansFor(s.x, { owner: team, coachUserId: s.coachX.id });
  await submitRpe(s.x[0], group[0].sessionId);
  const ev = await teamEvent(s);
  const before = await calendar(s.coachX.cookie);
  const card = plannedOn(before, PAST)[0];
  assert.equal(card.athleteCount, 3);
  const key = newKey();
  const body = { requestKey: key, expectedRevision: 1, logicalSessionIds: card.links.logicalSessionIds };
  const res = await api(`/api/calendar/events/${ev.id}/sessions`, { method: "POST", cookie: s.coachX.cookie, body });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.attached, 3);
  assert.equal(res.body.event.revision, 2);
  assert.equal(res.body.event.sessionLinks.length, 3);
  assert.ok(res.body.event.sessionLinks.every((l) => l.state === "linked" && l.aligned === true));
  const change = (await q(`select kind, basis, revision, details from calendar.event_changes where event_id = $1 order by revision desc limit 1`, [ev.id]))[0];
  assert.equal(change.kind, "attach_sessions");
  assert.equal(change.basis, "team_coach");
  assert.equal(change.revision, 2);
  assert.equal(change.details.sessions, 3);

  const after = await calendar(s.coachX.cookie, { extra: "&include=athletes" });
  assert.equal(plannedOn(after, PAST).length, 0, "the group is folded, never emitted alone");
  const evCard = eventCards(after, ev.id)[0];
  assert.deepEqual(evCard.rpe, { asked: 3, submitted: 1 });
  assert.equal(evCard.status, "awaiting_entry");
  assert.deepEqual([...evCard.links.planIds].sort(), group.map((x) => x.planId).sort());
  assert.equal(evCard.links.activityIds.length, 1, "the RPE activity folds under the event");
  assert.equal(evCard.athletes.find((a) => a.athleteId === s.x[0].athleteId).rpe, "submitted");
  assert.equal(evCard.athletes.find((a) => a.athleteId === s.x[1].athleteId).rpe, "missing");
  assert.equal(evCard.alignment.pending, 0);
  // A response without the event cards folds nothing: the linked group is its
  // own planned card there, never gone (security review, MEDIUM-3).
  const plannedOnly = await calendar(s.coachX.cookie, { extra: "&kinds=planned" });
  assert.equal(plannedOn(plannedOnly, PAST).length, 1, "kinds=planned shows the linked group as a planned card");
  assert.equal(plannedOn(plannedOnly, PAST)[0].athleteCount, 3);
  assert.equal(eventCards(plannedOnly, ev.id).length, 0);

  // The same key and body: the saved request, nothing written again, the
  // first answer's counts repeated (code review, LOW).
  const replay = await api(`/api/calendar/events/${ev.id}/sessions`, { method: "POST", cookie: s.coachX.cookie, body });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.attached, 3);
  assert.equal(replay.body.alreadyAttached, 0);
  assert.equal(await liveLinks(ev.id), 3);
  assert.equal((await q(`select count(*)::int as n from calendar.event_requests where request_key = $1`, [key]))[0].n, 1);
  const reused = await api(`/api/calendar/events/${ev.id}/sessions`, { method: "POST", cookie: s.coachX.cookie, body: { ...body, logicalSessionIds: body.logicalSessionIds.slice(1) } });
  assert.equal(reused.status, 409, reused.text);
  assert.equal(reused.body.error, "request_key_reused");
  const stale = await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: body.logicalSessionIds });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.body.error, "event_changed");
  const again = await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 2, logicalSessionIds: body.logicalSessionIds });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.attached, 0);
  assert.equal(again.body.alreadyAttached, 3);
  assert.equal(await liveLinks(ev.id), 3);

  // The athlete workspace folds nothing: own planned card and the event card.
  const athleteRes = await calendar(s.x[1].cookie);
  assert.equal(plannedOn(athleteRes, PAST).length, 1);
  assert.equal(eventCards(athleteRes, ev.id).length, 1);
  assert.equal(JSON.stringify(eventCards(athleteRes, ev.id)[0]).includes("planIds"), false);
});

test("5. attach refuses: a non-target athlete, a session outside the scope (byte-identical to a random id), another day, a session attached elsewhere, a cancelled event, a bad body; a stranger and an athlete get the one 404", async () => {
  const s = await squad("ref");
  const club = { scope: "club", clubId: s.clubId };
  const xPlans = await plansFor(s.x, { owner: club, coachUserId: s.clubAdmin.id });
  const yPlans = await plansFor(s.y, { owner: club, coachUserId: s.clubAdmin.id });
  const ev = await teamEvent(s);
  // The club admin (D18) sees Y's sessions, but Y is no target of team X's event.
  const notTarget = await attachSessions(s.clubAdmin.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [yPlans[0].logicalSessionId] });
  assert.equal(notTarget.status, 409, notTarget.text);
  assert.equal(notTarget.body.error, "athlete_not_targeted");
  // Team X's coach never reaches team Y's session: the same answer as a random id.
  const foreign = await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [yPlans[0].logicalSessionId] });
  const random = await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [crypto.randomUUID()] });
  assert.equal(foreign.status, 400, foreign.text);
  assert.equal(foreign.body.error, "session_not_available");
  assert.equal(foreign.text, random.text);
  const mixed = await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [xPlans[0].logicalSessionId, yPlans[1].logicalSessionId] });
  assert.equal(mixed.text, random.text, "one foreign id refuses the whole request");
  assert.equal(await liveLinks(ev.id), 0);
  // Another day.
  const other = await plansFor([s.x[0]], { owner: club, coachUserId: s.clubAdmin.id, date: addDays(PAST, -1), name: "Other day" });
  const outside = await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [other[0].logicalSessionId] });
  assert.equal(outside.status, 409, outside.text);
  assert.equal(outside.body.error, "session_outside_event");
  // Attached to another event.
  const ev2 = await teamEvent(s, { title: "Second" });
  assert.equal((await attachSessions(s.coachX.cookie, ev2.id, { expectedRevision: 1, logicalSessionIds: [xPlans[0].logicalSessionId] })).status, 200);
  const taken = await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [xPlans[0].logicalSessionId] });
  assert.equal(taken.status, 409, taken.text);
  assert.equal(taken.body.error, "session_already_attached");
  // Bad bodies.
  for (const bad of [{ logicalSessionIds: [] }, { logicalSessionIds: ["x"] }, { logicalSessionIds: Array.from({ length: 201 }, () => crypto.randomUUID()) }, {}]) {
    const r = await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, ...bad });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.body.error, "invalid_sessions");
  }
  assert.equal((await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [xPlans[1].logicalSessionId], alignSessions: "yes" })).body.error, "invalid_align");
  // Strangers: another club's admin, the athlete, team Y's coach — the one 404 body.
  const stranger = await clubAdminOf(await makeClub("ref other"));
  for (const who of [stranger, s.x[0], s.coachY]) {
    for (const call of [attachSessions, detachSessions, alignSessions]) {
      const r = await call(who.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [xPlans[1].logicalSessionId], linkIds: [crypto.randomUUID()] });
      assert.equal(r.status, 404, r.text);
      assert.equal(r.text, NOT_FOUND);
    }
  }
  // A cancelled event takes no link.
  assert.equal((await cancelEvent(s.coachX.cookie, ev.id, { expectedRevision: 1 })).status, 200);
  const cancelled = await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 2, logicalSessionIds: [xPlans[1].logicalSessionId] });
  assert.equal(cancelled.status, 409, cancelled.text);
  assert.equal(cancelled.body.error, "event_cancelled");
});

test("6. a group that changes after the attach is never silent: a new member stays a planned card beside the event; a renamed session is counted renamed; a session moved to another slot is an orphaned link and its own card; detach brings the group back; a cancelled event folds nothing", async () => {
  const s = await squad("chg");
  const team = { scope: "team", teamId: s.teamX };
  const group = await plansFor(s.x, { owner: team, coachUserId: s.coachX.id });
  const ev = await teamEvent(s);
  assert.equal((await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: group.map((x) => x.logicalSessionId) })).status, 200);
  // A fourth athlete joins team X with the same training.
  const x4 = await makeAthlete("chg X4", { clubId: s.clubId, teamId: s.teamX });
  await plansFor([x4], { owner: team, coachUserId: s.coachX.id });
  let res = await calendar(s.coachX.cookie);
  let planned = plannedOn(res, PAST);
  assert.equal(planned.length, 1, "the new member's session is a planned card beside the event");
  assert.deepEqual(planned[0].athleteIds, [x4.athleteId]);
  // A rename and a slot move in the Builder.
  await q(`update plans.plan_sessions set name = 'Speed' where id = $1`, [group[1].sessionId]);
  await q(`update plans.plan_sessions set am_pm = 'AM' where id = $1`, [group[2].sessionId]);
  res = await calendar(s.coachX.cookie);
  const evCard = eventCards(res, ev.id)[0];
  assert.equal(evCard.links.renamedSessionLinks, 1);
  assert.equal(evCard.links.orphanedSessionLinks, 1);
  assert.equal(evCard.athleteCount, 4, "the targets of the day: X4 joined team X, a target too");
  planned = plannedOn(res, PAST);
  assert.equal(planned.length, 2, "X4's group and the moved session's own AM card");
  assert.ok(planned.some((c) => c.slot.amPm === "AM" && c.athleteIds[0] === s.x[2].athleteId));
  const view = (await getEvent(s.coachX.cookie, ev.id)).body.event;
  const states = Object.fromEntries(view.sessionLinks.map((l) => [l.planId, l.state]));
  assert.equal(states[group[0].planId], "linked");
  assert.equal(states[group[1].planId], "renamed");
  assert.equal(states[group[2].planId], "orphaned");
  // Detach the renamed and the orphaned link.
  const detached = await detachSessions(s.coachX.cookie, ev.id, { expectedRevision: 2, linkIds: view.sessionLinks.filter((l) => l.state !== "linked").map((l) => l.id) });
  assert.equal(detached.status, 200, detached.text);
  assert.equal(detached.body.detached, 2);
  assert.equal((await q(`select kind from calendar.event_changes where event_id = $1 order by revision desc limit 1`, [ev.id]))[0].kind, "detach_sessions");
  const unknownLink = await detachSessions(s.coachX.cookie, ev.id, { expectedRevision: 3, linkIds: [view.sessionLinks[0].id, crypto.randomUUID()] });
  assert.equal(unknownLink.status, 400, unknownLink.text);
  assert.equal(unknownLink.body.error, "link_not_available");
  res = await calendar(s.coachX.cookie);
  assert.equal(eventCards(res, ev.id)[0].links.orphanedSessionLinks, 0);
  assert.ok(plannedOn(res, PAST).some((c) => c.title === "Speed"), "the renamed session is a planned card again");
  // A cancelled event folds nothing: X1's session is a planned card again.
  assert.equal((await cancelEvent(s.coachX.cookie, ev.id, { expectedRevision: 3 })).status, 200);
  res = await calendar(s.coachX.cookie);
  assert.ok(plannedOn(res, PAST).some((c) => c.athleteIds.includes(s.x[0].athleteId)));
});

// ---------------------------------------------------------------------------
// D20 — aligning the linked sessions' flags (option A)
// ---------------------------------------------------------------------------
test("7. align: the event's expects become the linked sessions' flags, only on plans the workspace manages, the edit-draft copy too; the switch is never touched; until then the panel shows the pending count and a gap, never an alarm", async () => {
  const s = await squad("aln");
  const club = { scope: "club", clubId: s.clubId };
  const p = await privateCoach("aln private");
  await q(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', true)`, [p.id, s.x[2].athleteId]);
  const clubPlans = await plansFor([s.x[0], s.x[1]], { owner: club, coachUserId: s.clubAdmin.id, rpeEnabled: false, tlEnabled: false });
  const teamPlan = await plansFor([s.y[0]], { owner: { scope: "team", teamId: s.teamY }, coachUserId: s.coachY.id, rpeEnabled: false, tlEnabled: false });
  const privatePlan = await plansFor([s.x[2]], { owner: { scope: "user", userId: p.id }, coachUserId: p.id, rpeEnabled: false, tlEnabled: false });
  // An open edit-draft of the first club plan carries its own copy of the session.
  const draft = await makePlan({ athleteId: s.x[0].athleteId, coachUserId: s.clubAdmin.id, owner: null, status: "draft", editSourcePlanId: clubPlans[0].planId });
  const draftSession = await makeSession({ planId: draft, date: PAST, rpeEnabled: false, tlEnabled: false, logicalSessionId: clubPlans[0].logicalSessionId });
  const all = [...clubPlans, ...teamPlan];
  const switchesBefore = await rowDigests(["training_load.planned_rpe_workspace_settings"]);
  const ev = await clubEvent(s);
  // The private coach's plan of a club athlete is outside the club's tree:
  // the club admin sees it, but it never folds under the club's event — the
  // answer of an id the caller cannot see (security review, MEDIUM-1).
  const privateRefused = await attachSessions(s.clubAdmin.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [privatePlan[0].logicalSessionId] });
  const randomRefused = await attachSessions(s.clubAdmin.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [crypto.randomUUID()] });
  assert.equal(privateRefused.status, 400, privateRefused.text);
  assert.equal(privateRefused.text, randomRefused.text);
  assert.equal((await attachSessions(s.clubAdmin.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: all.map((x) => x.logicalSessionId) })).status, 200);
  let res = await calendar(s.clubAdmin.cookie);
  let evCard = eventCards(res, ev.id)[0];
  assert.equal(evCard.alignment.pending, 3);
  assert.deepEqual(evCard.gaps, ["rpe"], "RPE expected, nothing asks yet: a gap");
  assert.notEqual(evCard.status, "awaiting_entry");
  const view = (await getEvent(s.clubAdmin.cookie, ev.id)).body.event;
  assert.equal(view.alignment.pending, 3);
  // The team coach of Y may not manage the club's event.
  assert.equal((await alignSessions(s.coachY.cookie, ev.id, { expectedRevision: 2 })).status, 404);
  const aligned = await alignSessions(s.clubAdmin.cookie, ev.id, { expectedRevision: 2 });
  assert.equal(aligned.status, 200, aligned.text);
  assert.deepEqual(aligned.body.alignment, { direction: "rpe_on", changed: 2, unchanged: 0, notAllowed: 1, switchOff: 0 });
  for (const x of clubPlans) assert.deepEqual(await flagsOf(x.sessionId), { rpe_enabled: true, training_load_enabled: true });
  assert.deepEqual(await flagsOf(draftSession.sessionId), { rpe_enabled: true, training_load_enabled: true }, "the edit-draft copy follows");
  for (const x of [...teamPlan, ...privatePlan]) assert.deepEqual(await flagsOf(x.sessionId), { rpe_enabled: false, training_load_enabled: false }, "a plan the club only reads is not changed");
  assert.deepEqual(await rowDigests(["training_load.planned_rpe_workspace_settings"]), switchesBefore, "the workspace switch is never touched");
  const change = (await q(`select kind, details from calendar.event_changes where event_id = $1 order by revision desc limit 1`, [ev.id]))[0];
  assert.equal(change.kind, "update");
  assert.equal(change.details.align, "rpe_on");
  assert.equal(change.details.aligned, 2);
  res = await calendar(s.clubAdmin.cookie);
  evCard = eventCards(res, ev.id)[0];
  assert.equal(evCard.alignment.pending, 1);
  assert.deepEqual(evCard.rpe, { asked: 2, submitted: 0 });
  assert.deepEqual(evCard.gaps, []);
  // Turning RPE off (the event no longer expects it): a session with results needs the confirmation.
  await submitRpe(s.x[0], clubPlans[0].sessionId);
  assert.equal((await patchEvent(s.clubAdmin.cookie, ev.id, { expectedRevision: 3, expects: [] })).status, 200);
  const refused = await alignSessions(s.clubAdmin.cookie, ev.id, { expectedRevision: 4 });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.body.error, "has_existing_results");
  assert.equal(refused.body.resultCount, 1);
  assert.deepEqual(await flagsOf(clubPlans[1].sessionId), { rpe_enabled: true, training_load_enabled: true }, "nothing written");
  const off = await alignSessions(s.clubAdmin.cookie, ev.id, { expectedRevision: 4, confirmDisableWithResults: true });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.body.alignment.direction, "rpe_off");
  assert.equal(off.body.alignment.changed, 2);
  for (const x of clubPlans) assert.deepEqual(await flagsOf(x.sessionId), { rpe_enabled: false, training_load_enabled: true }, "tracking stays");
  // An event without a linked session has nothing to align.
  const empty = await clubEvent(s, { title: "Empty" });
  const nothing = await alignSessions(s.clubAdmin.cookie, empty.id, { expectedRevision: 1 });
  assert.equal(nothing.status, 409, nothing.text);
  assert.equal(nothing.body.error, "nothing_to_align");
});

test("8. attach with alignSessions aligns the named sessions in the same command (audited as attach_sessions); a workspace whose switch is off is reported, never flipped", async () => {
  const clubId = await makeClub("sw club");
  const teamId = await makeTeam(clubId, "sw team");
  const coach = await coachOf(teamId, "sw coach");
  const athletes = [await makeAthlete("sw A", { clubId, teamId }), await makeAthlete("sw B", { clubId, teamId })];
  const plans = await plansFor(athletes, { owner: { scope: "team", teamId }, coachUserId: coach.id, rpeEnabled: false, tlEnabled: false });
  const type = await typeOf(coach.cookie, "training");
  const ev = (await createEvent(coach.cookie, { eventTypeId: type.id, title: "Training", day: PAST, targets: [{ kind: "team", id: teamId }] })).body.event;
  const body = { requestKey: newKey(), expectedRevision: 1, logicalSessionIds: plans.map((x) => x.logicalSessionId), alignSessions: true };
  const res = await api(`/api/calendar/events/${ev.id}/sessions`, { method: "POST", cookie: coach.cookie, body });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.alignment, { direction: "rpe_on", changed: 2, unchanged: 0, notAllowed: 0, switchOff: 2 });
  // A replay repeats the first answer's counts (code review, LOW), nothing written again.
  const replay = await api(`/api/calendar/events/${ev.id}/sessions`, { method: "POST", cookie: coach.cookie, body });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.alignment, res.body.alignment);
  assert.equal(replay.body.attached, 2);
  assert.equal(replay.body.event.revision, 2);
  assert.equal((await q(`select count(*)::int as n from training_load.planned_rpe_workspace_settings where owner_team_id = $1`, [teamId]))[0].n, 0, "the switch is not created or flipped");
  const change = (await q(`select kind, details from calendar.event_changes where event_id = $1 order by revision desc limit 1`, [ev.id]))[0];
  assert.equal(change.kind, "attach_sessions");
  assert.equal(change.details.aligned, 2);
  assert.equal(change.details.switchOff, 2);
  const card = eventCards(await calendar(coach.cookie), ev.id)[0];
  assert.equal(card.alignment.pending, 0, "the flags follow the event");
  assert.deepEqual(card.gaps, ["rpe"], "the switch is off: still nobody can answer, a gap");
});

test("9. the Training Load quick toggles write through the same shared function: on, off, the not-tracked 409, the results gate, the tracking cascade and the edit-draft copy", async () => {
  const s = await squad("tl");
  const team = { scope: "team", teamId: s.teamX };
  const [one] = await plansFor([s.x[0]], { owner: team, coachUserId: s.coachX.id });
  const draft = await makePlan({ athleteId: s.x[0].athleteId, coachUserId: s.coachX.id, owner: null, status: "draft", editSourcePlanId: one.planId });
  const draftSession = await makeSession({ planId: draft, date: PAST, logicalSessionId: one.logicalSessionId });
  const toggle = (path, body) => api(`/api/training-load/sessions/${one.sessionId}/${path}`, { method: "PATCH", cookie: s.coachX.cookie, body });
  let r = await toggle("rpe-enabled", { rpeEnabled: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.draftSessionUpdated, true);
  assert.deepEqual(await flagsOf(one.sessionId), { rpe_enabled: false, training_load_enabled: true });
  assert.deepEqual(await flagsOf(draftSession.sessionId), { rpe_enabled: false, training_load_enabled: true });
  r = await toggle("training-load-enabled", { trainingLoadEnabled: false });
  assert.equal(r.status, 200, r.text);
  r = await toggle("rpe-enabled", { rpeEnabled: true });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.error, "sessionNotTracked");
  assert.equal((await toggle("training-load-enabled", { trainingLoadEnabled: true })).status, 200);
  r = await toggle("rpe-enabled", { rpeEnabled: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.draftSessionUpdated, true);
  assert.equal(r.body.draftRpeKeptOff, false, "a tracked draft copy follows");
  assert.deepEqual(await flagsOf(draftSession.sessionId), { rpe_enabled: true, training_load_enabled: true });
  await submitRpe(s.x[0], one.sessionId);
  r = await toggle("training-load-enabled", { trainingLoadEnabled: false });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.error, "hasExistingResults");
  assert.equal(r.body.resultCount, 1);
  r = await toggle("training-load-enabled", { trainingLoadEnabled: false, confirmDisableWithResults: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.rpeEnabled, false, "tracking off turns RPE off in the same write");
  assert.deepEqual(await flagsOf(one.sessionId), { rpe_enabled: false, training_load_enabled: false });
  assert.deepEqual(await flagsOf(draftSession.sessionId), { rpe_enabled: false, training_load_enabled: false });
  // Statically: one write path for the two flags of a published session.
  const routes = (await fsp.readFile(path.resolve(__dirname, "../src/routes/trainingLoad.js"), "utf8")).replace(/\/\/.*$/gm, "");
  assert.equal(/update plans\.plan_sessions set (rpe_enabled|training_load_enabled)/.test(routes), false, "the quick toggles write only through plannedSessionFlags.js");
  const service = (await fsp.readFile(path.resolve(__dirname, "../src/calendarEventService.js"), "utf8")).replace(/\/\/.*$/gm, "");
  assert.equal(/update plans\.plan_sessions/.test(service), false, "the calendar writes flags only through plannedSessionFlags.js");
});

test("9b. the RPE quick toggle never changes the edit-draft copy's tracking (code review HIGH-1): off leaves the draft's own tracking off, on keeps an untracked draft copy without RPE instead of failing; the alignment's RPE off leaves tracking too", async () => {
  const s = await squad("tl9b");
  const team = { scope: "team", teamId: s.teamX };
  const [one] = await plansFor([s.x[0]], { owner: team, coachUserId: s.coachX.id });
  // The coach turned tracking off in the Builder's open draft, not yet published.
  const draft = await makePlan({ athleteId: s.x[0].athleteId, coachUserId: s.coachX.id, owner: null, status: "draft", editSourcePlanId: one.planId });
  const draftSession = await makeSession({ planId: draft, date: PAST, rpeEnabled: false, tlEnabled: false, logicalSessionId: one.logicalSessionId });
  const toggle = (body) => api(`/api/training-load/sessions/${one.sessionId}/rpe-enabled`, { method: "PATCH", cookie: s.coachX.cookie, body });
  let r = await toggle({ rpeEnabled: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.draftSessionUpdated, true);
  assert.deepEqual(await flagsOf(one.sessionId), { rpe_enabled: false, training_load_enabled: true });
  assert.deepEqual(await flagsOf(draftSession.sessionId), { rpe_enabled: false, training_load_enabled: false }, "the draft keeps its own tracking");
  assert.equal(r.body.draftRpeKeptOff, false);
  r = await toggle({ rpeEnabled: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await flagsOf(one.sessionId), { rpe_enabled: true, training_load_enabled: true });
  assert.deepEqual(await flagsOf(draftSession.sessionId), { rpe_enabled: false, training_load_enabled: false }, "an untracked draft copy never takes RPE");
  assert.equal(r.body.draftSessionUpdated, true);
  assert.equal(r.body.draftRpeKeptOff, true, "the answer says the draft copy kept RPE off (re-review LOW)");
  // The alignment's RPE off writes RPE alone: a tracked draft copy stays tracked, an untracked one untracked.
  await q(`update plans.plan_sessions set training_load_enabled = true, rpe_enabled = true where id = $1`, [draftSession.sessionId]);
  const [two] = await plansFor([s.x[1]], { owner: team, coachUserId: s.coachX.id });
  const draft2 = await makePlan({ athleteId: s.x[1].athleteId, coachUserId: s.coachX.id, owner: null, status: "draft", editSourcePlanId: two.planId });
  const draftSession2 = await makeSession({ planId: draft2, date: PAST, rpeEnabled: false, tlEnabled: false, logicalSessionId: two.logicalSessionId });
  const ev = await teamEvent(s, { expects: [] });
  const res = await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [one.logicalSessionId, two.logicalSessionId], alignSessions: true });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.alignment, { direction: "rpe_off", changed: 2, unchanged: 0, notAllowed: 0, switchOff: 0 });
  assert.deepEqual(await flagsOf(one.sessionId), { rpe_enabled: false, training_load_enabled: true });
  assert.deepEqual(await flagsOf(draftSession.sessionId), { rpe_enabled: false, training_load_enabled: true });
  assert.deepEqual(await flagsOf(two.sessionId), { rpe_enabled: false, training_load_enabled: true });
  assert.deepEqual(await flagsOf(draftSession2.sessionId), { rpe_enabled: false, training_load_enabled: false }, "the draft's own tracking off stays off");
});

// ---------------------------------------------------------------------------
// Activities (device_data)
// ---------------------------------------------------------------------------
test("10. attach an activity: device data meets the event (done), the activity card folds under it; idempotent; outside the days, no target, another club's activity (byte-identical to a random id), attached elsewhere; detach brings the card back", async () => {
  const s = await squad("act");
  const ev = await clubEvent(s, { expects: ["device_data"], targets: [{ kind: "team", id: s.teamX }] });
  const imported = await makeActivity({ owner: { scope: "club", clubId: s.clubId }, origin: "api_import", name: "GPS session" });
  await addParticipant(imported, s.x[0].athleteId);
  let card = eventCards(await calendar(s.clubAdmin.cookie), ev.id)[0];
  assert.equal(card.status, "awaiting_entry", "device data expected, none attached, the day passed");
  const res = await attachActivity(s.clubAdmin.cookie, ev.id, { expectedRevision: 1, activityId: imported });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.attached, true);
  assert.deepEqual(res.body.event.activityLinks.map((l) => l.activityId), [imported]);
  assert.equal((await q(`select kind, details from calendar.event_changes where event_id = $1 order by revision desc limit 1`, [ev.id]))[0].kind, "attach_activity");
  let cal = await calendar(s.clubAdmin.cookie);
  card = eventCards(cal, ev.id)[0];
  assert.equal(card.status, "done");
  assert.deepEqual(card.links.activityIds, [imported]);
  assert.equal(allItems(cal).some((i) => i.key === `activity:${imported}`), false, "the activity folds under the event");
  const activitiesOnly = await calendar(s.clubAdmin.cookie, { extra: "&kinds=activity" });
  assert.ok(allItems(activitiesOnly).some((i) => i.key === `activity:${imported}`), "kinds=activity shows the linked activity as its own card");
  const again = await attachActivity(s.clubAdmin.cookie, ev.id, { expectedRevision: 2, activityId: imported });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.attached, false);
  // Refusals.
  const late = await makeActivity({ owner: { scope: "club", clubId: s.clubId }, origin: "api_import", date: addDays(PAST, -1) });
  await addParticipant(late, s.x[0].athleteId, addDays(PAST, -1));
  assert.equal((await attachActivity(s.clubAdmin.cookie, ev.id, { expectedRevision: 3, activityId: late })).body.error, "activity_outside_event");
  const yOnly = await makeActivity({ owner: { scope: "club", clubId: s.clubId }, origin: "api_import" });
  await addParticipant(yOnly, s.y[0].athleteId);
  assert.equal((await attachActivity(s.clubAdmin.cookie, ev.id, { expectedRevision: 3, activityId: yOnly })).body.error, "activity_not_targeted");
  const foreignClub = await squad("act other");
  const foreignAct = await makeActivity({ owner: { scope: "club", clubId: foreignClub.clubId }, origin: "api_import" });
  await addParticipant(foreignAct, foreignClub.x[0].athleteId);
  const foreign = await attachActivity(s.clubAdmin.cookie, ev.id, { expectedRevision: 3, activityId: foreignAct });
  const random = await attachActivity(s.clubAdmin.cookie, ev.id, { expectedRevision: 3, activityId: crypto.randomUUID() });
  assert.equal(foreign.status, 400, foreign.text);
  assert.equal(foreign.body.error, "activity_not_available");
  assert.equal(foreign.text, random.text);
  const ev2 = await clubEvent(s, { title: "Second", expects: ["device_data"], targets: [{ kind: "team", id: s.teamX }] });
  const taken = await attachActivity(s.clubAdmin.cookie, ev2.id, { expectedRevision: 1, activityId: imported });
  assert.equal(taken.status, 409, taken.text);
  assert.equal(taken.body.error, "activity_already_attached");
  // Detach.
  const detached = await detachActivity(s.clubAdmin.cookie, ev.id, { expectedRevision: 3, activityId: imported });
  assert.equal(detached.status, 200, detached.text);
  assert.equal((await detachActivity(s.clubAdmin.cookie, ev.id, { expectedRevision: 4, activityId: imported })).body.error, "link_not_available");
  cal = await calendar(s.clubAdmin.cookie);
  assert.equal(eventCards(cal, ev.id)[0].status, "awaiting_entry");
  assert.ok(allItems(cal).some((i) => i.key === `activity:${imported}`), "the activity is its own card again");
});

// ---------------------------------------------------------------------------
// Concurrency and the lock order (plan 4.3)
// ---------------------------------------------------------------------------
async function waitForLockWait(predicate = () => true) {
  for (let i = 0; i < 200; i += 1) {
    const rows = await q(
      `select pid, query from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'`,
    );
    if (rows.some(predicate)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no command waited on a lock");
}

test("11. the lock order against a Builder save: an attach waits on the plan row the Builder holds; when the Builder removed the session meanwhile the attach answers session_not_available and writes nothing; when it released, the attach proceeds; two attaches of one slot to two events: one wins", async () => {
  const s = await squad("lck");
  const team = { scope: "team", teamId: s.teamX };
  const group = await plansFor(s.x, { owner: team, coachUserId: s.coachX.id });
  const ev = await teamEvent(s);
  // The Builder (a save or a delete) holds the first plan's row FOR UPDATE and removes its session.
  const builder = new pg.Client({ connectionString: db.url });
  await builder.connect();
  try {
    await builder.query("begin");
    await builder.query(`select id from plans.plans where id = $1 for update`, [group[0].planId]);
    const pending = attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: group.map((x) => x.logicalSessionId) });
    await waitForLockWait((row) => /for share/.test(row.query));
    await builder.query(`delete from plans.plan_sessions where id = $1`, [group[0].sessionId]);
    await builder.query("commit");
    const res = await pending;
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.error, "session_not_available");
    assert.equal(await liveLinks(ev.id), 0, "nothing written");
    assert.equal((await q(`select revision from calendar.events where id = $1`, [ev.id]))[0].revision, 1);
    // Held and released: the attach waits, then proceeds.
    await builder.query("begin");
    await builder.query(`select id from plans.plans where id = $1 for update`, [group[1].planId]);
    const waiting = attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [group[1].logicalSessionId, group[2].logicalSessionId] });
    await waitForLockWait((row) => /for share/.test(row.query));
    await builder.query("rollback");
    const done = await waiting;
    assert.equal(done.status, 200, done.text);
    assert.equal(await liveLinks(ev.id), 2);
  } finally {
    await builder.end();
  }
  // Two events, one slot, at the same time: exactly one link.
  const t = await squad("lck2");
  const plans = await plansFor(t.x, { owner: { scope: "team", teamId: t.teamX }, coachUserId: t.coachX.id });
  const e1 = await teamEvent(t, { title: "One" });
  const e2 = await teamEvent(t, { title: "Two" });
  const ids = plans.map((x) => x.logicalSessionId);
  const [a, b] = await Promise.all([
    attachSessions(t.coachX.cookie, e1.id, { expectedRevision: 1, logicalSessionIds: ids }),
    attachSessions(t.coachX.cookie, e2.id, { expectedRevision: 1, logicalSessionIds: ids }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.text} / ${b.text}`);
  assert.equal([a, b].find((r) => r.status === 409).body.error, "session_already_attached");
  assert.equal((await q(`select count(*)::int as n from calendar.event_session_links where event_id in ($1, $2) and ended_at is null`, [e1.id, e2.id]))[0].n, 3);
});

// ---------------------------------------------------------------------------
// The review round: cancel, a change of the days, the owner's tree, the
// alignment's statements
// ---------------------------------------------------------------------------
const liveActivityLinks = async (eventId) => (await q(`select count(*)::int as n from calendar.event_activity_links where event_id = $1 and ended_at is null`, [eventId]))[0].n;

test("12. a cancelled event releases its links in the same command (code review HIGH-2): the change row and the answer count them, a replay repeats the count, the slots and the activity go to another event at once", async () => {
  const s = await squad("cxl");
  const team = { scope: "team", teamId: s.teamX };
  const group = await plansFor(s.x, { owner: team, coachUserId: s.coachX.id });
  const ev = await teamEvent(s, { expects: ["rpe", "device_data"] });
  assert.equal((await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: group.map((x) => x.logicalSessionId) })).status, 200);
  const activity = await makeActivity({ owner: team, origin: "api_import", name: "GPS" });
  await addParticipant(activity, s.x[0].athleteId);
  assert.equal((await attachActivity(s.coachX.cookie, ev.id, { expectedRevision: 2, activityId: activity })).status, 200);
  const body = { requestKey: newKey(), expectedRevision: 3, reason: "Rain" };
  const cancelled = await api(`/api/calendar/events/${ev.id}/cancel`, { method: "POST", cookie: s.coachX.cookie, body });
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.body.event.status, "cancelled");
  assert.deepEqual(cancelled.body.linksEnded, { sessions: 3, activities: 1 });
  assert.equal(await liveLinks(ev.id), 0);
  assert.equal(await liveActivityLinks(ev.id), 0);
  assert.equal((await q(`select count(*)::int as n from calendar.event_session_links where event_id = $1 and ended_by_user_id = $2`, [ev.id, s.coachX.id]))[0].n, 3);
  const change = (await q(`select kind, revision, details from calendar.event_changes where event_id = $1 order by revision desc limit 1`, [ev.id]))[0];
  assert.equal(change.kind, "cancel");
  assert.equal(change.revision, 4);
  assert.equal(change.details.sessionLinksEnded, 3);
  assert.equal(change.details.activityLinksEnded, 1);
  const replay = await api(`/api/calendar/events/${ev.id}/cancel`, { method: "POST", cookie: s.coachX.cookie, body });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.linksEnded, { sessions: 3, activities: 1 });
  // The same slots and the activity go to a new event at once.
  const ev2 = await teamEvent(s, { title: "Indoors", expects: ["rpe", "device_data"] });
  const again = await attachSessions(s.coachX.cookie, ev2.id, { expectedRevision: 1, logicalSessionIds: group.map((x) => x.logicalSessionId) });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.attached, 3);
  const againActivity = await attachActivity(s.coachX.cookie, ev2.id, { expectedRevision: 2, activityId: activity });
  assert.equal(againActivity.status, 200, againActivity.text);
  assert.equal(againActivity.body.attached, true);
  const card = eventCards(await calendar(s.coachX.cookie), ev2.id)[0];
  assert.deepEqual([...card.links.planIds].sort(), group.map((x) => x.planId).sort());
  assert.ok(card.links.activityIds.includes(activity));
});

test("13. a change of the event's days never strands a link (code review MEDIUM): a day that leaves a linked session or activity outside is refused with the count and writes nothing; a change that keeps them inside works; after a detach the move works", async () => {
  const s = await squad("mov");
  const team = { scope: "team", teamId: s.teamX };
  const d1 = addDays(PAST, -1);
  const first = await plansFor([s.x[0]], { owner: team, coachUserId: s.coachX.id, date: d1 });
  const second = await plansFor([s.x[1]], { owner: team, coachUserId: s.coachX.id, date: PAST });
  const ev = await teamEvent(s, { day: d1, endDay: PAST, expects: ["rpe", "device_data"] });
  assert.equal((await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [first[0].logicalSessionId, second[0].logicalSessionId] })).status, 200);
  const activity = await makeActivity({ owner: team, origin: "api_import" });
  await addParticipant(activity, s.x[1].athleteId);
  assert.equal((await attachActivity(s.coachX.cookie, ev.id, { expectedRevision: 2, activityId: activity })).status, 200);
  const shrink = await patchEvent(s.coachX.cookie, ev.id, { expectedRevision: 3, day: PAST, endDay: null });
  assert.equal(shrink.status, 409, shrink.text);
  assert.equal(shrink.body.error, "links_outside_event");
  assert.equal(shrink.body.count, 1);
  const away = await patchEvent(s.coachX.cookie, ev.id, { expectedRevision: 3, day: FUTURE, endDay: null });
  assert.equal(away.status, 409, away.text);
  assert.equal(away.body.count, 3, "two sessions and the activity");
  const row = (await q(`select revision, day, end_day from calendar.events where id = $1`, [ev.id]))[0];
  assert.equal(row.revision, 3, "nothing written");
  assert.equal(await liveLinks(ev.id), 2);
  // Widening keeps every link inside.
  const wider = await patchEvent(s.coachX.cookie, ev.id, { expectedRevision: 3, endDay: addDays(PAST, 1) });
  assert.equal(wider.status, 200, wider.text);
  // Detach the first day's link, then the event may leave that day.
  const view = (await getEvent(s.coachX.cookie, ev.id)).body.event;
  const firstLink = view.sessionLinks.find((l) => l.day === d1);
  assert.equal((await detachSessions(s.coachX.cookie, ev.id, { expectedRevision: 4, linkIds: [firstLink.id] })).status, 200);
  const moved = await patchEvent(s.coachX.cookie, ev.id, { expectedRevision: 5, day: PAST, endDay: null });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(await liveLinks(ev.id), 1);
  const aligned = await alignSessions(s.coachX.cookie, ev.id, { expectedRevision: 6 });
  assert.equal(aligned.status, 200, aligned.text);
  assert.equal(aligned.body.alignment.unchanged + aligned.body.alignment.changed + aligned.body.alignment.notAllowed, 1, "only the link inside the days");
  // A merge (ADR-001): the event shows the linked activity's canonical
  // survivor, so the day check judges the survivor's day (re-review LOW).
  const survivor = await makeActivity({ owner: team, origin: "api_import", name: "Merged", date: FUTURE });
  await q(`select set_config('training.allow_supersede_write', 'on', false)`);
  try {
    await q(`update training.activities set lifecycle_state = 'superseded', superseded_by_activity_id = $2 where id = $1`, [activity, survivor]);
  } finally {
    await q(`select set_config('training.allow_supersede_write', 'off', false)`);
  }
  const afterMerge = await patchEvent(s.coachX.cookie, ev.id, { expectedRevision: 7, endDay: addDays(PAST, 1) });
  assert.equal(afterMerge.status, 409, afterMerge.text);
  assert.equal(afterMerge.body.error, "links_outside_event");
  assert.equal(afterMerge.body.count, 1, "the survivor's day is outside the new days");
});

test("14. a plan or an activity is linked only inside the event owner's tree (security review MEDIUM-1): an athlete of teams X and Y — team Y's plan and activity never fold under team X's event, whoever asks (byte-identical to a random id), and team Y's calendar keeps them; the club's own plan and team X's activity do", async () => {
  const s = await squad("own");
  const a = s.x[0];
  await addMembership({ athleteId: a.athleteId, clubId: s.clubId, teamId: s.teamY });
  const [yPlan] = await plansFor([a], { owner: { scope: "team", teamId: s.teamY }, coachUserId: s.coachY.id, name: "Y training" });
  const ev = await teamEvent(s, { expects: ["rpe", "device_data"] });
  const random = await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [crypto.randomUUID()] });
  for (const who of [s.coachX, s.clubAdmin]) {
    const refused = await attachSessions(who.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [yPlan.logicalSessionId] });
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.text, random.text);
  }
  assert.equal(await liveLinks(ev.id), 0);
  assert.ok(plannedOn(await calendar(s.coachY.cookie), PAST).some((c) => c.athleteIds.includes(a.athleteId)), "team Y's coach keeps the plan's own card");
  const yActivity = await makeActivity({ owner: { scope: "team", teamId: s.teamY }, origin: "api_import" });
  await addParticipant(yActivity, a.athleteId);
  const randomActivity = await attachActivity(s.clubAdmin.cookie, ev.id, { expectedRevision: 1, activityId: crypto.randomUUID() });
  const refusedActivity = await attachActivity(s.clubAdmin.cookie, ev.id, { expectedRevision: 1, activityId: yActivity });
  assert.equal(refusedActivity.status, 400, refusedActivity.text);
  assert.equal(refusedActivity.text, randomActivity.text);
  assert.equal(await liveActivityLinks(ev.id), 0);
  // A refused id never takes or waits on its plan's or activity's lock
  // (security review LOW-1): with team Y's plan and activity held FOR UPDATE
  // the answer is still the same 400 at once, never a wait or a try_again.
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select id from plans.plans where id = $1 for update`, [yPlan.planId]);
    await holder.query(`select id from training.activities where id = $1 for update`, [yActivity]);
    const heldPlan = await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [yPlan.logicalSessionId] });
    assert.equal(heldPlan.text, random.text);
    const heldActivity = await attachActivity(s.clubAdmin.cookie, ev.id, { expectedRevision: 1, activityId: yActivity });
    assert.equal(heldActivity.text, randomActivity.text);
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  // Inside the tree: the club's plan (a team event's club) and team X's own activity.
  const [clubPlan] = await plansFor([a], { owner: { scope: "club", clubId: s.clubId }, coachUserId: s.clubAdmin.id, name: "Club training", amPm: "AM" });
  assert.equal((await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [clubPlan.logicalSessionId] })).status, 200);
  const xActivity = await makeActivity({ owner: { scope: "team", teamId: s.teamX }, origin: "api_import" });
  await addParticipant(xActivity, a.athleteId);
  assert.equal((await attachActivity(s.coachX.cookie, ev.id, { expectedRevision: 2, activityId: xActivity })).status, 200);
});

test("15. the alignment's statements do not grow with its sessions (code review LOW): one session and three sessions with their edit-draft copies, the same count", async () => {
  const s = await squad("stm");
  const team = { scope: "team", teamId: s.teamX };
  const hooks = eventService.testHooks;
  async function alignStatements(athletes, title) {
    const plans = await plansFor(athletes, { owner: team, coachUserId: s.coachX.id, rpeEnabled: false, tlEnabled: false, name: title });
    for (const x of plans) {
      const draft = await makePlan({ athleteId: x.athlete.athleteId, coachUserId: s.coachX.id, owner: null, status: "draft", editSourcePlanId: x.planId });
      await makeSession({ planId: draft, date: PAST, name: title, rpeEnabled: false, tlEnabled: false, logicalSessionId: x.logicalSessionId });
    }
    const ev = await teamEvent(s, { title });
    assert.equal((await attachSessions(s.coachX.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: plans.map((x) => x.logicalSessionId) })).status, 200);
    let count = 0;
    let wrapped = null;
    hooks.beforeLocks = ({ client }) => {
      const original = client.query;
      wrapped = { client, original };
      client.query = function counted(...args) {
        count += 1;
        return original.apply(this, args);
      };
    };
    try {
      const res = await alignSessions(s.coachX.cookie, ev.id, { expectedRevision: 2 });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.alignment.changed, athletes.length);
    } finally {
      delete hooks.beforeLocks;
      if (wrapped) wrapped.client.query = wrapped.original;
    }
    for (const x of plans) assert.deepEqual(await flagsOf(x.sessionId), { rpe_enabled: true, training_load_enabled: true });
    return count;
  }
  const one = await alignStatements([s.x[0]], "One");
  const three = await alignStatements(s.x, "Three");
  assert.equal(three, one, `the same number of statements for one and for three sessions (${one})`);
});

// Phase 3A: the periodic notification worker (testsNotificationWorker.js/
// testsNotificationWorkerCli.js) and the Schedule-form Notifications API
// (backend/src/routes/tests.js's notificationRules handling in POST
// /schedules, POST /schedules/bulk, PATCH /schedules/:id, GET /schedules/
// :id).
//
// Same harness as tests-module-schedule-management.test.mjs: a disposable,
// uniquely-named temporary database (never OPTIMOVE, never monitoring2)
// through the real Strategy B runner, with the real Express app driven over
// real HTTP with real session cookies - plus, here, direct calls into
// processTestNotificationCycle()/runTestsNotificationWorkerOnce() against
// the exact same pool the HTTP server itself uses, since the worker is not
// an HTTP route.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILES = [
  "202608220900_tests_v42_schema.sql",
  "202608221000_tests_v42_seed_wellness_fms.sql",
  "202608240900_tests_v42_phase1_scheduling_execution.sql",
  "202608250900_tests_v42_presentation_metadata.sql",
  "202608250901_tests_v42_supersede_generated_column_fix.sql",
  "202608260900_tests_v42_occurrence_generation_lock_fix.sql",
  "202608270900_tests_v42_phase3_notification_dispatch_link.sql",
  "202608300900_tests_v42_phase4_assignment_timezone_window.sql",
];

const WELLNESS_TEST_VERSION_ID = "7a386bd1-d25e-4651-9012-e76d9dc32559";
const WELLNESS_INJURY_PARAMETER_ID = "a98f2afb-b458-40ff-98a7-c6b5108bba9e";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const baseUrl = new URL(ORIGINAL_DATABASE_URL);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const ADMIN_URL = adminUrl.toString();

function dbUrlFor(name) {
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return u.toString();
}
function refuseForbidden(name, url) {
  if (name.toLowerCase() === "optimove" || /monitoring2/i.test(url)) {
    throw new Error("SAFETY: refusing to run against a forbidden database name");
  }
}

const LEGACY_FIXTURE_SQL = `
  create extension if not exists pgcrypto;

  create table public.clubs (id uuid primary key default gen_random_uuid(), name text, is_active boolean not null default true);
  create table public.teams (id uuid primary key default gen_random_uuid(), club_id uuid references public.clubs(id), name text, is_active boolean not null default true);
  alter table public.teams add constraint teams_id_club_id_unique unique (id, club_id);

  create table public.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    password_hash text,
    full_name text,
    display_name text,
    first_name text,
    last_name text,
    role_hint text not null default 'user',
    is_active boolean not null default true
  );
  create table public.auth_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  );
  create table public.user_global_roles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    role text not null,
    is_active boolean not null default true,
    revoked_at timestamptz
  );
  create table public.user_club_roles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    club_id uuid not null references public.clubs(id) on delete cascade,
    role text not null,
    is_active boolean not null default true,
    updated_at timestamptz not null default now()
  );
  create table public.user_team_roles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    team_id uuid not null references public.teams(id) on delete cascade,
    role text not null,
    is_active boolean not null default true,
    updated_at timestamptz not null default now()
  );
  create table public.user_workspace_preferences (
    user_id uuid primary key references public.users(id) on delete cascade,
    workspace_type text not null,
    scope_id uuid,
    updated_at timestamptz not null default now()
  );

  create table public.athletes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references public.users(id) on delete set null,
    source_external_id text,
    full_name text,
    display_name text,
    first_name text,
    last_name text,
    athlete_id text,
    image_url text
  );
  create table public.user_athletes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    athlete_id uuid not null references public.athletes(id) on delete cascade,
    relationship_type text not null default 'coach',
    is_active boolean not null default true
  );
  create table public.athlete_memberships (
    id uuid primary key default gen_random_uuid(),
    athlete_id uuid not null references public.athletes(id),
    club_id uuid references public.clubs(id),
    team_id uuid references public.teams(id),
    membership_type varchar not null,
    status varchar not null default 'active'
  );
  create table public.athlete_invites (id uuid primary key default gen_random_uuid(), context_type text);
  create table public.account_email_change_tokens (id uuid primary key default gen_random_uuid());

  -- Real shape from the legacy create_notifications_schema.sql (never
  -- re-run per Strategy B - this fixture stands in for it). The new Phase 3A
  -- migration (202608270900_..., applied below) adds a FK from
  -- tests.test_schedule_notification_dispatches to this exact table, so it
  -- must exist here even though this test file's predecessor
  -- (tests-module-schedule-management.test.mjs) never needed it.
  create table public.app_notifications (
    id uuid primary key default gen_random_uuid(),
    recipient_user_id uuid not null references public.users(id) on delete cascade,
    actor_user_id uuid references public.users(id) on delete set null,
    type varchar(80) not null,
    title text not null,
    body text,
    entity_type varchar(80),
    entity_id uuid,
    href text,
    metadata jsonb not null default '{}'::jsonb,
    read_at timestamptz,
    created_at timestamptz not null default now()
  );

  create schema library;
  create table library.exercises (id uuid primary key default gen_random_uuid());

  create schema plans;
  create table plans.plans (id uuid primary key default gen_random_uuid());
  create table plans.plan_days (id uuid primary key default gen_random_uuid());
  create table plans.plan_sessions (id uuid primary key default gen_random_uuid(), session_time time);
  create table plans.plan_items (id uuid primary key default gen_random_uuid());
  create table plans.plan_nodes (id uuid primary key default gen_random_uuid());
  create view plans.v_plan_summary as select id from plans.plans;
  create view plans.v_plan_item_node_ancestry as select id from plans.plan_items;
  create view plans.v_weekly_plan_items as select id from plans.plan_items;
  create view plans.v_program_plan_items as select id from plans.plan_items;
`;

async function makeTempDb(label) {
  const name = `optimove_tests_notifworker_${label}_${crypto.randomBytes(6).toString("hex")}`;
  const url = dbUrlFor(name);
  refuseForbidden(name, url);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const cur = await admin.query("select current_database() as db");
  assert.equal(cur.rows[0].db, "postgres", "SAFETY: admin connection must be on the postgres database");
  await admin.query(`create database "${name}"`);
  await admin.end();
  return { name, url };
}
async function dropTempDb({ name }) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`, [name]);
  await admin.query(`drop database if exists "${name}"`);
  await admin.end();
}
async function writeMigrationsDir(runId, files) {
  const dir = path.resolve(__dirname, `tests_notifworker_migrations_${runId}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

let db, adminClient, migrationsDir;
let server, apiBaseUrl;
let query, pool, createSession, hashPassword, ensureCurrentOccurrence;
let processTestNotificationCycle, runTestsNotificationWorkerOnce;

before(async () => {
  const contents = await Promise.all(
    MIGRATION_FILES.map((name) => fsp.readFile(path.resolve(__dirname, "../../migrations_v2", name), "utf8")),
  );

  db = await makeTempDb("primary");
  adminClient = new pg.Client({ connectionString: db.url });
  await adminClient.connect();
  const ownCheck = await adminClient.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");

  await adminClient.query(LEGACY_FIXTURE_SQL);
  const files = {};
  MIGRATION_FILES.forEach((name, i) => { files[name] = contents[i]; });
  migrationsDir = await writeMigrationsDir("primary", files);
  await runner.runMigrations({ databaseUrl: db.url, migrationsRoot: migrationsDir });

  process.env.DATABASE_URL = db.url;
  const dbModule = await import("../src/db.js");
  query = dbModule.query;
  pool = dbModule.pool;
  const authModule = await import("../src/auth.js");
  createSession = authModule.createSession;
  hashPassword = authModule.hashPassword;
  const occurrenceServiceModule = await import("../src/testsOccurrenceService.js");
  ensureCurrentOccurrence = occurrenceServiceModule.ensureCurrentOccurrence;
  const workerModule = await import("../src/testsNotificationWorker.js");
  processTestNotificationCycle = workerModule.processTestNotificationCycle;
  const workerCliModule = await import("../src/testsNotificationWorkerCli.js");
  runTestsNotificationWorkerOnce = workerCliModule.runTestsNotificationWorkerOnce;
  const serverModule = await import("../src/server.js");

  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBaseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await adminClient.end();
  await fsp.rm(migrationsDir, { recursive: true, force: true });
  await dropTempDb(db);
});

// ------------------------------------------------------------
// Fixture helpers (same shapes as tests-module-schedule-management.test.mjs)
// ------------------------------------------------------------

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}
function cookieFor(token) {
  return `optimove_session=${token}`;
}
async function makeUser({ email, roleHint = "user" }) {
  const result = await query(
    `insert into public.users (email, password_hash, full_name, display_name, role_hint, is_active) values ($1,$2,$3,$3,$4,true) returning id`,
    [email, hashPassword("irrelevant-password-123"), email.split("@")[0], roleHint],
  );
  return result.rows[0].id;
}
async function makeClub(name) {
  const result = await query(`insert into public.clubs (name) values ($1) returning id`, [name]);
  return result.rows[0].id;
}
async function makeAthlete({ name, userId = null }) {
  const result = await query(`insert into public.athletes (user_id, full_name, display_name) values ($1,$2,$2) returning id`, [userId, name]);
  return result.rows[0].id;
}
async function grantClubAdmin(userId, clubId) {
  await query(`insert into public.user_club_roles (user_id, club_id, role) values ($1,$2,'club_admin')`, [userId, clubId]);
}
async function addMembership(athleteId, { clubId = null }) {
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
}
async function loginCookie(userId) {
  const token = await createSession(userId);
  return cookieFor(token);
}
async function waitUntilBlockedBy(blockerPid, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await adminClient.query(`select pid from pg_stat_activity where pg_blocking_pids(pid) @> array[$1]::int[]`, [blockerPid]);
    if (result.rowCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for a backend to be blocked by pid ${blockerPid}`);
}

const TODAY = new Date().toISOString().slice(0, 10);

// A club with a coach admin and N real athletes, all club-owned. `label`
// must be unique per test (used in emails).
async function makeClubWithAthletes(label, count, { withUserAccount = true } = {}) {
  const clubId = await makeClub(`${label} Club`);
  const coachId = await makeUser({ email: `${label}-coach-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local` });
  await grantClubAdmin(coachId, clubId);
  const coachCookie = await loginCookie(coachId);
  const athletes = [];
  for (let i = 0; i < count; i += 1) {
    const userId = withUserAccount
      ? await makeUser({ email: `${label}-athlete${i}-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local`, roleHint: "athlete" })
      : null;
    const athleteId = await makeAthlete({ name: `${label} Athlete ${i}`, userId });
    await addMembership(athleteId, { clubId });
    athletes.push({ athleteId, userId, cookie: userId ? await loginCookie(userId) : null });
  }
  return { clubId, coachId, coachCookie, athletes };
}

function baseCreateBody(targets, overrides = {}) {
  return {
    testVersionId: WELLNESS_TEST_VERSION_ID,
    scheduleKind: "one_time",
    timezone: "UTC",
    startDate: TODAY,
    opensTime: "00:00",
    closesTime: "23:59",
    targets,
    ...overrides,
  };
}

const FULL_RULES_ALL_ON = [
  { kind: "athlete_invitation", enabled: true },
  { kind: "athlete_reminder", enabled: true, reminderOffsetMinutes: 60 },
  { kind: "coach_digest", enabled: true },
  { kind: "final_digest", enabled: true },
];

async function createScheduleWithRules(coachCookie, targets, { rules = FULL_RULES_ALL_ON, overrides = {} } = {}) {
  const created = await api("/api/tests/schedules", {
    method: "POST", cookie: coachCookie,
    body: baseCreateBody(targets, { ...overrides, notificationRules: rules }),
  });
  return created.body.schedule;
}

// Calls ensureCurrentOccurrence() directly - the SAME safe, already-tested
// service Today/check-in routes and the worker's own Phase 1 both call - to
// materialize an occurrence+assignments for setup, WITHOUT also running a
// full notification cycle as a side effect (processTestNotificationCycle
// would send invitations/reminders/digests too, contaminating a test's own
// "first real cycle" assertions with results from setup itself).
async function ensureOccurrenceAndAssignments(scheduleId) {
  const scheduleResult = await query(`select * from tests.test_schedules where id = $1`, [scheduleId]);
  await ensureCurrentOccurrence(pool, scheduleResult.rows[0]);
  const occurrenceResult = await query(`select * from tests.test_schedule_occurrences where schedule_id = $1`, [scheduleId]);
  return { occurrence: occurrenceResult.rows[0] };
}

function closesAtOf(occurrence) {
  return new Date(occurrence.closes_at);
}

async function getAssignmentId(occurrenceId, athleteId) {
  const result = await query(`select id from tests.test_assignments where occurrence_id = $1 and athlete_id = $2`, [occurrenceId, athleteId]);
  return result.rows[0]?.id;
}

// ------------------------------------------------------------
// O. Occurrence auto-generation (no Today view opened)
// ------------------------------------------------------------

test("O1. the worker creates a daily schedule's occurrence and assignments entirely on its own - no GET /today ever called", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("o1", 2);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }, { kind: "athlete", id: athletes[1].athleteId }], {
    overrides: { scheduleKind: "daily", startDate: TODAY, opensTime: "00:00" },
  });

  const summary = await processTestNotificationCycle({ now: new Date(), pool });
  assert.ok(summary.occurrences.generated >= 1);

  // Phase 4 correction: an open-ended (no end_date) daily schedule's own
  // occurrence generation unconditionally covers BOTH today's and
  // tomorrow's logical date (to support an athlete ahead of the schedule's
  // own timezone) - so two occurrence rows now exist; only today's has
  // eligible (same-day, standard-UTC-clock) athletes to materialize.
  const occurrenceRows = await query(`select id, scheduled_date, assignments_materialized_at from tests.test_schedule_occurrences where schedule_id = $1 order by scheduled_date`, [schedule.id]);
  assert.equal(occurrenceRows.rowCount, 2);
  const todaysOccurrence = occurrenceRows.rows[0];
  assert.ok(todaysOccurrence.assignments_materialized_at);
  const assignmentRows = await query(`select id from tests.test_assignments where occurrence_id = $1`, [todaysOccurrence.id]);
  assert.equal(assignmentRows.rowCount, 2, "both targeted athletes must have a materialized assignment");
});

test("O2. a one_time schedule's date and opens_time are both respected - not yet due (future opens_time today) generates nothing, due generates exactly one occurrence", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("o2", 1);
  const notYetDue = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }], {
    overrides: { startDate: TODAY, opensTime: "23:59", closesTime: "23:59" },
  });
  await processTestNotificationCycle({ now: new Date(), pool });
  const notYetDueRows = await query(`select id from tests.test_schedule_occurrences where schedule_id = $1`, [notYetDue.id]);
  assert.equal(notYetDueRows.rowCount, 0, "opens_time (23:59) has not arrived yet today - nothing should be generated");

  const due = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }], {
    overrides: { startDate: TODAY, opensTime: "00:00" },
  });
  await processTestNotificationCycle({ now: new Date(), pool });
  const dueRows = await query(`select id from tests.test_schedule_occurrences where schedule_id = $1`, [due.id]);
  assert.equal(dueRows.rowCount, 1);
});

test("O3. a paused schedule is skipped by occurrence generation, a cancelled one too", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("o3", 1);
  const paused = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }], { overrides: { startDate: TODAY, opensTime: "00:00" } });
  await api(`/api/tests/schedules/${paused.id}`, { method: "PATCH", cookie: coachCookie, body: { status: "paused" } });
  const cancelled = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }], { overrides: { startDate: TODAY, opensTime: "00:00" } });
  await api(`/api/tests/schedules/${cancelled.id}`, { method: "DELETE", cookie: coachCookie });

  await processTestNotificationCycle({ now: new Date(), pool });
  const pausedRows = await query(`select id from tests.test_schedule_occurrences where schedule_id = $1`, [paused.id]);
  const cancelledRows = await query(`select id from tests.test_schedule_occurrences where schedule_id = $1`, [cancelled.id]);
  assert.equal(pausedRows.rowCount, 0);
  assert.equal(cancelledRows.rowCount, 0);
});

// ------------------------------------------------------------
// I. Athlete invitation
// ------------------------------------------------------------

test("I1. an athlete_invitation is sent exactly once per assignment, even across repeated cycles", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("i1", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);

  // Not asserted on summary.invitations.sent/alreadySent directly - other
  // tests sharing this temp DB may have their own eligible assignments open
  // at the same instant, so the cycle's aggregate counts reflect more than
  // this test's own fixture. athletes[0].userId is unique to this test, so
  // querying app_notifications by it directly is the real, isolated signal.
  await processTestNotificationCycle({ now: new Date(), pool });
  await processTestNotificationCycle({ now: new Date(), pool });

  const notifRows = await query(`select id, title, body, entity_type, entity_id from public.app_notifications where recipient_user_id = $1 and type = 'test_athlete_invitation'`, [athletes[0].userId]);
  assert.equal(notifRows.rowCount, 1);
  assert.equal(notifRows.rows[0].title, "WELLNESS check-in is available");
  assert.equal(notifRows.rows[0].entity_type, "test_assignment");
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);
  assert.equal(notifRows.rows[0].entity_id, assignmentId);
});

test("I2. an athlete with no linked user account is reported as no_recipient, and never crashes the cycle", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("i2", 1, { withUserAccount: false });
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }]);
  await ensureOccurrenceAndAssignments(schedule.id);

  const summary = await processTestNotificationCycle({ now: new Date(), pool });
  assert.equal(summary.invitations.noRecipient, 1);
  assert.equal(summary.invitations.sent, 0);
});

test("I3. a schedule with no athlete_invitation rule configured (legacy schedule, notificationRules never saved) never sends invitations", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("i3", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const { occurrence } = await ensureOccurrenceAndAssignments(created.body.schedule.id);

  await processTestNotificationCycle({ now: new Date(), pool });
  // Scoped to THIS test's own occurrence - other tests in this same shared
  // temp DB may also have eligible schedules open at the same time, so a
  // global summary.invitations.attempted count is not this test's own
  // signal; a real dispatch row for its specific occurrence is.
  const dispatchRows = await query(`select id from tests.test_schedule_notification_dispatches where occurrence_id = $1 and notification_kind = 'athlete_invitation'`, [occurrence.id]);
  assert.equal(dispatchRows.rowCount, 0, "no enabled rule row exists for this schedule - the join must exclude it entirely");
});

test("I4. an assignment completed before the invitation cycle runs is skipped, not invited", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("i4", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);
  await api(`/api/tests/assignments/${assignmentId}/submit`, {
    method: "POST", cookie: athletes[0].cookie,
    body: { values: { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: false } },
  });

  await processTestNotificationCycle({ now: new Date(), pool });
  const notifRows = await query(`select id from public.app_notifications where recipient_user_id = $1 and type = 'test_athlete_invitation'`, [athletes[0].userId]);
  assert.equal(notifRows.rowCount, 0);
});

// ------------------------------------------------------------
// R. Athlete reminder
// ------------------------------------------------------------

test("R1. a reminder fires exactly once at due_at (or closes_at) minus the offset, never twice", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("r1", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }], {
    overrides: { opensTime: "00:00", closesTime: "23:59" },
  });
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const closesAt = new Date(occurrence.closes_at);
  const triggerTime = new Date(closesAt.getTime() - 60 * 60 * 1000); // reminder offset is 60 minutes

  // Scoped to THIS test's own occurrence throughout - other tests sharing
  // this same temp DB may have their own reminder-eligible schedules open
  // at a similar closes_at, so the cycle's global summary.reminders.sent
  // count is not this test's own signal; a dispatch row for its specific
  // occurrence/recipient is.
  const dispatchForThis = () => query(
    `select id from tests.test_schedule_notification_dispatches where occurrence_id = $1 and notification_kind = 'athlete_reminder' and recipient_user_id = $2`,
    [occurrence.id, athletes[0].userId],
  );

  await processTestNotificationCycle({ now: new Date(triggerTime.getTime() - 5 * 60 * 1000), pool });
  assert.equal((await dispatchForThis()).rowCount, 0, "5 minutes before the trigger, nothing should fire yet");

  await processTestNotificationCycle({ now: triggerTime, pool });
  assert.equal((await dispatchForThis()).rowCount, 1);

  await processTestNotificationCycle({ now: new Date(triggerTime.getTime() + 5 * 60 * 1000), pool });
  assert.equal((await dispatchForThis()).rowCount, 1, "still exactly one dispatch row - a later cycle must never send a second reminder");
});

test("R2. a completed assignment never gets a reminder, even after the trigger time has passed", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("r2", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }], { overrides: { opensTime: "00:00", closesTime: "23:59" } });
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);
  await api(`/api/tests/assignments/${assignmentId}/submit`, {
    method: "POST", cookie: athletes[0].cookie,
    body: { values: { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: false } },
  });

  const farInTheFuture = new Date(closesAtOf(occurrence).getTime() + 60 * 1000);
  await processTestNotificationCycle({ now: farInTheFuture, pool });
  const dispatchRows = await query(`select id from tests.test_schedule_notification_dispatches where occurrence_id = $1 and notification_kind = 'athlete_reminder'`, [occurrence.id]);
  assert.equal(dispatchRows.rowCount, 0);
});

test("R3. a worker that missed its exact trigger cycle still sends the reminder once as catch-up, as long as the window hasn't closed", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("r3", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }], { overrides: { opensTime: "00:00", closesTime: "23:59" } });
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  // Deliberately well PAST the exact trigger minute, but still before close.
  const lateButBeforeClose = new Date(closesAtOf(occurrence).getTime() - 5 * 60 * 1000);

  await processTestNotificationCycle({ now: lateButBeforeClose, pool });
  const dispatchRows = await query(`select id from tests.test_schedule_notification_dispatches where occurrence_id = $1 and notification_kind = 'athlete_reminder'`, [occurrence.id]);
  assert.equal(dispatchRows.rowCount, 1, "a late-running worker must still catch up and send once, not skip the reminder entirely");
});

test("R4. after closes_at, the reminder is never sent, even though it was never sent before", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("r4", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }], { overrides: { opensTime: "00:00", closesTime: "23:59" } });
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const afterClose = new Date(closesAtOf(occurrence).getTime() + 60 * 1000);

  await processTestNotificationCycle({ now: afterClose, pool });
  const dispatchRows = await query(`select id from tests.test_schedule_notification_dispatches where occurrence_id = $1 and notification_kind = 'athlete_reminder'`, [occurrence.id]);
  assert.equal(dispatchRows.rowCount, 0, "closed occurrences must never receive a late reminder");
});

// ------------------------------------------------------------
// P. Parallel workers
// ------------------------------------------------------------

test("P1. two parallel cycles processing the SAME invitation never produce a duplicate dispatch or app_notifications row", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("p1", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }]);
  await ensureOccurrenceAndAssignments(schedule.id);

  const now = new Date();
  // Not asserted on a.invitations.sent/b.invitations.sent - other tests
  // sharing this same temp DB may have their own eligible schedules open at
  // the same instant, so the two cycles' own aggregate summaries reflect
  // more than just this test's fixture. The row-scoped checks below (keyed
  // on this test's own unique recipient) are the real signal.
  await Promise.all([
    processTestNotificationCycle({ now, pool }),
    processTestNotificationCycle({ now, pool }),
  ]);

  const notifRows = await query(`select id from public.app_notifications where recipient_user_id = $1 and type = 'test_athlete_invitation'`, [athletes[0].userId]);
  assert.equal(notifRows.rowCount, 1);
  const dispatchRows = await query(`select id from tests.test_schedule_notification_dispatches where notification_kind = 'athlete_invitation' and recipient_user_id = $1`, [athletes[0].userId]);
  assert.equal(dispatchRows.rowCount, 1);
});

test("P2. a simulated crash (dispatch row claimed then rolled back, never committed) leaves nothing behind - the next real cycle sends cleanly, exactly once", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("p2", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);
  const dedupeKey = `v1:athlete_invitation:${occurrence.id}:${assignmentId}:${athletes[0].userId}`;

  const client = await pool.connect();
  await client.query("begin");
  await client.query(
    `insert into tests.test_schedule_notification_dispatches (occurrence_id, assignment_id, notification_kind, recipient_user_id, dedupe_key, status)
     values ($1,$2,'athlete_invitation',$3,$4,'pending')`,
    [occurrence.id, assignmentId, athletes[0].userId, dedupeKey],
  );
  await client.query("rollback"); // simulated crash - never committed
  client.release();

  const preCheck = await query(`select id from tests.test_schedule_notification_dispatches where dedupe_key = $1`, [dedupeKey]);
  assert.equal(preCheck.rowCount, 0, "a rolled-back claim must leave no trace");

  await processTestNotificationCycle({ now: new Date(), pool });
  const postCheck = await query(`select status, app_notification_id from tests.test_schedule_notification_dispatches where dedupe_key = $1`, [dedupeKey]);
  assert.equal(postCheck.rowCount, 1);
  assert.equal(postCheck.rows[0].status, "sent");
  assert.ok(postCheck.rows[0].app_notification_id, "a sent dispatch must always have a real app_notification_id - never falsely 'sent' with nothing behind it");
});

// ------------------------------------------------------------
// D. Coach live digest
// ------------------------------------------------------------

test("D1. the coach live digest is ONE row that gets updated in place as completions come in, never a new notification per cycle", async () => {
  const { coachId, coachCookie, athletes } = await makeClubWithAthletes("d1", 2);
  const schedule = await createScheduleWithRules(coachCookie, athletes.map((a) => ({ kind: "athlete", id: a.athleteId })));
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);

  // Not asserted on summary.coachDigests.sent/unchanged - other tests
  // sharing this same temp DB keep their own occurrences open with coach
  // digests enabled too, so those aggregate counts reflect more than this
  // test's own fixture. coachId is a fresh, unique user per test, so
  // querying by it directly is the real, isolated signal.
  await processTestNotificationCycle({ now: new Date(), pool });
  const firstRow = await query(`select id, body from public.app_notifications where recipient_user_id = $1 and type = 'test_coach_digest'`, [coachId]);
  assert.equal(firstRow.rowCount, 1);
  assert.match(firstRow.rows[0].body, /^0\/2 completed/);

  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);
  await api(`/api/tests/assignments/${assignmentId}/submit`, {
    method: "POST", cookie: athletes[0].cookie,
    body: { values: { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: false } },
  });

  await processTestNotificationCycle({ now: new Date(), pool });
  const secondRow = await query(`select id, body from public.app_notifications where recipient_user_id = $1 and type = 'test_coach_digest'`, [coachId]);
  assert.equal(secondRow.rowCount, 1, "still exactly one notification row, not a second one");
  assert.equal(secondRow.rows[0].id, firstRow.rows[0].id, "the SAME row was updated, not replaced");
  assert.match(secondRow.rows[0].body, /^1\/2 completed/);
});

test("D2. an unchanged digest performs no update at all - no dispatch churn, read state untouched", async () => {
  const { coachId, coachCookie, athletes } = await makeClubWithAthletes("d2", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }]);
  await ensureOccurrenceAndAssignments(schedule.id);

  await processTestNotificationCycle({ now: new Date(), pool });
  const notifRow = await query(`select id, read_at from public.app_notifications where recipient_user_id = $1 and type = 'test_coach_digest'`, [coachId]);
  const dispatchBefore = await query(`select last_computed_at from tests.test_schedule_notification_dispatches where recipient_user_id = $1 and notification_kind = 'coach_digest'`, [coachId]);
  await api(`/api/notifications/${notifRow.rows[0].id}/read`, { method: "POST", cookie: coachCookie, body: {} });

  // Same reasoning as D1 - not asserted on the cycle's own aggregate
  // summary, since other tests' still-open occurrences are recomputed by
  // the same cycle call. What's isolated and provable is: this exact
  // dispatch row's last_computed_at must not move (no wasted recompute-and-
  // rewrite), and the notification stays marked read.
  await processTestNotificationCycle({ now: new Date(), pool });
  const dispatchAfter = await query(`select last_computed_at from tests.test_schedule_notification_dispatches where recipient_user_id = $1 and notification_kind = 'coach_digest'`, [coachId]);
  assert.equal(dispatchAfter.rows[0].last_computed_at.getTime(), dispatchBefore.rows[0].last_computed_at.getTime(), "an unchanged digest must not recompute/rewrite the dispatch row");
  const afterRow = await query(`select read_at from public.app_notifications where id = $1`, [notifRow.rows[0].id]);
  assert.ok(afterRow.rows[0].read_at, "an unchanged recompute must never flip a read notification back to unread");
});

test("D3. the injury count in the live digest reflects only the latest valid (non-superseded) assessment, not a corrected-away earlier one", async () => {
  const { coachId, coachCookie, athletes } = await makeClubWithAthletes("d3", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);

  await api(`/api/tests/assignments/${assignmentId}/submit`, {
    method: "POST", cookie: athletes[0].cookie,
    body: { values: { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: true } },
  });
  await processTestNotificationCycle({ now: new Date(), pool });
  const injuredRow = await query(`select body from public.app_notifications where recipient_user_id = $1 and type = 'test_coach_digest'`, [coachId]);
  assert.match(injuredRow.rows[0].body, /1 injury report/);

  // Correction: same assignment, injury now false - supersedes the earlier assessment.
  await api(`/api/tests/assignments/${assignmentId}/submit`, {
    method: "POST", cookie: athletes[0].cookie,
    body: { values: { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: false } },
  });
  await processTestNotificationCycle({ now: new Date(), pool });
  const correctedRow = await query(`select body from public.app_notifications where recipient_user_id = $1 and type = 'test_coach_digest'`, [coachId]);
  assert.match(correctedRow.rows[0].body, /0 injury reports/);
});

// ------------------------------------------------------------
// FD. Final coach digest
// ------------------------------------------------------------

test("FD1. exactly one final digest per occurrence, even across repeated cycles after closes_at", async () => {
  const { coachId, coachCookie, athletes } = await makeClubWithAthletes("fd1", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }], { overrides: { opensTime: "00:00", closesTime: "23:59" } });
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const afterClose = new Date(closesAtOf(occurrence).getTime() + 60 * 1000);

  // Not asserted on the cycle's own aggregate summary - many other tests in
  // this same shared temp DB default to the same 00:00-23:59 window, so
  // "afterClose" here is also past THEIR closes_at, and the same cycle call
  // correctly finalizes all of them at once. coachId is unique per test, so
  // querying by it directly isolates this test's own signal.
  await processTestNotificationCycle({ now: afterClose, pool });
  await processTestNotificationCycle({ now: afterClose, pool });

  const rows = await query(`select id, title, body from public.app_notifications where recipient_user_id = $1 and type = 'test_final_digest'`, [coachId]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].title, "WELLNESS final summary");
});

test("FD2. a schedule creator is the only coach recipient of both digests in this phase", async () => {
  const { coachId, coachCookie, athletes } = await makeClubWithAthletes("fd2", 1);
  const otherCoachId = await makeUser({ email: `fd2-other-coach-${Date.now()}@test.local` });
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }]);
  await ensureOccurrenceAndAssignments(schedule.id);

  await processTestNotificationCycle({ now: new Date(), pool });
  const coachNotifs = await query(`select id from public.app_notifications where recipient_user_id = $1 and type = 'test_coach_digest'`, [coachId]);
  const otherCoachNotifs = await query(`select id from public.app_notifications where recipient_user_id = $1 and type = 'test_coach_digest'`, [otherCoachId]);
  assert.equal(coachNotifs.rowCount, 1);
  assert.equal(otherCoachNotifs.rowCount, 0);
});

// ------------------------------------------------------------
// N. Notification rules API (create/edit/authorization)
// ------------------------------------------------------------

test("N1. a new schedule's notificationRules are written atomically and returned on GET", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("n1", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }]);
  const detail = await api(`/api/tests/schedules/${schedule.id}`, { cookie: coachCookie });
  assert.equal(detail.body.notificationRules.length, 4);
  const reminder = detail.body.notificationRules.find((r) => r.kind === "athlete_reminder");
  assert.equal(reminder.enabled, true);
  assert.equal(reminder.reminderOffsetMinutes, 60);
});

test("N2. a legacy schedule created without notificationRules reports an EMPTY array - not silently configured, not silently all-enabled", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("n2", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const detail = await api(`/api/tests/schedules/${created.body.schedule.id}`, { cookie: coachCookie });
  assert.deepEqual(detail.body.notificationRules, []);
});

test("N3. one invalid rule kind rolls back the ENTIRE notificationRules write, and the schedule creation with it", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("n3", 1);
  const before = await query(`select count(*)::int as n from tests.test_schedules`);
  const result = await api("/api/tests/schedules", {
    method: "POST", cookie: coachCookie,
    body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], {
      notificationRules: [{ kind: "not_a_real_kind", enabled: true }],
    }),
  });
  assert.equal(result.status, 400);
  const after = await query(`select count(*)::int as n from tests.test_schedules`);
  assert.equal(after.rows[0].n, before.rows[0].n, "nothing must be written - not the schedule, not any rule row");
});

test("N4. PATCH can update notificationRules alone, without touching schedule fields, and the change is atomic", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("n4", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }]);
  const patched = await api(`/api/tests/schedules/${schedule.id}`, {
    method: "PATCH", cookie: coachCookie,
    body: { notificationRules: [{ kind: "athlete_invitation", enabled: false }] },
  });
  assert.equal(patched.status, 200);
  const rules = patched.body.notificationRules;
  assert.equal(rules.find((r) => r.kind === "athlete_invitation").enabled, false);
  assert.equal(rules.find((r) => r.kind === "coach_digest").enabled, false, "kinds omitted from the PATCH resolve to disabled - every save fully replaces the set");
});

test("N5. a different coach cannot read or edit another coach's schedule's notification rules", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("n5", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }]);
  // A genuine coach of a DIFFERENT, unrelated club - not a bare user (a bare
  // user has no coachWorkspace capability at all and would correctly 403 at
  // requireCoachWorkspace before ever reaching the per-schedule 404 check
  // this test is actually about).
  const { coachCookie: outsiderCookie } = await makeClubWithAthletes("n5-outsider", 0);

  const getResult = await api(`/api/tests/schedules/${schedule.id}`, { cookie: outsiderCookie });
  assert.equal(getResult.status, 404);
  const patchResult = await api(`/api/tests/schedules/${schedule.id}`, {
    method: "PATCH", cookie: outsiderCookie,
    body: { notificationRules: [{ kind: "athlete_invitation", enabled: false }] },
  });
  assert.equal(patchResult.status, 404);
});

test("N6. a bulk (Specific dates) request applies the SAME notificationRules to every created schedule", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("n6", 1);
  const result = await api("/api/tests/schedules/bulk", {
    method: "POST", cookie: coachCookie,
    body: { testVersionId: WELLNESS_TEST_VERSION_ID, timezone: "UTC", opensTime: "06:00", closesTime: "22:00", dates: ["2027-01-10", "2027-01-11"], targets: [{ kind: "athlete", id: athletes[0].athleteId }], notificationRules: FULL_RULES_ALL_ON },
  });
  assert.equal(result.status, 201);
  for (const s of result.body.schedules) {
    const detail = await api(`/api/tests/schedules/${s.id}`, { cookie: coachCookie });
    assert.equal(detail.body.notificationRules.length, 4);
    assert.equal(detail.body.notificationRules.find((r) => r.kind === "athlete_invitation").enabled, true);
  }
});

// ------------------------------------------------------------
// W. Worker mechanics (CLI advisory lock, exit code, no network)
// ------------------------------------------------------------

test("W1. the CLI's advisory lock prevents a second concurrent invocation from running a real cycle - it skips instead", async () => {
  const client = await pool.connect();
  try {
    const pidResult = await client.query("select pg_backend_pid() as pid");
    const blockerPid = pidResult.rows[0].pid;
    await client.query("select pg_advisory_lock(822027)"); // same WORKER_LOCK_KEY as testsNotificationWorkerCli.js

    const result = await runTestsNotificationWorkerOnce({ now: new Date(), databaseUrl: db.url });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);

    await client.query("select pg_advisory_unlock(822027)");
  } finally {
    client.release();
  }
});

test("W2. a normal CLI run (lock free) actually processes a cycle and returns ok with real counters", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("w2", 1);
  const schedule = await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }], { overrides: { scheduleKind: "daily", startDate: TODAY, opensTime: "00:00" } });
  const result = await runTestsNotificationWorkerOnce({ now: new Date(), databaseUrl: db.url });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.ok(typeof result.invitations.sent === "number");
  // Phase 4 correction: an open-ended daily schedule now unconditionally
  // generates both today's and tomorrow's occurrence in one call.
  const occurrenceRows = await query(`select id from tests.test_schedule_occurrences where schedule_id = $1`, [schedule.id]);
  assert.equal(occurrenceRows.rowCount, 2);
});

test("W3. processTestNotificationCycle makes no external network calls - only DB queries (fetch is never invoked)", async () => {
  // Setup uses the real fetch (api() helper) - done and complete BEFORE
  // fetch is poisoned below, so only the cycle itself is under test.
  const { coachCookie, athletes } = await makeClubWithAthletes("w3", 1);
  await createScheduleWithRules(coachCookie, [{ kind: "athlete", id: athletes[0].athleteId }], { overrides: { scheduleKind: "daily", startDate: TODAY, opensTime: "00:00" } });

  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = () => { fetchCalled = true; throw new Error("unexpected network call from the worker"); };
  try {
    await processTestNotificationCycle({ now: new Date(), pool });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalled, false);
});

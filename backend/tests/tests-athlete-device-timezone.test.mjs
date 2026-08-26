// Phase 4: per-athlete timezone-correct assignment windows (mobile
// scheduling redesign companion). Covers migrations_v2/202608300900_tests_
// v42_phase4_assignment_timezone_window.sql (public.athletes.device_timezone
// + tests.test_assignments.timezone/opens_at/due_at/closes_at,
// materialize_test_assignments_for_occurrence rewrite), POST /api/tests/
// athlete/timezone, and every reader repointed at the assignment's own
// window (testsOccurrenceService.js's assignmentIsOpen, athlete Today/
// submit, testsCheckIn.js, testsNotificationWorker.js's invitation/reminder
// phases).
//
// Same disposable-temp-database harness as tests-notification-worker.test.mjs
// (never OPTIMOVE, never monitoring2) - the real Strategy B runner, the real
// Express app over real HTTP with real session cookies, plus direct calls
// into processTestNotificationCycle() for the worker-timing tests.
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
// Everything except the Phase 4 migration itself - used by the backfill test
// below, which needs to create a "legacy" (pre-Phase-4) assignment row and
// THEN apply Phase 4 on top of it, to prove the backfill reproduces history
// exactly rather than reinterpreting it.
const MIGRATION_FILES_PRE_PHASE4 = MIGRATION_FILES.slice(0, -1);
const PHASE4_MIGRATION_FILE = MIGRATION_FILES[MIGRATION_FILES.length - 1];

const WELLNESS_TEST_VERSION_ID = "7a386bd1-d25e-4651-9012-e76d9dc32559";

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
  const name = `optimove_tests_athletetz_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_athletetz_migrations_${runId}`);
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
let processTestNotificationCycle;

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
// Fixture helpers (same shapes as tests-notification-worker.test.mjs)
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

const TODAY = new Date().toISOString().slice(0, 10);

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
    opensTime: "06:00",
    closesTime: "23:59",
    targets,
    ...overrides,
  };
}

async function createSchedule(coachCookie, targets, overrides = {}) {
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody(targets, overrides) });
  assert.equal(created.status, 201, `expected schedule creation to succeed: ${JSON.stringify(created.body)}`);
  return created.body.schedule;
}

async function ensureOccurrenceAndAssignments(scheduleId) {
  const scheduleResult = await query(`select * from tests.test_schedules where id = $1`, [scheduleId]);
  await ensureCurrentOccurrence(pool, scheduleResult.rows[0]);
  const occurrenceResult = await query(`select * from tests.test_schedule_occurrences where schedule_id = $1`, [scheduleId]);
  return { occurrence: occurrenceResult.rows[0] };
}

async function assignmentFor(occurrenceId, athleteId) {
  const result = await query(`select * from tests.test_assignments where occurrence_id = $1 and athlete_id = $2`, [occurrenceId, athleteId]);
  return result.rows[0];
}

async function setDeviceTimezone(athleteCookie, timezone) {
  return api("/api/tests/athlete/timezone", { method: "POST", cookie: athleteCookie, body: { timezone } });
}

// ------------------------------------------------------------
// 1. Same schedule, two athletes, two timezones, two different UTC instants
// ------------------------------------------------------------

test("1. same schedule opening at 06:00: Europe/Belgrade and Asia/Dubai athletes both get 06:00 LOCAL, but different UTC timestamps", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz1", 0);
  const belgradeUserId = await makeUser({ email: `tz1-belgrade-${Date.now()}@test.local`, roleHint: "athlete" });
  const belgradeAthleteId = await makeAthlete({ name: "Belgrade Athlete", userId: belgradeUserId });
  await addMembership(belgradeAthleteId, { clubId });
  const belgradeCookie = await loginCookie(belgradeUserId);
  await setDeviceTimezone(belgradeCookie, "Europe/Belgrade");

  const dubaiUserId = await makeUser({ email: `tz1-dubai-${Date.now()}@test.local`, roleHint: "athlete" });
  const dubaiAthleteId = await makeAthlete({ name: "Dubai Athlete", userId: dubaiUserId });
  await addMembership(dubaiAthleteId, { clubId });
  const dubaiCookie = await loginCookie(dubaiUserId);
  await setDeviceTimezone(dubaiCookie, "Asia/Dubai");

  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);

  const belgradeAssignment = await assignmentFor(occurrence.id, belgradeAthleteId);
  const dubaiAssignment = await assignmentFor(occurrence.id, dubaiAthleteId);

  assert.equal(belgradeAssignment.timezone, "Europe/Belgrade");
  assert.equal(dubaiAssignment.timezone, "Asia/Dubai");
  // Same local_scheduled_date (the calendar-date label is shared, per spec) ...
  assert.equal(String(belgradeAssignment.local_scheduled_date), String(dubaiAssignment.local_scheduled_date));
  // ... but genuinely different absolute UTC instants for opens_at, since
  // Europe/Belgrade and Asia/Dubai are not the same UTC offset.
  assert.notEqual(new Date(belgradeAssignment.opens_at).getTime(), new Date(dubaiAssignment.opens_at).getTime());

  // Both, independently, read back as exactly 06:00 in THEIR OWN local zone.
  const belgradeLocal = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Belgrade", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(belgradeAssignment.opens_at));
  const dubaiLocal = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(dubaiAssignment.opens_at));
  assert.equal(belgradeLocal, "06:00");
  assert.equal(dubaiLocal, "06:00");
});

// ------------------------------------------------------------
// 2. DST transition (America/New_York)
// ------------------------------------------------------------

test("2. America/New_York opens_at is computed correctly across a DST transition (EST vs EDT UTC offset genuinely differs)", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz2", 0);
  const userId = await makeUser({ email: `tz2-ny-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "NY Athlete", userId });
  await addMembership(athleteId, { clubId });
  const athleteCookie = await loginCookie(userId);
  await setDeviceTimezone(athleteCookie, "America/New_York");

  // 2027-01-15 is EST (UTC-5); 2027-07-15 is EDT (UTC-4) - a real DST
  // difference, not a fixed offset.
  const winterSchedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { startDate: "2027-01-15", endDate: "2027-01-15", opensTime: "06:00", closesTime: "23:59" });
  const summerSchedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { startDate: "2027-07-15", endDate: "2027-07-15", opensTime: "06:00", closesTime: "23:59" });

  const winterOccResult = await query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [winterSchedule.id, "2027-01-15"]);
  await query(`select tests.materialize_test_assignments_for_occurrence($1)`, [winterOccResult.rows[0].id]);
  const summerOccResult = await query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [summerSchedule.id, "2027-07-15"]);
  await query(`select tests.materialize_test_assignments_for_occurrence($1)`, [summerOccResult.rows[0].id]);

  const winterAssignment = await assignmentFor(winterOccResult.rows[0].id, athleteId);
  const summerAssignment = await assignmentFor(summerOccResult.rows[0].id, athleteId);

  const winterUtcHour = new Date(winterAssignment.opens_at).getUTCHours();
  const summerUtcHour = new Date(summerAssignment.opens_at).getUTCHours();
  assert.equal(winterUtcHour, 11, "06:00 EST (UTC-5) must be 11:00 UTC");
  assert.equal(summerUtcHour, 10, "06:00 EDT (UTC-4) must be 10:00 UTC - a real DST-driven offset change, not a fixed -5");

  // Both still read back as exactly 06:00 local, regardless of which side of the DST boundary.
  const winterLocal = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(winterAssignment.opens_at));
  const summerLocal = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(summerAssignment.opens_at));
  assert.equal(winterLocal, "06:00");
  assert.equal(summerLocal, "06:00");
});

// ------------------------------------------------------------
// 3. Invalid IANA timezone rejected
// ------------------------------------------------------------

test("3. an invalid IANA timezone string is rejected with a controlled 400, and never stored", async () => {
  const userId = await makeUser({ email: `tz3-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Invalid TZ Athlete", userId });
  const athleteCookie = await loginCookie(userId);

  const result = await setDeviceTimezone(athleteCookie, "Not/A_Real_Zone");
  assert.equal(result.status, 400, `expected a controlled 400, got ${result.status}: ${JSON.stringify(result.body)}`);

  const row = await query(`select device_timezone from public.athletes where id = $1`, [athleteId]);
  assert.equal(row.rows[0].device_timezone, null, "an invalid value must never be stored, not even partially");
});

// ------------------------------------------------------------
// 4. Unknown timezone falls back to schedule.timezone
// ------------------------------------------------------------

test("4. an athlete who never reported a device timezone falls back to the schedule's own timezone", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz4", 0);
  const userId = await makeUser({ email: `tz4-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "No TZ Athlete", userId });
  await addMembership(athleteId, { clubId });
  // Deliberately never call setDeviceTimezone - device_timezone stays NULL.

  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "Asia/Tokyo" });
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignment = await assignmentFor(occurrence.id, athleteId);

  assert.equal(assignment.timezone, "Asia/Tokyo", "must fall back to the schedule's own timezone");
  assert.equal(new Date(assignment.opens_at).getTime(), new Date(occurrence.opens_at).getTime(), "with the fallback, the assignment window must equal the occurrence's own reference window exactly");
});

// ------------------------------------------------------------
// 5 & 6. Travel: today stays frozen, future days pick up the new zone
// ------------------------------------------------------------

test("5 & 6. changing device timezone never touches an already-materialized assignment, but a LATER not-yet-materialized day uses the new zone", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz56", 0);
  const userId = await makeUser({ email: `tz56-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Traveling Athlete", userId });
  await addMembership(athleteId, { clubId });
  const athleteCookie = await loginCookie(userId);
  await setDeviceTimezone(athleteCookie, "Europe/Belgrade");

  // Day 1: a daily schedule, materialize today's occurrence while the
  // athlete is still in Belgrade.
  const daily = await api("/api/tests/schedules", {
    method: "POST", cookie: coachCookie,
    body: baseCreateBody([{ kind: "club", id: clubId }], { scheduleKind: "daily", startDate: "2027-03-01", endDate: "2027-03-10", timezone: "UTC" }),
  });
  assert.equal(daily.status, 201);
  const scheduleId = daily.body.schedule.id;

  const day1Occ = await query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [scheduleId, "2027-03-01"]);
  await query(`select tests.materialize_test_assignments_for_occurrence($1)`, [day1Occ.rows[0].id]);
  const day1Assignment = await assignmentFor(day1Occ.rows[0].id, athleteId);
  assert.equal(day1Assignment.timezone, "Europe/Belgrade");
  const day1OpensAt = day1Assignment.opens_at;

  // Athlete travels - reports a new device timezone AFTER day 1 already materialized.
  await setDeviceTimezone(athleteCookie, "America/Los_Angeles");

  // Day 1's already-materialized assignment must be completely untouched.
  const day1AfterTravel = await assignmentFor(day1Occ.rows[0].id, athleteId);
  assert.equal(day1AfterTravel.timezone, "Europe/Belgrade", "an already-materialized assignment's timezone must never change after the fact");
  assert.equal(new Date(day1AfterTravel.opens_at).getTime(), new Date(day1OpensAt).getTime(), "an already-materialized assignment's opens_at must never change after the fact");

  // Day 2 (not yet materialized) must pick up the NEW timezone.
  const day2Occ = await query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [scheduleId, "2027-03-02"]);
  await query(`select tests.materialize_test_assignments_for_occurrence($1)`, [day2Occ.rows[0].id]);
  const day2Assignment = await assignmentFor(day2Occ.rows[0].id, athleteId);
  assert.equal(day2Assignment.timezone, "America/Los_Angeles", "a future, not-yet-materialized day must use the athlete's NEW current timezone");
});

// ------------------------------------------------------------
// 7. Backfill preserves pre-migration history exactly
// ------------------------------------------------------------

test("7. existing (pre-migration) assignments are backfilled from their occurrence, preserving exact prior opens/due/closes values", async () => {
  const preDb = await makeTempDb("prephase4");
  const preAdmin = new pg.Client({ connectionString: preDb.url });
  try {
    await preAdmin.connect();
    await preAdmin.query(LEGACY_FIXTURE_SQL);
    const preContents = await Promise.all(MIGRATION_FILES_PRE_PHASE4.map((name) => fsp.readFile(path.resolve(__dirname, "../../migrations_v2", name), "utf8")));
    const preFiles = {};
    MIGRATION_FILES_PRE_PHASE4.forEach((name, i) => { preFiles[name] = preContents[i]; });
    // migrationIdentity() (migrate.js) is basename(migrationsRoot) + "/" +
    // relative-path - the SAME migrationsRoot directory must be reused for
    // both runMigrations calls below, or the already-applied files would be
    // seen under a different identity the second time and re-applied
    // (colliding with the tables they already created).
    const preMigrationsDir = await writeMigrationsDir("prephase4", preFiles);
    await runner.runMigrations({ databaseUrl: preDb.url, migrationsRoot: preMigrationsDir });

    // Build a real "legacy" assignment the OLD way, entirely pre-Phase-4.
    const club = await preAdmin.query(`insert into public.clubs (name) values ('Legacy Club') returning id`);
    const coach = await preAdmin.query(`insert into public.users (email, password_hash, full_name, role_hint) values ('legacy-coach@test.local','x','Legacy Coach','coach') returning id`);
    const athlete = await preAdmin.query(`insert into public.athletes (full_name, display_name) values ('Legacy Athlete','Legacy Athlete') returning id`);
    await preAdmin.query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athlete.rows[0].id, club.rows[0].id]);
    const schedule = await preAdmin.query(
      `insert into tests.test_schedules (test_version_id, schedule_kind, timezone, start_date, opens_time, due_time, closes_time, status, created_by_user_id, owner_scope, owner_club_id)
       values ($1,'one_time','Europe/Belgrade','2027-05-01','06:00','12:00','23:59','active',$2,'club',$3) returning id`,
      [WELLNESS_TEST_VERSION_ID, coach.rows[0].id, club.rows[0].id],
    );
    await preAdmin.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_club_id) values ($1,'club',$2)`, [schedule.rows[0].id, club.rows[0].id]);
    const occ = await preAdmin.query(`select tests.generate_test_schedule_occurrence($1, '2027-05-01') as id`, [schedule.rows[0].id]);
    await preAdmin.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occ.rows[0].id]);
    const occRow = await preAdmin.query(`select opens_at, due_at, closes_at, scheduled_date from tests.test_schedule_occurrences where id = $1`, [occ.rows[0].id]);
    const legacyAssignmentBefore = await preAdmin.query(`select id from tests.test_assignments where occurrence_id = $1 and athlete_id = $2`, [occ.rows[0].id, athlete.rows[0].id]);
    assert.equal(legacyAssignmentBefore.rowCount, 1, "sanity: the legacy assignment must exist before Phase 4 runs");

    // NOW apply Phase 4 on top of this already-populated database - adding
    // the new file into the SAME directory (see the comment above) so the
    // 7 already-applied migrations are recognized as such and only the new
    // one actually runs.
    const phase4Sql = await fsp.readFile(path.resolve(__dirname, "../../migrations_v2", PHASE4_MIGRATION_FILE), "utf8");
    await fsp.writeFile(path.join(preMigrationsDir, PHASE4_MIGRATION_FILE), phase4Sql, "utf8");
    await runner.runMigrations({ databaseUrl: preDb.url, migrationsRoot: preMigrationsDir });
    await fsp.rm(preMigrationsDir, { recursive: true, force: true });

    const backfilled = await preAdmin.query(`select timezone, local_scheduled_date, opens_at, due_at, closes_at from tests.test_assignments where id = $1`, [legacyAssignmentBefore.rows[0].id]);
    const row = backfilled.rows[0];
    assert.equal(row.timezone, "Europe/Belgrade");
    assert.equal(String(row.local_scheduled_date), String(occRow.rows[0].scheduled_date));
    assert.equal(new Date(row.opens_at).getTime(), new Date(occRow.rows[0].opens_at).getTime(), "backfilled opens_at must exactly equal the pre-existing occurrence opens_at - history is preserved, not reinterpreted");
    assert.equal(new Date(row.due_at).getTime(), new Date(occRow.rows[0].due_at).getTime());
    assert.equal(new Date(row.closes_at).getTime(), new Date(occRow.rows[0].closes_at).getTime());
  } finally {
    await preAdmin.end();
    await dropTempDb(preDb);
  }
});

// ------------------------------------------------------------
// 8. Athlete Today and submit agree on the same assignment window
// ------------------------------------------------------------

test("8. athlete Today and POST submit use the exact same assignment window - never 'frontend shows open, backend rejects'", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz8", 0);
  const userId = await makeUser({ email: `tz8-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Today Submit Athlete", userId });
  await addMembership(athleteId, { clubId });
  const athleteCookie = await loginCookie(userId);
  // A timezone far enough from UTC that "now" is very likely still within
  // the assignment's open window in the athlete's OWN zone, wide open/close
  // margins make the actual offset irrelevant to this test's assertion.
  await setDeviceTimezone(athleteCookie, "Pacific/Auckland");

  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "UTC", opensTime: "00:00", closesTime: "23:59" });

  const today = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  assert.equal(today.status, 200);
  assert.equal(today.body.assignments.length, 1);
  const assignmentId = today.body.assignments[0].assignmentId;
  assert.equal(today.body.assignments[0].occurrence.isOpen, true, "Today must report this assignment as open");

  const detail = await api(`/api/tests/assignments/${assignmentId}`, { cookie: athleteCookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.canSubmit, true, "the assignment-detail GET must agree with Today");

  const submitted = await api(`/api/tests/assignments/${assignmentId}/submit`, {
    method: "POST", cookie: athleteCookie,
    body: { values: { fatigue: 5, soreness: 5, sleep: 5, mood: 5, stress: 5, injury: false } },
  });
  assert.equal(submitted.status, 200, `submit must succeed since Today/detail both reported it open: ${JSON.stringify(submitted.body)}`);
});

// ------------------------------------------------------------
// 9. Invitation/reminder worker uses the assignment window
// ------------------------------------------------------------

test("9. the invitation worker fires based on the ASSIGNMENT's own opens_at, not the shared occurrence's - proven with two athletes whose effective timezones disagree about whether it's open", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz9", 0);
  const knownUserId = await makeUser({ email: `tz9-known-${Date.now()}@test.local`, roleHint: "athlete" });
  const knownAthleteId = await makeAthlete({ name: "Known TZ Athlete", userId: knownUserId });
  await addMembership(knownAthleteId, { clubId });
  const knownCookie = await loginCookie(knownUserId);
  // The schedule's own reference timezone is UTC; this athlete's own
  // effective timezone is UTC+14 (Pacific/Kiritimati, the earliest
  // civil timezone in the world) - a schedule opening at 06:00 UTC on the
  // scheduled date opens at 06:00 in Kiritimati too, but that is a
  // genuinely different, EARLIER UTC instant (06:00 - 14h = the previous
  // day 16:00 UTC) than the shared occurrence's own 06:00 UTC reference
  // window - proving the worker is really reading the per-assignment value.
  await setDeviceTimezone(knownCookie, "Pacific/Kiritimati");

  const schedule = await createSchedule(coachCookie, [{ kind: "athlete", id: knownAthleteId }], {
    timezone: "UTC", opensTime: "06:00", closesTime: "23:59",
    notificationRules: [{ kind: "athlete_invitation", enabled: true }],
  });
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignment = await assignmentFor(occurrence.id, knownAthleteId);

  assert.notEqual(new Date(assignment.opens_at).getTime(), new Date(occurrence.opens_at).getTime(), "sanity: the assignment's own opens_at must genuinely differ from the occurrence's shared reference opens_at");

  // `now` sits strictly between the assignment's own (earlier) opens_at and
  // the occurrence's (later) shared opens_at - only a worker reading the
  // ASSIGNMENT's own window would send an invitation at this instant.
  const proofInstant = new Date((new Date(assignment.opens_at).getTime() + new Date(occurrence.opens_at).getTime()) / 2);
  assert.ok(proofInstant > new Date(assignment.opens_at) && proofInstant < new Date(occurrence.opens_at));

  const summary = await processTestNotificationCycle({ now: proofInstant, pool });
  assert.equal(summary.invitations.sent, 1, `expected exactly one invitation sent at this proof instant, got: ${JSON.stringify(summary.invitations)}`);

  const notif = await query(`select count(*)::int as n from public.app_notifications where recipient_user_id = $1 and type = 'test_athlete_invitation'`, [knownUserId]);
  assert.equal(notif.rows[0].n, 1);
});

// ------------------------------------------------------------
// 10. Completed/cancelled/paused behavior - no regression
// ------------------------------------------------------------

test("10. cancelled schedule + paused schedule still correctly block submit, with a device timezone in play - no regression from Phase 4", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz10", 0);
  const userId = await makeUser({ email: `tz10-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Cancel Pause Athlete", userId });
  await addMembership(athleteId, { clubId });
  const athleteCookie = await loginCookie(userId);
  await setDeviceTimezone(athleteCookie, "Europe/Belgrade");

  const cancelledSchedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "UTC", opensTime: "00:00", closesTime: "23:59" });
  await ensureOccurrenceAndAssignments(cancelledSchedule.id);
  const cancelToday = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  const cancelAssignmentId = cancelToday.body.assignments[0].assignmentId;
  const cancelled = await api(`/api/tests/schedules/${cancelledSchedule.id}`, { method: "DELETE", cookie: coachCookie });
  assert.equal(cancelled.status, 200);
  const submitAfterCancel = await api(`/api/tests/assignments/${cancelAssignmentId}/submit`, {
    method: "POST", cookie: athleteCookie,
    body: { values: { fatigue: 5, soreness: 5, sleep: 5, mood: 5, stress: 5, injury: false } },
  });
  assert.equal(submitAfterCancel.status, 409);

  const pausedSchedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "UTC", opensTime: "00:00", closesTime: "23:59" });
  await ensureOccurrenceAndAssignments(pausedSchedule.id);
  const pauseToday = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  const pauseAssignmentId = pauseToday.body.assignments.find((a) => a.assignmentId !== cancelAssignmentId)?.assignmentId;
  const paused = await api(`/api/tests/schedules/${pausedSchedule.id}`, { method: "PATCH", cookie: coachCookie, body: { status: "paused" } });
  assert.equal(paused.status, 200);
  const submitAfterPause = await api(`/api/tests/assignments/${pauseAssignmentId}/submit`, {
    method: "POST", cookie: athleteCookie,
    body: { values: { fatigue: 5, soreness: 5, sleep: 5, mood: 5, stress: 5, injury: false } },
  });
  assert.equal(submitAfterPause.status, 409);
});

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

function addDaysIso(iso, delta) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Item 1 correction: every test below that needs "the real current local
// date in timezone X" queries Postgres directly for it, rather than
// assuming any fixed relationship to TODAY (UTC) - this is what makes
// these tests deterministic regardless of what real moment they happen to
// run at (a fixed assumption like "Pacific/Auckland is always one day
// ahead of UTC" is only true part of the time).
async function localDateIn(timezone) {
  const result = await query(`select (now() at time zone $1)::date as d`, [timezone]);
  return result.rows[0].d;
}

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

  // Item 1 correction: candidate dates are target-derived, never guessed
  // from the schedule's own timezone - so start_date must be a date at
  // least one real target is currently on. Dubai (UTC+4) is never BEHIND
  // Belgrade's own date (its offset is always >= Belgrade's, winter or
  // summer) - Belgrade's own real current date is therefore always safe:
  // Belgrade is trivially on it, and Dubai is either also on it or has
  // already rolled exactly one day further ahead (the narrow daily window
  // where a 2-3h offset gap crosses a date boundary) - branch on the real,
  // directly-queried relationship so this is deterministic either way,
  // never a coin flip.
  const belgradeDate = await localDateIn("Europe/Belgrade");
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "UTC", startDate: belgradeDate, opensTime: "06:00", closesTime: "23:59" });
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);

  const belgradeAssignment = await assignmentFor(occurrence.id, belgradeAthleteId);
  assert.ok(belgradeAssignment, "Belgrade must be eligible - the occurrence's own date is Belgrade's real current date");
  assert.equal(belgradeAssignment.timezone, "Europe/Belgrade");
  const belgradeLocal = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Belgrade", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(belgradeAssignment.opens_at));
  assert.equal(belgradeLocal, "06:00");

  const dubaiDate = await localDateIn("Asia/Dubai");
  if (dubaiDate === belgradeDate) {
    const dubaiAssignment = await assignmentFor(occurrence.id, dubaiAthleteId);
    assert.ok(dubaiAssignment, "Dubai is currently on the same real date as Belgrade - both must share the exact same occurrence");
    assert.equal(dubaiAssignment.timezone, "Asia/Dubai");
    // Same local_scheduled_date (the calendar-date label is shared, per spec) ...
    assert.equal(String(belgradeAssignment.local_scheduled_date), String(dubaiAssignment.local_scheduled_date));
    // ... but genuinely different absolute UTC instants for opens_at, since
    // Europe/Belgrade and Asia/Dubai are not the same UTC offset.
    assert.notEqual(new Date(belgradeAssignment.opens_at).getTime(), new Date(dubaiAssignment.opens_at).getTime());
    const dubaiLocal = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(dubaiAssignment.opens_at));
    assert.equal(dubaiLocal, "06:00");
  } else {
    // Dubai has already rolled exactly one real day ahead of Belgrade at
    // this instant - a one-time date is never reinterpreted per timezone,
    // so Dubai still owes Belgrade's own declared start_date, not its own
    // "today", and is correctly NOT YET eligible under this occurrence.
    assert.equal(dubaiDate, addDaysIso(belgradeDate, 1), "Dubai can only ever equal or be exactly one day ahead of Belgrade's own date, never behind");
    const dubaiAssignment = await assignmentFor(occurrence.id, dubaiAthleteId);
    assert.equal(dubaiAssignment, undefined, "Dubai's own current date has already moved past this occurrence's fixed calendar date - not yet eligible under it");
  }
});

// ------------------------------------------------------------
// 2. DST transition (America/New_York)
// ------------------------------------------------------------

test("2. America/New_York opens_at is computed correctly across a DST transition (EST vs EDT UTC offset genuinely differs)", async () => {
  // Item 2 correction: materialize_test_assignments_for_occurrence() now
  // gates EVERY insert (one_time included) on the athlete's own real
  // current local date matching the occurrence's scheduled_date - so a
  // fixed, arbitrary-season date unrelated to real "now" (2027-01-15,
  // 2027-07-15) would never actually materialize an assignment through
  // that path. This test's real purpose is proving the WINDOW-COMPUTATION
  // FORMULA itself handles DST correctly (a fixed calendar date + wall-
  // clock time, converted through an IANA zone) - the exact same
  // `(date + time) at time zone tz` expression materialize_test_
  // assignments_for_occurrence uses for opens_at - so it is asserted
  // directly via SQL, decoupled from eligibility timing (already proven
  // deterministically by other tests in this file).
  const winterOpensUtc = await query(`select (date '2027-01-15' + time '06:00') at time zone 'America/New_York' as opens_utc`);
  const summerOpensUtc = await query(`select (date '2027-07-15' + time '06:00') at time zone 'America/New_York' as opens_utc`);

  const winterUtcHour = new Date(winterOpensUtc.rows[0].opens_utc).getUTCHours();
  const summerUtcHour = new Date(summerOpensUtc.rows[0].opens_utc).getUTCHours();
  assert.equal(winterUtcHour, 11, "06:00 EST (UTC-5) must be 11:00 UTC");
  assert.equal(summerUtcHour, 10, "06:00 EDT (UTC-4) must be 10:00 UTC - a real DST-driven offset change, not a fixed -5");

  // Both still read back as exactly 06:00 local, regardless of which side of the DST boundary.
  const winterLocal = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(winterOpensUtc.rows[0].opens_utc));
  const summerLocal = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(summerOpensUtc.rows[0].opens_utc));
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
  // Deliberately never call setDeviceTimezone - device_timezone stays NULL,
  // so the athlete's effective timezone falls back to the schedule's own
  // (Asia/Tokyo). Item 1 correction: candidate dates are target-derived, so
  // start_date must be a date the FALLBACK-resolved athlete is genuinely on
  // right now - Tokyo's own real current date (queried directly), not
  // TODAY (a UTC-based JS computation that only sometimes agrees with it).
  const tokyoToday = await localDateIn("Asia/Tokyo");
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "Asia/Tokyo", startDate: tokyoToday });
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignment = await assignmentFor(occurrence.id, athleteId);

  assert.equal(assignment.timezone, "Asia/Tokyo", "must fall back to the schedule's own timezone");
  assert.equal(new Date(assignment.opens_at).getTime(), new Date(occurrence.opens_at).getTime(), "with the fallback, the assignment window must equal the occurrence's own reference window exactly");
});

// ------------------------------------------------------------
// 5. Travel: an already-materialized assignment stays frozen
// ------------------------------------------------------------

test("5. changing device timezone never touches an already-materialized assignment", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz5", 0);
  const userId = await makeUser({ email: `tz5-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Traveling Athlete", userId });
  await addMembership(athleteId, { clubId });
  const athleteCookie = await loginCookie(userId);
  await setDeviceTimezone(athleteCookie, "Europe/Belgrade");

  // Day 1 = Belgrade's own real current date (queried directly - item 1
  // correction means candidate/eligible dates are target-derived, so this
  // must be the athlete's own real date, not a UTC-based JS computation
  // that only sometimes agrees with it).
  const day1 = await localDateIn("Europe/Belgrade");
  const daily = await api("/api/tests/schedules", {
    method: "POST", cookie: coachCookie,
    body: baseCreateBody([{ kind: "club", id: clubId }], { scheduleKind: "daily", startDate: day1, endDate: addDaysIso(day1, 30), timezone: "UTC" }),
  });
  assert.equal(daily.status, 201);
  const scheduleId = daily.body.schedule.id;

  const day1Occ = await query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [scheduleId, day1]);
  await query(`select tests.materialize_test_assignments_for_occurrence($1)`, [day1Occ.rows[0].id]);
  const day1Assignment = await assignmentFor(day1Occ.rows[0].id, athleteId);
  assert.ok(day1Assignment, "day 1's occurrence is the athlete's own real current date - must already be eligible");
  assert.equal(day1Assignment.timezone, "Europe/Belgrade");
  const day1OpensAt = day1Assignment.opens_at;

  // Athlete travels - reports a new device timezone AFTER day 1 already materialized.
  await setDeviceTimezone(athleteCookie, "America/Los_Angeles");

  // Day 1's already-materialized assignment must be completely untouched.
  const day1AfterTravel = await assignmentFor(day1Occ.rows[0].id, athleteId);
  assert.equal(day1AfterTravel.timezone, "Europe/Belgrade", "an already-materialized assignment's timezone must never change after the fact");
  assert.equal(new Date(day1AfterTravel.opens_at).getTime(), new Date(day1OpensAt).getTime(), "an already-materialized assignment's opens_at must never change after the fact");

  // Re-materializing the SAME occurrence again (as a real worker cycle
  // would) must be a pure no-op for this athlete - `on conflict do nothing`
  // never re-evaluates an already-inserted row against the new timezone.
  const reinsertedCount = await query(`select tests.materialize_test_assignments_for_occurrence($1) as n`, [day1Occ.rows[0].id]);
  assert.equal(reinsertedCount.rows[0].n, 0, "re-running materialize must insert nothing new for an athlete who already has a row");
  const day1StillAfter = await assignmentFor(day1Occ.rows[0].id, athleteId);
  assert.equal(day1StillAfter.timezone, "Europe/Belgrade");
});

// ------------------------------------------------------------
// 6. A timezone change AFTER the membership snapshot but BEFORE the
// assignment's own INSERT must use the NEW zone (item 2 correction: the
// snapshot table freezes membership only, never effective_timezone).
// ------------------------------------------------------------

test("6. a device-timezone change after the membership snapshot but before the assignment is actually inserted uses the NEW zone, not whatever was current at snapshot time", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz6", 0);
  const userId = await makeUser({ email: `tz6-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Snapshot Then Travel Athlete", userId });
  await addMembership(athleteId, { clubId });
  const athleteCookie = await loginCookie(userId);

  // Pacific/Pago_Pago (UTC-11, no DST) and Pacific/Kiritimati (UTC+14, no
  // DST) have a fixed 25-hour offset gap - strictly more than 24h, which
  // GUARANTEES their real current calendar dates are never equal (always
  // exactly 1 or 2 days apart, depending on time of day) - a fully
  // deterministic "definitely behind" / "definitely on this date" pair,
  // with no time-of-day-dependent branching needed anywhere below.
  await setDeviceTimezone(athleteCookie, "Pacific/Pago_Pago");
  const kiritimatiToday = await localDateIn("Pacific/Kiritimati");

  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "UTC", startDate: kiritimatiToday, opensTime: "00:00", closesTime: "23:59" });
  // The athlete's ONLY device timezone right now (Pago_Pago) is guaranteed
  // not to be on kiritimatiToday yet, so ensureCurrentOccurrence() itself
  // would never generate this occurrence at all (correctly - nobody is
  // really on it yet). Generate it directly, exactly like the worker's own
  // "an ahead athlete elsewhere already needs this date" case would, so the
  // membership-snapshot-vs-eligibility split can be tested in isolation.
  const occResult = await query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [schedule.id, kiritimatiToday]);
  const occurrence = { id: occResult.rows[0].id };
  await query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occurrence.id]);

  // Membership was snapshotted by the materialize call above, but
  // Pago_Pago is guaranteed NOT on kiritimatiToday yet - no assignment row
  // exists.
  const snapshotRow = await query(`select 1 from tests.test_occurrence_target_snapshot where occurrence_id = $1 and athlete_id = $2`, [occurrence.id, athleteId]);
  assert.equal(snapshotRow.rowCount, 1, "membership must already be frozen");
  const beforeTravel = await assignmentFor(occurrence.id, athleteId);
  assert.equal(beforeTravel, undefined, "Pago_Pago is guaranteed to not yet be on this occurrence's date - not eligible yet");

  // Athlete travels to Kiritimati AFTER the membership snapshot was taken,
  // but the assignment row has never been inserted yet.
  await setDeviceTimezone(athleteCookie, "Pacific/Kiritimati");
  await query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occurrence.id]);

  const afterTravel = await assignmentFor(occurrence.id, athleteId);
  assert.ok(afterTravel, "now eligible - Kiritimati's own real current date matches this occurrence's date");
  assert.equal(afterTravel.timezone, "Pacific/Kiritimati", "the NEW (current-at-insert-time) timezone must be used, never whatever was current back at snapshot time");
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
  // A timezone far enough from UTC that this test actually exercises the
  // cross-timezone path, with wide open/close margins so the exact offset
  // is irrelevant to whether the window itself is open. The schedule's own
  // startDate is set to Auckland's REAL current local date (queried
  // directly, not assumed) - "one-time datum ostaje isti lokalni datum za
  // svakog sportistu" means this athlete's own local_scheduled_date must
  // equal their own today for Today to show it at all, deterministically,
  // regardless of what UTC's own date happens to be at test-run time.
  await setDeviceTimezone(athleteCookie, "Pacific/Auckland");
  const aucklandToday = await localDateIn("Pacific/Auckland");

  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "UTC", startDate: aucklandToday, opensTime: "00:00", closesTime: "23:59" });

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
  // Item 1 correction: start_date must be a date the athlete is genuinely
  // on right now - Kiritimati's own real current date, queried directly.
  const kiritimatiToday = await localDateIn("Pacific/Kiritimati");

  const schedule = await createSchedule(coachCookie, [{ kind: "athlete", id: knownAthleteId }], {
    timezone: "UTC", startDate: kiritimatiToday, opensTime: "06:00", closesTime: "23:59",
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
  // Item 1 correction: start_date must be a date the athlete is genuinely
  // on right now - Belgrade's own real current date, queried directly.
  const belgradeToday = await localDateIn("Europe/Belgrade");

  const cancelledSchedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "UTC", startDate: belgradeToday, opensTime: "00:00", closesTime: "23:59" });
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

  const pausedSchedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "UTC", startDate: belgradeToday, opensTime: "00:00", closesTime: "23:59" });
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

// ------------------------------------------------------------
// Correction round: occurrence generation must support the logical
// scheduled date currently relevant to the TARGET athlete, not only the
// schedule's own reference timezone's "today" (migrations_v2/202608300900_
// ..._phase4_assignment_timezone_window.sql's "OCCURRENCE GENERATION ALSO
// HAD TO CHANGE" section).
// ------------------------------------------------------------

test("11. one-time: the schedule's own zone is still a full day behind when a Kiritimati-ahead athlete's own day arrives - the occurrence generates EARLY, not late", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz11", 0);
  const userId = await makeUser({ email: `tz11-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Kiritimati Athlete", userId });
  await addMembership(athleteId, { clubId });
  const athleteCookie = await loginCookie(userId);
  await setDeviceTimezone(athleteCookie, "Pacific/Kiritimati");

  // Pacific/Pago_Pago (UTC-11) and Pacific/Kiritimati (UTC+14) have a fixed
  // 25-hour offset gap - strictly more than 24h, GUARANTEEING their real
  // current calendar dates are never equal (always 1-2 days apart), so the
  // schedule's own reference zone is deterministically, always genuinely
  // "still behind" here - no dependency on what time of day this runs.
  const kiritimatiToday = await localDateIn("Pacific/Kiritimati");
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "Pacific/Pago_Pago", startDate: kiritimatiToday, opensTime: "00:00", closesTime: "23:59" });

  const scheduleRow = await query(`select * from tests.test_schedules where id = $1`, [schedule.id]);
  const occurrenceIds = await ensureCurrentOccurrence(pool, scheduleRow.rows[0]);
  assert.equal(occurrenceIds.length, 1, "the occurrence for the athlete's own real current date must already be generated, even though the schedule's own zone is still behind it");

  const occ = await query(`select scheduled_date from tests.test_schedule_occurrences where id = $1`, [occurrenceIds[0]]);
  assert.equal(String(occ.rows[0].scheduled_date), kiritimatiToday);

  const assignment = await assignmentFor(occurrenceIds[0], athleteId);
  assert.ok(assignment, "the Kiritimati athlete must already have a real assignment row, before the schedule's own zone even reaches start_date");
  assert.equal(assignment.timezone, "Pacific/Kiritimati");
});

test("one-time: an athlete whose own day has ALREADY started but the schedule's own zone hasn't reached start_date yet still gets canSubmit correctly once open", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz11b", 0);
  const userId = await makeUser({ email: `tz11b-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Already Started Athlete", userId });
  await addMembership(athleteId, { clubId });
  const athleteCookie = await loginCookie(userId);
  await setDeviceTimezone(athleteCookie, "Pacific/Kiritimati");

  const kiritimatiToday = await localDateIn("Pacific/Kiritimati");
  await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "Pacific/Pago_Pago", startDate: kiritimatiToday, opensTime: "00:00", closesTime: "23:59" });

  const today = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  assert.equal(today.status, 200);
  assert.equal(today.body.assignments.length, 1, "Today must already show it - it genuinely is today for this athlete's own local calendar");
  assert.equal(today.body.assignments[0].occurrence.isOpen, true);
});

test("12. daily: two DIFFERENT logical dates are simultaneously in play - occurrences for BOTH the behind athlete's and the ahead athlete's own dates exist at once, each with the correct athlete", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz12", 0);
  const behindUserId = await makeUser({ email: `tz12-behind-${Date.now()}@test.local`, roleHint: "athlete" });
  const behindAthleteId = await makeAthlete({ name: "Behind Athlete", userId: behindUserId });
  await addMembership(behindAthleteId, { clubId });
  await setDeviceTimezone(await loginCookie(behindUserId), "Pacific/Pago_Pago");

  const aheadUserId = await makeUser({ email: `tz12-ahead-${Date.now()}@test.local`, roleHint: "athlete" });
  const aheadAthleteId = await makeAthlete({ name: "Ahead Athlete", userId: aheadUserId });
  await addMembership(aheadAthleteId, { clubId });
  await setDeviceTimezone(await loginCookie(aheadUserId), "Pacific/Kiritimati");

  // Pago_Pago (UTC-11) and Kiritimati (UTC+14) have a fixed 25h offset gap
  // (>24h) - their real current dates are GUARANTEED never equal, so this
  // test is deterministic every run, with no time-of-day branching needed.
  const behindToday = await localDateIn("Pacific/Pago_Pago");
  const aheadToday = await localDateIn("Pacific/Kiritimati");
  assert.notEqual(behindToday, aheadToday, "sanity: a 25h offset gap must never produce the same real calendar date");

  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], {
    scheduleKind: "daily", timezone: "UTC", startDate: behindToday, endDate: addDaysIso(behindToday, 5), opensTime: "00:00", closesTime: "23:59",
  });

  const scheduleRow = await query(`select * from tests.test_schedules where id = $1`, [schedule.id]);
  const occurrenceIds = await ensureCurrentOccurrence(pool, scheduleRow.rows[0]);
  assert.equal(occurrenceIds.length, 2, "both athletes' own distinct real current dates must be generated in one call");

  const dates = await query(`select scheduled_date from tests.test_schedule_occurrences where id = any($1::uuid[]) order by scheduled_date`, [occurrenceIds]);
  assert.deepEqual(dates.rows.map((r) => String(r.scheduled_date)).sort(), [behindToday, aheadToday].sort());

  const behindOccId = (await query(`select id from tests.test_schedule_occurrences where schedule_id = $1 and scheduled_date = $2`, [schedule.id, behindToday])).rows[0].id;
  const aheadOccId = (await query(`select id from tests.test_schedule_occurrences where schedule_id = $1 and scheduled_date = $2`, [schedule.id, aheadToday])).rows[0].id;

  const behindUnderOwn = await assignmentFor(behindOccId, behindAthleteId);
  assert.ok(behindUnderOwn, "the behind athlete belongs under its own occurrence");
  const behindUnderAhead = await assignmentFor(aheadOccId, behindAthleteId);
  assert.equal(behindUnderAhead, undefined, "the behind athlete must not ALSO be assigned to the ahead athlete's occurrence");

  const aheadUnderOwn = await assignmentFor(aheadOccId, aheadAthleteId);
  assert.ok(aheadUnderOwn, "the ahead athlete belongs under its own occurrence");
  const aheadUnderBehind = await assignmentFor(behindOccId, aheadAthleteId);
  assert.equal(aheadUnderBehind, undefined, "the ahead athlete must not ALSO be assigned to the behind athlete's occurrence");
});

test("daily: start/end boundaries are respected in the ATHLETE's own local calendar, not just the schedule's", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz12b", 0);
  // A second, fallback-only athlete (no device_timezone - effective
  // timezone falls back to the schedule's own Pago_Pago) keeps this test
  // meaningful: it proves the occurrence generates for a real IN-range
  // target, while the Kiritimati athlete's own out-of-range date is
  // correctly excluded, rather than both being absent for unrelated
  // reasons.
  const fallbackUserId = await makeUser({ email: `tz12b-fallback-${Date.now()}@test.local`, roleHint: "athlete" });
  const fallbackAthleteId = await makeAthlete({ name: "Fallback Athlete", userId: fallbackUserId });
  await addMembership(fallbackAthleteId, { clubId });

  const userId = await makeUser({ email: `tz12b-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Boundary Athlete", userId });
  await addMembership(athleteId, { clubId });
  await setDeviceTimezone(await loginCookie(userId), "Pacific/Kiritimati");

  // Pago_Pago (UTC-11) is GUARANTEED (25h gap, >24h) to be 1-2 real days
  // behind Kiritimati (UTC+14) at every possible instant - a daily
  // schedule whose end_date is Pago_Pago's own real "today" therefore
  // ALWAYS excludes Kiritimati's own real current date, deterministically,
  // never a vacuous/coincidental pass.
  const pagoPagoToday = await localDateIn("Pacific/Pago_Pago");
  const kiritimatiToday = await localDateIn("Pacific/Kiritimati");
  assert.ok(kiritimatiToday > pagoPagoToday, "sanity: Kiritimati must genuinely be past Pago_Pago's own end_date for this test to prove anything");

  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], {
    scheduleKind: "daily", timezone: "Pacific/Pago_Pago", startDate: addDaysIso(pagoPagoToday, -3), endDate: pagoPagoToday, opensTime: "00:00", closesTime: "23:59",
  });
  const scheduleRow = await query(`select * from tests.test_schedules where id = $1`, [schedule.id]);
  const occurrenceIds = await ensureCurrentOccurrence(pool, scheduleRow.rows[0]);
  assert.equal(occurrenceIds.length, 1, "only the fallback athlete's real in-range occurrence (Pago_Pago's own today) may be generated - never one for Kiritimati's out-of-range date");
  const dates = await query(`select scheduled_date from tests.test_schedule_occurrences where id = any($1::uuid[])`, [occurrenceIds]);
  assert.equal(String(dates.rows[0].scheduled_date), pagoPagoToday);
  const fallbackAssignment = await assignmentFor(occurrenceIds[0], fallbackAthleteId);
  assert.ok(fallbackAssignment, "the fallback (Pago_Pago) athlete must be assigned - genuinely in range");
  const kiritimatiAssignment = await assignmentFor(occurrenceIds[0], athleteId);
  assert.equal(kiritimatiAssignment, undefined, "Kiritimati's own real current date is past end_date - correctly excluded, never generated/assigned");
});

test("13. the worker's occurrence-generation phase catches an ahead athlete's occurrence in its very next cycle, well before the 5-minute interval would even repeat", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz13", 0);
  const userId = await makeUser({ email: `tz13-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Worker Ahead Athlete", userId });
  await addMembership(athleteId, { clubId });
  await setDeviceTimezone(await loginCookie(userId), "Pacific/Kiritimati");

  const kiritimatiToday = await localDateIn("Pacific/Kiritimati");
  const startDate = kiritimatiToday;
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], {
    timezone: "Pacific/Pago_Pago", startDate, opensTime: "06:00", closesTime: "23:59",
    notificationRules: [{ kind: "athlete_invitation", enabled: true }],
  });

  // A full real worker cycle, using the real wall clock - proves the
  // WORKER's own Phase 1 SQL pre-filter genuinely picks this schedule up
  // too (not just the on-demand ensureCurrentOccurrence path exercised
  // directly by other tests above).
  const summary = await processTestNotificationCycle({ now: new Date(), pool });
  assert.ok(summary.occurrences.generated >= 1, `expected the worker to generate at least the ahead-athlete's occurrence this cycle: ${JSON.stringify(summary.occurrences)}`);

  const occ = await query(`select id from tests.test_schedule_occurrences where schedule_id = $1 and scheduled_date = $2`, [schedule.id, startDate]);
  assert.equal(occ.rowCount, 1, "the occurrence for start_date must exist after just one worker cycle");
  const assignment = await assignmentFor(occ.rows[0].id, athleteId);
  assert.ok(assignment, "the assignment must already exist too - generate+materialize run in the same cycle");

  if (new Date(assignment.opens_at) <= new Date()) {
    assert.equal(summary.invitations.sent + summary.invitations.alreadySent, 1, "once the athlete's own opens_at has already arrived, the invitation must go out in this SAME cycle, not a later one");
  }
});

// ------------------------------------------------------------
// Item 3: DB-enforced snapshot immutability
// ------------------------------------------------------------

test("14. direct UPDATE attempts on an assignment's snapshot columns are rejected by the database itself, but normal lifecycle updates still work", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz14", 0);
  const userId = await makeUser({ email: `tz14-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Immutable Athlete", userId });
  await addMembership(athleteId, { clubId });
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignment = await assignmentFor(occurrence.id, athleteId);
  assert.ok(assignment);

  await assert.rejects(
    () => query(`update tests.test_assignments set timezone = 'Asia/Tokyo' where id = $1`, [assignment.id]),
    /immutable snapshot/,
  );
  await assert.rejects(
    () => query(`update tests.test_assignments set opens_at = opens_at + interval '1 hour' where id = $1`, [assignment.id]),
    /immutable snapshot/,
  );
  await assert.rejects(
    () => query(`update tests.test_assignments set closes_at = closes_at + interval '1 hour' where id = $1`, [assignment.id]),
    /immutable snapshot/,
  );
  await assert.rejects(
    () => query(`update tests.test_assignments set local_scheduled_date = local_scheduled_date + 1 where id = $1`, [assignment.id]),
    /immutable snapshot/,
  );
  await assert.rejects(
    () => query(`update tests.test_assignments set due_at = closes_at where id = $1`, [assignment.id]),
    /immutable snapshot/,
  );

  // The real lifecycle path must be completely unaffected by the new checks.
  await query(`update tests.test_assignments set status = 'completed', completed_at = now() where id = $1`, [assignment.id]);
  const after = await query(`select status from tests.test_assignments where id = $1`, [assignment.id]);
  assert.equal(after.rows[0].status, "completed");
});

// ------------------------------------------------------------
// Item 4: coach Today no longer shows a single shared occurrence-level
// window
// ------------------------------------------------------------

test("15. coach Today never returns the old shared occurrence-level window object - anyOpen/allClosed are a clearly-defined aggregate instead", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz15", 0);
  const userId = await makeUser({ email: `tz15-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Open Athlete", userId });
  await addMembership(athleteId, { clubId });

  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "UTC", opensTime: "00:00", closesTime: "23:59" });
  await ensureOccurrenceAndAssignments(schedule.id);

  const today = await api("/api/tests/today", { cookie: coachCookie });
  assert.equal(today.status, 200);
  const group = today.body.groups.find((g) => g.schedule.id === schedule.id);
  assert.ok(group, "the schedule must appear in coach Today");
  assert.equal("occurrence" in group, false, "the old shared occurrence-level window object must be gone entirely");
  assert.equal(typeof group.anyOpen, "boolean");
  assert.equal(typeof group.allClosed, "boolean");
  assert.equal(group.anyOpen, true, "with a wide-open 00:00-23:59 UTC window, the group must report at least one athlete currently open");
  assert.equal(group.athletes[0].athleteId, athleteId);
  assert.ok(group.athletes[0].opensAt && group.athletes[0].closesAt, "each athlete row must still carry its own window");
});

test("16. an athlete significantly AHEAD of the schedule's own timezone is genuinely VISIBLE in coach Today (previously invisible - their assignment lived under a different occurrence than the one Today looked at)", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz16", 0);
  const userId = await makeUser({ email: `tz16-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Ahead Coach Today Athlete", userId });
  await addMembership(athleteId, { clubId });
  await setDeviceTimezone(await loginCookie(userId), "Pacific/Kiritimati");

  const kiritimatiToday = await localDateIn("Pacific/Kiritimati");
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "Pacific/Pago_Pago", startDate: kiritimatiToday, opensTime: "00:00", closesTime: "23:59" });

  const today = await api("/api/tests/today", { cookie: coachCookie });
  const group = today.body.groups.find((g) => g.schedule.id === schedule.id);
  assert.ok(group, "the schedule must appear at all");
  assert.equal(group.counts.total, 1, "the ahead athlete's assignment must be counted");
  assert.equal(group.athletes[0].athleteId, athleteId);
});

// ------------------------------------------------------------
// Additional round-2 regression coverage (items 1-3's explicit test list)
// ------------------------------------------------------------

test("17. an athlete added to a team AFTER the membership snapshot is not retroactively added, even across a later materialize call", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz17", 1);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);

  const snapshotBefore = await query(`select count(*)::int as n from tests.test_occurrence_target_snapshot where occurrence_id = $1`, [occurrence.id]);
  assert.equal(snapshotBefore.rows[0].n, 1, "sanity: exactly the one original club member is snapshotted");

  // A second athlete joins the SAME club AFTER the occurrence's membership
  // snapshot was already taken.
  const lateUserId = await makeUser({ email: `tz17-late-${Date.now()}@test.local`, roleHint: "athlete" });
  const lateAthleteId = await makeAthlete({ name: "Late Joiner", userId: lateUserId });
  await addMembership(lateAthleteId, { clubId });

  // A later materialize call (as a real worker cycle would make) must not
  // re-resolve membership - the late joiner must never be snapshotted or
  // assigned.
  await query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occurrence.id]);
  const snapshotAfter = await query(`select count(*)::int as n from tests.test_occurrence_target_snapshot where occurrence_id = $1 and athlete_id = $2`, [occurrence.id, lateAthleteId]);
  assert.equal(snapshotAfter.rows[0].n, 0, "the late joiner must never appear in the membership snapshot");
  const lateAssignment = await assignmentFor(occurrence.id, lateAthleteId);
  assert.equal(lateAssignment, undefined, "the late joiner must never get an assignment under this occurrence");
});

test("18. the worker's occurrence-generation phase and the on-demand Today/check-in path generate the exact same set of occurrence dates - the shared service, never independent guesses", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz18", 0);
  const userId = await makeUser({ email: `tz18-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Shared Service Athlete", userId });
  await addMembership(athleteId, { clubId });
  await setDeviceTimezone(await loginCookie(userId), "Pacific/Kiritimati");

  const kiritimatiToday = await localDateIn("Pacific/Kiritimati");
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "Pacific/Pago_Pago", startDate: kiritimatiToday, opensTime: "00:00", closesTime: "23:59" });

  // Query the shared candidate-date function directly - this is the single
  // source of truth both paths below must agree with.
  const directDates = await query(`select local_date from tests.resolve_current_target_dates($1) order by local_date`, [schedule.id]);
  const expectedDates = directDates.rows.map((r) => String(r.local_date));
  assert.deepEqual(expectedDates, [kiritimatiToday], "sanity: exactly one real target date is currently relevant");

  // The worker's own occurrence-generation phase, on a schedule it has
  // never touched before.
  const summary = await processTestNotificationCycle({ now: new Date(), pool });
  assert.ok(summary.occurrences.generated >= 1);
  const workerDates = await query(`select scheduled_date from tests.test_schedule_occurrences where schedule_id = $1 order by scheduled_date`, [schedule.id]);
  assert.deepEqual(workerDates.rows.map((r) => String(r.scheduled_date)), expectedDates, "the worker must generate EXACTLY the shared function's own candidate dates - no more, no less");
});

test("19. no premature one-time assignment materialization: two athletes are BOTH snapshotted as members, but only the one whose real date matches start_date gets an assignment", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz19", 0);
  const eligibleUserId = await makeUser({ email: `tz19-eligible-${Date.now()}@test.local`, roleHint: "athlete" });
  const eligibleAthleteId = await makeAthlete({ name: "Eligible Now Athlete", userId: eligibleUserId });
  await addMembership(eligibleAthleteId, { clubId });
  await setDeviceTimezone(await loginCookie(eligibleUserId), "Pacific/Kiritimati");

  const notYetUserId = await makeUser({ email: `tz19-notyet-${Date.now()}@test.local`, roleHint: "athlete" });
  const notYetAthleteId = await makeAthlete({ name: "Not Yet Eligible Athlete", userId: notYetUserId });
  await addMembership(notYetAthleteId, { clubId });
  await setDeviceTimezone(await loginCookie(notYetUserId), "Pacific/Pago_Pago");

  const kiritimatiToday = await localDateIn("Pacific/Kiritimati");
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { timezone: "UTC", startDate: kiritimatiToday, opensTime: "00:00", closesTime: "23:59" });
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);

  const snapshotCount = await query(`select count(*)::int as n from tests.test_occurrence_target_snapshot where occurrence_id = $1`, [occurrence.id]);
  assert.equal(snapshotCount.rows[0].n, 2, "BOTH athletes must be snapshotted as members - membership is never eligibility");

  const eligibleAssignment = await assignmentFor(occurrence.id, eligibleAthleteId);
  assert.ok(eligibleAssignment, "the Kiritimati athlete's own real date matches start_date - must already have a real assignment row");

  const notYetAssignment = await assignmentFor(occurrence.id, notYetAthleteId);
  assert.equal(notYetAssignment, undefined, "the Pago_Pago athlete's own real date is guaranteed behind start_date - must NOT have a premature assignment, even though this is a one_time schedule");
});

test("20. two parallel ensureCurrentOccurrence calls for the same schedule never produce duplicate occurrence or assignment rows", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("tz20", 2);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const scheduleRow = await query(`select * from tests.test_schedules where id = $1`, [schedule.id]);

  const [idsA, idsB] = await Promise.all([
    ensureCurrentOccurrence(pool, scheduleRow.rows[0]),
    ensureCurrentOccurrence(pool, scheduleRow.rows[0]),
  ]);
  assert.ok(idsA.length >= 1 && idsB.length >= 1, "both parallel calls must succeed");

  const occurrenceRows = await query(`select id, scheduled_date from tests.test_schedule_occurrences where schedule_id = $1`, [schedule.id]);
  const distinctDates = new Set(occurrenceRows.rows.map((r) => String(r.scheduled_date)));
  assert.equal(occurrenceRows.rowCount, distinctDates.size, "no two occurrence rows may share the same (schedule, date) - never a duplicate from the parallel race");

  for (const occRow of occurrenceRows.rows) {
    const assignmentRows = await query(`select athlete_id, count(*)::int as n from tests.test_assignments where occurrence_id = $1 group by athlete_id having count(*) > 1`, [occRow.id]);
    assert.equal(assignmentRows.rowCount, 0, "no athlete may have more than one assignment row under the same occurrence, even from the parallel race");
  }
});

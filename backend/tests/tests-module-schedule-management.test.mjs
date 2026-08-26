// Validates the Phase 2 follow-up: multi-athlete target selection, schedule
// editing (PATCH /api/tests/schedules/:id, extended, not a parallel route),
// and schedule delete/cancel (new DELETE /api/tests/schedules/:id) - built
// entirely on Phase 1's already-deployed tables (no new migration - multiple
// tests.test_schedule_targets rows and a 'cancelled' status were already
// supported).
//
// Same harness as tests-module-phase2-wellness-ui-api.test.mjs: a
// disposable, uniquely-named temporary database (never OPTIMOVE, never
// monitoring2) through the real Strategy B runner, with the real Express
// app driven over real HTTP with real session cookies.
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
const SCHEMA_PATH = path.resolve(__dirname, "../../migrations_v2/202608220900_tests_v42_schema.sql");
const SEED_PATH = path.resolve(__dirname, "../../migrations_v2/202608221000_tests_v42_seed_wellness_fms.sql");
const PHASE1_PATH = path.resolve(__dirname, "../../migrations_v2/202608240900_tests_v42_phase1_scheduling_execution.sql");
const PRESENTATION_PATH = path.resolve(__dirname, "../../migrations_v2/202608250900_tests_v42_presentation_metadata.sql");
const SUPERSEDE_FIX_PATH = path.resolve(__dirname, "../../migrations_v2/202608250901_tests_v42_supersede_generated_column_fix.sql");
const OCCURRENCE_LOCK_FIX_PATH = path.resolve(__dirname, "../../migrations_v2/202608260900_tests_v42_occurrence_generation_lock_fix.sql");
const ASSIGNMENT_TIMEZONE_WINDOW_PATH = path.resolve(__dirname, "../../migrations_v2/202608300900_tests_v42_phase4_assignment_timezone_window.sql");
const SCHEMA_NAME = "202608220900_tests_v42_schema.sql";
const SEED_NAME = "202608221000_tests_v42_seed_wellness_fms.sql";
const PHASE1_NAME = "202608240900_tests_v42_phase1_scheduling_execution.sql";
const PRESENTATION_NAME = "202608250900_tests_v42_presentation_metadata.sql";
const SUPERSEDE_FIX_NAME = "202608250901_tests_v42_supersede_generated_column_fix.sql";
const OCCURRENCE_LOCK_FIX_NAME = "202608260900_tests_v42_occurrence_generation_lock_fix.sql";
const ASSIGNMENT_TIMEZONE_WINDOW_NAME = "202608300900_tests_v42_phase4_assignment_timezone_window.sql";

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
  const name = `optimove_tests_schedmgmt_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_schedmgmt_migrations_${runId}`);
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

before(async () => {
  const [schemaSql, seedSql, phase1Sql, presentationSql, supersedeFixSql, occurrenceLockFixSql, assignmentTimezoneWindowSql] = await Promise.all([
    fsp.readFile(SCHEMA_PATH, "utf8"),
    fsp.readFile(SEED_PATH, "utf8"),
    fsp.readFile(PHASE1_PATH, "utf8"),
    fsp.readFile(PRESENTATION_PATH, "utf8"),
    fsp.readFile(SUPERSEDE_FIX_PATH, "utf8"),
    fsp.readFile(OCCURRENCE_LOCK_FIX_PATH, "utf8"),
    fsp.readFile(ASSIGNMENT_TIMEZONE_WINDOW_PATH, "utf8"),
  ]);

  db = await makeTempDb("primary");
  adminClient = new pg.Client({ connectionString: db.url });
  await adminClient.connect();
  const ownCheck = await adminClient.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");

  await adminClient.query(LEGACY_FIXTURE_SQL);
  migrationsDir = await writeMigrationsDir("primary", {
    [SCHEMA_NAME]: schemaSql,
    [SEED_NAME]: seedSql,
    [PHASE1_NAME]: phase1Sql,
    [PRESENTATION_NAME]: presentationSql,
    [SUPERSEDE_FIX_NAME]: supersedeFixSql,
    [OCCURRENCE_LOCK_FIX_NAME]: occurrenceLockFixSql,
    [ASSIGNMENT_TIMEZONE_WINDOW_NAME]: assignmentTimezoneWindowSql,
  });
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
// Fixture helpers
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
async function makeTeam(clubId, name) {
  const result = await query(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, name]);
  return result.rows[0].id;
}
async function makeAthlete({ name, userId = null }) {
  const result = await query(`insert into public.athletes (user_id, full_name, display_name) values ($1,$2,$2) returning id`, [userId, name]);
  return result.rows[0].id;
}
async function grantClubAdmin(userId, clubId) {
  await query(`insert into public.user_club_roles (user_id, club_id, role) values ($1,$2,'club_admin')`, [userId, clubId]);
}
async function grantTeamCoach(userId, teamId) {
  await query(`insert into public.user_team_roles (user_id, team_id, role) values ($1,$2,'team_coach')`, [userId, teamId]);
}
async function addMembership(athleteId, { teamId = null, clubId = null }) {
  await query(
    `insert into public.athlete_memberships (athlete_id, team_id, club_id, membership_type, status) values ($1,$2,$3,$4,'active')`,
    [athleteId, teamId, clubId, teamId ? "team" : "club"],
  );
}
async function loginCookie(userId) {
  const token = await createSession(userId);
  return cookieFor(token);
}

// Polls pg_stat_activity until some OTHER backend is genuinely blocked on a
// lock held by `blockerPid` (via pg_blocking_pids(), not a fixed sleep) -
// this is what makes the concurrency tests below deterministic instead of
// timing-dependent: the test only proceeds to release the blocking
// transaction once it has proven the other request/transaction is really
// queued behind it, not just "probably" queued by the time a sleep elapses.
async function waitUntilBlockedBy(blockerPid, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await adminClient.query(
      `select pid from pg_stat_activity where pg_blocking_pids(pid) @> array[$1]::int[]`,
      [blockerPid],
    );
    if (result.rowCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for a backend to be blocked by pid ${blockerPid}`);
}

const FULL_VALUES = { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: true };
const TODAY = new Date().toISOString().slice(0, 10);

async function getTodayAssignmentId(athleteCookie) {
  const today = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  return today.body.assignments[0]?.assignmentId;
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

// A club with a coach admin and N real athletes, all club-owned.
async function makeClubWithAthletes(label, count) {
  const clubId = await makeClub(`${label} Club`);
  const coachId = await makeUser({ email: `${label}-coach-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local` });
  await grantClubAdmin(coachId, clubId);
  const coachCookie = await loginCookie(coachId);
  const athletes = [];
  for (let i = 0; i < count; i += 1) {
    const userId = await makeUser({ email: `${label}-athlete${i}-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local`, roleHint: "athlete" });
    const athleteId = await makeAthlete({ name: `${label} Athlete ${i}`, userId });
    await addMembership(athleteId, { clubId });
    athletes.push({ athleteId, userId, cookie: await loginCookie(userId) });
  }
  return { clubId, coachId, coachCookie, athletes };
}

// ------------------------------------------------------------
// A. Multi-athlete + combined athlete/team/club targets
// ------------------------------------------------------------

test("A1. a schedule can target several individual athletes at once, each gets exactly one assignment", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("a1", 3);
  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: baseCreateBody(athletes.map((a) => ({ kind: "athlete", id: a.athleteId }))),
  });
  assert.equal(created.status, 201);
  for (const athlete of athletes) {
    const today = await api("/api/tests/athlete/today", { cookie: athlete.cookie });
    assert.equal(today.body.assignments.length, 1);
  }
  const count = await query(`select count(*)::int as n from tests.test_assignments where occurrence_id in (select id from tests.test_schedule_occurrences where schedule_id = $1)`, [created.body.schedule.id]);
  assert.equal(count.rows[0].n, 3);
});

test("A2. duplicate target entries (same athlete sent twice) collapse to one target row and one assignment", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("a2", 1);
  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }, { kind: "athlete", id: athletes[0].athleteId }]),
  });
  assert.equal(created.status, 201);
  const targetRows = await query(`select count(*)::int as n from tests.test_schedule_targets where schedule_id = $1`, [created.body.schedule.id]);
  assert.equal(targetRows.rows[0].n, 1);
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  const assignmentCount = await query(`select count(*)::int as n from tests.test_assignments where athlete_id = $1`, [athletes[0].athleteId]);
  assert.equal(assignmentCount.rows[0].n, 1);
});

test("A3. combining an individually-targeted athlete with a team they also belong to never produces a duplicate assignment", async () => {
  const clubId = await makeClub("A3 Club");
  const teamId = await makeTeam(clubId, "A3 Team");
  const coachId = await makeUser({ email: `a3-coach-${Date.now()}@test.local` });
  await grantTeamCoach(coachId, teamId);
  const coachCookie = await loginCookie(coachId);
  const userId = await makeUser({ email: `a3-athlete-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "A3 Athlete", userId });
  await addMembership(athleteId, { teamId });
  const athleteCookie = await loginCookie(userId);

  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: baseCreateBody([{ kind: "athlete", id: athleteId }, { kind: "team", id: teamId }]),
  });
  assert.equal(created.status, 201);
  const targetRows = await query(`select count(*)::int as n from tests.test_schedule_targets where schedule_id = $1`, [created.body.schedule.id]);
  assert.equal(targetRows.rows[0].n, 2, "both target rows (athlete + team) are kept - they are genuinely different rows");

  await api("/api/tests/athlete/today", { cookie: athleteCookie });
  const assignmentCount = await query(`select count(*)::int as n from tests.test_assignments where athlete_id = $1`, [athleteId]);
  assert.equal(assignmentCount.rows[0].n, 1, "materialization still yields exactly one assignment for this athlete, per Phase 1's own UNION dedupe");
});

test("A4. one unauthorized target among several rejects the entire schedule creation, nothing is written", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("a4", 2);
  const outsider = await makeAthlete({ name: "A4 Outsider" }); // not in this coach's club
  const before = await query(`select count(*)::int as n from tests.test_schedules`);
  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }, { kind: "athlete", id: outsider }]),
  });
  assert.equal(created.status, 403);
  const after = await query(`select count(*)::int as n from tests.test_schedules`);
  assert.equal(after.rows[0].n, before.rows[0].n, "no schedule row was created when one target failed authorization");
});

// ------------------------------------------------------------
// B. Edit schedule (PATCH, extended - not a parallel route)
// ------------------------------------------------------------

test("B1. editing a schedule with no occurrence yet freely changes targets/time/timezone", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b1", 2);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const edited = await api(`/api/tests/schedules/${created.body.schedule.id}`, {
    method: "PATCH",
    cookie: coachCookie,
    body: { scheduleKind: "one_time", timezone: "UTC", startDate: TODAY, opensTime: "01:00", closesTime: "22:00", targets: [{ kind: "athlete", id: athletes[1].athleteId }] },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.schedule.opensTime.slice(0, 5), "01:00");
  const targets = await api(`/api/tests/schedules/${created.body.schedule.id}`, { cookie: coachCookie });
  assert.equal(targets.body.targets.length, 1);
  assert.equal(targets.body.targets[0].id, athletes[1].athleteId);
});

test("B2. editing a recurring (daily) schedule that already has an occurrence changes only future occurrences - existing assignments are untouched", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b2", 2);
  const startDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { scheduleKind: "daily", startDate, opensTime: "00:00", closesTime: "23:59" }),
  });
  assert.equal(created.status, 201);
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie }); // materializes today's occurrence for athlete 0
  const existingAssignment = await query(`select id, snapshot_test_version_id from tests.test_assignments where athlete_id = $1`, [athletes[0].athleteId]);
  assert.equal(existingAssignment.rowCount, 1);
  const existingOccurrenceId = await query(`select occurrence_id from tests.test_assignments where id = $1`, [existingAssignment.rows[0].id]);

  const edited = await api(`/api/tests/schedules/${created.body.schedule.id}`, {
    method: "PATCH",
    cookie: coachCookie,
    body: { scheduleKind: "daily", timezone: "UTC", startDate, opensTime: "02:00", closesTime: "23:59", targets: [{ kind: "athlete", id: athletes[1].athleteId }] },
  });
  assert.equal(edited.status, 200);

  // Existing assignment/occurrence completely unchanged.
  const stillThere = await query(`select id from tests.test_assignments where id = $1`, [existingAssignment.rows[0].id]);
  assert.equal(stillThere.rowCount, 1);
  const occurrenceRow = await query(`select opens_at from tests.test_schedule_occurrences where id = $1`, [existingOccurrenceId.rows[0].occurrence_id]);
  assert.ok(occurrenceRow.rows[0], "the already-generated occurrence row itself is untouched");

  // Athlete 0 (removed from targets) still sees their already-materialized
  // assignment (Phase 1 + Phase 2's own snapshot-not-membership guarantee).
  const athlete0Today = await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  assert.equal(athlete0Today.body.assignments.length, 1);
});

test("B3. a one_time schedule whose occurrence exists but is still fully untouched (pending, no assessment) CAN be fully edited - Phase 2.5 loosened this from an unconditional block", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b3", 2);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie }); // generates the one_time occurrence, athlete never submits

  const edited = await api(`/api/tests/schedules/${created.body.schedule.id}`, {
    method: "PATCH",
    cookie: coachCookie,
    body: { scheduleKind: "one_time", timezone: "UTC", startDate: TODAY, opensTime: "01:00", closesTime: "22:00", targets: [{ kind: "athlete", id: athletes[1].athleteId }] },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.schedule.opensTime.slice(0, 5), "01:00");
  assert.equal(edited.body.schedule.hasOccurrences, false, "the stale, untouched occurrence was deleted, not left behind under the new targets/time");

  const detail = await api(`/api/tests/schedules/${created.body.schedule.id}`, { cookie: coachCookie });
  assert.equal(detail.body.targets.length, 1);
  assert.equal(detail.body.targets[0].id, athletes[1].athleteId, "the new target replaced the old one");
  assert.equal(detail.body.schedule.hasActivity, false);

  // A fresh occurrence/assignment for the NEW target regenerates normally
  // on the next on-demand call, exactly like a schedule that never had one.
  const today1 = await api("/api/tests/athlete/today", { cookie: athletes[1].cookie });
  assert.equal(today1.body.assignments.length, 1);
  assert.equal(today1.body.assignments[0].occurrence.opensAt.slice(11, 16), "01:00");

  // Athlete 0 (the OLD target) no longer has any assignment at all - the
  // untouched, never-submitted occurrence/assignment they had was safely
  // deleted, not left orphaned under a schedule that no longer targets them.
  const today0 = await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  assert.equal(today0.body.assignments.length, 0);
});

test("B3b. a one_time schedule whose occurrence has a real submitted response cannot be edited at all - 409, nothing changes, history untouched", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b3b", 2);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const assignmentId = await getTodayAssignmentId(athletes[0].cookie);
  const submitted = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athletes[0].cookie, body: { values: FULL_VALUES } });
  assert.equal(submitted.status, 200);

  const edited = await api(`/api/tests/schedules/${created.body.schedule.id}`, {
    method: "PATCH",
    cookie: coachCookie,
    body: { scheduleKind: "one_time", timezone: "UTC", startDate: TODAY, opensTime: "01:00", closesTime: "22:00", targets: [{ kind: "athlete", id: athletes[1].athleteId }] },
  });
  assert.equal(edited.status, 409);
  assert.equal(edited.body.reason, "has_activity");

  const detail = await api(`/api/tests/schedules/${created.body.schedule.id}`, { cookie: coachCookie });
  assert.equal(detail.body.targets.length, 1);
  assert.equal(detail.body.targets[0].id, athletes[0].athleteId, "nothing changed - target untouched");
  assert.equal(detail.body.schedule.hasActivity, true);

  // The submitted result is completely unaffected and still visible.
  const history = await api("/api/tests/athlete/history", { cookie: athletes[0].cookie });
  assert.equal(history.body.history.length, 1);
  assert.equal(history.body.history[0].wellnessScore, 4);
});

test("B4. status-only PATCH (pause/activate) still works exactly as before, without requiring targets/dates in the body", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b4", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const paused = await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "PATCH", cookie: coachCookie, body: { status: "paused" } });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, "paused");
});

test("B5. an unauthorized target in an edit request rolls back the whole edit, including any valid field changes", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b5", 1);
  const outsider = await makeAthlete({ name: "B5 Outsider" });
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const edited = await api(`/api/tests/schedules/${created.body.schedule.id}`, {
    method: "PATCH",
    cookie: coachCookie,
    body: { scheduleKind: "one_time", timezone: "UTC", startDate: TODAY, opensTime: "03:00", closesTime: "22:00", targets: [{ kind: "athlete", id: outsider }] },
  });
  assert.equal(edited.status, 403);
  const detail = await api(`/api/tests/schedules/${created.body.schedule.id}`, { cookie: coachCookie });
  assert.notEqual(detail.body.schedule.opensTime.slice(0, 5), "03:00", "the opens_time change must not have been applied either");
  assert.equal(detail.body.targets[0].id, athletes[0].athleteId);
});

test("B6. a different coach cannot edit another coach's schedule", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b6a", 1);
  const other = await makeClubWithAthletes("b6b", 0);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const edited = await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "PATCH", cookie: other.coachCookie, body: { status: "paused" } });
  assert.equal(edited.status, 404);
});

// ------------------------------------------------------------
// C. Delete/cancel schedule (DELETE - server decides the outcome)
// ------------------------------------------------------------

test("C1. deleting a schedule with no occurrence physically removes it and its targets", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("c1", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const deleted = await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { action: "deleted" });
  const scheduleRow = await query(`select id from tests.test_schedules where id = $1`, [created.body.schedule.id]);
  assert.equal(scheduleRow.rowCount, 0);
  const targetRows = await query(`select id from tests.test_schedule_targets where schedule_id = $1`, [created.body.schedule.id]);
  assert.equal(targetRows.rowCount, 0);
});

test("C2. deleting a schedule that already has an occurrence cancels it instead, preserving occurrences/assignments/results", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("c2", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  const assignmentId = await getTodayAssignmentId(athletes[0].cookie);
  await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athletes[0].cookie, body: { values: FULL_VALUES } });

  const deleted = await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { action: "cancelled", historyPreserved: true });

  const scheduleRow = await query(`select status from tests.test_schedules where id = $1`, [created.body.schedule.id]);
  assert.equal(scheduleRow.rows[0].status, "cancelled");
  const occurrenceRow = await query(`select id from tests.test_schedule_occurrences where schedule_id = $1`, [created.body.schedule.id]);
  assert.equal(occurrenceRow.rowCount, 1, "the occurrence row is preserved");
  const assessmentRow = await query(`select id from tests.test_assessments where id = (select id from tests.test_assessments where athlete_id = $1 limit 1)`, [athletes[0].athleteId]);
  assert.equal(assessmentRow.rowCount, 1, "the completed result is preserved");

  const history = await api("/api/tests/athlete/history", { cookie: athletes[0].cookie });
  assert.equal(history.body.history.length, 1, "the athlete's own history is untouched by cancelling the schedule");
});

test("C2b. cancelling a schedule with a still-PENDING (never submitted) assignment removes it from the athlete's own Today view immediately - it must not keep showing as an actionable check-in for something the coach already cancelled", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("c2b", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie }); // materializes today's occurrence/assignment, never submitted
  const before = await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  assert.equal(before.body.assignments.length, 1, "sanity check - the pending assignment is visible before cancel");

  const deleted = await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie });
  assert.equal(deleted.body.action, "cancelled");

  const after = await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  assert.equal(after.body.assignments.length, 0, "a cancelled schedule's still-pending assignment must disappear from Today");

  // The underlying rows are still preserved (only hidden from the Today
  // view, never deleted) - same "cancel preserves history" guarantee C2
  // already covers for a completed one.
  const assignmentRow = await query(`select id from tests.test_assignments where athlete_id = $1`, [athletes[0].athleteId]);
  assert.equal(assignmentRow.rowCount, 1, "the assignment row itself must not be deleted, only excluded from Today");
});

test("C3. cancelling via delete revokes any active group access link", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("c3", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const link = await api(`/api/tests/schedules/${created.body.schedule.id}/link`, { method: "POST", cookie: coachCookie });
  assert.equal(link.status, 201);
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie }); // generates the occurrence, forces the cancel path

  const deleted = await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie });
  assert.equal(deleted.body.action, "cancelled");

  const linkRow = await query(`select status from tests.test_access_links where id = $1`, [link.body.link.id]);
  assert.equal(linkRow.rows[0].status, "revoked");

  const checkIn = await api(`/api/tests/check-in/${link.body.link.publicToken}`);
  assert.equal(checkIn.status, 404);
});

test("C4. a cancelled schedule is excluded from the default schedules list, and included with ?includeCancelled=true", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("c4", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie });

  const defaultList = await api("/api/tests/schedules", { cookie: coachCookie });
  assert.ok(!defaultList.body.schedules.some((s) => s.id === created.body.schedule.id));

  const withCancelled = await api("/api/tests/schedules?includeCancelled=true", { cookie: coachCookie });
  const found = withCancelled.body.schedules.find((s) => s.id === created.body.schedule.id);
  assert.ok(found);
  assert.equal(found.status, "cancelled");
});

test("C5. a different coach cannot delete another coach's schedule", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("c5a", 1);
  const other = await makeClubWithAthletes("c5b", 0);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const deleted = await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: other.coachCookie });
  assert.equal(deleted.status, 404);
  const scheduleRow = await query(`select id from tests.test_schedules where id = $1`, [created.body.schedule.id]);
  assert.equal(scheduleRow.rowCount, 1, "the schedule must still exist");
});

// ------------------------------------------------------------
// D. Schedule list target summary
// ------------------------------------------------------------

test("D1. the schedules list reports a real athlete target count and team/club names", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("d1", 3);
  await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody(athletes.map((a) => ({ kind: "athlete", id: a.athleteId }))) });
  const list = await api("/api/tests/schedules", { cookie: coachCookie });
  assert.equal(list.body.schedules[0].athleteTargetCount, 3);
});

// ------------------------------------------------------------
// E. No regression in the core WELLNESS flow (submit/correction/group-link)
// ------------------------------------------------------------

test("E1. create -> submit -> correct -> group link still work end to end after the routing rewrite", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("e1", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  assert.equal(created.status, 201);
  const assignmentId = await getTodayAssignmentId(athletes[0].cookie);
  const first = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athletes[0].cookie, body: { values: FULL_VALUES } });
  assert.equal(first.status, 200);
  assert.equal(first.body.wellnessScore, 4);
  const second = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athletes[0].cookie, body: { values: { ...FULL_VALUES, fatigue: 10 } } });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.assessmentId, first.body.assessmentId);

  const link = await api(`/api/tests/schedules/${created.body.schedule.id}/link`, { method: "POST", cookie: coachCookie });
  assert.equal(link.status, 201);
  const resolved = await api(`/api/tests/check-in/${link.body.link.publicToken}/my-assignment`, { cookie: athletes[0].cookie });
  assert.equal(resolved.body.assignment.id, assignmentId);
});

// ------------------------------------------------------------
// F. requireCoachWorkspace rejection inside PATCH/DELETE must not
// double-release the pg client (the same `client.release()` inside the
// early-return AND inside `finally` regression previously fixed elsewhere
// in this file's own history).
// ------------------------------------------------------------

// pg's Client#release() throws "Release called on client which has already
// been released to the pool" on a second call - if either route still had
// its own manual release ahead of the shared `finally`, that throw would
// surface as an unhandled rejection (no async-error middleware is wired up
// in this app - see server.js/express@4), never as a clean 403 body. A
// plain, complete 403 response is already the first proof; draining the
// whole pool afterward and running a real query on every connection is the
// second, independent proof that no connection was left corrupted.
async function assertPoolStillFullyUsable() {
  const poolSize = pool.options.max || 10;
  const clients = [];
  try {
    for (let i = 0; i < poolSize; i += 1) clients.push(await pool.connect());
    for (const client of clients) {
      const result = await client.query("select 1 as ok");
      assert.equal(result.rows[0].ok, 1);
    }
  } finally {
    for (const client of clients) client.release();
  }
}

test("F1. a non-coach account calling PATCH gets a clean 403 (no double-release), and the pool stays fully usable afterward", async () => {
  const { athletes } = await makeClubWithAthletes("f1", 1);
  const nonCoachCookie = athletes[0].cookie; // athlete account: no club/team role, so no coachWorkspace capability
  const res = await api(`/api/tests/schedules/00000000-0000-0000-0000-000000000000`, { method: "PATCH", cookie: nonCoachCookie, body: { status: "paused" } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "Forbidden");
  await assertPoolStillFullyUsable();
});

test("F2. a non-coach account calling DELETE gets a clean 403 (no double-release), and the pool stays fully usable afterward", async () => {
  const { athletes } = await makeClubWithAthletes("f2", 1);
  const nonCoachCookie = athletes[0].cookie;
  const res = await api(`/api/tests/schedules/00000000-0000-0000-0000-000000000000`, { method: "DELETE", cookie: nonCoachCookie });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "Forbidden");
  await assertPoolStillFullyUsable();
});

// ------------------------------------------------------------
// G. cancelled is a terminal status - no reactivation, no edit
// ------------------------------------------------------------

test("G1. status-only PATCH cannot move a cancelled schedule to active or paused", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("g1", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const deleted = await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie });
  assert.equal(deleted.body.action, "deleted", "no occurrence yet - this DELETE physically removes the schedule, not what this test is about");

  // Re-create so there IS a cancelled row to test against (a schedule with
  // an occurrence cancels instead of being deleted - see C2).
  const created2 = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie }); // forces an occurrence to exist
  const cancelled = await api(`/api/tests/schedules/${created2.body.schedule.id}`, { method: "DELETE", cookie: coachCookie });
  assert.equal(cancelled.body.action, "cancelled");

  for (const status of ["active", "paused"]) {
    const attempt = await api(`/api/tests/schedules/${created2.body.schedule.id}`, { method: "PATCH", cookie: coachCookie, body: { status } });
    assert.equal(attempt.status, 409, `reactivating to '${status}' must be rejected`);
  }
  const row = await query(`select status from tests.test_schedules where id = $1`, [created2.body.schedule.id]);
  assert.equal(row.rows[0].status, "cancelled");
});

test("G2. a full edit (targets/kind/dates/times) on a cancelled schedule is rejected outright, nothing is written", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("g2", 2);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie });

  const edited = await api(`/api/tests/schedules/${created.body.schedule.id}`, {
    method: "PATCH",
    cookie: coachCookie,
    body: { scheduleKind: "daily", timezone: "UTC", startDate: TODAY, opensTime: "09:00", closesTime: "20:00", targets: [{ kind: "athlete", id: athletes[1].athleteId }] },
  });
  assert.equal(edited.status, 409);

  const detail = await api(`/api/tests/schedules/${created.body.schedule.id}`, { cookie: coachCookie });
  assert.equal(detail.body.schedule.status, "cancelled");
  assert.equal(detail.body.targets.length, 1);
  assert.equal(detail.body.targets[0].id, athletes[0].athleteId, "the original target must be untouched");
});

test("G3. status-only PATCH can no longer set status directly to 'cancelled' either - only DELETE cancels (it also revokes links, which a bare status write would skip)", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("g3", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const attempt = await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "PATCH", cookie: coachCookie, body: { status: "cancelled" } });
  assert.equal(attempt.status, 400);
  const row = await query(`select status from tests.test_schedules where id = $1`, [created.body.schedule.id]);
  assert.equal(row.rows[0].status, "active");
});

// ------------------------------------------------------------
// H. scheduleKind is validated explicitly, not silently coerced
// ------------------------------------------------------------

test("H1. POST /schedules rejects an unrecognized scheduleKind with a controlled 400, nothing is written", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("h1", 1);
  const before = await query(`select count(*)::int as n from tests.test_schedules`);
  const attempt = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { scheduleKind: "weekly" }),
  });
  assert.equal(attempt.status, 400);
  const after = await query(`select count(*)::int as n from tests.test_schedules`);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test("H2. full-edit PATCH rejects an unrecognized scheduleKind with a controlled 400, the schedule is left unchanged", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("h2", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const attempt = await api(`/api/tests/schedules/${created.body.schedule.id}`, {
    method: "PATCH",
    cookie: coachCookie,
    body: { scheduleKind: "typo", timezone: "UTC", startDate: TODAY, opensTime: "08:00", closesTime: "20:00", targets: [{ kind: "athlete", id: athletes[0].athleteId }] },
  });
  assert.equal(attempt.status, 400);
  const row = await query(`select schedule_kind from tests.test_schedules where id = $1`, [created.body.schedule.id]);
  assert.equal(row.rows[0].schedule_kind, "one_time");
});

// ------------------------------------------------------------
// J. Occurrence-generation vs PATCH/DELETE race, closed via
// migrations_v2/202608260900_tests_v42_occurrence_generation_lock_fix.sql
// (FOR SHARE in tests.generate_test_schedule_occurrence(), serializing
// against PATCH/DELETE's FOR UPDATE on the same schedule row). Driven with
// two REAL, independent connections and deterministic lock-wait polling
// (waitUntilBlockedBy), not sleeps.
// ------------------------------------------------------------

test("J1. generation wins the race first: DELETE waits, then sees the occurrence and correctly cancels instead of physically deleting", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("j1", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const scheduleId = created.body.schedule.id;

  const clientA = await pool.connect();
  try {
    const pidResult = await clientA.query("select pg_backend_pid() as pid");
    const blockerPid = pidResult.rows[0].pid;

    await clientA.query("begin");
    // Acquires the FOR SHARE lock (migrations_v2/202608260900_...) and
    // inserts the occurrence row, but does not commit yet - the row lock is
    // held for the rest of clientA's open transaction.
    const genResult = await clientA.query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [scheduleId, TODAY]);
    assert.ok(genResult.rows[0].id, "generation must succeed and return a real occurrence id");

    // Fire the REAL DELETE route concurrently - its own FOR UPDATE must
    // queue behind clientA's held FOR SHARE lock on the same schedule row.
    const deletePromise = api(`/api/tests/schedules/${scheduleId}`, { method: "DELETE", cookie: coachCookie });
    await waitUntilBlockedBy(blockerPid);

    await clientA.query("commit");
    const deleted = await deletePromise;

    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.action, "cancelled");
    assert.equal(deleted.body.historyPreserved, true);

    const scheduleRow = await query(`select status from tests.test_schedules where id = $1`, [scheduleId]);
    assert.equal(scheduleRow.rows[0].status, "cancelled", "the schedule row must still exist, now cancelled - never physically deleted once an occurrence exists");
    const occurrenceRow = await query(`select id from tests.test_schedule_occurrences where schedule_id = $1`, [scheduleId]);
    assert.equal(occurrenceRow.rowCount, 1, "the occurrence generated during the race must be preserved");
  } finally {
    clientA.release();
  }
});

test("J2. DELETE wins the race first: it physically removes the empty schedule, and the blocked generation call resolves to null afterward - no row created under a deleted schedule, no uncontrolled crash", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("j2", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const scheduleId = created.body.schedule.id;
  const scheduleRow = (await query(`select * from tests.test_schedules where id = $1`, [scheduleId])).rows[0];

  const clientA = await pool.connect();
  try {
    const pidResult = await clientA.query("select pg_backend_pid() as pid");
    const blockerPid = pidResult.rows[0].pid;

    await clientA.query("begin");
    // Mirrors the DELETE route's own first step: lock the schedule row
    // FOR UPDATE, but do not commit yet.
    await clientA.query(`select * from tests.test_schedules where id = $1 for update`, [scheduleId]);

    // Fire a REAL generation attempt concurrently, through the exact same
    // service function the app's own routes call - it must queue behind
    // clientA's FOR UPDATE (it takes FOR SHARE on the same row).
    const generatePromise = ensureCurrentOccurrence(pool, scheduleRow);
    await waitUntilBlockedBy(blockerPid);

    // Mirrors the DELETE route's own "no occurrence yet" branch: physically
    // remove the schedule (and, via cascade, its targets/links), then
    // commit.
    await clientA.query(`delete from tests.test_schedules where id = $1`, [scheduleId]);
    await clientA.query("commit");

    const occurrenceId = await generatePromise; // must resolve cleanly, never reject/throw
    assert.equal(occurrenceId, null, "no occurrence must ever be created under a schedule that was concurrently, physically deleted");

    const occurrenceRows = await query(`select id from tests.test_schedule_occurrences where schedule_id = $1`, [scheduleId]);
    assert.equal(occurrenceRows.rowCount, 0);
    const assignmentRows = await query(`select id from tests.test_assignments where athlete_id = $1`, [athletes[0].athleteId]);
    assert.equal(assignmentRows.rowCount, 0);
  } finally {
    clientA.release();
  }
});

// ------------------------------------------------------------
// K. Phase 2.5 - cancelled/paused lockdown across every access path (not
// just Today, which C2b already covered)
// ------------------------------------------------------------

test("K1. a cancelled schedule's still-pending assignment disappears from Upcoming too, not only Today", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("k1", 1);
  const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const created = await api("/api/tests/schedules", {
    method: "POST", cookie: coachCookie,
    body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { startDate: futureDate }),
  });
  const before = await api("/api/tests/athlete/upcoming", { cookie: athletes[0].cookie });
  assert.equal(before.body.upcoming.length, 1);

  const deleted = await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie });
  assert.equal(deleted.body.action, "deleted", "no occurrence exists yet for a future one_time schedule - this is a physical delete");

  const after = await api("/api/tests/athlete/upcoming", { cookie: athletes[0].cookie });
  assert.equal(after.body.upcoming.length, 0);
});

test("K2. direct GET of an assignment under a cancelled schedule reports canSubmit:false and the schedule's own status - it must never invite filling it in again", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("k2", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const assignmentId = await getTodayAssignmentId(athletes[0].cookie);
  await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie }); // has an occurrence -> cancels

  const detail = await api(`/api/tests/assignments/${assignmentId}`, { cookie: athletes[0].cookie });
  assert.equal(detail.status, 200, "the assignment itself is still readable (read-only), never a 404 - History must stay reachable through it");
  assert.equal(detail.body.canSubmit, false);
  assert.equal(detail.body.assignment.scheduleStatus, "cancelled");
});

test("K3. submit through a PREVIOUSLY-opened assignment form fails with a controlled 409 once the schedule is cancelled after the fact - the server, not the stale client state, decides", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("k3", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const assignmentId = await getTodayAssignmentId(athletes[0].cookie);

  const openedFormStillCanSubmit = await api(`/api/tests/assignments/${assignmentId}`, { cookie: athletes[0].cookie });
  assert.equal(openedFormStillCanSubmit.body.canSubmit, true, "the form was genuinely fillable at the moment it was opened");

  await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie }); // cancels after the form was already open

  const submitFromStaleForm = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athletes[0].cookie, body: { values: FULL_VALUES } });
  assert.equal(submitFromStaleForm.status, 409);
  assert.match(submitFromStaleForm.body.error, /cancelled/i);

  const assignmentRow = await query(`select status from tests.test_assignments where id = $1`, [assignmentId]);
  assert.equal(assignmentRow.rows[0].status, "pending", "the rejected submit must not have changed anything");
});

test("K4. a paused (not cancelled) schedule also rejects a new submit with a controlled 409, without touching any existing history", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("k4", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const assignmentId = await getTodayAssignmentId(athletes[0].cookie);

  const paused = await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "PATCH", cookie: coachCookie, body: { status: "paused" } });
  assert.equal(paused.status, 200);

  const submitWhilePaused = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athletes[0].cookie, body: { values: FULL_VALUES } });
  assert.equal(submitWhilePaused.status, 409);
  assert.match(submitWhilePaused.body.error, /paused/i);

  const assignmentRow = await query(`select status from tests.test_assignments where id = $1`, [assignmentId]);
  assert.equal(assignmentRow.rows[0].status, "pending");
});

test("K5. a completed result stays fully visible to the coach (in Results and the single-result view) after its schedule is cancelled", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("k5", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const assignmentId = await getTodayAssignmentId(athletes[0].cookie);
  const submitted = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athletes[0].cookie, body: { values: FULL_VALUES } });
  assert.equal(submitted.status, 200);

  const cancelled = await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie });
  assert.equal(cancelled.body.action, "cancelled");

  const results = await api("/api/tests/results", { cookie: coachCookie });
  assert.equal(results.body.results.length, 1);
  assert.equal(results.body.results[0].assessmentId, submitted.body.assessmentId);

  const singleResult = await api(`/api/tests/results/${submitted.body.assessmentId}`, { cookie: coachCookie });
  assert.equal(singleResult.status, 200);
  assert.equal(singleResult.body.wellnessScore, 4);

  // The athlete's own History is unaffected either.
  const history = await api("/api/tests/athlete/history", { cookie: athletes[0].cookie });
  assert.equal(history.body.history.length, 1);
});

// ------------------------------------------------------------
// N. Concurrency: PATCH edit vs a simultaneous athlete submit on the SAME
// one_time schedule's assignment - both orderings, driven with two real,
// independent connections and deterministic lock-wait polling
// (waitUntilBlockedBy), matching J1/J2's own pattern above.
// ------------------------------------------------------------

test("N1. submit wins the race: it completes first, so the concurrent edit attempt correctly sees the now-real activity and is rejected with 409", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("n1", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const assignmentId = await getTodayAssignmentId(athletes[0].cookie);

  const clientA = await pool.connect();
  try {
    const pidResult = await clientA.query("select pg_backend_pid() as pid");
    const blockerPid = pidResult.rows[0].pid;

    await clientA.query("begin");
    // Mirrors POST /submit's own first lock step.
    await clientA.query(`select * from tests.test_assignments where id = $1 for update`, [assignmentId]);

    // Fire the REAL PATCH edit concurrently - its own activity check takes
    // FOR UPDATE on this exact assignment row, so it must queue behind
    // clientA's held lock.
    const editPromise = api(`/api/tests/schedules/${created.body.schedule.id}`, {
      method: "PATCH", cookie: coachCookie,
      body: { scheduleKind: "one_time", timezone: "UTC", startDate: TODAY, opensTime: "01:00", closesTime: "22:00", targets: [{ kind: "athlete", id: athletes[0].athleteId }] },
    });
    await waitUntilBlockedBy(blockerPid);

    // Mirrors what a real submit does to the assignment row (the minimal
    // part the edit's own activity check actually looks at) before
    // committing - this IS "submit winning the race".
    await clientA.query(`update tests.test_assignments set status = 'completed', completed_at = now() where id = $1`, [assignmentId]);
    await clientA.query("commit");

    const edited = await editPromise;
    assert.equal(edited.status, 409);
    assert.equal(edited.body.reason, "has_activity");

    const occurrenceRows = await query(`select id from tests.test_schedule_occurrences where schedule_id = $1`, [created.body.schedule.id]);
    assert.equal(occurrenceRows.rowCount, 1, "the edit must not have deleted the occurrence once it saw real activity");
  } finally {
    clientA.release();
  }
});

test("N2. edit wins the race: it safely regenerates first, so the concurrent submit attempt correctly finds the assignment gone (404), never a corrupted half-state", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("n2", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  const assignmentId = await getTodayAssignmentId(athletes[0].cookie);

  const clientA = await pool.connect();
  try {
    const pidResult = await clientA.query("select pg_backend_pid() as pid");
    const blockerPid = pidResult.rows[0].pid;

    await clientA.query("begin");
    // Mirrors PATCH's own lock sequence: schedule row, then the
    // occurrence(s), then the assignment(s) - all FOR UPDATE.
    await clientA.query(`select * from tests.test_schedules where id = $1 for update`, [created.body.schedule.id]);
    await clientA.query(`select id from tests.test_schedule_occurrences where schedule_id = $1 for update`, [created.body.schedule.id]);
    await clientA.query(`select id, status, started_at from tests.test_assignments where id = $1 for update`, [assignmentId]);

    // Fire the REAL submit concurrently - its own first step locks this
    // exact assignment row, so it must queue behind clientA.
    const submitPromise = api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athletes[0].cookie, body: { values: FULL_VALUES } });
    await waitUntilBlockedBy(blockerPid);

    // Already proven safe (still pending, no assessment) - mirrors the
    // edit's own regeneration step.
    await clientA.query(`delete from tests.test_schedule_occurrences where schedule_id = $1`, [created.body.schedule.id]);
    await clientA.query("commit");

    const submitted = await submitPromise;
    assert.equal(submitted.status, 404, "the assignment the stale request was aimed at no longer exists - a clean 404, never a corrupted write");

    const occurrenceRows = await query(`select id from tests.test_schedule_occurrences where schedule_id = $1`, [created.body.schedule.id]);
    assert.equal(occurrenceRows.rowCount, 0);
    const assessmentRows = await query(`select id from tests.test_assessments where athlete_id = $1`, [athletes[0].athleteId]);
    assert.equal(assessmentRows.rowCount, 0, "the losing submit must never have created an assessment for a now-deleted assignment");
  } finally {
    clientA.release();
  }
});

test("N3. real PATCH and real POST /submit fired truly concurrently (no manual SQL standing in for either side), repeated - never a raw deadlock (40P01) or 500, always exactly one clean 200 against the OTHER side's controlled 404/409", async () => {
  // N1/N2 above prove each specific winning order deterministically, but
  // each one imitates ONE side by hand with raw SQL instead of driving both
  // sides through the real routes. This is the real-endpoint counterpart:
  // both requests are genuine HTTP calls into the real Express app, fired
  // together (Promise.all), against a fresh schedule/assignment each
  // iteration, repeated several times to exercise both real orderings the
  // canonical schedule -> occurrence -> assignment lock order (submit and
  // PATCH now both use it, see POST /submit and PATCH /schedules/:id in
  // backend/src/routes/tests.js) makes possible - and impossible to
  // deadlock between, unlike the old, inverted submit order.
  const ITERATIONS = 6;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const { coachCookie, athletes } = await makeClubWithAthletes(`n3-${i}`, 1);
    const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
    const assignmentId = await getTodayAssignmentId(athletes[0].cookie);

    const [submitResult, patchResult] = await Promise.all([
      api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athletes[0].cookie, body: { values: FULL_VALUES } }),
      api(`/api/tests/schedules/${created.body.schedule.id}`, {
        method: "PATCH", cookie: coachCookie,
        body: { scheduleKind: "one_time", timezone: "UTC", startDate: TODAY, opensTime: "01:00", closesTime: "22:00", targets: [{ kind: "athlete", id: athletes[0].athleteId }] },
      }),
    ]);

    for (const result of [submitResult, patchResult]) {
      assert.notEqual(result.status, 500, `iteration ${i}: a real 500 means a raw, unhandled deadlock (40P01) or crash slipped through - never allowed`);
    }

    const outcome = `${submitResult.status}/${patchResult.status}`;
    assert.ok(
      ["200/409", "404/200"].includes(outcome),
      `iteration ${i}: unexpected status pair submit=${submitResult.status}/patch=${patchResult.status} - expected submit-wins (200/409 has_activity) or edit-wins (404/200)`,
    );
    if (outcome === "200/409") assert.equal(patchResult.body.reason, "has_activity");
  }
});

// ------------------------------------------------------------
// M. "Specific dates" bulk scheduling (POST /schedules/bulk)
// ------------------------------------------------------------

function bulkCreateBody(dates, targets, overrides = {}) {
  return {
    testVersionId: WELLNESS_TEST_VERSION_ID,
    timezone: "UTC",
    opensTime: "06:00",
    closesTime: "22:00",
    dates,
    targets,
    ...overrides,
  };
}

test("M1. choosing three dates creates exactly three independent one_time schedules, sharing the same test/time/targets", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("m1", 1);
  const dates = ["2026-09-01", "2026-09-03", "2026-09-07"];
  const result = await api("/api/tests/schedules/bulk", { method: "POST", cookie: coachCookie, body: bulkCreateBody(dates, [{ kind: "athlete", id: athletes[0].athleteId }]) });
  assert.equal(result.status, 201);
  assert.equal(result.body.count, 3);
  assert.deepEqual(result.body.dates.sort(), dates.slice().sort());
  assert.equal(result.body.schedules.length, 3);
  assert.ok(result.body.schedules.every((s) => s.scheduleKind === "one_time"));

  const createdIds = result.body.schedules.map((s) => s.id);
  const rows = await query(`select id, start_date, schedule_kind from tests.test_schedules where id = any($1::uuid[]) order by start_date`, [createdIds]);
  assert.equal(rows.rowCount, 3);
  assert.deepEqual(rows.rows.map((r) => r.schedule_kind), ["one_time", "one_time", "one_time"]);

  // Independent schedules, not one grouped row - each has its own target row.
  const targetRows = await query(`select schedule_id from tests.test_schedule_targets where schedule_id = any($1::uuid[])`, [createdIds]);
  assert.equal(targetRows.rowCount, 3);
  assert.equal(new Set(targetRows.rows.map((r) => r.schedule_id)).size, 3);
});

test("M2. duplicate dates in the same bulk request collapse to one schedule per unique date, not an error", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("m2", 1);
  const result = await api("/api/tests/schedules/bulk", {
    method: "POST", cookie: coachCookie,
    body: bulkCreateBody(["2026-09-10", "2026-09-10", "2026-09-11", "2026-09-10"], [{ kind: "athlete", id: athletes[0].athleteId }]),
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.count, 2);
  assert.deepEqual(result.body.dates.sort(), ["2026-09-10", "2026-09-11"]);
});

test("M3. one malformed date rolls back the ENTIRE bulk request - no schedule for any of the valid dates either", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("m3", 1);
  const before = await query(`select count(*)::int as n from tests.test_schedules`);
  const result = await api("/api/tests/schedules/bulk", {
    method: "POST", cookie: coachCookie,
    body: bulkCreateBody(["2026-09-12", "not-a-date", "2026-09-14"], [{ kind: "athlete", id: athletes[0].athleteId }]),
  });
  assert.equal(result.status, 400);
  const after = await query(`select count(*)::int as n from tests.test_schedules`);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test("M3b. a syntactically well-formed but calendar-impossible date (Feb 30) is rejected with a controlled 400, not silently rolled over into March - nothing is written", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("m3b", 1);
  const before = await query(`select count(*)::int as n from tests.test_schedules`);
  const result = await api("/api/tests/schedules/bulk", {
    method: "POST", cookie: coachCookie,
    body: bulkCreateBody(["2026-09-12", "2026-02-30", "2026-09-14"], [{ kind: "athlete", id: athletes[0].athleteId }]),
  });
  assert.equal(result.status, 400);
  const after = await query(`select count(*)::int as n from tests.test_schedules`);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test("M3c. Feb 29 is accepted on a real leap year (2028) but rejected on a non-leap year (2026) - a bare regex can't tell these apart", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("m3c", 1);
  const leapYear = await api("/api/tests/schedules/bulk", {
    method: "POST", cookie: coachCookie,
    body: bulkCreateBody(["2028-02-29"], [{ kind: "athlete", id: athletes[0].athleteId }]),
  });
  assert.equal(leapYear.status, 201, "2028 is a real leap year - Feb 29 exists");

  const before = await query(`select count(*)::int as n from tests.test_schedules`);
  const nonLeapYear = await api("/api/tests/schedules/bulk", {
    method: "POST", cookie: coachCookie,
    body: bulkCreateBody(["2026-02-29"], [{ kind: "athlete", id: athletes[0].athleteId }]),
  });
  assert.equal(nonLeapYear.status, 400, "2026 is not a leap year - Feb 29 does not exist");
  const after = await query(`select count(*)::int as n from tests.test_schedules`);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test("M3d. April 31 (a real month, but one that only has 30 days) is rejected with a controlled 400", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("m3d", 1);
  const result = await api("/api/tests/schedules/bulk", {
    method: "POST", cookie: coachCookie,
    body: bulkCreateBody(["2026-04-31"], [{ kind: "athlete", id: athletes[0].athleteId }]),
  });
  assert.equal(result.status, 400);
});

test("M4. an unauthorized target rolls back the entire bulk request, across every date", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("m4", 1);
  const outsider = await makeAthlete({ name: "M4 Outsider" });
  const before = await query(`select count(*)::int as n from tests.test_schedules`);
  const result = await api("/api/tests/schedules/bulk", {
    method: "POST", cookie: coachCookie,
    body: bulkCreateBody(["2026-09-15", "2026-09-16"], [{ kind: "athlete", id: athletes[0].athleteId }, { kind: "athlete", id: outsider }]),
  });
  assert.equal(result.status, 403);
  const after = await query(`select count(*)::int as n from tests.test_schedules`);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test("M5. each schedule created by a bulk request is independently editable and independently deletable/cancellable afterward, through the existing single-schedule routes", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("m5", 2);
  const result = await api("/api/tests/schedules/bulk", {
    method: "POST", cookie: coachCookie,
    body: bulkCreateBody(["2026-09-20", "2026-09-21"], [{ kind: "athlete", id: athletes[0].athleteId }]),
  });
  const [first, second] = result.body.schedules;

  const edited = await api(`/api/tests/schedules/${first.id}`, {
    method: "PATCH", cookie: coachCookie,
    body: { scheduleKind: "one_time", timezone: "UTC", startDate: "2026-09-20", opensTime: "07:00", closesTime: "20:00", targets: [{ kind: "athlete", id: athletes[1].athleteId }] },
  });
  assert.equal(edited.status, 200, "editing one bulk-created day must not require or affect the others");

  const deleted = await api(`/api/tests/schedules/${second.id}`, { method: "DELETE", cookie: coachCookie });
  assert.equal(deleted.body.action, "deleted");

  const firstStillThere = await api(`/api/tests/schedules/${first.id}`, { cookie: coachCookie });
  assert.equal(firstStillThere.status, 200);
  assert.equal(firstStillThere.body.schedule.opensTime.slice(0, 5), "07:00");
});

function sequentialDates(startIso, count) {
  const dates = [];
  const cursor = new Date(`${startIso}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

test("M6. a bulk request with 367 unique dates is rejected with a controlled 400 - nothing is written, not even the first 366", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("m7", 1);
  const dates = sequentialDates("2029-01-01", 367);
  const before = await query(`select count(*)::int as n from tests.test_schedules`);
  const result = await api("/api/tests/schedules/bulk", { method: "POST", cookie: coachCookie, body: bulkCreateBody(dates, [{ kind: "athlete", id: athletes[0].athleteId }]) });
  assert.equal(result.status, 400);
  const after = await query(`select count(*)::int as n from tests.test_schedules`);
  assert.equal(after.rows[0].n, before.rows[0].n, "an over-limit request must write nothing, not even a truncated first 366");
});

// ------------------------------------------------------------
// O. Schedule-kind conversion rules (daily <-> one_time)
// ------------------------------------------------------------

test("O1. a daily schedule that already has a generated occurrence cannot be converted to one-time - controlled 409, existing occurrence untouched", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("o1", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { scheduleKind: "daily" }) });
  assert.equal(created.status, 201);
  // Materializes today's occurrence for the daily schedule, same as any
  // athlete opening Today would.
  await getTodayAssignmentId(athletes[0].cookie);

  const converted = await api(`/api/tests/schedules/${created.body.schedule.id}`, {
    method: "PATCH", cookie: coachCookie,
    body: { scheduleKind: "one_time", timezone: "UTC", startDate: TODAY, opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "athlete", id: athletes[0].athleteId }] },
  });
  assert.equal(converted.status, 409);
  assert.equal(converted.body.reason, "recurring_has_occurrence");

  const stillDaily = await query(`select schedule_kind from tests.test_schedules where id = $1`, [created.body.schedule.id]);
  assert.equal(stillDaily.rows[0].schedule_kind, "recurring", "a rejected conversion must leave the schedule's kind unchanged");
  const occurrenceRows = await query(`select id from tests.test_schedule_occurrences where schedule_id = $1`, [created.body.schedule.id]);
  assert.equal(occurrenceRows.rowCount, 1, "the existing occurrence must survive a rejected conversion untouched");
});

test("O1b. the SAME daily schedule, edited while staying daily (no kind change), is unaffected by the conversion rule - normal future-only edit still works", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("o1b", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { scheduleKind: "daily" }) });
  await getTodayAssignmentId(athletes[0].cookie);

  const edited = await api(`/api/tests/schedules/${created.body.schedule.id}`, {
    method: "PATCH", cookie: coachCookie,
    body: { scheduleKind: "daily", timezone: "UTC", startDate: TODAY, opensTime: "05:00", closesTime: "21:00", targets: [{ kind: "athlete", id: athletes[0].athleteId }] },
  });
  assert.equal(edited.status, 200, "editing a daily schedule while it stays daily must never be blocked by the recurring->one_time rule");
});

test("O2. a one_time schedule without activity converts cleanly to daily via the existing safe regeneration flow", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("o2", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  await getTodayAssignmentId(athletes[0].cookie); // materializes the one_time occurrence, still untouched

  const converted = await api(`/api/tests/schedules/${created.body.schedule.id}`, {
    method: "PATCH", cookie: coachCookie,
    body: { scheduleKind: "daily", timezone: "UTC", startDate: TODAY, opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "athlete", id: athletes[0].athleteId }] },
  });
  assert.equal(converted.status, 200);
  assert.equal(converted.body.schedule.scheduleKind, "recurring");

  // The stale one_time occurrence was safely deleted (same regeneration
  // path as a same-kind one_time edit) - the next Today view materializes a
  // fresh one under the now-daily schedule.
  const afterConvert = await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  assert.equal(afterConvert.body.assignments.length, 1, "a fresh occurrence/assignment must be generated under the new daily schedule");
});

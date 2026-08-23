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
const SCHEMA_NAME = "202608220900_tests_v42_schema.sql";
const SEED_NAME = "202608221000_tests_v42_seed_wellness_fms.sql";
const PHASE1_NAME = "202608240900_tests_v42_phase1_scheduling_execution.sql";
const PRESENTATION_NAME = "202608250900_tests_v42_presentation_metadata.sql";
const SUPERSEDE_FIX_NAME = "202608250901_tests_v42_supersede_generated_column_fix.sql";

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
    athlete_id text
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
let query, pool, createSession, hashPassword;

before(async () => {
  const [schemaSql, seedSql, phase1Sql, presentationSql, supersedeFixSql] = await Promise.all([
    fsp.readFile(SCHEMA_PATH, "utf8"),
    fsp.readFile(SEED_PATH, "utf8"),
    fsp.readFile(PHASE1_PATH, "utf8"),
    fsp.readFile(PRESENTATION_PATH, "utf8"),
    fsp.readFile(SUPERSEDE_FIX_PATH, "utf8"),
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
  });
  await runner.runMigrations({ databaseUrl: db.url, migrationsRoot: migrationsDir });

  process.env.DATABASE_URL = db.url;
  const dbModule = await import("../src/db.js");
  query = dbModule.query;
  pool = dbModule.pool;
  const authModule = await import("../src/auth.js");
  createSession = authModule.createSession;
  hashPassword = authModule.hashPassword;
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

test("B3. a one_time schedule that already has an occurrence cannot be fully edited - a clear, controlled rejection, not a silent no-op", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b3", 2);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }]) });
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie }); // generates the one_time occurrence

  const edited = await api(`/api/tests/schedules/${created.body.schedule.id}`, {
    method: "PATCH",
    cookie: coachCookie,
    body: { scheduleKind: "one_time", timezone: "UTC", startDate: TODAY, opensTime: "01:00", closesTime: "22:00", targets: [{ kind: "athlete", id: athletes[1].athleteId }] },
  });
  assert.equal(edited.status, 409);

  // Nothing changed.
  const detail = await api(`/api/tests/schedules/${created.body.schedule.id}`, { cookie: coachCookie });
  assert.equal(detail.body.targets.length, 1);
  assert.equal(detail.body.targets[0].id, athletes[0].athleteId);
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

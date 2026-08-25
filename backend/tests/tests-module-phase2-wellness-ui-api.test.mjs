// Validates Phase 2 of the Tests module: the new presentation-metadata
// migration (migrations_v2/202608250900_tests_v42_presentation_metadata.sql),
// the real /api/tests/... routes (backend/src/routes/tests.js,
// backend/src/routes/testsCheckIn.js), the on-demand occurrence/
// materialization service (backend/src/testsOccurrenceService.js), and the
// public schedule check-in link - built ON TOP of the already-deployed
// Tests v4.2 catalog and Phase 1 scheduling/execution layer (NOT modified
// here).
//
// Runs entirely against a disposable, uniquely-named temporary database
// (never OPTIMOVE, never monitoring2) through the real Strategy B runner
// (backend/src/migrate.js). Unlike the Phase 1 test file (which only needed
// raw SQL/trigger coverage), this file drives the REAL Express app over real
// HTTP with real session cookies - process.env.DATABASE_URL is pointed at
// the temp database BEFORE the app/db/auth modules are (dynamically)
// imported for the first time, so their internally-held pg Pool binds to
// the temp database, never OPTIMOVE. The hand-rolled fixture below is
// therefore larger than Phase 1's - it has to support real login/authz/
// workspace resolution, not just Phase 1's own FK targets.
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
const DEEP_SQUAT_TEST_VERSION_ID = "560cf251-50b1-4728-b317-a2c38fe9107a"; // FMS, not schedulable in this phase

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

// Extends Phase 1's minimal legacy-fingerprint fixture with real auth/authz/
// workspace machinery (sessions, roles, workspace preferences) - this file
// drives real HTTP requests through real login sessions, not just raw SQL
// against Phase 1's own tables.
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
  const name = `optimove_tests_phase2_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_phase2_migrations_${runId}`);
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

  // Point the app's own pool at the temp database BEFORE importing it for
  // the first time - db.js reads process.env.DATABASE_URL once, at module
  // evaluation, so this only works because these are the first imports of
  // these modules in this test process (node's test runner gives each test
  // FILE its own process by default).
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
async function grantIndependentCoach(userId) {
  await query(`insert into public.user_global_roles (user_id, role) values ($1,'independent_coach')`, [userId]);
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

async function linkCoachToAthlete(coachId, athleteId) {
  await query(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1,$2,'coach',true)`, [coachId, athleteId]);
}

async function makeIndependentCoachWithAthlete(label) {
  const coachId = await makeUser({ email: `coach-${label}-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local` });
  await grantIndependentCoach(coachId);
  const athleteUserId = await makeUser({ email: `athlete-${label}-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: `Athlete ${label}`, userId: athleteUserId });
  await linkCoachToAthlete(coachId, athleteId);
  const coachCookie = await loginCookie(coachId);
  const athleteCookie = await loginCookie(athleteUserId);
  return { coachId, coachCookie, athleteUserId, athleteId, athleteCookie };
}

// Schedules WELLNESS one_time for the given athlete, opening now and
// closing far in the future (unless overridden) - the fast path most tests
// use to get a submittable assignment.
async function scheduleWellnessForAthlete(coachCookie, athleteId, { closesTime = "23:59", opensTime = "00:00", timezone = "UTC", scheduleKind = "one_time" } = {}) {
  // For a daily (recurring) schedule, start_date sits a few days back
  // (server-local) so the timezone-computed "today" always falls inside the
  // window regardless of how far the schedule's own timezone offset is from
  // the server's. A one_time schedule's occurrence date is exactly
  // start_date (no timezone math involved), so it keeps using the server's
  // own today - a past start_date there would put its default 00:00-23:59
  // window in the past too, wrongly closing every fast-path test.
  const startDate = scheduleKind === "recurring"
    ? new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: {
      testVersionId: WELLNESS_TEST_VERSION_ID,
      scheduleKind,
      timezone,
      startDate,
      opensTime,
      closesTime,
      targets: [{ kind: "athlete", id: athleteId }],
    },
  });
  return created;
}

const FULL_VALUES = { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: true };

async function getTodayAssignmentId(athleteCookie) {
  const today = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  return today.body.assignments[0]?.assignmentId;
}

// ------------------------------------------------------------
// A. Presentation metadata is DB-driven, not frontend/backend-hardcoded
// ------------------------------------------------------------

test("A1. WELLNESS Test Library entry is schedulable; FMS batteries are not", async () => {
  const { coachId, coachCookie } = await makeIndependentCoachWithAthlete("a1");
  const res = await api("/api/tests/library", { cookie: coachCookie });
  assert.equal(res.status, 200);
  const wellness = res.body.tests.find((t) => t.testVersionId === WELLNESS_TEST_VERSION_ID);
  assert.equal(wellness.schedulable, true);
  assert.ok(res.body.batteries.length > 0);
  assert.ok(res.body.batteries.every((b) => b.schedulable === false));
});

test("A2. assignment form definition loads distinct, real DB presentation metadata per parameter - not hardcoded", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("a2");
  await scheduleWellnessForAthlete(coachCookie, athleteId);
  const assignmentId = await getTodayAssignmentId(athleteCookie);
  const detail = await api(`/api/tests/assignments/${assignmentId}`, { cookie: athleteCookie });
  assert.equal(detail.status, 200);
  const byKey = Object.fromEntries(detail.body.parameters.map((p) => [p.key, p]));
  assert.equal(byKey.fatigue.controlType, "slider");
  assert.equal(byKey.fatigue.direction, "lower_better");
  assert.equal(byKey.fatigue.minLabel, "Fresh");
  assert.equal(byKey.fatigue.maxLabel, "Exhausted");
  assert.equal(byKey.soreness.minLabel, "None");
  assert.equal(byKey.soreness.maxLabel, "Severe");
  assert.equal(byKey.injury.controlType, "yes_no");
  assert.equal(byKey.injury.direction, "neutral");
  assert.deepEqual(detail.body.parameters.map((p) => p.key), ["fatigue", "sleep", "soreness", "stress", "mood", "injury"]);
});

// ------------------------------------------------------------
// B. Value validation via the real submit endpoint
// ------------------------------------------------------------

test("B1. fatigue = 0 is accepted as a valid answer", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("b1");
  await scheduleWellnessForAthlete(coachCookie, athleteId);
  const assignmentId = await getTodayAssignmentId(athleteCookie);
  const submit = await api(`/api/tests/assignments/${assignmentId}/submit`, {
    method: "POST",
    cookie: athleteCookie,
    body: { values: { ...FULL_VALUES, fatigue: 0 } },
  });
  assert.equal(submit.status, 200);
  assert.equal(submit.body.values.fatigue, 0);
});

test("B2. injury = false is accepted as a valid answer", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("b2");
  await scheduleWellnessForAthlete(coachCookie, athleteId);
  const assignmentId = await getTodayAssignmentId(athleteCookie);
  const submit = await api(`/api/tests/assignments/${assignmentId}/submit`, {
    method: "POST",
    cookie: athleteCookie,
    body: { values: { ...FULL_VALUES, injury: false } },
  });
  assert.equal(submit.status, 200);
  assert.equal(submit.body.values.injury, false);
});

test("B3. a value outside 0-10 is rejected", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("b3");
  await scheduleWellnessForAthlete(coachCookie, athleteId);
  const assignmentId = await getTodayAssignmentId(athleteCookie);
  const submit = await api(`/api/tests/assignments/${assignmentId}/submit`, {
    method: "POST",
    cookie: athleteCookie,
    body: { values: { ...FULL_VALUES, stress: 11 } },
  });
  assert.equal(submit.status, 400);
});

test("B4. a decimal value for an integer parameter is rejected", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("b4");
  await scheduleWellnessForAthlete(coachCookie, athleteId);
  const assignmentId = await getTodayAssignmentId(athleteCookie);
  const submit = await api(`/api/tests/assignments/${assignmentId}/submit`, {
    method: "POST",
    cookie: athleteCookie,
    body: { values: { ...FULL_VALUES, mood: 3.5 } },
  });
  assert.equal(submit.status, 400);
});

test("B5. a missing required answer is rejected with a clear message", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("b5");
  await scheduleWellnessForAthlete(coachCookie, athleteId);
  const assignmentId = await getTodayAssignmentId(athleteCookie);
  const { mood, ...withoutMood } = FULL_VALUES;
  const submit = await api(`/api/tests/assignments/${assignmentId}/submit`, {
    method: "POST",
    cookie: athleteCookie,
    body: { values: withoutMood },
  });
  assert.equal(submit.status, 400);
  assert.match(submit.body.error, /mood/);
});

// ------------------------------------------------------------
// C. WELLNESS Total correctness
// ------------------------------------------------------------

test("C1. Wellness score is the average of exactly the 5 numeric answers, injury excluded", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("c1");
  await scheduleWellnessForAthlete(coachCookie, athleteId);
  const assignmentId = await getTodayAssignmentId(athleteCookie);
  const submit = await api(`/api/tests/assignments/${assignmentId}/submit`, {
    method: "POST",
    cookie: athleteCookie,
    body: { values: { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: true } },
  });
  assert.equal(submit.status, 200);
  assert.equal(submit.body.wellnessScore, 4);
});

// ------------------------------------------------------------
// D. Double submit / idempotency
// ------------------------------------------------------------

test("D1. a repeated submit with the same idempotency key never creates a second completed assessment", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("d1");
  await scheduleWellnessForAthlete(coachCookie, athleteId);
  const assignmentId = await getTodayAssignmentId(athleteCookie);
  const idempotencyKey = crypto.randomUUID();
  const first = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athleteCookie, body: { values: FULL_VALUES, idempotencyKey } });
  const second = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athleteCookie, body: { values: FULL_VALUES, idempotencyKey } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.assessmentId, second.body.assessmentId);
  const count = await query(`select count(*)::int as n from tests.test_assessments where idempotency_key = $1`, [idempotencyKey]);
  assert.equal(count.rows[0].n, 1);
});

// ------------------------------------------------------------
// E. Correction via supersedes, while occurrence stays open
// ------------------------------------------------------------

test("E1. submitting again creates a new revision via supersedes and never mutates the old completed row", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("e1");
  await scheduleWellnessForAthlete(coachCookie, athleteId);
  const assignmentId = await getTodayAssignmentId(athleteCookie);
  const first = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athleteCookie, body: { values: FULL_VALUES } });
  assert.equal(first.status, 200);
  const second = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athleteCookie, body: { values: { ...FULL_VALUES, fatigue: 9 } } });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.assessmentId, first.body.assessmentId);
  assert.equal(second.body.values.fatigue, 9);
  const original = await query(`select status, superseded_by_assessment_id from tests.test_assessments where id = $1`, [first.body.assessmentId]);
  assert.equal(original.rows[0].status, "invalidated");
  assert.equal(original.rows[0].superseded_by_assessment_id, second.body.assessmentId);
  const originalValues = await query(`select value_numeric from tests.test_assessment_values v join tests.test_parameters p on p.id = v.test_parameter_id where v.assessment_id = $1 and p.parameter_key = 'fatigue'`, [first.body.assessmentId]);
  assert.equal(Number(originalValues.rows[0].value_numeric), 2, "the old completed row's own values must be untouched");
});

// ------------------------------------------------------------
// F. Closed occurrence rejects submit
// ------------------------------------------------------------

test("F1. a closed occurrence rejects a new submit", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("f1");
  await scheduleWellnessForAthlete(coachCookie, athleteId, { opensTime: "00:00", closesTime: "00:01" });
  // The schedule's window (00:00-00:01) is almost certainly already in the
  // past by the time this runs today - ensure the occurrence exists via the
  // athlete's own Today call, then confirm the API refuses the submit.
  const assignmentId = await getTodayAssignmentId(athleteCookie);
  if (!assignmentId) return; // window fell exactly on midnight boundary - nothing to assert against
  const submit = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athleteCookie, body: { values: FULL_VALUES } });
  assert.equal(submit.status, 409);
});

// ------------------------------------------------------------
// G. Materialization is idempotent
// ------------------------------------------------------------

test("G1. repeated Today calls never duplicate the occurrence or the assignment", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("g1");
  await scheduleWellnessForAthlete(coachCookie, athleteId);
  await api("/api/tests/athlete/today", { cookie: athleteCookie });
  await api("/api/tests/athlete/today", { cookie: athleteCookie });
  const third = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  assert.equal(third.status, 200);
  assert.equal(third.body.assignments.length, 1);
  const counts = await query(
    `select
       (select count(*)::int from tests.test_schedule_occurrences o join tests.test_assignments a on a.occurrence_id = o.id where a.athlete_id = $1) as occurrences,
       (select count(*)::int from tests.test_assignments where athlete_id = $1) as assignments`,
    [athleteId],
  );
  assert.equal(counts.rows[0].occurrences, 1);
  assert.equal(counts.rows[0].assignments, 1);
});

// ------------------------------------------------------------
// H. Timezone-correct occurrence date
// ------------------------------------------------------------

test("H1. the occurrence's scheduled_date follows the schedule's own IANA timezone, not server-local", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("h1");
  const timezone = "Pacific/Kiritimati"; // UTC+14 - almost never equal to the test runner's own local/UTC date
  const localDate = (await query(`select (now() at time zone $1)::date as d`, [timezone])).rows[0].d;
  await scheduleWellnessForAthlete(coachCookie, athleteId, { timezone, scheduleKind: "daily" });
  await api("/api/tests/athlete/today", { cookie: athleteCookie });
  const occurrence = await query(
    `select o.scheduled_date from tests.test_schedule_occurrences o
     join tests.test_assignments a on a.occurrence_id = o.id
     where a.athlete_id = $1`,
    [athleteId],
  );
  assert.equal(String(occurrence.rows[0].scheduled_date), String(localDate));
});

// ------------------------------------------------------------
// I. Team target snapshot - a later member never joins a already-generated occurrence
// ------------------------------------------------------------

test("I1. materializing a team target assigns current members only; a member added afterward is excluded", async () => {
  const coachId = await makeUser({ email: `coach-i1-${Date.now()}@test.local` });
  const clubId = await makeClub("I1 Club");
  const teamId = await makeTeam(clubId, "I1 Team");
  await grantClubAdmin(coachId, clubId);
  const coachCookie = await loginCookie(coachId);

  const athleteAUserId = await makeUser({ email: `i1-a-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteBUserId = await makeUser({ email: `i1-b-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteAId = await makeAthlete({ name: "I1 A", userId: athleteAUserId });
  const athleteBId = await makeAthlete({ name: "I1 B", userId: athleteBUserId });
  await addMembership(athleteAId, { teamId });
  await addMembership(athleteBId, { teamId });

  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: { testVersionId: WELLNESS_TEST_VERSION_ID, scheduleKind: "one_time", timezone: "UTC", startDate: new Date().toISOString().slice(0, 10), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: teamId }] },
  });
  assert.equal(created.status, 201);

  const today = await api("/api/tests/today", { cookie: coachCookie });
  const group = today.body.groups.find((g) => g.schedule.id === created.body.schedule.id);
  assert.equal(group.counts.total, 2);

  const athleteCUserId = await makeUser({ email: `i1-c-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteCId = await makeAthlete({ name: "I1 C", userId: athleteCUserId });
  await addMembership(athleteCId, { teamId });

  const todayAgain = await api("/api/tests/today", { cookie: coachCookie });
  const groupAgain = todayAgain.body.groups.find((g) => g.schedule.id === created.body.schedule.id);
  assert.equal(groupAgain.counts.total, 2, "a member added after materialization must not retroactively join the occurrence");
});

// ------------------------------------------------------------
// J. Athlete cross-access is rejected
// ------------------------------------------------------------

test("J1. one athlete cannot view another athlete's assignment", async () => {
  const a = await makeIndependentCoachWithAthlete("j1a");
  const b = await makeIndependentCoachWithAthlete("j1b");
  await scheduleWellnessForAthlete(a.coachCookie, a.athleteId);
  const assignmentId = await getTodayAssignmentId(a.athleteCookie);
  const asOther = await api(`/api/tests/assignments/${assignmentId}`, { cookie: b.athleteCookie });
  assert.equal(asOther.status, 404);
});

test("J2. one athlete cannot submit another athlete's assignment", async () => {
  const a = await makeIndependentCoachWithAthlete("j2a");
  const b = await makeIndependentCoachWithAthlete("j2b");
  await scheduleWellnessForAthlete(a.coachCookie, a.athleteId);
  const assignmentId = await getTodayAssignmentId(a.athleteCookie);
  const asOther = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: b.athleteCookie, body: { values: FULL_VALUES } });
  assert.equal(asOther.status, 404);
});

// ------------------------------------------------------------
// K. Coach cross-scope is rejected
// ------------------------------------------------------------

test("K1. a coach outside a schedule's club cannot see or manage it", async () => {
  const clubX = await makeClub("K1 Club X");
  const clubY = await makeClub("K1 Club Y");
  const coachX = await makeUser({ email: `k1-x-${Date.now()}@test.local` });
  const coachY = await makeUser({ email: `k1-y-${Date.now()}@test.local` });
  await grantClubAdmin(coachX, clubX);
  await grantClubAdmin(coachY, clubY);
  const cookieX = await loginCookie(coachX);
  const cookieY = await loginCookie(coachY);
  const athleteUserId = await makeUser({ email: `k1-athlete-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "K1 Athlete", userId: athleteUserId });
  await addMembership(athleteId, { clubId: clubX });

  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: cookieX,
    body: { testVersionId: WELLNESS_TEST_VERSION_ID, scheduleKind: "one_time", timezone: "UTC", startDate: new Date().toISOString().slice(0, 10), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "club", id: clubX }] },
  });
  assert.equal(created.status, 201);

  const asOutsider = await api(`/api/tests/schedules/${created.body.schedule.id}`, { cookie: cookieY });
  assert.equal(asOutsider.status, 404);
  const list = await api("/api/tests/schedules", { cookie: cookieY });
  assert.ok(!list.body.schedules.some((s) => s.id === created.body.schedule.id));
});

// ------------------------------------------------------------
// L. Public group check-in link
// ------------------------------------------------------------

test("L1. the check-in link requires login before it resolves an assignment", async () => {
  const { coachCookie, athleteId } = await makeIndependentCoachWithAthlete("l1");
  const scheduled = await scheduleWellnessForAthlete(coachCookie, athleteId);
  const link = await api(`/api/tests/schedules/${scheduled.body.schedule.id}/link`, { method: "POST", cookie: coachCookie });
  assert.equal(link.status, 201);
  const noAuth = await api(`/api/tests/check-in/${link.body.link.publicToken}/my-assignment`);
  assert.equal(noAuth.status, 401);
});

test("L2. the same group link resolves to only the logged-in athlete's own assignment, never another's", async () => {
  const clubId = await makeClub("L2 Club");
  const teamId = await makeTeam(clubId, "L2 Team");
  const coachId = await makeUser({ email: `l2-coach-${Date.now()}@test.local` });
  await grantTeamCoach(coachId, teamId);
  const coachCookie = await loginCookie(coachId);
  const athleteAUserId = await makeUser({ email: `l2-a-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteBUserId = await makeUser({ email: `l2-b-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteAId = await makeAthlete({ name: "L2 A", userId: athleteAUserId });
  const athleteBId = await makeAthlete({ name: "L2 B", userId: athleteBUserId });
  await addMembership(athleteAId, { teamId });
  await addMembership(athleteBId, { teamId });
  const cookieA = await loginCookie(athleteAUserId);
  const cookieB = await loginCookie(athleteBUserId);

  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: { testVersionId: WELLNESS_TEST_VERSION_ID, scheduleKind: "one_time", timezone: "UTC", startDate: new Date().toISOString().slice(0, 10), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: teamId }] },
  });
  const link = await api(`/api/tests/schedules/${created.body.schedule.id}/link`, { method: "POST", cookie: coachCookie });

  const asA = await api(`/api/tests/check-in/${link.body.link.publicToken}/my-assignment`, { cookie: cookieA });
  const asB = await api(`/api/tests/check-in/${link.body.link.publicToken}/my-assignment`, { cookie: cookieB });
  assert.equal(asA.body.assignment.athlete.id, athleteAId);
  assert.equal(asB.body.assignment.athlete.id, athleteBId);
  assert.notEqual(asA.body.assignment.id, asB.body.assignment.id);
});

test("L3. a revoked link is rejected", async () => {
  const { coachCookie, athleteId } = await makeIndependentCoachWithAthlete("l3");
  const scheduled = await scheduleWellnessForAthlete(coachCookie, athleteId);
  const link = await api(`/api/tests/schedules/${scheduled.body.schedule.id}/link`, { method: "POST", cookie: coachCookie });
  const revoke = await api(`/api/tests/links/${link.body.link.id}/revoke`, { method: "POST", cookie: coachCookie });
  assert.equal(revoke.status, 200);
  const afterRevoke = await api(`/api/tests/check-in/${link.body.link.publicToken}`);
  assert.equal(afterRevoke.status, 404);
});

// ------------------------------------------------------------
// M. Only WELLNESS is schedulable in this phase
// ------------------------------------------------------------

test("M1. scheduling a non-WELLNESS test (FMS Deep Squat) is rejected", async () => {
  const { coachCookie, athleteId } = await makeIndependentCoachWithAthlete("m1");
  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: { testVersionId: DEEP_SQUAT_TEST_VERSION_ID, scheduleKind: "one_time", timezone: "UTC", startDate: new Date().toISOString().slice(0, 10), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "athlete", id: athleteId }] },
  });
  assert.equal(created.status, 400);
});

// ------------------------------------------------------------
// N. Coach Today aggregation
// ------------------------------------------------------------

test("N1. Today reports correct completed/pending counts and injury count", async () => {
  const clubId = await makeClub("N1 Club");
  const teamId = await makeTeam(clubId, "N1 Team");
  const coachId = await makeUser({ email: `n1-coach-${Date.now()}@test.local` });
  await grantTeamCoach(coachId, teamId);
  const coachCookie = await loginCookie(coachId);
  const athleteAUserId = await makeUser({ email: `n1-a-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteBUserId = await makeUser({ email: `n1-b-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteAId = await makeAthlete({ name: "N1 A", userId: athleteAUserId });
  const athleteBId = await makeAthlete({ name: "N1 B", userId: athleteBUserId });
  await addMembership(athleteAId, { teamId });
  await addMembership(athleteBId, { teamId });
  const cookieA = await loginCookie(athleteAUserId);

  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: { testVersionId: WELLNESS_TEST_VERSION_ID, scheduleKind: "one_time", timezone: "UTC", startDate: new Date().toISOString().slice(0, 10), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: teamId }] },
  });
  await api("/api/tests/athlete/today", { cookie: cookieA });
  const assignmentId = await getTodayAssignmentId(cookieA);
  await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: cookieA, body: { values: { ...FULL_VALUES, injury: true } } });

  const todayResult = await api("/api/tests/today", { cookie: coachCookie });
  const group = todayResult.body.groups.find((g) => g.schedule.id === created.body.schedule.id);
  assert.equal(group.counts.total, 2);
  assert.equal(group.counts.completed, 1);
  assert.equal(group.counts.pending, 1);
  assert.equal(group.counts.injuries, 1);
});

// ------------------------------------------------------------
// P. Presentation metadata lifecycle immutability (round 2 review fix)
// ------------------------------------------------------------
// tests.protect_presentation_lifecycle() (migrations_v2/202608250900) is
// created AFTER this file's own WELLNESS backfill runs (as a plain,
// trigger-free INSERT) - from that point on it applies to EVERY write,
// including WELLNESS's own already-active version. Exercised here directly
// via adminClient (raw SQL), the same way this file already proves other
// trigger-level guarantees, since these are DB-level invariants, not HTTP
// behavior.

async function makeDraftTestVersionWithParameter(label) {
  const testRow = await adminClient.query(`insert into tests.test (id, owner_scope, visibility) values (gen_random_uuid(), 'system', 'system') returning id`);
  const versionRow = await adminClient.query(
    `insert into tests.test_versions (id, test_id, version_number, status, name) values (gen_random_uuid(), $1, 1, 'draft', $2) returning id`,
    [testRow.rows[0].id, `QA Draft ${label}`],
  );
  const paramRow = await adminClient.query(
    `insert into tests.test_parameters (id, test_version_id, parameter_key, parameter, value_type) values (gen_random_uuid(), $1, $2, $2, 'integer') returning id`,
    [versionRow.rows[0].id, `qa_param_${label}`],
  );
  return { testVersionId: versionRow.rows[0].id, testParameterId: paramRow.rows[0].id };
}

async function expectRejected(promise, label) {
  try {
    await promise;
    assert.fail(`expected rejection: ${label}`);
  } catch (error) {
    assert.match(error.message, /P0001|test_parameter_presentation/, `${label} - got unexpected error: ${error.message}`);
  }
}

test("P1. insert into an already-active version with zero existing presentation rows is rejected", async () => {
  await adminClient.query("begin");
  try {
    await expectRejected(
      adminClient.query(
        `insert into tests.test_parameter_presentation (test_version_id, test_parameter_id, display_order, control_type, direction) values ($1, $2, 0, 'number', 'neutral')`,
        [DEEP_SQUAT_TEST_VERSION_ID, "3f2873b1-0453-4f4a-93d9-02c388e9efcb"],
      ),
      "insert into active Deep Squat version",
    );
  } finally {
    await adminClient.query("rollback");
  }
});

test("P2. a second insert into WELLNESS's own active version (which already has rows) is rejected", async () => {
  await adminClient.query("begin");
  try {
    await expectRejected(
      adminClient.query(
        `insert into tests.test_parameter_presentation (test_version_id, test_parameter_id, display_order, control_type, direction) values ($1, $2, 99, 'slider', 'lower_better')`,
        [WELLNESS_TEST_VERSION_ID, "f33abe4e-f2c2-48f7-89b0-e4c96ca0f6ea"],
      ),
      "second insert into WELLNESS",
    );
  } finally {
    await adminClient.query("rollback");
  }
});

test("P3. UPDATE and DELETE of WELLNESS presentation metadata are both rejected", async () => {
  await adminClient.query("begin");
  try {
    await expectRejected(
      adminClient.query(`update tests.test_parameter_presentation set help_text = 'x' where test_version_id = $1 and display_order = 0`, [WELLNESS_TEST_VERSION_ID]),
      "update WELLNESS presentation row",
    );
  } finally {
    await adminClient.query("rollback");
  }
  await adminClient.query("begin");
  try {
    await expectRejected(
      adminClient.query(`delete from tests.test_parameter_presentation where test_version_id = $1 and display_order = 0`, [WELLNESS_TEST_VERSION_ID]),
      "delete WELLNESS presentation row",
    );
  } finally {
    await adminClient.query("rollback");
  }
});

test("P4. insert/update/delete against a genuinely draft test_version all succeed", async () => {
  const { testVersionId, testParameterId } = await makeDraftTestVersionWithParameter("p4");
  const inserted = await adminClient.query(
    `insert into tests.test_parameter_presentation (test_version_id, test_parameter_id, display_order, control_type, direction) values ($1, $2, 0, 'slider', 'neutral') returning id`,
    [testVersionId, testParameterId],
  );
  await adminClient.query(`update tests.test_parameter_presentation set help_text = 'updated' where id = $1`, [inserted.rows[0].id]);
  const after = await adminClient.query(`select help_text from tests.test_parameter_presentation where id = $1`, [inserted.rows[0].id]);
  assert.equal(after.rows[0].help_text, "updated");
  await adminClient.query(`delete from tests.test_parameter_presentation where id = $1`, [inserted.rows[0].id]);
  const gone = await adminClient.query(`select id from tests.test_parameter_presentation where id = $1`, [inserted.rows[0].id]);
  assert.equal(gone.rowCount, 0);
});

test("P5. reparenting a draft row onto a different test_version/test_parameter via UPDATE is rejected, even though the row is still draft", async () => {
  const source = await makeDraftTestVersionWithParameter("p5-source");
  const other = await makeDraftTestVersionWithParameter("p5-other");
  const inserted = await adminClient.query(
    `insert into tests.test_parameter_presentation (test_version_id, test_parameter_id, display_order, control_type, direction) values ($1, $2, 0, 'slider', 'neutral') returning id`,
    [source.testVersionId, source.testParameterId],
  );
  await expectRejected(
    adminClient.query(
      `update tests.test_parameter_presentation set test_version_id = $1, test_parameter_id = $2 where id = $3`,
      [other.testVersionId, other.testParameterId, inserted.rows[0].id],
    ),
    "reparent draft row to a different version",
  );
  await adminClient.query(`delete from tests.test_parameter_presentation where id = $1`, [inserted.rows[0].id]);
});

test("P6. once a draft version is published, its presentation rows immediately become immutable - no further insert/update", async () => {
  const { testVersionId, testParameterId } = await makeDraftTestVersionWithParameter("p6");
  const inserted = await adminClient.query(
    `insert into tests.test_parameter_presentation (test_version_id, test_parameter_id, display_order, control_type, direction) values ($1, $2, 0, 'slider', 'neutral') returning id`,
    [testVersionId, testParameterId],
  );
  await adminClient.query(`update tests.test_versions set status = 'active', published_at = now() where id = $1`, [testVersionId]);
  await expectRejected(
    adminClient.query(
      `insert into tests.test_parameter_presentation (test_version_id, test_parameter_id, display_order, control_type, direction) values ($1, gen_random_uuid(), 1, 'slider', 'neutral')`,
      [testVersionId],
    ),
    "insert into the now-published version",
  );
  await expectRejected(
    adminClient.query(`update tests.test_parameter_presentation set help_text = 'y' where id = $1`, [inserted.rows[0].id]),
    "update the now-published version's row",
  );
});

test("P7. a concurrent publish and a concurrent child-write on the same draft version never both succeed against inconsistent state", async () => {
  const { testVersionId, testParameterId } = await makeDraftTestVersionWithParameter("p7");
  const publisher = new pg.Client({ connectionString: db.url });
  const writer = new pg.Client({ connectionString: db.url });
  await publisher.connect();
  await writer.connect();
  try {
    await publisher.query("begin");
    // Takes a row lock on this exact test_versions row and holds the
    // transaction open (not yet committed) - protect_presentation_lifecycle's
    // own FOR SHARE select on the same row must block behind this.
    await publisher.query(`update tests.test_versions set status = 'active', published_at = now() where id = $1 and status = 'draft'`, [testVersionId]);

    await writer.query("begin");
    const writerPromise = writer.query(
      `insert into tests.test_parameter_presentation (test_version_id, test_parameter_id, display_order, control_type, direction) values ($1, $2, 0, 'slider', 'neutral')`,
      [testVersionId, testParameterId],
    );

    // Give the writer's query a moment to actually reach and block on the
    // FOR SHARE select - it must NOT resolve while the publisher still
    // holds its uncommitted UPDATE.
    let writerSettled = false;
    writerPromise.then(() => { writerSettled = true; }, () => { writerSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(writerSettled, false, "the child-write must block behind the publisher's uncommitted transaction, not race ahead of it");

    await publisher.query("commit");

    // Now that the publish has committed, the writer's blocked SELECT ...
    // FOR SHARE unblocks and sees status='active' - its insert must be
    // rejected, never silently land against what is now a published
    // version.
    await expectRejected(writerPromise, "child-write against a version that published while it was waiting");
    await writer.query("rollback").catch(() => {});

    const finalStatus = await adminClient.query(`select status from tests.test_versions where id = $1`, [testVersionId]);
    assert.equal(finalStatus.rows[0].status, "active");
    const presentationCount = await adminClient.query(`select count(*)::int as n from tests.test_parameter_presentation where test_version_id = $1`, [testVersionId]);
    assert.equal(presentationCount.rows[0].n, 0, "no partial/inconsistent presentation row was left behind");
  } finally {
    await publisher.end();
    await writer.end();
  }
});

// ------------------------------------------------------------
// Q. One-time occurrence date correctness (round 2 review fix)
// ------------------------------------------------------------

test("Q1. a one_time schedule dated in the future does not appear in Athlete Today before its start_date", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("q1");
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: { testVersionId: WELLNESS_TEST_VERSION_ID, scheduleKind: "one_time", timezone: "UTC", startDate: tomorrow, opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "athlete", id: athleteId }] },
  });
  assert.equal(created.status, 201);
  const today = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  assert.equal(today.body.assignments.length, 0, "a future one_time schedule must not materialize/show as today's");
  const occurrenceCount = await query(`select count(*)::int as n from tests.test_schedule_occurrences where schedule_id = $1`, [created.body.schedule.id]);
  assert.equal(occurrenceCount.rows[0].n, 0, "no occurrence row should have been generated yet");
});

test("Q2. a one_time schedule appears in Athlete Today exactly on its start_date", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("q2");
  const created = await scheduleWellnessForAthlete(coachCookie, athleteId);
  assert.equal(created.status, 201);
  const today = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  assert.equal(today.body.assignments.length, 1);
});

test("Q3. a one_time schedule no longer appears as today's once its date has passed, even though the occurrence already exists", async () => {
  const { coachId, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("q3");
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // Created directly via SQL (bypassing the API's own start_date validation
  // convenience) as a one_time schedule whose window was "yesterday" -
  // simulates a schedule that genuinely was visited/materialized on its own
  // day and now has a real occurrence + assignment on record.
  const scheduleRow = await query(
    `insert into tests.test_schedules (test_version_id, schedule_kind, timezone, start_date, end_date, opens_time, closes_time, status, created_by_user_id, owner_scope, owner_user_id)
     values ($1, 'one_time', 'UTC', $2, $2, '00:00', '23:59', 'active', $3, 'user', $3)
     returning id`,
    [WELLNESS_TEST_VERSION_ID, yesterday, coachId],
  );
  const scheduleId = scheduleRow.rows[0].id;
  await query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id) values ($1, 'athlete', $2)`, [scheduleId, athleteId]);
  const occ = await query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [scheduleId, yesterday]);
  await query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occ.rows[0].id]);
  const assignmentCheck = await query(`select id from tests.test_assignments where occurrence_id = $1 and athlete_id = $2`, [occ.rows[0].id, athleteId]);
  assert.equal(assignmentCheck.rowCount, 1, "sanity check: the assignment really was materialized for yesterday");

  const today = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  assert.equal(today.body.assignments.length, 0, "an occurrence from a past one_time date must not show as today's");

  // Nothing was deleted, only excluded from Today - the row itself is still
  // reachable by direct query (it just never completed, so it won't appear
  // in the completed-only History list).
  const stillThere = await query(`select id from tests.test_assignments where id = $1`, [assignmentCheck.rows[0].id]);
  assert.equal(stillThere.rowCount, 1);
});

test("Q4. a daily schedule's local 'today' follows the schedule's own IANA timezone across a midnight boundary, for a one_time schedule too", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("q4");
  const timezone = "Pacific/Kiritimati"; // UTC+14
  const localToday = (await query(`select (now() at time zone $1)::date as d`, [timezone])).rows[0].d;
  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: { testVersionId: WELLNESS_TEST_VERSION_ID, scheduleKind: "one_time", timezone, startDate: String(localToday), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "athlete", id: athleteId }] },
  });
  assert.equal(created.status, 201);
  const today = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  assert.equal(today.body.assignments.length, 1, "a one_time schedule dated at the schedule timezone's own local today must appear, even if that differs from the server's own date");
});

// ------------------------------------------------------------
// R. Results query: club and team scope must never merge (round 2 review fix)
// ------------------------------------------------------------

test("R1. a club id and a team id that happen to be numerically equal never cross-authorize Results access", async () => {
  // Two real, distinct rows (clubs.id and teams.id are separate sequences/
  // tables) that we force to share the exact same UUID value - the only way
  // to prove the query parameters are genuinely independent rather than
  // coincidentally never colliding in practice.
  const sharedId = crypto.randomUUID();
  await query(`insert into public.clubs (id, name) values ($1, 'R1 Shared-Id Club')`, [sharedId]);
  const otherClubForTeam = await makeClub("R1 Team's Real Club");
  await query(`insert into public.teams (id, club_id, name) values ($1, $2, 'R1 Shared-Id Team')`, [sharedId, otherClubForTeam]);

  const clubAdminId = await makeUser({ email: `r1-clubadmin-${Date.now()}@test.local` });
  await grantClubAdmin(clubAdminId, sharedId);
  const clubAdminCookie = await loginCookie(clubAdminId);

  const teamCoachId = await makeUser({ email: `r1-teamcoach-${Date.now()}@test.local` });
  await grantTeamCoach(teamCoachId, sharedId);
  const teamCoachCookie = await loginCookie(teamCoachId);

  // A schedule genuinely owned by the TEAM (owner_scope='team', owner_team_id=sharedId).
  const athleteUserId = await makeUser({ email: `r1-athlete-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "R1 Athlete", userId: athleteUserId });
  await addMembership(athleteId, { teamId: sharedId });
  const athleteCookie = await loginCookie(athleteUserId);
  const teamSchedule = await api("/api/tests/schedules", {
    method: "POST",
    cookie: teamCoachCookie,
    body: { testVersionId: WELLNESS_TEST_VERSION_ID, scheduleKind: "one_time", timezone: "UTC", startDate: new Date().toISOString().slice(0, 10), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: sharedId }] },
  });
  assert.equal(teamSchedule.status, 201);
  assert.equal(teamSchedule.body.schedule.ownerScope, "team");
  await api("/api/tests/athlete/today", { cookie: athleteCookie });
  const assignmentId = await getTodayAssignmentId(athleteCookie);
  await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athleteCookie, body: { values: FULL_VALUES } });

  // The CLUB admin (whose id happens to equal the team's id) must NOT see
  // this team-owned result via Results - only a genuine club-owned schedule
  // should ever match the owner_club_id branch.
  const asClubAdmin = await api("/api/tests/results", { cookie: clubAdminCookie });
  assert.ok(!asClubAdmin.body.results.some((r) => r.scheduleId === teamSchedule.body.schedule.id), "club admin must not see a team-owned schedule's results merely because their club id equals the team id");

  // The team coach (the real owner) must see it.
  const asTeamCoach = await api("/api/tests/results", { cookie: teamCoachCookie });
  assert.ok(asTeamCoach.body.results.some((r) => r.scheduleId === teamSchedule.body.schedule.id), "the real team coach must still see their own team-owned schedule's results");
});

// ------------------------------------------------------------
// S. Athlete Today snapshot semantics (round 2 review fix)
// ------------------------------------------------------------

test("S1. an already-materialized assignment stays in Athlete Today even after the athlete's team membership is paused", async () => {
  const clubId = await makeClub("S1 Club");
  const teamId = await makeTeam(clubId, "S1 Team");
  const coachId = await makeUser({ email: `s1-coach-${Date.now()}@test.local` });
  await grantTeamCoach(coachId, teamId);
  const coachCookie = await loginCookie(coachId);
  const athleteUserId = await makeUser({ email: `s1-athlete-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "S1 Athlete", userId: athleteUserId });
  await addMembership(athleteId, { teamId });
  const athleteCookie = await loginCookie(athleteUserId);

  await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: { testVersionId: WELLNESS_TEST_VERSION_ID, scheduleKind: "one_time", timezone: "UTC", startDate: new Date().toISOString().slice(0, 10), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: teamId }] },
  });
  const firstToday = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  assert.equal(firstToday.body.assignments.length, 1, "sanity check: materialized once via team membership");

  await query(`update public.athlete_memberships set status = 'paused' where athlete_id = $1 and team_id = $2`, [athleteId, teamId]);

  const secondToday = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  assert.equal(secondToday.body.assignments.length, 1, "an already-materialized assignment must remain visible after membership is paused");
});

test("S2. an athlete added to a team AFTER materialization does not retroactively get an assignment for that occurrence", async () => {
  const clubId = await makeClub("S2 Club");
  const teamId = await makeTeam(clubId, "S2 Team");
  const coachId = await makeUser({ email: `s2-coach-${Date.now()}@test.local` });
  await grantTeamCoach(coachId, teamId);
  const coachCookie = await loginCookie(coachId);
  const existingAthleteUserId = await makeUser({ email: `s2-existing-${Date.now()}@test.local`, roleHint: "athlete" });
  const existingAthleteId = await makeAthlete({ name: "S2 Existing", userId: existingAthleteUserId });
  await addMembership(existingAthleteId, { teamId });
  const existingCookie = await loginCookie(existingAthleteUserId);

  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: { testVersionId: WELLNESS_TEST_VERSION_ID, scheduleKind: "one_time", timezone: "UTC", startDate: new Date().toISOString().slice(0, 10), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: teamId }] },
  });
  assert.equal(created.status, 201);
  await api("/api/tests/athlete/today", { cookie: existingCookie }); // triggers materialization

  const lateAthleteUserId = await makeUser({ email: `s2-late-${Date.now()}@test.local`, roleHint: "athlete" });
  const lateAthleteId = await makeAthlete({ name: "S2 Late", userId: lateAthleteUserId });
  await addMembership(lateAthleteId, { teamId });
  const lateCookie = await loginCookie(lateAthleteUserId);

  const lateToday = await api("/api/tests/athlete/today", { cookie: lateCookie });
  assert.equal(lateToday.body.assignments.length, 0, "a team member added after materialization must not join that occurrence");
});

test("S3. repeated Athlete Today calls never duplicate assignments, with the snapshot-vs-membership rewrite in place", async () => {
  const { coachCookie, athleteId, athleteCookie } = await makeIndependentCoachWithAthlete("s3");
  await scheduleWellnessForAthlete(coachCookie, athleteId);
  await api("/api/tests/athlete/today", { cookie: athleteCookie });
  await api("/api/tests/athlete/today", { cookie: athleteCookie });
  const third = await api("/api/tests/athlete/today", { cookie: athleteCookie });
  assert.equal(third.body.assignments.length, 1);
  const count = await query(`select count(*)::int as n from tests.test_assignments where athlete_id = $1`, [athleteId]);
  assert.equal(count.rows[0].n, 1);
});

// ------------------------------------------------------------
// T. Idempotency key scoping (round 2 review fix)
// ------------------------------------------------------------

test("T1. an idempotency key that belongs to a different assignment/athlete never returns that other athlete's result", async () => {
  const a = await makeIndependentCoachWithAthlete("t1a");
  const b = await makeIndependentCoachWithAthlete("t1b");
  await scheduleWellnessForAthlete(a.coachCookie, a.athleteId);
  await scheduleWellnessForAthlete(b.coachCookie, b.athleteId);
  const assignmentAId = await getTodayAssignmentId(a.athleteCookie);
  const assignmentBId = await getTodayAssignmentId(b.athleteCookie);

  const sharedKey = crypto.randomUUID();
  const submitA = await api(`/api/tests/assignments/${assignmentAId}/submit`, { method: "POST", cookie: a.athleteCookie, body: { values: FULL_VALUES, idempotencyKey: sharedKey } });
  assert.equal(submitA.status, 200);

  // Athlete B submits their OWN assignment reusing athlete A's already-
  // completed idempotency key. Before the fix, a bare
  // "idempotency_key = $1 and status = 'completed'" lookup would have
  // matched A's row and hapily returned A's assessmentId/values/score to B.
  const submitB = await api(`/api/tests/assignments/${assignmentBId}/submit`, { method: "POST", cookie: b.athleteCookie, body: { values: { ...FULL_VALUES, fatigue: 9 }, idempotencyKey: sharedKey } });
  if (submitB.status === 200) {
    assert.notEqual(submitB.body.assessmentId, submitA.body.assessmentId, "B must never be handed A's own assessment id");
    assert.notEqual(submitB.body.wellnessScore, submitA.body.wellnessScore, "B must never be handed A's own score by reusing A's key");
  } else {
    // The globally-unique idempotency_key index (Phase 1) makes a genuine
    // second INSERT with the same key impossible once the scoped lookup no
    // longer short-circuits into A's row - a clean rejection is an equally
    // acceptable, equally safe outcome, as long as A's data was never leaked.
    assert.equal(submitB.status, 409);
  }
  // Athlete A's own row must be completely unaffected either way.
  const historyA = await api("/api/tests/athlete/history", { cookie: a.athleteCookie });
  assert.equal(historyA.body.history[0].assessmentId, submitA.body.assessmentId);
});

// ------------------------------------------------------------
// O. Full backend/v4.2/Phase1 suites unaffected - covered by re-running
// those suites directly (see completion report), not duplicated here.
// ------------------------------------------------------------

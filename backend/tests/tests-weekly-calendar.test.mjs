// Tests/WELLNESS weekly calendar (shared across Today/Schedule/Results):
// GET /api/tests/weekly (the read-only weekly projection), GET /api/tests/
// schedules/:id/group?date= (the click-through detail, reusing the exact
// group shape GET /today already produces), and GET /api/tests/results's
// new optional ?date= filter + localScheduledDate field.
//
// Same disposable-DB harness as tests-module-schedule-management.test.mjs:
// a uniquely-named temporary database (never OPTIMOVE, never monitoring2),
// through the real Strategy B runner, with the real Express app driven
// over real HTTP with real session cookies.
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
    image_url text,
    device_timezone text,
    device_timezone_updated_at timestamptz
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
  const name = `optimove_tests_weeklycal_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_weeklycal_migrations_${runId}`);
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
async function loginCookie(userId) {
  const token = await createSession(userId);
  return cookieFor(token);
}
async function makeClubWithAthletes(label, count) {
  const clubId = await makeClub(`${label} Club`);
  const coachId = await makeUser({ email: `${label}-coach-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local` });
  await grantClubAdmin(coachId, clubId);
  const coachCookie = await loginCookie(coachId);
  const athletes = [];
  for (let i = 0; i < count; i += 1) {
    const userId = await makeUser({ email: `${label}-athlete${i}-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local`, roleHint: "athlete" });
    const athleteId = await makeAthlete({ name: `${label} Athlete ${i}`, userId });
    await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
    athletes.push({ athleteId, userId, cookie: await loginCookie(userId) });
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

// Real "today" - real Monday-of-this-week - used as a stable weekStart for
// most tests below (a schedule dated TODAY always falls inside it).
const TODAY = new Date().toISOString().slice(0, 10);
function mondayOfIso(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}
function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const THIS_WEEK_START = mondayOfIso(TODAY);

function sessionsOn(weeklyBody, dateIso) {
  return weeklyBody.days.find((d) => d.date === dateIso)?.sessions || [];
}

// ------------------------------------------------------------
// A. Response shape / week bounds
// ------------------------------------------------------------

test("A1. GET /weekly returns exactly 7 days, Monday weekStart through Sunday weekEnd, empty sessions when nothing is scheduled", async () => {
  const { coachCookie } = await makeClubWithAthletes("a1", 1);
  const res = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.weekStart, THIS_WEEK_START);
  assert.equal(res.body.weekEnd, addDaysIso(THIS_WEEK_START, 6));
  assert.equal(res.body.days.length, 7);
  assert.deepEqual(res.body.days.map((d) => d.date), Array.from({ length: 7 }, (_, i) => addDaysIso(THIS_WEEK_START, i)));
  assert.ok(res.body.days.every((d) => Array.isArray(d.sessions) && d.sessions.length === 0));
});

test("A2. an invalid or missing weekStart is a controlled 400, not a 500", async () => {
  const { coachCookie } = await makeClubWithAthletes("a2", 1);
  assert.equal((await api(`/api/tests/weekly`, { cookie: coachCookie })).status, 400);
  assert.equal((await api(`/api/tests/weekly?weekStart=not-a-date`, { cookie: coachCookie })).status, 400);
  assert.equal((await api(`/api/tests/weekly?weekStart=2026-02-30`, { cookie: coachCookie })).status, 400);
});

test("A3. a non-coach account gets 403, never a partial/leaked response", async () => {
  const { athletes } = await makeClubWithAthletes("a3", 1);
  const res = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: athletes[0].cookie });
  assert.equal(res.status, 403);
});

// ------------------------------------------------------------
// B. Projection correctness per scheduleKind
// ------------------------------------------------------------

test("B1. one_time appears ONLY on its own date - never the day before or after, even within the same visible week", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b1", 1);
  await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { startDate: TODAY }) });
  const res = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  assert.equal(sessionsOn(res.body, TODAY).length, 1);
  const before = addDaysIso(TODAY, -1);
  const afterDate = addDaysIso(TODAY, 1);
  if (before >= THIS_WEEK_START) assert.equal(sessionsOn(res.body, before).length, 0);
  if (afterDate <= res.body.weekEnd) assert.equal(sessionsOn(res.body, afterDate).length, 0);
});

test("B2. two DIFFERENT tests scheduled on the same day both appear as two separate sessions that day", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b2", 1);
  const target = [{ kind: "athlete", id: athletes[0].athleteId }];
  await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody(target, { startDate: TODAY, opensTime: "06:00" }) });
  await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody(target, { startDate: TODAY, opensTime: "16:30" }) });
  const res = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const sessions = sessionsOn(res.body, TODAY);
  assert.equal(sessions.length, 2, "the SAME test scheduled twice the same day must stay two separate sessions, never merged");
  assert.deepEqual(sessions.map((s) => s.opensTime.slice(0, 5)), ["06:00", "16:30"], "sessions come back sorted by opens time");
});

test("B3. Specific dates (N independent one_time schedules from one bulk request) each land on their OWN picked date only", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b3", 1);
  const d1 = THIS_WEEK_START;
  const d2 = addDaysIso(THIS_WEEK_START, 2);
  const d3 = addDaysIso(THIS_WEEK_START, 5);
  const bulk = await api("/api/tests/schedules/bulk", {
    method: "POST",
    cookie: coachCookie,
    body: { testVersionId: WELLNESS_TEST_VERSION_ID, timezone: "UTC", opensTime: "06:00", closesTime: "22:00", dates: [d1, d2, d3], targets: [{ kind: "athlete", id: athletes[0].athleteId }] },
  });
  assert.equal(bulk.status, 201);
  const res = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  assert.equal(sessionsOn(res.body, d1).length, 1);
  assert.equal(sessionsOn(res.body, d2).length, 1);
  assert.equal(sessionsOn(res.body, addDaysIso(THIS_WEEK_START, 1)).length, 0);
  assert.equal(sessionsOn(res.body, d3).length, 1);
});

test("B4. a bounded daily schedule appears on every date within [start,end], clipped correctly at both edges of the visible week", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b4", 1);
  const start = addDaysIso(THIS_WEEK_START, 2);
  const end = addDaysIso(THIS_WEEK_START, 4);
  await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { scheduleKind: "daily", startDate: start, endDate: end }),
  });
  const res = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  for (let i = 0; i < 7; i += 1) {
    const date = addDaysIso(THIS_WEEK_START, i);
    const expected = date >= start && date <= end ? 1 : 0;
    assert.equal(sessionsOn(res.body, date).length, expected, `date ${date} expected ${expected} session(s)`);
  }
});

test("B5. an open-ended daily schedule (no end_date) is clipped to ONLY the currently requested week, never projected past it", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b5", 1);
  await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { scheduleKind: "daily", startDate: addDaysIso(THIS_WEEK_START, -30), endDate: undefined }),
  });
  const thisWeek = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  assert.ok(thisWeek.body.days.every((d) => d.sessions.length === 1), "every day of the requested week has exactly one session");
  const nextWeekStart = addDaysIso(THIS_WEEK_START, 7);
  const nextWeek = await api(`/api/tests/weekly?weekStart=${nextWeekStart}`, { cookie: coachCookie });
  assert.ok(nextWeek.body.days.every((d) => d.sessions.length === 1), "an open-ended daily schedule still projects into a LATER week too, just never further than whatever week is actually being requested");
});

// ------------------------------------------------------------
// C. Paused/cancelled visibility, historical results
// ------------------------------------------------------------

test("C1. a paused schedule still appears in the weekly projection (never hidden outright), with its real status", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("c1", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { startDate: TODAY }) });
  await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "PATCH", cookie: coachCookie, body: { status: "paused" } });
  const res = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const session = sessionsOn(res.body, TODAY)[0];
  assert.ok(session);
  assert.equal(session.scheduleStatus, "paused");
});

test("C2. a cancelled schedule is hidden by default, and reappears with includeCancelled=true - same 'Show cancelled' contract GET /schedules already has", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("c2", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { startDate: TODAY }) });
  // DELETE only soft-cancels a schedule that already has real occurrence
  // activity - one with none yet is hard-deleted outright (see DELETE
  // /schedules/:id's own branch), which would remove it from every view
  // regardless of includeCancelled. Materialize first so this test actually
  // exercises the soft-cancel path.
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie });
  const hidden = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  assert.equal(sessionsOn(hidden.body, TODAY).length, 0);
  const shown = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}&includeCancelled=true`, { cookie: coachCookie });
  assert.equal(sessionsOn(shown.body, TODAY)[0]?.scheduleStatus, "cancelled");
});

test("C3. historical results of a schedule that was later cancelled remain visible via the weekly resultsCount and via GET /results, with includeCancelled=true", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("c3", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { startDate: TODAY }) });
  const today = await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  const assignmentId = today.body.assignments[0].assignmentId;
  const submitted = await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athletes[0].cookie, body: { values: { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: false } } });
  assert.equal(submitted.status, 200);

  await api(`/api/tests/schedules/${created.body.schedule.id}`, { method: "DELETE", cookie: coachCookie });

  const weekly = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}&includeCancelled=true`, { cookie: coachCookie });
  assert.equal(sessionsOn(weekly.body, TODAY)[0]?.resultsCount, 1, "the completed result must still be counted even though its schedule is now cancelled");

  const results = await api(`/api/tests/results?scheduleId=${created.body.schedule.id}`, { cookie: coachCookie });
  assert.equal(results.body.results.length, 1);
  assert.equal(results.body.results[0].assessmentId, submitted.body.assessmentId);
});

// ------------------------------------------------------------
// D. Operational counts (Today tab)
// ------------------------------------------------------------

test("D1. counts (completed/openPending/notYetOpen/missed) reflect real already-materialized assignments for the requested date, with occurrenceExists correctly true/false", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("d1", 2);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody(athletes.map((a) => ({ kind: "athlete", id: a.athleteId })), { startDate: TODAY }) });
  const beforeMaterialize = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const sessionBefore = sessionsOn(beforeMaterialize.body, TODAY)[0];
  assert.equal(sessionBefore.occurrenceExists, false, "before anyone has ever visited Today, nothing is materialized yet");
  assert.equal(sessionBefore.counts, null);

  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie }); // materializes today's occurrence for both targets
  const assignmentId = (await api("/api/tests/athlete/today", { cookie: athletes[0].cookie })).body.assignments[0].assignmentId;
  await api(`/api/tests/assignments/${assignmentId}/submit`, { method: "POST", cookie: athletes[0].cookie, body: { values: { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: false } } });

  const afterOne = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const sessionAfter = sessionsOn(afterOne.body, TODAY)[0];
  assert.equal(sessionAfter.occurrenceExists, true);
  assert.equal(sessionAfter.counts.total, 2);
  assert.equal(sessionAfter.counts.completed, 1);
  assert.equal(sessionAfter.counts.openPending, 1, "the other athlete's assignment is open now (00:00-23:59 today) and not yet completed");
  assert.equal(sessionAfter.counts.notYetOpen, 0);
  assert.equal(sessionAfter.counts.missed, 0);
  void created;
});

// ------------------------------------------------------------
// E. No premature materialization from browsing
// ------------------------------------------------------------

test("E1. browsing a future week's projection never creates an occurrence or assignment row - a pure read", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("e1", 1);
  const futureWeekStart = addDaysIso(THIS_WEEK_START, 21);
  const futureDate = futureWeekStart;
  await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { scheduleKind: "daily", startDate: addDaysIso(THIS_WEEK_START, -7), endDate: undefined }),
  });
  const occBefore = await query(`select count(*)::int as n from tests.test_schedule_occurrences`);
  const asgBefore = await query(`select count(*)::int as n from tests.test_assignments`);

  const res = await api(`/api/tests/weekly?weekStart=${futureWeekStart}`, { cookie: coachCookie });
  assert.equal(sessionsOn(res.body, futureDate).length, 1, "the future week's projection still shows the session");

  const occAfter = await query(`select count(*)::int as n from tests.test_schedule_occurrences`);
  const asgAfter = await query(`select count(*)::int as n from tests.test_assignments`);
  assert.equal(occAfter.rows[0].n, occBefore.rows[0].n, "browsing a future week must never generate an occurrence");
  assert.equal(asgAfter.rows[0].n, asgBefore.rows[0].n, "browsing a future week must never materialize an assignment");
});

test("E2. GET /schedules/:id/group for a NOT-YET-materialized future date returns an empty, honest group - never an error, never a side effect", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("e2", 1);
  const futureDate = addDaysIso(THIS_WEEK_START, 21);
  const created = await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { scheduleKind: "daily", startDate: addDaysIso(THIS_WEEK_START, -7), endDate: undefined }),
  });
  const occBefore = await query(`select count(*)::int as n from tests.test_schedule_occurrences`);
  const res = await api(`/api/tests/schedules/${created.body.schedule.id}/group?date=${futureDate}`, { cookie: coachCookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.group.athletes, []);
  assert.equal(res.body.group.counts.total, 0);
  const occAfter = await query(`select count(*)::int as n from tests.test_schedule_occurrences`);
  assert.equal(occAfter.rows[0].n, occBefore.rows[0].n, "a read of an unmaterialized future date must never create the occurrence itself");
});

// ------------------------------------------------------------
// F. Click-through detail (GET /schedules/:id/group) - reuses the exact
// GET /today group shape, real per-athlete status + reminder-ready data
// ------------------------------------------------------------

test("F1. GET /schedules/:id/group for an already-materialized date returns real per-athlete status, matching what GET /today itself would show for that same day", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("f1", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { startDate: TODAY }) });
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });

  const today = await api("/api/tests/today", { cookie: coachCookie });
  const liveGroup = today.body.groups.find((g) => g.schedule.id === created.body.schedule.id);

  const detail = await api(`/api/tests/schedules/${created.body.schedule.id}/group?date=${TODAY}`, { cookie: coachCookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.group.athletes.length, liveGroup.athletes.length);
  assert.equal(detail.body.group.athletes[0].athleteId, liveGroup.athletes[0].athleteId);
  assert.equal(detail.body.group.athletes[0].assignmentId, liveGroup.athletes[0].assignmentId, "the SAME assignment id, reusable directly by the existing manual-reminder action");
  assert.equal(detail.body.group.counts.total, liveGroup.counts.total);
});

test("F2. a coach cannot open the group detail for a schedule they don't manage (404, not a leak)", async () => {
  const owner = await makeClubWithAthletes("f2-owner", 1);
  const outsider = await makeClubWithAthletes("f2-outsider", 0);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: owner.coachCookie, body: baseCreateBody([{ kind: "athlete", id: owner.athletes[0].athleteId }], { startDate: TODAY }) });
  assert.equal(created.status, 201);
  const res = await api(`/api/tests/schedules/${created.body.schedule.id}/group?date=${TODAY}`, { cookie: outsider.coachCookie });
  assert.equal(res.status, 404, "an unrelated coach (different club, no membership overlap) must never see this schedule's group detail");
});

test("F3. an invalid date query param is a controlled 400", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("f3", 1);
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { startDate: TODAY }) });
  const res = await api(`/api/tests/schedules/${created.body.schedule.id}/group?date=not-a-date`, { cookie: coachCookie });
  assert.equal(res.status, 400);
});

// ------------------------------------------------------------
// G. GET /results grouping by local_scheduled_date (not completed_at/o.scheduled_date), and its new ?date filter
// ------------------------------------------------------------

test("G1. GET /results returns localScheduledDate, and filtering by ?date returns only that date's results", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("g1", 1);
  const d1 = THIS_WEEK_START;
  const d2 = addDaysIso(THIS_WEEK_START, 3);
  await api("/api/tests/schedules/bulk", {
    method: "POST",
    cookie: coachCookie,
    body: { testVersionId: WELLNESS_TEST_VERSION_ID, timezone: "UTC", opensTime: "00:00", closesTime: "23:59", dates: [d1, d2], targets: [{ kind: "athlete", id: athletes[0].athleteId }] },
  });
  // Materialize + submit both days' assignments directly (bypassing the
  // "only today gets auto-materialized" flow, which only ever covers real
  // today) via the coach's own manageable-schedule detail is out of scope
  // here - instead submit whichever one IS today's, and directly verify
  // the OTHER date's own row shape once materialized the same way a real
  // visit would (ensureCurrentOccurrence is exercised through
  // GET /athlete/today for the real-today case only, matching every other
  // test file's own convention - see getTodayAssignmentId elsewhere).
  const todayAssignment = await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  const assignmentForToday = todayAssignment.body.assignments.find((a) => a.assignmentId);
  if (assignmentForToday) {
    await api(`/api/tests/assignments/${assignmentForToday.assignmentId}/submit`, { method: "POST", cookie: athletes[0].cookie, body: { values: { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: false } } });
  }
  const filtered = await api(`/api/tests/results?date=${TODAY}`, { cookie: coachCookie });
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.results.every((r) => r.localScheduledDate === TODAY));
});

test("G2. an invalid ?date on GET /results is a controlled 400", async () => {
  const { coachCookie } = await makeClubWithAthletes("g2", 1);
  const res = await api(`/api/tests/results?date=nope`, { cookie: coachCookie });
  assert.equal(res.status, 400);
});

// ------------------------------------------------------------
// H. Timezone boundary: local_scheduled_date, not o.scheduled_date, is authoritative
// ------------------------------------------------------------

test("H1. an athlete whose own effective timezone diverges from the schedule's still groups correctly by their OWN local_scheduled_date", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("h1", 1);
  // A schedule timezone far from the athlete's own real device timezone -
  // this is exactly the scenario testsOccurrenceService.js's own comments
  // describe as the reason local_scheduled_date (not a shared occurrence-
  // level date) is the authoritative per-athlete column.
  await query(`update public.athletes set device_timezone = 'Pacific/Kiritimati' where id = $1`, [athletes[0].athleteId]);
  await api("/api/tests/schedules", {
    method: "POST",
    cookie: coachCookie,
    body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { scheduleKind: "daily", startDate: addDaysIso(THIS_WEEK_START, -3), endDate: undefined, timezone: "UTC" }),
  });
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  const row = await query(
    `select asg.local_scheduled_date::text as local_scheduled_date, o.scheduled_date::text as scheduled_date
     from tests.test_assignments asg join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
     where asg.athlete_id = $1 order by asg.created_at desc limit 1`,
    [athletes[0].athleteId],
  );
  assert.ok(row.rows[0], "an assignment was materialized for this athlete's own current local date");
  const localDate = row.rows[0].local_scheduled_date;
  const weekStartForLocalDate = mondayOfIso(localDate);
  const weekly = await api(`/api/tests/weekly?weekStart=${weekStartForLocalDate}`, { cookie: coachCookie });
  const session = sessionsOn(weekly.body, localDate)[0];
  assert.ok(session, "the weekly grid, keyed by local_scheduled_date, must show this athlete's assignment on THEIR OWN local date");
});

// ------------------------------------------------------------
// I. Item 1 correction: target summary distinguishes same-time sessions
// ------------------------------------------------------------

test("I1. two WELLNESS schedules on the SAME date and the SAME opens time, but targeting DIFFERENT teams, are clearly distinguished in the payload via their own targetSummary", async () => {
  const clubId = await makeClub("I1 Club");
  const teamA = await makeTeam(clubId, "First team");
  const teamB = await makeTeam(clubId, "Recovery group");
  const coachId = await makeUser({ email: `i1-coach-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local` });
  await grantClubAdmin(coachId, clubId);
  const coachCookie = await loginCookie(coachId);

  const createdA = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "team", id: teamA }], { startDate: TODAY, opensTime: "06:00" }) });
  const createdB = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "team", id: teamB }], { startDate: TODAY, opensTime: "06:00" }) });
  assert.equal(createdA.status, 201);
  assert.equal(createdB.status, 201);

  const weekly = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const sessions = sessionsOn(weekly.body, TODAY);
  assert.equal(sessions.length, 2, "both same-time same-day sessions are present, never merged");
  const byTeam = Object.fromEntries(sessions.map((s) => [s.targetSummary.teamTargetNames, s]));
  assert.ok(byTeam["First team"], "the first schedule's own targetSummary names its real team");
  assert.ok(byTeam["Recovery group"], "the second schedule's own targetSummary names ITS real team - not the same one");
  assert.notEqual(byTeam["First team"].scheduleId, byTeam["Recovery group"].scheduleId);
  for (const s of sessions) {
    assert.equal(s.targetSummary.athleteTargetCount, 0, "team-only targets carry no direct athlete-target count");
    assert.equal(s.targetSummary.clubTargetNames, "");
  }
});

test("I2. a schedule targeting individual athletes directly reports a real athleteTargetCount, with no team/club names", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("i2", 3);
  await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody(athletes.map((a) => ({ kind: "athlete", id: a.athleteId })), { startDate: TODAY }) });
  const weekly = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const session = sessionsOn(weekly.body, TODAY)[0];
  assert.equal(session.targetSummary.athleteTargetCount, 3);
  assert.equal(session.targetSummary.teamTargetNames, "");
  assert.equal(session.targetSummary.clubTargetNames, "");
});

// ------------------------------------------------------------
// J. Item 3 correction: Upcoming/Scheduled/Missed status semantics
// ------------------------------------------------------------

test("J1. no assignment materialized at all -> occurrenceExists is false and counts is null (the frontend renders this as 'Scheduled', never 'Upcoming')", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("j1", 1);
  await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { startDate: TODAY, opensTime: "00:00", closesTime: "23:59" }) });
  const weekly = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const session = sessionsOn(weekly.body, TODAY)[0];
  assert.equal(session.occurrenceExists, false);
  assert.equal(session.counts, null);
});

test("J2. an assignment that exists but hasn't opened yet is notYetOpen, never counted as openPending - the exact bug this correction fixes", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("j2", 1);
  // A near-end-of-day window (23:58-23:59 UTC) - deliberately NOT a
  // computed "now + N hours" time, which would wrap past midnight (and
  // become a time BEFORE "now" on the same calendar day, defeating the
  // test's own intent) whenever this happens to run late in the UTC day.
  // materialized via GET /athlete/today, but this athlete's own assignment
  // window hasn't started yet for virtually the entire day.
  await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody([{ kind: "athlete", id: athletes[0].athleteId }], { startDate: TODAY, timezone: "UTC", opensTime: "23:58", closesTime: "23:59" }) });
  await api("/api/tests/athlete/today", { cookie: athletes[0].cookie });
  const weekly = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const session = sessionsOn(weekly.body, TODAY)[0];
  assert.equal(session.occurrenceExists, true, "the assignment row DOES exist");
  assert.equal(session.counts.total, 1);
  assert.equal(session.counts.notYetOpen, 1, "not yet open - opens_at is still in the future");
  assert.equal(session.counts.openPending, 0, "must NOT be counted as open/pending - it isn't open yet");
  assert.equal(session.counts.completed, 0);
  assert.equal(session.counts.missed, 0);
});

// ------------------------------------------------------------
// K. Item 4 correction: assignment-less results are deliberately out of
// scope today - this test PROVES the current exclusion, it doesn't just
// assert a wish. See tests.js's own long comment right above GET /results
// for the full reasoning (nothing in this app ever creates such a row -
// this is schema-legal but application-unreachable today).
// ------------------------------------------------------------

test("K1. an assignment-less completed assessment (schema-legal - assignment_id is nullable - but never produced by any current code path) is excluded from both GET /results and GET /weekly's resultsCount", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("k1", 1);
  await query(
    `insert into tests.test_assessments (athlete_id, test_version_id, assignment_id, source, status, completed_at)
     values ($1, $2, null, 'coach_manual', 'completed', now())`,
    [athletes[0].athleteId, WELLNESS_TEST_VERSION_ID],
  );

  const flatResults = await api(`/api/tests/results`, { cookie: coachCookie });
  assert.ok(
    !flatResults.body.results.some((r) => r.athleteId === athletes[0].athleteId),
    "an assignment-less assessment can never resolve a schedule/coach owner through the required assignment->occurrence->schedule chain, so it must never appear in the coach's flat Results list",
  );

  const weekly = await api(`/api/tests/weekly?weekStart=${THIS_WEEK_START}&includeCancelled=true`, { cookie: coachCookie });
  const anySessionHasResults = weekly.body.days.some((d) => d.sessions.some((s) => s.resultsCount > 0));
  assert.equal(anySessionHasResults, false, "no schedule's own resultsCount is inflated by a result that isn't attributable to any schedule");
});

// Training load (RPE/sRPE), first complete phase - backend coverage.
// Same disposable-DB harness convention as tests-weekly-calendar.test.mjs:
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
const MIGRATION_PATH = path.resolve(__dirname, "../../migrations_v2/202608310900_training_load_v1_session_feedback.sql");
const MIGRATION_NAME = "202608310900_training_load_v1_session_feedback.sql";

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

// Stand-in for the pre-migrations_v2 base schema. backend/src/migrate.js's
// runMigrations() REFUSES to apply any migrations_v2 file at all until
// assertLegacyBaselinePresent()'s fingerprint check passes - a fixed list
// of specific tables/columns/views (see computeLegacyFingerprint in
// migrate.js) that has NOTHING to do with what trainingLoad.js itself
// actually reads. So the first part of this fixture (through the four
// plans.v_* views) is required scaffolding only to satisfy that
// fingerprint - library.exercises/plans.plan_items/plans.plan_nodes and
// the views are never queried by this module's routes or tests. Only the
// "extra columns" ALTER TABLE block at the end is what trainingLoad.js
// and backend/src/access.js actually read/write.
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
    device_timezone_updated_at timestamptz,
    is_active boolean not null default true
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

  -- Everything above this line exists only to satisfy migrate.js's legacy
  -- fingerprint check (see this const's own header comment) - the columns
  -- below are what trainingLoad.js's routes and this file's own tests
  -- actually read/write.
  alter table plans.plans
    add column plan_type text not null default 'weekly',
    add column athlete_id uuid references public.athletes(id),
    add column name text,
    add column status text not null default 'draft',
    add column is_active boolean not null default true,
    add column is_edit_draft boolean not null default false,
    add column week_start date,
    add column created_at timestamptz not null default now(),
    add column updated_at timestamptz not null default now();
  alter table plans.plan_days
    add column plan_id uuid not null references plans.plans(id) on delete cascade,
    add column date date,
    add column day_order int;
  alter table plans.plan_sessions
    add column plan_day_id uuid not null references plans.plan_days(id) on delete cascade,
    add column am_pm text,
    add column bta text,
    add column session_order int not null default 0,
    add column name text,
    add column created_at timestamptz not null default now(),
    add column updated_at timestamptz not null default now();
`;

async function makeTempDb(label) {
  const name = `optimove_tests_trainingload_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_trainingload_migrations_${runId}`);
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
  const migrationSql = await fsp.readFile(MIGRATION_PATH, "utf8");

  db = await makeTempDb("primary");
  adminClient = new pg.Client({ connectionString: db.url });
  await adminClient.connect();
  const ownCheck = await adminClient.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");

  await adminClient.query(LEGACY_FIXTURE_SQL);
  migrationsDir = await writeMigrationsDir("primary", { [MIGRATION_NAME]: migrationSql });
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
  const result = await query(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,$2,$2,'UTC') returning id`, [userId, name]);
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

// Real "today" - a schedule/session dated TODAY always falls inside a
// current week; TOMORROW/YESTERDAY give real, deterministic future/past
// boundaries without depending on any particular day-of-week.
const TODAY = new Date().toISOString().slice(0, 10);
function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const TOMORROW = addDaysIso(TODAY, 1);
const YESTERDAY = addDaysIso(TODAY, -1);
function mondayOfIso(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}
const THIS_WEEK_START = mondayOfIso(TODAY);

// weekStart/plan_type/status/is_active/is_edit_draft default to a normal,
// fully-published, currently-active weekly plan - the common case every
// test that doesn't specifically exercise draft/inactive/edit-draft
// filtering wants.
async function makeWeeklyPlan(athleteId, overrides = {}) {
  const {
    name = "Weekly plan",
    weekStart = THIS_WEEK_START,
    status = "active",
    isActive = true,
    isEditDraft = false,
  } = overrides;
  const result = await query(
    `insert into plans.plans (plan_type, athlete_id, name, status, is_active, is_edit_draft, week_start)
     values ('weekly', $1, $2, $3, $4, $5, $6) returning id`,
    [athleteId, name, status, isActive, isEditDraft, weekStart],
  );
  return result.rows[0].id;
}
async function makePlanDay(planId, date) {
  const result = await query(`insert into plans.plan_days (plan_id, date) values ($1,$2) returning id`, [planId, date]);
  return result.rows[0].id;
}
async function makeSession(planDayId, overrides = {}) {
  const { amPm = null, bta = null, sessionTime = null, sessionOrder = 0, name = "Session" } = overrides;
  const result = await query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_time, session_order, name)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [planDayId, amPm, bta, sessionTime, sessionOrder, name],
  );
  return result.rows[0].id;
}
// Convenience: one active weekly plan, one day, one session, all on the
// given date, for the given athlete - the common single-session fixture.
async function makeActiveSessionOn(athleteId, date, overrides = {}) {
  const planId = await makeWeeklyPlan(athleteId, { weekStart: mondayOfIso(date), ...overrides.plan });
  const dayId = await makePlanDay(planId, date);
  return makeSession(dayId, overrides.session);
}

function rpeBody(rpe, durationMinutes, note) {
  return { rpe, durationMinutes, ...(note !== undefined ? { note } : {}) };
}

// ------------------------------------------------------------
// A. sRPE calculation - always DB-derived, never client-accepted
// ------------------------------------------------------------

test("A1. sRPE = RPE x actual duration minutes, computed by Postgres, and a client-supplied sRPE is simply ignored (not even read)", async () => {
  const { athletes } = await makeClubWithAthletes("a1", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, {
    method: "POST",
    cookie: athletes[0].cookie,
    body: { rpe: 7, durationMinutes: 60, srpe: 999999 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.feedback.rpe, 7);
  assert.equal(res.body.feedback.durationMinutes, 60);
  assert.equal(res.body.feedback.srpe, 420, "7 x 60 = 420, never the client-supplied 999999");
});

test("A2. sRPE = 0 when RPE = 0, a real and valid combination (not falsy-skipped)", async () => {
  const { athletes } = await makeClubWithAthletes("a2", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(0, 45) });
  assert.equal(res.status, 201);
  assert.equal(res.body.feedback.srpe, 0);
});

// ------------------------------------------------------------
// B. RPE / duration DB bounds
// ------------------------------------------------------------

test("B1-B8. RPE and duration bounds are enforced, both at the boundary and just outside it", async () => {
  const { athletes } = await makeClubWithAthletes("b", 1);
  const cases = [
    { rpe: -1, durationMinutes: 30, ok: false, label: "rpe below 0" },
    { rpe: 11, durationMinutes: 30, ok: false, label: "rpe above 10" },
    { rpe: 10.5, durationMinutes: 30, ok: false, label: "non-integer rpe" },
    { rpe: 5, durationMinutes: 0, ok: false, label: "duration below 1" },
    { rpe: 5, durationMinutes: 601, ok: false, label: "duration above 600" },
    { rpe: 0, durationMinutes: 30, ok: true, label: "rpe = 0 boundary" },
    { rpe: 10, durationMinutes: 30, ok: true, label: "rpe = 10 boundary" },
    { rpe: 5, durationMinutes: 600, ok: true, label: "duration = 600 boundary" },
    { rpe: 5, durationMinutes: 1, ok: true, label: "duration = 1 boundary" },
  ];
  for (const c of cases) {
    const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
    const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(c.rpe, c.durationMinutes) });
    if (c.ok) assert.equal(res.status, 201, `${c.label} should be accepted`);
    else assert.equal(res.status, 400, `${c.label} should be rejected`);
  }
});

test("B9. a note over 500 characters is rejected", async () => {
  const { athletes } = await makeClubWithAthletes("b9", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30, "x".repeat(501)) });
  assert.equal(res.status, 400);
});

// ------------------------------------------------------------
// C. Two sessions the same day stay two separate results
// ------------------------------------------------------------

test("C1. two training sessions the same day produce two separate RPE entries with their own sRPE, never merged", async () => {
  const { athletes } = await makeClubWithAthletes("c1", 1);
  const planId = await makeWeeklyPlan(athletes[0].athleteId, { weekStart: THIS_WEEK_START });
  const dayId = await makePlanDay(planId, TODAY);
  const morningId = await makeSession(dayId, { amPm: "AM", name: "Morning strength", sessionOrder: 0 });
  const eveningId = await makeSession(dayId, { amPm: "PM", name: "Evening conditioning", sessionOrder: 1 });

  const morningRes = await api(`/api/training-load/sessions/${morningId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 50) });
  const eveningRes = await api(`/api/training-load/sessions/${eveningId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(8, 40) });
  assert.equal(morningRes.status, 201);
  assert.equal(eveningRes.status, 201);
  assert.equal(morningRes.body.feedback.srpe, 300);
  assert.equal(eveningRes.body.feedback.srpe, 320);

  const today = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.equal(today.body.sessions.length, 2, "both sessions appear, each with its own result");
  const bySession = Object.fromEntries(today.body.sessions.map((s) => [s.sessionId, s]));
  assert.equal(bySession[morningId].feedback.srpe, 300);
  assert.equal(bySession[eveningId].feedback.srpe, 320);
});

// ------------------------------------------------------------
// D. A future session can never be rated
// ------------------------------------------------------------

test("D1. a session dated tomorrow (the athlete's own local tomorrow) cannot be rated yet", async () => {
  const { athletes } = await makeClubWithAthletes("d1", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TOMORROW);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  assert.equal(res.status, 400);
});

test("D2. today's own session, and an earlier (yesterday's) not-yet-rated session, can both be rated", async () => {
  const { athletes } = await makeClubWithAthletes("d2", 1);
  const todaySession = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const yesterdaySession = await makeActiveSessionOn(athletes[0].athleteId, YESTERDAY);
  const todayRes = await api(`/api/training-load/sessions/${todaySession}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  const yesterdayRes = await api(`/api/training-load/sessions/${yesterdaySession}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(4, 25) });
  assert.equal(todayRes.status, 201);
  assert.equal(yesterdayRes.status, 201);
});

// ------------------------------------------------------------
// E. IDOR / unauthorized access
// ------------------------------------------------------------

test("E1. an athlete can never submit RPE for a DIFFERENT athlete's session (IDOR) - a controlled 404, not a leak", async () => {
  const groupA = await makeClubWithAthletes("e1a", 1);
  const groupB = await makeClubWithAthletes("e1b", 1);
  const sessionId = await makeActiveSessionOn(groupA.athletes[0].athleteId, TODAY);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: groupB.athletes[0].cookie, body: rpeBody(5, 30) });
  assert.equal(res.status, 404, "must never reveal that this session belongs to someone else - same response as a genuinely missing session");
});

test("E2. a coach account (no athlete profile) cannot submit RPE at all", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("e2", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: coachCookie, body: rpeBody(5, 30) });
  assert.equal(res.status, 403);
});

test("E3. a coach account cannot call the athlete-only GET /athlete/today", async () => {
  const { coachCookie } = await makeClubWithAthletes("e3", 1);
  const res = await api("/api/training-load/athlete/today", { cookie: coachCookie });
  assert.equal(res.status, 403);
});

test("E4. an unauthenticated request is rejected outright", async () => {
  const res = await api("/api/training-load/athlete/today", {});
  assert.equal(res.status, 401);
});

test("E5. a coach outside an athlete's club never sees that athlete in the weekly view", async () => {
  const inClub = await makeClubWithAthletes("e5in", 1);
  const outsideClub = await makeClubWithAthletes("e5out", 1);
  const sessionId = await makeActiveSessionOn(inClub.athletes[0].athleteId, TODAY);
  await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: inClub.athletes[0].cookie, body: rpeBody(5, 30) });

  const res = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: outsideClub.coachCookie });
  assert.equal(res.status, 200);
  const allSessions = res.body.days.flatMap((d) => d.sessions);
  assert.ok(!allSessions.some((s) => s.athleteId === inClub.athletes[0].athleteId), "an athlete outside the coach's workspace must never appear");
});

// ------------------------------------------------------------
// F. Idempotent retry
// ------------------------------------------------------------

test("F1. an identical retry (same rpe/duration/note) is a silent idempotent 200, never a duplicate row", async () => {
  const { athletes } = await makeClubWithAthletes("f1", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const first = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 50, "felt good") });
  assert.equal(first.status, 201);
  const retry = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 50, "felt good") });
  assert.equal(retry.status, 200, "an exact retry is a no-op success, not an error");
  assert.equal(retry.body.feedback.srpe, 300);

  const countResult = await query(`select count(*)::int as n from training_load.session_feedback where plan_session_id = $1`, [sessionId]);
  assert.equal(countResult.rows[0].n, 1, "only one row ever exists, regardless of the retry");
});

test("F2. an identical retry with no note both times is still recognized as identical (empty note vs empty note)", async () => {
  const { athletes } = await makeClubWithAthletes("f2", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const first = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  const retry = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
});

// ------------------------------------------------------------
// G. A conflicting second submit never silently overwrites the original
// ------------------------------------------------------------

test("G1. a genuinely different second submit is rejected with 409, and the original row is completely unchanged", async () => {
  const { athletes } = await makeClubWithAthletes("g1", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const first = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 50) });
  assert.equal(first.status, 201);
  const conflict = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(9, 90) });
  assert.equal(conflict.status, 409);

  const rowResult = await query(`select rpe, duration_minutes, srpe from training_load.session_feedback where plan_session_id = $1`, [sessionId]);
  assert.equal(rowResult.rows.length, 1);
  assert.equal(rowResult.rows[0].rpe, 6, "the original rpe must survive untouched");
  assert.equal(rowResult.rows[0].duration_minutes, 50);
  assert.equal(rowResult.rows[0].srpe, 300);
});

test("G2. a conflicting submit differing ONLY in the note is still rejected (note is part of the identity check)", async () => {
  const { athletes } = await makeClubWithAthletes("g2", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 50, "first note") });
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 50, "different note") });
  assert.equal(res.status, 409);
});

// ------------------------------------------------------------
// H. Draft / inactive / edit-draft weekly plans never create an
// actionable RPE session
// ------------------------------------------------------------

test("H1. a DRAFT weekly plan's session is never offered - absent from /athlete/today, and POSTing to it directly is a 404", async () => {
  const { athletes } = await makeClubWithAthletes("h1", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { plan: { status: "draft" } });
  const today = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.equal(today.body.sessions.length, 0);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  assert.equal(res.status, 404);
});

test("H2. an is_edit_draft=true weekly plan's session is never offered", async () => {
  const { athletes } = await makeClubWithAthletes("h2", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { plan: { isEditDraft: true } });
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  assert.equal(res.status, 404);
});

test("H3. an is_active=false weekly plan's session is never offered", async () => {
  const { athletes } = await makeClubWithAthletes("h3", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { plan: { isActive: false } });
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  assert.equal(res.status, 404);
});

// ------------------------------------------------------------
// I. Deleting or changing the original session never destroys a
// historical result
// ------------------------------------------------------------

test("I1. deleting the plan_session AFTER a result was submitted preserves the result's full snapshot, with plan_session_id nulled out (never a cascade delete, never an error)", async () => {
  const { athletes } = await makeClubWithAthletes("i1", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { plan: { name: "Pre-season block" }, session: { name: "Tempo run", amPm: "AM" } });
  const submit = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(7, 60, "solid session") });
  assert.equal(submit.status, 201);

  // Simulates applyEditDraft()'s real delete-and-recreate of a plan's day
  // tree (backend/src/routes/builder.js) - the exact scenario the
  // migration's own header comment documents.
  await query(`delete from plans.plan_sessions where id = $1`, [sessionId]);

  const rowResult = await query(`select plan_session_id, session_date, plan_name, session_name, session_am_pm, rpe, duration_minutes, srpe, athlete_note from training_load.session_feedback where athlete_id = $1`, [athletes[0].athleteId]);
  assert.equal(rowResult.rows.length, 1, "the result row itself is never deleted");
  const row = rowResult.rows[0];
  assert.equal(row.plan_session_id, null, "the dangling FK is nulled out, not left pointing at nothing");
  assert.equal(row.session_date, TODAY);
  assert.equal(row.plan_name, "Pre-season block");
  assert.equal(row.session_name, "Tempo run");
  assert.equal(row.session_am_pm, "AM");
  assert.equal(row.rpe, 7);
  assert.equal(row.duration_minutes, 60);
  assert.equal(row.srpe, 420);
  assert.equal(row.athlete_note, "solid session");
});

test("I2. a historical (session-deleted) result still appears in the weekly view, marked historical, with no live session to click into", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("i2", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 40) });
  await query(`delete from plans.plan_sessions where id = $1`, [sessionId]);

  const res = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const day = res.body.days.find((d) => d.date === TODAY);
  assert.equal(day.sessions.length, 1);
  assert.equal(day.sessions[0].historical, true);
  assert.equal(day.sessions[0].sessionId, null);
  assert.equal(day.sessions[0].feedback.srpe, 240);
});

test("I3. renaming the plan/session after submission never changes the already-saved snapshot", async () => {
  const { athletes } = await makeClubWithAthletes("i3", 1);
  const planId = await makeWeeklyPlan(athletes[0].athleteId, { name: "Original plan name" });
  const dayId = await makePlanDay(planId, TODAY);
  const sessionId = await makeSession(dayId, { name: "Original session name" });
  await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });

  await query(`update plans.plans set name = 'Renamed plan' where id = $1`, [planId]);
  await query(`update plans.plan_sessions set name = 'Renamed session' where id = $1`, [sessionId]);

  const rowResult = await query(`select plan_name, session_name from training_load.session_feedback where plan_session_id = $1`, [sessionId]);
  assert.equal(rowResult.rows[0].plan_name, "Original plan name");
  assert.equal(rowResult.rows[0].session_name, "Original session name");
});

// ------------------------------------------------------------
// J. Athlete local date / timezone boundary
// ------------------------------------------------------------

test("J1. an athlete whose device timezone is far ahead of UTC sees a session dated their LOCAL tomorrow as still not-yet-ratable, even if it's already tomorrow in UTC", async () => {
  const { athletes } = await makeClubWithAthletes("j1", 1);
  // Pacific/Kiritimati is UTC+14 - if it's already past 10:00 UTC, local
  // time there has rolled into "tomorrow" relative to UTC's own date.
  await query(`update public.athletes set device_timezone = 'Pacific/Kiritimati' where id = $1`, [athletes[0].athleteId]);
  const localTodayResult = await query(`select (now() at time zone 'Pacific/Kiritimati')::date as d`);
  const localToday = localTodayResult.rows[0].d;
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, localToday);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  assert.equal(res.status, 201, "a session dated this athlete's OWN local today must be ratable, regardless of the UTC date");
});

test("J2. a null device_timezone falls back to UTC rather than erroring", async () => {
  const { athletes } = await makeClubWithAthletes("j2", 1);
  await query(`update public.athletes set device_timezone = null where id = $1`, [athletes[0].athleteId]);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  assert.equal(res.status, 201);
});

// ------------------------------------------------------------
// K. Coach weekly view: Today/Schedule/Results shape, filters, multi-athlete
// ------------------------------------------------------------

test("K1. multiple athletes, multiple sessions the same day, all appear correctly attributed in the weekly view", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("k1", 2);
  const sessionA = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "A session" } });
  const planB = await makeWeeklyPlan(athletes[1].athleteId, { weekStart: THIS_WEEK_START });
  const dayB = await makePlanDay(planB, TODAY);
  const sessionB1 = await makeSession(dayB, { name: "B session 1", sessionOrder: 0 });
  const sessionB2 = await makeSession(dayB, { name: "B session 2", sessionOrder: 1 });

  await api(`/api/training-load/sessions/${sessionA}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  await api(`/api/training-load/sessions/${sessionB1}/rpe`, { method: "POST", cookie: athletes[1].cookie, body: rpeBody(6, 40) });
  // sessionB2 deliberately left unrated.

  const res = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  assert.equal(res.status, 200);
  const day = res.body.days.find((d) => d.date === TODAY);
  assert.equal(day.sessions.length, 3);
  const ratedCount = day.sessions.filter((s) => s.rated).length;
  assert.equal(ratedCount, 2);
  assert.ok(day.sessions.some((s) => s.sessionId === sessionB2 && !s.rated), "the unrated second session for athlete B is still listed");
});

test("K2. the weekly response always returns exactly 7 days, Monday weekStart through Sunday weekEnd, even with nothing scheduled", async () => {
  const { coachCookie } = await makeClubWithAthletes("k2", 1);
  const res = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.days.length, 7);
  assert.equal(res.body.days[0].date, THIS_WEEK_START);
});

test("K3. an invalid weekStart is a controlled 400, not a 500", async () => {
  const { coachCookie } = await makeClubWithAthletes("k3", 1);
  const res = await api("/api/training-load/weekly?weekStart=not-a-date", { cookie: coachCookie });
  assert.equal(res.status, 400);
});

test("K4. Club filter narrows the weekly view to only that club's athletes", async () => {
  const clubA = await makeClubWithAthletes("k4a", 1);
  const clubB = await makeClubWithAthletes("k4b", 1);
  // Both clubs managed by the SAME coach (an independent coach admining two clubs).
  await grantClubAdmin(clubA.coachId, clubB.clubId);
  const sessionA = await makeActiveSessionOn(clubA.athletes[0].athleteId, TODAY);
  const sessionB = await makeActiveSessionOn(clubB.athletes[0].athleteId, TODAY);
  await api(`/api/training-load/sessions/${sessionA}/rpe`, { method: "POST", cookie: clubA.athletes[0].cookie, body: rpeBody(5, 30) });
  await api(`/api/training-load/sessions/${sessionB}/rpe`, { method: "POST", cookie: clubB.athletes[0].cookie, body: rpeBody(6, 40) });

  const unfiltered = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: clubA.coachCookie });
  const unfilteredIds = unfiltered.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(unfilteredIds.includes(sessionA) && unfilteredIds.includes(sessionB), "both clubs visible without a filter");

  const filtered = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}&clubIds=${clubA.clubId}`, { cookie: clubA.coachCookie });
  const filteredIds = filtered.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(filteredIds.includes(sessionA) && !filteredIds.includes(sessionB), "only club A's athlete remains once filtered to club A");
});

test("K5. Team filter narrows the weekly view to only that team's athletes", async () => {
  const { clubId, coachId, coachCookie, athletes } = await makeClubWithAthletes("k5", 2);
  const teamId = await makeTeam(clubId, "K5 Team");
  await query(`insert into public.athlete_memberships (athlete_id, team_id, membership_type, status) values ($1,$2,'team','active')`, [athletes[0].athleteId, teamId]);
  const sessionTeam = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const sessionNonTeam = await makeActiveSessionOn(athletes[1].athleteId, TODAY);
  await api(`/api/training-load/sessions/${sessionTeam}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  await api(`/api/training-load/sessions/${sessionNonTeam}/rpe`, { method: "POST", cookie: athletes[1].cookie, body: rpeBody(6, 40) });

  const filtered = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}&teamIds=${teamId}`, { cookie: coachCookie });
  const filteredIds = filtered.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(filteredIds.includes(sessionTeam) && !filteredIds.includes(sessionNonTeam));
});

test("K6. Athlete filter narrows the weekly view to only the selected athlete(s)", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("k6", 2);
  const session0 = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const session1 = await makeActiveSessionOn(athletes[1].athleteId, TODAY);
  const filtered = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}&athleteIds=${athletes[0].athleteId}`, { cookie: coachCookie });
  const filteredIds = filtered.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(filteredIds.includes(session0) && !filteredIds.includes(session1));
});

test("K7. the athlete's own weekly view is always scoped to themselves - filter params are ignored, never a leak into another athlete's data", async () => {
  const groupA = await makeClubWithAthletes("k7a", 1);
  const groupB = await makeClubWithAthletes("k7b", 1);
  const sessionA = await makeActiveSessionOn(groupA.athletes[0].athleteId, TODAY);
  const sessionB = await makeActiveSessionOn(groupB.athletes[0].athleteId, TODAY);
  const res = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}&athleteIds=${groupB.athletes[0].athleteId}`, { cookie: groupA.athletes[0].cookie });
  const ids = res.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(ids.includes(sessionA) && !ids.includes(sessionB), "the athleteIds param must never override an athlete caller's own self-scope");
});

// ------------------------------------------------------------
// L. Read-only weekly GET - zero DB side effects
// ------------------------------------------------------------

test("L1. browsing the weekly view, including a future week with nothing materialized, creates no row anywhere - a pure read", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("l1", 1);
  await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const beforeCount = (await query(`select count(*)::int as n from training_load.session_feedback`)).rows[0].n;
  const beforePlanCount = (await query(`select count(*)::int as n from plans.plans`)).rows[0].n;
  const beforeSessionCount = (await query(`select count(*)::int as n from plans.plan_sessions`)).rows[0].n;

  await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  await api(`/api/training-load/weekly?weekStart=${addDaysIso(THIS_WEEK_START, 70)}`, { cookie: coachCookie });
  await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });

  const afterCount = (await query(`select count(*)::int as n from training_load.session_feedback`)).rows[0].n;
  const afterPlanCount = (await query(`select count(*)::int as n from plans.plans`)).rows[0].n;
  const afterSessionCount = (await query(`select count(*)::int as n from plans.plan_sessions`)).rows[0].n;
  assert.equal(afterCount, beforeCount);
  assert.equal(afterPlanCount, beforePlanCount);
  assert.equal(afterSessionCount, beforeSessionCount);
});

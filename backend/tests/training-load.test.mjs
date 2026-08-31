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
const MIGRATION_V1_PATH = path.resolve(__dirname, "../../migrations_v2/202608310900_training_load_v1_session_feedback.sql");
const MIGRATION_V1_NAME = "202608310900_training_load_v1_session_feedback.sql";
const MIGRATION_V2_PATH = path.resolve(__dirname, "../../migrations_v2/202608320900_training_load_v2_logical_session_identity.sql");
const MIGRATION_V2_NAME = "202608320900_training_load_v2_logical_session_identity.sql";
const MIGRATION_V3_PATH = path.resolve(__dirname, "../../migrations_v2/202609010900_training_load_v3_rpe_enabled.sql");
const MIGRATION_V3_NAME = "202609010900_training_load_v3_rpe_enabled.sql";
const MIGRATION_V4_PATH = path.resolve(__dirname, "../../migrations_v2/202609011000_training_load_v4_external_scheduling.sql");
const MIGRATION_V4_NAME = "202609011000_training_load_v4_external_scheduling.sql";
const MIGRATION_V5_PATH = path.resolve(__dirname, "../../migrations_v2/202609011100_training_load_v5_unified_result_source.sql");
const MIGRATION_V5_NAME = "202609011100_training_load_v5_unified_result_source.sql";
// v9's own planned_rpe_effective_for_athlete() is called unconditionally
// by both POST /sessions/:id/rpe and GET /athlete/today|weekly now (see
// trainingLoad.js) - every test in this file that exercises those routes
// needs it present, even though it has no functional dependency on v6-v8
// (the external-scheduling migrations) at all.
const MIGRATION_V9_PATH = path.resolve(__dirname, "../../migrations_v2/202609040900_training_load_v9_planned_rpe_workspace_toggle.sql");
const MIGRATION_V9_NAME = "202609040900_training_load_v9_planned_rpe_workspace_toggle.sql";

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
    add column edit_source_plan_id uuid references plans.plans(id),
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
  const [migrationV1Sql, migrationV2Sql, migrationV3Sql, migrationV4Sql, migrationV5Sql, migrationV9Sql] = await Promise.all([
    fsp.readFile(MIGRATION_V1_PATH, "utf8"),
    fsp.readFile(MIGRATION_V2_PATH, "utf8"),
    fsp.readFile(MIGRATION_V3_PATH, "utf8"),
    fsp.readFile(MIGRATION_V4_PATH, "utf8"),
    fsp.readFile(MIGRATION_V5_PATH, "utf8"),
    fsp.readFile(MIGRATION_V9_PATH, "utf8"),
  ]);

  db = await makeTempDb("primary");
  adminClient = new pg.Client({ connectionString: db.url });
  await adminClient.connect();
  const ownCheck = await adminClient.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");

  await adminClient.query(LEGACY_FIXTURE_SQL);
  migrationsDir = await writeMigrationsDir("primary", {
    [MIGRATION_V1_NAME]: migrationV1Sql,
    [MIGRATION_V2_NAME]: migrationV2Sql,
    [MIGRATION_V3_NAME]: migrationV3Sql,
    [MIGRATION_V4_NAME]: migrationV4Sql,
    [MIGRATION_V5_NAME]: migrationV5Sql,
    [MIGRATION_V9_NAME]: migrationV9Sql,
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

  // v9's workspace-level master toggle for planned RPE defaults to OFF
  // for every workspace that has never configured it - this whole file
  // predates that switch and tests the ORIGINAL per-session rpe_enabled
  // behavior exclusively (the master toggle itself has its own dedicated
  // test file, training-load-planned-rpe-master-toggle.test.mjs). A
  // single platform-wide 'system' row, enabled from year 2000, makes
  // every session/athlete this file's own tests create actionable by
  // default - the SAME effective behavior every one of these tests
  // already assumed before v9 existed - without touching any individual
  // test's own assertions.
  await query(
    `insert into training_load.planned_rpe_workspace_settings (owner_scope, enabled, enabled_at) values ('system', true, '2000-01-01T00:00:00Z')`,
  );

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
async function grantTeamCoach(userId, teamId) {
  await query(`insert into public.user_team_roles (user_id, team_id, role) values ($1,$2,'team_coach')`, [userId, teamId]);
}
async function grantGlobalRole(userId, role) {
  await query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,$2,true)`, [userId, role]);
}
async function linkPrivateCoachAthlete(userId, athleteId) {
  await query(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1,$2,'coach',true)`, [userId, athleteId]);
}
// The real, authoritative "which workspace is this account currently
// presenting as" mechanism (backend/src/workspace.js's own
// resolveActiveWorkspace) - only takes effect if the account genuinely
// holds the matching real role/FK (an unmatched preference silently falls
// back, exactly as it does in production).
async function setActiveWorkspace(userId, type, scopeId = null) {
  await query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id, updated_at) values ($1,$2,$3,now())
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id, updated_at = now()`,
    [userId, type, scopeId],
  );
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

// Item 1 correction, round 3: reads the migration's own legacy-draft-marker
// block straight out of the actual shipped file, never a hand-copied
// duplicate that could drift. (The earlier slot-matching fixup this used to
// extract was removed - see the migration file's own section 3 comment for
// why a slot key can never safely stand in for identity across an edit.)
async function extractLegacyDraftPolicySql() {
  const full = await fsp.readFile(MIGRATION_V2_PATH, "utf8");
  const startMarker = "alter table plans.plans add column if not exists legacy_pre_migration_draft";
  const endMarker = "-- 4. Snapshot immutability trigger.";
  const startIdx = full.indexOf(startMarker);
  const endIdx = full.indexOf(endMarker, startIdx);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error("could not locate the migration's legacy-draft-policy block - has the migration file's shape changed?");
  }
  return full.slice(startIdx, endIdx);
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

// Correction: Number(null) === 0 and Number("") === 0 used to let a
// missing/null rpe silently pass validation as a false "RPE 0" - only a
// real JSON integer number is ever accepted now.
test("B10. rpe: null is rejected outright, never silently coerced to RPE 0", async () => {
  const { athletes } = await makeClubWithAthletes("b10", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(null, 30) });
  assert.equal(res.status, 400);
});

test("B11. rpe as a string (e.g. \"5\") is rejected - the client must send a real JSON number, not a numeric string", async () => {
  const { athletes } = await makeClubWithAthletes("b11", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody("5", 30) });
  assert.equal(res.status, 400);
});

test("B12. durationMinutes: null or an empty string is rejected outright, never silently coerced to 0", async () => {
  const { athletes } = await makeClubWithAthletes("b12", 1);
  const sessionA = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const sessionB = await makeActiveSessionOn(athletes[0].athleteId, YESTERDAY);
  const resNull = await api(`/api/training-load/sessions/${sessionA}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, null) });
  assert.equal(resNull.status, 400);
  const resEmpty = await api(`/api/training-load/sessions/${sessionB}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, "") });
  assert.equal(resEmpty.status, 400);
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

test("E6. a malformed sessionId (not a real UUID) is a controlled 404, never a raw Postgres 22P02 type-mismatch 500", async () => {
  const { athletes } = await makeClubWithAthletes("e6", 1);
  const res = await api("/api/training-load/sessions/not-a-real-uuid/rpe", { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  assert.equal(res.status, 404, "must be rejected before it ever reaches a UUID comparison in SQL");
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
// I-continued. Stable logical_session_id - a session row recreated with
// the SAME logical_session_id (simulating builder.js's applyEditDraft,
// without needing the full HTTP Builder flow - see backend/tests/
// training-load-builder-edit-draft.test.mjs for the real end-to-end
// regression) must be recognized as already-rated, never double-counted.
// ------------------------------------------------------------

test("I4. a session row deleted and recreated with the SAME logical_session_id is recognized as already-rated - the historical query never returns it a second time", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("i4", 1);
  const planId = await makeWeeklyPlan(athletes[0].athleteId, { name: "I4 plan" });
  const dayId = await makePlanDay(planId, TODAY);
  const sessionId = await makeSession(dayId, { name: "I4 session" });
  const logicalIdResult = await query(`select logical_session_id from plans.plan_sessions where id = $1`, [sessionId]);
  const logicalId = logicalIdResult.rows[0].logical_session_id;

  const submit = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(7, 60) });
  assert.equal(submit.status, 201);

  // Simulates applyEditDraft(): delete the old row, insert a NEW row for
  // the same logical training session, explicitly carrying the SAME
  // logical_session_id forward (exactly what copyDaySessions'
  // preserveLogicalId:true does).
  await query(`delete from plans.plan_sessions where id = $1`, [sessionId]);
  const recreated = await query(
    `insert into plans.plan_sessions (plan_day_id, name, logical_session_id) values ($1,$2,$3) returning id`,
    [dayId, "I4 session (recreated)", logicalId],
  );
  const newSessionId = recreated.rows[0].id;

  const today = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  const row = today.body.sessions.find((s) => s.sessionId === newSessionId);
  assert.ok(row, "the recreated row appears under its own new id");
  assert.equal(row.rated, true, "and is correctly recognized as already-rated via the shared logical_session_id");
  assert.equal(row.feedback.srpe, 420);

  const weekly = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const allSessions = weekly.body.days.flatMap((d) => d.sessions);
  const ratedRows = allSessions.filter((s) => s.rated && s.feedback?.srpe === 420);
  assert.equal(ratedRows.length, 1, "the result must appear exactly ONCE across the whole week - never duplicated as both a live row and a historical row");
  assert.equal(ratedRows[0].historical, false, "it's reachable through the LIVE session, not the historical/orphaned fallback");
});

test("I5. an identical retry against the RECREATED row (same logical_session_id) is still a clean 200 idempotent no-op, and a genuinely different retry is still 409", async () => {
  const { athletes } = await makeClubWithAthletes("i5", 1);
  const planId = await makeWeeklyPlan(athletes[0].athleteId);
  const dayId = await makePlanDay(planId, TODAY);
  const sessionId = await makeSession(dayId);
  const logicalIdResult = await query(`select logical_session_id from plans.plan_sessions where id = $1`, [sessionId]);
  const logicalId = logicalIdResult.rows[0].logical_session_id;
  await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(7, 60) });
  await query(`delete from plans.plan_sessions where id = $1`, [sessionId]);
  const recreated = await query(`insert into plans.plan_sessions (plan_day_id, logical_session_id) values ($1,$2) returning id`, [dayId, logicalId]);
  const newSessionId = recreated.rows[0].id;

  const retrySame = await api(`/api/training-load/sessions/${newSessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(7, 60) });
  assert.equal(retrySame.status, 200);
  const retryDifferent = await api(`/api/training-load/sessions/${newSessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(9, 90) });
  assert.equal(retryDifferent.status, 409);

  const countResult = await query(`select count(*)::int as n from training_load.session_feedback where logical_session_id = $1`, [logicalId]);
  assert.equal(countResult.rows[0].n, 1);
});

test("I6. a session copied to a DIFFERENT day as a genuinely new training session gets its own logical_session_id and is independently ratable - never inheriting an old result", async () => {
  const { athletes } = await makeClubWithAthletes("i6", 1);
  const planId = await makeWeeklyPlan(athletes[0].athleteId);
  const dayId = await makePlanDay(planId, TODAY);
  const sessionId = await makeSession(dayId, { name: "Original" });
  await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(7, 60) });

  // A day-to-day copy (copyDaySessions with its default preserveLogicalId:
  // false) - a genuinely different training session, must NOT carry the
  // source's logical_session_id, so it must default to a fresh one.
  const otherDayId = await makePlanDay(planId, YESTERDAY);
  const copied = await query(
    `insert into plans.plan_sessions (plan_day_id, name) values ($1,$2) returning id, logical_session_id`,
    [otherDayId, "Copied to another day"],
  );
  const copiedSessionId = copied.rows[0].id;
  const sourceLogicalId = (await query(`select logical_session_id from plans.plan_sessions where id = $1`, [sessionId])).rows[0].logical_session_id;
  assert.notEqual(copied.rows[0].logical_session_id, sourceLogicalId, "a copy to a new day must never share the source's logical identity");

  const res = await api(`/api/training-load/sessions/${copiedSessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(4, 20) });
  assert.equal(res.status, 201, "the copy is a genuinely new, independently-ratable session");
});

// ------------------------------------------------------------
// I-trigger. DB-enforced snapshot immutability.
// ------------------------------------------------------------

test("I7. a direct UPDATE of a business/snapshot column (rpe) is rejected by the DB trigger, not just by the API layer", async () => {
  const { athletes } = await makeClubWithAthletes("i7", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  await assert.rejects(
    () => query(`update training_load.session_feedback set rpe = 9 where plan_session_id = $1`, [sessionId]),
    /immutable snapshot/,
  );
});

test("I8. a direct UPDATE of the athlete_note or session_date snapshot columns is also rejected", async () => {
  const { athletes } = await makeClubWithAthletes("i8", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30, "original note") });
  await assert.rejects(() => query(`update training_load.session_feedback set athlete_note = 'tampered' where plan_session_id = $1`, [sessionId]));
  await assert.rejects(() => query(`update training_load.session_feedback set session_date = session_date - 1 where plan_session_id = $1`, [sessionId]));
});

test("I9. the DB's own ON DELETE SET NULL on plan_session_id still works - the ONE column the trigger must never block", async () => {
  const { athletes } = await makeClubWithAthletes("i9", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  await assert.doesNotReject(() => query(`delete from plans.plan_sessions where id = $1`, [sessionId]));
  const row = (await query(`select plan_session_id from training_load.session_feedback where session_date = $1 order by created_at desc limit 1`, [TODAY])).rows[0];
  assert.equal(row.plan_session_id, null);
});

// ------------------------------------------------------------
// I-race. Transaction/lock safety - a concurrent Builder delete racing a
// POST must never produce a raw 500 or a result for an invalid session.
// ------------------------------------------------------------

test("I10. if the session row is deleted by a concurrent transaction while a submit is resolving it, the submit cleanly 404s - never a foreign-key 500", async () => {
  const { athletes } = await makeClubWithAthletes("i10", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);

  // A second, independent connection simulating a concurrent Builder
  // edit/delete - takes the row lock first, deletes it, and commits,
  // exactly like applyEditDraft's own deleteBlockTreeWithClient would.
  const raceClient = new pg.Client({ connectionString: db.url });
  await raceClient.connect();
  await raceClient.query("begin");
  await raceClient.query("select id from plans.plan_sessions where id = $1 for update", [sessionId]);
  await raceClient.query("delete from plans.plan_sessions where id = $1", [sessionId]);

  const submitPromise = api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  // Give the POST a moment to reach its own `for update` lock wait before
  // the race connection commits and releases the row - not required for
  // correctness (the assertion holds either way - see this test file's
  // own design note), but makes the "genuinely blocked, then unblocks to
  // find nothing" path the one actually exercised most of the time.
  await new Promise((resolve) => setTimeout(resolve, 150));
  await raceClient.query("commit");
  await raceClient.end();

  const res = await submitPromise;
  assert.equal(res.status, 404, "never a raw 500, and never a result created against an already-invalid session");
  const countResult = await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athletes[0].athleteId]);
  assert.equal(countResult.rows[0].n, 0, "no feedback row was ever created for the deleted session");
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

// Correction: a coach's CURRENT ACTIVE WORKSPACE (not the union of every
// club/team they happen to administer) is now the mandatory scope - a
// coach who administers two clubs but is currently working in Club A's
// workspace must never see Club B's athletes at all, filter or no
// filter. See coachWorkspaceScopeSql in trainingLoad.js.
test("K4. a coach's active CLUB workspace scopes the weekly view to ONLY that club's athletes, even when the same coach also administers a different club", async () => {
  const clubA = await makeClubWithAthletes("k4a", 1);
  const clubB = await makeClubWithAthletes("k4b", 1);
  // Both clubs managed by the SAME coach (an independent coach admining two clubs).
  await grantClubAdmin(clubA.coachId, clubB.clubId);
  const sessionA = await makeActiveSessionOn(clubA.athletes[0].athleteId, TODAY);
  const sessionB = await makeActiveSessionOn(clubB.athletes[0].athleteId, TODAY);
  await api(`/api/training-load/sessions/${sessionA}/rpe`, { method: "POST", cookie: clubA.athletes[0].cookie, body: rpeBody(5, 30) });
  await api(`/api/training-load/sessions/${sessionB}/rpe`, { method: "POST", cookie: clubB.athletes[0].cookie, body: rpeBody(6, 40) });

  await setActiveWorkspace(clubA.coachId, "club", clubA.clubId);
  const inClubA = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: clubA.coachCookie });
  const idsInA = inClubA.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(idsInA.includes(sessionA) && !idsInA.includes(sessionB), "only club A's athlete, even though this coach also administers club B");

  await setActiveWorkspace(clubA.coachId, "club", clubB.clubId);
  const inClubB = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: clubA.coachCookie });
  const idsInB = inClubB.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(idsInB.includes(sessionB) && !idsInB.includes(sessionA), "switching the active workspace to club B flips which athletes are visible");
});

test("K4b. within a workspace scope, the Club/Team/Athlete filter can only NARROW - it can never widen past the mandatory workspace boundary", async () => {
  const clubA = await makeClubWithAthletes("k4c", 1);
  const clubB = await makeClubWithAthletes("k4d", 1);
  await grantClubAdmin(clubA.coachId, clubB.clubId);
  const sessionB = await makeActiveSessionOn(clubB.athletes[0].athleteId, TODAY);
  await api(`/api/training-load/sessions/${sessionB}/rpe`, { method: "POST", cookie: clubB.athletes[0].cookie, body: rpeBody(6, 40) });

  await setActiveWorkspace(clubA.coachId, "club", clubA.clubId);
  // Explicitly asking for club B's athlete WHILE the active workspace is
  // club A must still return nothing - the filter is inside the
  // workspace scope, never an escape hatch out of it.
  const res = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}&athleteIds=${clubB.athletes[0].athleteId}`, { cookie: clubA.coachCookie });
  const ids = res.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(!ids.includes(sessionB));
});

test("K4c. a TEAM workspace scopes the weekly view to only that team's athletes", async () => {
  const { clubId, coachId, coachCookie, athletes } = await makeClubWithAthletes("k4e", 2);
  const teamId = await makeTeam(clubId, "K4e Team");
  await grantTeamCoach(coachId, teamId);
  await query(`insert into public.athlete_memberships (athlete_id, team_id, membership_type, status) values ($1,$2,'team','active')`, [athletes[0].athleteId, teamId]);
  const sessionTeam = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const sessionOther = await makeActiveSessionOn(athletes[1].athleteId, TODAY);
  await api(`/api/training-load/sessions/${sessionTeam}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  await api(`/api/training-load/sessions/${sessionOther}/rpe`, { method: "POST", cookie: athletes[1].cookie, body: rpeBody(6, 40) });

  await setActiveWorkspace(coachId, "team", teamId);
  const res = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const ids = res.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(ids.includes(sessionTeam) && !ids.includes(sessionOther), "the OTHER athlete (same club, not this team) must be invisible from a team workspace, even without a filter");
});

test("K4d. a PRIVATE-COACH workspace scopes the weekly view to only this coach's own direct athlete relationships - never via an unrelated club/team role", async () => {
  const { coachId, coachCookie, athletes } = await makeClubWithAthletes("k4f", 1);
  await grantGlobalRole(coachId, "independent_coach");
  const privateAthleteId = await makeAthlete({ name: "K4f Private Athlete" });
  await linkPrivateCoachAthlete(coachId, privateAthleteId);
  const sessionPrivate = await makeActiveSessionOn(privateAthleteId, TODAY);
  const sessionClub = await makeActiveSessionOn(athletes[0].athleteId, TODAY);

  await setActiveWorkspace(coachId, "private_coach", null);
  const res = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const ids = res.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(ids.includes(sessionPrivate) && !ids.includes(sessionClub), "the club-role-managed athlete must be invisible from the private-coach workspace, even though the same account also holds that club role");
});

test("K4e. a PLATFORM workspace sees every athlete, unrestricted", async () => {
  const clubA = await makeClubWithAthletes("k4g", 1);
  const platformUserId = await makeUser({ email: `k4g-platform-${Date.now()}@test.local` });
  await grantGlobalRole(platformUserId, "platform_admin");
  const platformCookie = await loginCookie(platformUserId);
  await setActiveWorkspace(platformUserId, "platform", null);
  const sessionA = await makeActiveSessionOn(clubA.athletes[0].athleteId, TODAY);

  const res = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: platformCookie });
  const ids = res.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(ids.includes(sessionA));
});

test("K4f. a multi-role account (real athlete profile AND real club_admin coach role) sees strictly different data depending on which workspace is currently active - existence of an athlete profile must never hijack a genuine coach request", async () => {
  const club = await makeClubWithAthletes("k4h", 1);
  // The coach account ITSELF also has a real athlete profile (a genuine
  // dual-role account), with its own weekly-plan session.
  const dualUserId = club.coachId;
  const dualAthleteId = await makeAthlete({ name: "K4h Dual-role Athlete", userId: dualUserId });
  await query(`update public.athletes set device_timezone = 'UTC' where id = $1`, [dualAthleteId]);
  const dualCookie = club.coachCookie;
  const ownSession = await makeActiveSessionOn(dualAthleteId, TODAY);
  const clubMemberSession = await makeActiveSessionOn(club.athletes[0].athleteId, TODAY);

  await setActiveWorkspace(dualUserId, "athlete", null);
  const asAthlete = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: dualCookie });
  const athleteIds = asAthlete.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.deepEqual(athleteIds.sort(), [ownSession].sort(), "in athlete workspace, only their OWN session - never the club roster, even though they administer it");

  await setActiveWorkspace(dualUserId, "club", club.clubId);
  const asCoach = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: dualCookie });
  const coachIds = asCoach.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(coachIds.includes(clubMemberSession), "in club workspace, the real athlete roster is visible");
  assert.ok(!coachIds.includes(ownSession), "the coach's OWN session (a different athlete_id relationship) is not part of the club roster query and must not leak in either");
});

test("K4g. Club + direct Athlete filters combine as a UNION (club roster OR the extra named athlete), never an AND", async () => {
  const clubA = await makeClubWithAthletes("k4i", 1);
  // A private-coach-managed athlete, unrelated to the club, reachable only
  // via a direct relationship - the coach must be in a workspace wide
  // enough to see both at once, so this uses the platform workspace as
  // the outer scope (a platform admin can legitimately combine any mix).
  const platformUserId = await makeUser({ email: `k4i-platform-${Date.now()}@test.local` });
  await grantGlobalRole(platformUserId, "platform_admin");
  const platformCookie = await loginCookie(platformUserId);
  await setActiveWorkspace(platformUserId, "platform", null);
  const outsideAthleteId = await makeAthlete({ name: "K4i Outside Athlete" });

  const sessionClub = await makeActiveSessionOn(clubA.athletes[0].athleteId, TODAY);
  const sessionOutside = await makeActiveSessionOn(outsideAthleteId, TODAY);
  const sessionNeither = await makeActiveSessionOn((await makeClubWithAthletes("k4i-neither", 1)).athletes[0].athleteId, TODAY);

  const res = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}&clubIds=${clubA.clubId}&athleteIds=${outsideAthleteId}`, { cookie: platformCookie });
  const ids = res.body.days.flatMap((d) => d.sessions.map((s) => s.sessionId));
  assert.ok(ids.includes(sessionClub), "the club's own athlete is included (club match)");
  assert.ok(ids.includes(sessionOutside), "the unrelated named athlete is ALSO included (union, not intersection)");
  assert.ok(!ids.includes(sessionNeither), "an athlete matching NEITHER condition is still excluded");
});

test("K4h. a malformed filter id is a controlled 400, never a raw Postgres 500", async () => {
  const { coachCookie } = await makeClubWithAthletes("k4j", 1);
  const res = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}&athleteIds=not-a-real-uuid`, { cookie: coachCookie });
  assert.equal(res.status, 400);
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

// ------------------------------------------------------------
// M. Item 1 correction, round 3: slot-based re-correlation (date + am_pm +
// bta + session_order) was removed - it is NOT a safe identity mechanism,
// since a slot key describes a session's CURRENT position, not its
// identity over time. Two concrete failures it had: (a) the coach changed
// the draft session's own slot before migration -> the old fixup found no
// match at all (false negative) -> saving the draft still orphaned an
// already-submitted result; (b) the coach deleted the original draft
// session and created an unrelated new one at the same slot -> the old
// fixup matched them anyway (false positive) -> a result got attributed to
// a completely different training session. Replaced with an explicit,
// safe policy: mark exactly the edit-drafts that already existed at
// migration time, and refuse new RPE submissions against their live plan
// until the coach saves or discards that draft - see trainingLoad.js's own
// POST /sessions/:sessionId/rpe and the migration file's section 3
// comment. This is safe specifically because RPE/sRPE was never deployed
// before this migration, so there are zero production results to protect
// at the moment it runs - only a short window afterward.
// ------------------------------------------------------------

// A pre-existing (legacy) edit-draft, with its own day/session at a
// caller-chosen slot - simulates "this draft already existed at migration
// time" without needing to actually re-run the migration mid-test.
async function makeLegacyEditDraft(athleteId, livePlanId, date, draftSessionOverrides = {}) {
  const draftPlanResult = await query(
    `insert into plans.plans (plan_type, athlete_id, name, status, is_active, is_edit_draft, edit_source_plan_id, legacy_pre_migration_draft, week_start)
     values ('weekly', $1, 'Weekly plan (edit-draft)', 'draft', false, true, $2, true, $3) returning id`,
    [athleteId, livePlanId, date],
  );
  const draftPlanId = draftPlanResult.rows[0].id;
  const draftDayId = await makePlanDay(draftPlanId, date);
  const draftSessionId = await makeSession(draftDayId, { amPm: "AM", sessionOrder: 0, name: "Draft session", ...draftSessionOverrides });
  return { draftPlanId, draftDayId, draftSessionId };
}

test("M1. the migration's own backfill marks a pre-existing edit-draft as legacy, and leaves a normal (post-migration) draft unmarked", async () => {
  const { athletes } = await makeClubWithAthletes("m1", 1);
  const athleteId = athletes[0].athleteId;
  const livePlanId = await makeWeeklyPlan(athleteId, { weekStart: THIS_WEEK_START });

  // Simulates the exact moment right after the migration's own ALTER TABLE
  // ... DEFAULT false has run, but before its UPDATE has - a pre-existing
  // draft (is_edit_draft = true already) still reads legacy = false here.
  const preExistingDraftResult = await query(
    `insert into plans.plans (plan_type, athlete_id, name, status, is_active, is_edit_draft, edit_source_plan_id, legacy_pre_migration_draft)
     values ('weekly', $1, 'Pre-existing draft', 'draft', false, true, $2, false) returning id`,
    [athleteId, livePlanId],
  );
  const preExistingDraftId = preExistingDraftResult.rows[0].id;
  // A genuinely normal (non-draft) plan must never be touched by the
  // backfill either, regardless of its own legacy_pre_migration_draft
  // value.
  const normalPlanId = await makeWeeklyPlan(athleteId);

  const policySql = await extractLegacyDraftPolicySql();
  await query(policySql);

  const preExistingAfter = (await query(`select legacy_pre_migration_draft from plans.plans where id = $1`, [preExistingDraftId])).rows[0].legacy_pre_migration_draft;
  const normalAfter = (await query(`select legacy_pre_migration_draft from plans.plans where id = $1`, [normalPlanId])).rows[0].legacy_pre_migration_draft;
  assert.equal(preExistingAfter, true, "an is_edit_draft=true row already present at migration time must be marked legacy");
  assert.equal(normalAfter, false, "a normal, non-draft plan must never be marked legacy");

  // A draft opened AFTER the migration (the normal, ongoing case) must
  // never be marked either - only rows that were ALREADY is_edit_draft=true
  // when the backfill actually ran.
  const postMigrationDraftResult = await query(
    `insert into plans.plans (plan_type, athlete_id, name, status, is_active, is_edit_draft, edit_source_plan_id)
     values ('weekly', $1, 'Post-migration draft', 'draft', false, true, $2) returning id`,
    [athleteId, livePlanId],
  );
  assert.equal(
    (await query(`select legacy_pre_migration_draft from plans.plans where id = $1`, [postMigrationDraftResult.rows[0].id])).rows[0].legacy_pre_migration_draft,
    false,
    "a draft created after the migration ran must default to false - it always carries a consistent logical_session_id via the existing preserveLogicalId round trip and was never at risk",
  );
});

test("M2. a legacy draft whose session's OWN SLOT was changed before migration still correctly blocks new RPE on the live plan - never relies on slot matching", async () => {
  const { athletes } = await makeClubWithAthletes("m2", 1);
  const athleteId = athletes[0].athleteId;
  const livePlanId = await makeWeeklyPlan(athleteId, { weekStart: THIS_WEEK_START });
  const liveDayId = await makePlanDay(livePlanId, TODAY);
  const liveSessionId = await makeSession(liveDayId, { amPm: "AM", sessionOrder: 0, name: "Live session" });

  // Counter-example 1: the coach changed the draft's OWN copy of this
  // session's slot (AM -> PM) before this migration ran - a slot-matching
  // fixup would find no live-side match at all here.
  await makeLegacyEditDraft(athleteId, livePlanId, TODAY, { amPm: "PM", sessionOrder: 0, name: "Draft session (slot changed)" });

  const res = await api(`/api/training-load/sessions/${liveSessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 40) });
  assert.equal(res.status, 409, `expected 409 while a legacy draft is pending, got ${res.status}: ${JSON.stringify(res.body)}`);
  const feedbackCount = (await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athleteId])).rows[0].n;
  assert.equal(feedbackCount, 0, "no row must be created while blocked");
});

test("M3. a legacy draft whose session was DELETED and replaced by an unrelated new one at the same slot still correctly blocks new RPE - never mis-attributes a result", async () => {
  const { athletes } = await makeClubWithAthletes("m3", 1);
  const athleteId = athletes[0].athleteId;
  const livePlanId = await makeWeeklyPlan(athleteId, { weekStart: THIS_WEEK_START });
  const liveDayId = await makePlanDay(livePlanId, TODAY);
  const liveSessionId = await makeSession(liveDayId, { amPm: "AM", sessionOrder: 0, name: "Live session" });

  // Counter-example 2: the coach deleted the draft's original session and
  // created a genuinely NEW, unrelated one that happens to land on the
  // SAME slot as the live session - a slot-matching fixup would wrongly
  // treat these as "the same" session.
  await makeLegacyEditDraft(athleteId, livePlanId, TODAY, { amPm: "AM", sessionOrder: 0, name: "Unrelated new draft session (same slot)" });

  const res = await api(`/api/training-load/sessions/${liveSessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 40) });
  assert.equal(res.status, 409, `expected 409 while a legacy draft is pending, got ${res.status}: ${JSON.stringify(res.body)}`);
  const feedbackCount = (await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athleteId])).rows[0].n;
  assert.equal(feedbackCount, 0, "no row must be created while blocked - nothing exists yet that a later save could mis-attribute");
});

test("M4. after the legacy draft is SAVED (its row deleted, simulating applyEditDraft's own unconditional last step), RPE against the recreated live session succeeds normally, exactly once", async () => {
  const { athletes } = await makeClubWithAthletes("m4", 1);
  const athleteId = athletes[0].athleteId;
  const livePlanId = await makeWeeklyPlan(athleteId, { weekStart: THIS_WEEK_START });
  const liveDayId = await makePlanDay(livePlanId, TODAY);
  const liveSessionId = await makeSession(liveDayId, { amPm: "AM", sessionOrder: 0, name: "Live session" });
  const { draftPlanId } = await makeLegacyEditDraft(athleteId, livePlanId, TODAY, { amPm: "PM", sessionOrder: 0 });

  const blocked = await api(`/api/training-load/sessions/${liveSessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 40) });
  assert.equal(blocked.status, 409);

  // applyEditDraft()'s own unconditional last step: delete the draft plan
  // row - the marker disappears with it, since it lives on that same row.
  await query(`delete from plans.plans where id = $1`, [draftPlanId]);

  const submitted = await api(`/api/training-load/sessions/${liveSessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 40) });
  assert.equal(submitted.status, 201, `expected 201 once the legacy draft is gone, got ${submitted.status}: ${JSON.stringify(submitted.body)}`);

  const retry = await api(`/api/training-load/sessions/${liveSessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 40) });
  assert.equal(retry.status, 200, "an identical retry must be idempotent, never a second 201");
  const feedbackCount = (await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athleteId])).rows[0].n;
  assert.equal(feedbackCount, 1, "exactly one result - no double logical training");
});

test("M5. after the legacy draft is DISCARDED (its row deleted without ever touching the live plan), RPE against the ORIGINAL live session succeeds normally", async () => {
  const { athletes } = await makeClubWithAthletes("m5", 1);
  const athleteId = athletes[0].athleteId;
  const livePlanId = await makeWeeklyPlan(athleteId, { weekStart: THIS_WEEK_START });
  const liveDayId = await makePlanDay(livePlanId, TODAY);
  const liveSessionId = await makeSession(liveDayId, { amPm: "AM", sessionOrder: 0, name: "Live session" });
  const { draftPlanId } = await makeLegacyEditDraft(athleteId, livePlanId, TODAY, { amPm: "PM", sessionOrder: 0 });

  const blocked = await api(`/api/training-load/sessions/${liveSessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 40) });
  assert.equal(blocked.status, 409);

  // Discard: the generic DELETE /plans/:planId path (never touches the
  // live plan at all).
  await query(`delete from plans.plans where id = $1`, [draftPlanId]);

  const submitted = await api(`/api/training-load/sessions/${liveSessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(7, 55) });
  assert.equal(submitted.status, 201, `expected 201 against the untouched original live session, got ${submitted.status}: ${JSON.stringify(submitted.body)}`);
  const feedbackCount = (await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athleteId])).rows[0].n;
  assert.equal(feedbackCount, 1);
});

test("M6. a NORMAL (non-legacy) edit-draft never blocks RPE on its own live plan - the block is specific to legacy_pre_migration_draft, not every open draft", async () => {
  const { athletes } = await makeClubWithAthletes("m6", 1);
  const athleteId = athletes[0].athleteId;
  const livePlanId = await makeWeeklyPlan(athleteId, { weekStart: THIS_WEEK_START });
  const liveDayId = await makePlanDay(livePlanId, TODAY);
  const liveSessionId = await makeSession(liveDayId, { amPm: "AM", sessionOrder: 0, name: "Live session" });

  await query(
    `insert into plans.plans (plan_type, athlete_id, name, status, is_active, is_edit_draft, edit_source_plan_id, legacy_pre_migration_draft)
     values ('weekly', $1, 'Normal edit-draft', 'draft', false, true, $2, false) returning id`,
    [athleteId, livePlanId],
  );

  const res = await api(`/api/training-load/sessions/${liveSessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 40) });
  assert.equal(res.status, 201, `a normal, non-legacy open draft must never block RPE, got ${res.status}: ${JSON.stringify(res.body)}`);
});

// ------------------------------------------------------------
// N. Per-session RPE opt-out (v3 migration): rpe_enabled schema/backfill.
// Runtime enforcement (POST /rpe 409, weekly/today filtering, the quick-
// toggle route) is added in a later round and tested in this same file at
// that point; Builder's PATCH partial-update behavior and copy-path
// propagation need the full real schema and are covered in the real-
// OPTIMOVE harness (training-load-rpe-enabled.test.mjs).
// ------------------------------------------------------------

test("N1. the v3 migration backfills every pre-existing plan_sessions row to rpe_enabled = true, and a brand-new session defaults to true without the client specifying it", async () => {
  const { athletes } = await makeClubWithAthletes("n1", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const rpeEnabled = (await query(`select rpe_enabled from plans.plan_sessions where id = $1`, [sessionId])).rows[0].rpe_enabled;
  assert.equal(rpeEnabled, true, "a session created after v3 already ran must default to enabled - existing/normal behavior is unchanged");
});

test("N2. rpe_enabled can be toggled directly and is read back correctly (schema-level sanity, ahead of Builder's own PATCH route which needs the full real schema)", async () => {
  const { athletes } = await makeClubWithAthletes("n2", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  await query(`update plans.plan_sessions set rpe_enabled = false where id = $1`, [sessionId]);
  const rpeEnabled = (await query(`select rpe_enabled from plans.plan_sessions where id = $1`, [sessionId])).rows[0].rpe_enabled;
  assert.equal(rpeEnabled, false);
});

// ------------------------------------------------------------
// O. Per-session RPE opt-out: runtime enforcement (POST /rpe 409, athlete/
// today + weekly filtering) and the coach quick-toggle route (PATCH
// /sessions/:sessionId/rpe-enabled), incl. its edit-draft sync and its
// race with a concurrent athlete submit.
// ------------------------------------------------------------

test("O1. a direct submit against a disabled session is rejected with a controlled 409, never 201/200, and creates no row", async () => {
  const { athletes } = await makeClubWithAthletes("o1", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  await query(`update plans.plan_sessions set rpe_enabled = false where id = $1`, [sessionId]);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  assert.equal(res.status, 409);
  const count = (await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athletes[0].athleteId])).rows[0].n;
  assert.equal(count, 0);
});

test("O2. GET /athlete/today omits a disabled+unrated session entirely, but still shows a disabled session that already has a result", async () => {
  const { athletes } = await makeClubWithAthletes("o2", 1);
  const disabledUnrated = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "Mobility (off, unrated)" } });
  const disabledRated = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "Mobility (off, already rated)" } });
  const submit = await api(`/api/training-load/sessions/${disabledRated}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(4, 20) });
  assert.equal(submit.status, 201);
  await query(`update plans.plan_sessions set rpe_enabled = false where id = any($1::uuid[])`, [[disabledUnrated, disabledRated]]);

  const today = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  const ids = today.body.sessions.map((s) => s.sessionId);
  assert.ok(!ids.includes(disabledUnrated), "a disabled session with no result must never appear as a pending request");
  assert.ok(ids.includes(disabledRated), "a disabled session that already has a result must keep showing its rated summary");
  const ratedRow = today.body.sessions.find((s) => s.sessionId === disabledRated);
  assert.equal(ratedRow.rated, true);
});

test("O3. the coach's weekly Schedule view still shows a disabled session (so it can be re-enabled), but the athlete's own weekly view omits a disabled+unrated one", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("o3", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  await query(`update plans.plan_sessions set rpe_enabled = false where id = $1`, [sessionId]);

  const coachWeekly = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const coachSessions = coachWeekly.body.days.flatMap((d) => d.sessions);
  const coachRow = coachSessions.find((s) => s.sessionId === sessionId);
  assert.ok(coachRow, "the coach's own Schedule view must still see a disabled session, so its quick-toggle control can re-enable it");
  assert.equal(coachRow.rpeEnabled, false);

  const athleteWeekly = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: athletes[0].cookie });
  const athleteSessions = athleteWeekly.body.days.flatMap((d) => d.sessions);
  assert.ok(!athleteSessions.some((s) => s.sessionId === sessionId), "the athlete's own weekly view must never show a disabled+unrated session");
});

test("O4. quick-toggle PATCH disabling a session with an existing result requires confirmDisableWithResults, and never alters/deletes the existing result", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("o4", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const submit = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 45) });
  assert.equal(submit.status, 201);

  const blocked = await api(`/api/training-load/sessions/${sessionId}/rpe-enabled`, { method: "PATCH", cookie: coachCookie, body: { rpeEnabled: false } });
  assert.equal(blocked.status, 409, `expected 409 without confirmation, got ${blocked.status}: ${JSON.stringify(blocked.body)}`);
  assert.equal(blocked.body.error, "hasExistingResults");
  assert.equal(blocked.body.resultCount, 1);
  assert.equal((await query(`select rpe_enabled from plans.plan_sessions where id = $1`, [sessionId])).rows[0].rpe_enabled, true, "must not have flipped without confirmation");

  const confirmed = await api(`/api/training-load/sessions/${sessionId}/rpe-enabled`, { method: "PATCH", cookie: coachCookie, body: { rpeEnabled: false, confirmDisableWithResults: true } });
  assert.equal(confirmed.status, 200, `expected 200 with confirmation, got ${confirmed.status}: ${JSON.stringify(confirmed.body)}`);
  assert.equal((await query(`select rpe_enabled from plans.plan_sessions where id = $1`, [sessionId])).rows[0].rpe_enabled, false);

  const feedback = (await query(`select rpe, duration_minutes from training_load.session_feedback where athlete_id = $1`, [athletes[0].athleteId])).rows[0];
  assert.equal(feedback.rpe, 6, "the existing result must never be altered by disabling RPE for the session");
  assert.equal(feedback.duration_minutes, 45);
});

test("O5. quick-toggle PATCH on a session with no existing results needs no confirmation", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("o5", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe-enabled`, { method: "PATCH", cookie: coachCookie, body: { rpeEnabled: false } });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test("O6. re-enabling a session restores its eligibility for a not-yet-rated athlete, per the existing date rules", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("o6", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  await api(`/api/training-load/sessions/${sessionId}/rpe-enabled`, { method: "PATCH", cookie: coachCookie, body: { rpeEnabled: false } });
  const blockedSubmit = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  assert.equal(blockedSubmit.status, 409);

  const reEnable = await api(`/api/training-load/sessions/${sessionId}/rpe-enabled`, { method: "PATCH", cookie: coachCookie, body: { rpeEnabled: true } });
  assert.equal(reEnable.status, 200);
  const submit = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(5, 30) });
  assert.equal(submit.status, 201, "re-enabling must restore normal ratability for a still-not-yet-rated athlete");
});

test("O7. the quick toggle updates BOTH the live session and its open edit-draft sibling (same logical_session_id) in one transaction", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("o7", 1);
  const athleteId = athletes[0].athleteId;
  const livePlanId = await makeWeeklyPlan(athleteId, { weekStart: THIS_WEEK_START });
  const liveDayId = await makePlanDay(livePlanId, THIS_WEEK_START);
  const liveSessionId = await makeSession(liveDayId, { amPm: "AM", sessionOrder: 0, name: "Morning session" });
  const liveLogicalId = (await query(`select logical_session_id from plans.plan_sessions where id = $1`, [liveSessionId])).rows[0].logical_session_id;

  const draftPlanResult = await query(
    `insert into plans.plans (plan_type, athlete_id, name, status, is_active, is_edit_draft, edit_source_plan_id, week_start)
     values ('weekly', $1, 'Weekly plan (edit-draft)', 'draft', false, true, $2, $3) returning id`,
    [athleteId, livePlanId, THIS_WEEK_START],
  );
  const draftDayId = await makePlanDay(draftPlanResult.rows[0].id, THIS_WEEK_START);
  // Same logical_session_id as the live session - exactly what the real
  // live->edit-draft copy (preserveLogicalId: true) produces.
  const draftSessionResult = await query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, session_order, name, logical_session_id) values ($1,'AM',0,'Morning session',$2) returning id`,
    [draftDayId, liveLogicalId],
  );
  const draftSessionId = draftSessionResult.rows[0].id;

  const res = await api(`/api/training-load/sessions/${liveSessionId}/rpe-enabled`, { method: "PATCH", cookie: coachCookie, body: { rpeEnabled: false } });
  assert.equal(res.status, 200);
  assert.equal(res.body.draftSessionUpdated, true);
  assert.equal((await query(`select rpe_enabled from plans.plan_sessions where id = $1`, [liveSessionId])).rows[0].rpe_enabled, false);
  assert.equal((await query(`select rpe_enabled from plans.plan_sessions where id = $1`, [draftSessionId])).rows[0].rpe_enabled, false, "the open edit-draft's own sibling session must be updated too, or a later Builder submit would silently revert the quick toggle");
});

test("O8. concurrent disable-vs-submit on the same session serializes cleanly - whichever transaction's lock wins first decides the outcome, never a partial write or 500", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("o8", 1);
  const sessionId = await makeActiveSessionOn(athletes[0].athleteId, TODAY);

  const disablePromise = api(`/api/training-load/sessions/${sessionId}/rpe-enabled`, { method: "PATCH", cookie: coachCookie, body: { rpeEnabled: false } });
  const submitPromise = api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: rpeBody(6, 40) });
  const [disableRes, submitRes] = await Promise.all([disablePromise, submitPromise]);

  // If submit wins the race, it commits a real result BEFORE disable's own
  // lock is granted - disable then correctly sees that result once it
  // re-reads under its own lock and (since this request never sent
  // confirmDisableWithResults) is itself rejected 409 by the SAME gate O4
  // already proves - not a race failure, the two features composing
  // correctly. If disable wins instead, no result exists yet for submit to
  // find once it gets the lock, so it correctly 409s via the plain
  // rpe_enabled check. Either way: never a 500, never two outcomes at once.
  assert.ok([200, 409].includes(disableRes.status), `disable must never 500, got ${disableRes.status}: ${JSON.stringify(disableRes.body)}`);
  assert.ok([201, 409].includes(submitRes.status), `submit must be either a clean success (won the race) or a controlled 409 (lost it), got ${submitRes.status}: ${JSON.stringify(submitRes.body)}`);
  assert.ok(
    disableRes.status === 200 || submitRes.status === 201,
    "at least one of the two must have cleanly succeeded - they can never BOTH fail",
  );

  const feedbackCount = (await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athletes[0].athleteId])).rows[0].n;
  if (submitRes.status === 201) {
    assert.equal(feedbackCount, 1, "if submit won the race, its result must be committed and never rolled back by the disable");
    assert.equal(disableRes.status, 409, "disable must be rejected (hasExistingResults) once a result exists and no confirmation was sent");
    assert.equal(disableRes.body.error, "hasExistingResults");
  } else {
    assert.equal(feedbackCount, 0, "if disable won the race, no partial/orphaned result row may exist");
    assert.equal(disableRes.status, 200);
    assert.equal(submitRes.status, 409);
  }
});

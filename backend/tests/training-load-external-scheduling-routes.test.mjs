// Training load: external scheduling API ROUTES (create/list/detail/
// update/pause/resume/cancel/schedule-again, athlete submit, and the
// GET /weekly + GET /athlete/today extension for the external source).
// Same disposable-DB harness convention as training-load.test.mjs - a
// uniquely-named temp database, the real Strategy B runner, the real
// Express app driven over real HTTP with real session cookies. Schema-
// level invariants (CHECK constraints, triggers, occurrence/assignment
// generation correctness, timezone regression) are already covered in
// training-load-external-scheduling.test.mjs; this file is scoped to the
// API surface built on top of that schema.
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
const MIGRATIONS = [
  ["202608310900_training_load_v1_session_feedback.sql"],
  ["202608320900_training_load_v2_logical_session_identity.sql"],
  ["202609010900_training_load_v3_rpe_enabled.sql"],
  ["202609011000_training_load_v4_external_scheduling.sql"],
  ["202609011100_training_load_v5_unified_result_source.sql"],
].map(([name]) => ({ name, path: path.resolve(__dirname, `../../migrations_v2/${name}`) }));

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
    add column rpe_enabled boolean not null default true,
    add column created_at timestamptz not null default now(),
    add column updated_at timestamptz not null default now();
`;

async function makeTempDb(label) {
  const name = `optimove_tests_tlroutes_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_tlroutes_migrations_${runId}`);
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
  const contents = await Promise.all(MIGRATIONS.map((m) => fsp.readFile(m.path, "utf8")));
  const files = {};
  MIGRATIONS.forEach((m, i) => { files[m.name] = contents[i]; });

  db = await makeTempDb("primary");
  adminClient = new pg.Client({ connectionString: db.url });
  await adminClient.connect();
  const ownCheck = await adminClient.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");

  await adminClient.query(LEGACY_FIXTURE_SQL);
  migrationsDir = await writeMigrationsDir("primary", files);
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
function cookieFor(token) { return `optimove_session=${token}`; }
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
async function makeAthlete({ name, userId = null, deviceTimezone = "UTC" }) {
  const result = await query(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,$2,$2,$3) returning id`, [userId, name, deviceTimezone]);
  return result.rows[0].id;
}
async function grantClubAdmin(userId, clubId) {
  await query(`insert into public.user_club_roles (user_id, club_id, role) values ($1,$2,'club_admin')`, [userId, clubId]);
}
async function loginCookie(userId) {
  const token = await createSession(userId);
  return cookieFor(token);
}
async function setActiveWorkspace(userId, type, scopeId = null) {
  await query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id, updated_at) values ($1,$2,$3,now())
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id, updated_at = now()`,
    [userId, type, scopeId],
  );
}
async function makeClubWithAthletes(label, count, { deviceTimezone = "UTC" } = {}) {
  const clubId = await makeClub(`${label} Club`);
  const coachId = await makeUser({ email: `${label}-coach-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local` });
  await grantClubAdmin(coachId, clubId);
  const coachCookie = await loginCookie(coachId);
  const athletes = [];
  for (let i = 0; i < count; i += 1) {
    const userId = await makeUser({ email: `${label}-athlete${i}-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local`, roleHint: "athlete" });
    const athleteId = await makeAthlete({ name: `${label} Athlete ${i}`, userId, deviceTimezone });
    await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
    athletes.push({ athleteId, userId, cookie: await loginCookie(userId) });
  }
  return { clubId, coachId, coachCookie, athletes };
}

const TODAY = new Date().toISOString().slice(0, 10);
function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function mondayOfIso(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}
const THIS_WEEK_START = mondayOfIso(TODAY);

function scheduleBody(overrides = {}) {
  return {
    eventName: "National team camp",
    scheduleKind: "one_time",
    timezone: "UTC",
    startDate: TODAY,
    opensTime: "00:00",
    closesTime: "23:59",
    targets: [],
    ...overrides,
  };
}

// ------------------------------------------------------------
// A. Create - Dates (one_time, incl. multi-date bulk) and Daily (recurring)
// ------------------------------------------------------------

test("A1. creating a one_time schedule for a single date, targeting one athlete directly", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("a1", 1);
  const res = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ targets: [{ kind: "athlete", id: athletes[0].athleteId }] }) });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.schedules.length, 1);
  assert.equal(res.body.schedules[0].scheduleKind, "one_time");
  assert.equal(res.body.schedules[0].startDate, TODAY);
});

test("A2. creating with a `dates` array (Dates/multi mode) creates one one_time schedule PER date, sharing the same targets/settings", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("a2", 1);
  const dates = [TODAY, addDaysIso(TODAY, 3), addDaysIso(TODAY, 7)];
  const res = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ dates, targets: [{ kind: "athlete", id: athletes[0].athleteId }] }) });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.schedules.length, 3);
  assert.deepEqual(res.body.schedules.map((s) => s.startDate).sort(), dates.sort());
  for (const schedule of res.body.schedules) assert.equal(schedule.scheduleKind, "one_time");
});

test("A3. creating a recurring (Daily) schedule with a start/end range", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("a3", 1);
  const res = await api("/api/training-load/external-schedules", {
    method: "POST", cookie: coachCookie,
    body: scheduleBody({ scheduleKind: "recurring", startDate: TODAY, endDate: addDaysIso(TODAY, 14), targets: [{ kind: "athlete", id: athletes[0].athleteId }] }),
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.schedules[0].scheduleKind, "recurring");
  assert.equal(res.body.schedules[0].endDate, addDaysIso(TODAY, 14));
});

test("A4. Club/Team/Athlete recipient union - a schedule can target all three kinds at once", async () => {
  const { coachCookie, clubId, athletes } = await makeClubWithAthletes("a4", 1);
  const teamId = await makeTeam(clubId, "A4 Team");
  const otherAthleteId = await makeAthlete({ name: "A4 Other" });
  const res = await api("/api/training-load/external-schedules", {
    method: "POST", cookie: coachCookie,
    body: scheduleBody({ targets: [{ kind: "athlete", id: athletes[0].athleteId }, { kind: "team", id: teamId }, { kind: "club", id: clubId }] }),
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  const detail = await api(`/api/training-load/external-schedules/${res.body.schedules[0].id}`, { cookie: coachCookie });
  assert.equal(detail.body.targets.length, 3);
});

test("A5. workspace authorization: a coach cannot target a club/team/athlete outside their own access - the WHOLE request is rejected, nothing is created", async () => {
  const groupA = await makeClubWithAthletes("a5a", 1);
  const groupB = await makeClubWithAthletes("a5b", 1);
  const res = await api("/api/training-load/external-schedules", {
    method: "POST", cookie: groupA.coachCookie,
    body: scheduleBody({ targets: [{ kind: "athlete", id: groupA.athletes[0].athleteId }, { kind: "athlete", id: groupB.athletes[0].athleteId }] }),
  });
  assert.equal(res.status, 403);
  const count = (await query(`select count(*)::int as n from training_load.external_schedules where created_by_user_id = $1`, [groupA.coachId])).rows[0].n;
  assert.equal(count, 0, "no partial acceptance - the whole request must be rejected, nothing created by this coach");
});

test("A6. a plain user (no coach workspace) cannot create an external schedule", async () => {
  const userId = await makeUser({ email: `a6-user-${Date.now()}@test.local` });
  const cookie = await loginCookie(userId);
  const res = await api("/api/training-load/external-schedules", { method: "POST", cookie, body: scheduleBody({ targets: [] }) });
  assert.equal(res.status, 403);
});

// ------------------------------------------------------------
// B. List/detail/update/pause/resume/cancel/schedule-again
// ------------------------------------------------------------

test("B1. a coach only sees schedules within their own workspace access", async () => {
  const groupA = await makeClubWithAthletes("b1a", 1);
  const groupB = await makeClubWithAthletes("b1b", 1);
  await api("/api/training-load/external-schedules", { method: "POST", cookie: groupA.coachCookie, body: scheduleBody({ eventName: "A's camp", targets: [{ kind: "athlete", id: groupA.athletes[0].athleteId }] }) });
  await api("/api/training-load/external-schedules", { method: "POST", cookie: groupB.coachCookie, body: scheduleBody({ eventName: "B's camp", targets: [{ kind: "athlete", id: groupB.athletes[0].athleteId }] }) });
  const list = await api("/api/training-load/external-schedules", { cookie: groupA.coachCookie });
  assert.equal(list.status, 200);
  assert.ok(list.body.schedules.every((s) => s.eventName !== "B's camp"), "must never see another coach's schedule outside their own access");
  assert.ok(list.body.schedules.some((s) => s.eventName === "A's camp"));
});

test("B2. PATCH updates fields and replaces targets; a coach outside access gets a 404, never a 403 (info-hiding, matching the rest of this module)", async () => {
  const groupA = await makeClubWithAthletes("b2a", 1);
  const groupB = await makeClubWithAthletes("b2b", 1);
  const created = await api("/api/training-load/external-schedules", { method: "POST", cookie: groupA.coachCookie, body: scheduleBody({ targets: [{ kind: "athlete", id: groupA.athletes[0].athleteId }] }) });
  const scheduleId = created.body.schedules[0].id;

  const patched = await api(`/api/training-load/external-schedules/${scheduleId}`, { method: "PATCH", cookie: groupA.coachCookie, body: { eventName: "Renamed camp" } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.schedule.eventName, "Renamed camp");

  const outside = await api(`/api/training-load/external-schedules/${scheduleId}`, { method: "PATCH", cookie: groupB.coachCookie, body: { eventName: "Hijacked" } });
  assert.equal(outside.status, 404);
});

test("B3. pause -> resume round trip, and cancel is terminal (cannot re-cancel with a controlled error, never a 500)", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b3", 1);
  const created = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ targets: [{ kind: "athlete", id: athletes[0].athleteId }] }) });
  const scheduleId = created.body.schedules[0].id;

  const paused = await api(`/api/training-load/external-schedules/${scheduleId}/pause`, { method: "POST", cookie: coachCookie });
  assert.equal(paused.body.schedule.status, "paused");
  const resumed = await api(`/api/training-load/external-schedules/${scheduleId}/resume`, { method: "POST", cookie: coachCookie });
  assert.equal(resumed.body.schedule.status, "active");
  const cancelled = await api(`/api/training-load/external-schedules/${scheduleId}/cancel`, { method: "POST", cookie: coachCookie });
  assert.equal(cancelled.body.schedule.status, "cancelled");
  const cancelledAgain = await api(`/api/training-load/external-schedules/${scheduleId}/cancel`, { method: "POST", cookie: coachCookie });
  assert.equal(cancelledAgain.status, 400, "cancelling an already-cancelled schedule must be a controlled error, never a 500");
});

test("B4. Schedule again creates a genuinely NEW schedule (never mutates the original), copying settings/targets but requiring a new date and never copying occurrences/assignments/responses/history", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b4", 1);
  const created = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ eventName: "Original camp", targets: [{ kind: "athlete", id: athletes[0].athleteId }] }) });
  const originalId = created.body.schedules[0].id;
  await api(`/api/training-load/external-schedules/${originalId}/cancel`, { method: "POST", cookie: coachCookie });

  const again = await api(`/api/training-load/external-schedules/${originalId}/schedule-again`, { method: "POST", cookie: coachCookie, body: { startDate: addDaysIso(TODAY, 30) } });
  assert.equal(again.status, 201, `expected 201, got ${again.status}: ${JSON.stringify(again.body)}`);
  const newId = again.body.schedule.id;
  assert.notEqual(newId, originalId, "a genuinely new schedule row, not a reactivation of the original");
  assert.equal(again.body.schedule.status, "active", "the new schedule starts active regardless of the original's (now cancelled) status");
  assert.equal(again.body.schedule.eventName, "Original camp");
  assert.equal(again.body.schedule.startDate, addDaysIso(TODAY, 30));

  const originalFresh = await api(`/api/training-load/external-schedules/${originalId}`, { cookie: coachCookie });
  assert.equal(originalFresh.body.schedule.status, "cancelled", "the original must remain untouched (still cancelled)");

  const occurrenceCount = (await query(`select count(*)::int as n from training_load.external_schedule_occurrences where schedule_id = $1`, [newId])).rows[0].n;
  assert.equal(occurrenceCount, 0, "Schedule again must never copy occurrences/history onto the new schedule");
});

// ------------------------------------------------------------
// C. Athlete submit
// ------------------------------------------------------------

async function makeReadyAssignment(label, { deviceTimezone = "UTC" } = {}) {
  const { coachCookie, athletes } = await makeClubWithAthletes(label, 1, { deviceTimezone });
  const created = await api("/api/training-load/external-schedules", {
    method: "POST", cookie: coachCookie,
    body: scheduleBody({ opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "athlete", id: athletes[0].athleteId }] }),
  });
  const scheduleId = created.body.schedules[0].id;
  // Trigger on-demand occurrence/assignment generation via a real athlete
  // GET, exactly the path a real Athlete Home visit would take.
  const today = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  const externalRow = today.body.sessions.find((s) => s.source === "scheduled_external");
  assert.ok(externalRow, `expected an external assignment to have materialized for today, got: ${JSON.stringify(today.body)}`);
  return { coachCookie, athlete: athletes[0], scheduleId, assignmentId: externalRow.externalAssignmentId };
}

test("C1. a real submit inserts exactly one session_feedback row, source='scheduled_external', with the DB-derived sRPE", async () => {
  const { athlete, assignmentId } = await makeReadyAssignment("c1");
  const res = await api(`/api/training-load/external-assignments/${assignmentId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 7, durationMinutes: 60 } });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.feedback.srpe, 420, "sRPE must be DB-derived (7*60), never client-supplied");
  const row = (await query(`select source, external_assignment_id, logical_session_id from training_load.session_feedback where athlete_id = $1`, [athlete.athleteId])).rows[0];
  assert.equal(row.source, "scheduled_external");
  assert.equal(row.external_assignment_id, assignmentId);
  assert.equal(row.logical_session_id, null, "the XOR identity - an external row must never carry a logical_session_id");
});

test("C2. an identical retry is a silent idempotent 200; a genuinely different retry is 409, never a silent overwrite", async () => {
  const { athlete, assignmentId } = await makeReadyAssignment("c2");
  const first = await api(`/api/training-load/external-assignments/${assignmentId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 30 } });
  assert.equal(first.status, 201);
  const retrySame = await api(`/api/training-load/external-assignments/${assignmentId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 30 } });
  assert.equal(retrySame.status, 200);
  const retryDifferent = await api(`/api/training-load/external-assignments/${assignmentId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 9, durationMinutes: 90 } });
  assert.equal(retryDifferent.status, 409);
  const count = (await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athlete.athleteId])).rows[0].n;
  assert.equal(count, 1);
});

test("C3. an athlete can never submit RPE for someone else's assignment (IDOR) - a controlled 404", async () => {
  const a = await makeReadyAssignment("c3a");
  const b = await makeReadyAssignment("c3b");
  const res = await api(`/api/training-load/external-assignments/${a.assignmentId}/rpe`, { method: "POST", cookie: b.athlete.cookie, body: { rpe: 5, durationMinutes: 30 } });
  assert.equal(res.status, 404);
});

test("C4. submitting against a PAUSED schedule is rejected with a controlled 409", async () => {
  const { coachCookie, scheduleId, athlete, assignmentId } = await makeReadyAssignment("c4");
  await api(`/api/training-load/external-schedules/${scheduleId}/pause`, { method: "POST", cookie: coachCookie });
  const res = await api(`/api/training-load/external-assignments/${assignmentId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 30 } });
  assert.equal(res.status, 409);
});

test("C5. submitting against a CANCELLED schedule is rejected with a controlled 409", async () => {
  const { coachCookie, scheduleId, athlete, assignmentId } = await makeReadyAssignment("c5");
  await api(`/api/training-load/external-schedules/${scheduleId}/cancel`, { method: "POST", cookie: coachCookie });
  const res = await api(`/api/training-load/external-assignments/${assignmentId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 30 } });
  assert.equal(res.status, 409);
});

test("C6. submitting outside the assignment's own opens_at/closes_at window is rejected with a controlled 409", async () => {
  const { athlete, assignmentId } = await makeReadyAssignment("c6");
  // The assignment's own window is immutable once materialized (by design
  // - see protect_external_assignment_identity_and_lifecycle), so a
  // "closed" assignment for this test is constructed via a fresh INSERT
  // (never reachable by an UPDATE) for a second athlete under the SAME
  // occurrence, with an already-past window from the start.
  const occurrenceId = (await query(`select occurrence_id from training_load.external_assignments where id = $1`, [assignmentId])).rows[0].occurrence_id;
  const closedAthleteUserId = await makeUser({ email: `c6-closed-${Date.now()}@test.local`, roleHint: "athlete" });
  const closedAthleteId = await makeAthlete({ name: "C6 Closed Athlete", userId: closedAthleteUserId });
  const closedCookie = await loginCookie(closedAthleteUserId);
  const closedAssignmentResult = await query(
    `insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, due_at, closes_at)
     values ($1,$2,'UTC',$3, now() - interval '2 hours', null, now() - interval '1 hour') returning id`,
    [occurrenceId, closedAthleteId, TODAY],
  );
  const closedAssignmentId = closedAssignmentResult.rows[0].id;
  const res = await api(`/api/training-load/external-assignments/${closedAssignmentId}/rpe`, { method: "POST", cookie: closedCookie, body: { rpe: 5, durationMinutes: 30 } });
  assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test("C7. a malformed assignmentId is a controlled 404, never a raw Postgres 500", async () => {
  const { athlete } = await makeReadyAssignment("c7");
  const res = await api(`/api/training-load/external-assignments/not-a-real-uuid/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 30 } });
  assert.equal(res.status, 404);
});

// ------------------------------------------------------------
// D. GET /weekly - unified aggregation, no side effects, local-date grouping
// ------------------------------------------------------------

test("D1. planned and external results appear together in the SAME days[].sessions[] array, tagged by source, and never duplicated", async () => {
  const { coachCookie, scheduleId, athlete, assignmentId } = await makeReadyAssignment("d1");
  await api(`/api/training-load/external-assignments/${assignmentId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 6, durationMinutes: 40 } });

  const weekly = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const allSessions = weekly.body.days.flatMap((d) => d.sessions);
  const externalRows = allSessions.filter((s) => s.source === "scheduled_external" && s.externalAssignmentId === assignmentId);
  assert.equal(externalRows.length, 1, "the external result must appear exactly once, never duplicated");
  assert.equal(externalRows[0].rated, true);
  assert.equal(externalRows[0].feedback.srpe, 240);
});

test("D2. a coach's weekly view is workspace-scoped for external assignments too - an athlete outside the coach's access never appears", async () => {
  const inClub = await makeReadyAssignment("d2in");
  const outsideClub = await makeClubWithAthletes("d2out", 1);
  await api(`/api/training-load/external-assignments/${inClub.assignmentId}/rpe`, { method: "POST", cookie: inClub.athlete.cookie, body: { rpe: 5, durationMinutes: 30 } });

  const weekly = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: outsideClub.coachCookie });
  const allSessions = weekly.body.days.flatMap((d) => d.sessions);
  assert.ok(!allSessions.some((s) => s.athleteId === inClub.athlete.athleteId), "an athlete outside the coach's workspace must never appear, planned or external");
});

test("D3. browsing the weekly view is a pure read - no occurrence/assignment/session_feedback row is created just by looking, beyond what on-demand generation already materialized once", async () => {
  const { coachCookie } = await makeReadyAssignment("d3");
  const beforeOccurrences = (await query(`select count(*)::int as n from training_load.external_schedule_occurrences`)).rows[0].n;
  const beforeAssignments = (await query(`select count(*)::int as n from training_load.external_assignments`)).rows[0].n;
  const beforeFeedback = (await query(`select count(*)::int as n from training_load.session_feedback`)).rows[0].n;

  await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  await api(`/api/training-load/weekly?weekStart=${addDaysIso(THIS_WEEK_START, 70)}`, { cookie: coachCookie });

  const afterOccurrences = (await query(`select count(*)::int as n from training_load.external_schedule_occurrences`)).rows[0].n;
  const afterAssignments = (await query(`select count(*)::int as n from training_load.external_assignments`)).rows[0].n;
  const afterFeedback = (await query(`select count(*)::int as n from training_load.session_feedback`)).rows[0].n;
  assert.equal(afterOccurrences, beforeOccurrences, "repeated GETs of the same/other weeks must not create new occurrences beyond on-demand generation's own idempotent behavior");
  assert.equal(afterAssignments, beforeAssignments);
  assert.equal(afterFeedback, beforeFeedback, "a pure read must never create a result row");
});

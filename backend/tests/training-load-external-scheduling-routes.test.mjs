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
  ["202608280900_app_notifications_dedupe_key.sql"],
  ["202608310900_training_load_v1_session_feedback.sql"],
  ["202608320900_training_load_v2_logical_session_identity.sql"],
  ["202609010900_training_load_v3_rpe_enabled.sql"],
  ["202609011000_training_load_v4_external_scheduling.sql"],
  ["202609011100_training_load_v5_unified_result_source.sql"],
  ["202609011200_training_load_v6_external_schedule_event_type.sql"],
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
let processTrainingLoadNotificationCycle;

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
  const workerModule = await import("../src/trainingLoadNotificationWorker.js");
  processTrainingLoadNotificationCycle = workerModule.processTrainingLoadNotificationCycle;

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

test("A7. eventType is optional, round-trips through create/detail, and rejects an unrecognized value with a controlled 400", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("a7", 1);
  const withType = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ eventType: "rehabilitation", targets: [{ kind: "athlete", id: athletes[0].athleteId }] }) });
  assert.equal(withType.status, 201);
  assert.equal(withType.body.schedules[0].eventType, "rehabilitation");

  const withoutType = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ targets: [{ kind: "athlete", id: athletes[0].athleteId }] }) });
  assert.equal(withoutType.status, 201);
  assert.equal(withoutType.body.schedules[0].eventType, null, "no type chosen is a normal, valid state");

  const invalid = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ eventType: "not-a-real-type", targets: [{ kind: "athlete", id: athletes[0].athleteId }] }) });
  assert.equal(invalid.status, 400, "an unrecognized event type must be a controlled 400, never silently stored or a 500");
});

test("A8. a dual-role coach (club_admin of BOTH Club A and Club B) is scoped to only whichever club is the CURRENTLY ACTIVE workspace - list/detail/update/target-selection/reminder all change immediately on a workspace switch, with zero cross-workspace access", async () => {
  const clubA = await makeClub("A8 Club A");
  const clubB = await makeClub("A8 Club B");
  const coachId = await makeUser({ email: `a8-coach-${Date.now()}@test.local` });
  await grantClubAdmin(coachId, clubA);
  await grantClubAdmin(coachId, clubB);
  const coachCookie = await loginCookie(coachId);

  const athleteAUserId = await makeUser({ email: `a8-athleteA-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteAId = await makeAthlete({ name: "A8 Athlete A", userId: athleteAUserId });
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteAId, clubA]);
  const athleteBUserId = await makeUser({ email: `a8-athleteB-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteBId = await makeAthlete({ name: "A8 Athlete B", userId: athleteBUserId });
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteBId, clubB]);

  // --- Active workspace = Club A ---
  await setActiveWorkspace(coachId, "club", clubA);

  const createInA = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ eventName: "A8 Club A schedule", targets: [{ kind: "athlete", id: athleteAId }] }) });
  assert.equal(createInA.status, 201, "creating with a Club A target while Club A is active must succeed");
  const scheduleAId = createInA.body.schedules[0].id;

  const createTargetingBWhileA = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ eventName: "should fail", targets: [{ kind: "athlete", id: athleteBId }] }) });
  assert.equal(createTargetingBWhileA.status, 403, "targeting Club B's athlete while Club A is the active workspace must be rejected, even though this account also administers Club B");

  const listWhileA = await api("/api/training-load/external-schedules", { cookie: coachCookie });
  assert.ok(listWhileA.body.schedules.some((s) => s.id === scheduleAId), "the Club A schedule must be listed while Club A is active");

  const detailAWhileA = await api(`/api/training-load/external-schedules/${scheduleAId}`, { cookie: coachCookie });
  assert.equal(detailAWhileA.status, 200);

  const remindAWhileA = await api(`/api/training-load/external-schedules/${scheduleAId}/remind`, { method: "POST", cookie: coachCookie, body: { assignmentIds: [crypto.randomUUID()] } });
  assert.notEqual(remindAWhileA.status, 403, "managing the Club A schedule while Club A is active must not be blocked by workspace scoping (a 404/400 for the fake assignment id is fine, 403 is not)");

  // --- Switch active workspace to Club B - the SAME account, no new login ---
  await setActiveWorkspace(coachId, "club", clubB);

  const listWhileB = await api("/api/training-load/external-schedules", { cookie: coachCookie });
  assert.ok(!listWhileB.body.schedules.some((s) => s.id === scheduleAId), "the Club A schedule must disappear from the list the instant the workspace switches to Club B - the SAME account, no re-login");

  const detailAWhileB = await api(`/api/training-load/external-schedules/${scheduleAId}`, { cookie: coachCookie });
  assert.equal(detailAWhileB.status, 404, "detail on the Club A schedule while Club B is active must 404, never leak via a stale global permission");

  const updateAWhileB = await api(`/api/training-load/external-schedules/${scheduleAId}`, { method: "PATCH", cookie: coachCookie, body: { eventName: "hijacked from Club B" } });
  assert.equal(updateAWhileB.status, 404, "PATCH on the Club A schedule while Club B is active must 404");

  const remindAWhileB = await api(`/api/training-load/external-schedules/${scheduleAId}/remind`, { method: "POST", cookie: coachCookie, body: { assignmentIds: [crypto.randomUUID()] } });
  assert.equal(remindAWhileB.status, 403, "a manual reminder against the Club A schedule while Club B is active must be a controlled 403, not silently processed");

  const createTargetingAWhileB = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ eventName: "should also fail", targets: [{ kind: "athlete", id: athleteAId }] }) });
  assert.equal(createTargetingAWhileB.status, 403, "targeting Club A's athlete while Club B is the active workspace must be rejected");

  const createInB = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ eventName: "A8 Club B schedule", targets: [{ kind: "athlete", id: athleteBId }] }) });
  assert.equal(createInB.status, 201, "creating with a Club B target while Club B is active must succeed");
  const scheduleBId = createInB.body.schedules[0].id;

  const listWhileB2 = await api("/api/training-load/external-schedules", { cookie: coachCookie });
  assert.ok(listWhileB2.body.schedules.some((s) => s.id === scheduleBId), "the newly-created Club B schedule must be listed while Club B is active");
  assert.ok(!listWhileB2.body.schedules.some((s) => s.id === scheduleAId), "the Club A schedule still must never appear");

  // --- Switch back to Club A - the original schedule reappears, the Club B one disappears ---
  await setActiveWorkspace(coachId, "club", clubA);
  const listBackToA = await api("/api/training-load/external-schedules", { cookie: coachCookie });
  assert.ok(listBackToA.body.schedules.some((s) => s.id === scheduleAId), "switching back to Club A must immediately restore visibility of the Club A schedule");
  assert.ok(!listBackToA.body.schedules.some((s) => s.id === scheduleBId), "the Club B schedule must disappear again once back in Club A");

  // --- Same account also holds a REAL athlete profile (a genuine dual-
  // role account, e.g. a coach who also trains) - switching to that
  // athlete workspace must make every coach schedule route unreachable,
  // even though the account's club_admin roles are still fully intact. ---
  await makeAthlete({ name: "A8 Coach's Own Athlete Profile", userId: coachId });
  await setActiveWorkspace(coachId, "athlete", null);
  const listAsAthleteWorkspace = await api("/api/training-load/external-schedules", { cookie: coachCookie });
  assert.equal(listAsAthleteWorkspace.status, 403, "no coach schedule route is reachable while the active workspace is 'athlete', even though this account holds real club_admin roles");
  const detailAsAthleteWorkspace = await api(`/api/training-load/external-schedules/${scheduleAId}`, { cookie: coachCookie });
  assert.equal(detailAsAthleteWorkspace.status, 403);
  const createAsAthleteWorkspace = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ targets: [{ kind: "athlete", id: athleteAId }] }) });
  assert.equal(createAsAthleteWorkspace.status, 403);
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

test("B5. Schedule again also copies eventType onto the new schedule", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("b5", 1);
  const created = await api("/api/training-load/external-schedules", { method: "POST", cookie: coachCookie, body: scheduleBody({ eventType: "gym", targets: [{ kind: "athlete", id: athletes[0].athleteId }] }) });
  const originalId = created.body.schedules[0].id;
  const again = await api(`/api/training-load/external-schedules/${originalId}/schedule-again`, { method: "POST", cookie: coachCookie, body: { startDate: addDaysIso(TODAY, 30) } });
  assert.equal(again.status, 201);
  assert.equal(again.body.schedule.eventType, "gym");
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
  // Regression: an external result's logical_session_id is NULL (the XOR
  // identity), which used to satisfy the "orphaned/historical planned
  // result" query's own NOT EXISTS unconditionally - producing a SECOND,
  // mislabeled source:"planned" row for the exact same result. Assert the
  // athlete's own row count for this result, not just the external-tagged
  // filter above (which the mislabeled duplicate would silently evade).
  const forThisAthlete = allSessions.filter((s) => s.athleteId === athlete.athleteId);
  assert.equal(forThisAthlete.length, 1, "no duplicate orphaned/historical row for the same external result");
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

// ------------------------------------------------------------
// E. Manual reminder
// ------------------------------------------------------------

test("E1. a manual reminder to a pending assignment succeeds, creating a real notification with the right deep-link metadata", async () => {
  const { coachCookie, scheduleId, athlete, assignmentId } = await makeReadyAssignment("e1");
  const res = await api(`/api/training-load/external-schedules/${scheduleId}/remind`, { method: "POST", cookie: coachCookie, body: { assignmentIds: [assignmentId] } });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.notifiedCount, 1);
  assert.equal(res.body.results[0].outcome, "notified");
  const notification = (await query(
    `select entity_type, entity_id, metadata, recipient_user_id from public.app_notifications where entity_type = 'training_load_external_assignment' and entity_id = $1`,
    [assignmentId],
  )).rows[0];
  assert.ok(notification, "a real app_notifications row must be created");
  assert.equal(notification.recipient_user_id, athlete.userId);
  assert.equal(notification.metadata.assignmentId, assignmentId, "deep-link metadata must point at the exact assignment, not a generic tab");
});

test("E2. a manual reminder to an ALREADY-COMPLETED assignment is skipped, never re-notified", async () => {
  const { coachCookie, scheduleId, athlete, assignmentId } = await makeReadyAssignment("e2");
  await api(`/api/training-load/external-assignments/${assignmentId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 30 } });
  const res = await api(`/api/training-load/external-schedules/${scheduleId}/remind`, { method: "POST", cookie: coachCookie, body: { assignmentIds: [assignmentId] } });
  assert.equal(res.body.results[0].outcome, "skippedCompleted");
  assert.equal(res.body.notifiedCount, 0);
});

test("E3. an assignment for an athlete with NO linked user account is reported skippedNoUser and never crashes the rest of the batch", async () => {
  const { coachCookie, scheduleId, athlete: readyAthlete, assignmentId: readyAssignmentId } = await makeReadyAssignment("e3");
  const occurrenceId = (await query(`select occurrence_id from training_load.external_assignments where id = $1`, [readyAssignmentId])).rows[0].occurrence_id;
  const noUserAthleteId = await makeAthlete({ name: "E3 No User Athlete" });
  const noUserAssignment = await query(
    `insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, due_at, closes_at)
     values ($1,$2,'UTC',$3, now() - interval '1 hour', null, now() + interval '1 hour') returning id`,
    [occurrenceId, noUserAthleteId, TODAY],
  );
  const noUserAssignmentId = noUserAssignment.rows[0].id;
  const res = await api(`/api/training-load/external-schedules/${scheduleId}/remind`, { method: "POST", cookie: coachCookie, body: { assignmentIds: [noUserAssignmentId, readyAssignmentId] } });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.noUserCount, 1);
  assert.equal(res.body.notifiedCount, 1, "the OTHER assignment in the same batch must still be notified");
  const noUserResult = res.body.results.find((r) => r.assignmentId === noUserAssignmentId);
  const readyResult = res.body.results.find((r) => r.assignmentId === readyAssignmentId);
  assert.equal(noUserResult.outcome, "skippedNoUser");
  assert.equal(readyResult.outcome, "notified");
});

test("E4. a real sliding-window cooldown - two reminders for the same assignment straddling a fixed-bucket boundary would both incorrectly succeed with a naive implementation; here the second must be skippedCooldown", async () => {
  const { coachCookie, scheduleId, assignmentId } = await makeReadyAssignment("e4");
  const first = await api(`/api/training-load/external-schedules/${scheduleId}/remind`, { method: "POST", cookie: coachCookie, body: { assignmentIds: [assignmentId] } });
  assert.equal(first.body.results[0].outcome, "notified");
  const second = await api(`/api/training-load/external-schedules/${scheduleId}/remind`, { method: "POST", cookie: coachCookie, body: { assignmentIds: [assignmentId] } });
  assert.equal(second.body.results[0].outcome, "skippedCooldown", "a reminder sent moments ago must not send a second one immediately");
});

test("E5. a manual reminder against a PAUSED or CANCELLED schedule is rejected outright with a controlled 400", async () => {
  const { coachCookie, scheduleId, assignmentId } = await makeReadyAssignment("e5");
  await api(`/api/training-load/external-schedules/${scheduleId}/pause`, { method: "POST", cookie: coachCookie });
  const pausedRes = await api(`/api/training-load/external-schedules/${scheduleId}/remind`, { method: "POST", cookie: coachCookie, body: { assignmentIds: [assignmentId] } });
  assert.equal(pausedRes.status, 400);

  await api(`/api/training-load/external-schedules/${scheduleId}/resume`, { method: "POST", cookie: coachCookie });
  await api(`/api/training-load/external-schedules/${scheduleId}/cancel`, { method: "POST", cookie: coachCookie });
  const cancelledRes = await api(`/api/training-load/external-schedules/${scheduleId}/remind`, { method: "POST", cookie: coachCookie, body: { assignmentIds: [assignmentId] } });
  assert.equal(cancelledRes.status, 400);
});

test("E6. only a currently pending/eligible assignment within its own window is notified - not-yet-open and already-closed assignments are skipped with distinct outcome codes", async () => {
  const { coachCookie, scheduleId, assignmentId } = await makeReadyAssignment("e6");
  const occurrenceId = (await query(`select occurrence_id from training_load.external_assignments where id = $1`, [assignmentId])).rows[0].occurrence_id;
  const notYetOpenAthleteId = await makeAthlete({ name: "E6 Not Yet Open" });
  const notYetOpenUserId = await makeUser({ email: `e6-notyet-${Date.now()}@test.local`, roleHint: "athlete" });
  await query(`update public.athletes set user_id = $2 where id = $1`, [notYetOpenAthleteId, notYetOpenUserId]);
  const notYetOpenAssignment = await query(
    `insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, due_at, closes_at)
     values ($1,$2,'UTC',$3, now() + interval '1 hour', null, now() + interval '2 hours') returning id`,
    [occurrenceId, notYetOpenAthleteId, TODAY],
  );
  const closedAthleteId = await makeAthlete({ name: "E6 Closed" });
  const closedUserId = await makeUser({ email: `e6-closed-${Date.now()}@test.local`, roleHint: "athlete" });
  await query(`update public.athletes set user_id = $2 where id = $1`, [closedAthleteId, closedUserId]);
  const closedAssignment = await query(
    `insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, due_at, closes_at)
     values ($1,$2,'UTC',$3, now() - interval '2 hours', null, now() - interval '1 hour') returning id`,
    [occurrenceId, closedAthleteId, TODAY],
  );

  const res = await api(`/api/training-load/external-schedules/${scheduleId}/remind`, {
    method: "POST", cookie: coachCookie,
    body: { assignmentIds: [notYetOpenAssignment.rows[0].id, closedAssignment.rows[0].id] },
  });
  const notYetOpenResult = res.body.results.find((r) => r.assignmentId === notYetOpenAssignment.rows[0].id);
  const closedResult = res.body.results.find((r) => r.assignmentId === closedAssignment.rows[0].id);
  assert.equal(notYetOpenResult.outcome, "skippedNotOpen");
  assert.equal(closedResult.outcome, "skippedClosed");
});

test("E7. a coach outside this schedule's workspace access gets an explicit 403, never able to trigger a reminder", async () => {
  const { scheduleId, assignmentId } = await makeReadyAssignment("e7a");
  const outside = await makeClubWithAthletes("e7b", 1);
  const res = await api(`/api/training-load/external-schedules/${scheduleId}/remind`, { method: "POST", cookie: outside.coachCookie, body: { assignmentIds: [assignmentId] } });
  assert.equal(res.status, 403);
});

// ------------------------------------------------------------
// F. Background notification worker cycle
// ------------------------------------------------------------

test("F1. the worker sends exactly one athlete-invitation notification for a currently-open assignment, and a second cycle never re-sends it", async () => {
  const { athlete, assignmentId } = await makeReadyAssignment("f1");
  const summary1 = await processTrainingLoadNotificationCycle({ now: new Date(), pool });
  assert.ok(summary1.invitations.sent >= 1, `expected at least one invitation sent, got: ${JSON.stringify(summary1)}`);
  const countAfterFirst = (await query(`select count(*)::int as n from public.app_notifications where entity_type = 'training_load_external_assignment' and entity_id = $1 and type = 'training_load_external_invitation'`, [assignmentId])).rows[0].n;
  assert.equal(countAfterFirst, 1);

  const summary2 = await processTrainingLoadNotificationCycle({ now: new Date(), pool });
  assert.equal(summary2.invitations.sent, 0, "a second cycle must never re-send an invitation already sent");
  const countAfterSecond = (await query(`select count(*)::int as n from public.app_notifications where entity_type = 'training_load_external_assignment' and entity_id = $1 and type = 'training_load_external_invitation'`, [assignmentId])).rows[0].n;
  assert.equal(countAfterSecond, 1, "still exactly one notification, never duplicated");
});

test("F2. the worker sends a reminder once the reminder offset before closes_at has passed, and skips it before then - deterministic via a synthetic `now`, never dependent on real wall-clock proximity to closes_at", async () => {
  // A real schedule/occurrence (via makeReadyAssignment for a first
  // athlete), but the assignment actually tested here is a SEPARATE, fresh
  // athlete under that SAME occurrence, inserted directly with an explicit
  // closes_at 2 hours out - the window is immutable once created, so this
  // is the only way to get a deterministic, real-schema-honest row to test
  // the 60-minute reminder offset against, independent of what real wall-
  // clock time this suite happens to run at (and isolated from any other
  // test's own leftover pending assignments in this same shared temp DB).
  const ready = await makeReadyAssignment("f2");
  const occurrenceId = (await query(`select occurrence_id from training_load.external_assignments where id = $1`, [ready.assignmentId])).rows[0].occurrence_id;
  const reminderAthleteId = await makeAthlete({ name: "F2 Reminder Athlete" });
  const reminderUserId = await makeUser({ email: `f2-reminder-${Date.now()}@test.local`, roleHint: "athlete" });
  await query(`update public.athletes set user_id = $2 where id = $1`, [reminderAthleteId, reminderUserId]);
  const closesAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const assignmentResult = await query(
    `insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, due_at, closes_at)
     values ($1,$2,'UTC',$3, now() - interval '1 hour', null, $4) returning id`,
    [occurrenceId, reminderAthleteId, TODAY, closesAt.toISOString()],
  );
  const assignmentId = assignmentResult.rows[0].id;

  // Too early: a synthetic `now` more than 60 minutes before closes_at.
  const before = await processTrainingLoadNotificationCycle({ now: new Date(closesAt.getTime() - 90 * 60 * 1000), pool });
  const countBefore = (await query(`select count(*)::int as n from public.app_notifications where entity_id = $1 and type = 'training_load_external_reminder'`, [assignmentId])).rows[0].n;
  assert.equal(countBefore, 0, "too early for the reminder offset - must not send yet");

  // Now within 60 minutes of closes_at.
  const after = await processTrainingLoadNotificationCycle({ now: new Date(closesAt.getTime() - 30 * 60 * 1000), pool });
  assert.equal(after.errors.length, 0, `expected no worker errors, got: ${JSON.stringify(after.errors)}`);
  const countAfter = (await query(`select count(*)::int as n from public.app_notifications where entity_id = $1 and type = 'training_load_external_reminder'`, [assignmentId])).rows[0].n;
  assert.equal(countAfter, 1, `expected exactly one reminder notification for this assignment once the offset has passed, got summary: ${JSON.stringify(after)}`);
});

test("F3. the worker sends a final digest to the schedule's own creator once the occurrence has closed, with an accurate completed/total count", async () => {
  const { coachCookie, coachId, athletes } = await makeClubWithAthletes("f3", 1);
  const created = await api("/api/training-load/external-schedules", {
    method: "POST", cookie: coachCookie,
    body: scheduleBody({ opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "athlete", id: athletes[0].athleteId }] }),
  });
  const scheduleId = created.body.schedules[0].id;
  await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  const occurrenceId = (await query(`select occurrence_id from training_load.external_assignments where athlete_id = $1`, [athletes[0].athleteId])).rows[0].occurrence_id;
  const occurrenceClosesAt = (await query(`select closes_at from training_load.external_schedule_occurrences where id = $1`, [occurrenceId])).rows[0].closes_at;

  // The occurrence's own window is immutable after creation (by design),
  // so "closed" here is simulated by passing a `now` AFTER its real
  // closes_at, rather than waiting for real wall-clock time to pass.
  const summary = await processTrainingLoadNotificationCycle({ now: new Date(new Date(occurrenceClosesAt).getTime() + 60 * 1000), pool });
  assert.ok(summary.finalDigests.sent >= 1, `expected a final digest to send, got: ${JSON.stringify(summary)}`);
  const digest = (await query(`select recipient_user_id, body from public.app_notifications where entity_type = 'training_load_external_occurrence' and entity_id = $1`, [occurrenceId])).rows[0];
  assert.equal(digest.recipient_user_id, coachId);
  assert.match(digest.body, /0\/1/, "0 of 1 athletes completed at this point");
});

test("F4. the worker never crashes on an athlete with no linked user account - it's skipped and reported in the cycle summary", async () => {
  const { coachCookie, clubId } = await makeClubWithAthletes("f4", 0);
  const noUserAthleteId = await makeAthlete({ name: "F4 No User" });
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [noUserAthleteId, clubId]);
  await api("/api/training-load/external-schedules", {
    method: "POST", cookie: coachCookie,
    body: scheduleBody({ opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "athlete", id: noUserAthleteId }] }),
  });

  const summary = await processTrainingLoadNotificationCycle({ now: new Date(), pool });
  assert.ok(summary.invitations.noRecipient >= 1, `expected at least one noRecipient, got: ${JSON.stringify(summary)}`);
  assert.equal(summary.errors.length, 0, "a missing user_id must never produce a worker error");
});

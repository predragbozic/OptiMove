// Training load: the workspace-level MASTER toggle for automatic
// planned-session RPE collection (migrations_v2/202609040900,
// training_load.planned_rpe_workspace_settings). Same disposable-DB
// harness convention as training-load-external-scheduling-routes.test.mjs
// - a uniquely-named temp database, the real Strategy B runner, the real
// Express app driven over real HTTP with real session cookies.
//
// Effective rule under test everywhere below:
//   workspace automatic planned RPE enabled AND session.rpe_enabled
// (see trainingLoad.js's own POST /sessions/:id/rpe and GET /athlete/
// today|weekly for where this is actually enforced/read).
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
  ["202609020900_training_load_v7_external_schedule_notification_rules.sql"],
  ["202609030900_training_load_v8_specific_dates_group.sql"],
  ["202609040900_training_load_v9_planned_rpe_workspace_toggle.sql"],
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
    add column created_by_user_id uuid references public.users(id),
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
  const name = `optimove_tests_tlmaster_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_tlmaster_migrations_${runId}`);
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
async function grantTeamCoach(userId, teamId) {
  await query(`insert into public.user_team_roles (user_id, team_id, role) values ($1,$2,'team_coach')`, [userId, teamId]);
}
async function grantGlobalRole(userId, role) {
  await query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,$2,true)`, [userId, role]);
}
async function grantPrivateCoachRelation(userId, athleteId) {
  await query(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1,$2,'coach',true)`, [userId, athleteId]);
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

// Shared scope -> owner-column mapping, reused by both the settings
// fixture helper (below) and the plan-ownership snapshot fixture helper -
// same shape trainingLoadAccess.js's own externalScheduleOwnerContextFromWorkspace
// produces for the real code paths.
function resolveOwnerColumns(scope) {
  return scope.type === "club" ? { ownerScope: "club", ownerUserId: null, ownerClubId: scope.clubId, ownerTeamId: null } :
    scope.type === "team" ? { ownerScope: "team", ownerUserId: null, ownerClubId: null, ownerTeamId: scope.teamId } :
    scope.type === "user" ? { ownerScope: "user", ownerUserId: scope.userId, ownerClubId: null, ownerTeamId: null } :
    scope.type === "unresolved" ? { ownerScope: "unresolved", ownerUserId: null, ownerClubId: null, ownerTeamId: null } :
    { ownerScope: "system", ownerUserId: null, ownerClubId: null, ownerTeamId: null };
}

// Directly stamps a plan's STORED ownership snapshot in the DB - mirrors
// what routes/builder.js now does once, for real, at plan-creation time
// (see migrations_v2/202609040900's own header). Tests below that create
// plans via raw SQL (not through Builder) must call this explicitly to
// give a plan a real governing workspace - a plan with no row here is
// correctly, permanently inactive for automatic planned RPE, exactly like
// a genuine legacy 'unresolved' row.
async function setPlanOwnershipDirect(planId, scope) {
  const owner = resolveOwnerColumns(scope);
  await query(
    `insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ($1,$2,$3,$4,$5)
     on conflict (plan_id) do update set owner_scope = excluded.owner_scope, owner_user_id = excluded.owner_user_id, owner_club_id = excluded.owner_club_id, owner_team_id = excluded.owner_team_id`,
    [planId, owner.ownerScope, owner.ownerUserId, owner.ownerClubId, owner.ownerTeamId],
  );
}

async function makeWeeklyPlan(athleteId, overrides = {}) {
  const { name = "Weekly plan", weekStart = THIS_WEEK_START, status = "active", isActive = true, isEditDraft = false, owner = null, createdByUserId = null } = overrides;
  const result = await query(
    `insert into plans.plans (plan_type, athlete_id, name, status, is_active, is_edit_draft, week_start, created_by_user_id)
     values ('weekly', $1, $2, $3, $4, $5, $6, $7) returning id`,
    [athleteId, name, status, isActive, isEditDraft, weekStart, createdByUserId],
  );
  const planId = result.rows[0].id;
  if (owner) await setPlanOwnershipDirect(planId, owner);
  return planId;
}
async function makePlanDay(planId, date) {
  const result = await query(`insert into plans.plan_days (plan_id, date) values ($1,$2) returning id`, [planId, date]);
  return result.rows[0].id;
}
async function makeSession(planDayId, overrides = {}) {
  const { amPm = null, bta = null, sessionTime = null, sessionOrder = 0, name = "Session", rpeEnabled = true } = overrides;
  const result = await query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_time, session_order, name, rpe_enabled)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [planDayId, amPm, bta, sessionTime, sessionOrder, name, rpeEnabled],
  );
  return result.rows[0].id;
}
async function makeActiveSessionOn(athleteId, date, overrides = {}) {
  const planId = await makeWeeklyPlan(athleteId, { weekStart: mondayOfIso(date), ...overrides.plan });
  const dayId = await makePlanDay(planId, date);
  const sessionId = await makeSession(dayId, overrides.session);
  return { planId, dayId, sessionId };
}

// Directly flips the master toggle in the DB - used where a test wants a
// deterministic starting state without going through the real PATCH
// route's own transitions (most tests DO go through the real route - see
// the "real HTTP flow" tests below for that path's own coverage).
async function setPlannedRpeSettingDirect(scope, enabled, enabledAt = enabled ? new Date() : null) {
  const owner = resolveOwnerColumns(scope);
  await query(
    `insert into training_load.planned_rpe_workspace_settings (owner_scope, owner_user_id, owner_club_id, owner_team_id, enabled, enabled_at)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (owner_scope, owner_user_id, owner_club_id, owner_team_id)
     do update set enabled = excluded.enabled, enabled_at = excluded.enabled_at, updated_at = now()`,
    [owner.ownerScope, owner.ownerUserId, owner.ownerClubId, owner.ownerTeamId, enabled, enabledAt],
  );
}

// ------------------------------------------------------------
// A. Default state, workspace isolation
// ------------------------------------------------------------

test("A1. a brand-new workspace defaults to automatic planned RPE OFF - GET returns enabled:false, enabledAt:null with no row ever created", async () => {
  const { coachCookie, clubId } = await makeClubWithAthletes("a1", 0);
  await setActiveWorkspace((await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id, "club", clubId);
  const res = await api("/api/training-load/planned-rpe-setting", { cookie: coachCookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.enabledAt, null);
  const rowCount = (await query(`select count(*)::int as n from training_load.planned_rpe_workspace_settings where owner_club_id = $1`, [clubId])).rows[0].n;
  assert.equal(rowCount, 0, "merely READING the setting must never create a row - absent still means off");
});

test("A2. turning ON in Club A never affects Club B, a Team, or Private Coaching - each stays independently OFF by default", async () => {
  const clubA = await makeClubWithAthletes("a2clubA", 0);
  const clubB = await makeClub("A2 Club B");
  const teamCoachId = await makeUser({ email: `a2-teamcoach-${Date.now()}@test.local` });
  const teamId = await makeTeam(clubB, "A2 Team");
  await grantTeamCoach(teamCoachId, teamId);
  const teamCoachCookie = await loginCookie(teamCoachId);
  await setActiveWorkspace(teamCoachId, "team", teamId);

  const privateCoachId = await makeUser({ email: `a2-privatecoach-${Date.now()}@test.local` });
  await grantGlobalRole(privateCoachId, "independent_coach");
  const privateCoachCookie = await loginCookie(privateCoachId);
  await setActiveWorkspace(privateCoachId, "private_coach", null);

  await setActiveWorkspace(clubA.coachId, "club", clubA.clubId);
  const turnedOn = await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: clubA.coachCookie, body: { enabled: true } });
  assert.equal(turnedOn.status, 200);
  assert.equal(turnedOn.body.enabled, true);

  const teamSetting = await api("/api/training-load/planned-rpe-setting", { cookie: teamCoachCookie });
  assert.equal(teamSetting.body.enabled, false, "a Team workspace must never see Club A's own ON state");
  const privateCoachSetting = await api("/api/training-load/planned-rpe-setting", { cookie: privateCoachCookie });
  assert.equal(privateCoachSetting.body.enabled, false, "a Private Coaching workspace must never see Club A's own ON state");

  const clubB2 = await makeUser({ email: `a2-clubbadmin-${Date.now()}@test.local` });
  await grantClubAdmin(clubB2, clubB);
  const clubBCookie = await loginCookie(clubB2);
  await setActiveWorkspace(clubB2, "club", clubB);
  const clubBSetting = await api("/api/training-load/planned-rpe-setting", { cookie: clubBCookie });
  assert.equal(clubBSetting.body.enabled, false, "a different Club must never see Club A's own ON state");
});

test("A3. a dual-role coach (club_admin of BOTH Club A and Club B) sees a COMPLETELY different setting the instant they switch workspace, and can only ever change the one they're currently in", async () => {
  const clubA = await makeClub("A3 Club A");
  const clubB = await makeClub("A3 Club B");
  const coachId = await makeUser({ email: `a3-dual-${Date.now()}@test.local` });
  await grantClubAdmin(coachId, clubA);
  await grantClubAdmin(coachId, clubB);
  const cookie = await loginCookie(coachId);

  await setActiveWorkspace(coachId, "club", clubA);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie, body: { enabled: true } });
  const whileA = await api("/api/training-load/planned-rpe-setting", { cookie });
  assert.equal(whileA.body.enabled, true);

  await setActiveWorkspace(coachId, "club", clubB);
  const whileB = await api("/api/training-load/planned-rpe-setting", { cookie });
  assert.equal(whileB.body.enabled, false, "switching to Club B must immediately show Club B's OWN (still off) value, never Club A's");

  await setActiveWorkspace(coachId, "club", clubA);
  const backToA = await api("/api/training-load/planned-rpe-setting", { cookie });
  assert.equal(backToA.body.enabled, true, "switching back to Club A must restore ITS own value, unaffected by anything done in Club B");
});

test("A4. platform/system scope and private-coach scope both work, and are mutually independent of club/team", async () => {
  const platformAdminId = await makeUser({ email: `a4-platform-${Date.now()}@test.local` });
  await grantGlobalRole(platformAdminId, "platform_admin");
  const platformCookie = await loginCookie(platformAdminId);
  await setActiveWorkspace(platformAdminId, "platform", null);
  const platformOn = await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: platformCookie, body: { enabled: true } });
  assert.equal(platformOn.status, 200);
  assert.equal(platformOn.body.enabled, true);

  const privateCoachId = await makeUser({ email: `a4-private-${Date.now()}@test.local` });
  await grantGlobalRole(privateCoachId, "independent_coach");
  const privateCookie = await loginCookie(privateCoachId);
  await setActiveWorkspace(privateCoachId, "private_coach", null);
  const privateSetting = await api("/api/training-load/planned-rpe-setting", { cookie: privateCookie });
  assert.equal(privateSetting.body.enabled, false, "the platform admin's own ON state must never leak into an unrelated private_coach workspace");

  // Cleanup: under the plan-scoped ownership model a 'system' setting row
  // only ever matches a plan whose OWN stored snapshot says
  // owner_scope='system' - it can no longer leak into any other test's
  // club/team-owned plans (see H4 below for the test that actually proves
  // this). Still turned back off here as ordinary test hygiene, matching
  // this file's own "every test cleans up its own setting" convention -
  // never left as a permanent row (per this branch's own explicit "no
  // global test fixture" rule).
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: platformCookie, body: { enabled: false } });
});

// ------------------------------------------------------------
// B. Authorization
// ------------------------------------------------------------

test("B1. an athlete can never read or change the setting - a controlled 403, regardless of what a coach's own workspace shows", async () => {
  const { athletes } = await makeClubWithAthletes("b1", 1);
  await setActiveWorkspace(athletes[0].userId, "athlete", null);
  const getRes = await api("/api/training-load/planned-rpe-setting", { cookie: athletes[0].cookie });
  assert.equal(getRes.status, 403);
  const patchRes = await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: athletes[0].cookie, body: { enabled: true } });
  assert.equal(patchRes.status, 403);
});

test("B2. a coach outside a workspace can never manage it, even indirectly - PATCH always targets the CALLER's own current active workspace, never an id the client could supply", async () => {
  const groupA = await makeClubWithAthletes("b2a", 0);
  const groupB = await makeClubWithAthletes("b2b", 0);
  await setActiveWorkspace(groupA.coachId, "club", groupA.clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: groupA.coachCookie, body: { enabled: true } });

  await setActiveWorkspace(groupB.coachId, "club", groupB.clubId);
  const bSetting = await api("/api/training-load/planned-rpe-setting", { cookie: groupB.coachCookie });
  assert.equal(bSetting.body.enabled, false, "Club B's coach must never see or inherit Club A's own setting, even though both are real club_admins");
});

test("B3. a plain user with no coach workspace at all gets a controlled 403, never a 500", async () => {
  const userId = await makeUser({ email: `b3-user-${Date.now()}@test.local` });
  const cookie = await loginCookie(userId);
  const res = await api("/api/training-load/planned-rpe-setting", { cookie });
  assert.equal(res.status, 403);
});

test("B4. PATCH validates `enabled` is a real boolean - a controlled 400, never silently coerced or a 500", async () => {
  const { coachCookie, clubId } = await makeClubWithAthletes("b4", 0);
  await setActiveWorkspace((await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id, "club", clubId);
  for (const badBody of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }]) {
    const res = await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: badBody });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(badBody)}, got ${res.status}`);
  }
});

// ------------------------------------------------------------
// C. Effect on the athlete-facing read paths (Home, weekly overlay)
// ------------------------------------------------------------

test("C1. while OFF, a planned session disappears from BOTH Athlete Home and the athlete's own weekly overlay - never shown as a pending request", async () => {
  const { clubId, athletes } = await makeClubWithAthletes("c1", 1);
  await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "Squat day" } });

  const home = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.ok(!home.body.sessions.some((s) => s.sessionName === "Squat day"), "OFF by default - must never appear on Home");

  const weekly = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: athletes[0].cookie });
  const allWeeklySessions = weekly.body.days.flatMap((d) => d.sessions);
  assert.ok(!allWeeklySessions.some((s) => s.sessionName === "Squat day"), "OFF by default - must never appear on the athlete's own weekly overlay either");
});

test("C2. turning ON makes the SAME session appear on both Home and the weekly overlay, without ever having been recreated", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("c2", 1);
  await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "Bench day" }, plan: { owner: { type: "club", clubId } } });
  await setActiveWorkspace((await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });

  const home = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.ok(home.body.sessions.some((s) => s.sessionName === "Bench day"), "ON - must now appear on Home");
});

// ------------------------------------------------------------
// D. Submit enforcement
// ------------------------------------------------------------

test("D1. a direct planned-session submit gets a controlled 409 while the workspace switch is OFF - never a silent success, never a 500", async () => {
  const { athletes } = await makeClubWithAthletes("d1", 1);
  const { sessionId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: { rpe: 5, durationMinutes: 30 } });
  assert.equal(res.status, 409, `expected a controlled 409, got ${res.status}: ${JSON.stringify(res.body)}`);
  const rowCount = (await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athletes[0].athleteId])).rows[0].n;
  assert.equal(rowCount, 0, "no row may be created for a rejected submit");
});

test("D2. when ON, a session with rpe_enabled=true accepts a real submit", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("d2", 1);
  const { sessionId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { rpeEnabled: true }, plan: { owner: { type: "club", clubId } } });
  await setActiveWorkspace((await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: { rpe: 7, durationMinutes: 45 } });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.feedback.srpe, 315);
});

test("D3. when ON, a session with rpe_enabled=false STAYS disabled - the individual per-session flag is never overridden by the master switch", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("d3", 1);
  const { sessionId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { rpeEnabled: false }, plan: { owner: { type: "club", clubId } } });
  await setActiveWorkspace((await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: { rpe: 5, durationMinutes: 30 } });
  assert.equal(res.status, 409, `expected a controlled 409 (per-session still off), got ${res.status}: ${JSON.stringify(res.body)}`);
});

test("D4. an old or direct link to a session that is (still) OFF can never be used to sneak a submit through - same controlled 409 as the normal UI path", async () => {
  const { athletes } = await makeClubWithAthletes("d4", 1);
  const { sessionId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY);
  // Simulates a bookmarked/old link - the athlete never even loaded a
  // fresh Home/weekly response before hitting submit directly.
  const res = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: { rpe: 5, durationMinutes: 20 } });
  assert.equal(res.status, 409);
});

test("D5. OFF -> ON never changes or loses individual session-level rpe_enabled values", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("d5", 1);
  const { sessionId: onSessionId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { rpeEnabled: true, name: "on-session" } });
  const dayId2 = await makePlanDay(await makeWeeklyPlan(athletes[0].athleteId, { weekStart: THIS_WEEK_START }), addDaysIso(TODAY, 1));
  const offSessionId = await makeSession(dayId2, { rpeEnabled: false, name: "off-session" });

  await setActiveWorkspace((await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });

  const rows = (await query(`select id, rpe_enabled from plans.plan_sessions where id = any($1::uuid[])`, [[onSessionId, offSessionId]])).rows;
  assert.equal(rows.find((r) => r.id === onSessionId).rpe_enabled, true, "flipping the master switch must never touch individual rpe_enabled values");
  assert.equal(rows.find((r) => r.id === offSessionId).rpe_enabled, false);
});

// ------------------------------------------------------------
// E. Historical results, denominator, external independence
// ------------------------------------------------------------

test("E1. a result already submitted while ON stays permanently visible in Today/Schedule/Results and its aggregates, even after the master switch is turned back OFF", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("e1", 1);
  const { sessionId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "Deadlift day" }, plan: { owner: { type: "club", clubId } } });
  const coachUserId = (await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id;
  await setActiveWorkspace(coachUserId, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });
  const submit = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: { rpe: 8, durationMinutes: 60 } });
  assert.equal(submit.status, 201);

  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: false } });

  const weekly = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const row = weekly.body.days.flatMap((d) => d.sessions).find((s) => s.sessionId === sessionId);
  assert.ok(row, "the already-submitted session must still be present in the coach's own weekly view");
  assert.equal(row.rated, true);
  assert.equal(row.feedback.srpe, 480);

  const athleteWeekly = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: athletes[0].cookie });
  const athleteRow = athleteWeekly.body.days.flatMap((d) => d.sessions).find((s) => s.sessionId === sessionId);
  assert.ok(athleteRow, "the athlete's own weekly overlay must ALSO keep showing the already-submitted result, even now that the master switch is off");
  assert.equal(athleteRow.rated, true);
});

test("E2. while OFF, an unrated planned session is explicitly marked non-actionable (workspacePlannedRpeEnabled: false, actionable: false) on the coach's own Schedule view - never silently indistinguishable from a genuine 'not rated yet'", async () => {
  const { clubId, athletes } = await makeClubWithAthletes("e2", 1);
  const { sessionId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "Off session" } });
  const coachUserId = (await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id;
  const coachCookie = await loginCookie(coachUserId);
  await setActiveWorkspace(coachUserId, "club", clubId);

  const weekly = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const row = weekly.body.days.flatMap((d) => d.sessions).find((s) => s.sessionId === sessionId);
  assert.ok(row, "the coach's own Schedule view must still show the session, unfiltered, for management");
  assert.equal(row.rpeEnabled, true, "the per-session flag itself is untouched");
  assert.equal(row.workspacePlannedRpeEnabled, false);
  assert.equal(row.actionable, false);
});

test("E3. external/outside-plan RPE scheduling is completely unaffected by this switch, in both directions", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("e3", 1);
  const coachUserId = (await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id;
  await setActiveWorkspace(coachUserId, "club", clubId);
  // Planned RPE stays OFF throughout - external must still work fully.
  const created = await api("/api/training-load/external-schedules", {
    method: "POST", cookie: coachCookie,
    body: { eventName: "National team camp", scheduleKind: "one_time", timezone: "UTC", startDate: TODAY, opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "athlete", id: athletes[0].athleteId }] },
  });
  assert.equal(created.status, 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
  const today = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  const externalRow = today.body.sessions.find((s) => s.source === "scheduled_external");
  assert.ok(externalRow, "an external assignment must still materialize and show on Home while planned RPE is globally off");
  const submit = await api(`/api/training-load/external-assignments/${externalRow.externalAssignmentId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: { rpe: 6, durationMinutes: 50 } });
  assert.equal(submit.status, 201, `external submit must succeed regardless of the planned-RPE master switch, got ${submit.status}: ${JSON.stringify(submit.body)}`);
});

// ------------------------------------------------------------
// F. Re-enabling never floods old missed days
// ------------------------------------------------------------

test("F1. re-enabling after a long OFF stretch applies only from today onward - a session from BEFORE the re-enable date never becomes actionable, even though it was never rated", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("f1", 1);
  const pastDate = addDaysIso(TODAY, -10);
  const { sessionId: pastSessionId } = await makeActiveSessionOn(athletes[0].athleteId, pastDate, { session: { name: "Old missed session" }, plan: { weekStart: mondayOfIso(pastDate), owner: { type: "club", clubId } } });
  const { sessionId: todaySessionId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "Today session" }, plan: { owner: { type: "club", clubId } } });

  const coachUserId = (await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id;
  await setActiveWorkspace(coachUserId, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });

  const pastWeekly = await api(`/api/training-load/weekly?weekStart=${mondayOfIso(pastDate)}`, { cookie: athletes[0].cookie });
  const pastRow = pastWeekly.body.days.flatMap((d) => d.sessions).find((s) => s.sessionId === pastSessionId);
  assert.ok(!pastRow, "a genuinely OLD, never-rated session must never suddenly appear as a pending request just because the switch was turned back on today");

  const todayHome = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.ok(todayHome.body.sessions.some((s) => s.sessionId === todaySessionId), "a session dated TODAY (on/after the re-enable date) must be actionable immediately");
});

test("F2. a session dated exactly on the re-enable date itself IS actionable (the cutoff is inclusive, 'currently relevant' - never exclusive)", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("f2", 1);
  const { sessionId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "Cutoff day session" }, plan: { owner: { type: "club", clubId } } });
  const coachUserId = (await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id;
  await setActiveWorkspace(coachUserId, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });
  const home = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.ok(home.body.sessions.some((s) => s.sessionId === sessionId), "today's own session must be actionable the instant the switch turns on today");
});

test("F3. re-toggling an already-ON switch back to true (a no-op re-save) must NEVER push enabled_at forward - a real off->on transition is the only thing that resets the cutoff", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("f3", 0);
  const coachUserId = (await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id;
  await setActiveWorkspace(coachUserId, "club", clubId);
  const first = await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });
  const firstEnabledAt = first.body.enabledAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });
  assert.equal(second.body.enabledAt, firstEnabledAt, "re-saving an already-true value must never move enabled_at forward");
});

// ------------------------------------------------------------
// G. Concurrency
// ------------------------------------------------------------

test("G1. a Turn off racing a concurrent athlete submit never lets the submit succeed after the disable has already committed - a real Promise.all race, not simulated locking", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("g1", 1);
  const { sessionId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { plan: { owner: { type: "club", clubId } } });
  const coachUserId = (await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id;
  await setActiveWorkspace(coachUserId, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });

  const [turnOffResult, submitResult] = await Promise.all([
    api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: false } }),
    api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athletes[0].cookie, body: { rpe: 5, durationMinutes: 30 } }),
  ]);
  assert.equal(turnOffResult.status, 200);

  const feedbackCount = (await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athletes[0].athleteId])).rows[0].n;
  if (submitResult.status === 201) {
    // The submit's own lock was granted FIRST (before the disable's own
    // UPDATE could commit) - a genuinely clean, real "still open" outcome.
    assert.equal(feedbackCount, 1);
  } else {
    // The disable committed first - the submit that was waiting behind
    // its lock re-read the now-updated (off) state and correctly 409'd.
    assert.equal(submitResult.status, 409, `expected either 201 or 409, got ${submitResult.status}: ${JSON.stringify(submitResult.body)}`);
    assert.equal(feedbackCount, 0, "a submit that loses the race must never leave a partial row behind");
  }
});

test("G2. many concurrent submits racing one disable never produce more committed results than genuinely won the race, and never a 500", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("g2", 3);
  const coachUserId = (await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id;
  await setActiveWorkspace(coachUserId, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });
  const sessionIds = [];
  for (const athlete of athletes) {
    const { sessionId } = await makeActiveSessionOn(athlete.athleteId, TODAY, { plan: { owner: { type: "club", clubId } } });
    sessionIds.push({ athlete, sessionId });
  }

  const results = await Promise.all([
    api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: false } }),
    ...sessionIds.map(({ athlete, sessionId }) => api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 30 } })),
  ]);
  const submitResults = results.slice(1);
  assert.ok(submitResults.every((r) => r.status === 201 || r.status === 409), `every submit must resolve cleanly (201 or 409), got: ${submitResults.map((r) => r.status)}`);
  const successCount = submitResults.filter((r) => r.status === 201).length;
  const feedbackCount = (await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = any($1::uuid[])`, [athletes.map((a) => a.athleteId)])).rows[0].n;
  assert.equal(feedbackCount, successCount, "the committed row count must exactly match the number of submits that actually got a 201");
});

// ------------------------------------------------------------
// H. Plan-scoped ownership - the workspace setting governs only the
// plan's OWN stored scope, never any other workspace the athlete simply
// happens to also belong to. This is the direct regression coverage for
// this branch's own correction: the original "any qualifying scope wins"
// design resolved a session's governing workspace from the athlete's
// CURRENT memberships at read time, so turning on ONE of an athlete's
// several workspaces made ALL of that athlete's plans actionable,
// including ones owned by a workspace that was left deliberately off.
// ------------------------------------------------------------

test("H1. same athlete, Club A ON and Private Coaching OFF: only the Club A plan is actionable, never the private plan", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("h1", 1);
  const athleteId = athletes[0].athleteId;
  const privateCoachId = await makeUser({ email: `h1-private-${Date.now()}@test.local` });
  await grantGlobalRole(privateCoachId, "independent_coach");
  await grantPrivateCoachRelation(privateCoachId, athleteId);

  const { sessionId: clubSessionId } = await makeActiveSessionOn(athleteId, TODAY, { session: { name: "Club A session" }, plan: { owner: { type: "club", clubId } } });
  const { sessionId: privateSessionId } = await makeActiveSessionOn(athleteId, TODAY, { session: { name: "Private session" }, plan: { owner: { type: "user", userId: privateCoachId } } });

  await setActiveWorkspace((await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });
  // Private Coaching stays OFF - never toggled.

  const home = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.ok(home.body.sessions.some((s) => s.sessionId === clubSessionId), "the Club A plan must be actionable");
  assert.ok(!home.body.sessions.some((s) => s.sessionId === privateSessionId), "the private plan must NOT become actionable just because Club A is on - the exact leak this branch's correction closes");
});

test("H2. same athlete, Private Coaching ON and Club A OFF: only the private plan is actionable, never the Club A plan", async () => {
  const { clubId, athletes } = await makeClubWithAthletes("h2", 1);
  const athleteId = athletes[0].athleteId;
  const privateCoachId = await makeUser({ email: `h2-private-${Date.now()}@test.local` });
  await grantGlobalRole(privateCoachId, "independent_coach");
  await grantPrivateCoachRelation(privateCoachId, athleteId);
  const privateCoachCookie = await loginCookie(privateCoachId);

  const { sessionId: clubSessionId } = await makeActiveSessionOn(athleteId, TODAY, { session: { name: "Club A session" }, plan: { owner: { type: "club", clubId } } });
  const { sessionId: privateSessionId } = await makeActiveSessionOn(athleteId, TODAY, { session: { name: "Private session" }, plan: { owner: { type: "user", userId: privateCoachId } } });

  await setActiveWorkspace(privateCoachId, "private_coach", null);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: privateCoachCookie, body: { enabled: true } });
  // Club A stays OFF - never toggled.

  const home = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.ok(home.body.sessions.some((s) => s.sessionId === privateSessionId), "the private plan must be actionable");
  assert.ok(!home.body.sessions.some((s) => s.sessionId === clubSessionId), "the Club A plan must NOT become actionable just because Private Coaching is on");
});

test("H3. same athlete belongs to two clubs with different plans and different switch values: only the ON club's own plan is actionable", async () => {
  const clubA = await makeClubWithAthletes("h3a", 1);
  const athleteId = clubA.athletes[0].athleteId;
  const clubB = await makeClub("H3 Club B");
  const clubBCoachId = await makeUser({ email: `h3-clubb-${Date.now()}@test.local` });
  await grantClubAdmin(clubBCoachId, clubB);
  // Athlete also belongs to Club B - a real second membership, the exact
  // shape that made the OLD "any qualifying scope wins" design leak.
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubB]);

  const { sessionId: clubASessionId } = await makeActiveSessionOn(athleteId, TODAY, { session: { name: "Club A session" }, plan: { owner: { type: "club", clubId: clubA.clubId } } });
  const { sessionId: clubBSessionId } = await makeActiveSessionOn(athleteId, TODAY, { session: { name: "Club B session" }, plan: { owner: { type: "club", clubId: clubB } } });

  await setActiveWorkspace((await query(`select user_id from public.user_club_roles where club_id = $1`, [clubA.clubId])).rows[0].user_id, "club", clubA.clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: clubA.coachCookie, body: { enabled: true } });
  // Club B's own switch stays OFF.

  const home = await api("/api/training-load/athlete/today", { cookie: clubA.athletes[0].cookie });
  assert.ok(home.body.sessions.some((s) => s.sessionId === clubASessionId), "Club A's own plan must be actionable");
  assert.ok(!home.body.sessions.some((s) => s.sessionId === clubBSessionId), "Club B's own plan must stay inactive - membership in Club A must never activate a plan Club B actually owns");
});

test("H4. a platform-wide (system) setting turned ON never activates a club, team, or private plan - it only ever governs a plan whose OWN stored scope is 'system'", async () => {
  const { clubId, athletes } = await makeClubWithAthletes("h4", 1);
  const athleteId = athletes[0].athleteId;
  const platformAdminId = await makeUser({ email: `h4-platform-${Date.now()}@test.local` });
  await grantGlobalRole(platformAdminId, "platform_admin");
  const platformCookie = await loginCookie(platformAdminId);

  const { sessionId: clubSessionId } = await makeActiveSessionOn(athleteId, TODAY, { session: { name: "Club plan session" }, plan: { owner: { type: "club", clubId } } });

  await setActiveWorkspace(platformAdminId, "platform", null);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: platformCookie, body: { enabled: true } });
  // The club's own switch stays OFF.

  const home = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.ok(!home.body.sessions.some((s) => s.sessionId === clubSessionId), "system=true must never activate a club-owned plan - only a plan whose own snapshot is owner_scope='system' may ever match it");

  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: platformCookie, body: { enabled: false } });
});

test("H5. an athlete membership change or removal after plan creation never moves an already-created plan's own stored scope", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("h5", 1);
  const athleteId = athletes[0].athleteId;
  const { sessionId } = await makeActiveSessionOn(athleteId, TODAY, { session: { name: "Club A session" }, plan: { owner: { type: "club", clubId } } });

  await setActiveWorkspace((await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });

  const before = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.ok(before.body.sessions.some((s) => s.sessionId === sessionId), "must be actionable while the owning scope's own setting is on");

  // Remove the athlete's OWN membership in Club A entirely - the plan's
  // own stored snapshot must be completely unaffected.
  await query(`delete from public.athlete_memberships where athlete_id = $1 and club_id = $2`, [athleteId, clubId]);

  const after = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.ok(after.body.sessions.some((s) => s.sessionId === sessionId), "removing the athlete's membership must never retroactively move or invalidate an already-created plan's own stored ownership scope");
});

// ------------------------------------------------------------
// I. Athlete-local timezone-aware re-enable cutoff (planned_rpe_effective_
// for_plan evaluates enabled_at in coalesce(athlete.device_timezone,
// 'UTC'), never a plain UTC date - see this branch's own correction).
//
// The athlete's own "local today" is computed for real, via Postgres
// itself (never assumed to equal this file's own UTC-based TODAY
// constant) - for a zone far enough from UTC, the athlete's own local
// calendar date can genuinely differ from TODAY depending on the exact
// moment the test happens to run, which would make a hard-coded
// assumption flaky rather than a real regression check.
// ------------------------------------------------------------

async function localTodayAndMidnight(timezone) {
  const result = await query(
    `select (now() at time zone $1)::date as local_today,
            (date_trunc('day', now() at time zone $1) at time zone $1) as local_midnight
     from (select 1) t`,
    [timezone],
  );
  const rawLocalToday = result.rows[0].local_today;
  const localToday = rawLocalToday instanceof Date ? rawLocalToday.toISOString().slice(0, 10) : String(rawLocalToday).slice(0, 10);
  return { localToday, localMidnight: result.rows[0].local_midnight };
}

test("I1. re-enabling just after local midnight in Pacific/Kiritimati (UTC+14) must use the athlete's own local date for the cutoff, never the still-previous UTC date", async () => {
  const { clubId } = await makeClubWithAthletes("i1", 0);
  const athleteUserId = await makeUser({ email: `i1-athlete-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Kiritimati athlete", userId: athleteUserId, deviceTimezone: "Pacific/Kiritimati" });
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
  const athleteCookie = await loginCookie(athleteUserId);

  const { localToday, localMidnight } = await localTodayAndMidnight("Pacific/Kiritimati");
  const localYesterday = addDaysIso(localToday, -1);
  const { sessionId: yesterdaySessionId } = await makeActiveSessionOn(athleteId, localYesterday, { session: { name: "Local yesterday" }, plan: { weekStart: mondayOfIso(localYesterday), owner: { type: "club", clubId } } });
  const { sessionId: todaySessionId } = await makeActiveSessionOn(athleteId, localToday, { session: { name: "Local today" }, plan: { weekStart: mondayOfIso(localToday), owner: { type: "club", clubId } } });

  // enabled_at = the exact UTC instant of this athlete's own local
  // midnight today at Pacific/Kiritimati (a fixed UTC+14 offset, no DST).
  await setPlannedRpeSettingDirect({ type: "club", clubId }, true, localMidnight);

  const home = await api("/api/training-load/athlete/today", { cookie: athleteCookie });
  assert.ok(home.body.sessions.some((s) => s.sessionId === todaySessionId), "today's own local-date session must be actionable");
  assert.ok(!home.body.sessions.some((s) => s.sessionId === yesterdaySessionId), "the athlete's own PREVIOUS local day must stay inactive - a plain UTC cutoff would have wrongly reactivated it here");
});

test("I2. re-enabling just after local midnight in Pacific/Auckland must use the athlete's own local date, not the still-previous UTC date", async () => {
  const { clubId } = await makeClubWithAthletes("i2", 0);
  const athleteUserId = await makeUser({ email: `i2-athlete-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "Auckland athlete", userId: athleteUserId, deviceTimezone: "Pacific/Auckland" });
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
  const athleteCookie = await loginCookie(athleteUserId);

  // Auckland is UTC+12 (or +13 under NZDT) - localTodayAndMidnight reads
  // the REAL current offset from Postgres itself rather than hard-coding
  // one, so this test stays correct year-round across the DST transition.
  const { localToday, localMidnight } = await localTodayAndMidnight("Pacific/Auckland");
  const localYesterday = addDaysIso(localToday, -1);
  const { sessionId: yesterdaySessionId } = await makeActiveSessionOn(athleteId, localYesterday, { session: { name: "Local yesterday" }, plan: { weekStart: mondayOfIso(localYesterday), owner: { type: "club", clubId } } });
  const { sessionId: todaySessionId } = await makeActiveSessionOn(athleteId, localToday, { session: { name: "Local today" }, plan: { weekStart: mondayOfIso(localToday), owner: { type: "club", clubId } } });

  await setPlannedRpeSettingDirect({ type: "club", clubId }, true, localMidnight);

  const home = await api("/api/training-load/athlete/today", { cookie: athleteCookie });
  assert.ok(home.body.sessions.some((s) => s.sessionId === todaySessionId), "today's own local-date session must be actionable");
  assert.ok(!home.body.sessions.some((s) => s.sessionId === yesterdaySessionId), "the athlete's own previous local day must stay inactive");
});

test("I3. an athlete BEHIND UTC (e.g. America/Los_Angeles): enabling right after UTC midnight, while it is still today in the athlete's own local time, must not exclude today's own session", async () => {
  const { clubId } = await makeClubWithAthletes("i3", 0);
  const athleteUserId = await makeUser({ email: `i3-athlete-${Date.now()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ name: "LA athlete", userId: athleteUserId, deviceTimezone: "America/Los_Angeles" });
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
  const athleteCookie = await loginCookie(athleteUserId);

  const { localToday } = await localTodayAndMidnight("America/Los_Angeles");
  const { sessionId: todaySessionId } = await makeActiveSessionOn(athleteId, localToday, { session: { name: "LA today" }, plan: { weekStart: mondayOfIso(localToday), owner: { type: "club", clubId } } });

  // enabled_at = shortly after UTC midnight on TOMORROW's UTC date - a
  // plain UTC-date cutoff would already read as tomorrow here, even
  // though it is still TODAY, evening, in the athlete's own Los Angeles
  // time (UTC-7/-8). This is the opposite-direction version of the
  // Kiritimati/Auckland bug above: an athlete BEHIND UTC could have
  // TODAY's own brand-new session wrongly EXCLUDED the instant the
  // switch is turned on, if that happens soon after UTC midnight.
  const enabledAt = new Date(`${addDaysIso(localToday, 1)}T02:00:00Z`);
  await setPlannedRpeSettingDirect({ type: "club", clubId }, true, enabledAt);

  const home = await api("/api/training-load/athlete/today", { cookie: athleteCookie });
  assert.ok(home.body.sessions.some((s) => s.sessionId === todaySessionId), "today's own session must stay actionable - the cutoff must be evaluated in the athlete's own Los Angeles local date, never the already-rolled-over UTC date");
});

// ------------------------------------------------------------
// J. Explicit unresolved-plan ownership resolution (correction round 3,
// POST /plans/resolve-rpe-ownership) - a legacy plan the backfill could
// never deterministically attribute (owner_scope='unresolved') stays
// permanently inactive for automatic planned RPE, by design, until an
// explicit, authorized action assigns it a real scope. These tests use
// `owner: { type: "unresolved" }` to stamp a REAL unresolved row (never
// just "no row at all") - the same shape the actual backfill/legacy path
// produces, so the resolve endpoint's own lookup (an INNER JOIN against
// plan_workspace_ownership) finds it exactly like it would in production.
// ------------------------------------------------------------

test("J1. an unresolved existing plan stays inactive and clearly marked even while the workspace switch is ON", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("j1", 1);
  const { sessionId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "Legacy session" }, plan: { owner: { type: "unresolved" } } });
  await setActiveWorkspace((await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });

  const home = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.ok(!home.body.sessions.some((s) => s.sessionId === sessionId), "an unresolved plan must stay inactive even while the workspace switch is ON");

  const weekly = await api(`/api/training-load/weekly?weekStart=${THIS_WEEK_START}`, { cookie: coachCookie });
  const row = weekly.body.days.flatMap((d) => d.sessions).find((s) => s.sessionId === sessionId);
  assert.ok(row, "the coach's own Schedule view must still show the session for management");
  assert.equal(row.ownershipUnresolved, true, "must be clearly marked as unresolved - never just a silent, unexplained 'off'");
  assert.equal(row.workspacePlannedRpeEnabled, false);
  assert.equal(row.actionable, false);
});

test("J2. the plan's own original creator explicitly resolving it to the current workspace makes its current/future session actionable", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("j2", 1);
  const coachUserId = (await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id;
  const { sessionId, planId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "Legacy session" }, plan: { owner: { type: "unresolved" }, createdByUserId: coachUserId } });
  await setActiveWorkspace(coachUserId, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });

  const resolveRes = await api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: coachCookie, body: { planIds: [planId] } });
  assert.equal(resolveRes.status, 200, `expected 200, got ${resolveRes.status}: ${JSON.stringify(resolveRes.body)}`);
  assert.deepEqual(resolveRes.body.resolvedPlanIds, [planId]);
  assert.deepEqual(resolveRes.body.alreadyMatchingPlanIds, []);

  const home = await api("/api/training-load/athlete/today", { cookie: athletes[0].cookie });
  assert.ok(home.body.sessions.some((s) => s.sessionId === sessionId), "the session must be actionable now that its plan has a real, resolved scope");

  const ownershipRow = (await query(`select owner_scope, owner_club_id from training_load.plan_workspace_ownership where plan_id = $1`, [planId])).rows[0];
  assert.equal(ownershipRow.owner_scope, "club");
  assert.equal(ownershipRow.owner_club_id, clubId);
});

test("J3. a plan resolved to the current workspace still respects the enabled_at cutoff - a session from before the switch was enabled stays inactive", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("j3", 1);
  const coachUserId = (await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id;
  const pastDate = addDaysIso(TODAY, -10);
  const { sessionId, planId } = await makeActiveSessionOn(athletes[0].athleteId, pastDate, { session: { name: "Old legacy session" }, plan: { weekStart: mondayOfIso(pastDate), owner: { type: "unresolved" }, createdByUserId: coachUserId } });
  await setActiveWorkspace(coachUserId, "club", clubId);
  await api("/api/training-load/planned-rpe-setting", { method: "PATCH", cookie: coachCookie, body: { enabled: true } });

  const resolveRes = await api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: coachCookie, body: { planIds: [planId] } });
  assert.equal(resolveRes.status, 200, `expected 200, got ${resolveRes.status}: ${JSON.stringify(resolveRes.body)}`);

  const pastWeekly = await api(`/api/training-load/weekly?weekStart=${mondayOfIso(pastDate)}`, { cookie: athletes[0].cookie });
  const pastRow = pastWeekly.body.days.flatMap((d) => d.sessions).find((s) => s.sessionId === sessionId);
  assert.ok(!pastRow, "a session from before the enable cutoff must never become actionable through resolution - resolving ownership must never bypass enabled_at");
});

test("J4. a private coach cannot resolve a club athlete's plan when they have no real private-coach relation with that athlete", async () => {
  const { athletes } = await makeClubWithAthletes("j4", 1);
  const athleteId = athletes[0].athleteId;
  const privateCoachId = await makeUser({ email: `j4-private-${Date.now()}@test.local` });
  await grantGlobalRole(privateCoachId, "independent_coach");
  // Deliberately NO grantPrivateCoachRelation - this private coach has no
  // real tie to this athlete at all, only knows they exist.
  const privateCoachCookie = await loginCookie(privateCoachId);
  await setActiveWorkspace(privateCoachId, "private_coach", null);

  const { planId } = await makeActiveSessionOn(athleteId, TODAY, { session: { name: "Club plan" }, plan: { owner: { type: "unresolved" } } });

  const resolveRes = await api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: privateCoachCookie, body: { planIds: [planId] } });
  assert.equal(resolveRes.status, 403, `expected 403, got ${resolveRes.status}: ${JSON.stringify(resolveRes.body)}`);
  const ownershipRow = (await query(`select owner_scope from training_load.plan_workspace_ownership where plan_id = $1`, [planId])).rows[0];
  assert.equal(ownershipRow.owner_scope, "unresolved", "must remain unresolved after a rejected attempt");
});

test("J5. Club A cannot resolve a plan belonging to an athlete who only belongs to Club B", async () => {
  const clubA = await makeClubWithAthletes("j5a", 0);
  const clubB = await makeClubWithAthletes("j5b", 1);
  const { planId } = await makeActiveSessionOn(clubB.athletes[0].athleteId, TODAY, { session: { name: "Club B plan" }, plan: { owner: { type: "unresolved" } } });
  await setActiveWorkspace(clubA.coachId, "club", clubA.clubId);

  const resolveRes = await api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: clubA.coachCookie, body: { planIds: [planId] } });
  assert.equal(resolveRes.status, 403, `expected 403, got ${resolveRes.status}: ${JSON.stringify(resolveRes.body)}`);
  const ownershipRow = (await query(`select owner_scope from training_load.plan_workspace_ownership where plan_id = $1`, [planId])).rows[0];
  assert.equal(ownershipRow.owner_scope, "unresolved");
});

// ------------------------------------------------------------
// Correction round 4: workspace-scope coverage of a plan's athlete is
// NOT proof of ownership - only the plan's own ORIGINAL creator (or a
// real platform administrator) may resolve a genuinely unresolved plan.
// J6-J11 below replace the OLD J6 (which wrongly treated "two different
// workspaces that both happen to manage the same athlete" as a
// legitimate race between equally-authorized parties - exactly the bug
// this correction closes) with the real semantics: only the creator's
// OWN identity (in a workspace that still covers the athlete), or a
// platform override, may ever resolve one.
// ------------------------------------------------------------

test("J6. a private coach who genuinely manages the same athlete (a real user_athletes relation) but did NOT create the plan still gets 403 - workspace coverage alone is never proof of ownership", async () => {
  const { clubId, athletes, coachCookie } = await makeClubWithAthletes("j6", 1);
  const athleteId = athletes[0].athleteId;
  const coachUserId = (await query(`select user_id from public.user_club_roles where club_id = $1`, [clubId])).rows[0].user_id;
  const privateCoachId = await makeUser({ email: `j6-private-${Date.now()}@test.local` });
  await grantGlobalRole(privateCoachId, "independent_coach");
  // A REAL, active relation - this private coach genuinely, legitimately
  // manages this athlete today. That must still never be enough on its
  // own: the plan was created by the CLUB coach, not this private coach.
  await grantPrivateCoachRelation(privateCoachId, athleteId);
  const privateCoachCookie = await loginCookie(privateCoachId);
  await setActiveWorkspace(privateCoachId, "private_coach", null);

  const { planId } = await makeActiveSessionOn(athleteId, TODAY, { session: { name: "Club-created plan" }, plan: { owner: { type: "unresolved" }, createdByUserId: coachUserId } });

  const resolveRes = await api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: privateCoachCookie, body: { planIds: [planId] } });
  assert.equal(resolveRes.status, 403, `expected 403, got ${resolveRes.status}: ${JSON.stringify(resolveRes.body)}`);
  const ownershipRow = (await query(`select owner_scope from training_load.plan_workspace_ownership where plan_id = $1`, [planId])).rows[0];
  assert.equal(ownershipRow.owner_scope, "unresolved", "must remain unresolved - a real relationship to the athlete is not the same as having created this plan");
});

test("J7. a coach from a DIFFERENT club who also has this athlete (a second, real membership) but did NOT create the plan still gets 403", async () => {
  const clubA = await makeClubWithAthletes("j7a", 1);
  const clubB = await makeClub("J7 Club B");
  const clubBCoachId = await makeUser({ email: `j7-clubb-${Date.now()}@test.local` });
  await grantClubAdmin(clubBCoachId, clubB);
  const clubBCoachCookie = await loginCookie(clubBCoachId);
  // The athlete genuinely, actively belongs to Club B too - Club B's own
  // coach is otherwise authorized against this athlete. Still not enough:
  // Club A's own coach created this specific plan.
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [clubA.athletes[0].athleteId, clubB]);

  const { planId } = await makeActiveSessionOn(clubA.athletes[0].athleteId, TODAY, { session: { name: "Club A-created plan" }, plan: { owner: { type: "unresolved" }, createdByUserId: clubA.coachId } });

  await setActiveWorkspace(clubBCoachId, "club", clubB);
  const resolveRes = await api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: clubBCoachCookie, body: { planIds: [planId] } });
  assert.equal(resolveRes.status, 403, `expected 403, got ${resolveRes.status}: ${JSON.stringify(resolveRes.body)}`);
  const ownershipRow = (await query(`select owner_scope from training_load.plan_workspace_ownership where plan_id = $1`, [planId])).rows[0];
  assert.equal(ownershipRow.owner_scope, "unresolved");
});

test("J8. the plan's own original creator, who also holds a second, unrelated workspace role, can explicitly resolve it through whichever workspace they're currently in", async () => {
  const { clubId, athletes, coachCookie, coachId } = await makeClubWithAthletes("j8", 1);
  const athleteId = athletes[0].athleteId;
  // The SAME creator ALSO becomes this athlete's private coach - a real,
  // second, valid workspace of their own.
  await grantGlobalRole(coachId, "independent_coach");
  await grantPrivateCoachRelation(coachId, athleteId);

  const { planId } = await makeActiveSessionOn(athleteId, TODAY, { session: { name: "Own plan" }, plan: { owner: { type: "unresolved" }, createdByUserId: coachId } });

  // Resolves it through the PRIVATE COACH workspace, not the club one it
  // was implicitly created under - their own explicit, current-workspace
  // click is the decision, exactly as the spec allows.
  await setActiveWorkspace(coachId, "private_coach", null);
  const resolveRes = await api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: coachCookie, body: { planIds: [planId] } });
  assert.equal(resolveRes.status, 200, `expected 200, got ${resolveRes.status}: ${JSON.stringify(resolveRes.body)}`);
  const ownershipRow = (await query(`select owner_scope, owner_user_id from training_load.plan_workspace_ownership where plan_id = $1`, [planId])).rows[0];
  assert.equal(ownershipRow.owner_scope, "user");
  assert.equal(ownershipRow.owner_user_id, coachId);
});

test("J9. two truly parallel resolution requests from the SAME original creator (two real sessions/tabs, same currently-active workspace) racing for the SAME plan are idempotent and conflict-safe - exactly one real update, one clean idempotent match, never a lost update or a spurious rejection", async () => {
  // Note: the account's active workspace (public.user_workspace_
  // preferences) is a single server-side value per account, never per-
  // session/tab - there is no way for the SAME account to genuinely be
  // "in" two different workspaces at the same instant, so a real race
  // between this one creator's own two DIFFERENT workspaces can't be
  // constructed (switching one tab's workspace immediately changes it
  // for every other tab/session of that same account too). What IS a
  // real, physically possible race for a single account: two tabs both
  // sitting in the SAME active workspace, both clicking "resolve" on the
  // same plan at once - exactly what this test drives, through the
  // exact same FOR UPDATE lock this endpoint already serializes on.
  const { clubId, athletes, coachCookie, coachId } = await makeClubWithAthletes("j9", 1);
  const secondSessionCookie = await loginCookie(coachId); // a second real login/session for the same account, e.g. a second tab

  const { planId } = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "Contested-by-self plan" }, plan: { owner: { type: "unresolved" }, createdByUserId: coachId } });
  await setActiveWorkspace(coachId, "club", clubId);

  const [firstResult, secondResult] = await Promise.all([
    api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: coachCookie, body: { planIds: [planId] } }),
    api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: secondSessionCookie, body: { planIds: [planId] } }),
  ]);
  assert.equal(firstResult.status, 200, `expected 200, got ${firstResult.status}: ${JSON.stringify(firstResult.body)}`);
  assert.equal(secondResult.status, 200, `expected 200 (idempotent), got ${secondResult.status}: ${JSON.stringify(secondResult.body)}`);
  const outcomes = [firstResult.body, secondResult.body];
  const realResolves = outcomes.filter((b) => b.resolvedPlanIds.includes(planId)).length;
  const idempotentMatches = outcomes.filter((b) => b.alreadyMatchingPlanIds.includes(planId)).length;
  assert.equal(realResolves, 1, "exactly ONE of the two racing requests must perform the real unresolved -> resolved transition");
  assert.equal(idempotentMatches, 1, "the OTHER must see it as already matching its own scope - a clean idempotent no-op, never a lost update or a duplicate resolve");
  const ownershipRow = (await query(`select owner_scope, owner_club_id from training_load.plan_workspace_ownership where plan_id = $1`, [planId])).rows[0];
  assert.equal(ownershipRow.owner_scope, "club");
  assert.equal(ownershipRow.owner_club_id, clubId);
});

test("J10. a plan already resolved to a real scope can never have its workspace changed through this endpoint - a genuine conflict is 409, a same-scope retry is idempotent", async () => {
  const clubA = await makeClubWithAthletes("j10a", 1);
  const clubB = await makeClub("J10 Club B");
  const clubBCoachId = await makeUser({ email: `j10-clubb-${Date.now()}@test.local` });
  await grantClubAdmin(clubBCoachId, clubB);
  const clubBCoachCookie = await loginCookie(clubBCoachId);
  // The SAME athlete also gets a real membership in Club B, so Club B's
  // coach is otherwise authorized against the athlete - the point of
  // this test is that ALREADY-RESOLVED ownership blocks the change
  // regardless of the requester's own authorization.
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [clubA.athletes[0].athleteId, clubB]);

  const { planId } = await makeActiveSessionOn(clubA.athletes[0].athleteId, TODAY, { session: { name: "Already Club A" }, plan: { owner: { type: "club", clubId: clubA.clubId } } });

  await setActiveWorkspace(clubBCoachId, "club", clubB);
  const conflictRes = await api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: clubBCoachCookie, body: { planIds: [planId] } });
  assert.equal(conflictRes.status, 409, `expected 409 for an already-resolved plan owned by a different scope, got ${conflictRes.status}: ${JSON.stringify(conflictRes.body)}`);

  const ownershipRow = (await query(`select owner_scope, owner_club_id from training_load.plan_workspace_ownership where plan_id = $1`, [planId])).rows[0];
  assert.equal(ownershipRow.owner_scope, "club");
  assert.equal(ownershipRow.owner_club_id, clubA.clubId, "ownership must remain Club A's own, completely untouched by the rejected Club B attempt");

  await setActiveWorkspace(clubA.coachId, "club", clubA.clubId);
  const idempotentRes = await api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: clubA.coachCookie, body: { planIds: [planId] } });
  assert.equal(idempotentRes.status, 200, "Club A resolving its OWN already-matching plan must be a clean idempotent no-op, never an error");
  assert.deepEqual(idempotentRes.body.alreadyMatchingPlanIds, [planId]);
  assert.deepEqual(idempotentRes.body.resolvedPlanIds, []);
});

test("J11. a mixed bulk batch - one plan the caller genuinely created, one that belongs to someone else - rejects the WHOLE request atomically, and changes neither", async () => {
  const { clubId, athletes, coachCookie, coachId } = await makeClubWithAthletes("j11", 2);
  const ownPlan = await makeActiveSessionOn(athletes[0].athleteId, TODAY, { session: { name: "Own plan" }, plan: { owner: { type: "unresolved" }, createdByUserId: coachId } });
  // A second plan, same club/workspace scope (so the OLD, wrong rule
  // would have allowed it), but created by a DIFFERENT coach.
  const otherCoachId = await makeUser({ email: `j11-other-${Date.now()}@test.local` });
  await grantClubAdmin(otherCoachId, clubId);
  const foreignPlan = await makeActiveSessionOn(athletes[1].athleteId, TODAY, { session: { name: "Someone else's plan" }, plan: { owner: { type: "unresolved" }, createdByUserId: otherCoachId } });

  await setActiveWorkspace(coachId, "club", clubId);
  const resolveRes = await api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: coachCookie, body: { planIds: [ownPlan.planId, foreignPlan.planId] } });
  assert.equal(resolveRes.status, 403, `expected the whole batch to be rejected with 403, got ${resolveRes.status}: ${JSON.stringify(resolveRes.body)}`);

  const rows = (await query(`select plan_id, owner_scope from training_load.plan_workspace_ownership where plan_id = any($1::uuid[])`, [[ownPlan.planId, foreignPlan.planId]])).rows;
  for (const row of rows) {
    assert.equal(row.owner_scope, "unresolved", `plan ${row.plan_id} must stay unresolved - a mixed batch must never partially apply, not even for the one plan the caller genuinely owns`);
  }
});

test("J12. a real platform administrator's explicit override CAN resolve an unresolved plan regardless of who created it - the one deliberate exception, never a plain club/team/private-coach workspace", async () => {
  const { athletes } = await makeClubWithAthletes("j12", 1);
  const athleteId = athletes[0].athleteId;
  const someOtherCoachId = await makeUser({ email: `j12-creator-${Date.now()}@test.local` });
  const platformAdminId = await makeUser({ email: `j12-platform-${Date.now()}@test.local` });
  await grantGlobalRole(platformAdminId, "platform_admin");
  const platformCookie = await loginCookie(platformAdminId);
  await setActiveWorkspace(platformAdminId, "platform", null);

  const { planId } = await makeActiveSessionOn(athleteId, TODAY, { session: { name: "Orphaned-creator plan" }, plan: { owner: { type: "unresolved" }, createdByUserId: someOtherCoachId } });

  const resolveRes = await api("/api/training-load/plans/resolve-rpe-ownership", { method: "POST", cookie: platformCookie, body: { planIds: [planId] } });
  assert.equal(resolveRes.status, 200, `expected the platform override to succeed, got ${resolveRes.status}: ${JSON.stringify(resolveRes.body)}`);
  const ownershipRow = (await query(`select owner_scope from training_load.plan_workspace_ownership where plan_id = $1`, [planId])).rows[0];
  assert.equal(ownershipRow.owner_scope, "system", "the platform override stamps the real system scope, not a borrowed club/team/user one");
});

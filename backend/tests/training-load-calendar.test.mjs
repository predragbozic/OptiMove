// Training Load Frontend 3A — GET /api/training-load/calendar, the new
// unified calendar read model: one item per canonical training.activity
// (never per participant), plus one item per tracked planned session/
// external assignment that has not yet been materialized — deduplicated
// via a real NOT EXISTS against training.activity_participant_session_links,
// never a name/time heuristic. Same disposable-DB harness convention as
// training-activity-metrics-integration.test.mjs: a uniquely-named
// temporary database (never OPTIMOVE, never monitoring2), through the
// real Strategy B runner, with the real Express app driven over real HTTP
// with real session cookies.
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
  "202608310900_training_load_v1_session_feedback.sql",
  "202608320900_training_load_v2_logical_session_identity.sql",
  "202609010900_training_load_v3_rpe_enabled.sql",
  "202609011000_training_load_v4_external_scheduling.sql",
  "202609011100_training_load_v5_unified_result_source.sql",
  "202609040900_training_load_v9_planned_rpe_workspace_toggle.sql",
  "202609041400_training_load_v10_metrics_catalog.sql",
  "202609041500_training_load_v11_metrics_provenance.sql",
  "202609041600_training_load_v12_metrics_events.sql",
  "202609041700_training_load_v13_metrics_measurements.sql",
  "202609071000_training_activity_v1_core_tables.sql",
  "202609071100_training_activity_v2_components_links.sql",
  "202609071200_training_activity_v3_metrics_core_extensions.sql",
  "202609071300_training_activity_v4_canonical_functions.sql",
  "202609080900_training_load_v14_session_tracking_and_rpe_defaults.sql",
];

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
    add column logical_session_id uuid,
    add column created_at timestamptz not null default now(),
    add column updated_at timestamptz not null default now();
`;

async function makeTempDb(label) {
  const name = `optimove_tests_tlcal_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_tlcal_migrations_${runId}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}
async function readMigrationFiles(names) {
  const contents = await Promise.all(names.map((name) => fsp.readFile(path.resolve(__dirname, "../../migrations_v2", name), "utf8")));
  return Object.fromEntries(names.map((name, i) => [name, contents[i]]));
}

let db, adminClient, migrationsDir;
let server, apiBaseUrl;
let query, pool, createSession, hashPassword;

before(async () => {
  db = await makeTempDb("primary");
  adminClient = new pg.Client({ connectionString: db.url });
  await adminClient.connect();
  const ownCheck = await adminClient.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");

  await adminClient.query(LEGACY_FIXTURE_SQL);
  migrationsDir = await writeMigrationsDir("primary", await readMigrationFiles(MIGRATIONS));
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
// Fixtures
// ------------------------------------------------------------
async function api(urlPath, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBaseUrl}${urlPath}`, {
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
function uid() {
  return crypto.randomBytes(4).toString("hex");
}
async function makeUser({ email, roleHint = "user" } = {}) {
  const e = email || `u-${uid()}@test.local`;
  const result = await query(
    `insert into public.users (email, password_hash, full_name, display_name, role_hint, is_active) values ($1,$2,$3,$3,$4,true) returning id`,
    [e, hashPassword("irrelevant-password-123"), e.split("@")[0], roleHint],
  );
  return result.rows[0].id;
}
async function makeClub(name) {
  const result = await query(`insert into public.clubs (name) values ($1) returning id`, [name || `Club ${uid()}`]);
  return result.rows[0].id;
}
async function makeAthlete({ name, userId = null, timezone = "UTC" } = {}) {
  const result = await query(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,$2,$2,$3) returning id`, [userId, name || `Athlete ${uid()}`, timezone]);
  return result.rows[0].id;
}
async function grantClubAdmin(userId, clubId) {
  await query(`insert into public.user_club_roles (user_id, club_id, role) values ($1,$2,'club_admin')`, [userId, clubId]);
}
async function grantGlobalRole(userId, role) {
  await query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,$2,true)`, [userId, role]);
}
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
async function makeClubCoach(label) {
  const clubId = await makeClub(`${label} ${uid()}`);
  const coachId = await makeUser({ email: `${label}-coach-${uid()}@test.local` });
  await grantClubAdmin(coachId, clubId);
  await setActiveWorkspace(coachId, "club", clubId);
  const coachCookie = await loginCookie(coachId);
  return { clubId, coachId, coachCookie };
}
async function makeAthleteInClub(clubId, { timezone = "UTC" } = {}) {
  const userId = await makeUser({ email: `athlete-${uid()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ userId, timezone });
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
  await setActiveWorkspace(userId, "athlete", null);
  return { athleteId, userId, cookie: await loginCookie(userId) };
}

// training_load_enabled defaults true (a "real, live, published, tracked"
// Weekly session — the common case every test wants unless it's
// specifically exercising the training_load_enabled=false rejection).
async function makePlanSessionForAthlete(athleteId, {
  date = "2026-09-08", name = "Session", planName = `Plan ${uid()}`, owner = null, status = "active", trainingLoadEnabled = true,
} = {}) {
  const planId = crypto.randomUUID();
  await query(`insert into plans.plans (id, athlete_id, name, plan_type, status, week_start) values ($1,$2,$3,'weekly',$4,$5)`, [planId, athleteId, planName, status, date]);
  if (owner) {
    await query(
      `insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_user_id, owner_club_id, owner_team_id) values ($1,$2,$3,$4,$5)`,
      [planId, owner.ownerScope, owner.ownerUserId || null, owner.ownerClubId || null, owner.ownerTeamId || null],
    );
  }
  const dayId = crypto.randomUUID();
  await query(`insert into plans.plan_days (id, plan_id, date, day_order) values ($1,$2,$3,1)`, [dayId, planId, date]);
  const logicalSessionId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await query(
    `insert into plans.plan_sessions (id, plan_day_id, name, logical_session_id, session_order, training_load_enabled) values ($1,$2,$3,$4,1,$5)`,
    [sessionId, dayId, name, logicalSessionId, trainingLoadEnabled],
  );
  return { planId, dayId, sessionId, logicalSessionId };
}

async function makeExternalAssignmentForAthlete(athleteId, sysAdminId, { date = "2026-09-08", owner = null } = {}) {
  const effectiveOwner = owner || { ownerScope: "system" };
  const scheduleId = crypto.randomUUID();
  await query(
    `insert into training_load.external_schedules (id, schedule_kind, timezone, start_date, opens_time, closes_time, status, event_name, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ($1,'one_time','UTC',$2,'00:00','23:59','active','Fixture event',$3,$4,$5,$6,$7)`,
    [scheduleId, date, sysAdminId, effectiveOwner.ownerScope, effectiveOwner.ownerUserId || null, effectiveOwner.ownerClubId || null, effectiveOwner.ownerTeamId || null],
  );
  const occurrenceId = crypto.randomUUID();
  await query(
    `insert into training_load.external_schedule_occurrences (id, schedule_id, scheduled_date, opens_at, closes_at)
     values ($1,$2,$3,$4,$5)`,
    [occurrenceId, scheduleId, date, `${date}T00:00:00Z`, `${date}T23:59:00Z`],
  );
  const assignmentId = crypto.randomUUID();
  await query(
    `insert into training_load.external_assignments (id, occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at)
     values ($1,$2,$3,'UTC',$4,$5,$6)`,
    [assignmentId, occurrenceId, athleteId, date, `${date}T00:00:00Z`, `${date}T23:59:00Z`],
  );
  return { scheduleId, occurrenceId, assignmentId };
}

let sysAdminId, sysAdminCookie, distanceDefId, distanceVersionId;
async function ensureSystemDefinition() {
  if (distanceDefId) return distanceDefId;
  sysAdminId = await makeUser({ email: `sysadmin-${uid()}@test.local` });
  await grantGlobalRole(sysAdminId, "platform_admin");
  await setActiveWorkspace(sysAdminId, "platform", null);
  sysAdminCookie = await loginCookie(sysAdminId);
  const res = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: sysAdminCookie,
    body: { key: `total_distance_${uid()}`, label: "Total Distance", ownerScope: "system", unit: "m", valueType: "numeric", dailyAggregationMethod: "sum", scopeCapabilities: ["session", "component", "day"] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  distanceDefId = res.body.row.id;
  distanceVersionId = res.body.row.current_version_id;
  return distanceDefId;
}
function distanceValue(value, extra = {}) {
  return { metricDefinitionId: distanceDefId, metricDefinitionVersionId: distanceVersionId, value, ...extra };
}

async function submitRpe(athleteId, logicalSessionId, { date = "2026-09-08", rpe = 6, durationMinutes = 60 } = {}) {
  const materializeService = await import("../src/trainingActivityMaterialize.js");
  const insertRes = await query(
    `insert into training_load.session_feedback (athlete_id, session_date, logical_session_id, source, rpe, duration_minutes)
     values ($1,$2,$3,'planned',$4,$5) on conflict (athlete_id, logical_session_id) do nothing returning id`,
    [athleteId, date, logicalSessionId, rpe, durationMinutes],
  );
  return insertRes.rowCount > 0;
}
async function materializeRpeActivity(athleteId, logicalSessionId, { date = "2026-09-08", timezone = "UTC", owner } = {}) {
  const materializeService = await import("../src/trainingActivityMaterialize.js");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await materializeService.materializeNaturalKeyActivity(client, {
      logicalSessionId, externalAssignmentId: null, athleteId, localDate: date, timezone, startInstant: null,
      sessionName: "Session", ownerScope: owner.ownerScope, ownerIds: { userId: owner.ownerUserId, clubId: owner.ownerClubId, teamId: owner.ownerTeamId }, performedBy: null,
    });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// Materializes a genuine solo activity via the real, existing
// /materialize route — used to seed a real pre-existing candidate for the
// group-fuzzy-matching correction round's own tests. matchStatus in the
// response tells the fixture whether it landed as a clean single row
// (useful for scoreCandidate's own strong-match thresholds).
async function materializeManualActivity(coachCookie, { athleteId, localDate, timezone = "UTC", name, activityTypeKey, startInstant } = {}) {
  const res = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: `k-${uid()}`, athleteId, localDate, timezone, name, activityTypeKey, startInstant },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function calendar(cookie, { dateFrom = "2026-09-08", dateTo = "2026-09-08", extra = "" } = {}) {
  return api(`/api/training-load/calendar?dateFrom=${dateFrom}&dateTo=${dateTo}${extra}`, { cookie });
}
function itemsFor(res, date) {
  return (res.body.days.find((d) => d.date === date) || { items: [] }).items;
}

// ============================================================
// Tests
// ============================================================

test("1. a tracked planned session with no submission yet appears as a 'planned' item", async () => {
  const { clubId, coachCookie } = await makeClubCoach("c1");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { logicalSessionId } = await makePlanSessionForAthlete(athleteId, { owner: { ownerScope: "club", ownerClubId: clubId } });

  const res = await calendar(coachCookie);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const items = itemsFor(res, "2026-09-08");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "planned");
  assert.equal(items[0].logicalSessionId, logicalSessionId);
  assert.equal(items[0].athleteId, athleteId);
});

test("2. the SAME session, once materialized via a real RPE submit, appears EXACTLY ONCE as an 'activity' item — never duplicated as both 'planned' and 'activity'", async () => {
  const { clubId, coachCookie } = await makeClubCoach("c2");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { logicalSessionId, sessionId } = await makePlanSessionForAthlete(athleteId, { owner: { ownerScope: "club", ownerClubId: clubId } });
  // rpe_enabled defaults to false (v14) — this test's own point is the
  // "RPE requested" badge, so it must be explicitly on, exactly like a
  // real Builder-created Training session with RPE requested would be.
  await query(`update plans.plan_sessions set rpe_enabled = true where id = $1`, [sessionId]);

  const before = await calendar(coachCookie);
  assert.equal(itemsFor(before, "2026-09-08").length, 1);
  assert.equal(itemsFor(before, "2026-09-08")[0].kind, "planned");

  await submitRpe(athleteId, logicalSessionId);
  const mat = await materializeRpeActivity(athleteId, logicalSessionId, { owner: { ownerScope: "club", ownerClubId: clubId } });

  const after = await calendar(coachCookie);
  const items = itemsFor(after, "2026-09-08");
  assert.equal(items.length, 1, "must be EXACTLY one item — never both a planned AND an activity item for the same real session");
  assert.equal(items[0].kind, "activity");
  assert.equal(items[0].activityId, mat.activityId);
  assert.equal(items[0].participantCount, 1);
  assert.deepEqual(items[0].rpe, { requested: 1, rated: 1 });
});

test("3. a standalone (manually materialized) activity with no plan/external anchor appears as an 'activity' item", async () => {
  const { clubId, coachCookie } = await makeClubCoach("c3");
  const { athleteId } = await makeAthleteInClub(clubId);
  const mat = await materializeManualActivity(coachCookie, { athleteId, localDate: "2026-09-08", timezone: "UTC", name: "Gym session" });

  const res = await calendar(coachCookie);
  const items = itemsFor(res, "2026-09-08");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "activity");
  assert.equal(items[0].activityId, mat.activityId);
  assert.equal(items[0].origin, "manual");
  assert.equal(items[0].rpe, null, "a standalone manual activity with no plan/external anchor must never show an RPE badge");
});

test("4. an external assignment appears as 'external' before rating, and as ONE 'activity' item after a real RPE submit — never duplicated", async () => {
  const { coachId } = await makeClubCoach("c4-sysadmin"); // unused, just to get a coach id for schedule ownership
  const { clubId, coachCookie } = await makeClubCoach("c4");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { assignmentId } = await makeExternalAssignmentForAthlete(athleteId, coachId, { owner: { ownerScope: "club", ownerClubId: clubId } });

  const before = await calendar(coachCookie);
  const beforeItems = itemsFor(before, "2026-09-08");
  assert.equal(beforeItems.length, 1);
  assert.equal(beforeItems[0].kind, "external");
  assert.equal(beforeItems[0].externalAssignmentId, assignmentId);

  const materializeService = await import("../src/trainingActivityMaterialize.js");
  const client = await pool.connect();
  let matActivityId;
  try {
    await client.query("begin");
    const r = await materializeService.materializeNaturalKeyActivity(client, {
      logicalSessionId: null, externalAssignmentId: assignmentId, athleteId, localDate: "2026-09-08", timezone: "UTC", startInstant: null,
      sessionName: "External session", ownerScope: "club", ownerIds: { clubId }, performedBy: null,
    });
    matActivityId = r.activityId;
    await client.query("commit");
  } finally {
    client.release();
  }

  const after = await calendar(coachCookie);
  const afterItems = itemsFor(after, "2026-09-08");
  assert.equal(afterItems.length, 1, "must be exactly one item after materialization");
  assert.equal(afterItems[0].kind, "activity");
  assert.equal(afterItems[0].activityId, matActivityId);
});

test("5. canonical alias: after two individually-materialized activities merge (reparent) into one, the calendar shows exactly ONE item for the whole group", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("c5");
  const { athleteId: a1 } = await makeAthleteInClub(clubId);
  const { athleteId: a2 } = await makeAthleteInClub(clubId);
  const { logicalSessionId: s1 } = await makePlanSessionForAthlete(a1, { owner: { ownerScope: "club", ownerClubId: clubId } });
  const { logicalSessionId: s2 } = await makePlanSessionForAthlete(a2, { owner: { ownerScope: "club", ownerClubId: clubId } });

  // A single GROUP metric event with both natural keys forces the
  // existing 2B merge (reparent) path — see trainingActivityMetricsLink.js.
  const groupRes = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [
        { athleteId: a1, timezone: "UTC", logicalSessionId: s1, values: [distanceValue(1000)] },
        { athleteId: a2, timezone: "UTC", logicalSessionId: s2, values: [distanceValue(1000)] },
      ],
    },
  });
  assert.equal(groupRes.status, 201, JSON.stringify(groupRes.body));

  const res = await calendar(coachCookie);
  const items = itemsFor(res, "2026-09-08");
  assert.equal(items.length, 1, "a shared group activity must appear as exactly ONE calendar item, never one per participant");
  assert.equal(items[0].activityId, groupRes.body.activityId);
  assert.equal(items[0].participantCount, 2);
});

test("6. workspace isolation: club B never sees club A's planned session, external assignment, or activity", async () => {
  const { clubId: clubA, coachCookie: coachCookieA } = await makeClubCoach("c6a");
  const { clubId: clubB, coachCookie: coachCookieB } = await makeClubCoach("c6b");
  const { athleteId } = await makeAthleteInClub(clubA);
  await makePlanSessionForAthlete(athleteId, { owner: { ownerScope: "club", ownerClubId: clubA } });
  await materializeManualActivity(coachCookieA, { athleteId, localDate: "2026-09-08", timezone: "UTC", name: "Club A only" });

  const resA = await calendar(coachCookieA);
  assert.equal(itemsFor(resA, "2026-09-08").length, 2, "club A must see both its own planned session and its own activity");

  const resB = await calendar(coachCookieB);
  assert.equal(itemsFor(resB, "2026-09-08").length, 0, "club B must see nothing belonging to club A");
});

test("7. a day-level metric event is never surfaced as an activity calendar item", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("c7");
  const { athleteId } = await makeAthleteInClub(clubId);

  const dayRes = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "day",
      participants: [{ athleteId, timezone: "UTC", values: [distanceValue(1)] }],
    },
  });
  assert.equal(dayRes.status, 201, JSON.stringify(dayRes.body));
  assert.equal(dayRes.body.activityId, null);

  const res = await calendar(coachCookie);
  assert.equal(itemsFor(res, "2026-09-08").length, 0, "a day-level event must never appear in the activity calendar");
});

test("8. date-range validation: dateTo before dateFrom, and a range exceeding the maximum, are both controlled 400s", async () => {
  const { coachCookie } = await makeClubCoach("c8");
  const badOrder = await calendar(coachCookie, { dateFrom: "2026-09-10", dateTo: "2026-09-08" });
  assert.equal(badOrder.status, 400);
  const tooWide = await calendar(coachCookie, { dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  assert.equal(tooWide.status, 400);
  const badDate = await api("/api/training-load/calendar?dateFrom=not-a-date&dateTo=2026-09-08", { cookie: coachCookie });
  assert.equal(badDate.status, 400);
});

test("9. conflict count: two effective values for the same athlete/metric/scope on one activity surface a non-zero conflictCount", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("c9");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { logicalSessionId } = await makePlanSessionForAthlete(athleteId, { owner: { ownerScope: "club", ownerClubId: clubId } });

  await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", logicalSessionId, values: [distanceValue(5000)] }],
    },
  });
  const second = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", logicalSessionId, values: [distanceValue(5200)] }],
    },
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const res = await calendar(coachCookie);
  const items = itemsFor(res, "2026-09-08");
  assert.equal(items.length, 1);
  assert.equal(items[0].conflictCount, 1);
  assert.deepEqual(items[0].metrics, { total: 1, withData: 1 });
});

test("10. an ambiguous fuzzy-matched activity's open suggestion is surfaced as openSuggestionCount", async () => {
  const { clubId, coachCookie } = await makeClubCoach("c10");
  const { athleteId } = await makeAthleteInClub(clubId);
  await materializeManualActivity(coachCookie, { athleteId, localDate: "2026-09-08", timezone: "UTC", name: "Candidate One" });
  await materializeManualActivity(coachCookie, { athleteId, localDate: "2026-09-08", timezone: "UTC", name: "Candidate Two" });
  const ambiguous = await materializeManualActivity(coachCookie, { athleteId, localDate: "2026-09-08", timezone: "UTC", name: "Ambiguous Source" });
  assert.equal(ambiguous.matchStatus, "ambiguous_new");

  const res = await calendar(coachCookie);
  const items = itemsFor(res, "2026-09-08");
  const target = items.find((i) => i.activityId === ambiguous.activityId);
  assert.ok(target, "the provisional/ambiguous activity must still appear in the calendar");
  assert.equal(target.lifecycleState, "provisional");
  assert.equal(target.openSuggestionCount, 2);
});

test("11. the athlete's own calendar shows only their own items, self-scoped, filters ignored", async () => {
  const { clubId, coachCookie } = await makeClubCoach("c11");
  const { athleteId, cookie: athleteCookie } = await makeAthleteInClub(clubId);
  const { athleteId: other } = await makeAthleteInClub(clubId);
  await makePlanSessionForAthlete(athleteId, { owner: { ownerScope: "club", ownerClubId: clubId } });
  await makePlanSessionForAthlete(other, { owner: { ownerScope: "club", ownerClubId: clubId } });

  const res = await calendar(athleteCookie);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const items = itemsFor(res, "2026-09-08");
  assert.equal(items.length, 1);
  assert.equal(items[0].athleteId, athleteId);
});


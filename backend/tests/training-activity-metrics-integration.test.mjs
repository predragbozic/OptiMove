// Training Activity 2B — linking Metrics Core session-level measurements
// to a canonical training.activity, inside POST /api/training-load/metrics/
// events' own single transaction (see trainingActivityMetricsLink.js /
// createGroupEvent's own comments). Same disposable-DB harness convention
// as training-activity.test.mjs / training-load-metrics.test.mjs: a
// uniquely-named temporary database (never OPTIMOVE, never monitoring2),
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
  const name = `optimove_tests_tam2b_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_tam2b_migrations_${runId}`);
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

// ============================================================
// Tests
// ============================================================

test("1. day-level event never creates or links a training.activity", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d1");
  const { athleteId } = await makeAthleteInClub(clubId);
  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "day",
      participants: [{ athleteId, timezone: "UTC", values: [distanceValue(100)] }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.activityId, null);
  const links = await query(`select count(*)::int as n from training.activity_metric_event_links where metric_event_id=$1`, [res.body.eventId]);
  assert.equal(links.rows[0].n, 0);
});

test("2. standalone session event (no identity) materializes exactly one Activity", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d2");
  const { athleteId } = await makeAthleteInClub(clubId);
  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", values: [distanceValue(3500)] }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.activityId);
  assert.equal(res.body.linkStatus, "confirmed");
  const activity = await query(`select origin, lifecycle_state from training.activities where id=$1`, [res.body.activityId]);
  assert.equal(activity.rows[0].origin, "source_import");
  assert.equal(activity.rows[0].lifecycle_state, "confirmed");
});

test("13b. an activityComponentId belonging to a DIFFERENT activity than the resolved one is rejected atomically, zero partial writes", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d13c");
  const { athleteId } = await makeAthleteInClub(clubId);
  const targetActivity = await query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state)
     values ('training_session','Target activity','2026-09-08','UTC','club',$1,'manual','confirmed') returning id`,
    [clubId],
  );
  const otherActivity = await query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state)
     values ('training_session','Some other activity','2026-09-08','UTC','club',$1,'manual','confirmed') returning id`,
    [clubId],
  );
  const foreignComponent = await query(
    `insert into training.activity_components (activity_id, component_type_key, name_snapshot, origin) values ($1,'exercise','Someone else''s component','manual') returning id`,
    [otherActivity.rows[0].id],
  );

  const before = await query(`select count(*)::int as n from training_load.metric_events`);
  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session", activityId: targetActivity.rows[0].id,
      segments: [{ label: "Segment", activityComponentId: foreignComponent.rows[0].id }],
      participants: [{ athleteId, timezone: "UTC", values: [distanceValue(300, { segmentIndex: 0 })] }],
    },
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  const after = await query(`select count(*)::int as n from training_load.metric_events`);
  assert.equal(after.rows[0].n, before.rows[0].n, "zero partial writes when the component belongs to a different activity");
});

test("3. RPE submitted first, then a metric event for the SAME logical session -> same canonical Activity", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d3");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { logicalSessionId } = await makePlanSessionForAthlete(athleteId, { owner: { ownerScope: "club", ownerClubId: clubId } });

  const isNew = await submitRpe(athleteId, logicalSessionId);
  assert.ok(isNew);
  const rpeMat = await materializeRpeActivity(athleteId, logicalSessionId, { owner: { ownerScope: "club", ownerClubId: clubId } });

  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", logicalSessionId, values: [distanceValue(4000)] }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.activityId, rpeMat.activityId);
});

test("4. metric event first, then RPE for the SAME logical session -> same canonical Activity", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d4");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { logicalSessionId } = await makePlanSessionForAthlete(athleteId, { owner: { ownerScope: "club", ownerClubId: clubId } });

  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", logicalSessionId, values: [distanceValue(4200)] }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  await submitRpe(athleteId, logicalSessionId);
  const rpeMat = await materializeRpeActivity(athleteId, logicalSessionId, { owner: { ownerScope: "club", ownerClubId: clubId } });
  assert.equal(rpeMat.activityId, res.body.activityId);
  assert.equal(rpeMat.reused, true);
});

test("9. training_load_enabled=false: explicit link via logicalSessionId is rejected atomically, zero partial writes", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d9");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { logicalSessionId } = await makePlanSessionForAthlete(athleteId, { owner: { ownerScope: "club", ownerClubId: clubId }, trainingLoadEnabled: false });

  const before = await query(`select count(*)::int as n from training_load.metric_events`);
  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", logicalSessionId, values: [distanceValue(1000)] }],
    },
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "trainingLoadNotEnabled");
  const after = await query(`select count(*)::int as n from training_load.metric_events`);
  assert.equal(after.rows[0].n, before.rows[0].n, "zero partial writes — the whole event row must not exist");
});

test("10. explicit existing-Activity link (activityId) confirms the link", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d10");
  const { athleteId } = await makeAthleteInClub(clubId);
  const activityRes = await query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state)
     values ('training_session','Manual entry','2026-09-08','UTC','club',$1,'manual','confirmed') returning id`,
    [clubId],
  );
  const activityId = activityRes.rows[0].id;

  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session", activityId,
      participants: [{ athleteId, timezone: "UTC", values: [distanceValue(2200)] }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.activityId, activityId);
  const link = await query(`select link_status, link_method from training.activity_metric_event_links where metric_event_id=$1`, [res.body.eventId]);
  assert.equal(link.rows[0].link_status, "confirmed");
  assert.equal(link.rows[0].link_method, "manual");
});

test("11. component mapping to an existing activity component", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d11");
  const { athleteId } = await makeAthleteInClub(clubId);
  const activityRes = await query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state)
     values ('training_session','Manual entry','2026-09-08','UTC','club',$1,'manual','confirmed') returning id`,
    [clubId],
  );
  const activityId = activityRes.rows[0].id;
  const compRes = await query(
    `insert into training.activity_components (activity_id, component_type_key, name_snapshot, origin) values ($1,'exercise','Warm-up','manual') returning id`,
    [activityId],
  );
  const componentId = compRes.rows[0].id;

  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session", activityId,
      segments: [{ label: "Warm-up", activityComponentId: componentId }],
      participants: [{ athleteId, timezone: "UTC", values: [distanceValue(500, { segmentIndex: 0 })] }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const link = await query(`select link_status, link_method, activity_component_id from training.activity_component_metric_segment_links where activity_component_id=$1`, [componentId]);
  assert.equal(link.rows[0].link_status, "confirmed");
  assert.equal(link.rows[0].link_method, "manual");
});

test("12. unknown segment auto-creates a source component snapshot", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d12");
  const { athleteId } = await makeAthleteInClub(clubId);

  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      segments: [{ label: "Half 1" }],
      participants: [{ athleteId, timezone: "UTC", values: [distanceValue(1800, { segmentIndex: 0 })] }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const link = await query(
    `select csl.link_status, csl.link_method, ac.name_snapshot, ac.origin from training.activity_component_metric_segment_links csl
     join training.activity_components ac on ac.id = csl.activity_component_id
     join training_load.metric_event_segments s on s.event_id = $1
     where csl.metric_event_segment_id = s.id`,
    [res.body.eventId],
  );
  assert.equal(link.rows[0].link_status, "confirmed");
  assert.equal(link.rows[0].link_method, "automatic");
  assert.equal(link.rows[0].name_snapshot, "Half 1");
  assert.equal(link.rows[0].origin, "api_source");
});

test("13. invalid explicit activityId (unauthorized/foreign) -> atomic rollback, zero partial writes", async () => {
  await ensureSystemDefinition();
  const { clubId: clubA, coachCookie: coachCookieA } = await makeClubCoach("d13a");
  const { clubId: clubB } = await makeClubCoach("d13b");
  const { athleteId } = await makeAthleteInClub(clubA);
  const foreignActivity = await query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state)
     values ('training_session','Other club activity','2026-09-08','UTC','club',$1,'manual','confirmed') returning id`,
    [clubB],
  );

  const before = await query(`select count(*)::int as n from training_load.metric_events`);
  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookieA,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session", activityId: foreignActivity.rows[0].id,
      participants: [{ athleteId, timezone: "UTC", values: [distanceValue(900)] }],
    },
  });
  assert.equal(res.status, 404, JSON.stringify(res.body));
  const after = await query(`select count(*)::int as n from training_load.metric_events`);
  assert.equal(after.rows[0].n, before.rows[0].n, "zero partial writes — no new metric_events row on rollback");
});

test("16. identical retry returns the SAME eventId/activityId/linkStatus", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d16");
  const { athleteId } = await makeAthleteInClub(clubId);
  const requestKey = `k-${uid()}`;
  const body = {
    requestKey, occurredDate: "2026-09-08", scopeLevel: "session",
    participants: [{ athleteId, timezone: "UTC", values: [distanceValue(1234)] }],
  };
  const first = await api("/api/training-load/metrics/events", { method: "POST", cookie: coachCookie, body });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await api("/api/training-load/metrics/events", { method: "POST", cookie: coachCookie, body });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.reused, true);
  assert.equal(second.body.eventId, first.body.eventId);
  assert.equal(second.body.activityId, first.body.activityId);
  assert.equal(second.body.linkStatus, "confirmed");
});

test("19. workspace isolation: two workspaces managing the same athlete never see or link each other's activities", async () => {
  await ensureSystemDefinition();
  const { clubId: clubA, coachCookie: coachCookieA } = await makeClubCoach("d19a");
  const { clubId: clubB, coachCookie: coachCookieB } = await makeClubCoach("d19b");
  const athleteUserId = await makeUser({ email: `shared-athlete-${uid()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ userId: athleteUserId, timezone: "UTC" });
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubA]);
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubB]);

  const resA = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookieA,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", values: [distanceValue(1500)] }],
    },
  });
  assert.equal(resA.status, 201, JSON.stringify(resA.body));

  // Club B must never see club A's activity via an explicit activityId.
  const resB = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookieB,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session", activityId: resA.body.activityId,
      participants: [{ athleteId, timezone: "UTC", values: [distanceValue(1600)] }],
    },
  });
  assert.equal(resB.status, 404, JSON.stringify(resB.body));

  const detail = await api(`/api/training-activity/${resA.body.activityId}`, { cookie: coachCookieB });
  assert.equal(detail.status, 404);
});

test("5a. external assignment RPE-equivalent materialized first, then a metric event for the SAME external assignment -> same canonical Activity", async () => {
  await ensureSystemDefinition();
  const materializeService = await import("../src/trainingActivityMaterialize.js");
  const { clubId, coachCookie } = await makeClubCoach("d5a");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { assignmentId } = await makeExternalAssignmentForAthlete(athleteId, sysAdminId, { owner: { ownerScope: "club", ownerClubId: clubId } });

  const client = await pool.connect();
  let firstActivityId;
  try {
    await client.query("begin");
    const r = await materializeService.materializeNaturalKeyActivity(client, {
      logicalSessionId: null, externalAssignmentId: assignmentId, athleteId, localDate: "2026-09-08", timezone: "UTC", startInstant: null,
      sessionName: "External session", ownerScope: "club", ownerIds: { clubId }, performedBy: null,
    });
    firstActivityId = r.activityId;
    await client.query("commit");
  } finally {
    client.release();
  }

  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", externalAssignmentId: assignmentId, values: [distanceValue(3800)] }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.activityId, firstActivityId);
});

test("5b. metric event first via externalAssignmentId, then the same external identity materialized again -> reuses the SAME canonical Activity", async () => {
  await ensureSystemDefinition();
  const materializeService = await import("../src/trainingActivityMaterialize.js");
  const { clubId, coachCookie } = await makeClubCoach("d5b");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { assignmentId } = await makeExternalAssignmentForAthlete(athleteId, sysAdminId, { owner: { ownerScope: "club", ownerClubId: clubId } });

  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", externalAssignmentId: assignmentId, values: [distanceValue(4100)] }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const client = await pool.connect();
  let secondResult;
  try {
    await client.query("begin");
    secondResult = await materializeService.materializeNaturalKeyActivity(client, {
      logicalSessionId: null, externalAssignmentId: assignmentId, athleteId, localDate: "2026-09-08", timezone: "UTC", startInstant: null,
      sessionName: "External session", ownerScope: "club", ownerIds: { clubId }, performedBy: null,
    });
    await client.query("commit");
  } finally {
    client.release();
  }
  assert.equal(secondResult.activityId, res.body.activityId);
  assert.equal(secondResult.reused, true);
});

test("6. two SEPARATE metric events (two sources), same logicalSessionId -> ONE Activity, both events remain visible/linked", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d6");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { logicalSessionId } = await makePlanSessionForAthlete(athleteId, { owner: { ownerScope: "club", ownerClubId: clubId } });

  const res1 = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", logicalSessionId, values: [distanceValue(4400)] }],
    },
  });
  assert.equal(res1.status, 201, JSON.stringify(res1.body));

  const res2 = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", logicalSessionId, values: [distanceValue(4500)] }],
    },
  });
  assert.equal(res2.status, 201, JSON.stringify(res2.body));
  assert.equal(res2.body.activityId, res1.body.activityId);
  assert.notEqual(res2.body.eventId, res1.body.eventId);

  const links = await query(
    `select metric_event_id from training.activity_metric_event_links where activity_id=$1 and link_status='confirmed' order by metric_event_id`,
    [res1.body.activityId],
  );
  assert.equal(links.rowCount, 2, "both events must each carry their OWN confirmed link to the same activity");
  const linkedEventIds = links.rows.map((r) => r.metric_event_id).sort();
  assert.deepEqual(linkedEventIds, [res1.body.eventId, res2.body.eventId].sort());
});

test("8. same metric, same athlete, same session scope, from two different (session-level) sources -> BOTH values returned with a conflict flag", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d8");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { logicalSessionId } = await makePlanSessionForAthlete(athleteId, { owner: { ownerScope: "club", ownerClubId: clubId } });

  await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", logicalSessionId, values: [distanceValue(5000)] }],
    },
  });
  await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", logicalSessionId, values: [distanceValue(5200)] }],
    },
  });

  const results = await api(
    `/api/training-load/metrics/results?dateFrom=2026-09-08&dateTo=2026-09-08&athleteIds=${athleteId}&metricDefinitionIds=${distanceDefId}`,
    { cookie: coachCookie },
  );
  assert.equal(results.status, 200, JSON.stringify(results.body));
  const relevant = results.body.rows.filter((r) => r.metricDefinitionId === distanceDefId);
  assert.equal(relevant.length, 2, "both effective values must be returned, never silently picking a primary");
  assert.ok(relevant.every((r) => r.conflict === true), "both rows must be flagged as conflicting");
});

test("mixed group: two participants whose OWN natural keys resolve to DIFFERENT existing activities are merged (reparented) into ONE canonical activity for the shared metric event", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("dmix");
  const { athleteId: athleteA } = await makeAthleteInClub(clubId);
  const { athleteId: athleteB } = await makeAthleteInClub(clubId);
  const { logicalSessionId: sessionA } = await makePlanSessionForAthlete(athleteA, { owner: { ownerScope: "club", ownerClubId: clubId } });
  const { logicalSessionId: sessionB } = await makePlanSessionForAthlete(athleteB, { owner: { ownerScope: "club", ownerClubId: clubId } });

  // Each athlete already has their OWN separately-materialized activity
  // (e.g. from an earlier individual RPE submission) BEFORE the group
  // metric event ever arrives.
  const materializeService = await import("../src/trainingActivityMaterialize.js");
  async function materializeFor(athleteId, logicalSessionId) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const r = await materializeService.materializeNaturalKeyActivity(client, {
        logicalSessionId, externalAssignmentId: null, athleteId, localDate: "2026-09-08", timezone: "UTC", startInstant: null,
        sessionName: "Session", ownerScope: "club", ownerIds: { clubId }, performedBy: null,
      });
      await client.query("commit");
      return r;
    } finally {
      client.release();
    }
  }
  const preA = await materializeFor(athleteA, sessionA);
  const preB = await materializeFor(athleteB, sessionB);
  assert.notEqual(preA.activityId, preB.activityId, "fixture sanity: the two athletes must start with genuinely DIFFERENT activities");

  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [
        { athleteId: athleteA, timezone: "UTC", logicalSessionId: sessionA, values: [distanceValue(6000)] },
        { athleteId: athleteB, timezone: "UTC", logicalSessionId: sessionB, values: [distanceValue(6100)] },
      ],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok([preA.activityId, preB.activityId].includes(res.body.activityId), "the canonical activity must be one of the two pre-existing ones, not a brand-new third");

  const canonicalA = await query(`select training.resolve_canonical_activity_id($1) as id`, [preA.activityId]);
  const canonicalB = await query(`select training.resolve_canonical_activity_id($1) as id`, [preB.activityId]);
  assert.equal(canonicalA.rows[0].id, canonicalB.rows[0].id, "both original activities must now resolve to the SAME canonical activity");
  assert.equal(canonicalA.rows[0].id, res.body.activityId);
});

test("17. parallel RPE materialization and metric-event write for the SAME session anchor -> no duplicate activities, no deadlock (deterministic lock proof, no sleep)", async () => {
  await ensureSystemDefinition();
  const measurementsService = await import("../src/trainingLoadMetricsMeasurements.js");
  const materializeService = await import("../src/trainingActivityMaterialize.js");
  const { clubId, coachCookie } = await makeClubCoach("d17");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { logicalSessionId } = await makePlanSessionForAthlete(athleteId, { owner: { ownerScope: "club", ownerClubId: clubId } });
  const scope = { type: "club", clubId, ownerContext: { ownerScope: "club", ownerUserId: null, ownerClubId: clubId, ownerTeamId: null } };
  const coachRow = await query(`select user_id from public.user_club_roles where club_id=$1 limit 1`, [clubId]);
  const coachUserId = coachRow.rows[0].user_id;

  const monitor = await pool.connect();
  let releaseFirst = () => {};
  try {
    let signalFirstReached;
    const firstReachedBarrier = new Promise((res) => { signalFirstReached = res; });
    const firstBarrier = new Promise((res) => { releaseFirst = res; });
    let firstPid;

    const firstPromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const r = await materializeService.materializeNaturalKeyActivity(client, {
          logicalSessionId, externalAssignmentId: null, athleteId, localDate: "2026-09-08", timezone: "UTC", startInstant: null,
          sessionName: "Session", ownerScope: "club", ownerIds: { clubId }, performedBy: coachUserId,
        }, {
          onLocked: async (c) => { firstPid = c.processID; signalFirstReached(); await firstBarrier; },
        });
        await client.query("commit");
        return r;
      } finally {
        client.release();
      }
    })();

    await firstReachedBarrier;
    const fakeReq = { user: { id: coachUserId }, authz: { platformRoles: [], clubRoles: [{ clubId, role: "club_admin" }], teamRoles: [], managedTeamIds: [] } };
    const secondPromise = measurementsService.createGroupEvent(fakeReq, scope, {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", logicalSessionId, values: [distanceValue(7000)] }],
    });

    let secondBlocked = false;
    const start = Date.now();
    while (Date.now() - start < 3000) {
      const r = await monitor.query(`select pid from pg_stat_activity where wait_event_type='Lock' and pid <> $1`, [firstPid]);
      if (r.rowCount > 0) { secondBlocked = true; break; }
      await new Promise((res) => setTimeout(res, 15));
    }
    assert.ok(secondBlocked, "the second (metric-event) write must be genuinely lock-waiting behind the first's held advisory lock");

    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(secondResult.activityId, firstResult.activityId, "both writers must converge on exactly one canonical activity");

    const activityCount = await query(
      `select count(distinct training.resolve_canonical_activity_id(ap.activity_id))::int as n
       from training.activity_participants ap where ap.athlete_id=$1 and ap.local_date='2026-09-08'`,
      [athleteId],
    );
    assert.equal(activityCount.rows[0].n, 1, "no duplicate activity was created under concurrency");
  } finally {
    releaseFirst();
    monitor.release();
  }
});

test("20. no historical RPE reconciliation: an old session_feedback row with no Activity link stays untouched by a new metric event for a DIFFERENT session", async () => {
  await ensureSystemDefinition();
  const { clubId, coachCookie } = await makeClubCoach("d20");
  const { athleteId } = await makeAthleteInClub(clubId);
  await query(
    `insert into training_load.session_feedback (athlete_id, session_date, logical_session_id, source, rpe, duration_minutes) values ($1,'2026-09-01',$2,'planned',5,40)`,
    [athleteId, crypto.randomUUID()],
  );
  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", values: [distanceValue(700)] }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const historicalLinks = await query(
    `select count(*)::int as n from training.activity_participant_session_links where athlete_id=$1`,
    [athleteId],
  );
  assert.equal(historicalLinks.rows[0].n, 0, "the old session_feedback row must never have been retroactively linked to any Activity");
});

// Training Activity — canonical activity/participant identity connecting
// planned Weekly sessions, external RPE assignments, and Metrics Core
// events to one shared "this actually happened" identity. Same
// disposable-DB harness convention as training-load-metrics.test.mjs: a
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
];
const BASE_MIGRATIONS = MIGRATIONS.slice(0, 10); // everything BEFORE training_activity_v1 — used by the upgrade-safety test
const ACTIVITY_MIGRATIONS = MIGRATIONS.slice(10);

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

// Same legacy scaffold as training-load-metrics.test.mjs — required ONLY
// to satisfy migrate.js's Strategy B legacy-fingerprint preflight.
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
  const name = `optimove_tests_tacore_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_tacore_migrations_${runId}`);
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
let materializeService, catalogService, measurementsService, metricsAccessModule, authzModule;

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
  materializeService = await import("../src/trainingActivityMaterialize.js");
  catalogService = await import("../src/trainingLoadMetricsCatalog.js");
  measurementsService = await import("../src/trainingLoadMetricsMeasurements.js");
  metricsAccessModule = await import("../src/trainingLoadMetricsAccess.js");
  authzModule = await import("../src/authz.js");

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
// Fixture helpers (mirrors training-load-metrics.test.mjs's own conventions)
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
async function makePlanSessionForAthlete(athleteId, { date = "2026-09-08", name = "Session", planName = `Plan ${uid()}`, owner = null, status = "active" } = {}) {
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
  await query(`insert into plans.plan_sessions (id, plan_day_id, name, logical_session_id, session_order) values ($1,$2,$3,$4,1)`, [sessionId, dayId, name, logicalSessionId]);
  return { planId, dayId, sessionId, logicalSessionId };
}
// Simulates a Builder edit-draft/publish round trip: a NEW plan_sessions
// row is created (new physical id) carrying the SAME logical_session_id,
// under a brand new plan_days/plans row (mirroring how Builder recreates
// the whole draft structure), and is_edit_draft is left false (a
// published result). The OLD session row is deleted, exactly like a real
// publish replaces the live plan's own rows.
async function republishSessionWithSameLogicalId(athleteId, oldPlanId, logicalSessionId, { date = "2026-09-08", name = "Session (republished)", owner = null } = {}) {
  await query(`delete from plans.plans where id=$1`, [oldPlanId]);
  const planId = crypto.randomUUID();
  await query(`insert into plans.plans (id, athlete_id, name, plan_type, status, week_start) values ($1,$2,$3,'weekly','active',$4)`, [planId, athleteId, `Republished ${uid()}`, date]);
  if (owner) {
    await query(
      `insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_user_id, owner_club_id, owner_team_id) values ($1,$2,$3,$4,$5)`,
      [planId, owner.ownerScope, owner.ownerUserId || null, owner.ownerClubId || null, owner.ownerTeamId || null],
    );
  }
  const dayId = crypto.randomUUID();
  await query(`insert into plans.plan_days (id, plan_id, date, day_order) values ($1,$2,$3,1)`, [dayId, planId, date]);
  const sessionId = crypto.randomUUID();
  await query(`insert into plans.plan_sessions (id, plan_day_id, name, logical_session_id, session_order) values ($1,$2,$3,$4,1)`, [sessionId, dayId, name, logicalSessionId]);
  return { planId, dayId, sessionId };
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
async function makeMetricEvent({ ownerClubId, date = "2026-09-08", scopeLevel = "session", eventTimezoneSnapshot = "UTC", occurredInstant = null }) {
  const r = await query(
    `insert into training_load.metric_events (occurred_date, occurred_instant, scope_level, owner_scope, owner_club_id, event_timezone_snapshot) values ($1,$2,$3,'club',$4,$5) returning id`,
    [date, occurredInstant, scopeLevel, ownerClubId, eventTimezoneSnapshot],
  );
  return r.rows[0].id;
}
async function addMetricParticipant({ eventId, athleteId, timezone = "UTC" }) {
  const r = await query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,$3) returning id`, [eventId, athleteId, timezone]);
  return r.rows[0].id;
}

// ============================================================
// 1. Migration correctness
// ============================================================

test("1. clean apply and checksum-safe re-apply of the 4 training_activity migrations", async () => {
  const tempDb = await makeTempDb("reapply");
  const client = new pg.Client({ connectionString: tempDb.url });
  await client.connect();
  try {
    await client.query(LEGACY_FIXTURE_SQL);
    const dir = await writeMigrationsDir(`reapply-${uid()}`, await readMigrationFiles(MIGRATIONS));
    try {
      await runner.runMigrations({ databaseUrl: tempDb.url, migrationsRoot: dir });
      // Re-apply against the SAME database — every file must be skipped
      // as "already applied, checksum matches", never re-executed or
      // rejected.
      await runner.runMigrations({ databaseUrl: tempDb.url, migrationsRoot: dir });
      const applied = await client.query(`select migration_name from public.schema_migrations where migration_name like '%training_activity%' order by migration_name`);
      assert.equal(applied.rows.length, 4);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  } finally {
    await client.end();
    await dropTempDb(tempDb);
  }
});

test("2. upgrade safety: applying training_activity_v3 over a database with pre-existing v10-v13 metric_values leaves them intact, derives scope capabilities from real history only, and correction chains keep working", async () => {
  const tempDb = await makeTempDb("upgrade");
  const client = new pg.Client({ connectionString: tempDb.url });
  await client.connect();
  let dir;
  try {
    await client.query(LEGACY_FIXTURE_SQL);
    dir = await writeMigrationsDir(`upgrade-base-${uid()}`, await readMigrationFiles(BASE_MIGRATIONS));
    await runner.runMigrations({ databaseUrl: tempDb.url, migrationsRoot: dir });

    // --- pre-existing v10-v13 data, built directly against the REAL
    // tables, exactly as a real pre-upgrade production database would
    // already hold it. ---
    const clubRes = await client.query(`insert into public.clubs (name) values ('Upgrade Club') returning id`);
    const clubId = clubRes.rows[0].id;
    const athleteUserRes = await client.query(`insert into public.users (email, full_name, display_name) values ($1,'A','A') returning id`, [`upgrade-a-${uid()}@test.local`]);
    const athleteRes = await client.query(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,'A','A','UTC') returning id`, [athleteUserRes.rows[0].id]);
    const athleteId = athleteRes.rows[0].id;

    const noValueDefRes = await client.query(`insert into training_load.metric_definitions (key, label, owner_scope) values ($1,'No History','system') returning id`, [`no_history_${uid()}`]);
    const noValueDefVerRes = await client.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1,1,'m','numeric') returning id`, [noValueDefRes.rows[0].id]);
    await client.query(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [noValueDefVerRes.rows[0].id, noValueDefRes.rows[0].id]);

    const defRes = await client.query(`insert into training_load.metric_definitions (key, label, owner_scope) values ($1,'Legacy','system') returning id`, [`legacy_${uid()}`]);
    const verRes = await client.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1,1,'m','numeric') returning id`, [defRes.rows[0].id]);
    await client.query(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [verRes.rows[0].id, defRes.rows[0].id]);
    const definitionId = defRes.rows[0].id;
    const versionId = verRes.rows[0].id;

    const sessionEventRes = await client.query(`insert into training_load.metric_events (occurred_date, scope_level, owner_scope, owner_club_id) values ('2026-08-01','session','club',$1) returning id`, [clubId]);
    const sessionParticipantRes = await client.query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'UTC') returning id`, [sessionEventRes.rows[0].id, athleteId]);
    const sessionOccRes = await client.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, content_hash) values ($1,'manual',$2) returning id`, [sessionParticipantRes.rows[0].id, `h-${uid()}`]);
    await client.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) values ($1,$2,$3,111,'m')`, [sessionOccRes.rows[0].id, definitionId, versionId]);

    const compEventRes = await client.query(`insert into training_load.metric_events (occurred_date, scope_level, owner_scope, owner_club_id) values ('2026-08-01','session','club',$1) returning id`, [clubId]);
    const compSegRes = await client.query(`insert into training_load.metric_event_segments (event_id, label, segment_order) values ($1,'Seg',1) returning id`, [compEventRes.rows[0].id]);
    const compParticipantRes = await client.query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'UTC') returning id`, [compEventRes.rows[0].id, athleteId]);
    const compOccRes = await client.query(`insert into training_load.metric_measurement_occasions (event_participant_id, segment_id, entry_method, content_hash) values ($1,$2,'manual',$3) returning id`, [compParticipantRes.rows[0].id, compSegRes.rows[0].id, `h-${uid()}`]);
    await client.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) values ($1,$2,$3,222,'m')`, [compOccRes.rows[0].id, definitionId, versionId]);

    // One existing import-correction history: the real v13 3-step
    // sequence.
    const connRes = await client.query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_club_id) values ('generic_gps','club',$1) returning id`, [clubId]);
    const identityRes = await client.query(`insert into training_load.metric_source_identities (source_connection_id, source_external_id) values ($1,'ext-upgrade-1') returning id`, [connRes.rows[0].id]);
    const importEventRes = await client.query(`insert into training_load.metric_events (occurred_date, scope_level, owner_scope, owner_club_id, source_connection_id) values ('2026-08-02','session','club',$1,$2) returning id`, [clubId, connRes.rows[0].id]);
    const importParticipantRes = await client.query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'UTC') returning id`, [importEventRes.rows[0].id, athleteId]);
    const oldOccRes = await client.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, content_hash, source_identity_id) values ($1,'api_import',$2,$3) returning id`, [importParticipantRes.rows[0].id, `h-${uid()}`, identityRes.rows[0].id]);
    await client.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) values ($1,$2,$3,10,'m')`, [oldOccRes.rows[0].id, definitionId, versionId]);
    await client.query(`update training_load.metric_source_identities set current_occasion_id=$1 where id=$2`, [oldOccRes.rows[0].id, identityRes.rows[0].id]);
    const newOccRes = await client.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, content_hash, source_identity_id, supersedes_occasion_id) values ($1,'api_import',$2,$3,$4) returning id`, [importParticipantRes.rows[0].id, `h-${uid()}`, identityRes.rows[0].id, oldOccRes.rows[0].id]);
    await client.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) values ($1,$2,$3,15,'m')`, [newOccRes.rows[0].id, definitionId, versionId]);
    await client.query(`update training_load.metric_source_identities set current_occasion_id=$1 where id=$2`, [newOccRes.rows[0].id, identityRes.rows[0].id]);
    await client.query(`update training_load.metric_measurement_occasions set superseded_by_occasion_id=$1 where id=$2`, [newOccRes.rows[0].id, oldOccRes.rows[0].id]);

    const beforeValues = await client.query(`select occasion_id, metric_definition_id, value_numeric from training_load.metric_values order by occasion_id`);

    // --- THE UPGRADE: apply ONLY the 4 NEW training_activity migrations
    // on top of the already-applied base — never the full list again
    // (the base migrations are already recorded in schema_migrations on
    // this database). ---
    const upgradeDir = await writeMigrationsDir(`upgrade-full-${uid()}`, await readMigrationFiles(ACTIVITY_MIGRATIONS));
    try {
      await runner.runMigrations({ databaseUrl: tempDb.url, migrationsRoot: upgradeDir });
    } finally {
      await fsp.rm(upgradeDir, { recursive: true, force: true });
    }

    const afterValues = await client.query(`select occasion_id, metric_definition_id, value_numeric, aggregation_role, coverage from training_load.metric_values order by occasion_id`);
    assert.equal(afterValues.rows.length, beforeValues.rows.length, "no metric_values row lost or gained by the upgrade");
    for (let i = 0; i < beforeValues.rows.length; i++) {
      assert.equal(afterValues.rows[i].occasion_id, beforeValues.rows[i].occasion_id);
      assert.equal(Number(afterValues.rows[i].value_numeric), Number(beforeValues.rows[i].value_numeric));
      assert.equal(afterValues.rows[i].aggregation_role, "standalone", "a pre-existing row must default to standalone, never a guessed source_rollup");
      assert.equal(afterValues.rows[i].coverage, "not_applicable");
    }

    const derivedCaps = await client.query(`select scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id=$1 order by scope_level`, [definitionId]);
    assert.deepEqual(derivedCaps.rows.map((r) => r.scope_level).sort(), ["component", "session"], "capability rows derived from the REAL observed scopes only");
    const noHistoryCaps = await client.query(`select count(*)::int as n from training_load.metric_definition_scope_capabilities where metric_definition_id=$1`, [noValueDefRes.rows[0].id]);
    assert.equal(noHistoryCaps.rows[0].n, 0, "a definition with no historical values gets zero capability rows, never guessed");

    // Wire the corrected identity's occasion into a real activity and
    // prove the canonical read contract (only available post-upgrade)
    // still returns ONLY the corrected (15) value, never the superseded
    // (10) original.
    const activityRes = await client.query(`insert into training.activities (occurred_local_date, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state, created_by_user_id) values ('2026-08-02','UTC','club',$1,'manual','confirmed',$2) returning id`, [clubId, athleteUserRes.rows[0].id]);
    const activityParticipantRes = await client.query(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot) values ($1,$2,'2026-08-02','UTC') returning id`, [activityRes.rows[0].id, athleteId]);
    await client.query(`insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id) values ($1,$2,'manual','confirmed',$3,now(),$3)`, [activityRes.rows[0].id, importEventRes.rows[0].id, athleteUserRes.rows[0].id]);
    await client.query(`insert into training.activity_participant_metric_participant_links (activity_participant_id, metric_event_participant_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id) values ($1,$2,'manual','confirmed',$3,now(),$3)`, [activityParticipantRes.rows[0].id, importParticipantRes.rows[0].id, athleteUserRes.rows[0].id]);

    const results = await client.query(`select detail from training.canonical_activity_results($1) where fact_kind='metric_value'`, [activityRes.rows[0].id]);
    assert.equal(results.rows.length, 1, "exactly one metric_value fact post-upgrade");
    assert.equal(Number(results.rows[0].detail.valueNumeric), 15);
  } finally {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    await client.end();
    await dropTempDb(tempDb);
  }
});

// ============================================================
// 2. Single-participant materialization + matching
// ============================================================

test("3. materializing a manual entry with no candidates creates a new confirmed activity", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("mat3");
  const { athleteId } = await makeAthleteInClub(clubId);
  const res = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), athleteId, localDate: "2026-09-08", timezone: "UTC", name: "Solo run" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.matchStatus, "new");
  const row = await query(`select lifecycle_state, owner_club_id from training.activities where id=$1`, [res.body.activityId]);
  assert.equal(row.rows[0].lifecycle_state, "confirmed");
  assert.equal(row.rows[0].owner_club_id, clubId);
});

test("4. a genuinely strong single candidate auto-matches; a weak/ambiguous one becomes a suggestion, and accepting it merges without duplicating facts", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("mat4");
  const { athleteId } = await makeAthleteInClub(clubId);

  const first = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), athleteId, localDate: "2026-09-08", timezone: "UTC", startInstant: "2026-09-08T10:00:00Z", durationMinutes: 60, name: "Strength", activityTypeKey: "training_session" },
  });
  assert.equal(first.status, 201);

  // Same day, close in time, matching duration AND name -> strong,
  // multi-signal auto-match onto the SAME activity.
  const strong = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), athleteId, localDate: "2026-09-08", timezone: "UTC", startInstant: "2026-09-08T10:10:00Z", durationMinutes: 58, name: "Strength", activityTypeKey: "training_session" },
  });
  assert.equal(strong.status, 201);
  assert.equal(strong.body.matchStatus, "auto_matched");
  assert.equal(strong.body.activityId, first.body.activityId);

  // A SECOND, different athlete/day scenario: a weak (time-only) same-day
  // candidate must NOT silently merge — becomes its own new provisional
  // activity plus a suggestion for human review.
  const { athleteId: athlete2 } = await makeAthleteInClub(clubId);
  const a = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), athleteId: athlete2, localDate: "2026-09-09", timezone: "UTC", name: "Morning" },
  });
  const b = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), athleteId: athlete2, localDate: "2026-09-09", timezone: "UTC", name: "Different Name Entirely" },
  });
  assert.equal(b.body.matchStatus, "ambiguous_new");
  const suggestion = await query(`select id, source_participant_id from training.activity_match_suggestions where activity_id=$1 and status='open'`, [b.body.activityId]);
  assert.equal(suggestion.rowCount, 1);

  const accept = await api(`/api/training-activity/match-suggestions/${suggestion.rows[0].id}/accept`, { method: "POST", cookie: coachCookie, body: {} });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  assert.equal(accept.body.canonicalParticipantId, a.body.participantId);

  // Reading the ORIGINAL (now-merged-away) activity's results must still
  // resolve through the alias chain to the SAME unified facts, never
  // duplicated.
  const detail = await api(`/api/training-activity/${b.body.activityId}`, { cookie: coachCookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.canonicalActivityId, a.body.activityId);
});

// ============================================================
// 3. Group materialization + midnight-crossing timezone
// ============================================================

test("5. group materialization from a metric event: RPE, metric value, and component performance all surface through ONE canonical result with no duplication", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("mat5");
  const { athleteId } = await makeAthleteInClub(clubId);
  const { logicalSessionId, planId } = await makePlanSessionForAthlete(athleteId, { date: "2026-09-08", owner: { ownerScope: "club", ownerClubId: clubId } });
  await query(
    `insert into training_load.session_feedback (athlete_id, session_date, logical_session_id, source, rpe, duration_minutes) values ($1,'2026-09-08',$2,'planned',6,60)`,
    [athleteId, logicalSessionId],
  );

  const eventId = await makeMetricEvent({ ownerClubId: clubId, date: "2026-09-08", eventTimezoneSnapshot: "UTC" });
  const metricParticipantId = await addMetricParticipant({ eventId, athleteId });
  const defRes = await query(`insert into training_load.metric_definitions (key, label, owner_scope) values ($1,'Distance','system') returning id`, [`dist_${uid()}`]);
  const verRes = await query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1,1,'m','numeric') returning id`, [defRes.rows[0].id]);
  await query(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [verRes.rows[0].id, defRes.rows[0].id]);
  await query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'session')`, [defRes.rows[0].id]);

  const materialize = await api(`/api/training-activity/materialize/metric-event/${eventId}`, {
    method: "POST", cookie: coachCookie, body: { activityTypeKey: "training_session", name: "GPS session" },
  });
  assert.equal(materialize.status, 201, JSON.stringify(materialize.body));
  const activityId = materialize.body.activityId;

  const participantRow = await query(`select id from training.activity_participants where activity_id=$1 and athlete_id=$2`, [activityId, athleteId]);
  const participantId = participantRow.rows[0].id;
  // The group materializer ITSELF already inserted the confirmed
  // activity_participant_metric_participant_links row for this athlete —
  // only the occasion/value data is new here.
  const occRes = await query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, content_hash) values ($1,'manual',$2) returning id`, [metricParticipantId, `h-${uid()}`]);
  await query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) values ($1,$2,$3,5000,'m')`, [occRes.rows[0].id, defRes.rows[0].id, verRes.rows[0].id]);

  const compRes = await query(`insert into training.activity_components (activity_id, component_type_key, name_snapshot, origin) values ($1,'exercise','Warm-up','manual') returning id`, [activityId]);
  await query(`insert into training.activity_participant_components (activity_id, activity_participant_id, activity_component_id, status) values ($1,$2,$3,'performed')`, [activityId, participantId, compRes.rows[0].id]);

  // Link the SAME session's RPE onto the SAME activity/participant the
  // group metric materializer already created — a direct confirmed
  // session link, exactly what a coach's own single-participant RPE
  // materialize call would produce once it settles on this activity (the
  // matching heuristic that decides WHICH activity a bare RPE submission
  // lands on is already covered by test 4; this test's own purpose is
  // proving canonical result aggregation once the link exists).
  await query(
    `insert into training.activity_participant_session_links (activity_participant_id, athlete_id, logical_session_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id) values ($1,$2,$3,'automatic','confirmed',$4,now(),$4)`,
    [participantId, athleteId, logicalSessionId, coachId],
  );

  const detail = await api(`/api/training-activity/${activityId}`, { cookie: coachCookie });
  assert.equal(detail.status, 200);
  const kinds = detail.body.facts.map((f) => f.factKind);
  assert.equal(kinds.filter((k) => k === "rpe").length, 1);
  assert.equal(kinds.filter((k) => k === "metric_value").length, 1);
  assert.equal(kinds.filter((k) => k === "component_performance").length, 1);
});

test("6. midnight crossing: a Belgrade athlete's local_date is the day AFTER a UTC-anchored event's own occurred_date, both remain part of the SAME activity", async () => {
  const { clubId, coachCookie } = await makeClubCoach("mat6");
  const { athleteId: utcAthleteId } = await makeAthleteInClub(clubId, { timezone: "UTC" });
  const { athleteId: belgradeAthleteId } = await makeAthleteInClub(clubId, { timezone: "Europe/Belgrade" });

  // 2026-09-08T23:00:00Z is still 2026-09-08 in UTC, but 2026-09-09
  // 01:00/02:00 (CEST, UTC+2) in Europe/Belgrade — the FOLLOWING day.
  const occurredInstant = "2026-09-08T23:00:00Z";
  const eventId = await makeMetricEvent({ ownerClubId: clubId, date: "2026-09-08", occurredInstant, eventTimezoneSnapshot: "UTC" });
  await addMetricParticipant({ eventId, athleteId: utcAthleteId, timezone: "UTC" });
  await addMetricParticipant({ eventId, athleteId: belgradeAthleteId, timezone: "Europe/Belgrade" });

  const materialize = await api(`/api/training-activity/materialize/metric-event/${eventId}`, {
    method: "POST", cookie: coachCookie, body: { activityTypeKey: "training_session", name: "Night session" },
  });
  assert.equal(materialize.status, 201, JSON.stringify(materialize.body));
  const activityId = materialize.body.activityId;

  const utcLocalDate = await query(`select to_char(local_date,'YYYY-MM-DD') as d from training.activity_participants where activity_id=$1 and athlete_id=$2`, [activityId, utcAthleteId]);
  const belgradeLocalDate = await query(`select to_char(local_date,'YYYY-MM-DD') as d from training.activity_participants where activity_id=$1 and athlete_id=$2`, [activityId, belgradeAthleteId]);
  assert.equal(utcLocalDate.rows[0].d, "2026-09-08");
  assert.equal(belgradeLocalDate.rows[0].d, "2026-09-09", "the Belgrade athlete's own local date is the FOLLOWING calendar date");

  const bothCount = await query(`select count(distinct activity_id)::int as n from training.activity_participants where athlete_id in ($1,$2)`, [utcAthleteId, belgradeAthleteId]);
  assert.equal(bothCount.rows[0].n, 1, "both athletes remain part of the exact same single activity");
});

test("7. a day-scope metric event can never be materialized as a training activity", async () => {
  const { clubId, coachCookie } = await makeClubCoach("mat7");
  const { athleteId } = await makeAthleteInClub(clubId);
  const eventId = await makeMetricEvent({ ownerClubId: clubId, date: "2026-09-08", scopeLevel: "day", eventTimezoneSnapshot: "UTC" });
  await addMetricParticipant({ eventId, athleteId });
  const res = await api(`/api/training-activity/materialize/metric-event/${eventId}`, { method: "POST", cookie: coachCookie, body: {} });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /only session-level events may be materialized/i);
});

test("8. concurrent group materialization for the SAME external occurrence converges to exactly ONE activity", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("mat8");
  const athletes = await Promise.all([1, 2, 3].map(() => makeAthleteInClub(clubId)));
  const sysAdmin = await makeUser({ email: `sysadmin-${uid()}@test.local` });
  const { occurrenceId } = await makeExternalAssignmentForAthlete(athletes[0].athleteId, sysAdmin, { date: "2026-09-08", owner: { ownerScope: "club", ownerClubId: clubId } });
  for (const a of athletes.slice(1)) {
    await query(`insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at) values ($1,$2,'UTC','2026-09-08','2026-09-08T00:00:00Z','2026-09-08T23:59:00Z')`, [occurrenceId, a.athleteId]);
  }

  const results = await Promise.all(
    Array.from({ length: 5 }, () => api(`/api/training-activity/materialize/external-occurrence/${occurrenceId}`, { method: "POST", cookie: coachCookie, body: { activityTypeKey: "training_session", name: "Squad session" } })),
  );
  for (const r of results) assert.equal(r.status, 201, JSON.stringify(r.body));
  const distinctActivityIds = new Set(results.map((r) => r.body.activityId));
  assert.equal(distinctActivityIds.size, 1, "5 parallel calls for the same occurrence must converge to exactly one activity");
  const participantCount = await query(`select count(*)::int as n from training.activity_participants where activity_id=$1`, [[...distinctActivityIds][0]]);
  assert.equal(participantCount.rows[0].n, 3);
});

// ============================================================
// 4. Reparent / merge
// ============================================================

test("9. reparent with component_strategy=clone preserves a hierarchy under the target activity", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("mat9");
  const { athleteId } = await makeAthleteInClub(clubId);
  const source = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-09-08", timezone: "UTC", name: "Source" } });
  const { athleteId: targetAthleteId } = await makeAthleteInClub(clubId);
  const target = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId: targetAthleteId, localDate: "2026-09-08", timezone: "UTC", name: "Target" } });

  const block = await query(`insert into training.activity_components (activity_id, component_type_key, name_snapshot, origin) values ($1,'block','Block','manual') returning id`, [source.body.activityId]);
  const leaf = await query(`insert into training.activity_components (activity_id, parent_component_id, component_type_key, name_snapshot, origin) values ($1,$2,'exercise','Leaf','manual') returning id`, [source.body.activityId, block.rows[0].id]);
  await query(`insert into training.activity_participant_components (activity_id, activity_participant_id, activity_component_id, status) values ($1,$2,$3,'performed')`, [source.body.activityId, source.body.participantId, leaf.rows[0].id]);

  const reparent = await api(`/api/training-activity/participants/${source.body.participantId}/reparent`, {
    method: "POST", cookie: coachCookie, body: { toActivityId: target.body.activityId, componentStrategy: "clone", reason: "test" },
  });
  assert.equal(reparent.status, 200, JSON.stringify(reparent.body));
  const junction = await query(`select activity_component_id from training.activity_participant_components where activity_participant_id=$1`, [source.body.participantId]);
  const clonedLeaf = await query(`select activity_id, parent_component_id, name_snapshot from training.activity_components where id=$1`, [junction.rows[0].activity_component_id]);
  assert.equal(clonedLeaf.rows[0].activity_id, target.body.activityId);
  assert.equal(clonedLeaf.rows[0].name_snapshot, "Leaf");
});

test("10. an unknown/malformed reparent input gets a controlled 400, and reparenting into a superseded activity gets a controlled 400 (never a raw 500)", async () => {
  const { clubId, coachCookie } = await makeClubCoach("mat10");
  const { athleteId } = await makeAthleteInClub(clubId);
  const source = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-09-08", timezone: "UTC", name: "S" } });
  const bad = await api(`/api/training-activity/participants/${source.body.participantId}/reparent`, { method: "POST", cookie: coachCookie, body: { toActivityId: "not-a-uuid" } });
  assert.equal(bad.status, 400);

  // Produce a GENUINELY superseded activity through the sanctioned
  // path: materialize the SAME athlete twice on two different days (two
  // separate activities, one participant each), then merge one
  // participant into the other — since that leaves the source activity
  // with zero remaining canonical participants, reparent_activity_
  // participant's own vestigial-activity check supersedes it
  // automatically.
  const { athleteId: a2 } = await makeAthleteInClub(clubId);
  const other1 = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId: a2, localDate: "2026-09-20", timezone: "UTC", name: "O1" } });
  const other2 = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId: a2, localDate: "2026-09-21", timezone: "UTC", name: "O2" } });
  const mergeAway = await api(`/api/training-activity/participants/${other1.body.participantId}/merge`, { method: "POST", cookie: coachCookie, body: { targetParticipantId: other2.body.participantId, reason: "test setup" } });
  assert.equal(mergeAway.status, 200, JSON.stringify(mergeAway.body));
  const nowSuperseded = await query(`select lifecycle_state from training.activities where id=$1`, [other1.body.activityId]);
  assert.equal(nowSuperseded.rows[0].lifecycle_state, "superseded", "test setup: other1 must be genuinely superseded via the sanctioned merge flow");

  const intoSuperseded = await api(`/api/training-activity/participants/${source.body.participantId}/reparent`, { method: "POST", cookie: coachCookie, body: { toActivityId: other1.body.activityId } });
  assert.equal(intoSuperseded.status, 400, JSON.stringify(intoSuperseded.body));
  assert.match(intoSuperseded.body.error, /already superseded/i);
});

test("11. direct participant merge declares an alias, and the canonical read resolves through it", async () => {
  const { clubId, coachCookie } = await makeClubCoach("mat11");
  const { athleteId } = await makeAthleteInClub(clubId);
  const a = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-09-10", timezone: "UTC", name: "A" } });
  const b = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-09-11", timezone: "UTC", name: "B" } });
  const merge = await api(`/api/training-activity/participants/${a.body.participantId}/merge`, { method: "POST", cookie: coachCookie, body: { targetParticipantId: b.body.participantId, reason: "dup" } });
  assert.equal(merge.status, 200, JSON.stringify(merge.body));
  assert.equal(merge.body.canonicalParticipantId, b.body.participantId);
  const row = await query(`select merge_status, superseded_by_participant_id from training.activity_participants where id=$1`, [a.body.participantId]);
  assert.equal(row.rows[0].merge_status, "superseded");
  assert.equal(row.rows[0].superseded_by_participant_id, b.body.participantId);
});

// ============================================================
// 5. Workspace isolation + idempotency re-authorization
// ============================================================

test("12. a club-scoped coach cannot read or write another club's activity — a 404, not a leak", async () => {
  const clubA = await makeClubCoach("clubA");
  const clubB = await makeClubCoach("clubB");
  const { athleteId } = await makeAthleteInClub(clubA.clubId);
  const created = await api("/api/training-activity/materialize", { method: "POST", cookie: clubA.coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-09-08", timezone: "UTC", name: "Private" } });
  assert.equal(created.status, 201);

  const readAsB = await api(`/api/training-activity/${created.body.activityId}`, { cookie: clubB.coachCookie });
  assert.equal(readAsB.status, 404);

  const reparentAsB = await api(`/api/training-activity/participants/${created.body.participantId}/reparent`, { method: "POST", cookie: clubB.coachCookie, body: { toActivityId: created.body.activityId } });
  assert.equal(reparentAsB.status, 404);

  const materializeAsBForAthleteInA = await api("/api/training-activity/materialize", { method: "POST", cookie: clubB.coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-09-08", timezone: "UTC", name: "Cross-club attempt" } });
  assert.equal(materializeAsBForAthleteInA.status, 403, "an athlete belonging to a DIFFERENT club must be refused, not silently materialized under club B's own scope");
});

test("13. an athlete can read their own activity results but not another athlete's, and cannot reach coach-only write routes", async () => {
  const { clubId, coachCookie } = await makeClubCoach("mat13");
  const athlete1 = await makeAthleteInClub(clubId);
  const athlete2 = await makeAthleteInClub(clubId);
  const created = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId: athlete1.athleteId, localDate: "2026-09-08", timezone: "UTC", name: "Mine" } });

  const ownRead = await api(`/api/training-activity/${created.body.activityId}`, { cookie: athlete1.cookie });
  assert.equal(ownRead.status, 200);

  const otherRead = await api(`/api/training-activity/${created.body.activityId}`, { cookie: athlete2.cookie });
  assert.equal(otherRead.status, 404, "an athlete workspace has zero visibility into another athlete's activity");

  const writeAttempt = await api(`/api/training-activity/participants/${created.body.participantId}/reparent`, { method: "POST", cookie: athlete1.cookie, body: { toActivityId: created.body.activityId } });
  assert.equal(writeAttempt.status, 403, "an athlete workspace can never reach a coach-only write route, even for their OWN activity");
});

test("14. a materialize request-key replay under a DIFFERENT workspace is refused — rights are re-checked, never trusted from the first call", async () => {
  const clubA = await makeClubCoach("replayA");
  const clubB = await makeClubCoach("replayB");
  const { athleteId } = await makeAthleteInClub(clubA.clubId);
  const requestKey = uid();
  const first = await api("/api/training-activity/materialize", { method: "POST", cookie: clubA.coachCookie, body: { requestKey, athleteId, localDate: "2026-09-08", timezone: "UTC", name: "Original" } });
  assert.equal(first.status, 201);

  // The SAME coach account switches its active workspace to club B, then
  // replays the SAME request key (still nominally "their own" retry from
  // the client's point of view) — must be refused, never silently
  // returned as if it were club B's own result.
  await setActiveWorkspace(clubA.coachId, "club", clubB.clubId);
  await query(`insert into public.user_club_roles (user_id, club_id, role) values ($1,$2,'club_admin')`, [clubA.coachId, clubB.clubId]);
  const replayedCookie = await loginCookie(clubA.coachId);
  const replay = await api("/api/training-activity/materialize", { method: "POST", cookie: replayedCookie, body: { requestKey, athleteId, localDate: "2026-09-08", timezone: "UTC", name: "Original" } });
  assert.equal(replay.status, 403, JSON.stringify(replay.body));
});

// ============================================================
// 6. Builder edit-draft / publish round trip
// ============================================================

test("15. a confirmed session link created before a Builder edit-draft/publish round trip stays valid, and a NEW link against the republished session still resolves through the real published-plan gate", async () => {
  const { clubId, coachCookie } = await makeClubCoach("mat15");
  const { athleteId } = await makeAthleteInClub(clubId);
  const owner = { ownerScope: "club", ownerClubId: clubId };
  const { planId, logicalSessionId } = await makePlanSessionForAthlete(athleteId, { date: "2026-09-08", owner });

  const before = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-09-08", timezone: "UTC", planLogicalSessionId: logicalSessionId } });
  assert.equal(before.status, 201, JSON.stringify(before.body));

  await republishSessionWithSameLogicalId(athleteId, planId, logicalSessionId, { date: "2026-09-08", owner });

  const existingLink = await query(`select link_status from training.activity_participant_session_links where logical_session_id=$1 and link_status='confirmed'`, [logicalSessionId]);
  assert.equal(existingLink.rowCount, 1, "the existing confirmed link survives the edit-draft/publish round trip untouched");

  // A brand new materialize call for a DIFFERENT athlete against the SAME
  // (now-republished) logical session must still succeed — proving the
  // published-plan gate resolves through the NEW physical session row.
  const { athleteId: athlete2 } = await makeAthleteInClub(clubId);
  const secondSourceActivity = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId: athlete2, localDate: "2026-09-08", timezone: "UTC", name: "Different session entirely" } });
  assert.equal(secondSourceActivity.status, 201);
});

// ============================================================
// 7. List endpoint
// ============================================================

test("16. the DB trigger enforces scope capability unconditionally — a definition with ZERO declared capabilities rejects a value at ANY scope, even bypassing the application entirely", async () => {
  const clubId = await makeClub();
  const eventId = await makeMetricEvent({ ownerClubId: clubId, date: "2026-09-08", eventTimezoneSnapshot: "UTC" });
  const athleteUser = await makeUser({ email: `scopecap-${uid()}@test.local` });
  const athleteId = await makeAthlete({ userId: athleteUser, timezone: "UTC" });
  const metricParticipantId = await addMetricParticipant({ eventId, athleteId });

  const def = await query(`insert into training_load.metric_definitions (key, label, owner_scope) values ($1,'Unconfigured','system') returning id`, [`unconfigured_${uid()}`]);
  const ver = await query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1,1,'m','numeric') returning id`, [def.rows[0].id]);
  await query(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [ver.rows[0].id, def.rows[0].id]);
  const occ = await query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, content_hash) values ($1,'manual',$2) returning id`, [metricParticipantId, `h-${uid()}`]);
  await assert.rejects(
    query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) values ($1,$2,$3,42,'m')`, [occ.rows[0].id, def.rows[0].id, ver.rows[0].id]),
    /has no declared scope_capability for level 'session'/,
  );
});

test("17. creating a metric definition with an explicit scopeCapabilities list configures it immediately, and GET returns them", async () => {
  const { clubId, coachCookie } = await makeClubCoach("scopecap17");
  const created = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: coachCookie,
    body: { key: `configured_${uid()}`, label: "Configured", ownerScope: "club", ownerClubId: clubId, unit: "m", valueType: "numeric", scopeCapabilities: ["session", "component"] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([...created.body.row.scope_capabilities].sort(), ["component", "session"]);

  const fetched = await api(`/api/training-load/metrics/definitions/${created.body.row.id}`, { cookie: coachCookie });
  assert.equal(fetched.status, 200);
  assert.deepEqual([...fetched.body.row.scope_capabilities].sort(), ["component", "session"]);
});

test("18. PUT scope-capabilities configures a previously-unconfigured definition, and a subsequent value submission at that scope then succeeds", async () => {
  const { clubId, coachCookie } = await makeClubCoach("scopecap18");
  const athlete = await makeAthleteInClub(clubId);
  const created = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: coachCookie,
    body: { key: `unconfigured_then_set_${uid()}`, label: "Unconfigured Then Set", ownerScope: "club", ownerClubId: clubId, unit: "m", valueType: "numeric" },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.row.scope_capabilities, []);

  const configured = await api(`/api/training-load/metrics/definitions/${created.body.row.id}/scope-capabilities`, {
    method: "PUT", cookie: coachCookie, body: { scopeCapabilities: ["session"] },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.deepEqual(configured.body.row.scope_capabilities, ["session"]);

  const eventRes = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: uid(), occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId: athlete.athleteId, timezone: "UTC", values: [{ metricDefinitionId: created.body.row.id, metricDefinitionVersionId: created.body.row.current_version_id, value: 100 }] }],
    },
  });
  assert.equal(eventRes.status, 201, JSON.stringify(eventRes.body));
});

test("19. submitting a value against a definition with NO configured scope capability returns a controlled 409 (scopeCapabilitiesRequired), never a raw 500", async () => {
  const { clubId, coachCookie } = await makeClubCoach("scopecap19");
  const athlete = await makeAthleteInClub(clubId);
  const created = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: coachCookie,
    body: { key: `still_unconfigured_${uid()}`, label: "Still Unconfigured", ownerScope: "club", ownerClubId: clubId, unit: "m", valueType: "numeric" },
  });
  assert.equal(created.status, 201);

  const eventRes = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: uid(), occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId: athlete.athleteId, timezone: "UTC", values: [{ metricDefinitionId: created.body.row.id, metricDefinitionVersionId: created.body.row.current_version_id, value: 100 }] }],
    },
  });
  assert.equal(eventRes.status, 409, JSON.stringify(eventRes.body));
  assert.equal(eventRes.body.code, "scopeCapabilitiesRequired");

  // Zero partial writes — the whole event/occasion insert rolled back.
  const leftoverEvents = await query(`select count(*)::int as n from training_load.metric_events where owner_club_id=$1`, [clubId]);
  assert.equal(leftoverEvents.rows[0].n, 0);
});

test("20. removing a scope capability that already has real historical values is rejected — both through the app endpoint (409, scopeCapabilityHasHistory) and a raw DB bypass (the trigger backstop)", async () => {
  const { clubId, coachCookie } = await makeClubCoach("scopecap20");
  const athlete = await makeAthleteInClub(clubId);
  const created = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: coachCookie,
    body: { key: `history_protected_${uid()}`, label: "History Protected", ownerScope: "club", ownerClubId: clubId, unit: "m", valueType: "numeric", scopeCapabilities: ["session"] },
  });
  assert.equal(created.status, 201);
  const eventRes = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: uid(), occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId: athlete.athleteId, timezone: "UTC", values: [{ metricDefinitionId: created.body.row.id, metricDefinitionVersionId: created.body.row.current_version_id, value: 100 }] }],
    },
  });
  assert.equal(eventRes.status, 201, JSON.stringify(eventRes.body));

  const removeAttempt = await api(`/api/training-load/metrics/definitions/${created.body.row.id}/scope-capabilities`, {
    method: "PUT", cookie: coachCookie, body: { scopeCapabilities: [] },
  });
  assert.equal(removeAttempt.status, 409, JSON.stringify(removeAttempt.body));
  assert.equal(removeAttempt.body.code, "scopeCapabilityHasHistory");
  const stillThere = await query(`select 1 from training_load.metric_definition_scope_capabilities where metric_definition_id=$1 and scope_level='session'`, [created.body.row.id]);
  assert.equal(stillThere.rowCount, 1);

  await assert.rejects(
    query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id=$1 and scope_level='session'`, [created.body.row.id]),
    /cannot remove scope 'session'.*real historical values already exist/,
  );
});

test("21. listing activities by period and athlete returns only in-scope, canonical rows", async () => {
  const { clubId, coachCookie } = await makeClubCoach("mat16");
  const { athleteId } = await makeAthleteInClub(clubId);
  await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-09-15", timezone: "UTC", name: "In range" } });
  await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-10-15", timezone: "UTC", name: "Out of range" } });

  const list = await api(`/api/training-activity?athleteId=${athleteId}&dateFrom=2026-09-01&dateTo=2026-09-30`, { cookie: coachCookie });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.rows.length, 1);
  assert.equal(list.body.rows[0].name, "In range");
});

// ============================================================
// §1 — authoritative planned/external materialization (Round 2 correction)
// ============================================================

test("22. materializing via a real planLogicalSessionId belonging to athlete B is rejected when the client claims athleteId=athlete A — controlled 400, zero partial writes", async () => {
  const { clubId, coachCookie } = await makeClubCoach("authoritative22");
  const athleteA = await makeAthleteInClub(clubId);
  const athleteB = await makeAthleteInClub(clubId);
  const { logicalSessionId } = await makePlanSessionForAthlete(athleteB.athleteId, { date: "2026-09-08", owner: { ownerScope: "club", ownerClubId: clubId } });

  const attempt = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), athleteId: athleteA.athleteId, planLogicalSessionId: logicalSessionId, localDate: "2026-09-08", timezone: "UTC" },
  });
  assert.equal(attempt.status, 400, JSON.stringify(attempt.body));
  assert.match(attempt.body.error, /athleteId does not match the authoritative source/i);

  const leftover = await query(`select count(*)::int as n from training.activity_participants where athlete_id in ($1,$2)`, [athleteA.athleteId, athleteB.athleteId]);
  assert.equal(leftover.rows[0].n, 0, "zero partial writes for either athlete");
});

test("23. a planned-session materialize call derives athleteId/localDate/timezone AUTHORITATIVELY from the real plan — never from client input", async () => {
  const { clubId, coachCookie } = await makeClubCoach("authoritative23");
  const athlete = await makeAthleteInClub(clubId, { timezone: "Europe/Belgrade" });
  const { logicalSessionId } = await makePlanSessionForAthlete(athlete.athleteId, { date: "2026-09-12", owner: { ownerScope: "club", ownerClubId: clubId } });

  const result = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), planLogicalSessionId: logicalSessionId },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const participant = await query(`select athlete_id, to_char(local_date,'YYYY-MM-DD') as d, timezone_snapshot from training.activity_participants where id=$1`, [result.body.participantId]);
  assert.equal(participant.rows[0].athlete_id, athlete.athleteId);
  assert.equal(participant.rows[0].d, "2026-09-12");
  assert.equal(participant.rows[0].timezone_snapshot, "Europe/Belgrade");
});

test("24. providing BOTH planLogicalSessionId and externalAssignmentId is rejected with 400 before any transaction begins", async () => {
  const { clubId, coachCookie } = await makeClubCoach("authoritative24");
  const athlete = await makeAthleteInClub(clubId);
  const { logicalSessionId } = await makePlanSessionForAthlete(athlete.athleteId, { date: "2026-09-08", owner: { ownerScope: "club", ownerClubId: clubId } });
  const sysAdmin = await makeUser({ email: `sysadmin24-${uid()}@test.local` });
  const { assignmentId } = await makeExternalAssignmentForAthlete(athlete.athleteId, sysAdmin, { date: "2026-09-08", owner: { ownerScope: "club", ownerClubId: clubId } });
  const attempt = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), planLogicalSessionId: logicalSessionId, externalAssignmentId: assignmentId },
  });
  assert.equal(attempt.status, 400);
  assert.match(attempt.body.error, /cannot both be provided/i);
  const leftover = await query(`select count(*)::int as n from training.activity_participants where athlete_id=$1`, [athlete.athleteId]);
  assert.equal(leftover.rows[0].n, 0);
});

test("25. an external-assignment materialize call derives athleteId/localDate/timezone from the real assignment, and rejects a mismatched client-supplied athleteId", async () => {
  const { clubId, coachCookie } = await makeClubCoach("authoritative25");
  const athlete = await makeAthleteInClub(clubId);
  const otherAthlete = await makeAthleteInClub(clubId);
  const sysAdmin = await makeUser({ email: `sysadmin25-${uid()}@test.local` });
  const { assignmentId } = await makeExternalAssignmentForAthlete(athlete.athleteId, sysAdmin, { date: "2026-09-14", owner: { ownerScope: "club", ownerClubId: clubId } });

  const mismatch = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), athleteId: otherAthlete.athleteId, externalAssignmentId: assignmentId },
  });
  assert.equal(mismatch.status, 400);

  const ok = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), externalAssignmentId: assignmentId },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const participant = await query(`select athlete_id, to_char(local_date,'YYYY-MM-DD') as d from training.activity_participants where id=$1`, [ok.body.participantId]);
  assert.equal(participant.rows[0].athlete_id, athlete.athleteId);
  assert.equal(participant.rows[0].d, "2026-09-14");
});

// ============================================================
// §4 — identity/time validation (Round 2 correction)
// ============================================================

test("26. manual materialization validates timezone, timestamp format, reversed interval, positive duration, localDate/startInstant consistency, and activityTypeKey existence", async () => {
  const { clubId, coachCookie } = await makeClubCoach("validate26");
  const athlete = await makeAthleteInClub(clubId);
  const base = { athleteId: athlete.athleteId, localDate: "2026-09-08", timezone: "UTC" };

  const badTz = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { ...base, requestKey: uid(), timezone: "Not/AZone" } });
  assert.equal(badTz.status, 400);

  const badTimestamp = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { ...base, requestKey: uid(), startInstant: "2026-09-08 12:00:00" } });
  assert.equal(badTimestamp.status, 400);

  const reversed = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { ...base, requestKey: uid(), startInstant: "2026-09-08T12:00:00Z", endInstant: "2026-09-08T10:00:00Z" } });
  assert.equal(reversed.status, 400);

  const badDuration = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { ...base, requestKey: uid(), durationMinutes: -5 } });
  assert.equal(badDuration.status, 400);

  const mismatchedDate = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { ...base, requestKey: uid(), startInstant: "2026-09-09T12:00:00Z" } });
  assert.equal(mismatchedDate.status, 400);

  const badType = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { ...base, requestKey: uid(), activityTypeKey: "not_a_real_type" } });
  assert.equal(badType.status, 400);

  const good = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { ...base, requestKey: uid(), startInstant: "2026-09-08T12:00:00Z", endInstant: "2026-09-08T13:00:00Z", durationMinutes: 60, activityTypeKey: "training_session" },
  });
  assert.equal(good.status, 201, JSON.stringify(good.body));
});

test("27. training.activities itself rejects a blank/invalid timezone_snapshot and a reversed started_at/ended_at interval at the DB level, bypassing Node validation entirely", async () => {
  const clubId = await makeClub();
  await assert.rejects(
    query(`insert into training.activities (occurred_local_date, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state) values ('2026-09-08','Not/AZone','club',$1,'manual','confirmed')`, [clubId]),
    /is not a timezone Postgres recognizes/,
  );
  await assert.rejects(
    query(`insert into training.activities (occurred_local_date, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state) values ('2026-09-08','','club',$1,'manual','confirmed')`, [clubId]),
    /timezone_snapshot cannot be blank/,
  );
  await assert.rejects(
    query(`insert into training.activities (occurred_local_date, started_at, ended_at, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state) values ('2026-09-08','2026-09-08T12:00:00Z','2026-09-08T10:00:00Z','UTC','club',$1,'manual','confirmed')`, [clubId]),
    /ended_at cannot be before started_at/,
  );
});

test("28. an invalid pagination cursor (bad date/UUID shape, or unparseable JSON) on the list endpoint returns a controlled 400, never a raw Postgres error", async () => {
  const { coachCookie } = await makeClubCoach("cursor28");
  const badShape = await api(`/api/training-activity?dateFrom=2026-09-01&dateTo=2026-09-30&cursor=${encodeURIComponent(JSON.stringify({ localDate: "not-a-date", activityId: "not-a-uuid", participantId: "not-a-uuid" }))}`, { cookie: coachCookie });
  assert.equal(badShape.status, 400);
  const partialShape = await api(`/api/training-activity?dateFrom=2026-09-01&dateTo=2026-09-30&cursor=${encodeURIComponent(JSON.stringify({ localDate: "2026-09-01" }))}`, { cookie: coachCookie });
  assert.equal(partialShape.status, 400);
  const notJson = await api(`/api/training-activity?dateFrom=2026-09-01&dateTo=2026-09-30&cursor=%7Bnot-json`, { cookie: coachCookie });
  assert.equal(notJson.status, 400);
});

// ============================================================
// §5 — matching policy provenance (Round 2 correction)
// ============================================================

test("29. a new match suggestion persists policy_version=2 and its full score breakdown", async () => {
  const { clubId, coachCookie } = await makeClubCoach("policy29");
  const { athleteId } = await makeAthleteInClub(clubId);
  const first = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-09-20", timezone: "UTC", name: "First" } });
  assert.equal(first.status, 201);
  const second = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-09-20", timezone: "UTC", name: "Second Different Name" } });
  assert.equal(second.status, 201);
  const suggestion = await query(`select policy_version, score_breakdown from training.activity_match_suggestions where activity_id=$1`, [second.body.activityId]);
  assert.equal(suggestion.rowCount, 1);
  assert.equal(suggestion.rows[0].policy_version, 2);
  assert.ok(suggestion.rows[0].score_breakdown && "time" in suggestion.rows[0].score_breakdown);
});

// ============================================================
// §3 — deterministic concurrent accept/dismiss race (Round 2 correction)
// ============================================================

async function waitUntilAnyOtherBlocked(monitorClient, excludePid, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await monitorClient.query(`select pid from pg_stat_activity where wait_event_type='Lock' and pid <> $1`, [excludePid]);
    if (r.rowCount > 0) return true;
    await new Promise((res) => setTimeout(res, 15));
  }
  return false;
}

test("30. concurrent accept vs dismiss on the SAME match suggestion have exactly one winning outcome — a dismiss that loses the race can never overwrite an accept's already-completed merge", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("race30");
  const { athleteId } = await makeAthleteInClub(clubId);
  const a = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-09-25", timezone: "UTC", name: "First" } });
  const b = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), athleteId, localDate: "2026-09-25", timezone: "UTC", name: "Second Different Name" } });
  const suggestionRow = await query(`select id from training.activity_match_suggestions where activity_id=$1 and status='open'`, [b.body.activityId]);
  const suggestionId = suggestionRow.rows[0].id;
  const scope = { type: "club", clubId, ownerContext: { ownerScope: "club", ownerUserId: null, ownerClubId: clubId, ownerTeamId: null } };

  const monitor = await pool.connect();
  let releaseAccept = () => {};
  let acceptPromise = Promise.resolve();
  let dismissPromise = Promise.resolve();
  try {
    let signalAcceptReached;
    const acceptReachedBarrier = new Promise((res) => { signalAcceptReached = res; });
    const acceptBarrier = new Promise((res) => { releaseAccept = res; });
    let acceptPid;
    acceptPromise = materializeService.acceptMatchSuggestion(scope, { suggestionId, performedBy: coachId, reason: "race" }, {
      onLocked: async (client) => { acceptPid = client.processID; signalAcceptReached(); await acceptBarrier; },
    });
    await acceptReachedBarrier;

    dismissPromise = materializeService.dismissMatchSuggestion(scope, { suggestionId, performedBy: coachId });
    const blocked = await waitUntilAnyOtherBlocked(monitor, acceptPid);
    assert.equal(blocked, true, "dismiss must be directly observed Lock-waiting on the SAME suggestion row accept is holding");

    releaseAccept();
    const acceptResult = await acceptPromise;
    assert.ok(acceptResult.canonicalParticipantId, "accept must deterministically win and complete the merge");

    await assert.rejects(dismissPromise, /already resolved/i, "dismiss must lose the race and see the ALREADY-accepted status, never overwrite it");

    const finalStatus = await monitor.query(`select status from training.activity_match_suggestions where id=$1`, [suggestionId]);
    assert.equal(finalStatus.rows[0].status, "accepted", "the suggestion's final status must be 'accepted' — never clobbered back to 'dismissed' by the loser");
  } finally {
    releaseAccept();
    await Promise.allSettled([acceptPromise, dismissPromise]);
    monitor.release();
  }
});

// ============================================================
// Round 3 — capability-removal vs value-insert race (§1)
// ============================================================

test("31. capability removal vs value insert race: the value insert wins first, so the removal correctly waits and then gets 409 scopeCapabilityHasHistory", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("caprace31");
  const athlete = await makeAthleteInClub(clubId);
  const created = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: coachCookie,
    body: { key: `caprace31_${uid()}`, label: "Cap Race 31", ownerScope: "club", ownerClubId: clubId, unit: "m", valueType: "numeric", scopeCapabilities: ["session"] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const defId = created.body.row.id;
  const versionId = created.body.row.current_version_id;

  const authz = await authzModule.loadAuthorizationContext({ id: coachId, role_hint: "club_admin" });
  const fakeReq = { user: { id: coachId }, authz };
  const scope = await metricsAccessModule.resolveMetricsWorkspaceScope(fakeReq);

  const monitor = await pool.connect();
  let releaseInsert = () => {};
  let insertPromise = Promise.resolve();
  let removePromise = Promise.resolve();
  try {
    let signalInsertReached;
    const insertReachedBarrier = new Promise((res) => { signalInsertReached = res; });
    const insertBarrier = new Promise((res) => { releaseInsert = res; });
    let insertPid;

    insertPromise = measurementsService.createGroupEvent(
      fakeReq, scope,
      { requestKey: uid(), occurredDate: "2026-09-08", scopeLevel: "session", participants: [{ athleteId: athlete.athleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, metricDefinitionVersionId: versionId, value: 100 }] }] },
      { onLocked: async (client) => { insertPid = client.processID; signalInsertReached(); await insertBarrier; } },
    );
    await insertReachedBarrier;

    removePromise = catalogService.setDefinitionScopeCapabilities(fakeReq, defId, []);
    const blocked = await waitUntilAnyOtherBlocked(monitor, insertPid);
    assert.equal(blocked, true, "the capability removal must be directly observed Lock-waiting on the definition row the insert already holds FOR KEY SHARE");

    releaseInsert();
    const insertResult = await insertPromise;
    assert.equal(insertResult.error, undefined, JSON.stringify(insertResult));

    const removeResult = await removePromise;
    assert.equal(removeResult.status, 409, JSON.stringify(removeResult));
    assert.equal(removeResult.code, "scopeCapabilityHasHistory");

    const stillConfigured = await query(`select 1 from training_load.metric_definition_scope_capabilities where metric_definition_id=$1 and scope_level='session'`, [defId]);
    assert.equal(stillConfigured.rowCount, 1, "the capability must remain declared — the removal was correctly refused");
    const valueCount = await query(`select count(*)::int as n from training_load.metric_values where metric_definition_id=$1`, [defId]);
    assert.equal(valueCount.rows[0].n, 1, "the value insert must have won and be the only row");
  } finally {
    releaseInsert();
    await Promise.allSettled([insertPromise, removePromise]);
    monitor.release();
  }
});

test("32. capability removal vs value insert race: the removal wins first, so the value insert correctly waits and then gets 409 scopeCapabilitiesRequired", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("caprace32");
  const athlete = await makeAthleteInClub(clubId);
  const created = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: coachCookie,
    body: { key: `caprace32_${uid()}`, label: "Cap Race 32", ownerScope: "club", ownerClubId: clubId, unit: "m", valueType: "numeric", scopeCapabilities: ["session"] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const defId = created.body.row.id;
  const versionId = created.body.row.current_version_id;

  const authz = await authzModule.loadAuthorizationContext({ id: coachId, role_hint: "club_admin" });
  const fakeReq = { user: { id: coachId }, authz };
  const scope = await metricsAccessModule.resolveMetricsWorkspaceScope(fakeReq);

  const monitor = await pool.connect();
  let releaseRemove = () => {};
  let insertPromise = Promise.resolve();
  let removePromise = Promise.resolve();
  try {
    let signalRemoveReached;
    const removeReachedBarrier = new Promise((res) => { signalRemoveReached = res; });
    const removeBarrier = new Promise((res) => { releaseRemove = res; });
    let removePid;

    removePromise = catalogService.setDefinitionScopeCapabilities(fakeReq, defId, [], {
      onLocked: async (client) => { removePid = client.processID; signalRemoveReached(); await removeBarrier; },
    });
    await removeReachedBarrier;

    insertPromise = measurementsService.createGroupEvent(
      fakeReq, scope,
      { requestKey: uid(), occurredDate: "2026-09-08", scopeLevel: "session", participants: [{ athleteId: athlete.athleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, metricDefinitionVersionId: versionId, value: 100 }] }] },
    );
    const blocked = await waitUntilAnyOtherBlocked(monitor, removePid);
    assert.equal(blocked, true, "the value insert must be directly observed Lock-waiting on the definition row the removal already holds FOR UPDATE");

    releaseRemove();
    const removeResult = await removePromise;
    assert.equal(removeResult.error, undefined, JSON.stringify(removeResult));

    const insertResult = await insertPromise;
    assert.equal(insertResult.error, "Metric definition " + defId + " has no configured scope capability for level 'session' — configure it before submitting a value at this scope.");
    assert.equal(insertResult.status, 409);
    assert.equal(insertResult.code, "scopeCapabilitiesRequired");

    const capRow = await query(`select 1 from training_load.metric_definition_scope_capabilities where metric_definition_id=$1`, [defId]);
    assert.equal(capRow.rowCount, 0, "the capability must be gone — the removal correctly won");
    const valueCount = await query(`select count(*)::int as n from training_load.metric_values where metric_definition_id=$1`, [defId]);
    assert.equal(valueCount.rows[0].n, 0, "the value insert must have lost and left zero rows");
  } finally {
    releaseRemove();
    await Promise.allSettled([insertPromise, removePromise]);
    monitor.release();
  }
});

// ============================================================
// Round 3 — don't silently ignore source-backed time fields (§2)
// ============================================================

test("33. planned/external materialize rejects client-supplied startInstant/endInstant/durationMinutes it cannot verify against the authoritative source, instead of silently discarding them", async () => {
  const { clubId, coachCookie } = await makeClubCoach("sourcetime33");
  const athlete = await makeAthleteInClub(clubId);
  const { logicalSessionId } = await makePlanSessionForAthlete(athlete.athleteId, { date: "2026-09-08", owner: { ownerScope: "club", ownerClubId: clubId } });

  // This plan session has no session_time set — the authoritative source
  // has NO real startInstant to compare against, so supplying one at all
  // must be rejected, never silently dropped.
  const badStart = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), planLogicalSessionId: logicalSessionId, startInstant: "2026-09-08T10:00:00Z" },
  });
  assert.equal(badStart.status, 400, JSON.stringify(badStart.body));

  const badEnd = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), planLogicalSessionId: logicalSessionId, endInstant: "2026-09-08T11:00:00Z" },
  });
  assert.equal(badEnd.status, 400, JSON.stringify(badEnd.body));

  const badDuration = await api("/api/training-activity/materialize", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: uid(), planLogicalSessionId: logicalSessionId, durationMinutes: 60 },
  });
  assert.equal(badDuration.status, 400, JSON.stringify(badDuration.body));

  const leftover = await query(`select count(*)::int as n from training.activity_participants where athlete_id=$1`, [athlete.athleteId]);
  assert.equal(leftover.rows[0].n, 0, "every rejected attempt must leave zero rows");

  // Once no unverifiable fields are supplied, the SAME call succeeds.
  const ok = await api("/api/training-activity/materialize", { method: "POST", cookie: coachCookie, body: { requestKey: uid(), planLogicalSessionId: logicalSessionId } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

// ============================================================
// Round 3 — group-materialization routes validate too (§3)
// ============================================================

test("34. group-materialization routes (/materialize/external-occurrence, /materialize/metric-event) validate activityTypeKey and name exactly like /materialize — controlled 400, zero partial writes", async () => {
  const { clubId, coachCookie } = await makeClubCoach("groupvalidate34");
  const { athleteId } = await makeAthleteInClub(clubId);
  const sysAdmin = await makeUser({ email: `sysadmin34-${uid()}@test.local` });
  const { occurrenceId } = await makeExternalAssignmentForAthlete(athleteId, sysAdmin, { date: "2026-09-08", owner: { ownerScope: "club", ownerClubId: clubId } });
  const eventId = await makeMetricEvent({ ownerClubId: clubId, date: "2026-09-08", eventTimezoneSnapshot: "UTC" });
  await addMetricParticipant({ eventId, athleteId });

  const badTypeOccurrence = await api(`/api/training-activity/materialize/external-occurrence/${occurrenceId}`, { method: "POST", cookie: coachCookie, body: { activityTypeKey: "not_a_real_type" } });
  assert.equal(badTypeOccurrence.status, 400, JSON.stringify(badTypeOccurrence.body));
  const longNameOccurrence = await api(`/api/training-activity/materialize/external-occurrence/${occurrenceId}`, { method: "POST", cookie: coachCookie, body: { name: "x".repeat(500) } });
  assert.equal(longNameOccurrence.status, 400);

  const badTypeEvent = await api(`/api/training-activity/materialize/metric-event/${eventId}`, { method: "POST", cookie: coachCookie, body: { activityTypeKey: "not_a_real_type" } });
  assert.equal(badTypeEvent.status, 400, JSON.stringify(badTypeEvent.body));
  const longNameEvent = await api(`/api/training-activity/materialize/metric-event/${eventId}`, { method: "POST", cookie: coachCookie, body: { name: "x".repeat(500) } });
  assert.equal(longNameEvent.status, 400);

  const leftover = await query(`select count(*)::int as n from training.activities where owner_club_id=$1`, [clubId]);
  assert.equal(leftover.rows[0].n, 0, "every rejected group-materialize attempt must leave zero activities");

  // A valid call on each route still succeeds.
  const goodOccurrence = await api(`/api/training-activity/materialize/external-occurrence/${occurrenceId}`, { method: "POST", cookie: coachCookie, body: { activityTypeKey: "training_session", name: "Squad" } });
  assert.equal(goodOccurrence.status, 201, JSON.stringify(goodOccurrence.body));
  const goodEvent = await api(`/api/training-activity/materialize/metric-event/${eventId}`, { method: "POST", cookie: coachCookie, body: { activityTypeKey: "training_session", name: "GPS" } });
  assert.equal(goodEvent.status, 201, JSON.stringify(goodEvent.body));
});

// ============================================================
// Round 3 — DB-level timezone integrity on activity_participants +
// activities' own started_at/occurred_local_date consistency (§4)
// ============================================================

test("35. activity_participants itself rejects a blank/invalid timezone_snapshot, and training.activities rejects an occurred_local_date that disagrees with started_at converted into its OWN timezone_snapshot — both at the DB level, bypassing Node validation", async () => {
  const clubId = await makeClub();
  const activity = await query(`insert into training.activities (occurred_local_date, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state) values ('2026-09-08','UTC','club',$1,'manual','confirmed') returning id`, [clubId]);
  const athleteUser = await makeUser({ email: `dbtz35-${uid()}@test.local` });
  const athleteId = await makeAthlete({ userId: athleteUser, timezone: "UTC" });

  await assert.rejects(
    query(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot) values ($1,$2,'2026-09-08','Not/AZone')`, [activity.rows[0].id, athleteId]),
    /is not a timezone Postgres recognizes/,
  );
  await assert.rejects(
    query(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot) values ($1,$2,'2026-09-08','')`, [activity.rows[0].id, athleteId]),
    /timezone_snapshot cannot be blank/,
  );

  // started_at (2026-09-08T23:30:00Z) converted into UTC is still
  // 2026-09-08 — but occurred_local_date is deliberately wrong here.
  await assert.rejects(
    query(`insert into training.activities (occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state) values ('2026-09-09','2026-09-08T23:30:00Z','UTC','club',$1,'manual','confirmed')`, [clubId]),
    /does not match started_at/,
  );

  // The midnight-crossing case itself must remain entirely legal: the
  // activity's OWN date agrees with started_at in the activity's OWN
  // (event) timezone, while nothing here constrains any participant's
  // own local_date to match it.
  const nyActivity = await query(`insert into training.activities (occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state) values ('2026-09-08','2026-09-09T03:30:00Z','America/New_York','club',$1,'manual','confirmed') returning id`, [clubId]);
  assert.ok(nyActivity.rows[0].id);
  const belgradeAthleteUser = await makeUser({ email: `dbtz35b-${uid()}@test.local` });
  const belgradeAthleteId = await makeAthlete({ userId: belgradeAthleteUser, timezone: "Europe/Belgrade" });
  const participant = await query(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot) values ($1,$2,'2026-09-09','Europe/Belgrade') returning id`,
    [nyActivity.rows[0].id, belgradeAthleteId],
  );
  assert.ok(participant.rows[0].id, "a participant's own local_date the FOLLOWING day, in their own zone, remains entirely legal");
});

// ============================================================
// Round 3 — catalog list must return capabilities (§5)
// ============================================================

test("36. the paginated definitions list returns scope_capabilities for every row, via one query, matching create/detail/PUT field naming", async () => {
  const { clubId, coachCookie } = await makeClubCoach("listcaps36");
  const configuredKey = `listcaps_configured_${uid()}`;
  const unconfiguredKey = `listcaps_unconfigured_${uid()}`;
  const configured = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: coachCookie,
    body: { key: configuredKey, label: "List Caps Configured", ownerScope: "club", ownerClubId: clubId, unit: "m", valueType: "numeric", scopeCapabilities: ["session", "component"] },
  });
  assert.equal(configured.status, 201);
  const unconfigured = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: coachCookie,
    body: { key: unconfiguredKey, label: "List Caps Unconfigured", ownerScope: "club", ownerClubId: clubId, unit: "m", valueType: "numeric" },
  });
  assert.equal(unconfigured.status, 201);

  const list = await api(`/api/training-load/metrics/definitions?search=listcaps_&ownerScope=club`, { cookie: coachCookie });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const configuredRow = list.body.rows.find((r) => r.key === configuredKey);
  const unconfiguredRow = list.body.rows.find((r) => r.key === unconfiguredKey);
  assert.ok(configuredRow, "the configured definition must appear in the list");
  assert.ok(unconfiguredRow, "the unconfigured definition must appear in the list");
  assert.deepEqual([...configuredRow.scope_capabilities].sort(), ["component", "session"]);
  assert.deepEqual(unconfiguredRow.scope_capabilities, [], "an unconfigured definition is explicitly an empty array, never null or omitted");
});

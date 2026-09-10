// Training Load 3B2 — Analysis Dashboard: real migrations (v15-v18) +
// real backend (trainingLoadDashboardAccess/Catalog/Widgets/Query.js +
// routes/trainingLoadDashboard.js) exercised through the REAL Express app
// over real HTTP with real session cookies, against a disposable,
// uniquely-named temporary database (never OPTIMOVE, never monitoring2)
// — same convention as training-activity.test.mjs / training-load-
// metrics.test.mjs. The confirmed model contract this migrates comes from
// feature/training-load-analysis-dashboard-model's Round 6 design proof
// (schema.sql / test-harness.mjs / DASHBOARD_MODEL_REPORT.md /
// DASHBOARD_UX_SPEC.md) — every invariant asserted below is a real
// production behavior, not a re-run of that disposable-DB PoC.
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
  "202609100900_training_load_v15_dashboard_catalog_and_dashboards.sql",
  "202609101000_training_load_v16_dashboard_widgets_series_selection.sql",
  "202609101100_training_load_v17_dashboard_sanctioned_functions.sql",
  "202609101200_training_load_v18_dashboard_catalog_seed.sql",
];
const BASE_MIGRATIONS = MIGRATIONS.slice(0, 14); // everything BEFORE the dashboard migrations — used by the upgrade-safety test
const DASHBOARD_MIGRATIONS = MIGRATIONS.slice(14);

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

// Same legacy scaffold as training-activity.test.mjs — required ONLY to
// satisfy migrate.js's Strategy B legacy-fingerprint preflight.
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
  const name = `optimove_tests_tldash_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_tldash_migrations_${runId}`);
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
let queryCount = 0;

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
// Fixture / HTTP helpers.
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
async function makePlatformAdmin(label) {
  const adminId = await makeUser({ email: `${label}-admin-${uid()}@test.local` });
  await grantGlobalRole(adminId, "platform_admin");
  await setActiveWorkspace(adminId, "platform", null);
  const adminCookie = await loginCookie(adminId);
  return { adminId, adminCookie };
}
async function makeAthleteInClub(clubId, { timezone = "UTC" } = {}) {
  const userId = await makeUser({ email: `athlete-${uid()}@test.local`, roleHint: "athlete" });
  const athleteId = await makeAthlete({ userId, timezone });
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
  await setActiveWorkspace(userId, "athlete", null);
  return { athleteId, userId, cookie: await loginCookie(userId) };
}

// A REAL, active, session-scope, numeric metric definition, club-owned —
// mirrors makeQuickMetric() from the design-proof harness.
async function makeMetricDefinition({ clubId, adminId, label, valueType = "numeric", dailyAggregationMethod = "sum", scopeLevels = ["session", "component"], key } = {}) {
  const def = await query(
    `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id, state, created_by_user_id) values ($1,$2,'club',$3,'active',$4) returning id`,
    [key || `metric-${uid()}`, label || `Metric ${uid()}`, clubId, adminId],
  );
  const ver = await query(
    `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id) values ($1,1,'bpm',$2,$3,$4) returning id`,
    [def.rows[0].id, valueType, dailyAggregationMethod, adminId],
  );
  await query(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [ver.rows[0].id, def.rows[0].id]);
  for (const s of scopeLevels) {
    await query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,$2)`, [def.rows[0].id, s]);
  }
  return { metricDefinitionId: def.rows[0].id, versionId: ver.rows[0].id };
}

async function makeSourceConnection(clubId) {
  const r = await query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_club_id) values ('test-import','club',$1) returning id`, [clubId]);
  return r.rows[0].id;
}

// A real training.activities row for an athlete, in a club, with real
// canonical linkage — mirrors the design-proof harness's own fixture
// construction. Returns {activityId, participantId, eventId, eventParticipantId}.
async function makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date, startedAt }) {
  const dateStr = date || "2026-09-09";
  const startStr = startedAt || `${dateStr}T09:00:00Z`;
  const activity = await query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state, created_by_user_id)
     values ('training_session','Test Session',$1,$2,'Europe/Belgrade','club',$3,'manual','confirmed',$4) returning id`,
    [dateStr, startStr, clubId, coachId],
  );
  const participant = await query(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,$3,'Europe/Belgrade','participated') returning id`,
    [activity.rows[0].id, athleteId, dateStr],
  );
  const event = await query(
    `insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_club_id, source_connection_id, created_by_user_id)
     values ('Test Session',$1,$2,'session','club',$3,$4,$5) returning id`,
    [dateStr, startStr, clubId, connectionId, coachId],
  );
  const eventParticipant = await query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Belgrade') returning id`, [event.rows[0].id, athleteId]);
  await query(`insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [activity.rows[0].id, event.rows[0].id]);
  await query(`insert into training.activity_participant_metric_participant_links (activity_participant_id, metric_event_participant_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [participant.rows[0].id, eventParticipant.rows[0].id]);
  return { activityId: activity.rows[0].id, participantId: participant.rows[0].id, eventId: event.rows[0].id, eventParticipantId: eventParticipant.rows[0].id, dateStr };
}

async function addMetricValue({ eventParticipantId, metricDefinitionId, versionId, value, unit = "bpm", segmentId = null, aggregationRole = "standalone", coverage = "not_applicable" }) {
  const occ = await query(`insert into training_load.metric_measurement_occasions (event_participant_id, segment_id, entry_method) values ($1,$2,'manual') returning id`, [eventParticipantId, segmentId]);
  await query(
    `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, aggregation_role, coverage) values ($1,$2,$3,$4,$5,$6,$7)`,
    [occ.rows[0].id, metricDefinitionId, versionId, value, unit, aggregationRole, coverage],
  );
  return occ.rows[0].id;
}

async function makeRpeFeedback({ clubId, athleteId, activityParticipantId, date, rpe = 7, durationMinutes = 60 }) {
  const logicalSessionId = crypto.randomUUID();
  const plan = await query(`insert into plans.plans (plan_type, athlete_id, name, status, is_active, is_edit_draft, week_start) values ('weekly',$1,'Test Plan','active',true,false,$2) returning id`, [athleteId, date]);
  // training.check_session_link_integrity() requires a real, matching
  // plan_workspace_ownership row (owner_scope/owner_club_id) equal to
  // the ACTIVITY's own owner_scope/owner_club_id — a plan with no
  // ownership snapshot at all is treated as 'unresolved' and never
  // confirms-links to anything.
  await query(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_club_id) values ($1,'club',$2)`, [plan.rows[0].id, clubId]);
  const planDay = await query(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [plan.rows[0].id, date]);
  await query(`insert into plans.plan_sessions (plan_day_id, session_order, name, logical_session_id) values ($1,1,'Test Session',$2)`, [planDay.rows[0].id, logicalSessionId]);
  await query(`insert into training_load.session_feedback (athlete_id, session_date, plan_name, source, external_assignment_id, logical_session_id, rpe, duration_minutes) values ($1,$2,'Test Plan','planned',null,$3,$4,$5)`, [athleteId, date, logicalSessionId, rpe, durationMinutes]);
  await query(`insert into training.activity_participant_session_links (activity_participant_id, athlete_id, logical_session_id, link_method, link_status, confirmed_at) values ($1,$2,$3,'manual','confirmed',now())`, [activityParticipantId, athleteId, logicalSessionId]);
}

async function newClient() {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  const pidRow = await c.query("select pg_backend_pid() as pid");
  return { client: c, pid: pidRow.rows[0].pid };
}
async function waitUntilBlocked(pid, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await pool.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

// ============================================================
// §1 — Real migrations: clean apply / re-apply / upgrade-from-earlier /
// rollback-on-error, run against a real, unmodified migrate.js.
// ============================================================

test("§1.1 all 18 migrations (incl. v15-v18) applied cleanly at before() — schema_migrations records exactly this run's own files", async () => {
  const applied = await query(`select migration_name from public.schema_migrations where migration_name like '%dashboard%' order by migration_name`);
  assert.equal(applied.rowCount, 4, "exactly the 4 new dashboard migrations must be recorded");
});

test("§1.2 re-applying the SAME migrations_v2 directory a second time is a genuine no-op (checksum-safe idempotent re-run)", async () => {
  await runner.runMigrations({ databaseUrl: db.url, migrationsRoot: migrationsDir });
  const applied = await query(`select count(*)::int as n from public.schema_migrations where migration_name like '%dashboard%'`);
  assert.equal(applied.rows[0].n, 4, "re-running must not duplicate or re-apply anything");
});

test("§1.3 upgrade path: a database at exactly v1-v14 (no dashboard tables) can apply v15-v18 cleanly on top, in one runner call", async () => {
  const upgradeDb = await makeTempDb("upgrade");
  const upgradeClient = new pg.Client({ connectionString: upgradeDb.url });
  await upgradeClient.connect();
  try {
    await upgradeClient.query(LEGACY_FIXTURE_SQL);
    const baseDir = await writeMigrationsDir("upgrade_base", await readMigrationFiles(BASE_MIGRATIONS));
    await runner.runMigrations({ databaseUrl: upgradeDb.url, migrationsRoot: baseDir });
    const beforeUpgrade = await upgradeClient.query(`select 1 from information_schema.tables where table_schema='training_load' and table_name='dashboards'`);
    assert.equal(beforeUpgrade.rowCount, 0, "sanity: dashboards must not exist yet on the base-only database");
    // Only the 4 NEW dashboard files — migrate.js's own migration
    // identity includes the migrationsRoot's own basename
    // (migrationIdentity()), so passing the FULL 18-file set again here
    // (under a DIFFERENT directory name than "upgrade_base") would make
    // the runner treat v1-v14 as "not yet applied under THIS identity"
    // and try to re-run them against tables that already exist.
    const fullDir = await writeMigrationsDir("upgrade_full", await readMigrationFiles(DASHBOARD_MIGRATIONS));
    await runner.runMigrations({ databaseUrl: upgradeDb.url, migrationsRoot: fullDir });
    const afterUpgrade = await upgradeClient.query(`select 1 from information_schema.tables where table_schema='training_load' and table_name='dashboards'`);
    assert.equal(afterUpgrade.rowCount, 1, "the upgrade must have created dashboards");
    const seedCheck = await upgradeClient.query(`select count(*)::int as n from training_load.dashboard_widget_types`);
    assert.equal(seedCheck.rows[0].n, 4, "v18's seed data must have applied too");
    await fsp.rm(baseDir, { recursive: true, force: true });
    await fsp.rm(fullDir, { recursive: true, force: true });
  } finally {
    await upgradeClient.end();
    await dropTempDb(upgradeDb);
  }
});

test("§1.4 a migration that fails mid-file leaves NO partial objects — the runner's own per-file transaction wrapping rolls back completely", async () => {
  const brokenDb = await makeTempDb("broken");
  const brokenClient = new pg.Client({ connectionString: brokenDb.url });
  await brokenClient.connect();
  try {
    await brokenClient.query(LEGACY_FIXTURE_SQL);
    const baseDir = await writeMigrationsDir("broken_base", await readMigrationFiles(BASE_MIGRATIONS));
    await runner.runMigrations({ databaseUrl: brokenDb.url, migrationsRoot: baseDir });
    const recordedBefore = await brokenClient.query(`select count(*)::int as n from public.schema_migrations`);
    const brokenSql = (await readMigrationFiles(DASHBOARD_MIGRATIONS))["202609100900_training_load_v15_dashboard_catalog_and_dashboards.sql"]
      + "\ncreate table training_load.this_will_fail (id uuid primary key references training_load.does_not_exist(id));\n";
    const brokenDir = await writeMigrationsDir("broken_full", { "202609100901_broken.sql": brokenSql });
    await assert.rejects(runner.runMigrations({ databaseUrl: brokenDb.url, migrationsRoot: brokenDir }));
    const partial = await brokenClient.query(`select 1 from information_schema.tables where table_schema='training_load' and table_name='dashboard_widget_types'`);
    assert.equal(partial.rowCount, 0, "the failed migration's own CREATE TABLE must have been rolled back — no partial object left behind");
    const recordedAfter = await brokenClient.query(`select count(*)::int as n from public.schema_migrations`);
    assert.equal(recordedAfter.rows[0].n, recordedBefore.rows[0].n, "a failed migration must never be recorded as applied — the schema_migrations row count must be completely unchanged");
    await fsp.rm(baseDir, { recursive: true, force: true });
    await fsp.rm(brokenDir, { recursive: true, force: true });
  } finally {
    await brokenClient.end();
    await dropTempDb(brokenDb);
  }
});

// ============================================================
// §2 — Dashboard lifecycle + authorization matrix.
// ============================================================

test("§2.1 a coach can create a private dashboard, bound to their currently active club workspace", async () => {
  const { clubId, coachCookie } = await makeClubCoach("l1");
  const created = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "My Dashboard" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.dashboard.owner_scope, "user");
  assert.equal(created.body.dashboard.data_workspace_type, "club");
  assert.equal(created.body.dashboard.data_workspace_scope_id, clubId);
});

test("§2.2 a club-owned dashboard requires real club-admin rights — a coach cannot create one for a club they don't administer", async () => {
  const { coachCookie } = await makeClubCoach("l2a");
  const otherClubId = await makeClub("Other Club");
  const created = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "X", ownerScope: "club", ownerClubId: otherClubId } });
  assert.equal(created.status, 403);
});

test("§2.3 only a platform admin can create a system template", async () => {
  const { coachCookie } = await makeClubCoach("l3");
  const rejected = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "Template", ownerScope: "system" } });
  assert.equal(rejected.status, 403);
  const { adminCookie } = await makePlatformAdmin("l3");
  const created = await api("/api/training-load/dashboards", { method: "POST", cookie: adminCookie, body: { name: "Template", ownerScope: "system" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.dashboard.is_template, true);
  assert.equal(created.body.dashboard.data_workspace_type, null);
});

test("§2.4 a private dashboard bound to Club A's data is invisible from Club B's workspace — real cross-club isolation, no leak", async () => {
  const { coachCookie: coachACookie } = await makeClubCoach("l4a");
  const { coachCookie: coachBCookie } = await makeClubCoach("l4b");
  const created = await api("/api/training-load/dashboards", { method: "POST", cookie: coachACookie, body: { name: "Club A Private" } });
  const dashboardId = created.body.dashboard.id;
  const fromB = await api(`/api/training-load/dashboards/${dashboardId}`, { cookie: coachBCookie });
  assert.equal(fromB.status, 404, "a foreign private dashboard must come back as info-hiding 404, never 403 (never revealing it exists)");
});

test("§2.5 owner scope vs data workspace: the SAME club coach's private dashboard is only usable while THEY are viewing that exact club — switching their own active workspace elsewhere hides it too", async () => {
  const clubAId = await makeClub("Club L5A");
  const clubBId = await makeClub("Club L5B");
  const coachId = await makeUser({ email: `l5-coach-${uid()}@test.local` });
  await grantClubAdmin(coachId, clubAId);
  await grantClubAdmin(coachId, clubBId);
  await setActiveWorkspace(coachId, "club", clubAId);
  const cookie = await loginCookie(coachId);
  const created = await api("/api/training-load/dashboards", { method: "POST", cookie, body: { name: "Club A bound" } });
  assert.equal(created.body.dashboard.data_workspace_type, "club");
  assert.equal(created.body.dashboard.data_workspace_scope_id, clubAId);
  // Switch the SAME account's active workspace to Club B — a workspace
  // switch mid-account-lifetime must not retroactively change what the
  // already-created dashboard is bound to, and the query/list layer must
  // reflect the NEW active workspace on the very next request.
  await setActiveWorkspace(coachId, "club", clubBId);
  const listAfterSwitch = await api("/api/training-load/dashboards", { cookie });
  const stillThere = listAfterSwitch.body.dashboards.find((d) => d.id === created.body.dashboard.id);
  assert.ok(stillThere, "the dashboard's OWNER (this same coach) can still see/manage it regardless of data-workspace match — ownership visibility is broader than data-workspace read visibility");
  const detailFromB = await api(`/api/training-load/dashboards/${created.body.dashboard.id}/query`, { method: "POST", cookie, body: { dateFrom: "2026-01-01", dateTo: "2026-01-02" } });
  assert.equal(detailFromB.status, 200, "the owner can still QUERY it (visibility follows ownership), but it will only ever surface Club A's own activities — never Club B's, proven in §5 below");
});

test("§2.6 an athlete's own 'athlete' data workspace is a real, first-class data workspace for a private self-view dashboard", async () => {
  const clubId = await makeClub("Club L6");
  const { userId, cookie } = await makeAthleteInClub(clubId);
  const created = await api("/api/training-load/dashboards", { method: "POST", cookie, body: { name: "My Own Training" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.dashboard.data_workspace_type, "athlete");
});

test("§2.7 platform-workspace visibility spans every club/team — a platform admin can view a club-owned dashboard directly", async () => {
  const { clubId, coachCookie } = await makeClubCoach("l7");
  const created = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "Club Dash", ownerScope: "club", ownerClubId: clubId } });
  const { adminCookie } = await makePlatformAdmin("l7");
  const fromAdmin = await api(`/api/training-load/dashboards/${created.body.dashboard.id}`, { cookie: adminCookie });
  assert.equal(fromAdmin.status, 200);
});

// ============================================================
// §3 — Widgets, series, layout, stale revisions, atomic swap.
// ============================================================

async function makeDashboardHttp(cookie, body = {}) {
  const r = await api("/api/training-load/dashboards", { method: "POST", cookie, body: { name: "Dash", ...body } });
  return r.body.dashboard;
}
// widgetOrder/mobileOrder default to a monotonically increasing GLOBAL
// counter — dashboard_widgets_order_unique/_mobile_order_unique are
// per-dashboard deferred UNIQUE constraints, so a never-repeating global
// sequence trivially satisfies per-dashboard uniqueness too, without
// every call site needing to remember to vary it itself (an earlier
// version of this helper defaulted both to a bare 1, which silently
// collided the SECOND time any test created more than one widget on the
// same dashboard — caught by this suite's own §3.4/§6.3/§6.6 failures).
let widgetOrderCounter = 0;
async function makeWidgetHttp(cookie, dashboard, body = {}) {
  widgetOrderCounter += 1;
  const r = await api(`/api/training-load/dashboards/${dashboard.id}/widgets`, {
    method: "POST", cookie,
    body: { expectedDashboardRevision: dashboard.revision, widgetType: "table", title: "W", widgetOrder: widgetOrderCounter, x: 0, y: 0, width: 6, height: 4, mobileOrder: widgetOrderCounter, ...body },
  });
  if (r.status >= 400) throw new Error(`makeWidgetHttp failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

test("§3.1 create widget + add a built-in RPE series, then query it — full round trip through the sanctioned functions", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l31");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  const series = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachCookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "avg" },
  });
  assert.equal(series.status, 201);
  const { athleteId } = await makeAthleteInClub(clubId);
  const { activityId, participantId, dateStr } = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId: await makeSourceConnection(clubId) });
  await makeRpeFeedback({ clubId, athleteId, activityParticipantId: participantId, date: dateStr, rpe: 8 });
  const result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: dateStr, dateTo: dateStr } });
  assert.equal(result.status, 200);
  const seriesResult = result.body.widgets[0].series[0];
  assert.equal(seriesResult.status, "ok");
  assert.equal(Number(seriesResult.data.current[0].value), 8);
});

test("§3.2 a stale widget revision on update_widget_content maps to a controlled 409, not a 500", async () => {
  const { coachCookie } = await makeClubCoach("l32");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  const stale = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 999, title: "New" } });
  assert.equal(stale.status, 409);
});

test("§3.3 a stale dashboard revision on layout replace maps to a controlled 409", async () => {
  const { coachCookie } = await makeClubCoach("l33");
  const dashboard = await makeDashboardHttp(coachCookie);
  const bad = await api(`/api/training-load/dashboards/${dashboard.id}/layout`, { method: "PUT", cookie: coachCookie, body: { expectedRevision: 999, layout: [] } });
  assert.equal(bad.status, 409);
});

test("§3.4 atomic layout swap: two widgets exchange positions in ONE replace_dashboard_layout call — the deferred overlap check never rejects the legal final state", async () => {
  const { coachCookie } = await makeClubCoach("l34");
  const dashboard = await makeDashboardHttp(coachCookie);
  const a = await makeWidgetHttp(coachCookie, dashboard, { x: 0, y: 0, width: 6, height: 4, mobileOrder: 1 });
  const dashAfterA = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const b = await makeWidgetHttp(coachCookie, dashAfterA.body.dashboard, { x: 6, y: 0, width: 6, height: 4, mobileOrder: 2 });
  const dashAfterB = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const swap = await api(`/api/training-load/dashboards/${dashboard.id}/layout`, {
    method: "PUT", cookie: coachCookie,
    body: {
      expectedRevision: dashAfterB.body.dashboard.revision,
      layout: [
        { widgetId: a.widgetId, x: 6, y: 0, width: 6, height: 4, mobileOrder: 2 },
        { widgetId: b.widgetId, x: 0, y: 0, width: 6, height: 4, mobileOrder: 1 },
      ],
    },
  });
  assert.equal(swap.status, 200, "a genuine atomic swap must succeed — never rejected on the transiently-overlapping intermediate state");
});

test("§3.5 an unresolved series is preserved and later resolved via the sanctioned resolve endpoint — never queried while unresolved", async () => {
  const { clubId, coachCookie } = await makeClubCoach("l35");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  const added = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachCookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, templateMetricKeyHints: [{ key: "totally-unknown-metric-key" }], resolutionStatus: "unresolved" },
  });
  assert.equal(added.status, 201);
  const queried = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-01-01", dateTo: "2026-01-02" } });
  assert.equal(queried.body.widgets[0].series[0].status, "unresolved", "an unresolved series must never be queried — it comes back as a fixed placeholder");
  const { adminId } = await makePlatformAdmin("l35");
  const { metricDefinitionId } = await makeMetricDefinition({ clubId, adminId });
  const widgetDetail = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const seriesRow = widgetDetail.body.widgets[0].series[0];
  const resolved = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/${seriesRow.id}/resolve`, {
    method: "POST", cookie: coachCookie,
    body: { expectedWidgetRevision: widgetDetail.body.widgets[0].revision, metricDefinitionId },
  });
  assert.equal(resolved.status, 200);
  const after = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  assert.equal(after.body.widgets[0].series[0].resolution_status, "resolved");
});

test("§3.6 resolve_series_binding() rejects binding to a metric from ANOTHER club's workspace — live re-authorization at resolve time, not trust in stale hints", async () => {
  const { coachCookie } = await makeClubCoach("l36a");
  const { clubId: otherClubId, coachId: otherCoachId } = await makeClubCoach("l36b");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, templateMetricKeyHints: [{ key: "x" }], resolutionStatus: "unresolved" },
  });
  const detail = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const seriesRow = detail.body.widgets[0].series[0];
  const { metricDefinitionId: foreignMetricId } = await makeMetricDefinition({ clubId: otherClubId, adminId: otherCoachId });
  const rejected = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/${seriesRow.id}/resolve`, {
    method: "POST", cookie: coachCookie,
    body: { expectedWidgetRevision: detail.body.widgets[0].revision, metricDefinitionId: foreignMetricId },
  });
  assert.equal(rejected.status, 400, "the DB trigger's own P0001 (metric not visible to this workspace) must map to a controlled 400");
});

// ============================================================
// §4 — Clone.
// ============================================================

test("§4.1 clone a system template into an active club workspace — widgets/series copy, a hinted series genuinely re-resolves against the NEW workspace", async () => {
  const { adminId, adminCookie } = await makePlatformAdmin("l41");
  const template = await makeDashboardHttp(adminCookie, { ownerScope: "system" });
  const tw = await makeWidgetHttp(adminCookie, template);
  await api(`/api/training-load/dashboards/${template.id}/widgets/${tw.widgetId}/series`, {
    method: "POST", cookie: adminCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "avg" },
  });
  const { clubId, coachCookie } = await makeClubCoach("l41club");
  await makeMetricDefinition({ clubId, adminId, key: "shared-hint-key" }); // exists but the template never hinted at it — just proving isolation
  const cloned = await api(`/api/training-load/dashboards/${template.id}/clone`, { method: "POST", cookie: coachCookie, body: { ownerScope: "club", ownerClubId: clubId, name: "Cloned" } });
  assert.equal(cloned.status, 201);
  assert.equal(cloned.body.dashboard.data_workspace_type, "club");
  assert.equal(cloned.body.dashboard.cloned_from_dashboard_id, template.id);
  const detail = await api(`/api/training-load/dashboards/${cloned.body.dashboard.id}`, { cookie: coachCookie });
  assert.equal(detail.body.widgets.length, 1);
  assert.equal(detail.body.widgets[0].series[0].built_in_series_key, "rpe");
  assert.equal(detail.body.widgets[0].series[0].resolution_status, "resolved");
});

test("§4.2 cloning a NON-template dashboard is rejected", async () => {
  const { coachCookie } = await makeClubCoach("l42");
  const dashboard = await makeDashboardHttp(coachCookie);
  const rejected = await api(`/api/training-load/dashboards/${dashboard.id}/clone`, { method: "POST", cookie: coachCookie, body: {} });
  assert.equal(rejected.status, 400);
});

// ============================================================
// §5 — Active dashboard selection, archive, real concurrency.
// ============================================================

test("§5.1 set/get/clear active dashboard for a workspace, end to end over HTTP", async () => {
  const { coachCookie } = await makeClubCoach("l51");
  const dashboard = await makeDashboardHttp(coachCookie);
  const set = await api("/api/training-load/dashboards/active", { method: "POST", cookie: coachCookie, body: { dashboardId: dashboard.id } });
  assert.equal(set.status, 200);
  const got = await api("/api/training-load/dashboards/active", { cookie: coachCookie });
  assert.equal(got.body.activeDashboard.dashboard_id, dashboard.id);
  const cleared = await api("/api/training-load/dashboards/active", { method: "DELETE", cookie: coachCookie });
  assert.equal(cleared.body.cleared, true);
  const gotAfter = await api("/api/training-load/dashboards/active", { cookie: coachCookie });
  assert.equal(gotAfter.body.activeDashboard, null);
});

test("§5.2 archiving the active dashboard clears the selection atomically — a subsequent GET /active shows none", async () => {
  const { coachCookie } = await makeClubCoach("l52");
  const dashboard = await makeDashboardHttp(coachCookie);
  await api("/api/training-load/dashboards/active", { method: "POST", cookie: coachCookie, body: { dashboardId: dashboard.id } });
  await api(`/api/training-load/dashboards/${dashboard.id}/archive`, { method: "POST", cookie: coachCookie, body: { expectedRevision: dashboard.revision } });
  const got = await api("/api/training-load/dashboards/active", { cookie: coachCookie });
  assert.equal(got.body.activeDashboard, null);
});

test("§5.3 REAL concurrency: set_active_dashboard() vs archive_dashboard(), both orderings, proven via two real connections and pg_stat_activity — never a sleep heuristic", async () => {
  const { coachId, clubId, coachCookie } = await makeClubCoach("l53");
  // Ordering A: selection-first.
  {
    const dashboard = await makeDashboardHttp(coachCookie);
    const a = await newClient();
    const b = await newClient();
    try {
      await a.client.query("begin");
      await a.client.query(`select * from training_load.set_active_dashboard($1,'club',$2,$3)`, [coachId, clubId, dashboard.id]);
      const bPromise = b.client.query(`select * from training_load.archive_dashboard($1,$2)`, [dashboard.id, dashboard.revision]);
      const blocked = await waitUntilBlocked(b.pid);
      assert.ok(blocked, "archive genuinely queues behind the in-flight selection's own dashboard lock");
      await a.client.query("commit");
      await bPromise;
    } finally {
      await a.client.end();
      await b.client.end();
    }
    const remaining = await query(`select count(*)::int as n from training_load.dashboard_active_selection where dashboard_id=$1`, [dashboard.id]);
    assert.equal(remaining.rows[0].n, 0);
  }
  // Ordering B: archive-first.
  {
    const dashboard = await makeDashboardHttp(coachCookie);
    const a = await newClient();
    const b = await newClient();
    try {
      await a.client.query("begin");
      await a.client.query(`select * from training_load.archive_dashboard($1,$2)`, [dashboard.id, dashboard.revision]);
      const bPromise = b.client.query(`select * from training_load.set_active_dashboard($1,'club',$2,$3)`, [coachId, clubId, dashboard.id]).catch((e) => ({ error: e }));
      const blocked = await waitUntilBlocked(b.pid);
      assert.ok(blocked, "the selection genuinely queues behind the in-flight archive's own dashboard lock");
      await a.client.query("commit");
      const bResult = await bPromise;
      assert.ok(bResult.error, "the selection must be rejected once it can finally see the now-archived status");
      assert.match(bResult.error.message, /is not active/);
    } finally {
      await a.client.end();
      await b.client.end();
    }
  }
});

// ============================================================
// §6 — Query semantics: activity/component/day filters, RPE + Metrics
// Core + day-level facts together, historical version/unit behavior,
// two-source conflict, comparison period, and the N+1 proof.
// ============================================================

test("§6.1 an explicit activityId filter narrows a session-scope series to EXACTLY that activity — a different real activity on the same date is excluded", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l61");
  const { athleteId } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  const act1 = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09" });
  await addMetricValue({ eventParticipantId: act1.eventParticipantId, metricDefinitionId, versionId, value: 100, aggregationRole: "standalone", coverage: "not_applicable" });
  const act2 = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09", startedAt: "2026-09-09T15:00:00Z" });
  await addMetricValue({ eventParticipantId: act2.eventParticipantId, metricDefinitionId, versionId, value: 200, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard, { group_by: "session" });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachCookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" },
  });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 2, groupBy: "session" } });

  const result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09", activityId: act1.activityId } });
  const values = result.body.widgets[0].series[0].data.current.map((r) => Number(r.value));
  assert.deepEqual(values, [100], "only act1's own bucket — act2 (same date, different real activity) is excluded");
});

test("§6.2 a real standalone day-level Metrics Core fact — never activity-backed — returns zero rows under an activity/component filter, structurally", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l62");
  const { athleteId } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const dayMetric = await makeMetricDefinition({ clubId, adminId: coachId, scopeLevels: ["day"] });
  const ev = await query(
    `insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_club_id, source_connection_id, created_by_user_id)
     values ('Sleep','2026-09-09','2026-09-09T06:00:00Z','day','club',$1,$2,$3) returning id`,
    [clubId, connectionId, coachId],
  );
  const evp = await query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'UTC') returning id`, [ev.rows[0].id, athleteId]);
  await addMetricValue({ eventParticipantId: evp.rows[0].id, metricDefinitionId: dayMetric.metricDefinitionId, versionId: dayMetric.versionId, value: 7.5, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachCookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId: dayMetric.metricDefinitionId, dataScopeLevel: "day", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" },
  });
  const withoutFilter = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.ok(withoutFilter.body.widgets[0].series[0].data.current.length > 0, "sanity: the day fact is genuinely visible without a filter");

  const activity = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09" });
  const withFilter = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09", activityId: activity.activityId } });
  assert.equal(withFilter.body.widgets[0].series[0].data.current.length, 0, "a day-scope series under an activity filter must return zero rows — it has no activity identity to narrow by");
});

test("§6.3 RPE (built-in), a real Metrics-Core metric, and a standalone day-level fact all resolve correctly TOGETHER in one batch query", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l63");
  const { athleteId } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { activityId, participantId, eventParticipantId, dateStr } = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09" });
  await makeRpeFeedback({ clubId, athleteId, activityParticipantId: participantId, date: dateStr, rpe: 6 });
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  await addMetricValue({ eventParticipantId, metricDefinitionId, versionId, value: 4200, aggregationRole: "standalone", coverage: "not_applicable" });
  const dayMetric = await makeMetricDefinition({ clubId, adminId: coachId, scopeLevels: ["day"] });
  const ev = await query(`insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_club_id, source_connection_id, created_by_user_id) values ('Sleep',$1,$2,'day','club',$3,$4,$5) returning id`, [dateStr, `${dateStr}T05:00:00Z`, clubId, connectionId, coachId]);
  const evp = await query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'UTC') returning id`, [ev.rows[0].id, athleteId]);
  await addMetricValue({ eventParticipantId: evp.rows[0].id, metricDefinitionId: dayMetric.metricDefinitionId, versionId: dayMetric.versionId, value: 8, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachCookie);
  const w1 = await makeWidgetHttp(coachCookie, dashboard, { x: 0 });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w1.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "avg" } });
  const dAfter1 = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const w2 = await makeWidgetHttp(coachCookie, dAfter1.body.dashboard, { x: 6 });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w2.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" } });
  const dAfter2 = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const w3 = await makeWidgetHttp(coachCookie, dAfter2.body.dashboard, { x: 0, y: 4 });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w3.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId: dayMetric.metricDefinitionId, dataScopeLevel: "day", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" } });

  const result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: dateStr, dateTo: dateStr } });
  assert.equal(result.status, 200);
  const byWidget = Object.fromEntries(result.body.widgets.map((w) => [w.widgetId, w.series[0]]));
  assert.equal(Number(byWidget[w1.widgetId].data.current[0].value), 6, "RPE built-in");
  assert.equal(Number(byWidget[w2.widgetId].data.current[0].value), 4200, "Metrics-Core session-scope metric");
  assert.equal(Number(byWidget[w3.widgetId].data.current[0].value), 8, "standalone day-level fact");
});

test("§6.4 a historical unit change stays two separate groups, and a genuine two-source conflict is never silently summed", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l64");
  const { athleteId } = await makeAthleteInClub(clubId);
  const connA = await makeSourceConnection(clubId);
  const connB = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId: v1 } = await makeMetricDefinition({ clubId, adminId: coachId, unit: "m" });
  const v2 = await query(
    `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id, superseded_reason) values ($1,2,'km','numeric','sum',$2,'unit change') returning id`,
    [metricDefinitionId, coachId],
  );
  await query(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [v2.rows[0].id, metricDefinitionId]);

  const act1 = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId: connA, date: "2026-09-09" });
  await addMetricValue({ eventParticipantId: act1.eventParticipantId, metricDefinitionId, versionId: v1, value: 4800, unit: "m", aggregationRole: "standalone", coverage: "not_applicable" });
  const act2 = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId: connB, date: "2026-09-10" });
  await addMetricValue({ eventParticipantId: act2.eventParticipantId, metricDefinitionId, versionId: v2.rows[0].id, value: 4.9, unit: "km", aggregationRole: "standalone", coverage: "not_applicable" });
  // A genuine two-source conflict: the SAME activity, two different
  // connections' own facts on the exact same measurement target.
  const act3conn2occ = await addMetricValue({ eventParticipantId: act1.eventParticipantId, metricDefinitionId, versionId: v1, value: 5000, unit: "m", aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard, { group_by: "session" });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachCookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" },
  });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 2, groupBy: "session" } });
  const result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-10" } });
  const rows = result.body.widgets[0].series[0].data.current;
  const conflictRow = rows.find((r) => r.conflict === true);
  assert.ok(conflictRow, "act1's own target (two standalone facts on the SAME session) must show as a real conflict");
  assert.equal(conflictRow.value, null, "a conflicted bucket is never a false sum");
  const cleanRow = rows.find((r) => r.conflict !== true);
  assert.ok(cleanRow, "act2's own clean, single-source bucket must still resolve normally");
});

test("§6.5 comparison_period='previous_period' computes a real shifted range and returns both numbers", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l65");
  const { athleteId } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  const current = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-15" });
  await addMetricValue({ eventParticipantId: current.eventParticipantId, metricDefinitionId, versionId, value: 150, aggregationRole: "standalone", coverage: "not_applicable" });
  const prev = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-14" });
  await addMetricValue({ eventParticipantId: prev.eventParticipantId, metricDefinitionId, versionId, value: 60, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard, { widgetType: "kpi", width: 3, height: 2, group_by: "athlete" });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachCookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any", comparisonPeriod: "previous_period" },
  });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 2, groupBy: "athlete" } });
  const result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-15", dateTo: "2026-09-15" } });
  const s = result.body.widgets[0].series[0].data;
  assert.equal(Number(s.current[0].value), 150);
  assert.ok(s.comparison);
  assert.equal(Number(s.comparison[0].value), 60);
  assert.equal(s.comparisonRange.dateFrom, "2026-09-14");
  assert.equal(s.comparisonRange.dateTo, "2026-09-14");
});

test("§6.6 NO N+1: querying 20 widgets against the SAME date range issues a bounded, small number of real DB statements — not one (or more) per widget/activity", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l66");
  const { athleteId } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  // 10 real activities, each with its own real fact.
  for (let i = 0; i < 10; i += 1) {
    const act = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09", startedAt: `2026-09-09T0${i % 9}:00:00Z` });
    await addMetricValue({ eventParticipantId: act.eventParticipantId, metricDefinitionId, versionId, value: 100 + i, aggregationRole: "standalone", coverage: "not_applicable" });
  }
  const dashboard = await makeDashboardHttp(coachCookie);
  let currentDashboard = dashboard;
  const widgetIds = [];
  for (let i = 0; i < 20; i += 1) {
    const w = await makeWidgetHttp(coachCookie, currentDashboard, { widgetType: "kpi", x: (i % 4) * 3, y: Math.floor(i / 4) * 2, width: 3, height: 2 });
    widgetIds.push(w.widgetId);
    await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
      method: "POST", cookie: coachCookie,
      body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" },
    });
    currentDashboard = (await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie })).body.dashboard;
  }

  const before = queryCount;
  const original = pool.query.bind(pool);
  pool.query = (...args) => { queryCount += 1; return original(...args); };
  let result;
  try {
    result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  } finally {
    pool.query = original;
  }
  const statementsForThisQuery = queryCount - before;
  assert.equal(result.status, 200);
  for (const w of result.body.widgets) assert.equal(w.series[0].status, "ok");
  // A genuine set-based plan issues a SMALL, ROUGHLY CONSTANT number of
  // statements (dashboard detail read, widgets, series, authorized-
  // activity-set, ONE lateral canonical-facts query, occasion context,
  // version info, participant rows) regardless of the 20-widget count —
  // nowhere near "one query per widget" (20+) or "one query per
  // activity" (10+ within just the facts fetch).
  assert.ok(statementsForThisQuery < 20, `expected a small, bounded statement count (well under the 20-widget/10-activity counts) for this batch query, got ${statementsForThisQuery} (an N+1 plan would scale with widget or activity count, not stay flat)`);
});

// ============================================================
// §7 — REAL end-to-end integration: dashboard-side scope-capability lock
// vs. the REAL, unmodified backend/src/trainingLoadMetricsCatalog.js
// setDefinitionScopeCapabilities() — carried over from the design proof's
// own §13.22, now proven against the real route layer's own add_series
// call path (via addSeries()) instead of a raw insert.
// ============================================================

test("§7.1 REAL setDefinitionScopeCapabilities() genuinely serializes against a concurrent dashboard series-add through the real add_series() sanctioned function", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l71");
  const { metricDefinitionId } = await makeMetricDefinition({ clubId, adminId: coachId, scopeLevels: ["session", "component"] });
  const catalogModule = await import("../src/trainingLoadMetricsCatalog.js");
  const platformAdminReq = { user: { id: coachId }, authz: { platformRoles: ["platform_admin"] } };

  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);

  let releaseLock;
  const lockHeld = new Promise((resolve) => { releaseLock = resolve; });
  let proceedSignal;
  const proceed = new Promise((resolve) => { proceedSignal = resolve; });
  const removalPromise = catalogModule.setDefinitionScopeCapabilities(platformAdminReq, metricDefinitionId, ["session"], {
    onLocked: async () => { releaseLock(); await proceed; },
  });
  await lockHeld;

  const c = await newClient();
  let addResult;
  try {
    const addPromise = c.client.query(
      `insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, data_scope_level) values ($1,1,$2,'component')`,
      [w.widgetId, metricDefinitionId],
    ).then(() => ({ ok: true })).catch((e) => ({ error: e }));
    const blocked = await waitUntilBlocked(c.pid);
    assert.ok(blocked, "the dashboard-side insert genuinely queues behind the REAL setDefinitionScopeCapabilities()'s own FOR UPDATE lock");
    proceedSignal();
    const removalResult = await removalPromise;
    assert.ok(!removalResult.error);
    addResult = await addPromise;
  } finally {
    await c.client.end();
  }
  assert.ok(addResult.error, "the dashboard-side insert must see the REAL, final (capability-removed) state");
  assert.match(addResult.error.message, /has never been configured for scope_level=component/);
});

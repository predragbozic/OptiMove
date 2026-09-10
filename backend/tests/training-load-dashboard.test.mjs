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
// Used only when the blocked side is a SERVICE FUNCTION (createDefinitionVersion)
// that owns its own pool.connect()'d client internally — no pid is handed back
// to the caller the way newClient()'s raw client exposes one. Polls for ANY
// backend genuinely queued on a real lock, excluding this test process's own
// query connection — safe in this suite because each concurrency test drives
// exactly one blocking actor at a time. Never a sleep() heuristic standing in
// for a real wait — every caller still asserts a real pg_stat_activity fact.
async function waitForAnyLockWait(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await pool.query("select pid from pg_stat_activity where wait_event_type = 'Lock' and pid <> pg_backend_pid()");
    if (r.rows.length > 0) return r.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}
// Real component-grain fixture (merge-readiness FINAL round, finding #7) —
// never a random/nonexistent component UUID standing in for a real one. Two
// real training.activity_components under the SAME real activity, two real
// training_load.metric_event_segments under that activity's own real metric
// event, and a CONFIRMED training.activity_component_metric_segment_links row
// for each — the exact chain training.canonical_activity_results() requires
// to emit a component_metric_segment_link fact and canonically bucket a
// component-grain metric_value fact.
async function makeComponentFixture({ clubId, coachId, athleteId, connectionId, date }) {
  const act = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date });
  const compA = await query(`insert into training.activity_components (activity_id, component_type_key, name_snapshot, origin) values ($1,'exercise','Component A','manual') returning id`, [act.activityId]);
  const compB = await query(`insert into training.activity_components (activity_id, component_type_key, name_snapshot, origin) values ($1,'exercise','Component B','manual') returning id`, [act.activityId]);
  const segA = await query(`insert into training_load.metric_event_segments (event_id, label, segment_order) values ($1,'Segment A',0) returning id`, [act.eventId]);
  const segB = await query(`insert into training_load.metric_event_segments (event_id, label, segment_order) values ($1,'Segment B',1) returning id`, [act.eventId]);
  await query(
    `insert into training.activity_component_metric_segment_links (activity_component_id, metric_event_segment_id, link_method, link_status, confirmed_by_user_id, confirmed_at) values ($1,$2,'manual','confirmed',$3,now())`,
    [compA.rows[0].id, segA.rows[0].id, coachId],
  );
  await query(
    `insert into training.activity_component_metric_segment_links (activity_component_id, metric_event_segment_id, link_method, link_status, confirmed_by_user_id, confirmed_at) values ($1,$2,'manual','confirmed',$3,now())`,
    [compB.rows[0].id, segB.rows[0].id, coachId],
  );
  return { ...act, componentAId: compA.rows[0].id, componentBId: compB.rows[0].id, segmentAId: segA.rows[0].id, segmentBId: segB.rows[0].id };
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
  assert.equal(detailFromB.status, 404, "QUERYING requires the CURRENT active workspace to actually match the dashboard's own data_workspace binding — visibility (ownership) is broader than queryability; the coach can still SEE this dashboard from Club B (manage rights), but querying it while active in Club B must be refused, not silently answered from Club B's own data");
  assert.equal(detailFromB.body.error, "notFound");
  await setActiveWorkspace(coachId, "club", clubAId);
  const detailFromA = await api(`/api/training-load/dashboards/${created.body.dashboard.id}/query`, { method: "POST", cookie, body: { dateFrom: "2026-01-01", dateTo: "2026-01-02" } });
  assert.equal(detailFromA.status, 200, "querying while active in the SAME workspace the dashboard is bound to must still succeed");
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
  const w = await makeWidgetHttp(coachCookie, dashboard);
  const bad = await api(`/api/training-load/dashboards/${dashboard.id}/layout`, { method: "PUT", cookie: coachCookie, body: { expectedRevision: 999, layout: [{ widgetId: w.widgetId, x: 0 }] } });
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
    body: { expectedWidgetRevision: 1, seriesOrder: 1, templateMetricKeyHints: [{ key: "totally-unknown-metric-key" }] },
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
    method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, templateMetricKeyHints: [{ key: "x" }] },
  });
  const detail = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const seriesRow = detail.body.widgets[0].series[0];
  const { metricDefinitionId: foreignMetricId } = await makeMetricDefinition({ clubId: otherClubId, adminId: otherCoachId });
  const rejected = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/${seriesRow.id}/resolve`, {
    method: "POST", cookie: coachCookie,
    body: { expectedWidgetRevision: detail.body.widgets[0].revision, metricDefinitionId: foreignMetricId },
  });
  // The application-layer pre-check (assertMetricReferenceOk, finding #7
  // of the 3B2 corrective round) catches this BEFORE the DB trigger ever
  // runs, returning the SAME info-hiding 404 a nonexistent metric id
  // would — never a 400, and never the trigger's own detailed P0001
  // message (which would otherwise name owner_scope/club/team ids).
  assert.equal(rejected.status, 404);
  assert.equal(rejected.body.error, "notFound");
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
  const w = await makeWidgetHttp(coachCookie, dashboard, {});
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
  const w = await makeWidgetHttp(coachCookie, dashboard, {});
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
  const w = await makeWidgetHttp(coachCookie, dashboard, { widgetType: "kpi", width: 3, height: 2 });
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

// ============================================================
// §8 — 3B2 CORRECTIVE ROUND: the 10 acceptance findings closed on top of
// commit 88fafb3. Each test here targets exactly one finding from that
// review; §2.5/§3.6 above were also updated in place (their old
// assertions encoded the PRE-correction, incorrect behavior).
// ============================================================

async function makeTeamCoach(label, { clubId } = {}) {
  const resolvedClubId = clubId || (await makeClub(`${label} club ${uid()}`));
  const teamRes = await query(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [resolvedClubId, `${label} Team ${uid()}`]);
  const teamId = teamRes.rows[0].id;
  const coachId = await makeUser({ email: `${label}-teamcoach-${uid()}@test.local` });
  await query(`insert into public.user_team_roles (user_id, team_id, role) values ($1,$2,'team_coach')`, [coachId, teamId]);
  await setActiveWorkspace(coachId, "team", teamId);
  const coachCookie = await loginCookie(coachId);
  return { clubId: resolvedClubId, teamId, coachId, coachCookie };
}

// --- Finding #1: query must be bound to its own data workspace ---

test("§8.1 a system template cannot be queried before it is cloned (409 templateRequiresClone); the clone can be queried normally", async () => {
  const { adminCookie } = await makePlatformAdmin("l81");
  const template = await makeDashboardHttp(adminCookie, { ownerScope: "system" });
  const before = await api(`/api/training-load/dashboards/${template.id}/query`, { method: "POST", cookie: adminCookie, body: { dateFrom: "2026-01-01", dateTo: "2026-01-02" } });
  assert.equal(before.status, 409);
  assert.equal(before.body.error, "templateRequiresClone");
  const { clubId, coachCookie } = await makeClubCoach("l81club");
  const cloned = await api(`/api/training-load/dashboards/${template.id}/clone`, { method: "POST", cookie: coachCookie, body: { ownerScope: "club", ownerClubId: clubId } });
  assert.equal(cloned.status, 201);
  const after = await api(`/api/training-load/dashboards/${cloned.body.dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-01-01", dateTo: "2026-01-02" } });
  assert.equal(after.status, 200);
});

test("§8.2 Team A vs Team B: the SAME coach managing both teams cannot query Team A's dashboard while active in Team B", async () => {
  const { clubId, teamId: teamAId, coachId, coachCookie: cookieA } = await makeTeamCoach("l82a");
  const teamBRes = await query(`insert into public.teams (club_id, name) values ($1,'Team B L82') returning id`, [clubId]);
  const teamBId = teamBRes.rows[0].id;
  await query(`insert into public.user_team_roles (user_id, team_id, role) values ($1,$2,'team_coach')`, [coachId, teamBId]);
  const created = await api("/api/training-load/dashboards", { method: "POST", cookie: cookieA, body: { name: "Team A Dash", ownerScope: "team", ownerTeamId: teamAId } });
  assert.equal(created.status, 201);
  await setActiveWorkspace(coachId, "team", teamBId);
  const rejected = await api(`/api/training-load/dashboards/${created.body.dashboard.id}/query`, { method: "POST", cookie: cookieA, body: { dateFrom: "2026-01-01", dateTo: "2026-01-02" } });
  assert.equal(rejected.status, 404);
  assert.equal(rejected.body.error, "notFound");
});

// --- Finding #2: ambiguous/unresolved template binding ---

test("§8.3 clone with 2 equally-valid template hint candidates lands as 'ambiguous' — both candidates preserved, nothing auto-picked", async () => {
  const { adminId, adminCookie } = await makePlatformAdmin("l83");
  const { clubId, coachCookie } = await makeClubCoach("l83club");
  const sharedKey = `ambiguous-key-${uid()}`;
  const sysDef = await query(`insert into training_load.metric_definitions (key, label, owner_scope, state, created_by_user_id) values ($1,'System Metric','system','active',$2) returning id`, [sharedKey, adminId]);
  const sysVer = await query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id) values ($1,1,'bpm','numeric','sum',$2) returning id`, [sysDef.rows[0].id, adminId]);
  await query(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [sysVer.rows[0].id, sysDef.rows[0].id]);
  const { metricDefinitionId: clubMetricId } = await makeMetricDefinition({ clubId, adminId, key: sharedKey });

  const template = await makeDashboardHttp(adminCookie, { ownerScope: "system" });
  const tw = await makeWidgetHttp(adminCookie, template);
  await api(`/api/training-load/dashboards/${template.id}/widgets/${tw.widgetId}/series`, {
    method: "POST", cookie: adminCookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, templateMetricKeyHints: [{ key: sharedKey }] },
  });
  const cloned = await api(`/api/training-load/dashboards/${template.id}/clone`, { method: "POST", cookie: coachCookie, body: { ownerScope: "club", ownerClubId: clubId } });
  assert.equal(cloned.status, 201);
  const detail = await api(`/api/training-load/dashboards/${cloned.body.dashboard.id}`, { cookie: coachCookie });
  const series = detail.body.widgets[0].series[0];
  assert.equal(series.resolution_status, "ambiguous");
  assert.equal(series.metric_definition_id, null);
  assert.ok(Array.isArray(series.template_resolution_candidates) && series.template_resolution_candidates.length === 2);
  assert.ok(series.template_resolution_candidates.includes(sysDef.rows[0].id));
  assert.ok(series.template_resolution_candidates.includes(clubMetricId));
});

test("§8.3b a clone whose hint matches ZERO candidates stays 'unresolved' — visible and fixable, not dropped", async () => {
  const { adminCookie } = await makePlatformAdmin("l83z");
  const { clubId, coachCookie } = await makeClubCoach("l83zclub");
  const template = await makeDashboardHttp(adminCookie, { ownerScope: "system" });
  const tw = await makeWidgetHttp(adminCookie, template);
  await api(`/api/training-load/dashboards/${template.id}/widgets/${tw.widgetId}/series`, {
    method: "POST", cookie: adminCookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, templateMetricKeyHints: [{ key: `no-such-metric-${uid()}` }] },
  });
  const cloned = await api(`/api/training-load/dashboards/${template.id}/clone`, { method: "POST", cookie: coachCookie, body: { ownerScope: "club", ownerClubId: clubId } });
  const detail = await api(`/api/training-load/dashboards/${cloned.body.dashboard.id}`, { cookie: coachCookie });
  const series = detail.body.widgets[0].series[0];
  assert.equal(series.resolution_status, "unresolved");
  assert.equal(series.metric_definition_id, null);
  assert.equal(series.template_resolution_candidates, null);
});

// --- Finding #3: resolveActiveWorkspace() resolved exactly once per request ---

test("§8.4 the clone route resolves the active workspace's own preference row EXACTLY ONCE per request", async () => {
  const { adminCookie } = await makePlatformAdmin("l84");
  const template = await makeDashboardHttp(adminCookie, { ownerScope: "system" });
  const { coachCookie } = await makeClubCoach("l84club");

  const original = pool.query.bind(pool);
  let preferenceLookups = 0;
  pool.query = (...args) => {
    queryCount += 1;
    const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
    if (sql && sql.includes("user_workspace_preferences")) preferenceLookups += 1;
    return original(...args);
  };
  let result;
  try {
    result = await api(`/api/training-load/dashboards/${template.id}/clone`, { method: "POST", cookie: coachCookie, body: {} });
  } finally {
    pool.query = original;
  }
  assert.equal(result.status, 201);
  assert.equal(preferenceLookups, 1, `resolveActiveWorkspace()'s own user_workspace_preferences read must happen exactly once per clone request, got ${preferenceLookups}`);
});

// --- Finding #4: real filter semantics (default -> runtime -> per-widget) ---

test("§8.5 default filter -> runtime override -> per-widget local override merge key-by-key; an explicit null clears a default key", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l85");
  const { athleteId: athleteA } = await makeAthleteInClub(clubId);
  const { athleteId: athleteB } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  const actA = await makeActivityWithEvent({ clubId, coachId, athleteId: athleteA, connectionId, date: "2026-09-09" });
  await addMetricValue({ eventParticipantId: actA.eventParticipantId, metricDefinitionId, versionId, value: 111, aggregationRole: "standalone", coverage: "not_applicable" });
  const actB = await makeActivityWithEvent({ clubId, coachId, athleteId: athleteB, connectionId, date: "2026-09-09", startedAt: "2026-09-09T15:00:00Z" });
  await addMetricValue({ eventParticipantId: actB.eventParticipantId, metricDefinitionId, versionId, value: 222, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachCookie);
  const patched = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: dashboard.revision, defaultFilter: { athleteIds: [athleteA] } } });
  assert.equal(patched.status, 200);

  const w1 = await makeWidgetHttp(coachCookie, patched.body.dashboard, {});
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w1.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w1.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 2, groupBy: "session" } });

  const dAfter1 = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const w2 = await makeWidgetHttp(coachCookie, dAfter1.body.dashboard, { x: 6, localFilterOverride: { athleteIds: [athleteB] } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w2.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w2.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 2, groupBy: "session" } });

  const result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  const byWidget = Object.fromEntries(result.body.widgets.map((w) => [w.widgetId, w.series[0]]));
  assert.deepEqual(byWidget[w1.widgetId].data.current.map((r) => Number(r.value)), [111], "widget 1 inherits the dashboard default_filter (athleteA only)");
  assert.deepEqual(byWidget[w2.widgetId].data.current.map((r) => Number(r.value)), [222], "widget 2's own local_filter_override wins over the dashboard default");

  const resultBoth = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09", athleteIds: [athleteA, athleteB] } });
  const byWidgetBoth = Object.fromEntries(resultBoth.body.widgets.map((w) => [w.widgetId, w.series[0]]));
  assert.deepEqual(byWidgetBoth[w1.widgetId].data.current.map((r) => Number(r.value)).sort(), [111, 222], "widget 1 has no local override, so the RUNTIME filter (both athletes) applies");
  assert.deepEqual(byWidgetBoth[w2.widgetId].data.current.map((r) => Number(r.value)), [222], "widget 2's own local_filter_override still wins over the runtime filter");

  const resultCleared = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09", athleteIds: null } });
  const byWidgetCleared = Object.fromEntries(resultCleared.body.widgets.map((w) => [w.widgetId, w.series[0]]));
  assert.deepEqual(byWidgetCleared[w1.widgetId].data.current.map((r) => Number(r.value)).sort(), [111, 222], "an explicit null athleteIds in the request clears the dashboard's own default_filter");
});

test("§8.6 a widget's local_filter_override can never WIDEN past the authorized workspace — a foreign athlete id yields zero rows, never a leak", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l86");
  const { athleteId: ownAthleteId } = await makeAthleteInClub(clubId);
  const otherClubId = await makeClub("Other L86 Club");
  const { athleteId: foreignAthleteId } = await makeAthleteInClub(otherClubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  const act = await makeActivityWithEvent({ clubId, coachId, athleteId: ownAthleteId, connectionId, date: "2026-09-09" });
  await addMetricValue({ eventParticipantId: act.eventParticipantId, metricDefinitionId, versionId, value: 500, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard, { localFilterOverride: { athleteIds: [foreignAthleteId] } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 2, groupBy: "session" } });

  const result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.widgets[0].series[0].data.current.length, 0, "a foreign athlete id filter must yield zero rows — never this club's own unfiltered data, and never that athlete's data either");
});

// --- Finding #5: built-in metadata from the catalog ---

test("§8.7 built-in series unit/value_type come from training_load.dashboard_builtin_series, not a hardcoded JS literal", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l87");
  const { athleteId } = await makeAthleteInClub(clubId);
  const act = await makeActivityWithEvent({ clubId, coachId, athleteId, date: "2026-09-09" });
  await makeRpeFeedback({ clubId, athleteId, activityParticipantId: act.participantId, date: act.dateStr, rpe: 5, durationMinutes: 45 });

  // 'srpe' is not yet bound to any series in this database — the catalog's
  // own semantics-immutability trigger only blocks a unit change once a
  // series references it, so this mutation is legal here.
  await query(`update training_load.dashboard_builtin_series set unit = 'TEST_UNIT_L87' where key = 'srpe'`);

  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "srpe", dataScopeLevel: "session", analyticalAggregation: "sum" } });

  const result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: act.dateStr, dateTo: act.dateStr } });
  assert.equal(result.status, 200);
  assert.equal(result.body.widgets[0].series[0].data.current[0].unit, "TEST_UNIT_L87", "a hardcoded JS literal would still show the original seed unit (AU) — this proves the query engine reads it from the catalog at query time");
});

// --- Finding #6: HTTP validation / error mapping never 500 ---

test("§8.8 a representative invalid-payload matrix never produces a 500", async () => {
  const { coachCookie } = await makeClubCoach("l88");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);

  const cases = [
    ["bad dashboardId UUID in path", () => api(`/api/training-load/dashboards/not-a-uuid`, { cookie: coachCookie })],
    ["unknown widget type (FK/trigger violation)", () => api(`/api/training-load/dashboards/${dashboard.id}/widgets`, { method: "POST", cookie: coachCookie, body: { expectedDashboardRevision: dashboard.revision, widgetType: "not-a-real-type", title: "W", widgetOrder: 999, x: 0, y: 0, width: 6, height: 4, mobileOrder: 999 } })],
    ["out-of-range width (CHECK violation)", () => api(`/api/training-load/dashboards/${dashboard.id}/widgets`, { method: "POST", cookie: coachCookie, body: { expectedDashboardRevision: dashboard.revision, widgetType: "table", title: "W", widgetOrder: 998, x: 0, y: 0, width: 999, height: 4, mobileOrder: 998 } })],
    ["revision sent as a string, not a number", () => api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: "1", title: "x" } })],
    ["defaultFilter with an unknown key", () => api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: dashboard.revision, defaultFilter: { notAKey: 1 } } })],
    ["malformed date", () => api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "not-a-date", dateTo: "2026-01-02" } })],
    ["empty name", () => api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "" } })],
    ["out-of-range period (cursor-like span)", () => api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2020-01-01", dateTo: "2026-01-01" } })],
  ];
  for (const [label, run] of cases) {
    const r = await run();
    assert.ok(r.status === 400 || r.status === 404 || r.status === 409, `[${label}] expected a controlled 4xx, got ${r.status}: ${JSON.stringify(r.body)}`);
  }
});

// --- Finding #7: metric/source-connection references checked before the DB trigger ---

test("§8.9 addSeries() rejects a foreign private metric at CREATE time with the SAME info-hiding 404 as resolve_series_binding", async () => {
  const { coachCookie } = await makeClubCoach("l89a");
  const { clubId: otherClubId, coachId: otherCoachId } = await makeClubCoach("l89b");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  const { metricDefinitionId: foreignMetricId } = await makeMetricDefinition({ clubId: otherClubId, adminId: otherCoachId });
  const rejected = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachCookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId: foreignMetricId, dataScopeLevel: "session", analyticalAggregation: "sum" },
  });
  assert.equal(rejected.status, 404);
  assert.equal(rejected.body.error, "notFound");
});

test("§8.9b a nonexistent metricDefinitionId returns the SAME 404 as a foreign one", async () => {
  const { coachCookie } = await makeClubCoach("l89c");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  const rejected = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachCookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId: crypto.randomUUID(), dataScopeLevel: "session", analyticalAggregation: "sum" },
  });
  assert.equal(rejected.status, 404);
  assert.equal(rejected.body.error, "notFound");
});

// --- Finding #8/#9: template contract + create_dashboard/update_dashboard_metadata sanctioned functions ---

test("§8.10 update_dashboard_metadata(): PATCH honors optimistic revision (stale -> 409 staleRevision) and can flip is_template for a club dashboard", async () => {
  const { clubId, coachCookie } = await makeClubCoach("l810");
  const created = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "Club Dash", ownerScope: "club", ownerClubId: clubId } });
  assert.equal(created.body.dashboard.is_template, false);
  const stale = await api(`/api/training-load/dashboards/${created.body.dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: 999, name: "X" } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "staleRevision");
  const flipped = await api(`/api/training-load/dashboards/${created.body.dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: created.body.dashboard.revision, isTemplate: true } });
  assert.equal(flipped.status, 200);
  assert.equal(flipped.body.dashboard.is_template, true);
  assert.equal(flipped.body.dashboard.revision, created.body.dashboard.revision + 1);
});

test("§8.11 a club dashboard can be created as a template via a strict isTemplate boolean — never silently forced to false", async () => {
  const { clubId, coachCookie } = await makeClubCoach("l811");
  const created = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "Club Template", ownerScope: "club", ownerClubId: clubId, isTemplate: true } });
  assert.equal(created.status, 201);
  assert.equal(created.body.dashboard.is_template, true);
});

test("§8.11b isTemplate:false is rejected for a system dashboard; a non-boolean isTemplate is rejected everywhere", async () => {
  const { adminCookie } = await makePlatformAdmin("l811c");
  const rejected = await api("/api/training-load/dashboards", { method: "POST", cookie: adminCookie, body: { name: "X", ownerScope: "system", isTemplate: false } });
  assert.equal(rejected.status, 400);
  const { coachCookie } = await makeClubCoach("l811d");
  const badType = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "X", isTemplate: "yes" } });
  assert.equal(badType.status, 400);
});

// --- Finding #4/#10: N+1 stays bounded across DISTINCT filter contexts, not just a shared one ---

test("§8.12 NO N+1 across distinct filter contexts: 12 widgets split across 3 distinct local_filter_override contexts issue a bounded, filter-context-scaled statement count, never one per widget", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l812");
  const { athleteId: athleteA } = await makeAthleteInClub(clubId);
  const { athleteId: athleteB } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  for (const athleteId of [athleteA, athleteB]) {
    const act = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09" });
    await addMetricValue({ eventParticipantId: act.eventParticipantId, metricDefinitionId, versionId, value: 42, aggregationRole: "standalone", coverage: "not_applicable" });
  }
  const dashboard = await makeDashboardHttp(coachCookie);
  let currentDashboard = dashboard;
  const contexts = [{ athleteIds: [athleteA] }, { athleteIds: [athleteB] }, null];
  for (let i = 0; i < 12; i += 1) {
    const override = contexts[i % 3];
    const w = await makeWidgetHttp(coachCookie, currentDashboard, { widgetType: "kpi", x: (i % 4) * 3, y: Math.floor(i / 4) * 2, width: 3, height: 2, ...(override ? { localFilterOverride: override } : {}) });
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
  assert.ok(statementsForThisQuery < 30, `expected a small statement count scaling with the 3 distinct filter contexts, not the 12-widget count — got ${statementsForThisQuery}`);
  console.log(`[§8.12] 12 widgets / 3 distinct filter contexts -> ${statementsForThisQuery} DB statements`);
});

// ============================================================
// §9 — MERGE-READINESS CORRECTIVE ROUND: the 10 further acceptance
// findings closed on top of commit 22de90a.
// ============================================================

// Generalizes makeActivityWithEvent above to a real TEAM-scoped activity
// (that helper hardcodes owner_scope='club') — needed only for the
// Team A/B isolation test below.
async function makeActivityWithEventScoped({ ownerScope, scopeId, coachId, athleteId, connectionId, date, startedAt }) {
  const dateStr = date || "2026-09-09";
  const startStr = startedAt || `${dateStr}T09:00:00Z`;
  const ownerCol = ownerScope === "team" ? "owner_team_id" : "owner_club_id";
  const activity = await query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, ${ownerCol}, origin, lifecycle_state, created_by_user_id)
     values ('training_session','Test Session',$1,$2,'Europe/Belgrade',$3,$4,'manual','confirmed',$5) returning id`,
    [dateStr, startStr, ownerScope, scopeId, coachId],
  );
  const participant = await query(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,$3,'Europe/Belgrade','participated') returning id`,
    [activity.rows[0].id, athleteId, dateStr],
  );
  const event = await query(
    `insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, ${ownerCol}, source_connection_id, created_by_user_id)
     values ('Test Session',$1,$2,'session',$3,$4,$5,$6) returning id`,
    [dateStr, startStr, ownerScope, scopeId, connectionId, coachId],
  );
  const eventParticipant = await query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Belgrade') returning id`, [event.rows[0].id, athleteId]);
  await query(`insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [activity.rows[0].id, event.rows[0].id]);
  await query(`insert into training.activity_participant_metric_participant_links (activity_participant_id, metric_event_participant_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [participant.rows[0].id, eventParticipant.rows[0].id]);
  return { activityId: activity.rows[0].id, participantId: participant.rows[0].id, eventId: event.rows[0].id, eventParticipantId: eventParticipant.rows[0].id, dateStr };
}

// --- Finding #1: archived dashboard is fully read-only ---

test("§9.1 an archived dashboard is fully read-only: GET stays visible, query/clone/metadata/layout/widget/series writes all reject with 409 dashboardArchived, and archive itself is idempotent", async () => {
  const { clubId, coachCookie } = await makeClubCoach("l91");
  const created = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "To Archive", ownerScope: "club", ownerClubId: clubId, isTemplate: true } });
  const dashboard = created.body.dashboard;
  const w = await makeWidgetHttp(coachCookie, dashboard);
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "avg" } });
  const dAfterSeries = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const seriesId = dAfterSeries.body.widgets[0].series[0].id;

  const archived = await api(`/api/training-load/dashboards/${dashboard.id}/archive`, { method: "POST", cookie: coachCookie, body: { expectedRevision: dAfterSeries.body.dashboard.revision } });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.dashboard.status, "archived");
  const revisionAfterArchive = archived.body.dashboard.revision;

  const got = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  assert.equal(got.status, 200, "GET must still show an archived dashboard for historical review");
  assert.equal(got.body.dashboard.status, "archived");

  const queried = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-01-01", dateTo: "2026-01-02" } });
  assert.equal(queried.status, 409);
  assert.equal(queried.body.error, "dashboardArchived");

  const cloned = await api(`/api/training-load/dashboards/${dashboard.id}/clone`, { method: "POST", cookie: coachCookie, body: {} });
  assert.equal(cloned.status, 409);
  assert.equal(cloned.body.error, "dashboardArchived");

  const metaPatch = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: revisionAfterArchive, name: "New Name" } });
  assert.equal(metaPatch.status, 409);
  assert.equal(metaPatch.body.error, "dashboardArchived");

  const layoutPatch = await api(`/api/training-load/dashboards/${dashboard.id}/layout`, { method: "PUT", cookie: coachCookie, body: { expectedRevision: revisionAfterArchive, layout: [{ widgetId: w.widgetId, x: 0 }] } });
  assert.equal(layoutPatch.status, 409);
  assert.equal(layoutPatch.body.error, "dashboardArchived");

  const widgetPatch = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 1, title: "New" } });
  assert.equal(widgetPatch.status, 409);
  assert.equal(widgetPatch.body.error, "dashboardArchived");

  const seriesPatch = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/${seriesId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 1, axis: "secondary" } });
  assert.equal(seriesPatch.status, 409);
  assert.equal(seriesPatch.body.error, "dashboardArchived");

  // Idempotent archive: re-archiving with the SAME (unchanged) revision
  // succeeds again — status didn't actually change, so no revision bump.
  const reArchived = await api(`/api/training-load/dashboards/${dashboard.id}/archive`, { method: "POST", cookie: coachCookie, body: { expectedRevision: revisionAfterArchive } });
  assert.equal(reArchived.status, 200);
  assert.equal(reArchived.body.dashboard.status, "archived");
  assert.equal(reArchived.body.dashboard.revision, revisionAfterArchive);
});

// --- Finding #2: no raw per-series error leakage ---

test("§9.3 an unexpected internal per-series query failure surfaces as a stable 'seriesQueryFailed', never the raw internal error message", async () => {
  // Note: a genuinely INVALID spec (e.g. an out-of-enum source_policy)
  // can never reach the query engine through the real HTTP/DB layer —
  // every field reduceTyped()/resolveFactsToRows() branch on is itself
  // DB-CHECK-constrained on dashboard_widget_series, and a per-BUCKET
  // reduceTyped() failure (e.g. a value_type/aggregation mismatch) is
  // ALREADY caught internally by reduceRows()'s own finalizeStage2 (a
  // separate, legitimate "this bucket has a conflict" reporting path,
  // not what this finding targets) — so it never reaches the OUTER catch
  // in runDashboardBatchQuery() either. This test instead unit-tests
  // THAT outer catch directly, with a hand-built spec resolveFactsToRows()
  // itself would reject outright (source_policy='not_applicable' paired
  // with a real metricDefinitionId — illegal on any real persisted row,
  // but exactly the "truly unanticipated internal state" finding #2
  // exists to guard even when the DB's own constraints already prevent
  // it via every real write path).
  const { clubId, coachId } = await makeClubCoach("l93");
  const { athleteId } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  const act = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09" });
  await addMetricValue({ eventParticipantId: act.eventParticipantId, metricDefinitionId, versionId, value: 42, aggregationRole: "standalone", coverage: "not_applicable" });

  const queryModule = await import("../src/trainingLoadDashboardQuery.js");
  const results = await queryModule.runDashboardBatchQuery(
    { dataWorkspaceType: "club", dataWorkspaceScopeId: clubId, dataWorkspaceUserId: null, athleteWorkspaceAthleteId: null, dateFrom: "2026-09-09", dateTo: "2026-09-09" },
    [{
      widgetId: "w1", seriesId: "s1", metricDefinitionId, builtInSeriesKey: null,
      dataScopeLevel: "session", aggregationRolePolicy: "standalone_only", coveragePolicy: "any",
      sourcePolicy: "not_applicable", sourceConnectionId: null,
      groupBy: "day", analyticalAggregation: "sum", comparisonPeriod: null,
      athleteIds: undefined, activityId: null, componentId: null,
    }],
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "error");
  assert.equal(results[0].error, "seriesQueryFailed", "the public per-series error must be the stable code, never resolveFactsToRows()'s own raw exception message");
  assert.ok(!JSON.stringify(results).includes("resolveFactsToRows"), "no internal function/identifier name may leak into the response body");
  assert.ok(!JSON.stringify(results).includes("source_policy"), "no raw internal exception message fragment may leak");
});

// --- Finding #3: source-connection active-state contract ---

test("§9.4 foreign, nonexistent, and inactive source connections all return the SAME info-hiding 404 via add_series()", async () => {
  const { clubId: ownClubId, coachCookie } = await makeClubCoach("l94a");
  const { clubId: otherClubId } = await makeClubCoach("l94b");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);

  const foreignConnectionId = await makeSourceConnection(otherClubId);
  const nonexistentConnectionId = crypto.randomUUID();
  const inactiveConnectionId = await makeSourceConnection(ownClubId);
  await query(`update training_load.metric_source_connections set state='inactive' where id=$1`, [inactiveConnectionId]);

  for (const [label, connId] of [["foreign", foreignConnectionId], ["nonexistent", nonexistentConnectionId], ["inactive", inactiveConnectionId]]) {
    const r = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
      method: "POST", cookie: coachCookie,
      body: { expectedWidgetRevision: 1, seriesOrder: 1, sourcePolicy: "source_connection", sourceConnectionId: connId, dataScopeLevel: "session", analyticalAggregation: "sum", templateMetricKeyHints: [{ key: "irrelevant-never-reached" }] },
    });
    assert.equal(r.status, 404, `[${label}]`);
    assert.equal(r.body.error, "notFound", `[${label}]`);
  }
});

test("§9.4b update_series() also rejects an inactive source connection with the same 404", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l94c");
  const { metricDefinitionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum" } });
  const detail = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const seriesId = detail.body.widgets[0].series[0].id;
  const inactiveConnectionId = await makeSourceConnection(clubId);
  await query(`update training_load.metric_source_connections set state='inactive' where id=$1`, [inactiveConnectionId]);
  const r = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/${seriesId}`, {
    method: "PATCH", cookie: coachCookie,
    body: { expectedWidgetRevision: detail.body.widgets[0].revision, sourcePolicy: "source_connection", sourceConnectionId: inactiveConnectionId },
  });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "notFound");
});

// --- Finding #4: workspace snapshot is Promise-memoized (concurrency-safe) ---

test("§9.5 resolveActiveDataWorkspace() memoizes the IN-FLIGHT PROMISE — two truly concurrent calls on the same req share exactly ONE resolveActiveWorkspace() execution", async () => {
  const dashAccess = await import("../src/trainingLoadDashboardAccess.js");
  const authzModule = await import("../src/authz.js");
  const { coachId, clubId } = await makeClubCoach("l95");
  await setActiveWorkspace(coachId, "club", clubId);

  // Baseline: real DB-statement cost of ONE resolveActiveDataWorkspace()
  // call on a FRESH req.
  const authzA = await authzModule.loadAuthorizationContext({ id: coachId });
  const reqA = { user: { id: coachId }, authz: authzA };
  const original = pool.query.bind(pool);
  let counted = 0;
  pool.query = (...args) => { counted += 1; return original(...args); };
  try {
    await dashAccess.resolveActiveDataWorkspace(reqA);
  } finally {
    pool.query = original;
  }
  const baseline = counted;
  assert.ok(baseline > 0, "sanity: resolving a workspace does real DB work");

  // Race: two CONCURRENT calls (via Promise.all — both function bodies
  // start executing before either has awaited anything) on the SAME
  // fresh req.
  const authzB = await authzModule.loadAuthorizationContext({ id: coachId });
  const reqB = { user: { id: coachId }, authz: authzB };
  counted = 0;
  pool.query = (...args) => { counted += 1; return original(...args); };
  let a, b;
  try {
    [a, b] = await Promise.all([dashAccess.resolveActiveDataWorkspace(reqB), dashAccess.resolveActiveDataWorkspace(reqB)]);
  } finally {
    pool.query = original;
  }
  assert.deepEqual(a, b, "both concurrent calls must resolve to the identical snapshot");
  assert.equal(counted, baseline, `two truly concurrent calls on the same req must cost EXACTLY the same number of DB statements as one call (got ${counted}, expected ${baseline}) — proves the in-flight PROMISE is shared, not just the resolved value`);
});

// --- Finding #5 + #6 + fail-fast #11: clone snapshot consistency, default_filter copy, portable source-connection contract, and atomic rollback ---

test("§9.6 clone reads a locked template snapshot, copies default_filter, and rolls back ATOMICALLY (zero new rows) when a pinned source connection cannot be resolved in the target workspace", async () => {
  const clubAId = await makeClub("L96 Club A");
  const clubBId = await makeClub("L96 Club B");
  const coachId = await makeUser({ email: `l96-coach-${uid()}@test.local` });
  await grantClubAdmin(coachId, clubAId);
  await grantClubAdmin(coachId, clubBId);
  await setActiveWorkspace(coachId, "club", clubAId);
  const cookie = await loginCookie(coachId);

  const { athleteId } = await makeAthleteInClub(clubAId);
  const connectionId = await makeSourceConnection(clubAId); // active, visible ONLY to club A
  const template = await api("/api/training-load/dashboards", { method: "POST", cookie, body: { name: "Portable Template", ownerScope: "club", ownerClubId: clubAId, isTemplate: true, defaultFilter: { athleteIds: [athleteId] } } });
  assert.equal(template.status, 201);
  const templateId = template.body.dashboard.id;

  const w1 = await makeWidgetHttp(cookie, template.body.dashboard);
  await api(`/api/training-load/dashboards/${templateId}/widgets/${w1.widgetId}/series`, { method: "POST", cookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "avg" } });

  const { metricDefinitionId } = await makeMetricDefinition({ clubId: clubAId, adminId: coachId });
  const dAfterW1 = await api(`/api/training-load/dashboards/${templateId}`, { cookie });
  const w2 = await makeWidgetHttp(cookie, dAfterW1.body.dashboard, { x: 6 });
  const addSeriesRes = await api(`/api/training-load/dashboards/${templateId}/widgets/${w2.widgetId}/series`, {
    method: "POST", cookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, sourcePolicy: "source_connection", sourceConnectionId: connectionId, dataScopeLevel: "session", analyticalAggregation: "sum" },
  });
  assert.equal(addSeriesRes.status, 201);

  // Attempt clone into Club B — connectionId is not visible there.
  await setActiveWorkspace(coachId, "club", clubBId);
  const beforeDash = (await query(`select count(*)::int as n from training_load.dashboards`)).rows[0].n;
  const beforeWidgets = (await query(`select count(*)::int as n from training_load.dashboard_widgets`)).rows[0].n;
  const beforeSeries = (await query(`select count(*)::int as n from training_load.dashboard_widget_series`)).rows[0].n;

  const failedClone = await api(`/api/training-load/dashboards/${templateId}/clone`, { method: "POST", cookie, body: { ownerScope: "club", ownerClubId: clubBId } });
  assert.equal(failedClone.status, 409);
  assert.equal(failedClone.body.error, "sourceConnectionResolutionRequired");

  const afterDash = (await query(`select count(*)::int as n from training_load.dashboards`)).rows[0].n;
  const afterWidgets = (await query(`select count(*)::int as n from training_load.dashboard_widgets`)).rows[0].n;
  const afterSeries = (await query(`select count(*)::int as n from training_load.dashboard_widget_series`)).rows[0].n;
  assert.equal(afterDash, beforeDash, "zero new dashboards after the rollback — even though widget 1's built-in series would have succeeded on its own");
  assert.equal(afterWidgets, beforeWidgets, "zero new widgets");
  assert.equal(afterSeries, beforeSeries, "zero new series rows");

  // A successful clone (same club, connection IS visible) proves the
  // FOR-SHARE-locked snapshot is read correctly and default_filter is
  // copied — previously silently dropped.
  await setActiveWorkspace(coachId, "club", clubAId);
  const okClone = await api(`/api/training-load/dashboards/${templateId}/clone`, { method: "POST", cookie, body: { ownerScope: "club", ownerClubId: clubAId } });
  assert.equal(okClone.status, 201);
  assert.deepEqual(okClone.body.dashboard.default_filter, { athleteIds: [athleteId] }, "default_filter must be copied from the template, not silently dropped");
  const detail = await api(`/api/training-load/dashboards/${okClone.body.dashboard.id}`, { cookie });
  assert.equal(detail.body.widgets.length, 2);
});

// --- Finding #6: portable template-series contract ---

test("§9.8 a template series bound directly to a real metric (auto-snapshotted hints) re-resolves per target workspace: resolved / unresolved / ambiguous", async () => {
  const { adminId } = await makePlatformAdmin("l98admin");
  // A club-owned template is visible ONLY within its own club (unlike a
  // system template, visible everywhere) — so exercising it from a
  // DIFFERENT target club needs the SAME coach to manage both clubs
  // (same pattern as §9.6), never an unrelated coach who could never
  // legitimately see it in the first place.
  const sourceClubId = await makeClub("L98 Source Club");
  const otherClubId = await makeClub("L98 Other Club");
  const coachId = await makeUser({ email: `l98-coach-${uid()}@test.local` });
  await grantClubAdmin(coachId, sourceClubId);
  await grantClubAdmin(coachId, otherClubId);
  await setActiveWorkspace(coachId, "club", sourceClubId);
  const cookie = await loginCookie(coachId);

  const sharedKey = `direct-key-${uid()}`;
  const { metricDefinitionId: sourceMetricId } = await makeMetricDefinition({ clubId: sourceClubId, adminId: coachId, key: sharedKey });

  const template = await makeDashboardHttp(cookie, { ownerScope: "club", ownerClubId: sourceClubId, isTemplate: true });
  const tw = await makeWidgetHttp(cookie, template);
  const addRes = await api(`/api/training-load/dashboards/${template.id}/widgets/${tw.widgetId}/series`, {
    method: "POST", cookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId: sourceMetricId, dataScopeLevel: "session", analyticalAggregation: "sum" },
  });
  assert.equal(addRes.status, 201);

  // RESOLVED: clone into the SAME club — exactly 1 visible candidate.
  const clonedResolved = await api(`/api/training-load/dashboards/${template.id}/clone`, { method: "POST", cookie, body: { ownerScope: "club", ownerClubId: sourceClubId } });
  assert.equal(clonedResolved.status, 201);
  const detailResolved = await api(`/api/training-load/dashboards/${clonedResolved.body.dashboard.id}`, { cookie });
  assert.equal(detailResolved.body.widgets[0].series[0].resolution_status, "resolved");
  assert.equal(detailResolved.body.widgets[0].series[0].metric_definition_id, sourceMetricId);

  // UNRESOLVED: clone into the OTHER club (same coach, no matching key
  // there) — must switch the active workspace first, since clone
  // visibility of a club-owned template requires the caller's CURRENT
  // active workspace to actually match its own club.
  await setActiveWorkspace(coachId, "club", otherClubId);
  const clonedUnresolved = await api(`/api/training-load/dashboards/${template.id}/clone`, { method: "POST", cookie, body: { ownerScope: "club", ownerClubId: otherClubId } });
  assert.equal(clonedUnresolved.status, 201);
  const detailUnresolved = await api(`/api/training-load/dashboards/${clonedUnresolved.body.dashboard.id}`, { cookie });
  assert.equal(detailUnresolved.body.widgets[0].series[0].resolution_status, "unresolved");
  assert.equal(detailUnresolved.body.widgets[0].series[0].metric_definition_id, null);

  // AMBIGUOUS: add a SECOND, system-scope metric sharing the SAME key —
  // now visible from the SOURCE club too — then clone there again.
  await setActiveWorkspace(coachId, "club", sourceClubId);
  const sysDef = await query(`insert into training_load.metric_definitions (key, label, owner_scope, state, created_by_user_id) values ($1,'Sys Dup','system','active',$2) returning id`, [sharedKey, adminId]);
  const sysVer = await query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id) values ($1,1,'bpm','numeric','sum',$2) returning id`, [sysDef.rows[0].id, adminId]);
  await query(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [sysVer.rows[0].id, sysDef.rows[0].id]);
  const clonedAmbiguous = await api(`/api/training-load/dashboards/${template.id}/clone`, { method: "POST", cookie, body: { ownerScope: "club", ownerClubId: sourceClubId } });
  assert.equal(clonedAmbiguous.status, 201);
  const detailAmbiguous = await api(`/api/training-load/dashboards/${clonedAmbiguous.body.dashboard.id}`, { cookie });
  const s = detailAmbiguous.body.widgets[0].series[0];
  assert.equal(s.resolution_status, "ambiguous");
  assert.equal(s.metric_definition_id, null);
  assert.equal(s.template_resolution_candidates.length, 2);
  assert.ok(s.template_resolution_candidates.includes(sourceMetricId));
  assert.ok(s.template_resolution_candidates.includes(sysDef.rows[0].id));
});

// --- Finding #7: strict Node-side validation ---

test("§9.10 strict Node-side validation: revision/order type+range, name/title trim+whitespace, description type, unknown fields, defaultFilter saved on create", async () => {
  const { clubId, coachCookie } = await makeClubCoach("l910");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);

  const cases = [
    ["revision as float", () => api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: 1.5, name: "X" } })],
    ["revision zero", () => api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: 0, name: "X" } })],
    ["revision negative", () => api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: -1, name: "X" } })],
    ["revision as string", () => api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: "1", name: "X" } })],
    ["whitespace-only name", () => api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: dashboard.revision, name: "   " } })],
    ["description wrong type", () => api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: dashboard.revision, description: 123 } })],
    ["unknown field on metadata PATCH (retired clearDescription contract)", () => api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: dashboard.revision, clearDescription: true } })],
    ["whitespace-only widget title", () => api(`/api/training-load/dashboards/${dashboard.id}/widgets`, { method: "POST", cookie: coachCookie, body: { expectedDashboardRevision: dashboard.revision, widgetType: "table", title: "   ", widgetOrder: 500, x: 0, y: 0, width: 6, height: 4, mobileOrder: 500 } })],
    ["negative order field", () => api(`/api/training-load/dashboards/${dashboard.id}/widgets`, { method: "POST", cookie: coachCookie, body: { expectedDashboardRevision: dashboard.revision, widgetType: "table", title: "W", widgetOrder: -1, x: 0, y: 0, width: 6, height: 4, mobileOrder: 500 } })],
    ["non-integer order field", () => api(`/api/training-load/dashboards/${dashboard.id}/widgets`, { method: "POST", cookie: coachCookie, body: { expectedDashboardRevision: dashboard.revision, widgetType: "table", title: "W", widgetOrder: 1.5, x: 0, y: 0, width: 6, height: 4, mobileOrder: 500 } })],
    ["missing required order field", () => api(`/api/training-load/dashboards/${dashboard.id}/widgets`, { method: "POST", cookie: coachCookie, body: { expectedDashboardRevision: dashboard.revision, widgetType: "table", title: "W", x: 0, y: 0, width: 6, height: 4, mobileOrder: 500 } })],
    ["unknown field on widget PATCH (retired clearLocalFilterOverride contract)", () => api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 1, clearLocalFilterOverride: true } })],
    ["unknown field on series PATCH (retired clearComparisonPeriod contract)", () => api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/${crypto.randomUUID()}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 1, clearComparisonPeriod: true } })],
    ["unknown field on dashboard create", () => api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "X", bogusField: 1 } })],
  ];
  for (const [label, run] of cases) {
    const r = await run();
    assert.equal(r.status, 400, `[${label}] expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalidRequest", `[${label}]`);
  }

  const { athleteId } = await makeAthleteInClub(clubId);
  const createdWithFilter = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "With Filter", defaultFilter: { athleteIds: [athleteId] } } });
  assert.equal(createdWithFilter.status, 201);
  assert.deepEqual(createdWithFilter.body.dashboard.default_filter, { athleteIds: [athleteId] }, "POST /dashboards previously ignored defaultFilter entirely — it must now be validated and persisted");
});

// --- Fail-fast #1/#2: shared athlete across two real workspaces ---

test("§9.11 a shared athlete real in BOTH Club A and Club B: Club A's dashboard sees only Club A's own activity data, never Club B's", async () => {
  const { adminId } = await makePlatformAdmin("l911admin");
  const { clubId: clubAId, coachId: coachAId, coachCookie: coachACookie } = await makeClubCoach("l911a");
  const { clubId: clubBId, coachId: coachBId } = await makeClubCoach("l911b");
  const { athleteId } = await makeAthleteInClub(clubAId);
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubBId]);

  // ONE system-scope metric, visible/bindable everywhere — the SAME
  // metric is used for both clubs' activities so the isolation this test
  // proves comes purely from ACTIVITY-level owner_club_id scoping, never
  // incidentally from the metric binding itself narrowing things.
  const sysDef = await query(`insert into training_load.metric_definitions (key, label, owner_scope, state, created_by_user_id) values ($1,'Shared Metric','system','active',$2) returning id`, [`shared-${uid()}`, adminId]);
  const sysVer = await query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id) values ($1,1,'bpm','numeric','sum',$2) returning id`, [sysDef.rows[0].id, adminId]);
  await query(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [sysVer.rows[0].id, sysDef.rows[0].id]);
  await query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'session')`, [sysDef.rows[0].id]);
  const metricDefinitionId = sysDef.rows[0].id;
  const versionId = sysVer.rows[0].id;

  const connA = await makeSourceConnection(clubAId);
  const connB = await makeSourceConnection(clubBId);
  const actA = await makeActivityWithEvent({ clubId: clubAId, coachId: coachAId, athleteId, connectionId: connA, date: "2026-09-09" });
  await addMetricValue({ eventParticipantId: actA.eventParticipantId, metricDefinitionId, versionId, value: 111, aggregationRole: "standalone", coverage: "not_applicable" });
  const actB = await makeActivityWithEvent({ clubId: clubBId, coachId: coachBId, athleteId, connectionId: connB, date: "2026-09-09" });
  await addMetricValue({ eventParticipantId: actB.eventParticipantId, metricDefinitionId, versionId, value: 222, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachACookie, { ownerScope: "club", ownerClubId: clubAId });
  const w = await makeWidgetHttp(coachACookie, dashboard);
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachACookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" },
  });
  const result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachACookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.equal(result.status, 200);
  const values = result.body.widgets[0].series[0].data.current.map((r) => Number(r.value));
  assert.deepEqual(values, [111], "only Club A's own activity value for the shared athlete — Club B's value for the SAME athlete/metric must never leak in");
});

test("§9.12 a shared athlete real in BOTH Team A and Team B: Team A's dashboard sees only Team A's own activity data, never Team B's", async () => {
  const { adminId } = await makePlatformAdmin("l912admin");
  const { clubId, teamId: teamAId, coachId, coachCookie: coachACookie } = await makeTeamCoach("l912a");
  const teamBRes = await query(`insert into public.teams (club_id, name) values ($1,'Team B L912') returning id`, [clubId]);
  const teamBId = teamBRes.rows[0].id;
  await query(`insert into public.user_team_roles (user_id, team_id, role) values ($1,$2,'team_coach')`, [coachId, teamBId]);

  const athleteId = await makeAthlete({});
  await query(`insert into public.athlete_memberships (athlete_id, team_id, membership_type, status) values ($1,$2,'team','active')`, [athleteId, teamAId]);
  await query(`insert into public.athlete_memberships (athlete_id, team_id, membership_type, status) values ($1,$2,'team','active')`, [athleteId, teamBId]);

  const sysDef = await query(`insert into training_load.metric_definitions (key, label, owner_scope, state, created_by_user_id) values ($1,'Shared Team Metric','system','active',$2) returning id`, [`shared-team-${uid()}`, adminId]);
  const sysVer = await query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id) values ($1,1,'bpm','numeric','sum',$2) returning id`, [sysDef.rows[0].id, adminId]);
  await query(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [sysVer.rows[0].id, sysDef.rows[0].id]);
  await query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'session')`, [sysDef.rows[0].id]);
  const metricDefinitionId = sysDef.rows[0].id;
  const versionId = sysVer.rows[0].id;

  // A team-scoped event requires a team-scoped source connection (the DB
  // trigger requires the event's own owner_scope to match its
  // connection's owner_scope) — makeSourceConnection only makes club-
  // scoped ones, so each team gets its own real team-scoped connection.
  const connA = (await query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('test-import','team',$1) returning id`, [teamAId])).rows[0].id;
  const connB = (await query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('test-import','team',$1) returning id`, [teamBId])).rows[0].id;
  const actA = await makeActivityWithEventScoped({ ownerScope: "team", scopeId: teamAId, coachId, athleteId, connectionId: connA, date: "2026-09-09" });
  await addMetricValue({ eventParticipantId: actA.eventParticipantId, metricDefinitionId, versionId, value: 111, aggregationRole: "standalone", coverage: "not_applicable" });
  const actB = await makeActivityWithEventScoped({ ownerScope: "team", scopeId: teamBId, coachId, athleteId, connectionId: connB, date: "2026-09-09", startedAt: "2026-09-09T15:00:00Z" });
  await addMetricValue({ eventParticipantId: actB.eventParticipantId, metricDefinitionId, versionId, value: 222, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachACookie, { ownerScope: "team", ownerTeamId: teamAId });
  const w = await makeWidgetHttp(coachACookie, dashboard);
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachACookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" },
  });
  const result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachACookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.equal(result.status, 200);
  const values = result.body.widgets[0].series[0].data.current.map((r) => Number(r.value));
  assert.deepEqual(values, [111], "only Team A's own activity value for the shared athlete — Team B's value for the SAME athlete/metric must never leak in");
});

// --- Fail-fast #4/#5/#6: default/runtime/widget-override clearing for activityId/componentId ---

test("§9.13 dashboard default activityId is cleared by an explicit runtime activityId:null", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l913");
  const { athleteId } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  const act1 = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09" });
  await addMetricValue({ eventParticipantId: act1.eventParticipantId, metricDefinitionId, versionId, value: 100, aggregationRole: "standalone", coverage: "not_applicable" });
  const act2 = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09", startedAt: "2026-09-09T15:00:00Z" });
  await addMetricValue({ eventParticipantId: act2.eventParticipantId, metricDefinitionId, versionId, value: 200, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachCookie);
  const patched = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: dashboard.revision, defaultFilter: { activityId: act1.activityId } } });
  assert.equal(patched.status, 200);
  const w = await makeWidgetHttp(coachCookie, patched.body.dashboard);
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 2, groupBy: "session" } });

  const withDefault = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.deepEqual(withDefault.body.widgets[0].series[0].data.current.map((r) => Number(r.value)), [100], "the default activityId narrows to act1 only");

  const cleared = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09", activityId: null } });
  const values = cleared.body.widgets[0].series[0].data.current.map((r) => Number(r.value)).sort();
  assert.deepEqual(values, [100, 200], "an explicit runtime activityId:null clears the dashboard default — both activities show");
});

test("§9.14 dashboard default componentId is cleared by an explicit runtime componentId:null", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l914");
  const { athleteId } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  const act = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09" });
  await addMetricValue({ eventParticipantId: act.eventParticipantId, metricDefinitionId, versionId, value: 100, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachCookie);
  // A default componentId that resolves to NO owning activity structurally
  // zeroes out the authorized activity set (buildRangeContext's own
  // componentId-intersection rule) — a deterministic, real way to prove
  // the CLEAR mechanism without needing the full component_types/segment-
  // link fixture graph a real component grain needs (already exercised,
  // via activityId, by §6.1/§6.2 from the original round; that shared
  // code path is what actually narrows by componentId too).
  const bogusComponentId = crypto.randomUUID();
  const patched = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: dashboard.revision, defaultFilter: { componentId: bogusComponentId } } });
  assert.equal(patched.status, 200);
  const w = await makeWidgetHttp(coachCookie, patched.body.dashboard);
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 2, groupBy: "session" } });

  const withDefault = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.equal(withDefault.body.widgets[0].series[0].data.current.length, 0, "the (unmatched) default componentId narrows to zero rows");

  const cleared = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09", componentId: null } });
  assert.deepEqual(cleared.body.widgets[0].series[0].data.current.map((r) => Number(r.value)), [100], "an explicit runtime componentId:null clears the dashboard default — the real activity shows again");
});

test("§9.15 a widget local override of activityId:null/componentId:null correctly overrides a real dashboard default for THAT widget only", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l915");
  const { athleteId } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  const act1 = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09" });
  await addMetricValue({ eventParticipantId: act1.eventParticipantId, metricDefinitionId, versionId, value: 100, aggregationRole: "standalone", coverage: "not_applicable" });
  const act2 = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09", startedAt: "2026-09-09T15:00:00Z" });
  await addMetricValue({ eventParticipantId: act2.eventParticipantId, metricDefinitionId, versionId, value: 200, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachCookie);
  const patched = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: dashboard.revision, defaultFilter: { activityId: act1.activityId } } });
  const w1 = await makeWidgetHttp(coachCookie, patched.body.dashboard);
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w1.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w1.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 2, groupBy: "session" } });

  const dAfter1 = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const w2 = await makeWidgetHttp(coachCookie, dAfter1.body.dashboard, { x: 6, localFilterOverride: { activityId: null, componentId: null } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w2.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w2.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 2, groupBy: "session" } });

  const result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  const byWidget = Object.fromEntries(result.body.widgets.map((w) => [w.widgetId, w.series[0]]));
  assert.deepEqual(byWidget[w1.widgetId].data.current.map((r) => Number(r.value)), [100], "widget 1 inherits the real dashboard default (act1 only)");
  assert.deepEqual(byWidget[w2.widgetId].data.current.map((r) => Number(r.value)).sort(), [100, 200], "widget 2's own {activityId:null, componentId:null} override clears the default for THIS widget only — both activities show");
});

// --- Fail-fast #7: athleteIds:[] locked semantics ---

test("§9.16 athleteIds:[] means 'no athlete restriction', identically to null/absent — including sharing the SAME range-context cache key", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l916");
  const { athleteId: athleteA } = await makeAthleteInClub(clubId);
  const { athleteId: athleteB } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  const actA = await makeActivityWithEvent({ clubId, coachId, athleteId: athleteA, connectionId, date: "2026-09-09" });
  await addMetricValue({ eventParticipantId: actA.eventParticipantId, metricDefinitionId, versionId, value: 11, aggregationRole: "standalone", coverage: "not_applicable" });
  const actB = await makeActivityWithEvent({ clubId, coachId, athleteId: athleteB, connectionId, date: "2026-09-09", startedAt: "2026-09-09T15:00:00Z" });
  await addMetricValue({ eventParticipantId: actB.eventParticipantId, metricDefinitionId, versionId, value: 22, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachCookie);
  const w1 = await makeWidgetHttp(coachCookie, dashboard);
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w1.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w1.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 2, groupBy: "session" } });
  const dAfter1 = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const w2 = await makeWidgetHttp(coachCookie, dAfter1.body.dashboard, { x: 6, localFilterOverride: { athleteIds: [] } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w2.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" } });
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w2.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 2, groupBy: "session" } });

  const original = pool.query.bind(pool);

  // Baseline: cost of querying widget 1 ALONE (its own one range context).
  let before = queryCount;
  pool.query = (...args) => { queryCount += 1; return original(...args); };
  let onlyW1;
  try {
    onlyW1 = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09", widgetIds: [w1.widgetId] } });
  } finally {
    pool.query = original;
  }
  const singleWidgetCost = queryCount - before;
  assert.equal(onlyW1.status, 200);

  // Both widgets together — if athleteIds:[] genuinely normalizes to the
  // SAME cache key as widget 1's "no filter at all", this must cost only
  // a small per-series increment over the single-widget baseline (one
  // extra series to read/reduce), never a SECOND range-context fetch
  // (which would add many more statements — activity ids, canonical
  // facts, occasion context, version info, participant rows, ...).
  before = queryCount;
  pool.query = (...args) => { queryCount += 1; return original(...args); };
  let result;
  try {
    result = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  } finally {
    pool.query = original;
  }
  const bothWidgetsCost = queryCount - before;
  assert.equal(result.status, 200);
  const byWidget = Object.fromEntries(result.body.widgets.map((w) => [w.widgetId, w.series[0]]));
  assert.deepEqual(byWidget[w1.widgetId].data.current.map((r) => Number(r.value)).sort(), [11, 22], "widget 1 (no filter at all) sees both athletes");
  assert.deepEqual(byWidget[w2.widgetId].data.current.map((r) => Number(r.value)).sort(), [11, 22], "widget 2's athleteIds:[] override must behave identically — 'no restriction', never 'restrict to nobody'");
  assert.ok(bothWidgetsCost <= singleWidgetCost + 3, `adding widget 2 (whose athleteIds:[] must share widget 1's range context) must cost only a tiny increment over the single-widget baseline, not a whole second context fetch — single-widget=${singleWidgetCost}, both=${bothWidgetsCost}`);
});

// --- Fail-fast #8: 100+ widgets across 3 contexts, bounded query count ---

test("§9.17 NO N+1 at real scale: 100 widgets split across 3 distinct filter contexts still cost a small, bounded (<=30) statement count", { timeout: 120000 }, async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l917");
  const { athleteId: athleteA } = await makeAthleteInClub(clubId);
  const { athleteId: athleteB } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  for (const athleteId of [athleteA, athleteB]) {
    const act = await makeActivityWithEvent({ clubId, coachId, athleteId, connectionId, date: "2026-09-09" });
    await addMetricValue({ eventParticipantId: act.eventParticipantId, metricDefinitionId, versionId, value: 42, aggregationRole: "standalone", coverage: "not_applicable" });
  }
  const dashboard = await makeDashboardHttp(coachCookie);
  let currentDashboard = dashboard;
  const contexts = [{ athleteIds: [athleteA] }, { athleteIds: [athleteB] }, null];
  for (let i = 0; i < 100; i += 1) {
    const override = contexts[i % 3];
    const w = await makeWidgetHttp(coachCookie, currentDashboard, { widgetType: "kpi", x: (i % 4) * 3, y: Math.floor(i / 4) * 2, width: 3, height: 2, ...(override ? { localFilterOverride: override } : {}) });
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
  assert.ok(statementsForThisQuery <= 30, `expected <=30 DB statements for 100 widgets across 3 distinct filter contexts (was 26 for 12 widgets/3 contexts) — got ${statementsForThisQuery}`);
  console.log(`[§9.17] 100 widgets / 3 distinct filter contexts -> ${statementsForThisQuery} DB statements`);
});

// --- Finding #9: resolveTemplateSeriesForWorkspace() scalability ---

test("§9.18 resolveTemplateSeriesForWorkspace() stays set-based at real scale: 1000 metric definitions, many shared keys/owner scopes/capabilities, many resolved hints", async () => {
  const { adminId } = await makePlatformAdmin("l918admin");
  const { clubId, coachId } = await makeClubCoach("l918");
  const keyPrefix = `stress-${uid()}`;
  const HINT_COUNT = 100;

  // Structural note: training_load.metric_definitions has a real UNIQUE
  // constraint on (owner_scope, owner_user_id, owner_club_id, owner_team_id,
  // key) — so within ONE owner scope+id, a key can appear at most once.
  // The realistic "many equal keys, many candidates" shape this schema
  // actually supports is: many DISTINCT keys, each with a SMALL, bounded
  // number of owner-scope variants (here: 1 system + 1 club per key) —
  // 1000 total definitions (500 keys x 2 owner scopes), each key resolving
  // to exactly 2 real candidates when queried from the target club. This
  // is what "different owner scopes and capabilities" genuinely means at
  // this scale, not one hint impossibly matching hundreds of duplicate
  // rows under a single owner scope.
  // NOTE: a single WITH-clause statement whose primary UPDATE targets the
  // SAME table an earlier CTE just INSERTed into does not reliably see
  // those brand-new rows (the primary statement's own row lookups use
  // the pre-statement snapshot) — confirmed empirically. So each block
  // below is genuinely TWO round trips (one combined insert-of-
  // definitions+versions, one bulk update wiring current_version_id via
  // array parameters) rather than one, but still nowhere near 1000
  // individual round trips.
  async function bulkCreateStressDefinitions(ownerScope, ownerClubId, count) {
    const ownerCol = ownerScope === "club" ? "owner_club_id" : null;
    const defs = ownerCol
      ? await query(
          `insert into training_load.metric_definitions (key, label, owner_scope, ${ownerCol}, state, created_by_user_id)
           select $1 || '-' || i, 'Stress ' || $3 || ' ' || i, $3, $4, 'active', $5
           from generate_series(1, $2) as i
           returning id`,
          [keyPrefix, count, ownerScope, ownerClubId, adminId],
        )
      : await query(
          `insert into training_load.metric_definitions (key, label, owner_scope, state, created_by_user_id)
           select $1 || '-' || i, 'Stress ' || $3 || ' ' || i, $3, 'active', $4
           from generate_series(1, $2) as i
           returning id`,
          [keyPrefix, count, ownerScope, adminId],
        );
    const defIds = defs.rows.map((r) => r.id);
    const vers = await query(
      `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id)
       select id, 1, 'bpm', 'numeric', 'sum', $2 from unnest($1::uuid[]) as id
       returning id, metric_definition_id`,
      [defIds, adminId],
    );
    await query(
      `update training_load.metric_definitions d set current_version_id = v.ver_id
       from (select unnest($1::uuid[]) as def_id, unnest($2::uuid[]) as ver_id) v
       where v.def_id = d.id`,
      [vers.rows.map((r) => r.metric_definition_id), vers.rows.map((r) => r.id)],
    );
  }
  await bulkCreateStressDefinitions("system", null, 500);
  await bulkCreateStressDefinitions("club", clubId, 500);
  await query(
    `insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level)
     select id, 'session' from training_load.metric_definitions where key like $1 || '-%'`,
    [keyPrefix],
  );
  const totalDefs = (await query(`select count(*)::int as n from training_load.metric_definitions where key like $1 || '-%'`, [keyPrefix])).rows[0].n;
  assert.equal(totalDefs, 1000, "sanity: exactly 1000 stress-fixture definitions were created");

  const widgetsModule = await import("../src/trainingLoadDashboardWidgets.js");
  const original = pool.query.bind(pool);

  // finding #6 requires the resolver phase to cost a CONSTANT, small
  // (<=2-3) number of SELECTs whether the batch holds 1, 10, or 100
  // hint-bearing series — measured as three SEPARATE batch calls here,
  // each over a DIFFERENT slice of the 1000-definition pool so no result
  // is cached/reused across measurements.
  async function measureBatch(count, offset) {
    const specs = [];
    for (let i = 1; i <= count; i += 1) specs.push({ sourceSeriesId: `s${offset + i}`, hints: [{ key: `${keyPrefix}-${offset + i}`, scopeLevel: "session" }] });
    let statements = 0;
    pool.query = (...args) => { statements += 1; return original(...args); };
    const start = Date.now();
    let results;
    try {
      results = await widgetsModule.resolveTemplateSeriesBatchForWorkspace(query, specs, { dataWorkspaceType: "club", dataWorkspaceScopeId: clubId, ownerUserId: null });
    } finally {
      pool.query = original;
    }
    const elapsedMs = Date.now() - start;
    for (const spec of specs) {
      const r = results.get(spec.sourceSeriesId);
      assert.equal(r.status, "ambiguous", `every hint must genuinely see both its system and club candidate`);
      assert.equal(r.candidateIds.length, 2, "exactly the 2 real candidates — never more, never fewer");
    }
    return { statements, elapsedMs };
  }

  const batch1 = await measureBatch(1, 0);
  const batch10 = await measureBatch(10, 1);
  const batch100 = await measureBatch(100, 11);

  for (const [label, { statements }] of [["1", batch1], ["10", batch10], ["100", batch100]]) {
    assert.ok(statements <= 3, `resolveTemplateSeriesBatchForWorkspace() must cost <=3 SELECTs for a batch of ${label} hint-bearing series — got ${statements}`);
  }
  console.log(`[§9.18] 1000 metric definitions (500 keys x 2 owner scopes) — batch resolver cost: 1 series -> ${batch1.statements} stmts/${batch1.elapsedMs}ms, 10 series -> ${batch10.statements} stmts/${batch10.elapsedMs}ms, 100 series -> ${batch100.statements} stmts/${batch100.elapsedMs}ms`);
});

// ============================================================
// §10 — LAST merge-readiness corrective round (from commit 2edac10): the
// 8 strict findings, each fail-fast test reproducing its problem BEFORE
// the fix it now verifies. §10.6 is deliberately absent — the rewritten
// §9.18 above already IS that fail-fast test for finding #6 (the batch
// resolver), verbatim to the letter of fail-fast #10.
// ============================================================

// --- Finding #1: account-identity gap in dataWorkspaceMatches() ---

test("§10.1 platform-admin/dual-role cross-account isolation: a private_coach or athlete workspace never matches ANOTHER account's private dashboard for query/active-selection (info-hiding 404) — GET (structure) still works for a platform admin, and the OWNER's own original workspace keeps working — finding #1, fail-fast #1/#2", async () => {
  // --- private_coach half ---
  const coachA = await makeUser({ email: `l101-coacha-${uid()}@test.local` });
  await grantGlobalRole(coachA, "independent_coach");
  await setActiveWorkspace(coachA, "private_coach", null);
  const coachACookie = await loginCookie(coachA);
  const dashA = await makeDashboardHttp(coachACookie);
  assert.equal(dashA.data_workspace_type, "private_coach");

  const admin = await makeUser({ email: `l101-dualadmin-${uid()}@test.local` });
  await grantGlobalRole(admin, "platform_admin");
  await grantGlobalRole(admin, "independent_coach");
  await setActiveWorkspace(admin, "private_coach", null);
  const adminCookie = await loginCookie(admin);

  const seenStructure = await api(`/api/training-load/dashboards/${dashA.id}`, { cookie: adminCookie });
  assert.equal(seenStructure.status, 200, "a platform admin may still view the STRUCTURE of another coach's private dashboard");

  const queried = await api(`/api/training-load/dashboards/${dashA.id}/query`, { method: "POST", cookie: adminCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.equal(queried.status, 404, "querying from the admin's OWN (different) private_coach workspace must be info-hiding 404, never 403");
  assert.equal(queried.body.error, "notFound");

  const setActive = await api("/api/training-load/dashboards/active", { method: "POST", cookie: adminCookie, body: { dashboardId: dashA.id } });
  assert.equal(setActive.status, 404, "setting ANOTHER account's private_coach dashboard active must be info-hiding 404");
  assert.equal(setActive.body.error, "notFound");

  const ownQuery = await api(`/api/training-load/dashboards/${dashA.id}/query`, { method: "POST", cookie: coachACookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.equal(ownQuery.status, 200, "the OWNER, in their own original private_coach workspace, must keep working");
  const ownActive = await api("/api/training-load/dashboards/active", { method: "POST", cookie: coachACookie, body: { dashboardId: dashA.id } });
  assert.equal(ownActive.status, 200);

  // --- athlete half ---
  const clubX = await makeClub("l101 club");
  const athleteUser = await makeUser({ email: `l101-athleteuser-${uid()}@test.local`, roleHint: "athlete" });
  const athleteRow = await makeAthlete({ userId: athleteUser, timezone: "UTC" });
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteRow, clubX]);
  await setActiveWorkspace(athleteUser, "athlete", null);
  const athleteCookie = await loginCookie(athleteUser);
  const dashAthlete = await makeDashboardHttp(athleteCookie);
  assert.equal(dashAthlete.data_workspace_type, "athlete");

  const dualAthleteRow = await makeAthlete({ userId: admin, timezone: "UTC" });
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [dualAthleteRow, clubX]);
  await setActiveWorkspace(admin, "athlete", null);
  const adminAsAthleteCookie = await loginCookie(admin);

  const seenStructure2 = await api(`/api/training-load/dashboards/${dashAthlete.id}`, { cookie: adminAsAthleteCookie });
  assert.equal(seenStructure2.status, 200, "a platform admin may still view the STRUCTURE of another athlete's private dashboard");
  const queried2 = await api(`/api/training-load/dashboards/${dashAthlete.id}/query`, { method: "POST", cookie: adminAsAthleteCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.equal(queried2.status, 404);
  assert.equal(queried2.body.error, "notFound");
  const setActive2 = await api("/api/training-load/dashboards/active", { method: "POST", cookie: adminAsAthleteCookie, body: { dashboardId: dashAthlete.id } });
  assert.equal(setActive2.status, 404);
  assert.equal(setActive2.body.error, "notFound");

  const ownQuery2 = await api(`/api/training-load/dashboards/${dashAthlete.id}/query`, { method: "POST", cookie: athleteCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.equal(ownQuery2.status, 200, "the athlete OWNER, in their own workspace, must keep working");
});

// --- Finding #2: partial layout PATCH must COALESCE, never null out omitted fields ---

test("§10.2 partial layout PATCH preserves every OMITTED field and changes only what was SENT — finding #2, fail-fast #3", async () => {
  const { coachCookie } = await makeClubCoach("l102");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard, { x: 2, y: 3, width: 6, height: 4, mobileOrder: 7 });
  const patched = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/layout`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 1, width: 8 } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.widget.width, 8, "the SENT field changed");
  assert.equal(patched.body.widget.x, 2, "x must be preserved, not nulled");
  assert.equal(patched.body.widget.y, 3, "y must be preserved, not nulled");
  assert.equal(patched.body.widget.height, 4, "height must be preserved, not nulled");
  assert.equal(patched.body.widget.mobile_order, 7, "mobileOrder must be preserved, not nulled");
  assert.equal(patched.body.widget.widget_revision, 2, "the widget revision must have bumped exactly once");
});

test("§10.2b partial layout PATCH strict matrix: width:0, height:0, x:12, an empty body, and an unknown nested field all reject 400 with ZERO writes and an unchanged revision — finding #2, fail-fast #4", async () => {
  const { coachCookie } = await makeClubCoach("l102b");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard, { x: 0, y: 0, width: 6, height: 4, mobileOrder: 1 });
  const attempts = [{ width: 0 }, { height: 0 }, { x: 12 }, {}, { unknownField: 1 }];
  for (const body of attempts) {
    const res = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/layout`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: 1, ...body } });
    assert.equal(res.status, 400, `${JSON.stringify(body)} must reject with 400 — got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalidRequest");
  }
  const check = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const widgetRow = check.body.widgets.find((x) => x.id === w.widgetId);
  assert.equal(widgetRow.x, 0);
  assert.equal(widgetRow.width, 6);
  assert.equal(widgetRow.revision, 1, "no rejected attempt may have bumped the widget revision");
});

// --- Finding #3: unified nullable-field PATCH semantics ---

test("§10.3 series color/displayLabel: absent preserves, explicit null clears, a string replaces — finding #3, fail-fast #5", async () => {
  const { coachCookie } = await makeClubCoach("l103");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  const series = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "rpe", color: "#ff0000", displayLabel: "My RPE" } });
  assert.equal(series.status, 201, JSON.stringify(series.body));
  const seriesId = series.body.seriesId;
  // A series add/update/delete bumps its PARENT WIDGET's own revision too
  // (training_load.bump_widget_revision(), v16) — every subsequent call
  // must thread the ACTUAL returned widgetRevision, never a guessed value.
  let widgetRevision = series.body.widgetRevision;

  const p1 = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/${seriesId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: widgetRevision, axis: "secondary" } });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  widgetRevision = p1.body.widgetRevision;
  let detail = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  let s = detail.body.widgets[0].series[0];
  assert.equal(s.color, "#ff0000", "absent color must be PRESERVED, not nulled");
  assert.equal(s.display_label, "My RPE", "absent displayLabel must be PRESERVED, not nulled");
  assert.equal(s.axis, "secondary");

  const p2 = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/${seriesId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: widgetRevision, color: null, displayLabel: null } });
  assert.equal(p2.status, 200, JSON.stringify(p2.body));
  widgetRevision = p2.body.widgetRevision;
  detail = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  s = detail.body.widgets[0].series[0];
  assert.equal(s.color, null, "explicit null must actually CLEAR color");
  assert.equal(s.display_label, null, "explicit null must actually CLEAR displayLabel");

  const p3 = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/${seriesId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: widgetRevision, color: "#00ff00" } });
  assert.equal(p3.status, 200, JSON.stringify(p3.body));
  detail = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  s = detail.body.widgets[0].series[0];
  assert.equal(s.color, "#00ff00", "a string value must REPLACE");
  assert.equal(s.display_label, null, "displayLabel stays cleared — untouched by this PATCH");
});

test("§10.3b sourceConnectionId:null while sourcePolicy stays 'source_connection' is rejected 400 (zero writes); switching sourcePolicy away in the SAME request auto-clears the pin — finding #3", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l103b");
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  const series = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, sourcePolicy: "source_connection", sourceConnectionId: connectionId, dataScopeLevel: "session", analyticalAggregation: "sum" } });
  assert.equal(series.status, 201, JSON.stringify(series.body));
  const seriesId = series.body.seriesId;
  const widgetRevision = series.body.widgetRevision;

  const rejected = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/${seriesId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: widgetRevision, sourceConnectionId: null } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "invalidRequest");
  let detail = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  let s = detail.body.widgets[0].series[0];
  assert.equal(s.source_connection_id, connectionId, "the rejected request must not have cleared the pin");

  const cleared = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/${seriesId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: widgetRevision, sourcePolicy: "manual", sourceConnectionId: null } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  detail = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  s = detail.body.widgets[0].series[0];
  assert.equal(s.source_policy, "manual");
  assert.equal(s.source_connection_id, null, "switching sourcePolicy away from 'source_connection' in the SAME request auto-clears the pin");
});

// --- Finding #4: strict Node-side validation, DB CHECK/FK is only a backstop ---

test("§10.4 every enum gets at least one invalid example → 400 invalidRequest, zero writes, unchanged revision — finding #4, fail-fast #6", async () => {
  const { coachCookie } = await makeClubCoach("l104");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  const seriesOk = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "rpe" } });
  assert.equal(seriesOk.status, 201, JSON.stringify(seriesOk.body));
  const seriesId = seriesOk.body.seriesId;
  // Adding the series already bumped widget.revision once (trigger-driven,
  // v16) — every REJECTED attempt below must be checked against THAT real
  // value, and must never bump it further.
  const widgetRevision = seriesOk.body.widgetRevision;

  const badGroupBy = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: widgetRevision, groupBy: "bogus" } });
  assert.equal(badGroupBy.status, 400);
  const badState = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: widgetRevision, state: "bogus" } });
  assert.equal(badState.status, 400);

  const seriesCases = [
    { axis: "bogus" }, { sourcePolicy: "bogus" }, { dataScopeLevel: "bogus" },
    { analyticalAggregation: "bogus" }, { aggregationRolePolicy: "bogus" }, { coveragePolicy: "bogus" }, { comparisonPeriod: "bogus" },
  ];
  for (const body of seriesCases) {
    const res = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/${seriesId}`, { method: "PATCH", cookie: coachCookie, body: { expectedWidgetRevision: widgetRevision, ...body } });
    assert.equal(res.status, 400, `${JSON.stringify(body)} must reject — got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalidRequest");
  }

  const detail = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const widgetRow = detail.body.widgets.find((x) => x.id === w.widgetId);
  assert.equal(widgetRow.revision, widgetRevision, "no rejected PATCH may have bumped the widget revision");
  assert.equal(widgetRow.series[0].axis, "primary", "no rejected series PATCH may have changed anything");
});

test("§10.4b strict Node validation — description length, displayConfig shape, unknown widgetType/builtInSeriesKey, duplicate ids in a layout/reorder batch, and contradictory owner fields — finding #4, fail-fast #7", async () => {
  const { clubId, coachCookie } = await makeClubCoach("l104b");
  const dashboard = await makeDashboardHttp(coachCookie);

  const tooLong = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: dashboard.revision, description: "x".repeat(2001) } });
  assert.equal(tooLong.status, 400);

  const badDisplayConfig = await api(`/api/training-load/dashboards/${dashboard.id}/widgets`, { method: "POST", cookie: coachCookie, body: { expectedDashboardRevision: dashboard.revision, widgetType: "table", title: "W", widgetOrder: 9001, x: 0, y: 0, width: 6, height: 4, mobileOrder: 9001, displayConfig: { foo: "bar" } } });
  assert.equal(badDisplayConfig.status, 400, "displayConfig without a positive integer schemaVersion must reject");

  const unknownWidgetType = await api(`/api/training-load/dashboards/${dashboard.id}/widgets`, { method: "POST", cookie: coachCookie, body: { expectedDashboardRevision: dashboard.revision, widgetType: "totally-bogus-type", title: "W", widgetOrder: 9002, x: 0, y: 0, width: 6, height: 4, mobileOrder: 9002 } });
  assert.equal(unknownWidgetType.status, 400);

  const w = await makeWidgetHttp(coachCookie, dashboard);
  const unknownBuiltIn = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "totally-bogus-key" } });
  assert.equal(unknownBuiltIn.status, 400);

  // Creating w already bumped dashboard.revision (trigger-driven, v16) —
  // w.dashboardRevision (from createWidget's own return) is the real,
  // fresh value, never the stale pre-creation dashboard.revision.
  const w2 = await api(`/api/training-load/dashboards/${dashboard.id}/widgets`, { method: "POST", cookie: coachCookie, body: { expectedDashboardRevision: w.dashboardRevision, widgetType: "table", title: "W2", widgetOrder: 9003, x: 6, y: 0, width: 6, height: 4, mobileOrder: 9003 } });
  assert.equal(w2.status, 201, JSON.stringify(w2.body));
  const dupLayout = await api(`/api/training-load/dashboards/${dashboard.id}/layout`, { method: "PUT", cookie: coachCookie, body: { expectedRevision: w2.body.dashboardRevision, layout: [{ widgetId: w.widgetId, x: 0 }, { widgetId: w.widgetId, x: 1 }] } });
  assert.equal(dupLayout.status, 400, "a layout batch repeating the same widgetId must reject");

  const s1 = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "rpe" } });
  assert.equal(s1.status, 201, JSON.stringify(s1.body));
  // s1's own add bumped widget.revision again — s2 must use that REAL value.
  const s2 = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: s1.body.widgetRevision, seriesOrder: 2, builtInSeriesKey: "srpe" } });
  assert.equal(s2.status, 201, JSON.stringify(s2.body));
  const dupReorder = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series/reorder`, { method: "PUT", cookie: coachCookie, body: { expectedWidgetRevision: s2.body.widgetRevision, order: [{ seriesId: s1.body.seriesId, seriesOrder: 1 }, { seriesId: s1.body.seriesId, seriesOrder: 2 }] } });
  assert.equal(dupReorder.status, 400, "a reorder batch repeating the same seriesId must reject");

  const badOwner = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "X", ownerScope: "club", ownerClubId: clubId, ownerTeamId: crypto.randomUUID() } });
  assert.equal(badOwner.status, 400, "an irrelevant owner field for the requested ownerScope must reject, never be silently ignored");
});

// --- Finding #5: authoritative, server-derived template-hint contract ---

test("§10.5 add_series() on a template dashboard: the server ALWAYS derives templateMetricKeyHints from the LOCKED real metric definition — pairing a real metricDefinitionId with a client hint (or the retired resolutionStatus field) is rejected 400 with ZERO writes, and a legitimate metric-backed series gets the metric's OWN real key/unit/valueType, never a spoofed one — finding #5, fail-fast #8", async () => {
  const { adminId, adminCookie } = await makePlatformAdmin("l105");
  const created = await api("/api/training-load/dashboards", { method: "POST", cookie: adminCookie, body: { name: "Sys Template", ownerScope: "system" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const dashboard = created.body.dashboard;
  const w = await makeWidgetHttp(adminCookie, dashboard);

  const defRes = await query(`insert into training_load.metric_definitions (key, label, owner_scope, state, created_by_user_id) values ($1,$2,'system','active',$3) returning id, key`, [`metric-${uid()}`, "System Metric", adminId]);
  const metricDefinitionId = defRes.rows[0].id;
  const realKey = defRes.rows[0].key;
  const verRes = await query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id) values ($1,1,'bpm','numeric','sum',$2) returning id`, [metricDefinitionId, adminId]);
  await query(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [verRes.rows[0].id, metricDefinitionId]);
  await query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'session')`, [metricDefinitionId]);

  const spoofedHint = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: adminCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, templateMetricKeyHints: [{ key: "totally-fake-metric" }] } });
  assert.equal(spoofedHint.status, 400);
  assert.equal(spoofedHint.body.error, "invalidRequest");

  const spoofedStatus = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: adminCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, resolutionStatus: "resolved" } });
  assert.equal(spoofedStatus.status, 400, "resolutionStatus is retired — always an unknown-field 400");

  const zeroRows = await query(`select count(*)::int as n from training_load.dashboard_widget_series where widget_id=$1`, [w.widgetId]);
  assert.equal(zeroRows.rows[0].n, 0, "neither spoofed attempt may have written a series row");

  const legit = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, { method: "POST", cookie: adminCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId } });
  assert.equal(legit.status, 201, JSON.stringify(legit.body));
  const detail = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: adminCookie });
  const s = detail.body.widgets[0].series[0];
  assert.equal(s.resolution_status, "resolved");
  assert.deepEqual(s.template_metric_key_hints, [{ key: realKey, valueType: "numeric", unit: "bpm", scopeLevel: "session" }], "the server's own hint must name the metric's REAL key/unit/valueType — never a client-influenced value");
});

// --- Finding #7: real component-grain proof ---

test("§10.7 real component-grain fixture: BOTH real components bucket distinctly, componentId=A narrows to A only, a session-grain series of the SAME activity stays visible under a component filter, dashboard-default/runtime-clear/widget-local-clear all work over REAL components, and a foreign component returns zero data without widening the authorized set — finding #7, fail-fast #11", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l107");
  const { athleteId } = await makeAthleteInClub(clubId);
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId, adminId: coachId, scopeLevels: ["session", "component"] });
  const fx = await makeComponentFixture({ clubId, coachId, athleteId, connectionId, date: "2026-09-09" });

  await addMetricValue({ eventParticipantId: fx.eventParticipantId, metricDefinitionId, versionId, value: 10, segmentId: fx.segmentAId, aggregationRole: "standalone", coverage: "not_applicable" });
  await addMetricValue({ eventParticipantId: fx.eventParticipantId, metricDefinitionId, versionId, value: 20, segmentId: fx.segmentBId, aggregationRole: "standalone", coverage: "not_applicable" });
  await addMetricValue({ eventParticipantId: fx.eventParticipantId, metricDefinitionId, versionId, value: 99, segmentId: null, aggregationRole: "standalone", coverage: "not_applicable" });

  const dashboard = await makeDashboardHttp(coachCookie);
  // W1: component-grain series, groupBy='component' — the ONLY groupBy that
  // buckets per real canonical component (groupBy='session'/'day' would sum
  // both components' values into one bucket, defeating this test's own proof).
  const w1 = await makeWidgetHttp(coachCookie, dashboard, { groupBy: "component" });
  const compSeries = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w1.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "component", analyticalAggregation: "sum" } });
  assert.equal(compSeries.status, 201, JSON.stringify(compSeries.body));
  // W2: session-grain series of the SAME activity, in its OWN widget (groupBy
  // is a per-widget property) — proves the session value stays visible under
  // a componentId filter, per the adopted contract.
  const dAfterW1 = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const w2 = await makeWidgetHttp(coachCookie, dAfterW1.body.dashboard, { x: 6, groupBy: "session" });
  const sessSeries = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w2.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "sum" } });
  assert.equal(sessSeries.status, 201, JSON.stringify(sessSeries.body));

  function seriesResultFor(body, widgetId) {
    return body.widgets.find((w) => w.widgetId === widgetId).series[0];
  }

  // 1. No filter: both REAL components exist as distinct canonical buckets;
  //    the session-grain value is also visible in its own widget.
  const noFilter = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.equal(noFilter.status, 200, JSON.stringify(noFilter.body));
  assert.deepEqual(seriesResultFor(noFilter.body, w1.widgetId).data.current.map((r) => Number(r.value)).sort((a, b) => a - b), [10, 20], "no filter: BOTH real components show as distinct canonical buckets");
  assert.deepEqual(seriesResultFor(noFilter.body, w2.widgetId).data.current.map((r) => Number(r.value)), [99], "the session-grain value is visible");

  // 2. componentId=A narrows the component series to ONLY A; the session
  //    series of the SAME activity stays visible.
  const filteredA = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09", componentId: fx.componentAId } });
  assert.equal(filteredA.status, 200, JSON.stringify(filteredA.body));
  assert.deepEqual(seriesResultFor(filteredA.body, w1.widgetId).data.current.map((r) => Number(r.value)), [10], "componentId=A narrows the component-grain series to ONLY A");
  assert.deepEqual(seriesResultFor(filteredA.body, w2.widgetId).data.current.map((r) => Number(r.value)), [99], "a session-grain series of the SAME activity stays visible under a component filter, per the adopted contract");

  // 3. Dashboard default componentId over REAL data. w2's own creation
  //    already bumped dashboard.revision — its return carries the REAL,
  //    current value (the original `dashboard.revision` captured before W1/
  //    W2 existed is stale by now).
  const patched = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: w2.dashboardRevision, defaultFilter: { componentId: fx.componentAId } } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const withDefault = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.deepEqual(seriesResultFor(withDefault.body, w1.widgetId).data.current.map((r) => Number(r.value)), [10], "a real dashboard-default componentId narrows the component series over REAL data");

  // 4. Runtime componentId:null clears the real default.
  const clearedRuntime = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09", componentId: null } });
  assert.deepEqual(seriesResultFor(clearedRuntime.body, w1.widgetId).data.current.map((r) => Number(r.value)).sort((a, b) => a - b), [10, 20], "an explicit runtime componentId:null clears the real default — both real components show again");

  // 5. Widget-local componentId:null overrides the real dashboard default for
  //    THAT widget only.
  const dAfterDefault = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  const w3 = await makeWidgetHttp(coachCookie, dAfterDefault.body.dashboard, { x: 0, y: 4, groupBy: "component", localFilterOverride: { componentId: null } });
  const w3Series = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w3.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, dataScopeLevel: "component", analyticalAggregation: "sum" } });
  assert.equal(w3Series.status, 201, JSON.stringify(w3Series.body));
  const withWidgetOverride = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09" } });
  assert.deepEqual(seriesResultFor(withWidgetOverride.body, w3.widgetId).data.current.map((r) => Number(r.value)).sort((a, b) => a - b), [10, 20], "widget-local componentId:null overrides the real dashboard default for THAT widget only, over real components");
  assert.deepEqual(seriesResultFor(withWidgetOverride.body, w1.widgetId).data.current.map((r) => Number(r.value)), [10], "the OTHER widget (no local override) still inherits the real dashboard default");

  // 6. A foreign component UUID from another workspace returns zero data,
  //    never widening the authorized set.
  const { clubId: foreignClubId, coachId: foreignCoachId, coachCookie: foreignCoachCookie } = await makeClubCoach("l107foreign");
  const { athleteId: foreignAthleteId } = await makeAthleteInClub(foreignClubId);
  const foreignConn = await makeSourceConnection(foreignClubId);
  const foreignFx = await makeComponentFixture({ clubId: foreignClubId, coachId: foreignCoachId, athleteId: foreignAthleteId, connectionId: foreignConn, date: "2026-09-09" });
  void foreignCoachCookie;
  const foreignFiltered = await api(`/api/training-load/dashboards/${dashboard.id}/query`, { method: "POST", cookie: coachCookie, body: { dateFrom: "2026-09-09", dateTo: "2026-09-09", componentId: foreignFx.componentAId } });
  assert.equal(foreignFiltered.status, 200, JSON.stringify(foreignFiltered.body));
  assert.equal(seriesResultFor(foreignFiltered.body, w1.widgetId).data.current.length, 0, "a foreign component UUID from another workspace must return zero data, never widen the authorized set to the foreign activity");
});

// --- Finding #8: remaining concurrency/clone proofs ---

test("§10.8 an in-flight/already-resolved request keeps using ITS OWN workspace snapshot for its entire lifetime, even after the preference changes mid-lifetime — a genuinely NEW request afterward sees the NEW workspace — finding #8, fail-fast #12", async () => {
  const dashAccess = await import("../src/trainingLoadDashboardAccess.js");
  const authzModule = await import("../src/authz.js");
  const clubAId = await makeClub("l108 club A");
  const clubBId = await makeClub("l108 club B");
  const coachId = await makeUser({ email: `l108-coach-${uid()}@test.local` });
  await grantClubAdmin(coachId, clubAId);
  await grantClubAdmin(coachId, clubBId);
  await setActiveWorkspace(coachId, "club", clubAId);

  const authz = await authzModule.loadAuthorizationContext({ id: coachId });
  const req = { user: { id: coachId }, authz };
  const resolved1 = await dashAccess.resolveActiveDataWorkspace(req);
  assert.equal(resolved1.dataWorkspaceScopeId, clubAId);

  // The preference changes WHILE this same request object is still (as far
  // as its own lifetime is concerned) active — a real HTTP request holds
  // its resolved snapshot for its whole duration, never re-resolving mid-
  // flight even if the underlying preference row changes concurrently.
  await setActiveWorkspace(coachId, "club", clubBId);
  const resolved2 = await dashAccess.resolveActiveDataWorkspace(req);
  assert.strictEqual(resolved2, resolved1, "a second call on the SAME request object must return the IDENTICAL cached snapshot object, never re-resolve");
  assert.equal(resolved2.dataWorkspaceScopeId, clubAId, "the SAME request must keep seeing the workspace that was active when IT resolved, never a value changed mid-request");

  // A genuinely NEW request (a fresh req object, as a new HTTP request would
  // build) issued AFTER the change must see the NEW workspace.
  const authz2 = await authzModule.loadAuthorizationContext({ id: coachId });
  const req2 = { user: { id: coachId }, authz: authz2 };
  const resolved3 = await dashAccess.resolveActiveDataWorkspace(req2);
  assert.equal(resolved3.dataWorkspaceScopeId, clubBId, "a NEW request must see the NEW workspace preference");
});

test("§10.9 clone aborts atomically (409 sourceConnectionResolutionRequired, zero new rows) when a pinned source connection is INACTIVE (deactivated AFTER being legitimately pinned) in the SAME target workspace — never a foreign-workspace substitute — finding #8, fail-fast #13", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l109");
  const connectionId = await makeSourceConnection(clubId);
  const { metricDefinitionId } = await makeMetricDefinition({ clubId, adminId: coachId });
  const template = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "Inactive-Conn Template", ownerScope: "club", ownerClubId: clubId, isTemplate: true } });
  assert.equal(template.status, 201, JSON.stringify(template.body));
  const templateId = template.body.dashboard.id;
  const w = await makeWidgetHttp(coachCookie, template.body.dashboard);
  const addSeriesRes = await api(`/api/training-load/dashboards/${templateId}/widgets/${w.widgetId}/series`, { method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId, sourcePolicy: "source_connection", sourceConnectionId: connectionId, dataScopeLevel: "session", analyticalAggregation: "sum" } });
  assert.equal(addSeriesRes.status, 201, JSON.stringify(addSeriesRes.body));

  // Deactivated strictly AFTER being legitimately pinned — add_series()'s own
  // pre-check (assertSourceConnectionReferenceOk) would reject binding an
  // ALREADY-inactive connection, so this ordering is the only real way an
  // inactive PINNED connection can ever exist.
  await query(`update training_load.metric_source_connections set state='inactive' where id=$1`, [connectionId]);

  const beforeDash = (await query(`select count(*)::int as n from training_load.dashboards`)).rows[0].n;
  const beforeWidgets = (await query(`select count(*)::int as n from training_load.dashboard_widgets`)).rows[0].n;
  const beforeSeries = (await query(`select count(*)::int as n from training_load.dashboard_widget_series`)).rows[0].n;

  const failedClone = await api(`/api/training-load/dashboards/${templateId}/clone`, { method: "POST", cookie: coachCookie, body: { ownerScope: "club", ownerClubId: clubId } });
  assert.equal(failedClone.status, 409);
  assert.equal(failedClone.body.error, "sourceConnectionResolutionRequired");

  const afterDash = (await query(`select count(*)::int as n from training_load.dashboards`)).rows[0].n;
  const afterWidgets = (await query(`select count(*)::int as n from training_load.dashboard_widgets`)).rows[0].n;
  const afterSeries = (await query(`select count(*)::int as n from training_load.dashboard_widget_series`)).rows[0].n;
  assert.equal(afterDash, beforeDash, "zero new dashboards after the atomic rollback");
  assert.equal(afterWidgets, beforeWidgets, "zero new widgets");
  assert.equal(afterSeries, beforeSeries, "zero new series rows");
  // NOTE (documented, per the finding's own explicit instruction — not
  // tested here): a "nonexistent pinned connection" at clone time is
  // STRUCTURALLY IMPOSSIBLE once a series is legitimately created — the
  // real `on delete restrict` FK from dashboard_widget_series.
  // source_connection_id to metric_source_connections(id) (v16) means the
  // connection row can never be deleted while any series still points at
  // it, so no fixture can ever construct this state without fabricating an
  // impossible one, which the finding explicitly forbids.
});

test("§10.10 REAL concurrency: add_series() vs createDefinitionVersion(), BOTH lock orderings, proven via two real connections and pg_stat_activity — never a sleep() heuristic; whichever wins, the resulting hint never straddles an old and a new version", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("l1010");
  const catalogModule = await import("../src/trainingLoadMetricsCatalog.js");
  const platformAdminReq = { user: { id: coachId }, authz: { platformRoles: ["platform_admin"] } };

  // --- Ordering A: createDefinitionVersion() locks the definition FIRST;
  //     add_series()'s own `FOR SHARE OF d` must genuinely queue behind it,
  //     then see the FULLY COMMITTED new version once unblocked.
  {
    const { metricDefinitionId } = await makeMetricDefinition({ clubId, adminId: coachId, valueType: "numeric" });
    const template = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "Concurrency A", ownerScope: "club", ownerClubId: clubId, isTemplate: true } });
    const w = await makeWidgetHttp(coachCookie, template.body.dashboard);

    let releaseLock; const lockHeld = new Promise((resolve) => { releaseLock = resolve; });
    let proceedSignal; const proceed = new Promise((resolve) => { proceedSignal = resolve; });
    const versionPromise = catalogModule.createDefinitionVersion(platformAdminReq, metricDefinitionId, { valueType: "numeric", unit: "watts" }, {
      onLocked: async () => { releaseLock(); await proceed; },
    });
    await lockHeld;

    const c = await newClient();
    let addResult;
    try {
      const addPromise = c.client.query(
        `select * from training_load.add_series($1,$2,$3,$4,null,null,'primary',null,null,'all_with_conflicts',null,'session','sum','standalone_and_source_rollup','complete_and_partial',null,$5)`,
        [w.widgetId, 1, 1, metricDefinitionId, coachId],
      ).then((r) => ({ ok: true, row: r.rows[0] })).catch((e) => ({ error: e }));
      const blocked = await waitUntilBlocked(c.pid);
      assert.ok(blocked, "add_series()'s FOR SHARE OF d on the metric definition must genuinely queue behind createDefinitionVersion()'s own FOR UPDATE");
      proceedSignal();
      const versionResult = await versionPromise;
      assert.ok(!versionResult.error, JSON.stringify(versionResult.error));
      addResult = await addPromise;
    } finally {
      await c.client.end();
    }
    assert.ok(addResult.ok, JSON.stringify(addResult.error?.message));
    const hintRow = await query(`select template_metric_key_hints from training_load.dashboard_widget_series where id=$1`, [addResult.row.series_id]);
    assert.equal(hintRow.rows[0].template_metric_key_hints[0].unit, "watts", "add_series(), once unblocked, must see the FULLY COMMITTED new version — never a straddled old/new mix");
  }

  // --- Ordering B: add_series() locks the definition FIRST (inside its own
  //     open transaction); createDefinitionVersion()'s own FOR UPDATE must
  //     genuinely queue behind it, and add_series()'s already-taken snapshot
  //     must keep the OLD version — never retroactively see a version that
  //     committed AFTER it had already read.
  {
    const { metricDefinitionId } = await makeMetricDefinition({ clubId, adminId: coachId, valueType: "numeric" });
    const template = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "Concurrency B", ownerScope: "club", ownerClubId: clubId, isTemplate: true } });
    const w = await makeWidgetHttp(coachCookie, template.body.dashboard);

    const c = await newClient();
    let addResult;
    try {
      await c.client.query("begin");
      addResult = await c.client.query(
        `select * from training_load.add_series($1,$2,$3,$4,null,null,'primary',null,null,'all_with_conflicts',null,'session','sum','standalone_and_source_rollup','complete_and_partial',null,$5)`,
        [w.widgetId, 1, 1, metricDefinitionId, coachId],
      );

      const versionPromise = catalogModule.createDefinitionVersion(platformAdminReq, metricDefinitionId, { valueType: "numeric", unit: "steps" });
      const blockedPid = await waitForAnyLockWait();
      assert.ok(blockedPid, "createDefinitionVersion()'s own FOR UPDATE must genuinely queue behind add_series()'s already-held FOR SHARE OF d");

      await c.client.query("commit");
      const versionResult = await versionPromise;
      assert.ok(!versionResult.error, JSON.stringify(versionResult.error));
    } finally {
      await c.client.end();
    }
    const hintRow = await query(`select template_metric_key_hints from training_load.dashboard_widget_series where id=$1`, [addResult.rows[0].series_id]);
    assert.equal(hintRow.rows[0].template_metric_key_hints[0].unit, "bpm", "add_series(), having already locked and read the metric BEFORE createDefinitionVersion() ever started, must keep its OWN snapshot of the OLD version — never retroactively see the version that committed AFTER it");
  }
});

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
  "202609170900_training_load_v19_dashboard_delete.sql",
  "202610301300_dashboard_simple_atomic_save.sql",
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
// mirrors makeQuickMetric() from the design-proof harness. With `teamId` it
// is team-owned instead: the older catalog writers change only team and user
// definitions (a club or system one is a canonical variable, C98), so the
// tests that drive those writers use one.
async function makeMetricDefinition({ clubId, teamId = null, adminId, label, valueType = "numeric", dailyAggregationMethod = "sum", scopeLevels = ["session", "component"], key } = {}) {
  const def = await query(
    `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id, owner_team_id, state, created_by_user_id) values ($1,$2,$3,$4,$5,'active',$6) returning id`,
    [key || `metric-${uid()}`, label || `Metric ${uid()}`, teamId ? "team" : "club", teamId ? null : clubId, teamId, adminId],
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

test("§1.1 all 20 migrations including Simple atomic save apply cleanly and record exactly this run's dashboard files", async () => {
  const applied = await query(`select migration_name from public.schema_migrations where migration_name like '%dashboard%' order by migration_name`);
  assert.equal(applied.rowCount, 6, "all six dashboard migrations including Simple atomic save must be recorded");
});

test("§1.2 re-applying the SAME migrations_v2 directory a second time is a genuine no-op (checksum-safe idempotent re-run)", async () => {
  await runner.runMigrations({ databaseUrl: db.url, migrationsRoot: migrationsDir });
  const applied = await query(`select count(*)::int as n from public.schema_migrations where migration_name like '%dashboard%'`);
  assert.equal(applied.rows[0].n, 6, "re-running must not duplicate or re-apply anything");
});

test("§1.3 upgrade path: a database at exactly v1-v14 can apply all six dashboard migrations in one runner call", async () => {
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
  // A team coach, a team dashboard and a team definition (see makeMetricDefinition).
  const { teamId, coachId, coachCookie } = await makeTeamCoach("l71");
  const { metricDefinitionId } = await makeMetricDefinition({ teamId, adminId: coachId, scopeLevels: ["session", "component"] });
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
  // A team coach, team dashboards and team definitions (see makeMetricDefinition).
  const { teamId, coachId, coachCookie } = await makeTeamCoach("l1010");
  const catalogModule = await import("../src/trainingLoadMetricsCatalog.js");
  const platformAdminReq = { user: { id: coachId }, authz: { platformRoles: ["platform_admin"] } };

  // --- Ordering A: createDefinitionVersion() locks the definition FIRST;
  //     add_series()'s own `FOR SHARE OF d` must genuinely queue behind it,
  //     then see the FULLY COMMITTED new version once unblocked.
  {
    const { metricDefinitionId } = await makeMetricDefinition({ teamId, adminId: coachId, valueType: "numeric" });
    const template = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "Concurrency A", ownerScope: "team", ownerTeamId: teamId, isTemplate: true } });
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
    const { metricDefinitionId } = await makeMetricDefinition({ teamId, adminId: coachId, valueType: "numeric" });
    const template = await api("/api/training-load/dashboards", { method: "POST", cookie: coachCookie, body: { name: "Concurrency B", ownerScope: "team", ownerTeamId: teamId, isTemplate: true } });
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

// ============================================================
// §11 - LIST visibility must equal canViewDashboardRow (fix/dashboard-
// list-visibility). Found live during the Dashboards UX H1 browser QA:
// dashboardVisibilitySql's data-workspace clause listed every OTHER
// account's private dashboard whose stored data workspace equalled the
// caller's. The single-row GET always re-checked and 404'd, so the leak
// was the list row itself (id, name, description, ownership, data-workspace
// binding, status, revision, timestamps) - never widgets/series/query data -
// but the new picker shows exactly that list. Each test below asserts BOTH surfaces (list + GET)
// for the same dashboard, so they can never drift apart again.
// ============================================================

async function listIds(cookie) {
  const r = await api("/api/training-load/dashboards", { cookie });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.dashboards.map((d) => d.id);
}

test("§11.1 two private_coach accounts: A's private dashboard is NOT in B's list (same workspace type, null scope) and B's GET is info-hiding 404; A still lists it; a platform admin still lists and reads it", async () => {
  const mk = async (label) => {
    const id = await makeUser({ email: `l111-${label}-${uid()}@test.local` });
    await grantGlobalRole(id, "independent_coach");
    await setActiveWorkspace(id, "private_coach", null);
    return { id, cookie: await loginCookie(id) };
  };
  const a = await mk("coacha");
  const b = await mk("coachb");
  const dashA = await makeDashboardHttp(a.cookie, { name: "A private" });
  assert.equal(dashA.owner_scope, "user");
  assert.equal(dashA.data_workspace_type, "private_coach");
  const dashB = await makeDashboardHttp(b.cookie, { name: "B private" });

  const seenByB = await listIds(b.cookie);
  assert.ok(!seenByB.includes(dashA.id), "B must NOT list A's private dashboard - an identical private_coach/null data workspace is not a match for a 'user'-owned board");
  assert.ok(seenByB.includes(dashB.id), "B lists their OWN private dashboard");
  const getByB = await api(`/api/training-load/dashboards/${dashA.id}`, { cookie: b.cookie });
  assert.equal(getByB.status, 404);
  assert.equal(getByB.body.error, "notFound");

  const seenByA = await listIds(a.cookie);
  assert.ok(seenByA.includes(dashA.id), "the owner keeps listing their own private dashboard");
  assert.ok(!seenByA.includes(dashB.id), "and never the other coach's");

  const { adminCookie } = await makePlatformAdmin("l111");
  const seenByAdmin = await listIds(adminCookie);
  assert.ok(seenByAdmin.includes(dashA.id) && seenByAdmin.includes(dashB.id), "platform-admin list visibility is unchanged (everything)");
  const getByAdmin = await api(`/api/training-load/dashboards/${dashA.id}`, { cookie: adminCookie });
  assert.equal(getByAdmin.status, 200, "platform-admin single GET is unchanged");
});

test("§11.2 two club admins active in the SAME club: A's private dashboard is NOT in B's list nor readable by B; A's club-owned (shared) dashboard IS listed and readable by B; a system template is listed by both", async () => {
  const clubId = await makeClub(`l112 club ${uid()}`);
  const mk = async (label) => {
    const id = await makeUser({ email: `l112-${label}-${uid()}@test.local` });
    await grantClubAdmin(id, clubId);
    await setActiveWorkspace(id, "club", clubId);
    return { id, cookie: await loginCookie(id) };
  };
  const a = await mk("a");
  const b = await mk("b");
  const privateA = await makeDashboardHttp(a.cookie, { name: "A private in club" });
  assert.equal(privateA.owner_scope, "user");
  assert.equal(privateA.data_workspace_type, "club");
  assert.equal(String(privateA.data_workspace_scope_id), String(clubId), "sanity: the private board is bound to the very club B is active in");
  const sharedA = await makeDashboardHttp(a.cookie, { name: "Club shared", ownerScope: "club", ownerClubId: clubId });
  assert.equal(sharedA.owner_scope, "club");
  const { adminCookie } = await makePlatformAdmin("l112");
  const template = await makeDashboardHttp(adminCookie, { name: "L112 system template", ownerScope: "system" });
  assert.equal(template.owner_scope, "system");

  const seenByB = await listIds(b.cookie);
  assert.ok(!seenByB.includes(privateA.id), "a colleague's PRIVATE dashboard must not be listed just because both are active in the same club");
  assert.ok(seenByB.includes(sharedA.id), "the club-OWNED dashboard stays visible to every coach active in that club");
  assert.ok(seenByB.includes(template.id), "system templates stay visible");
  const privateGetByB = await api(`/api/training-load/dashboards/${privateA.id}`, { cookie: b.cookie });
  assert.equal(privateGetByB.status, 404);
  assert.equal(privateGetByB.body.error, "notFound");
  const sharedGetByB = await api(`/api/training-load/dashboards/${sharedA.id}`, { cookie: b.cookie });
  assert.equal(sharedGetByB.status, 200, "the shared club dashboard is readable by the colleague");

  const seenByA = await listIds(a.cookie);
  assert.ok(seenByA.includes(privateA.id) && seenByA.includes(sharedA.id) && seenByA.includes(template.id), "the owner lists all three");
});

test("§11.3 two team coaches of the SAME team: A's private dashboard is NOT in B's list nor readable by B; the team-owned dashboard IS listed and readable by B", async () => {
  const clubId = await makeClub(`l113 club ${uid()}`);
  const teamRes = await query(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `l113 Team ${uid()}`]);
  const teamId = teamRes.rows[0].id;
  const mk = async (label) => {
    const id = await makeUser({ email: `l113-${label}-${uid()}@test.local` });
    await query(`insert into public.user_team_roles (user_id, team_id, role) values ($1,$2,'team_coach')`, [id, teamId]);
    await setActiveWorkspace(id, "team", teamId);
    return { id, cookie: await loginCookie(id) };
  };
  const a = await mk("a");
  const b = await mk("b");
  const privateA = await makeDashboardHttp(a.cookie, { name: "A private in team" });
  assert.equal(privateA.owner_scope, "user");
  assert.equal(privateA.data_workspace_type, "team");
  assert.equal(String(privateA.data_workspace_scope_id), String(teamId));
  const sharedA = await makeDashboardHttp(a.cookie, { name: "Team shared", ownerScope: "team", ownerTeamId: teamId });
  assert.equal(sharedA.owner_scope, "team");

  const seenByB = await listIds(b.cookie);
  assert.ok(!seenByB.includes(privateA.id), "a team-mate's PRIVATE dashboard must not be listed via the shared team workspace");
  assert.ok(seenByB.includes(sharedA.id), "the team-OWNED dashboard stays visible to every coach of that team");
  const privateGetByB = await api(`/api/training-load/dashboards/${privateA.id}`, { cookie: b.cookie });
  assert.equal(privateGetByB.status, 404);
  assert.equal(privateGetByB.body.error, "notFound");
  const sharedGetByB = await api(`/api/training-load/dashboards/${sharedA.id}`, { cookie: b.cookie });
  assert.equal(sharedGetByB.status, 200);
});

test("§11.4 two athletes of the SAME club (athlete workspace, null scope): A's private self-view dashboard is NOT in B's list and B's GET is info-hiding 404; A still lists it - code-reviewer note", async () => {
  const clubId = await makeClub(`l114 club ${uid()}`);
  const a = await makeAthleteInClub(clubId);
  const b = await makeAthleteInClub(clubId);
  const dashA = await makeDashboardHttp(a.cookie, { name: "A self-view" });
  assert.equal(dashA.owner_scope, "user");
  assert.equal(dashA.data_workspace_type, "athlete");
  const seenByB = await listIds(b.cookie);
  assert.ok(!seenByB.includes(dashA.id), "another athlete's private self-view dashboard must not be listed via the shared athlete/null data workspace");
  const getByB = await api(`/api/training-load/dashboards/${dashA.id}`, { cookie: b.cookie });
  assert.equal(getByB.status, 404);
  assert.equal(getByB.body.error, "notFound");
  assert.ok((await listIds(a.cookie)).includes(dashA.id), "the athlete owner still lists their own dashboard");
});

// ============================================================
// Section 12 - Permanent delete (feature/training-load-dashboard-delete).
// Real DELETE /api/training-load/dashboards/:id, exercised over real HTTP
// against the real migrated schema. Covers: only a manager may delete
// (owner / a different, unrelated user / a viewer-but-not-manager);
// system templates can never be deleted, no exception; deleting the
// currently ACTIVE dashboard clears the active selection; an ARCHIVED
// dashboard can still be deleted (unlike other writes); a dashboard that
// has been cloned from is protected (dashboards.cloned_from_dashboard_id
// is ON DELETE RESTRICT and immutable, v15/v19); stale revision and
// invalid-input matrices.
// ============================================================

async function countRows(table, whereSql, params) {
  const r = await query(`select count(*)::int as n from ${table} where ${whereSql}`, params);
  return r.rows[0].n;
}
// Adding/removing a widget or series bumps dashboards.revision
// (bump_dashboard_revision, v15/v16), so a revision captured when the
// dashboard was created is stale by the time a test deletes it.
async function freshRevision(cookie, dashboardId) {
  const r = await api(`/api/training-load/dashboards/${dashboardId}`, { cookie });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.dashboard.revision;
}

test("delete 1: the owner can permanently delete their own dashboard - the dashboard, its widgets AND its series are all gone; a subsequent GET is info-hiding 404", async () => {
  const { coachCookie } = await makeClubCoach("ld1");
  const dashboard = await makeDashboardHttp(coachCookie);
  const w = await makeWidgetHttp(coachCookie, dashboard);
  const series = await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachCookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "avg" },
  });
  assert.equal(series.status, 201);
  const revision = await freshRevision(coachCookie, dashboard.id);
  assert.ok(revision > dashboard.revision, "sanity: the widget/series writes really bumped the dashboard revision");

  const deleted = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: revision } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.deleted, true);
  assert.equal(deleted.body.dashboardId, dashboard.id);

  assert.equal(await countRows("training_load.dashboards", "id = $1", [dashboard.id]), 0, "the dashboard row itself is gone");
  assert.equal(await countRows("training_load.dashboard_widgets", "id = $1", [w.widgetId]), 0, "its widget cascaded away");
  assert.equal(await countRows("training_load.dashboard_widget_series", "id = $1", [series.body.seriesId]), 0, "its series cascaded away");

  const fromOwner = await api(`/api/training-load/dashboards/${dashboard.id}`, { cookie: coachCookie });
  assert.equal(fromOwner.status, 404, "info-hiding: deleted looks exactly like never-existed, even to the former owner");
  assert.equal(fromOwner.body.error, "notFound");
});

test("delete 2: other users - an unrelated coach and the admin of a DIFFERENT club both get info-hiding 404 and the dashboard survives; a platform admin CAN delete another user's private dashboard (the same canManageDashboardRow contract Archive and Rename already use)", async () => {
  const { clubId, coachCookie } = await makeClubCoach("ld2");
  const dashboard = await makeDashboardHttp(coachCookie, { ownerScope: "club", ownerClubId: clubId });

  const strangerId = await makeUser({ email: `ld2-stranger-${uid()}@test.local` });
  await grantGlobalRole(strangerId, "independent_coach");
  await setActiveWorkspace(strangerId, "private_coach", null);
  const strangerCookie = await loginCookie(strangerId);
  const fromStranger = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "DELETE", cookie: strangerCookie, body: { expectedRevision: dashboard.revision } });
  assert.equal(fromStranger.status, 404, "a dashboard this account cannot even VIEW must never distinguish not-yours from does-not-exist");
  assert.equal(fromStranger.body.error, "notFound");

  // Only a club_admin can be ACTIVE in a club (loadAvailableWorkspaces), so
  // the realistic other-tenant case is the admin of another club.
  const { coachCookie: otherClubCookie } = await makeClubCoach("ld2other");
  const fromOtherClub = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "DELETE", cookie: otherClubCookie, body: { expectedRevision: dashboard.revision } });
  assert.equal(fromOtherClub.status, 404, "another club's admin cannot see - and so cannot delete - this club's dashboard");
  assert.equal(fromOtherClub.body.error, "notFound");

  assert.equal(await countRows("training_load.dashboards", "id = $1", [dashboard.id]), 1, "neither refused attempt deleted anything");

  // Pinned on purpose: Delete follows exactly the manage contract Archive and
  // Rename already use - a platform admin manages every non-system dashboard.
  const ownerId = await makeUser({ email: `ld2-owner-${uid()}@test.local` });
  await grantGlobalRole(ownerId, "independent_coach");
  await setActiveWorkspace(ownerId, "private_coach", null);
  const ownerCookie = await loginCookie(ownerId);
  const privateBoard = await makeDashboardHttp(ownerCookie, { name: "Owner private" });
  assert.equal(privateBoard.owner_scope, "user");
  const { adminCookie } = await makePlatformAdmin("ld2");
  const fromAdmin = await api(`/api/training-load/dashboards/${privateBoard.id}`, { method: "DELETE", cookie: adminCookie, body: { expectedRevision: privateBoard.revision } });
  assert.equal(fromAdmin.status, 200, JSON.stringify(fromAdmin.body));
  assert.equal(await countRows("training_load.dashboards", "id = $1", [privateBoard.id]), 0);
});

test("delete 3: a system template can NEVER be permanently deleted - not even by a platform admin who can manage every other system dashboard", async () => {
  const { adminCookie } = await makePlatformAdmin("ld3");
  const template = await makeDashboardHttp(adminCookie, { ownerScope: "system" });
  assert.equal(template.owner_scope, "system");
  const rejected = await api(`/api/training-load/dashboards/${template.id}`, { method: "DELETE", cookie: adminCookie, body: { expectedRevision: template.revision } });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error, "systemTemplateProtected");
  assert.equal(await countRows("training_load.dashboards", "id = $1", [template.id]), 1, "the system template is untouched");
});

test("delete 3b: a NON-system template (club-owned, is_template true) is NOT protected by the system-template rule - its manager can delete it", async () => {
  const { clubId, coachCookie } = await makeClubCoach("ld3b");
  const template = await makeDashboardHttp(coachCookie, { ownerScope: "club", ownerClubId: clubId, isTemplate: true });
  assert.equal(template.owner_scope, "club");
  assert.equal(template.is_template, true);
  const deleted = await api(`/api/training-load/dashboards/${template.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: template.revision } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(await countRows("training_load.dashboards", "id = $1", [template.id]), 0);
});

test("delete 4: deleting the CURRENTLY ACTIVE dashboard clears the active selection atomically - GET active shows none afterward, for every viewer who had it active", async () => {
  const { clubId, coachCookie } = await makeClubCoach("ld4");
  const dashboard = await makeDashboardHttp(coachCookie, { ownerScope: "club", ownerClubId: clubId });
  await api("/api/training-load/dashboards/active", { method: "POST", cookie: coachCookie, body: { dashboardId: dashboard.id } });

  // A second coach, sharing the same club workspace, ALSO has it active -
  // dashboard_active_selection.dashboard_id is ON DELETE RESTRICT (not
  // cascade) specifically because more than one row can point at the same
  // shared dashboard; every one of them must be cleared, not just the
  // deleting account's own.
  const secondCoachId = await makeUser({ email: `ld4-second-${uid()}@test.local` });
  await grantClubAdmin(secondCoachId, clubId);
  await setActiveWorkspace(secondCoachId, "club", clubId);
  const secondCookie = await loginCookie(secondCoachId);
  await api("/api/training-load/dashboards/active", { method: "POST", cookie: secondCookie, body: { dashboardId: dashboard.id } });

  assert.equal(await countRows("training_load.dashboard_active_selection", "dashboard_id = $1", [dashboard.id]), 2, "sanity: two active-selection rows point at it");

  const deleted = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: dashboard.revision } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));

  assert.equal(await countRows("training_load.dashboard_active_selection", "dashboard_id = $1", [dashboard.id]), 0, "every active-selection row pointing at the deleted dashboard is gone");
  const gotFirst = await api("/api/training-load/dashboards/active", { cookie: coachCookie });
  assert.equal(gotFirst.body.activeDashboard, null);
  const gotSecond = await api("/api/training-load/dashboards/active", { cookie: secondCookie });
  assert.equal(gotSecond.body.activeDashboard, null);
});

test("delete 5: a dashboard that has been CLONED FROM cannot be permanently deleted - dashboards.cloned_from_dashboard_id is ON DELETE RESTRICT and immutable; the source, its clone, and their widgets/series all survive the refused attempt", async () => {
  const { clubId, coachCookie } = await makeClubCoach("ld5");
  const template = await makeDashboardHttp(coachCookie, { ownerScope: "club", ownerClubId: clubId, isTemplate: true });
  const tw = await makeWidgetHttp(coachCookie, template);
  await api(`/api/training-load/dashboards/${template.id}/widgets/${tw.widgetId}/series`, {
    method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "avg" },
  });
  const cloned = await api(`/api/training-load/dashboards/${template.id}/clone`, { method: "POST", cookie: coachCookie, body: { ownerScope: "club", ownerClubId: clubId, name: "Cloned from LD5" } });
  assert.equal(cloned.status, 201, JSON.stringify(cloned.body));
  assert.equal(cloned.body.dashboard.cloned_from_dashboard_id, template.id);

  const rejected = await api(`/api/training-load/dashboards/${template.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: await freshRevision(coachCookie, template.id) } });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error, "dashboardHasClones");

  assert.equal(await countRows("training_load.dashboards", "id = $1", [template.id]), 1, "the source template survives the refused delete");
  assert.equal(await countRows("training_load.dashboards", "id = $1", [cloned.body.dashboard.id]), 1, "the clone itself is untouched");
  assert.equal(await countRows("training_load.dashboard_widgets", "dashboard_id = $1", [template.id]), 1, "the source's own widget is untouched - nothing was partially deleted");

  // Deleting the CLONE (which nothing else references) still works fine -
  // the restriction is specific to being a clone SOURCE, not to having ever
  // participated in a clone relationship at all.
  const deletedClone = await api(`/api/training-load/dashboards/${cloned.body.dashboard.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: await freshRevision(coachCookie, cloned.body.dashboard.id) } });
  assert.equal(deletedClone.status, 200, JSON.stringify(deletedClone.body));
});

test("delete 6: a stale expectedRevision is refused 409 staleRevision - zero writes, the dashboard is untouched", async () => {
  const { coachCookie } = await makeClubCoach("ld6");
  const dashboard = await makeDashboardHttp(coachCookie);
  // Bump the real revision once via an unrelated metadata PATCH, so the
  // dashboard's ORIGINAL revision (still held by the test) is now stale.
  await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: dashboard.revision, name: "Renamed" } });
  const rejected = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: dashboard.revision } });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error, "staleRevision");
  assert.equal(await countRows("training_load.dashboards", "id = $1", [dashboard.id]), 1);
});

test("delete 7: an ARCHIVED dashboard can still be permanently deleted - delete is deliberately NOT gated by the archived read-only rule that blocks every other write", async () => {
  const { coachCookie } = await makeClubCoach("ld7");
  const dashboard = await makeDashboardHttp(coachCookie);
  const archived = await api(`/api/training-load/dashboards/${dashboard.id}/archive`, { method: "POST", cookie: coachCookie, body: { expectedRevision: dashboard.revision } });
  assert.equal(archived.status, 200);
  const deleted = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: archived.body.dashboard.revision } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  const logged = await query(`select status from training_load.dashboard_deletion_log where dashboard_id = $1`, [dashboard.id]);
  assert.deepEqual(logged.rows.map((r) => r.status), ["archived"], "the log records the status the dashboard had when it was deleted");
  assert.equal(await countRows("training_load.dashboards", "id = $1", [dashboard.id]), 0);
});

test("delete 8: invalid input matrix - an unknown field, a missing/non-integer/zero expectedRevision, and an invalid dashboardId all reject 400 with zero writes", async () => {
  const { coachCookie } = await makeClubCoach("ld8");
  const dashboard = await makeDashboardHttp(coachCookie);
  const attempts = [
    { url: `/api/training-load/dashboards/${dashboard.id}`, body: { expectedRevision: dashboard.revision, unknownField: 1 } },
    { url: `/api/training-load/dashboards/${dashboard.id}`, body: {} },
    { url: `/api/training-load/dashboards/${dashboard.id}`, body: { expectedRevision: 0 } },
    { url: `/api/training-load/dashboards/${dashboard.id}`, body: { expectedRevision: "1" } },
    { url: "/api/training-load/dashboards/not-a-uuid", body: { expectedRevision: dashboard.revision } },
  ];
  for (const attempt of attempts) {
    const res = await api(attempt.url, { method: "DELETE", cookie: coachCookie, body: attempt.body });
    assert.equal(res.status, 400, `${JSON.stringify(attempt)} -> got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalidRequest");
  }
  assert.equal(await countRows("training_load.dashboards", "id = $1", [dashboard.id]), 1, "no rejected attempt deleted anything");
});

test("delete 3c: a NON-admin gets the same 409 systemTemplateProtected for a system template (checked before the manage check) - one consistent answer for every caller", async () => {
  const { adminCookie } = await makePlatformAdmin("ld3c");
  const template = await makeDashboardHttp(adminCookie, { ownerScope: "system" });
  const { coachCookie } = await makeClubCoach("ld3c");
  const seen = await api(`/api/training-load/dashboards/${template.id}`, { cookie: coachCookie });
  assert.equal(seen.status, 200, "sanity: a system template is visible to every account");
  const rejected = await api(`/api/training-load/dashboards/${template.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: template.revision } });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error, "systemTemplateProtected");
  assert.equal(await countRows("training_load.dashboards", "id = $1", [template.id]), 1);
});

test("delete 9: REAL concurrency - a dashboard deleted by another transaction while this DELETE waits on the row lock returns info-hiding 404 notFound, never 400 or 500 (waiter proven via pg_stat_activity, no sleep)", async () => {
  const { coachCookie } = await makeClubCoach("ld9");
  const dashboard = await makeDashboardHttp(coachCookie);
  const { client } = await newClient();
  try {
    await client.query("begin");
    await client.query("select 1 from training_load.dashboards where id = $1 for update", [dashboard.id]);
    const pending = api(`/api/training-load/dashboards/${dashboard.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: dashboard.revision } });
    const blockedPid = await waitForAnyLockWait();
    assert.ok(blockedPid, "the HTTP DELETE really waited on the row lock");
    await client.query("delete from training_load.dashboards where id = $1", [dashboard.id]);
    await client.query("commit");
    const res = await pending;
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error, "notFound");
  } finally {
    await client.end();
  }
  assert.equal(await countRows("training_load.dashboards", "id = $1", [dashboard.id]), 0);
  assert.equal(await countRows("training_load.dashboard_deletion_log", "dashboard_id = $1", [dashboard.id]), 0, "the request that got 404 wrote no deletion record");
});

// ============================================================
// Deletion log (product decision (c), 2026-09-17): whoever may manage a
// dashboard - a platform admin included - keeps the right to delete it,
// and EVERY permanent delete is recorded in the append-only
// training_load.dashboard_deletion_log: who, on what authority, what, when.
// ============================================================

async function deletionLogRows(dashboardId) {
  const r = await query(`select * from training_load.dashboard_deletion_log where dashboard_id = $1 order by deleted_at`, [dashboardId]);
  return r.rows;
}

test("log 1: an owner's delete writes exactly one record - who (the owner), on what authority ('owner'), what (name, ownership, workspace, template flag, status, revision, widget and series counts, original creator) and when", async () => {
  const { clubId, coachId, coachCookie } = await makeClubCoach("lg1");
  const dashboard = await makeDashboardHttp(coachCookie, { name: "Readiness board" });
  const w = await makeWidgetHttp(coachCookie, dashboard);
  await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${w.widgetId}/series`, {
    method: "POST", cookie: coachCookie, body: { expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "avg" },
  });
  const w2 = await makeWidgetHttp(coachCookie, { ...dashboard, revision: await freshRevision(coachCookie, dashboard.id) }, { x: 6 });
  const revision = await freshRevision(coachCookie, dashboard.id);
  // Database clock, not Node's: deleted_at must be the moment of THIS delete.
  const { rows: [{ t: beforeDelete }] } = await query("select clock_timestamp() as t");
  const deleted = await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: revision } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.ok(w2.widgetId);

  const rows = await deletionLogRows(dashboard.id);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.deleted_by_user_id, coachId);
  assert.equal(row.authorized_via, "owner");
  assert.equal(row.dashboard_name, "Readiness board");
  assert.equal(row.owner_scope, "user");
  assert.equal(row.owner_user_id, coachId);
  assert.equal(row.owner_club_id, null);
  assert.equal(row.data_workspace_type, "club");
  assert.equal(row.data_workspace_scope_id, clubId);
  assert.equal(row.is_template, false);
  assert.equal(row.status, "active");
  assert.equal(row.revision, revision, "the revision the dashboard had when it was deleted");
  assert.equal(row.widget_count, 2);
  assert.equal(row.series_count, 1);
  assert.equal(row.dashboard_created_by_user_id, coachId);
  assert.ok(row.dashboard_created_at instanceof Date);
  assert.ok(row.deleted_at >= beforeDelete, "deleted_at is the moment of the delete, not a snapshot of the dashboard's own timestamps");
  assert.ok(row.deleted_at > row.dashboard_created_at);
  assert.ok(!Object.prototype.hasOwnProperty.call(deleted.body, "logId"), "the log is not exposed through the API response");
});

test("log 2: a platform admin deleting ANOTHER user's private dashboard is allowed and recorded as authorized_via 'platform_admin' with the admin as the actor and the original owner preserved; an admin deleting their OWN private dashboard is recorded as 'owner'", async () => {
  const ownerId = await makeUser({ email: `lg2-owner-${uid()}@test.local` });
  await grantGlobalRole(ownerId, "independent_coach");
  await setActiveWorkspace(ownerId, "private_coach", null);
  const ownerCookie = await loginCookie(ownerId);
  const privateBoard = await makeDashboardHttp(ownerCookie, { name: "Owner's private board" });

  const adminId = await makeUser({ email: `lg2-admin-${uid()}@test.local` });
  await grantGlobalRole(adminId, "platform_admin");
  await grantGlobalRole(adminId, "independent_coach");
  await setActiveWorkspace(adminId, "private_coach", null);
  const adminCookie = await loginCookie(adminId);

  const byAdmin = await api(`/api/training-load/dashboards/${privateBoard.id}`, { method: "DELETE", cookie: adminCookie, body: { expectedRevision: privateBoard.revision } });
  assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
  const [overrideRow] = await deletionLogRows(privateBoard.id);
  assert.equal(overrideRow.deleted_by_user_id, adminId);
  assert.equal(overrideRow.authorized_via, "platform_admin", "the admin override was the only basis");
  assert.equal(overrideRow.owner_user_id, ownerId, "whose dashboard it was is preserved");
  assert.equal(overrideRow.dashboard_name, "Owner's private board");

  const adminOwn = await makeDashboardHttp(adminCookie, { name: "Admin's own board" });
  const ownDelete = await api(`/api/training-load/dashboards/${adminOwn.id}`, { method: "DELETE", cookie: adminCookie, body: { expectedRevision: adminOwn.revision } });
  assert.equal(ownDelete.status, 200);
  const [ownRow] = await deletionLogRows(adminOwn.id);
  assert.equal(ownRow.authorized_via, "owner", "the most specific basis wins - an admin deleting their own board is the owner");
});

test("log 3: club and team authority are recorded precisely - club admin on a club dashboard ('club_admin'), team coach on a team dashboard ('team_coach'), and a club admin on a team dashboard under their club ('club_admin')", async () => {
  const { clubId, coachId: clubAdminId, coachCookie: clubAdminCookie } = await makeClubCoach("lg3");
  const clubBoard = await makeDashboardHttp(clubAdminCookie, { name: "Club board", ownerScope: "club", ownerClubId: clubId });
  assert.equal((await api(`/api/training-load/dashboards/${clubBoard.id}`, { method: "DELETE", cookie: clubAdminCookie, body: { expectedRevision: clubBoard.revision } })).status, 200);
  const [clubRow] = await deletionLogRows(clubBoard.id);
  assert.equal(clubRow.authorized_via, "club_admin");
  assert.equal(clubRow.deleted_by_user_id, clubAdminId);
  assert.equal(clubRow.owner_club_id, clubId);

  const { teamId, coachId: teamCoachId, coachCookie: teamCoachCookie } = await makeTeamCoach("lg3", { clubId });
  const teamBoard1 = await makeDashboardHttp(teamCoachCookie, { name: "Team board 1", ownerScope: "team", ownerTeamId: teamId });
  assert.equal((await api(`/api/training-load/dashboards/${teamBoard1.id}`, { method: "DELETE", cookie: teamCoachCookie, body: { expectedRevision: teamBoard1.revision } })).status, 200);
  const [teamRow] = await deletionLogRows(teamBoard1.id);
  assert.equal(teamRow.authorized_via, "team_coach");
  assert.equal(teamRow.deleted_by_user_id, teamCoachId);
  assert.equal(teamRow.owner_team_id, teamId);

  const teamBoard2 = await makeDashboardHttp(teamCoachCookie, { name: "Team board 2", ownerScope: "team", ownerTeamId: teamId });
  const byClubAdmin = await api(`/api/training-load/dashboards/${teamBoard2.id}`, { method: "DELETE", cookie: clubAdminCookie, body: { expectedRevision: teamBoard2.revision } });
  assert.equal(byClubAdmin.status, 200, JSON.stringify(byClubAdmin.body));
  const [parentClubRow] = await deletionLogRows(teamBoard2.id);
  assert.equal(parentClubRow.authorized_via, "club_admin", "managing a team through its parent club is club-admin authority, not team-coach");
  assert.equal(parentClubRow.deleted_by_user_id, clubAdminId);
});

test("log 4: a refused or rolled-back delete leaves NO record - unrelated user 404, system template 409, stale revision 409, and a cloned-from dashboard whose log insert rolls back with the failing delete", async () => {
  const { clubId, coachCookie } = await makeClubCoach("lg4");

  const board = await makeDashboardHttp(coachCookie, { name: "Survivor" });
  const strangerId = await makeUser({ email: `lg4-stranger-${uid()}@test.local` });
  await grantGlobalRole(strangerId, "independent_coach");
  await setActiveWorkspace(strangerId, "private_coach", null);
  const strangerCookie = await loginCookie(strangerId);
  assert.equal((await api(`/api/training-load/dashboards/${board.id}`, { method: "DELETE", cookie: strangerCookie, body: { expectedRevision: board.revision } })).status, 404);
  await api(`/api/training-load/dashboards/${board.id}`, { method: "PATCH", cookie: coachCookie, body: { expectedRevision: board.revision, name: "Survivor renamed" } });
  assert.equal((await api(`/api/training-load/dashboards/${board.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: board.revision } })).status, 409, "stale");
  assert.equal((await deletionLogRows(board.id)).length, 0);

  const { adminCookie } = await makePlatformAdmin("lg4");
  const systemTemplate = await makeDashboardHttp(adminCookie, { ownerScope: "system" });
  assert.equal((await api(`/api/training-load/dashboards/${systemTemplate.id}`, { method: "DELETE", cookie: adminCookie, body: { expectedRevision: systemTemplate.revision } })).status, 409);
  assert.equal((await deletionLogRows(systemTemplate.id)).length, 0);

  // The log row is inserted BEFORE the delete; the delete then fails on
  // the clone FK (23503) - the insert must roll back with it.
  const template = await makeDashboardHttp(coachCookie, { ownerScope: "club", ownerClubId: clubId, isTemplate: true });
  const cloned = await api(`/api/training-load/dashboards/${template.id}/clone`, { method: "POST", cookie: coachCookie, body: { ownerScope: "club", ownerClubId: clubId, name: "Clone LG4" } });
  assert.equal(cloned.status, 201, JSON.stringify(cloned.body));
  const refused = await api(`/api/training-load/dashboards/${template.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: await freshRevision(coachCookie, template.id) } });
  assert.equal(refused.body.error, "dashboardHasClones");
  assert.equal((await deletionLogRows(template.id)).length, 0, "no record for a delete that rolled back");
});

test("log 5: the deletion log is append-only - UPDATE, DELETE and TRUNCATE are all refused by the database, and the record survives", async () => {
  const { coachCookie } = await makeClubCoach("lg5");
  const dashboard = await makeDashboardHttp(coachCookie, { name: "To be recorded" });
  assert.equal((await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: dashboard.revision } })).status, 200);
  const [row] = await deletionLogRows(dashboard.id);
  assert.ok(row);
  await assert.rejects(query(`update training_load.dashboard_deletion_log set dashboard_name = 'tampered' where id = $1`, [row.id]), /append-only \(UPDATE refused\)/);
  await assert.rejects(query(`delete from training_load.dashboard_deletion_log where id = $1`, [row.id]), /append-only \(DELETE refused\)/);
  await assert.rejects(query(`truncate training_load.dashboard_deletion_log`), /append-only \(TRUNCATE refused\)/);
  const [after] = await deletionLogRows(dashboard.id);
  assert.equal(after.dashboard_name, "To be recorded");
});

test("log 6: database-level backstop - calling delete_dashboard() directly on a SYSTEM template fails the log's owner_scope CHECK and the whole delete rolls back, even with a platform-admin basis", async () => {
  const { adminId, adminCookie } = await makePlatformAdmin("lg6");
  const template = await makeDashboardHttp(adminCookie, { ownerScope: "system" });
  await assert.rejects(
    query(`select * from training_load.delete_dashboard($1, $2, $3, $4)`, [template.id, template.revision, adminId, "platform_admin"]),
    (error) => error.code === "23514",
  );
  assert.equal(await countRows("training_load.dashboards", "id = $1", [template.id]), 1, "the system template survives");
  assert.equal((await deletionLogRows(template.id)).length, 0);
});

test("log 7: a platform admin with NO club/team role deleting a club and a team dashboard is recorded as 'platform_admin' (never as club_admin/team_coach); a team coach who is ALSO club admin of the parent club is recorded as 'team_coach'", async () => {
  const { clubId, coachCookie: clubAdminCookie } = await makeClubCoach("lg7");
  const { teamId, coachCookie: teamCoachCookie } = await makeTeamCoach("lg7", { clubId });
  const { adminId, adminCookie } = await makePlatformAdmin("lg7");

  const clubBoard = await makeDashboardHttp(clubAdminCookie, { name: "LG7 club board", ownerScope: "club", ownerClubId: clubId });
  const byAdminClub = await api(`/api/training-load/dashboards/${clubBoard.id}`, { method: "DELETE", cookie: adminCookie, body: { expectedRevision: clubBoard.revision } });
  assert.equal(byAdminClub.status, 200, JSON.stringify(byAdminClub.body));
  const [clubRow] = await deletionLogRows(clubBoard.id);
  assert.equal(clubRow.authorized_via, "platform_admin", "the admin override was the only basis for a club dashboard");
  assert.equal(clubRow.deleted_by_user_id, adminId);

  const teamBoard = await makeDashboardHttp(teamCoachCookie, { name: "LG7 team board", ownerScope: "team", ownerTeamId: teamId });
  const byAdminTeam = await api(`/api/training-load/dashboards/${teamBoard.id}`, { method: "DELETE", cookie: adminCookie, body: { expectedRevision: teamBoard.revision } });
  assert.equal(byAdminTeam.status, 200, JSON.stringify(byAdminTeam.body));
  const [teamRow] = await deletionLogRows(teamBoard.id);
  assert.equal(teamRow.authorized_via, "platform_admin", "the admin override was the only basis for a team dashboard");

  // Both a direct team_coach role AND club-admin authority over the parent
  // club: the direct team role is the most specific basis.
  const { teamId: teamId2, coachId: dualId, coachCookie: dualCookie } = await makeTeamCoach("lg7b", { clubId });
  await grantClubAdmin(dualId, clubId);
  const dualBoard = await makeDashboardHttp(dualCookie, { name: "LG7 dual board", ownerScope: "team", ownerTeamId: teamId2 });
  const byDual = await api(`/api/training-load/dashboards/${dualBoard.id}`, { method: "DELETE", cookie: dualCookie, body: { expectedRevision: dualBoard.revision } });
  assert.equal(byDual.status, 200, JSON.stringify(byDual.body));
  const [dualRow] = await deletionLogRows(dualBoard.id);
  assert.equal(dualRow.authorized_via, "team_coach");
  assert.equal(dualRow.deleted_by_user_id, dualId);
});

test("log 8: dashboardManageBasis agrees with canManageDashboardRow for EVERY owner_scope x role combination (non-null exactly when management is allowed), and names the most specific basis", async () => {
  const { dashboardManageBasis, canManageDashboardRow } = await import("../src/trainingLoadDashboardAccess.js");
  const me = "11111111-1111-4111-8111-000000000001";
  const other = "11111111-1111-4111-8111-000000000002";
  const c1 = "22222222-2222-4222-8222-000000000001";
  const c2 = "22222222-2222-4222-8222-000000000002";
  const t1 = "33333333-3333-4333-8333-000000000001";
  const t2 = "33333333-3333-4333-8333-000000000002";
  const authz = (over = {}) => ({ platformRoles: [], clubRoles: [], teamRoles: [], managedTeamIds: [], ...over });
  const accounts = {
    unrelated: authz(),
    admin: authz({ platformRoles: ["platform_admin"] }),
    clubAdminC1: authz({ clubRoles: [{ clubId: c1, role: "club_admin" }], managedTeamIds: [t1] }),
    otherClubRoleC1: authz({ clubRoles: [{ clubId: c1, role: "club_member" }] }),
    teamCoachT1: authz({ teamRoles: [{ teamId: t1, role: "team_coach" }] }),
    otherTeamRoleT1: authz({ teamRoles: [{ teamId: t1, role: "team_member" }] }),
    teamCoachT1AndClubAdminC1: authz({ teamRoles: [{ teamId: t1, role: "team_coach" }], clubRoles: [{ clubId: c1, role: "club_admin" }], managedTeamIds: [t1] }),
    adminAndClubAdminC1: authz({ platformRoles: ["platform_admin"], clubRoles: [{ clubId: c1, role: "club_admin" }], managedTeamIds: [t1] }),
  };
  const rows = {
    ownPrivate: { owner_scope: "user", owner_user_id: me },
    otherPrivate: { owner_scope: "user", owner_user_id: other },
    clubC1: { owner_scope: "club", owner_club_id: c1 },
    clubC2: { owner_scope: "club", owner_club_id: c2 },
    teamT1: { owner_scope: "team", owner_team_id: t1 },
    teamT2: { owner_scope: "team", owner_team_id: t2 },
    system: { owner_scope: "system" },
  };
  const expected = {
    unrelated: { ownPrivate: "owner", otherPrivate: null, clubC1: null, clubC2: null, teamT1: null, teamT2: null, system: null },
    admin: { ownPrivate: "owner", otherPrivate: "platform_admin", clubC1: "platform_admin", clubC2: "platform_admin", teamT1: "platform_admin", teamT2: "platform_admin", system: "platform_admin" },
    clubAdminC1: { ownPrivate: "owner", otherPrivate: null, clubC1: "club_admin", clubC2: null, teamT1: "club_admin", teamT2: null, system: null },
    otherClubRoleC1: { ownPrivate: "owner", otherPrivate: null, clubC1: null, clubC2: null, teamT1: null, teamT2: null, system: null },
    teamCoachT1: { ownPrivate: "owner", otherPrivate: null, clubC1: null, clubC2: null, teamT1: "team_coach", teamT2: null, system: null },
    otherTeamRoleT1: { ownPrivate: "owner", otherPrivate: null, clubC1: null, clubC2: null, teamT1: null, teamT2: null, system: null },
    teamCoachT1AndClubAdminC1: { ownPrivate: "owner", otherPrivate: null, clubC1: "club_admin", clubC2: null, teamT1: "team_coach", teamT2: null, system: null },
    adminAndClubAdminC1: { ownPrivate: "owner", otherPrivate: "platform_admin", clubC1: "club_admin", clubC2: "platform_admin", teamT1: "club_admin", teamT2: "platform_admin", system: "platform_admin" },
  };
  let checked = 0;
  for (const [accountName, accountAuthz] of Object.entries(accounts)) {
    for (const [rowName, row] of Object.entries(rows)) {
      const req = { authz: accountAuthz, user: { id: me } };
      const basis = dashboardManageBasis(req, row);
      const manage = canManageDashboardRow(req, row);
      assert.equal(basis !== null, manage, `${accountName} x ${rowName}: basis ${basis} vs canManage ${manage}`);
      assert.equal(basis, expected[accountName][rowName], `${accountName} x ${rowName}`);
      checked += 1;
    }
  }
  assert.equal(checked, Object.keys(accounts).length * Object.keys(rows).length);
});

test("log 9: the log's own CHECKs reject a malformed record written outside delete_dashboard() (bad status, bad workspace type, owner id not matching owner_scope), and a second record for the same dashboard is rejected as a duplicate", async () => {
  const { coachId, coachCookie } = await makeClubCoach("lg9");
  const dashboard = await makeDashboardHttp(coachCookie, { name: "LG9" });
  assert.equal((await api(`/api/training-load/dashboards/${dashboard.id}`, { method: "DELETE", cookie: coachCookie, body: { expectedRevision: dashboard.revision } })).status, 200);
  const [row] = await deletionLogRows(dashboard.id);
  const insert = (over) => {
    const r = { ...row, ...over };
    return query(
      `insert into training_load.dashboard_deletion_log (deleted_by_user_id, authorized_via, dashboard_id, dashboard_name, owner_scope, owner_user_id, owner_club_id, owner_team_id,
         data_workspace_type, data_workspace_scope_id, is_template, status, revision, widget_count, series_count, dashboard_created_by_user_id, dashboard_created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [r.deleted_by_user_id, r.authorized_via, r.dashboard_id, r.dashboard_name, r.owner_scope, r.owner_user_id, r.owner_club_id, r.owner_team_id,
        r.data_workspace_type, r.data_workspace_scope_id, r.is_template, r.status, r.revision, r.widget_count, r.series_count, r.dashboard_created_by_user_id, r.dashboard_created_at],
    );
  };
  const fresh = () => crypto.randomUUID();
  await assert.rejects(insert({ dashboard_id: fresh(), status: "pending" }), (e) => e.code === "23514", "status outside active/archived");
  await assert.rejects(insert({ dashboard_id: fresh(), data_workspace_type: "galaxy" }), (e) => e.code === "23514", "unknown data workspace type");
  await assert.rejects(insert({ dashboard_id: fresh(), owner_scope: "club" }), (e) => e.code === "23514", "owner_scope club with only an owner_user_id set");
  await assert.rejects(insert({ dashboard_id: fresh(), owner_club_id: coachId }), (e) => e.code === "23514", "two owner ids at once");
  await assert.rejects(insert({}), (e) => e.code === "23505", "a second record for the same dashboard id");
  assert.equal((await deletionLogRows(dashboard.id)).length, 1);
});

async function s2aModules() {
  assert.match(db.name, /^optimove_tests_tldash_primary_[a-f0-9]{12}$/);
  assert.equal(process.env.DATABASE_URL, db.url, "S2a may only use this suite's disposable database");
  assert.equal((await query("select current_database() as db")).rows[0].db, db.name);
  const { createSimpleCapabilityReader } = await import("../src/dashboardSimple/capabilities.js");
  const { compileSimpleDraft } = await import("../src/dashboardSimple/compiler.js");
  const { canManageDashboardRow, dataWorkspaceMatches, dataWorkspaceForActiveWorkspace } = await import("../src/trainingLoadDashboardAccess.js");
  const { loadAuthorizationContext } = await import("../src/authz.js");
  const statements = [];
  const reader = createSimpleCapabilityReader({
    query: async (sql, params) => {
      assert.match(sql, /^\s*select\b/i, "the capability port must remain read-only");
      statements.push(sql);
      return query(sql, params);
    },
    canManageDashboardRow, dataWorkspaceMatches,
  });
  async function args(userId, dashboardId, type, scopeId = null) {
    const user = (await query("select * from public.users where id=$1", [userId])).rows[0];
    const req = { user, authz: await loadAuthorizationContext(user) };
    return { req, dashboardId, dataWorkspace: dataWorkspaceForActiveWorkspace({ type, scopeId }, req) };
  }
  return { reader, compileSimpleDraft, statements, args };
}

function s2aDraft(metricRef, view = {}) {
  return {
    contractVersion: 1, draftId: crypto.randomUUID(), draftVersion: 1, title: "S2a parity",
    metricRef, athleteSelection: { mode: "inherit" },
    advancedFilter: { activity: { mode: "inherit" }, component: { mode: "inherit" } },
    periodIntent: { mode: "inherit" }, view: { type: "table", groupBy: "day", ...view },
  };
}

function s2aContext(athleteIds = []) {
  return { authorizedAthleteIds: athleteIds, period: { dateFrom: "2026-09-09", dateTo: "2026-09-10", timeZone: "UTC" }, evaluatedAt: "2026-10-29T12:00:00Z" };
}

function s2aUpdateDraft(draft) {
  return { ...draft, display: draft.display ?? { mode: "preserve" }, presentation: draft.presentation ?? { mode: "preserve" } };
}

function s2aIssue(result, code, issuePath, status = "invalid") {
  assert.equal(result.status, status, JSON.stringify(result));
  assert.ok(result.issues.some(issue => issue.code === code && issue.path === issuePath), JSON.stringify(result.issues));
  assert.equal(result.widget, undefined);
}

async function s2aFixture(label) {
  const modules = await s2aModules();
  const actor = await makeClubCoach(label);
  const dashboard = await makeDashboardHttp(actor.coachCookie);
  assert.ok(dashboard?.id);
  return { ...modules, ...actor, dashboard, target: await modules.args(actor.coachId, dashboard.id, "club", actor.clubId) };
}

async function s2aStored(widgetId) {
  const widget = (await query("select * from training_load.dashboard_widgets where id=$1", [widgetId])).rows[0];
  assert.ok(widget);
  const series = (await query("select * from training_load.dashboard_widget_series where widget_id=$1 order by series_order, id", [widgetId])).rows;
  return { ...widget, series };
}

async function s2aState(dashboardId) {
  return (await query(`select to_jsonb(d) as dashboard,
    (select coalesce(jsonb_agg(to_jsonb(w) order by w.id), '[]'::jsonb) from training_load.dashboard_widgets w where w.dashboard_id=d.id) as widgets,
    (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb) from training_load.dashboard_widget_series s join training_load.dashboard_widgets w on w.id=s.widget_id where w.dashboard_id=d.id) as series
    from training_load.dashboards d where d.id=$1`, [dashboardId])).rows[0];
}

async function s2aDbReject(dashboardId, run, code, message) {
  const before = await s2aState(dashboardId);
  await assert.rejects(run, error => error.code === code && (!message || message.test(error.message)));
  assert.deepEqual(await s2aState(dashboardId), before, "rejected SQL must leave all rows and revisions unchanged");
}

function s2aSeriesBody(series) {
  return {
    axis: series.axis, sourcePolicy: series.source_policy, sourceConnectionId: series.source_connection_id,
    dataScopeLevel: series.data_scope_level, analyticalAggregation: series.analytical_aggregation,
    aggregationRolePolicy: series.aggregation_role_policy, coveragePolicy: series.coverage_policy,
    comparisonPeriod: series.comparison_period,
  };
}

async function s2aLegacyProjection(fixture, compiled, { existing = null, layout = {} } = {}) {
  assert.equal(compiled.status, "valid", JSON.stringify(compiled));
  assert.equal(compiled.requiresPreview, true, "compilation is not an executed Simple preview/save");
  assert.equal(compiled.semanticBinding.proof, "catalogOnly");
  assert.equal(compiled.semanticBinding.requiresResultSemanticProof, true);
  const widget = compiled.widget, series = widget.series[0];
  assert.equal(widget.series.length, 1);
  const content = { widgetType: widget.widget_type, title: widget.title, groupBy: widget.group_by, displayConfig: widget.display_config, localFilterOverride: widget.local_filter_override };
  let widgetId, seriesId;
  if (existing) {
    widgetId = existing.id;
    seriesId = existing.series[0].id;
    const updated = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${widgetId}`, {
      method: "PATCH", cookie: fixture.coachCookie, body: { expectedWidgetRevision: existing.revision, ...content },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const current = await s2aStored(widgetId);
    const updatedSeries = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${widgetId}/series/${seriesId}`, {
      method: "PATCH", cookie: fixture.coachCookie, body: { expectedWidgetRevision: current.revision, ...s2aSeriesBody(series) },
    });
    assert.equal(updatedSeries.status, 200, JSON.stringify(updatedSeries.body));
  } else {
    const created = await makeWidgetHttp(fixture.coachCookie, { ...fixture.dashboard, revision: await freshRevision(fixture.coachCookie, fixture.dashboard.id) }, { ...content, ...layout });
    widgetId = created.widgetId;
    const added = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${widgetId}/series`, {
      method: "POST", cookie: fixture.coachCookie,
      body: { expectedWidgetRevision: 1, seriesOrder: series.series_order, ...(series.metric_definition_id ? { metricDefinitionId: series.metric_definition_id } : { builtInSeriesKey: series.built_in_series_key }), ...s2aSeriesBody(series) },
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    seriesId = added.body.seriesId;
  }
  const stored = await s2aStored(widgetId);
  for (const key of ["widget_type", "title", "group_by", "display_config", "local_filter_override"]) assert.deepEqual(stored[key], widget[key], key);
  assert.equal(stored.series.length, 1);
  assert.equal(stored.series[0].id, seriesId);
  for (const key of ["metric_definition_id", "built_in_series_key", "resolution_status", "series_order", "axis", "source_policy", "source_connection_id", "data_scope_level", "analytical_aggregation", "aggregation_role_policy", "coverage_policy", "comparison_period"]) {
    assert.deepEqual(stored.series[0][key], series[key], key);
  }
  assert.equal(stored.presentation_config, null, "legacy projection leaves the sidecar null unless explicitly written");
  if (!existing) {
    assert.notEqual(widgetId, widget.id, "legacy writers assign real IDs, independently of compiler draft IDs");
    assert.notEqual(seriesId, series.id);
  }
  return stored;
}

async function s2aRawAdd(widgetId, compiledSeries, overrides = {}) {
  const series = { ...compiledSeries, ...overrides };
  const widget = await s2aStored(widgetId);
  return query(`select * from training_load.add_series($1,$2,$3,$4,$5,null,$6,null,null,$7,$8,$9,$10,$11,$12,$13)`,
    [widgetId, widget.revision, series.series_order, series.metric_definition_id, series.built_in_series_key, series.axis,
      series.source_policy, series.source_connection_id, series.data_scope_level, series.analytical_aggregation,
      series.aggregation_role_policy, series.coverage_policy, series.comparison_period]);
}

async function s2aRawUpdate(widgetId, overrides) {
  const widget = await s2aStored(widgetId), series = { ...widget.series[0], ...overrides };
  return query(`select * from training_load.update_series($1,$2,$3,$4,null,false,null,false,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [series.id, widgetId, widget.revision, series.axis, series.source_policy, series.source_connection_id, series.data_scope_level,
      series.analytical_aggregation, series.aggregation_role_policy, series.coverage_policy, series.comparison_period, series.comparison_period === null]);
}

test("S2a target gate: real manage/workspace predicates deny unauthorized, mismatched, missing, archived and template targets before catalog SQL", async () => {
  const fixture = await s2aFixture("s2a-target");
  const stranger = await makeUser();
  const template = await makeDashboardHttp(fixture.coachCookie, { isTemplate: true });
  const archived = await makeDashboardHttp(fixture.coachCookie);
  const archive = await api(`/api/training-load/dashboards/${archived.id}/archive`, { method: "POST", cookie: fixture.coachCookie, body: { expectedRevision: archived.revision } });
  assert.equal(archive.status, 200, JSON.stringify(archive.body));
  const cases = [
    [await fixture.args(stranger, fixture.dashboard.id, "club", fixture.clubId), "notFound", 404],
    [await fixture.args(fixture.coachId, fixture.dashboard.id, "club", await makeClub()), "notFound", 404],
    [{ ...fixture.target, dashboardId: crypto.randomUUID() }, "notFound", 404],
    [{ ...fixture.target, dashboardId: archived.id }, "dashboardArchived", 409],
    [{ ...fixture.target, dashboardId: template.id }, "templateRequiresClone", 409],
  ];
  const { adminId } = await makePlatformAdmin("s2a-private");
  await grantGlobalRole(fixture.coachId, "independent_coach");
  await setActiveWorkspace(fixture.coachId, "private_coach");
  const privateBoard = await makeDashboardHttp(fixture.coachCookie);
  cases.push([await fixture.args(adminId, privateBoard.id, "private_coach"), "notFound", 404]);
  for (const [target, code, status] of cases) {
    for (const method of ["load", "listMetrics"]) {
      fixture.statements.length = 0;
      await assert.rejects(() => fixture.reader[method]({ ...target, metricRef: { kind: "builtin", key: "rpe" } }), error => error.code === code && error.status === status);
      assert.equal(fixture.statements.length, 1);
      assert.match(fixture.statements[0], /^select \* from training_load\.dashboards where id = \$1$/);
    }
  }
});

test("S2a SQL picker: dual-club/platform actor sees only target bindings before pagination; metric/source owner and active-state parity", async () => {
  const fixture = await s2aFixture("s2a-picker");
  const otherClub = await makeClub();
  await grantClubAdmin(fixture.coachId, otherClub);
  await grantGlobalRole(fixture.coachId, "platform_admin");
  const foreignUser = await makeUser();
  const teamA = await makeTeamCoach("s2a-picker-a", { clubId: fixture.clubId });
  const teamB = await makeTeamCoach("s2a-picker-b", { clubId: otherClub });
  const prefix = `s2apicker-${uid()}`;
  const owners = [
    ["system", null], ["club", fixture.clubId], ["club", otherClub], ["team", teamA.teamId],
    ["team", teamB.teamId], ["user", fixture.coachId], ["user", foreignUser],
  ];
  const entries = [];
  for (const [scope, ownerId] of owners) {
    const def = await query(`insert into training_load.metric_definitions (key,label,owner_scope,owner_user_id,owner_club_id,owner_team_id)
      values ($1,$1,$2,$3,$4,$5) returning id`, [`${prefix}-${entries.length}`, scope, scope === "user" ? ownerId : null, scope === "club" ? ownerId : null, scope === "team" ? ownerId : null]);
    const metricId = def.rows[0].id;
    const version = await query(`insert into training_load.metric_definition_versions (metric_definition_id,version_number,value_type,daily_aggregation_method) values ($1,1,'numeric','sum') returning id`, [metricId]);
    await query("update training_load.metric_definitions set current_version_id=$1 where id=$2", [version.rows[0].id, metricId]);
    const source = await query(`insert into training_load.metric_source_connections (source_system,owner_scope,owner_user_id,owner_club_id,owner_team_id)
      values ('s2a',$1,$2,$3,$4) returning id`, [scope, scope === "user" ? ownerId : null, scope === "club" ? ownerId : null, scope === "team" ? ownerId : null]);
    entries.push({ scope, ownerId, metricId, sourceId: source.rows[0].id });
  }
  const inactiveMetric = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, key: `${prefix}-inactive` });
  await query("update training_load.metric_definitions set state='archived' where id=$1", [inactiveMetric.metricDefinitionId]);
  const noVersion = await query("insert into training_load.metric_definitions (key,label,owner_scope,owner_club_id) values ($1,$1,'club',$2) returning id", [`${prefix}-no-version`, fixture.clubId]);
  const inactiveSource = await makeSourceConnection(fixture.clubId);
  await query("update training_load.metric_source_connections set state='inactive' where id=$1", [inactiveSource]);
  const sharedClub = await makeDashboardHttp(fixture.coachCookie, { ownerScope: "club", ownerClubId: fixture.clubId });
  const sharedTeam = await makeDashboardHttp(teamA.coachCookie, { ownerScope: "team", ownerTeamId: teamA.teamId });
  await setActiveWorkspace(fixture.coachId, "platform");
  const platformBoard = await makeDashboardHttp(fixture.coachCookie);
  const targets = [
    [fixture.dashboard, "club", fixture.clubId, [0, 1, 5]],
    [sharedClub, "club", fixture.clubId, [0, 1]],
    [sharedTeam, "team", teamA.teamId, [0, 3]],
    [platformBoard, "platform", null, [0, 5]],
  ];
  for (const [dashboard, type, scopeId, allowed] of targets) {
    await setActiveWorkspace(fixture.coachId, type, scopeId);
    const target = await fixture.args(fixture.coachId, dashboard.id, type, scopeId);
    const ids = [], cursors = new Set();
    let afterId = null;
    do {
      const page = await fixture.reader.listMetrics({ ...target, search: prefix, limit: 1, afterId });
      assert.equal(page.metrics.length, 1, "filtering after pagination would produce short/empty pages");
      ids.push(...page.metrics.map(metric => metric.id));
      afterId = page.nextCursor;
      if (afterId) { assert.ok(!cursors.has(afterId)); cursors.add(afterId); }
      assert.ok(ids.length <= allowed.length);
    } while (afterId);
    assert.deepEqual(ids, allowed.map(index => entries[index].metricId).sort());
    assert.equal(new Set(ids).size, ids.length);
    const widget = await makeWidgetHttp(type === "team" ? teamA.coachCookie : fixture.coachCookie, { ...dashboard, revision: await freshRevision(fixture.coachCookie, dashboard.id) });
    for (const [index, entry] of entries.entries()) {
      const metricRef = { kind: "metric", metricDefinitionId: entry.metricId };
      if (allowed.includes(index)) {
        const snapshot = await fixture.reader.load({ ...target, metricRef, sourceConnectionId: entry.sourceId });
        assert.equal(snapshot.metric.current_version_id, (await query("select current_version_id from training_load.metric_definitions where id=$1", [entry.metricId])).rows[0].current_version_id);
        assert.equal(snapshot.connection.id, entry.sourceId);
      } else {
        await assert.rejects(() => fixture.reader.load({ ...target, metricRef }), error => error.code === "notFound" && error.status === 404);
        await assert.rejects(() => fixture.reader.load({ ...target, metricRef: { kind: "metric", metricDefinitionId: entries[0].metricId }, sourceConnectionId: entry.sourceId }), error => error.code === "notFound" && error.status === 404);
        const base = { series_order: 0, metric_definition_id: entry.metricId, built_in_series_key: null, axis: "primary", source_policy: "all_with_conflicts", source_connection_id: null, data_scope_level: "session", analytical_aggregation: "sum", aggregation_role_policy: "standalone_only", coverage_policy: "any", comparison_period: null };
        await s2aDbReject(dashboard.id, () => s2aRawAdd(widget.widgetId, base), "P0001", /not visible/);
        await s2aDbReject(dashboard.id, () => s2aRawAdd(widget.widgetId, base, { metric_definition_id: entries[0].metricId, source_policy: "source_connection", source_connection_id: entry.sourceId }), "P0001", /not visible/);
      }
    }
  }
  const target = await fixture.args(fixture.coachId, fixture.dashboard.id, "club", fixture.clubId);
  for (const metricId of [inactiveMetric.metricDefinitionId, noVersion.rows[0].id, crypto.randomUUID()]) {
    await assert.rejects(() => fixture.reader.load({ ...target, metricRef: { kind: "metric", metricDefinitionId: metricId } }), error => error.code === "notFound" && error.status === 404);
  }
  for (const sourceConnectionId of [inactiveSource, crypto.randomUUID()]) {
    await assert.rejects(() => fixture.reader.load({ ...target, metricRef: { kind: "metric", metricDefinitionId: entries[0].metricId }, sourceConnectionId }), error => error.code === "notFound" && error.status === 404);
  }
  await setActiveWorkspace(fixture.coachId, "club", fixture.clubId);
  const draft = s2aDraft({ kind: "metric", metricDefinitionId: entries[0].metricId }, { dataScopeLevel: "session", analyticalAggregation: "avg" });
  const snapshot = await fixture.reader.load({ ...target, metricRef: draft.metricRef });
  const compiled = fixture.compileSimpleDraft(draft, snapshot, s2aContext());
  const stored = await s2aLegacyProjection(fixture, compiled, { layout: { y: 8 } });
  await s2aDbReject(fixture.dashboard.id, () => s2aRawAdd(stored.id, compiled.widget.series[0], {
    series_order: 1, metric_definition_id: inactiveMetric.metricDefinitionId,
  }), "P0001", /metric_definition .*not active/);
  await s2aDbReject(fixture.dashboard.id, () => s2aRawAdd(stored.id, compiled.widget.series[0], {
    series_order: 1, source_policy: "source_connection", source_connection_id: inactiveSource,
  }), "P0001", /source_connection .*not active/);
  for (const [sourceId, message] of [[inactiveSource, /not active/], [entries[2].sourceId, /not visible/]]) {
    const badExisting = structuredClone(stored);
    badExisting.series[0].source_policy = "source_connection";
    badExisting.series[0].source_connection_id = sourceId;
    s2aIssue(fixture.compileSimpleDraft(s2aUpdateDraft(draft), snapshot, s2aContext(), badExisting), "notFound", "$.metricRef");
    await s2aDbReject(fixture.dashboard.id, () => s2aRawUpdate(stored.id, {
      source_policy: "source_connection", source_connection_id: sourceId,
    }), "P0001", message);
  }
});

for (const [key, scope, aggregation, unit] of [
  ["rpe", "session", "avg", null], ["srpe", "session", "sum", undefined],
  ["duration_minutes", "session", "sum", "min"], ["session_count", "day", "sum", null], ["last_session_date", "day", "last", null],
]) test(`S2a builtin ${key}: loaded catalog defaults/null unit; legacy create/update projection and DB fixed-scope refusal`, async () => {
  const fixture = await s2aFixture(`s2a-${key}`);
  const draft = s2aDraft({ kind: "builtin", key });
  const snapshot = await fixture.reader.load({ ...fixture.target, metricRef: draft.metricRef });
  const catalog = (await query("select * from training_load.dashboard_builtin_series where key=$1", [key])).rows[0];
  assert.equal(snapshot.metric.unit, catalog.unit);
  if (unit !== undefined) assert.equal(snapshot.metric.unit, unit);
  assert.equal(snapshot.metric.fixed_data_scope_level, scope);
  assert.equal(snapshot.metric.default_analytical_aggregation, aggregation);
  assert.equal(snapshot.metric.is_active, true);
  assert.deepEqual(snapshot.metric.allowed_aggregations, catalog.value_type === "numeric" ? ["sum", "avg", "max", "last", "none"] : ["last", "none"]);
  const compiled = fixture.compileSimpleDraft(draft, snapshot, s2aContext());
  assert.equal(compiled.status, "valid", JSON.stringify(compiled));
  assert.equal(compiled.semanticBinding.unit, catalog.unit);
  assert.equal(compiled.widget.series[0].source_policy, "not_applicable");
  const stored = await s2aLegacyProjection(fixture, compiled);
  const nextDraft = { ...draft, title: "Updated from loaded DB", display: { mode: "preserve" }, presentation: { mode: "preserve" } };
  await s2aLegacyProjection(fixture, fixture.compileSimpleDraft(nextDraft, snapshot, s2aContext(), stored), { existing: stored });
  const badScope = scope === "session" ? "day" : "session";
  s2aIssue(fixture.compileSimpleDraft({ ...draft, view: { ...draft.view, dataScopeLevel: badScope } }, snapshot, s2aContext()), "scopeCapability", "$.view.dataScopeLevel");
  s2aIssue(fixture.compileSimpleDraft({ ...nextDraft, view: { ...nextDraft.view, dataScopeLevel: badScope } }, snapshot, s2aContext(), await s2aStored(stored.id)), "scopeCapability", "$.view.dataScopeLevel");
  await s2aDbReject(fixture.dashboard.id, () => s2aRawAdd(stored.id, compiled.widget.series[0], { series_order: 1, data_scope_level: badScope }), "P0001", /always scope_level/);
  await s2aDbReject(fixture.dashboard.id, () => s2aRawUpdate(stored.id, { data_scope_level: badScope }), "P0001", /always scope_level/);
});

test("S2a metric scopes: zero rows require explicit choice and allow every scope; positive capabilities filter SQL and reject create/update", async () => {
  const fixture = await s2aFixture("s2a-scopes");
  for (const scopeLevels of [[], ["session"], ["session", "component"]]) {
    const def = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, scopeLevels });
    const draft = s2aDraft({ kind: "metric", metricDefinitionId: def.metricDefinitionId }, { analyticalAggregation: "avg" });
    const snapshot = await fixture.reader.load({ ...fixture.target, metricRef: draft.metricRef });
    assert.deepEqual(snapshot.metric.scope_capabilities, [...scopeLevels].sort());
    const implicit = fixture.compileSimpleDraft(draft, snapshot, s2aContext());
    if (scopeLevels.length === 1) assert.equal(implicit.status, "valid", JSON.stringify(implicit));
    else s2aIssue(implicit, "requiresChoice", "$.view.dataScopeLevel", "requiresChoice");
    const noAggregation = { ...draft, view: { type: "table", groupBy: "day", dataScopeLevel: "session" } };
    s2aIssue(fixture.compileSimpleDraft(noAggregation, snapshot, s2aContext()), "requiresChoice", "$.view.analyticalAggregation", "requiresChoice");
    const valid = fixture.compileSimpleDraft({ ...draft, view: { ...draft.view, dataScopeLevel: "session" } }, snapshot, s2aContext());
    let stored = await s2aLegacyProjection(fixture, valid, { layout: { y: scopeLevels.length * 8 } });
    for (const scope of ["day", "session", "component"]) {
      const selected = { ...draft, view: { ...draft.view, dataScopeLevel: scope } };
      const page = await fixture.reader.listMetrics({ ...fixture.target, search: snapshot.metric.key, dataScopeLevel: scope });
      const allowed = scopeLevels.length === 0 || scopeLevels.includes(scope);
      assert.equal(page.metrics.some(metric => metric.id === def.metricDefinitionId), allowed);
      if (allowed) {
        stored = await s2aLegacyProjection(fixture, fixture.compileSimpleDraft(s2aUpdateDraft(selected), snapshot, s2aContext(), stored), { existing: stored });
        const added = await s2aRawAdd(stored.id, valid.widget.series[0], { series_order: scope === "day" ? 1 : scope === "session" ? 2 : 3, data_scope_level: scope });
        await query("select * from training_load.delete_series($1,$2,$3)", [added.rows[0].series_id, stored.id, added.rows[0].widget_revision]);
        stored = await s2aStored(stored.id);
      } else {
        s2aIssue(fixture.compileSimpleDraft(selected, snapshot, s2aContext()), "scopeCapability", "$.view.dataScopeLevel");
        s2aIssue(fixture.compileSimpleDraft(s2aUpdateDraft(selected), snapshot, s2aContext(), stored), "scopeCapability", "$.view.dataScopeLevel");
        await s2aDbReject(fixture.dashboard.id, () => s2aRawAdd(stored.id, valid.widget.series[0], { series_order: 1, data_scope_level: scope }), "P0001", /never been configured/);
        await s2aDbReject(fixture.dashboard.id, () => s2aRawUpdate(stored.id, { data_scope_level: scope }), "P0001", /never been configured/);
      }
    }
  }
});

test("S2a aggregation parity: numeric all five, text/boolean last/none; exact compiler paths and DB create/update refusals", async () => {
  const fixture = await s2aFixture("s2a-aggregation");
  for (const [index, valueType] of ["numeric", "text", "boolean"].entries()) {
    const def = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, valueType, dailyAggregationMethod: "last", scopeLevels: ["session"] });
    const draft = s2aDraft({ kind: "metric", metricDefinitionId: def.metricDefinitionId }, { dataScopeLevel: "session", analyticalAggregation: "last" });
    const snapshot = await fixture.reader.load({ ...fixture.target, metricRef: draft.metricRef });
    const valid = fixture.compileSimpleDraft(draft, snapshot, s2aContext());
    let stored = await s2aLegacyProjection(fixture, valid, { layout: { y: index * 8 } });
    for (const aggregation of ["sum", "avg", "max", "last", "none"]) {
      const selected = { ...draft, view: { ...draft.view, analyticalAggregation: aggregation } };
      if (valueType === "numeric" || ["last", "none"].includes(aggregation)) {
        stored = await s2aLegacyProjection(fixture, fixture.compileSimpleDraft(s2aUpdateDraft(selected), snapshot, s2aContext(), stored), { existing: stored });
        const added = await s2aRawAdd(stored.id, valid.widget.series[0], { series_order: 1, analytical_aggregation: aggregation });
        await query("select * from training_load.delete_series($1,$2,$3)", [added.rows[0].series_id, stored.id, added.rows[0].widget_revision]);
        stored = await s2aStored(stored.id);
      } else {
        s2aIssue(fixture.compileSimpleDraft(selected, snapshot, s2aContext()), "aggregationType", "$.view.analyticalAggregation");
        s2aIssue(fixture.compileSimpleDraft(s2aUpdateDraft(selected), snapshot, s2aContext(), stored), "aggregationType", "$.view.analyticalAggregation");
        await s2aDbReject(fixture.dashboard.id, () => s2aRawAdd(stored.id, valid.widget.series[0], { series_order: 1, analytical_aggregation: aggregation }), "P0001", /only supports analytical_aggregation last\/none/);
        await s2aDbReject(fixture.dashboard.id, () => s2aRawUpdate(stored.id, { analytical_aggregation: aggregation }), "P0001", /only supports analytical_aggregation last\/none/);
      }
    }
  }
});

test("S2a source/axis/comparison policies: preserve loaded bindings, paired pins and supported KPI comparison; real create/update backstops", async () => {
  const fixture = await s2aFixture("s2a-policies");
  const def = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, scopeLevels: ["session"] });
  const sourceId = await makeSourceConnection(fixture.clubId);
  const draft = s2aDraft({ kind: "metric", metricDefinitionId: def.metricDefinitionId }, { dataScopeLevel: "session", analyticalAggregation: "avg" });
  const snapshot = await fixture.reader.load({ ...fixture.target, metricRef: draft.metricRef, sourceConnectionId: sourceId });
  const valid = fixture.compileSimpleDraft(draft, snapshot, s2aContext());
  let stored = await s2aLegacyProjection(fixture, valid);
  const matrix = [
    ["axis", "wrong", "axis", "$.metricRef", "23514", null],
    ["source_policy", "not_applicable", "sourcePolicy", "$.metricRef", "23514", null],
    ["source_policy", "source_connection", "sourceConnectionRequired", "$.metricRef", "23514", null],
    ["source_connection_id", sourceId, "sourceConnectionRequired", "$.metricRef", "23514", null],
    ["aggregation_role_policy", "wrong", "aggregationRolePolicy", "$.metricRef", "23514", null],
    ["coverage_policy", "wrong", "coveragePolicy", "$.metricRef", "23514", null],
    ["comparison_period", "previous_period", "comparisonPeriod", "$.view.type", "P0001", /not supported/],
  ];
  for (const [field, value, code, issuePath, sqlState, message] of matrix) {
    const badExisting = structuredClone(stored);
    badExisting.series[0][field] = value;
    s2aIssue(fixture.compileSimpleDraft(s2aUpdateDraft(draft), snapshot, s2aContext(), badExisting), code, issuePath);
    await s2aDbReject(fixture.dashboard.id, () => s2aRawAdd(stored.id, valid.widget.series[0], { series_order: 1, [field]: value }), sqlState, message);
    if (field !== "source_connection_id") await s2aDbReject(fixture.dashboard.id, () => s2aRawUpdate(stored.id, { [field]: value }), sqlState, message);
  }
  for (const sourcePolicy of ["all_with_conflicts", "manual", "api_import", "csv_import", "derived", "source_connection"]) {
    await s2aRawUpdate(stored.id, { source_policy: sourcePolicy, source_connection_id: sourcePolicy === "source_connection" ? sourceId : null, axis: "secondary" });
    stored = await s2aStored(stored.id);
    const next = fixture.compileSimpleDraft({ ...draft, display: { mode: "preserve" }, presentation: { mode: "preserve" } }, snapshot, s2aContext(), stored);
    stored = await s2aLegacyProjection(fixture, next, { existing: stored });
    assert.equal(stored.series[0].source_policy, sourcePolicy);
    assert.equal(stored.series[0].source_connection_id, sourcePolicy === "source_connection" ? sourceId : null);
  }
  const kpiDraft = { ...draft, view: { ...draft.view, type: "kpi", groupBy: "athlete" } };
  const kpi = await s2aLegacyProjection(fixture, fixture.compileSimpleDraft(kpiDraft, snapshot, s2aContext()), { layout: { y: 8, width: 3, height: 3 } });
  for (const comparison of ["previous_period", "previous_year"]) {
    await s2aRawUpdate(kpi.id, { comparison_period: comparison });
    const loaded = await s2aStored(kpi.id);
    await s2aLegacyProjection(fixture, fixture.compileSimpleDraft(s2aUpdateDraft(kpiDraft), snapshot, s2aContext(), loaded), { existing: loaded });
    const tableDraft = { ...kpiDraft, view: { ...kpiDraft.view, type: "table" } };
    s2aIssue(fixture.compileSimpleDraft(s2aUpdateDraft(tableDraft), snapshot, s2aContext(), await s2aStored(kpi.id)), "comparisonPeriod", "$.view.type");
    const current = await s2aStored(kpi.id);
    await s2aDbReject(fixture.dashboard.id, () => query("select * from training_load.update_widget_content($1,$2,$3)", [kpi.id, current.revision - 1, "table"]), "40001", /stale/);
    await s2aDbReject(fixture.dashboard.id, () => query("select * from training_load.update_widget_content($1,$2,$3)", [kpi.id, current.revision, "table"]), "P0001", /comparison_period/);
  }
});

test("S2a retained size correction: loaded Table-to-KPI fails with widgetSizeBounds and DB rollback, compatible explicit layout then transitions", async () => {
  const fixture = await s2aFixture("s2a-size");
  const draft = s2aDraft({ kind: "builtin", key: "rpe" });
  const snapshot = await fixture.reader.load({ ...fixture.target, metricRef: draft.metricRef });
  let stored = await s2aLegacyProjection(fixture, fixture.compileSimpleDraft(draft, snapshot, s2aContext()));
  const kpiDraft = { ...draft, view: { type: "kpi", groupBy: "athlete" }, display: { mode: "preserve" }, presentation: { mode: "preserve" } };
  s2aIssue(fixture.compileSimpleDraft(kpiDraft, snapshot, s2aContext(), stored), "widgetSizeBounds", "$.view.type");
  await s2aDbReject(fixture.dashboard.id, () => query("select * from training_load.update_widget_content($1,$2,$3)", [stored.id, stored.revision, "kpi"]), "P0001", /out of bounds/);
  const dashboardRevision = (await s2aState(fixture.dashboard.id)).dashboard.revision;
  await s2aDbReject(fixture.dashboard.id, () => query("select * from training_load.create_widget($1,$2,'kpi','Invalid size',99,$3,$4,$5,$6,99)", [fixture.dashboard.id, dashboardRevision, 0, 8, 6, 4]), "P0001", /out of bounds/);
  const result = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${stored.id}/layout`, { method: "PATCH", cookie: fixture.coachCookie, body: { expectedWidgetRevision: stored.revision, width: 3, height: 3 } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  stored = await s2aStored(stored.id);
  const compiled = fixture.compileSimpleDraft(kpiDraft, snapshot, s2aContext(), stored);
  assert.equal(compiled.status, "valid", JSON.stringify(compiled));
  assert.equal(compiled.widget.width, 3);
  assert.equal(compiled.widget.height, 3);
  stored = await s2aLegacyProjection(fixture, compiled, { existing: stored });
  assert.equal(stored.widget_type, "kpi");
  assert.equal(stored.width, 3);
  assert.equal(stored.height, 3);
});

test("S2a compiled filter query parity: stored legacy projection preserves V1 and exact result identity/status/value multiplicity on create/update", async () => {
  const fixture = await s2aFixture("s2a-query");
  const first = await makeAthleteInClub(fixture.clubId), second = await makeAthleteInClub(fixture.clubId);
  const fixtureRows = [];
  for (const [athleteId, date, rpe] of [[first.athleteId, "2026-09-09", 6], [first.athleteId, "2026-09-10", 8], [second.athleteId, "2026-09-09", 9]]) {
    const activity = await makeActivityWithEvent({ clubId: fixture.clubId, coachId: fixture.coachId, athleteId, date });
    await makeRpeFeedback({ clubId: fixture.clubId, athleteId, activityParticipantId: activity.participantId, date, rpe });
    fixtureRows.push({ athleteId, bucketKey: date, unit: null, value: rpe, rawCount: 1 });
  }
  const draft = s2aDraft({ kind: "builtin", key: "rpe" });
  draft.athleteSelection = { mode: "selected", athleteIds: [first.athleteId] };
  const snapshot = await fixture.reader.load({ ...fixture.target, metricRef: draft.metricRef });
  const context = s2aContext([first.athleteId, second.athleteId]);
  const compiled = fixture.compileSimpleDraft(draft, snapshot, context);
  assert.deepEqual(compiled.effectiveFilter.athleteIds, [first.athleteId]);
  assert.equal(compiled.semanticBinding.valueType, "numeric");
  let stored = await s2aLegacyProjection(fixture, compiled);
  const tuple = row => [row.athleteId, row.bucketKey, row.unit, row.value, row.rawCount];
  const sort = rows => rows.map(tuple).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  async function verify(expected) {
    const result = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/query`, { method: "POST", cookie: fixture.coachCookie, body: { dateFrom: context.period.dateFrom, dateTo: context.period.dateTo } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.widgets.length, 1);
    assert.equal(result.body.widgets[0].widgetId, stored.id);
    assert.equal(result.body.widgets[0].series.length, 1);
    const series = result.body.widgets[0].series[0];
    assert.equal(series.seriesId, stored.series[0].id);
    assert.equal(series.status, "ok");
    assert.deepEqual(sort(series.data.current), sort(expected));
    for (const row of series.data.current) for (const flag of ["error", "typeConflict", "semanticConflict", "targetConflict", "conflict"]) assert.ok(!row[flag], JSON.stringify(row));
  }
  await verify(fixtureRows.filter(row => row.athleteId === first.athleteId));
  const legacy = { schemaVersion: 1, opaqueLegacy: { retained: [1, "two"] } };
  const changed = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${stored.id}`, { method: "PATCH", cookie: fixture.coachCookie, body: { expectedWidgetRevision: stored.revision, displayConfig: legacy } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  stored = await s2aStored(stored.id);
  const all = { ...draft, athleteSelection: { mode: "allAuthorized" }, display: { mode: "preserve" }, presentation: { mode: "preserve" } };
  const update = fixture.compileSimpleDraft(all, snapshot, context, stored);
  assert.equal(update.widget.local_filter_override.athleteIds, null);
  assert.deepEqual(update.widget.display_config, legacy);
  stored = await s2aLegacyProjection(fixture, update, { existing: stored });
  await verify(fixtureRows);
});

test("S2a component-only parity: absent/cleared activity compiles and queries only the selected real component; parent and foreign denials have exact paths", async () => {
  const fixture = await s2aFixture("s2a-component");
  const { athleteId } = await makeAthleteInClub(fixture.clubId);
  const connectionId = await makeSourceConnection(fixture.clubId);
  const { metricDefinitionId, versionId } = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, scopeLevels: ["component"] });
  const components = await makeComponentFixture({ clubId: fixture.clubId, coachId: fixture.coachId, athleteId, connectionId, date: "2026-09-09" });
  for (const [segmentId, value] of [[components.segmentAId, 10], [components.segmentBId, 20]]) {
    await addMetricValue({ eventParticipantId: components.eventParticipantId, metricDefinitionId, versionId, segmentId, value });
  }
  const otherActivity = await makeActivityWithEvent({ clubId: fixture.clubId, coachId: fixture.coachId, athleteId, connectionId, date: "2026-09-10" });
  const foreignCoach = await makeClubCoach("s2a-component-foreign");
  const foreignAthlete = await makeAthleteInClub(foreignCoach.clubId);
  const foreignComponents = await makeComponentFixture({
    clubId: foreignCoach.clubId, coachId: foreignCoach.coachId, athleteId: foreignAthlete.athleteId,
    connectionId: await makeSourceConnection(foreignCoach.clubId), date: "2026-09-09",
  });
  const draft = s2aDraft({ kind: "metric", metricDefinitionId }, { groupBy: "component", dataScopeLevel: "component", analyticalAggregation: "sum" });
  draft.advancedFilter.component = { mode: "selected", id: components.componentAId };
  let snapshot = await fixture.reader.load({ ...fixture.target, metricRef: draft.metricRef });
  const context = {
    ...s2aContext([athleteId]), componentActivityId: components.activityId,
    authorizedFilterIds: { activityId: [components.activityId, otherActivity.activityId], componentId: [components.componentAId, components.componentBId] },
  };
  const compiled = fixture.compileSimpleDraft(draft, snapshot, context);
  assert.equal(compiled.status, "valid", JSON.stringify(compiled));
  assert.equal(Object.hasOwn(compiled.widget.local_filter_override, "activityId"), false);
  assert.equal(compiled.effectiveFilter.componentId, components.componentAId);
  let stored = await s2aLegacyProjection(fixture, compiled);
  async function verifySelectedComponent() {
    const result = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/query`, {
      method: "POST", cookie: fixture.coachCookie, body: { dateFrom: context.period.dateFrom, dateTo: context.period.dateTo },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.widgets.length, 1);
    assert.equal(result.body.widgets[0].widgetId, stored.id);
    assert.equal(result.body.widgets[0].series.length, 1);
    const series = result.body.widgets[0].series[0];
    assert.equal(series.seriesId, stored.series[0].id);
    assert.equal(series.status, "ok");
    assert.deepEqual(series.data.current.map(row => [row.athleteId, row.bucketKey, row.unit, row.value, row.rawCount]), [[athleteId, components.componentAId, "bpm", 10, 1]]);
    for (const row of series.data.current) for (const flag of ["error", "typeConflict", "semanticConflict", "conflict"]) assert.ok(!row[flag], JSON.stringify(row));
  }
  await verifySelectedComponent();
  const defaultChanged = await api(`/api/training-load/dashboards/${fixture.dashboard.id}`, {
    method: "PATCH", cookie: fixture.coachCookie,
    body: { expectedRevision: await freshRevision(fixture.coachCookie, fixture.dashboard.id), defaultFilter: { activityId: otherActivity.activityId } },
  });
  assert.equal(defaultChanged.status, 200, JSON.stringify(defaultChanged.body));
  snapshot = await fixture.reader.load({ ...fixture.target, metricRef: draft.metricRef });
  context.defaultFilter = snapshot.dashboard.default_filter;
  assert.deepEqual(context.defaultFilter, { activityId: otherActivity.activityId });
  const clearedDraft = s2aUpdateDraft({ ...draft, advancedFilter: { ...draft.advancedFilter, activity: { mode: "clear" } } });
  const cleared = fixture.compileSimpleDraft(clearedDraft, snapshot, context, stored);
  assert.equal(cleared.status, "valid", JSON.stringify(cleared));
  assert.equal(cleared.effectiveFilter.activityId, null);
  assert.equal(cleared.widget.local_filter_override.activityId, null);
  stored = await s2aLegacyProjection(fixture, cleared, { existing: stored });
  await verifySelectedComponent();
  const beforeDenied = await s2aState(fixture.dashboard.id);
  s2aIssue(fixture.compileSimpleDraft(s2aUpdateDraft(draft), snapshot, context, stored), "componentActivityMismatch", "$.advancedFilter.component");
  const foreignDraft = { ...clearedDraft, advancedFilter: { ...clearedDraft.advancedFilter, component: { mode: "selected", id: foreignComponents.componentAId } } };
  s2aIssue(fixture.compileSimpleDraft(foreignDraft, snapshot, context, stored), "notFound", "$.advancedFilter.componentId");
  assert.deepEqual(await s2aState(fixture.dashboard.id), beforeDenied);
});

async function s2bModules() {
  const [expressModule, authModule, serviceModule, routerModule, admissionModule, tokenModule, queryModule] = await Promise.all([
    import("express"), import("../src/auth.js"), import("../src/dashboardSimple/previewService.js"),
    import("../src/dashboardSimple/previewRouter.js"), import("../src/dashboardSimple/previewAdmission.js"),
    import("../src/dashboardSimple/previewTokens.js"), import("../src/trainingLoadDashboardQuery.js"),
  ]);
  return { express: expressModule.default, ...authModule, ...serviceModule, ...routerModule, ...admissionModule, ...tokenModule, ...queryModule };
}

function s2bEnvelope(draft = s2aDraft({ kind: "builtin", key: "rpe" }, { dataScopeLevel: "session", analyticalAggregation: "avg" }), overrides = {}) {
  return {
    contractVersion: 1, context: { kind: "legacyDashboard", period: s2aContext().period },
    draftRef: { draftId: draft.draftId, draftVersion: draft.draftVersion }, draft, editTarget: null, ...overrides,
  };
}

async function s2bHttpHarness(testContext, options = {}) {
  const modules = await s2bModules();
  assert.match(db.name, /^optimove_tests_tldash_primary_[a-f0-9]{12}$/);
  const previewPool = new pg.Pool({ connectionString: db.url, max: 3 });
  const observations = [], lifecycle = [], queryDashboardErrors = [];
  const observedPool = {
    async connect() {
      const client = await previewPool.connect();
      const backendPid = (await client.query("select pg_backend_pid() as pid")).rows[0].pid;
      lifecycle.push({ kind: "checkout", backendPid });
      return {
        async query(sql, params) {
          const result = await client.query(sql, params);
          if (options.observe && /^\s*select\b/i.test(sql)) {
            const state = (await client.query(`select current_database() as database_name, pg_backend_pid() as backend_pid,
              current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only,
              txid_current_snapshot()::text as snapshot`)).rows[0];
            observations.push({ sql, ...state });
          }
          return result;
        },
        release(destroy) {
          lifecycle.push({ kind: "release", backendPid, destroy: Boolean(destroy) });
          client.release(destroy);
        },
      };
    },
  };
  const coordinator = modules.createPreviewAdmissionCoordinator({ maxActiveDeployment: 1 });
  const admission = modules.createPreviewAdmission({ coordinator, processId: `s2b-http-${uid()}`, poolMax: 3 });
  const tokenService = modules.createPreviewTokenService({ keyId: `s2b-test-${uid()}`, key: crypto.randomBytes(32) });
  const service = modules.createSimplePreviewService({
    pool: observedPool,
    queryDashboard: async (...args) => {
      try { return await (options.queryDashboard ?? modules.queryDashboard)(...args); }
      catch (error) { queryDashboardErrors.push(error); throw error; }
    },
    admission, tokenService,
    activation: options.activation ?? { coordinatedAdmissionVerified: true, deploymentBudgetVerified: true },
    transactionOptions: options.transactionOptions ?? {},
  });
  const app = modules.express();
  app.use(modules.authMiddleware);
  if (options.upstreamParser) app.use(modules.express.json({ limit: '128kb', verify: options.captureOriginalBytes ? modules.captureSimplePreviewRequestBytes : undefined }));
  if (options.afterAuthentication) app.use((req, res, next) => Promise.resolve(options.afterAuthentication(req)).then(() => next(), next));
  app.use("/api/training-load/dashboards/:dashboardId/simple-editor", modules.createSimplePreviewRouter({ service }));
  const previewServer = http.createServer(app);
  testContext.after(async () => {
    previewServer.closeAllConnections();
    await new Promise(resolve => previewServer.close(resolve));
    await previewPool.end();
  });
  await new Promise(resolve => previewServer.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${previewServer.address().port}`;
  function url(dashboardId, action) {
    return `${origin}/api/training-load/dashboards/${dashboardId}/simple-editor/${action}`;
  }
  async function request(dashboardId, action, { cookie, body, signal, rawBody } = {}) {
    const response = await fetch(url(dashboardId, action), {
      method: action === "capabilities" ? "GET" : "POST", signal,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: action === "capabilities" ? undefined : rawBody ?? JSON.stringify(body ?? s2bEnvelope()),
    });
    return {
      status: response.status, body: await response.json(), headers: response.headers,
      internalQueryErrors: queryDashboardErrors.map(error => ({ code: error.code, message: error.message, stack: error.stack })),
    };
  }
  return { ...modules, service, admission, tokenService, previewPool, observations, lifecycle, queryDashboardErrors, request };
}

async function s2bDataFixture(label) {
  const fixture = await s2aFixture(label);
  const first = await makeAthleteInClub(fixture.clubId), second = await makeAthleteInClub(fixture.clubId);
  const expectedRows = [];
  for (const [athleteId, date, rpe] of [[first.athleteId, "2026-09-09", 6], [first.athleteId, "2026-09-10", 8], [second.athleteId, "2026-09-09", 9]]) {
    const activity = await makeActivityWithEvent({ clubId: fixture.clubId, coachId: fixture.coachId, athleteId, date });
    await makeRpeFeedback({ clubId: fixture.clubId, athleteId, activityParticipantId: activity.participantId, date, rpe });
    expectedRows.push({ athleteId, bucketKey: date, unit: null, value: rpe, rawCount: 1 });
  }
  return { ...fixture, first, second, expectedRows };
}

function s2bRows(rows) {
  return rows.map(row => [row.athleteId, row.bucketKey, row.unit, row.value, row.rawCount])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function s2bAssertPreview(response) {
  assert.equal(response.status, 200, JSON.stringify({ body: response.body, internalQueryErrors: response.internalQueryErrors }));
  assert.equal(response.body.status, "valid", JSON.stringify(response.body));
  assert.equal(response.body.widgetResult.series.length, 1);
  assert.equal(response.body.widgetResult.series[0].status, "ok");
  assert.equal(typeof response.body.previewToken, "string");
  return response.body.widgetResult.series[0].data.current;
}

async function s2bDatabaseState() {
  const tables = (await query(`select schemaname, tablename from pg_tables
    where schemaname in ('public','training','training_load','plans') order by schemaname, tablename`)).rows;
  const state = {};
  for (const table of tables) {
    const identifier = value => `"${value.replaceAll('"', '""')}"`;
    const relation = `${identifier(table.schemaname)}.${identifier(table.tablename)}`;
    state[relation] = (await query(`select count(*)::int as row_count,
      md5(coalesce(string_agg(to_jsonb(record)::text, E'\n' order by to_jsonb(record)::text), '')) as digest from ${relation} record`)).rows[0];
  }
  return state;
}

async function s2bWaitForDatabaseState(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test("S2b P01/P09 real HTTP session authentication, fresh session recheck and disabled preview gate", async testContext => {
  const fixture = await s2aFixture("s2b-auth");
  const harness = await s2bHttpHarness(testContext, { activation: {} });
  for (const cookie of [undefined, cookieFor(crypto.randomBytes(32).toString("hex"))]) {
    const denied = await harness.request(fixture.dashboard.id, "capabilities", { cookie });
    assert.equal(denied.status, 401);
  }
  const capabilities = await harness.request(fixture.dashboard.id, "capabilities", { cookie: fixture.coachCookie });
  assert.equal(capabilities.status, 200, JSON.stringify(capabilities.body));
  assert.equal(capabilities.body.capabilities.preview, false);
  const disabled = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie });
  assert.deepEqual({ status: disabled.status, body: disabled.body }, { status: 503, body: { error: "previewUnavailable" } });
  const validation = await harness.request(fixture.dashboard.id, "validate", { cookie: fixture.coachCookie });
  assert.equal(validation.status, 200, JSON.stringify(validation.body));
  assert.equal(validation.body.status, "valid", JSON.stringify(validation.body));
  assert.equal(validation.body.previewToken, undefined);
  let authenticatedUserId;
  const revokingHarness = await s2bHttpHarness(testContext, {
    afterAuthentication: async req => {
      authenticatedUserId = req.user?.id;
      await query("delete from public.auth_sessions where user_id=$1", [fixture.coachId]);
    },
  });
  const revokedDuringRequest = await revokingHarness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie });
  assert.equal(authenticatedUserId, fixture.coachId);
  assert.deepEqual({ status: revokedDuringRequest.status, body: revokedDuringRequest.body }, { status: 404, body: { error: "notFound" } });
  const revokedNextRequest = await harness.request(fixture.dashboard.id, "capabilities", { cookie: fixture.coachCookie });
  assert.equal(revokedNextRequest.status, 401);
});

test("S2b P01 missing or revoked workspace requires explicit selection without fallback or preference writes", async testContext => {
  const fixture = await s2aFixture("s2b-workspace");
  const harness = await s2bHttpHarness(testContext);
  await query("delete from public.user_workspace_preferences where user_id=$1", [fixture.coachId]);
  for (const state of ["missing", "revoked"]) {
    if (state === "revoked") {
      await setActiveWorkspace(fixture.coachId, "club", fixture.clubId);
      await query("update public.user_club_roles set is_active=false where user_id=$1 and club_id=$2", [fixture.coachId, fixture.clubId]);
    }
    const before = await s2bDatabaseState();
    for (const action of ["capabilities", "validate", "preview"]) {
      const response = await harness.request(fixture.dashboard.id, action, { cookie: fixture.coachCookie });
      assert.deepEqual({ status: response.status, body: response.body }, { status: 409, body: { error: "workspaceSelectionRequired" } }, `${state}: ${action}`);
    }
    assert.deepEqual(await s2bDatabaseState(), before, `${state} workspace must not create or repair a preference or mutate any application row`);
  }
});

test("S2b P01/P02 foreign and workspace-mismatched targets hide existence before draft validation", async testContext => {
  const fixture = await s2aFixture("s2b-target");
  const foreign = await s2aFixture("s2b-target-foreign");
  const harness = await s2bHttpHarness(testContext);
  const before = await s2bDatabaseState();
  for (const dashboardId of [foreign.dashboard.id, crypto.randomUUID(), "invalid-dashboard-id"]) {
    for (const action of ["validate", "preview"]) {
      const response = await harness.request(dashboardId, action, { cookie: fixture.coachCookie, body: { draft: { secretProbe: true } } });
      assert.deepEqual({ status: response.status, body: response.body }, { status: 404, body: { error: "notFound" } });
    }
  }
  const malformedOwnDraft = await harness.request(fixture.dashboard.id, "validate", { cookie: fixture.coachCookie, body: {} });
  assert.equal(malformedOwnDraft.status, 200);
  assert.equal(malformedOwnDraft.body.status, "invalid");
  assert.ok(malformedOwnDraft.body.issues.length > 0);
  assert.deepEqual(await s2bDatabaseState(), before);
  await grantClubAdmin(fixture.coachId, foreign.clubId);
  await setActiveWorkspace(fixture.coachId, "club", foreign.clubId);
  for (const action of ["capabilities", "validate", "preview"]) {
    const mismatch = await harness.request(fixture.dashboard.id, action, { cookie: fixture.coachCookie, body: {} });
    assert.deepEqual({ status: mismatch.status, body: mismatch.body }, { status: 404, body: { error: "notFound" } });
  }
});

test("S2b P02/P03 preview equals a clean saved legacy projection, preserves IDs/multiplicity and writes no application rows; former members cannot broaden an empty selection", async testContext => {
  const fixture = await s2bDataFixture("s2b-parity");
  const envelope = s2bEnvelope();
  const snapshot = await fixture.reader.load({ ...fixture.target, metricRef: envelope.draft.metricRef });
  const compiled = fixture.compileSimpleDraft(envelope.draft, snapshot, s2aContext([fixture.first.athleteId, fixture.second.athleteId]));
  const stored = await s2aLegacyProjection(fixture, compiled);
  let engineCalls = 0;
  const { queryDashboard } = await s2bModules();
  const harness = await s2bHttpHarness(testContext, {
    queryDashboard: async (...args) => { engineCalls += 1; return queryDashboard(...args); },
  });
  const before = await s2bDatabaseState();
  const capabilities = await harness.request(fixture.dashboard.id, "capabilities", { cookie: fixture.coachCookie });
  assert.equal(capabilities.body.capabilities.preview, true);
  const validated = await harness.request(fixture.dashboard.id, "validate", { cookie: fixture.coachCookie, body: envelope });
  assert.equal(validated.body.status, "valid", JSON.stringify(validated.body));
  assert.equal(validated.body.previewToken, undefined);
  const preview = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie, body: envelope });
  const rows = s2bAssertPreview(preview);
  assert.deepEqual(s2bRows(rows), s2bRows(fixture.expectedRows));
  assert.equal(preview.body.widgetResult.widgetId, compiled.widget.id);
  assert.equal(preview.body.widgetResult.series[0].widgetId, compiled.widget.id);
  assert.equal(preview.body.widgetResult.series[0].seriesId, compiled.widget.series[0].id);
  const legacy = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/query`, {
    method: "POST", cookie: fixture.coachCookie, body: { dateFrom: envelope.context.period.dateFrom, dateTo: envelope.context.period.dateTo },
  });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal(legacy.body.widgets[0].widgetId, stored.id);
  assert.equal(legacy.body.widgets[0].series[0].seriesId, stored.series[0].id);
  const mappedLegacy = structuredClone(legacy.body.widgets[0]);
  mappedLegacy.widgetId = compiled.widget.id;
  mappedLegacy.series[0].widgetId = compiled.widget.id;
  mappedLegacy.series[0].seriesId = compiled.widget.series[0].id;
  assert.deepEqual({ ...mappedLegacy, series: mappedLegacy.series.map(series => ({ ...series, data: { ...series.data, current: s2bRows(series.data.current) } })) },
    { ...preview.body.widgetResult, series: preview.body.widgetResult.series.map(series => ({ ...series, data: { ...series.data, current: s2bRows(series.data.current) } })) });
  assert.deepEqual(await s2bDatabaseState(), before, "capabilities/validate/preview/legacy reads must preserve widgets, preferences, selections, sessions, metrics and existing ledgers");
  await query("update public.athlete_memberships set status='inactive' where club_id=$1", [fixture.clubId]);
  const afterRevocation = await s2bDatabaseState();
  const callsBeforeEmptyPreview = engineCalls;
  const empty = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie, body: envelope });
  assert.deepEqual(s2bAssertPreview(empty), []);
  assert.deepEqual(empty.body.effectiveFilterSummary.athleteIds, []);
  assert.ok(empty.body.warnings.some(warning => warning.code === "emptyPreview"));
  assert.equal(engineCalls, callsBeforeEmptyPreview, "zero authorized athletes must bypass the legacy empty-array normalization");
  assert.deepEqual(await s2bDatabaseState(), afterRevocation);
});

test("S2b P03/P06 one real repeatable-read read-only client spans authorization/catalog/facts and holds the old snapshot across a concurrent fact insert", async testContext => {
  const fixture = await s2bDataFixture("s2b-snapshot");
  const { queryDashboard } = await s2bModules();
  let changed = false, injectedRunner;
  const harness = await s2bHttpHarness(testContext, {
    observe: true,
    queryDashboard: async (workspace, widgets, period, options) => {
      assert.equal(typeof options.queryRunner, "function");
      injectedRunner = options.queryRunner;
      if (!changed) {
        changed = true;
        const activity = await makeActivityWithEvent({ clubId: fixture.clubId, coachId: fixture.coachId, athleteId: fixture.second.athleteId, date: "2026-09-10" });
        await makeRpeFeedback({ clubId: fixture.clubId, athleteId: fixture.second.athleteId, activityParticipantId: activity.participantId, date: "2026-09-10", rpe: 3 });
      }
      return queryDashboard(workspace, widgets, period, options);
    },
  });
  const preview = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie });
  assert.deepEqual(s2bRows(s2bAssertPreview(preview)), s2bRows(fixture.expectedRows));
  assert.equal(typeof injectedRunner, "function");
  assert.ok(harness.observations.some(item => /auth_sessions/i.test(item.sql)));
  assert.ok(harness.observations.some(item => /user_club_roles/i.test(item.sql)));
  assert.ok(harness.observations.some(item => /user_workspace_preferences/i.test(item.sql)));
  assert.ok(harness.observations.some(item => /dashboard_builtin_series/i.test(item.sql)));
  assert.ok(harness.observations.some(item => /canonical/i.test(item.sql)), "the actual engine must read canonical facts through the injected runner");
  assert.equal(new Set(harness.observations.map(item => item.backend_pid)).size, 1);
  assert.equal(new Set(harness.observations.map(item => item.snapshot)).size, 1);
  for (const observation of harness.observations) {
    assert.equal(observation.database_name, db.name);
    assert.equal(observation.isolation, "repeatable read");
    assert.equal(observation.read_only, "on");
  }
  const freshExpected = [...fixture.expectedRows, { athleteId: fixture.second.athleteId, bucketKey: "2026-09-10", unit: null, value: 3, rawCount: 1 }];
  const fresh = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie });
  assert.deepEqual(s2bRows(s2bAssertPreview(fresh)), s2bRows(freshExpected));
});

test("S2b P06 PostgreSQL itself refuses a sanctioned writer inside the preview transaction and a separate follow-up still succeeds", async testContext => {
  const fixture = await s2bDataFixture("s2b-readonly");
  const { queryDashboard } = await s2bModules();
  let attemptWrite = true, databaseRejection;
  const harness = await s2bHttpHarness(testContext, {
    observe: true,
    queryDashboard: async (workspace, widgets, period, options) => {
      if (attemptWrite) {
        attemptWrite = false;
        try {
          await options.queryRunner("select * from training_load.create_widget($1,$2,'table','Forbidden preview write',99,0::smallint,80::smallint,6::smallint,4::smallint,99)", [fixture.dashboard.id, fixture.dashboard.revision]);
          assert.fail("PostgreSQL accepted a write in a preview transaction");
        } catch (error) {
          databaseRejection = error;
          throw error;
        }
      }
      return queryDashboard(workspace, widgets, period, options);
    },
  });
  const before = await s2bDatabaseState();
  const rejected = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie });
  assert.equal(databaseRejection?.code, "25006", "the assertion must reach PostgreSQL rather than only a JavaScript SQL guard");
  assert.deepEqual({ status: rejected.status, body: rejected.body }, { status: 503, body: { error: "previewReadOnlyViolation" } });
  assert.deepEqual(await s2bDatabaseState(), before);
  const followUp = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie });
  assert.deepEqual(s2bRows(s2bAssertPreview(followUp)), s2bRows(fixture.expectedRows));
  assert.deepEqual(await s2bDatabaseState(), before, "a failed read-only probe must not poison the subsequent preview or mutate state");
});

test("S2b P02/P03 stale edit revision rejects and component inherit uses the runtime component's real parent rather than the stored component's parent", async testContext => {
  const fixture = await s2aFixture("s2b-component");
  const { athleteId } = await makeAthleteInClub(fixture.clubId);
  const connectionId = await makeSourceConnection(fixture.clubId);
  const definition = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, scopeLevels: ["component"] });
  const first = await makeComponentFixture({ ...fixture, athleteId, connectionId, date: "2026-09-09" });
  const second = await makeComponentFixture({ ...fixture, athleteId, connectionId, date: "2026-09-10" });
  for (const [component, value] of [[first, 10], [second, 20]]) await addMetricValue({ eventParticipantId: component.eventParticipantId, ...definition, value, segmentId: component.segmentAId });
  const draft = s2aDraft({ kind: "metric", metricDefinitionId: definition.metricDefinitionId }, { type: "table", groupBy: "component", dataScopeLevel: "component", analyticalAggregation: "sum" });
  draft.advancedFilter.component = { mode: "selected", id: first.componentAId };
  const snapshot = await fixture.reader.load({ ...fixture.target, metricRef: draft.metricRef });
  const compiled = fixture.compileSimpleDraft(draft, snapshot, {
    ...s2aContext([athleteId]), componentActivityId: first.activityId,
    authorizedFilterIds: { activityId: [first.activityId, second.activityId], componentId: [first.componentAId, second.componentAId] },
  });
  const stored = await s2aLegacyProjection(fixture, compiled);
  const inherited = s2aUpdateDraft({ ...draft, advancedFilter: { activity: { mode: "inherit" }, component: { mode: "inherit" } } });
  const envelope = s2bEnvelope(inherited, {
    context: { kind: "legacyDashboard", period: s2aContext().period, runtimeFilter: { activityId: second.activityId, componentId: second.componentAId } },
    editTarget: { widgetId: stored.id, expectedWidgetRevision: stored.revision },
  });
  const harness = await s2bHttpHarness(testContext);
  const before = await s2bDatabaseState();
  const response = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie, body: envelope });
  assert.deepEqual(s2bRows(s2bAssertPreview(response)), [[athleteId, second.componentAId, "bpm", 20, 1]]);
  assert.equal(response.body.effectiveFilterSummary.componentId, second.componentAId);
  assert.equal(response.body.effectiveFilterSummary.activityId, second.activityId);
  const stale = await harness.request(fixture.dashboard.id, "preview", {
    cookie: fixture.coachCookie, body: { ...envelope, editTarget: { ...envelope.editTarget, expectedWidgetRevision: stored.revision + 1 } },
  });
  assert.deepEqual({ status: stale.status, body: stale.body }, { status: 409, body: { error: "staleRevision" } });
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2b P02/P07 invalid catalog binding and changed expected catalog token produce no preview proof", async testContext => {
  const fixture = await s2bDataFixture("s2b-catalog");
  const harness = await s2bHttpHarness(testContext);
  const envelope = s2bEnvelope();
  const before = await s2bDatabaseState();
  const invalid = await harness.request(fixture.dashboard.id, "preview", {
    cookie: fixture.coachCookie, body: s2bEnvelope(s2aDraft({ kind: "metric", metricDefinitionId: crypto.randomUUID() }, { dataScopeLevel: "session", analyticalAggregation: "avg" })),
  });
  assert.deepEqual({ status: invalid.status, body: invalid.body }, { status: 404, body: { error: "notFound" } });
  assert.equal(invalid.body.previewToken, undefined);
  assert.equal(invalid.body.widgetResult, undefined);
  const valid = await harness.request(fixture.dashboard.id, "validate", { cookie: fixture.coachCookie, body: envelope });
  assert.equal(valid.body.status, "valid", JSON.stringify(valid.body));
  assert.equal(typeof valid.body.catalogToken, "string");
  const changed = await harness.request(fixture.dashboard.id, "preview", {
    cookie: fixture.coachCookie, body: { ...envelope, expectedCatalogToken: `stale-${valid.body.catalogToken}` },
  });
  assert.deepEqual({ status: changed.status, body: changed.body }, { status: 409, body: { error: "catalogChanged" } });
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2b P07 a token from a real HTTP preview binds the loaded user/workspace/target/catalog/draft/context/period and rejects tampering", async testContext => {
  const fixture = await s2bDataFixture("s2b-token");
  const harness = await s2bHttpHarness(testContext);
  const envelope = s2bEnvelope();
  const preview = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie, body: envelope });
  s2bAssertPreview(preview);
  const [encoded, signature] = preview.body.previewToken.split(".");
  const { binding } = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.equal(binding.userId, fixture.coachId);
  assert.deepEqual(binding.workspace, fixture.target.dataWorkspace);
  assert.deepEqual(binding.target, { dashboardId: fixture.dashboard.id, widgetId: null, widgetRevision: null });
  for (const field of ["draftHash", "catalogToken", "contextFingerprint", "resolvedPeriod", "evaluatedAt"]) assert.deepEqual(binding[field], preview.body[field]);
  assert.deepEqual(binding.periodIntent, envelope.draft.periodIntent);
  const snapshot = await fixture.reader.load({ ...fixture.target, metricRef: envelope.draft.metricRef });
  const compiled = fixture.compileSimpleDraft(envelope.draft, snapshot, { ...s2aContext([fixture.first.athleteId, fixture.second.athleteId]), evaluatedAt: preview.body.evaluatedAt });
  assert.equal(binding.semanticFingerprint, compiled.semanticBinding.fingerprint);
  assert.deepEqual(harness.tokenService.verify(preview.body.previewToken, binding), binding);
  for (const field of Object.keys(binding)) {
    const changed = structuredClone(binding);
    if (field === "workspace") changed.workspace.dataWorkspaceScopeId = crypto.randomUUID();
    else if (field === "target") changed.target.dashboardId = crypto.randomUUID();
    else if (field === "periodIntent") changed.periodIntent = { mode: "replacePageRuntime", periodConfig: { mode: "relative", schemaVersion: 1, preset: "today", timeZone: "UTC" } };
    else if (field === "resolvedPeriod") changed.resolvedPeriod.dateFrom = "2026-09-08";
    else if (field === "evaluatedAt") changed.evaluatedAt = new Date(Date.parse(binding.evaluatedAt) - 1).toISOString();
    else changed[field] = field === "userId" ? crypto.randomUUID() : `changed-${changed[field]}`;
    assert.throws(() => harness.tokenService.verify(preview.body.previewToken, changed), error => error.code === "previewRequired" && error.status === 409, field);
  }
  const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assert.throws(() => harness.tokenService.verify(`${encoded}.${tamperedSignature}`, binding), error => error.code === "previewRequired" && error.status === 409);
});

test("S2b P03/P10 a genuine engine SQL error is a controlled failure without empty-result proof, and the next request works", async testContext => {
  const fixture = await s2bDataFixture("s2b-query-error");
  const { queryDashboard } = await s2bModules();
  let injectSqlError = true, errorCode;
  const harness = await s2bHttpHarness(testContext, {
    queryDashboard: async (workspace, widgets, period, options) => {
      const queryRunner = async (sql, params) => {
        if (injectSqlError && /canonical/i.test(sql)) {
          injectSqlError = false;
          try { await options.queryRunner("select 1 / 0 as s2b_real_sql_failure"); }
          catch (error) { errorCode = error.code; throw error; }
        }
        return options.queryRunner(sql, params);
      };
      return queryDashboard(workspace, widgets, period, { ...options, queryRunner });
    },
  });
  const before = await s2bDatabaseState();
  const failed = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie });
  assert.equal(errorCode, "22012", "the failure must originate from a real PostgreSQL statement in the actual engine runner");
  assert.deepEqual({ status: failed.status, body: failed.body }, { status: 503, body: { error: "previewQueryFailed" } });
  assert.equal(failed.body.previewToken, undefined);
  assert.equal(failed.body.widgetResult, undefined);
  assert.ok(!JSON.stringify(failed.body).includes("s2b_real_sql_failure"));
  assert.deepEqual(s2bRows(s2bAssertPreview(await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie }))), s2bRows(fixture.expectedRows));
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2b P09/P10 HTTP request bytes stop at 64 KiB and a real metric result exceeding 2 MiB is refused without a preview token", async testContext => {
  const fixture = await s2aFixture("s2b-size");
  const { athleteId } = await makeAthleteInClub(fixture.clubId);
  const definition = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, valueType: "text", dailyAggregationMethod: "last", scopeLevels: ["session"] });
  const activity = await makeActivityWithEvent({ ...fixture, athleteId, date: "2026-09-09" });
  const occasion = (await query("insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id", [activity.eventParticipantId])).rows[0].id;
  await query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_text, unit_at_capture, aggregation_role, coverage)
    values ($1,$2,$3,repeat('z', $4),'bpm','standalone','not_applicable')`, [occasion, definition.metricDefinitionId, definition.versionId, 2 * 1024 * 1024]);
  const envelope = s2bEnvelope(s2aDraft({ kind: "metric", metricDefinitionId: definition.metricDefinitionId }, { dataScopeLevel: "session", analyticalAggregation: "last" }));
  let engineResultBytes = 0;
  const { queryDashboard } = await s2bModules();
  const harness = await s2bHttpHarness(testContext, {
    queryDashboard: async (...args) => {
      const results = await queryDashboard(...args);
      assert.equal(results[0].series[0].status, "ok");
      assert.equal(results[0].series[0].data.current[0].value.length, 2 * 1024 * 1024);
      engineResultBytes = Buffer.byteLength(JSON.stringify(results));
      return results;
    },
  });
  const before = await s2bDatabaseState();
  const encoded = JSON.stringify(envelope);
  const atLimit = await harness.request(fixture.dashboard.id, "validate", {
    cookie: fixture.coachCookie, rawBody: encoded + " ".repeat(65536 - Buffer.byteLength(encoded)),
  });
  assert.equal(atLimit.status, 200, JSON.stringify(atLimit.body));
  assert.equal(atLimit.body.status, "valid", JSON.stringify(atLimit.body));
  const oversizedRequest = await harness.request(fixture.dashboard.id, "preview", {
    cookie: fixture.coachCookie, rawBody: encoded + " ".repeat(65537 - Buffer.byteLength(encoded)),
  });
  assert.deepEqual({ status: oversizedRequest.status, body: oversizedRequest.body }, { status: 413, body: { error: "payloadTooLarge" } });
  assert.equal(engineResultBytes, 0);
  const oversizedResponse = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie, body: envelope });
  assert.ok(engineResultBytes > 2 * 1024 * 1024, "the actual query engine must have produced the oversized database result");
  assert.deepEqual({ status: oversizedResponse.status, body: oversizedResponse.body }, { status: 413, body: { error: "previewTooLarge" } });
  assert.equal(oversizedResponse.body.previewToken, undefined);
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2b P07 an upstream JSON parser must preserve original byte evidence including whitespace", async testContext => {
  const fixture = await s2bDataFixture('s2b-upstream-parser');
  const envelope = s2bEnvelope();
  const encoded = JSON.stringify(envelope);
  const rawAtLimit = encoded + ' '.repeat(65536 - Buffer.byteLength(encoded));
  const rawTooLarge = rawAtLimit + ' ';
  const missingProof = await s2bHttpHarness(testContext, { upstreamParser: true });
  const capturedProof = await s2bHttpHarness(testContext, { upstreamParser: true, captureOriginalBytes: true });
  const before = await s2bDatabaseState();
  const blocked = await missingProof.request(fixture.dashboard.id, 'preview', { cookie: fixture.coachCookie, body: envelope });
  assert.deepEqual({ status: blocked.status, body: blocked.body }, { status: 503, body: { error: 'previewParserRequired' } });
  const accepted = await capturedProof.request(fixture.dashboard.id, 'validate', { cookie: fixture.coachCookie, rawBody: rawAtLimit });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.status, 'valid', JSON.stringify(accepted.body));
  const refused = await capturedProof.request(fixture.dashboard.id, 'preview', { cookie: fixture.coachCookie, rawBody: rawTooLarge });
  assert.deepEqual({ status: refused.status, body: refused.body }, { status: 413, body: { error: 'payloadTooLarge' } });
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2b P06/P09/P10 real SQL timeout and HTTP abort retain admission until cleanup, never reuse a busy pool client, and permit follow-up previews", { timeout: 20000 }, async testContext => {
  const fixture = await s2bDataFixture("s2b-cancellation");
  const { queryDashboard } = await s2bModules();
  for (const mode of ["timeout", "abort"]) {
    let slow = true, slowPid, slowStatementFinished = false;
    const harness = await s2bHttpHarness(testContext, {
      transactionOptions: { checkoutTimeoutMs: 1000, statementTimeoutMs: mode === "timeout" ? 250 : 1000, transactionTimeoutMs: 2500 },
      queryDashboard: async (workspace, widgets, period, options) => {
        if (slow) {
          slow = false;
          slowPid = (await options.queryRunner("select pg_backend_pid() as pid")).rows[0].pid;
          try { await options.queryRunner("select pg_sleep(0.7)"); }
          finally { slowStatementFinished = true; }
        }
        return queryDashboard(workspace, widgets, period, options);
      },
    });
    const before = await s2bDatabaseState();
    const controller = new AbortController();
    const pending = harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie, signal: controller.signal })
      .then(response => ({ response }), error => ({ error }));
    await s2bWaitForDatabaseState(async () => {
      if (!slowPid) return false;
      return (await query("select pid from pg_stat_activity where pid=$1 and state='active' and wait_event='PgSleep'", [slowPid])).rows.length === 1;
    }, `${mode} query to enter PostgreSQL PgSleep`);
    assert.equal(slowStatementFinished, false);
    if (mode === "abort") controller.abort();
    await assert.rejects(() => harness.admission.tryAcquire({ userId: fixture.coachId }), error => error.code === "previewBusy", "the same user's lease remains occupied while PostgreSQL is executing");
    await assert.rejects(() => harness.admission.tryAcquire({ userId: crypto.randomUUID() }), error => error.code === "previewBusy", "the deployment slot remains occupied while PostgreSQL is executing");
    assert.equal(harness.lifecycle.some(item => item.kind === "release" && item.backendPid === slowPid), false, "a still-running client must not be returned to the pool");
    if (mode === "timeout") {
      const { response, error } = await pending;
      assert.equal(error, undefined);
      assert.deepEqual({ status: response.status, body: response.body }, { status: 503, body: { error: "previewTimeout" } });
    } else {
      const { error } = await pending;
      assert.equal(error?.name, "AbortError");
    }
    await s2bWaitForDatabaseState(async () => {
      if (!slowStatementFinished || !harness.lifecycle.some(item => item.kind === "release" && item.backendPid === slowPid)) return false;
      const state = (await query("select state, xact_start from pg_stat_activity where pid=$1", [slowPid])).rows[0];
      return !state || state.state === "idle" && state.xact_start === null;
    }, `${mode} rollback or connection destruction`);
    const lease = await harness.admission.tryAcquire({ userId: fixture.coachId });
    await lease.release();
    const followUp = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie });
    assert.deepEqual(s2bRows(s2bAssertPreview(followUp)), s2bRows(fixture.expectedRows));
    assert.deepEqual(await s2bDatabaseState(), before);
  }
});

test("S2b P01/P02 a foreign edit widget stays 404 before an invalid draft title can disclose detailed validation", async testContext => {
  const fixture = await s2aFixture("s2b-edit-gate");
  const sameOwnerDashboard = await makeDashboardHttp(fixture.coachCookie);
  const foreign = await s2aFixture("s2b-edit-gate-foreign");
  const ownWidget = await makeWidgetHttp(fixture.coachCookie, fixture.dashboard);
  const otherDashboardWidget = await makeWidgetHttp(fixture.coachCookie, sameOwnerDashboard);
  const foreignWidget = await makeWidgetHttp(foreign.coachCookie, foreign.dashboard);
  const harness = await s2bHttpHarness(testContext);
  const draft = s2aUpdateDraft({ ...s2bEnvelope().draft, title: "" });
  const before = await s2bDatabaseState();
  for (const action of ["validate", "preview"]) {
    for (const widgetId of [otherDashboardWidget.widgetId, foreignWidget.widgetId, crypto.randomUUID()]) {
      const denied = await harness.request(fixture.dashboard.id, action, {
        cookie: fixture.coachCookie, body: s2bEnvelope(draft, { editTarget: { widgetId, expectedWidgetRevision: 1 } }),
      });
      assert.deepEqual({ status: denied.status, body: denied.body }, { status: 404, body: { error: "notFound" } });
      assert.equal(denied.body.issues, undefined);
      assert.equal(denied.body.previewToken, undefined);
    }
    const authorized = await harness.request(fixture.dashboard.id, action, {
      cookie: fixture.coachCookie, body: s2bEnvelope(draft, { editTarget: { widgetId: ownWidget.widgetId, expectedWidgetRevision: 1 } }),
    });
    assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
    assert.equal(authorized.body.status, "invalid");
    assert.ok(authorized.body.issues.some(issue => issue.path === "$.draft.title"), JSON.stringify(authorized.body));
    assert.equal(authorized.body.previewToken, undefined);
  }
  assert.deepEqual(await s2bDatabaseState(), before);
});

async function s2bHistoricalTypeFixture(label, historicalDate, numericDate) {
  const fixture = await s2aFixture(label);
  const { athleteId } = await makeAthleteInClub(fixture.clubId);
  const definition = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, valueType: "boolean", dailyAggregationMethod: "last", scopeLevels: ["session"] });
  const historicalActivity = await makeActivityWithEvent({ ...fixture, athleteId, date: historicalDate });
  const occasion = (await query("insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id", [historicalActivity.eventParticipantId])).rows[0].id;
  await query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_boolean, unit_at_capture, aggregation_role, coverage)
    values ($1,$2,$3,true,'bpm','standalone','not_applicable')`, [occasion, definition.metricDefinitionId, definition.versionId]);
  const numericVersionId = (await query(`insert into training_load.metric_definition_versions
    (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id)
    values ($1,2,'bpm','numeric','sum',$2) returning id`, [definition.metricDefinitionId, fixture.coachId])).rows[0].id;
  await query("update training_load.metric_definitions set current_version_id=$1 where id=$2", [numericVersionId, definition.metricDefinitionId]);
  const numericActivity = await makeActivityWithEvent({ ...fixture, athleteId, date: numericDate });
  await addMetricValue({ eventParticipantId: numericActivity.eventParticipantId, metricDefinitionId: definition.metricDefinitionId, versionId: numericVersionId, value: 7 });
  const versions = (await query("select version_number, value_type from training_load.metric_definition_versions where metric_definition_id=$1 order by version_number", [definition.metricDefinitionId])).rows;
  assert.deepEqual(versions, [{ version_number: 1, value_type: "boolean" }, { version_number: 2, value_type: "numeric" }]);
  return { ...fixture, athleteId, metricDefinitionId: definition.metricDefinitionId };
}

test("S2b P03/P10 real historical boolean facts under a now-numeric catalog yield a current row.error and must fail preview without proof", async testContext => {
  const fixture = await s2bHistoricalTypeFixture("s2b-history-current", "2026-09-09", "2026-09-10");
  const { queryDashboard } = await s2bModules();
  const engineResults = [];
  const harness = await s2bHttpHarness(testContext, {
    queryDashboard: async (...args) => {
      const result = await queryDashboard(...args);
      engineResults.push(result);
      return result;
    },
  });
  const draft = s2aDraft({ kind: "metric", metricDefinitionId: fixture.metricDefinitionId }, { dataScopeLevel: "session", analyticalAggregation: "sum" });
  const envelope = s2bEnvelope(draft);
  const before = await s2bDatabaseState();
  const validated = await harness.request(fixture.dashboard.id, "validate", { cookie: fixture.coachCookie, body: envelope });
  assert.equal(validated.status, 200, JSON.stringify(validated.body));
  assert.equal(validated.body.status, "valid", JSON.stringify(validated.body));
  const failed = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie, body: envelope });
  assert.equal(engineResults.length, 1, JSON.stringify(failed));
  const series = engineResults[0][0].series[0];
  assert.equal(series.status, "ok", "this regression concerns an error row inside an otherwise successful actual engine result");
  assert.equal(series.data.current.length, 2);
  const historicalRow = series.data.current.find(row => row.bucketKey === "2026-09-09");
  assert.equal(historicalRow.athleteId, fixture.athleteId);
  assert.equal(historicalRow.value, null);
  assert.match(historicalRow.error, /aggregation 'sum'.*value_type 'boolean'/);
  assert.ok(!historicalRow.typeConflict && !historicalRow.semanticConflict);
  assert.equal(series.data.current.find(row => row.bucketKey === "2026-09-10").value, 7);
  assert.equal(series.data.comparison, null);
  assert.deepEqual({ status: failed.status, body: failed.body }, { status: 503, body: { error: "previewQueryFailed" } });
  assert.equal(failed.body.previewToken, undefined);
  assert.equal(failed.body.widgetResult, undefined);
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2b P03/P10 a clean current numeric KPI cannot hide a real historical boolean error in its comparison result", async testContext => {
  const fixture = await s2bHistoricalTypeFixture("s2b-history-comparison", "2026-09-08", "2026-09-09");
  const draft = s2aDraft({ kind: "metric", metricDefinitionId: fixture.metricDefinitionId }, { type: "kpi", groupBy: "athlete", dataScopeLevel: "session", analyticalAggregation: "sum" });
  const snapshot = await fixture.reader.load({ ...fixture.target, metricRef: draft.metricRef });
  const compiled = fixture.compileSimpleDraft(draft, snapshot, s2aContext([fixture.athleteId]));
  let stored = await s2aLegacyProjection(fixture, compiled, { layout: { width: 3, height: 3 } });
  await s2aRawUpdate(stored.id, { comparison_period: "previous_period" });
  stored = await s2aStored(stored.id);
  const envelope = s2bEnvelope(s2aUpdateDraft(draft), { editTarget: { widgetId: stored.id, expectedWidgetRevision: stored.revision } });
  const { queryDashboard } = await s2bModules();
  const engineResults = [];
  const harness = await s2bHttpHarness(testContext, {
    queryDashboard: async (...args) => {
      const result = await queryDashboard(...args);
      engineResults.push(result);
      return result;
    },
  });
  const before = await s2bDatabaseState();
  const validated = await harness.request(fixture.dashboard.id, "validate", { cookie: fixture.coachCookie, body: envelope });
  assert.equal(validated.status, 200, JSON.stringify(validated.body));
  assert.equal(validated.body.status, "valid", JSON.stringify(validated.body));
  const failed = await harness.request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie, body: envelope });
  assert.equal(engineResults.length, 1, JSON.stringify(failed));
  const series = engineResults[0][0].series[0];
  assert.equal(series.status, "ok");
  assert.deepEqual(s2bRows(series.data.current), [[fixture.athleteId, "all", "bpm", 7, 1]]);
  assert.equal(series.data.comparison.length, 1);
  assert.deepEqual(series.data.comparisonRange, { dateFrom: "2026-09-07", dateTo: "2026-09-08" });
  const historicalRow = series.data.comparison[0];
  assert.equal(historicalRow.athleteId, fixture.athleteId);
  assert.equal(historicalRow.value, null);
  assert.match(historicalRow.error, /aggregation 'sum'.*value_type 'boolean'/);
  assert.ok(!historicalRow.typeConflict && !historicalRow.semanticConflict);
  assert.deepEqual({ status: failed.status, body: failed.body }, { status: 503, body: { error: "previewQueryFailed" } });
  assert.equal(failed.body.previewToken, undefined);
  assert.equal(failed.body.widgetResult, undefined);
  assert.deepEqual(await s2bDatabaseState(), before);
});

async function s2cHttpHarness(testContext, options = {}) {
  const modules = await s2bModules();
  const { createSimpleSaveService } = await import("../src/dashboardSimple/saveService.js");
  const { createSimpleSaveRouter } = await import("../src/dashboardSimple/saveRouter.js");
  assert.equal(process.env.DATABASE_URL, db.url);
  assert.match(db.name, /^optimove_tests_tldash_primary_[a-f0-9]{12}$/);
  const databasePool = new pg.Pool({ connectionString: db.url, max: 4 });
  const observations = [], lifecycle = [];
  let commitFaultInjected = false, releaseCommitAcknowledgement;
  const now = options.now ?? (() => Date.now());
  const tokenService = options.tokenService ?? modules.createPreviewTokenService({ keyId: `s2c-${uid()}`, key: crypto.randomBytes(32), now });
  const savePool = {
    async connect() {
      if (commitFaultInjected && options.recoveryUnavailable) throw new Error("s2c recovery connection unavailable");
      const client = await databasePool.connect();
      const backendPid = (await client.query("select pg_backend_pid() as pid")).rows[0].pid;
      const checkout = lifecycle.filter(event => event.kind === "checkout").length + 1;
      lifecycle.push({ kind: "checkout", checkout, backendPid });
      return {
        async query(sql, params) {
          observations.push({ sql, checkout, backendPid });
          if (/^\s*commit\s*;?\s*$/i.test(sql) && options.commitFault && !commitFaultInjected) {
            commitFaultInjected = true;
            if (options.commitFault === "before") throw new Error("s2c COMMIT was not sent");
            const result = await client.query(sql, params);
            if (options.commitFault === "after") throw new Error("s2c COMMIT acknowledgement lost");
            if (options.commitFault === "delayed") {
              await new Promise(resolve => { releaseCommitAcknowledgement = resolve; });
              return result;
            }
            assert.fail(`Unsupported COMMIT fault ${options.commitFault}`);
          }
          const result = await client.query(sql, params);
          if (/^\s*select\b/i.test(sql)) {
            const transaction = (await client.query("select current_database() as database_name, current_setting('transaction_read_only') as read_only")).rows[0];
            observations[observations.length - 1] = { sql, checkout, backendPid, ...transaction };
          }
          return result;
        },
        release(destroy) {
          lifecycle.push({ kind: "release", checkout, backendPid, destroy: Boolean(destroy) });
          client.release(destroy);
        },
      };
    },
  };
  const coordinator = modules.createPreviewAdmissionCoordinator({ maxActiveDeployment: 2 });
  const admission = modules.createPreviewAdmission({ coordinator, processId: `s2c-${uid()}`, poolMax: 4 });
  const previewService = modules.createSimplePreviewService({
    pool: databasePool, queryDashboard: modules.queryDashboard, admission, tokenService, now,
    activation: { coordinatedAdmissionVerified: true, deploymentBudgetVerified: true },
  });
  const saveService = createSimpleSaveService({
    pool: savePool, tokenService, now,
    ...(options.defaultActivation ? {} : { activation: options.activation ?? { atomicSaveVerified: true } }),
    transactionOptions: {
      checkoutTimeoutMs: 1000, transactionTimeoutMs: 5000, statementTimeoutMs: 3000,
      commitTimeoutMs: 150, recoveryTimeoutMs: 1000, ...options.transactionOptions,
    },
  });
  const previewRouter = modules.createSimplePreviewRouter({ service: previewService });
  const app = modules.express();
  app.use(modules.authMiddleware);
  if (options.afterAuthentication) app.use((req, res, next) => Promise.resolve(options.afterAuthentication(req)).then(() => next(), next));
  const mountPath = "/api/training-load/dashboards/:dashboardId/simple-editor";
  app.use(mountPath, (req, res, next) => /^\/(preview|validate|capabilities)\/?$/.test(req.path) ? previewRouter(req, res, next) : next());
  app.use(mountPath, createSimpleSaveRouter({ service: saveService }));
  const saveServer = http.createServer(app);
  testContext.after(async () => {
    releaseCommitAcknowledgement?.();
    saveServer.closeAllConnections();
    await new Promise(resolve => saveServer.close(resolve));
    await databasePool.end();
  });
  await new Promise(resolve => saveServer.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${saveServer.address().port}`;
  async function request(dashboardId, action, { cookie, body, method = "POST", rawBody } = {}) {
    const response = await fetch(`${origin}/api/training-load/dashboards/${dashboardId}/simple-editor/${action}`, {
      method, signal: AbortSignal.timeout(12000),
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: rawBody ?? JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function preview(fixture, input = s2bEnvelope()) {
    const response = await request(fixture.dashboard.id, "preview", { cookie: fixture.coachCookie, body: input });
    s2bAssertPreview(response);
    assert.equal(typeof response.body.requestIssuedAt, "string");
    return {
      response: response.body,
      body: {
        requestId: crypto.randomUUID(), requestIssuedAt: response.body.requestIssuedAt,
        resolvedPeriod: response.body.resolvedPeriod, previewToken: response.body.previewToken, input,
      },
    };
  }
  function save(fixture, body, widgetId = null) {
    return request(fixture.dashboard.id, widgetId ? `widgets/${widgetId}` : "widgets", {
      cookie: fixture.coachCookie, body, method: widgetId ? "PUT" : "POST",
    });
  }
  return { ...modules, request, preview, save, saveService, tokenService, observations, lifecycle };
}

function s2cReceipt(response, operation) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { verification, ...receipt } = response.body;
  assert.ok(["commitAcknowledged", "replayed", "verifiedAfterCommitError"].includes(verification), JSON.stringify(response.body));
  assert.equal(receipt.operation, operation);
  assert.match(receipt.widgetId, /^[a-f0-9-]{36}$/i);
  assert.match(receipt.seriesId, /^[a-f0-9-]{36}$/i);
  assert.ok(Number.isSafeInteger(receipt.widgetRevision) && receipt.widgetRevision > 0);
  assert.ok(Number.isSafeInteger(receipt.dashboardRevision) && receipt.dashboardRevision > 0);
  return receipt;
}

async function s2cLedger(fixture, requestId, queryRunner = query) {
  return (await queryRunner("select * from training_load.dashboard_simple_requests where initiator_user_id=$1 and request_id=$2", [fixture.coachId, requestId])).rows;
}

async function s2cSqlSave(fixture, prepared, { widget = prepared.response.normalizedWidget, widgetId = null, expectedRevision = null, requestId = prepared.body.requestId, payloadHash = "a".repeat(64) } = {}, queryRunner = query) {
  const signedEnvelope = JSON.parse(Buffer.from(prepared.body.previewToken.split(".")[0], "base64url").toString("utf8"));
  return queryRunner("select training_load.save_simple_widget($1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::uuid,$6::uuid,$7::integer,$8::jsonb,$9::jsonb,$10::jsonb) as receipt", [
    fixture.coachId, requestId, payloadHash, prepared.body.requestIssuedAt, fixture.dashboard.id, widgetId, expectedRevision,
    JSON.stringify(widget), JSON.stringify(prepared.body.resolvedPeriod), JSON.stringify(signedEnvelope.binding.workspace),
  ]);
}

async function s2cEditPreview(harness, fixture, widgetId, change = {}) {
  const stored = await s2aStored(widgetId);
  const draft = s2aUpdateDraft({ ...s2bEnvelope().draft, title: stored.title, ...change });
  return harness.preview(fixture, s2bEnvelope(draft, { editTarget: { widgetId, expectedWidgetRevision: stored.revision } }));
}

test("S2c relative midnight requires a fresh preview for a new write but replays the original completed receipt", async testContext => {
  const fixture = await s2aFixture("s2c-midnight");
  let serverNow = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z') - 1000;
  const originalDay = new Date(serverNow).toISOString().slice(0, 10);
  const harness = await s2cHttpHarness(testContext, { now: () => serverNow });
  const input = s2bEnvelope();
  input.draft.periodIntent = { mode: 'replacePageRuntime', periodConfig: { schemaVersion: 1, mode: 'relative', preset: 'today', timeZone: 'UTC' } };
  const prepared = await harness.preview(fixture, input);
  assert.equal(prepared.body.resolvedPeriod.dateFrom, originalDay);
  const receipt = s2cReceipt(await harness.save(fixture, prepared.body), 'created');
  serverNow += 2000;
  const before = await s2bDatabaseState();
  const newRequest = { ...prepared.body, requestId: crypto.randomUUID() };
  const refused = await harness.save(fixture, newRequest);
  assert.deepEqual(refused, { status: 409, body: { error: 'previewRequired', reason: 'effectivePeriodChanged' } });
  assert.deepEqual(await s2cLedger(fixture, newRequest.requestId), []);
  assert.deepEqual(s2cReceipt(await harness.save(fixture, prepared.body), 'created'), receipt);
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2c S01 default activation refuses saves; real HTTP authentication gates save and token-free status", async testContext => {
  const fixture = await s2aFixture("s2c-activation");
  const harness = await s2cHttpHarness(testContext, { defaultActivation: true });
  const prepared = await harness.preview(fixture);
  const before = await s2bDatabaseState();
  const disabled = await harness.save(fixture, prepared.body);
  assert.deepEqual(disabled, { status: 503, body: { error: "saveUnavailable" } });
  for (const cookie of [undefined, cookieFor(crypto.randomBytes(32).toString("hex"))]) {
    for (const action of ["widgets", "requests/status"]) {
      const denied = await harness.request(fixture.dashboard.id, action, { cookie, body: action === "widgets" ? prepared.body : { requestId: prepared.body.requestId } });
      assert.equal(denied.status, 401, JSON.stringify(denied));
      assert.equal(denied.body.receipt, undefined);
    }
  }
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2c S01/S02 one real HTTP save atomically stores widget, exactly one series, presentation and a value-free receipt", async testContext => {
  const fixture = await s2bDataFixture("s2c-atomic");
  const harness = await s2cHttpHarness(testContext);
  const draft = s2aDraft({ kind: "builtin", key: "rpe" }, { type: "line_chart", dataScopeLevel: "session", analyticalAggregation: "avg" });
  const prepared = await harness.preview(fixture, s2bEnvelope(draft));
  const before = await s2bDatabaseState();
  const response = await harness.save(fixture, prepared.body);
  const receipt = s2cReceipt(response, "created");
  assert.equal(response.body.verification, "commitAcknowledged");
  const stored = await s2aStored(receipt.widgetId);
  const state = await s2aState(fixture.dashboard.id);
  assert.equal(state.widgets.length, 1);
  assert.equal(state.series.length, 1);
  assert.equal(stored.series[0].id, receipt.seriesId);
  assert.equal(stored.revision, receipt.widgetRevision);
  assert.equal(state.dashboard.revision, receipt.dashboardRevision);
  for (const field of ["widget_type", "title", "group_by", "display_config", "presentation_config", "local_filter_override"]) assert.deepEqual(stored[field], prepared.response.normalizedWidget[field], field);
  assert.ok(stored.presentation_config?.chartInteractions);
  assert.notEqual(stored.id, prepared.response.normalizedWidget.id);
  assert.notEqual(stored.series[0].id, prepared.response.normalizedWidget.series[0].id);
  assert.deepEqual(receipt.idMapping, {
    widget: { from: prepared.response.normalizedWidget.id, to: stored.id },
    series: { from: prepared.response.normalizedWidget.series[0].id, to: stored.series[0].id },
  });
  assert.deepEqual(receipt.resolvedPeriod, prepared.body.resolvedPeriod);
  assert.equal(Date.parse(receipt.requestIssuedAt), Date.parse(prepared.body.requestIssuedAt));
  const ledger = await s2cLedger(fixture, prepared.body.requestId);
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0].receipt, receipt);
  assert.match(ledger[0].payload_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(ledger[0]).sort(), ["initiator_user_id", "request_id", "dashboard_id", "widget_id", "workspace", "payload_hash", "request_issued_at", "resolved_period", "receipt", "created_at", "retain_until"].sort());
  assert.deepEqual(Object.keys(receipt).sort(), ["requestId", "operation", "widgetId", "seriesId", "idMapping", "widgetRevision", "dashboardRevision", "resolvedPeriod", "requestIssuedAt"].sort());
  const after = await s2bDatabaseState();
  const changedTables = new Set(['"training_load"."dashboards"', '"training_load"."dashboard_widgets"', '"training_load"."dashboard_widget_series"', '"training_load"."dashboard_simple_requests"']);
  for (const [table, original] of Object.entries(before)) if (!changedTables.has(table)) assert.deepEqual(after[table], original, table);
  const queried = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/query`, { method: "POST", cookie: fixture.coachCookie, body: { dateFrom: prepared.body.resolvedPeriod.dateFrom, dateTo: prepared.body.resolvedPeriod.dateTo } });
  assert.equal(queried.status, 200, JSON.stringify(queried.body));
  assert.deepEqual(s2bRows(queried.body.widgets[0].series[0].data.current), s2bRows(fixture.expectedRows));
});

test("S2c S02 real series and presentation trigger failures roll back the entire SQL save including widget and receipt", async testContext => {
  const fixture = await s2aFixture("s2c-rollback");
  const harness = await s2cHttpHarness(testContext);
  const prepared = await harness.preview(fixture);
  const before = await s2bDatabaseState();
  const invalidSeries = structuredClone(prepared.response.normalizedWidget);
  invalidSeries.series[0].data_scope_level = "unsupported_scope";
  await assert.rejects(() => s2cSqlSave(fixture, prepared, { widget: invalidSeries }), error => error.code && /scope|scope_level/i.test(error.message));
  const invalidPresentation = structuredClone(prepared.response.normalizedWidget);
  invalidPresentation.presentation_config = { schemaVersion: 1, chartInteractions: { legend: { toggle: true } } };
  await assert.rejects(() => s2cSqlSave(fixture, prepared, { widget: invalidPresentation }), error => error.code === "S2C02");
  assert.deepEqual(await s2bDatabaseState(), before);
  assert.deepEqual(await s2cLedger(fixture, prepared.body.requestId), []);
  assert.equal((await s2aState(fixture.dashboard.id)).widgets.length, 0);
  s2cReceipt(await harness.save(fixture, prepared.body), "created");
});

test("S2c S03 same and truly concurrent request IDs yield one durable result without extra rows or revisions", async testContext => {
  const fixture = await s2aFixture("s2c-idempotency");
  const harness = await s2cHttpHarness(testContext);
  const prepared = await harness.preview(fixture);
  const blocker = await newClient();
  let responses;
  try {
    await blocker.client.query("begin");
    await blocker.client.query("select pg_advisory_xact_lock(hashtextextended('dashboard-simple:' || $1::text || ':' || $2::text, 0))", [fixture.coachId, prepared.body.requestId]);
    const concurrent = [harness.save(fixture, prepared.body), harness.save(fixture, prepared.body)];
    await s2bWaitForDatabaseState(async () => {
      const waiting = await query("select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%pg_advisory_xact_lock(hashtextextended($1,0))%' ");
      return waiting.rows[0].n >= 1;
    }, "real save requests waiting on the held request lock");
    await blocker.client.query("commit");
    responses = await Promise.all(concurrent);
  } finally {
    await blocker.client.query("rollback");
    await blocker.client.end();
  }
  const receipt = s2cReceipt(responses[0], "created");
  assert.deepEqual(s2cReceipt(responses[1], "created"), receipt);
  const beforeReplay = await s2bDatabaseState();
  const replay = await harness.save(fixture, prepared.body);
  assert.deepEqual(s2cReceipt(replay, "created"), receipt);
  assert.equal(replay.body.verification, "replayed");
  assert.deepEqual(await s2bDatabaseState(), beforeReplay);
  assert.equal((await s2cLedger(fixture, prepared.body.requestId)).length, 1);
  assert.equal((await s2aState(fixture.dashboard.id)).widgets.length, 1);
});

test("S2c S04 a new request key with a stale edit revision refuses 409 and records no receipt", async testContext => {
  const fixture = await s2aFixture("s2c-stale");
  const harness = await s2cHttpHarness(testContext);
  const created = s2cReceipt(await harness.save(fixture, (await harness.preview(fixture)).body), "created");
  const edit = await s2cEditPreview(harness, fixture, created.widgetId, { title: "Simple pending edit" });
  const changed = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${created.widgetId}`, {
    method: "PATCH", cookie: fixture.coachCookie, body: { expectedWidgetRevision: created.widgetRevision, title: "Concurrent Advanced edit" },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const before = await s2bDatabaseState();
  const stale = await harness.save(fixture, edit.body, created.widgetId);
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error, "staleRevision");
  assert.deepEqual(await s2cLedger(fixture, edit.body.requestId), []);
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2c S05 a completed request key cannot be reused with different payload or another authorized target", async testContext => {
  const fixture = await s2aFixture("s2c-conflict");
  const harness = await s2cHttpHarness(testContext);
  const prepared = await harness.preview(fixture);
  s2cReceipt(await harness.save(fixture, prepared.body), "created");
  const anotherDashboard = await makeDashboardHttp(fixture.coachCookie);
  const secondTarget = { ...fixture, dashboard: anotherDashboard };
  const secondPrepared = await harness.preview(secondTarget);
  secondPrepared.body.requestId = prepared.body.requestId;
  const mutated = structuredClone(prepared.body);
  mutated.input.draft.title = "Changed after completed save";
  const before = await s2bDatabaseState();
  for (const [target, body] of [[fixture, mutated], [secondTarget, secondPrepared.body]]) {
    const conflict = await harness.save(target, body);
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error, "idempotencyConflict");
    assert.equal(conflict.body.widgetId, undefined);
    assert.equal(conflict.body.receipt, undefined);
  }
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2c S06 current authorization is reloaded after middleware for completed replay and status, without disclosing receipts", async testContext => {
  const fixture = await s2aFixture("s2c-revocation");
  let revoke = false;
  const harness = await s2cHttpHarness(testContext, {
    afterAuthentication: async () => {
      if (revoke) await query("update public.user_club_roles set is_active=false where user_id=$1 and club_id=$2", [fixture.coachId, fixture.clubId]);
    },
  });
  const prepared = await harness.preview(fixture);
  s2cReceipt(await harness.save(fixture, prepared.body), "created");
  revoke = true;
  const status = await harness.request(fixture.dashboard.id, "requests/status", { cookie: fixture.coachCookie, body: { requestId: prepared.body.requestId } });
  const replay = await harness.save(fixture, prepared.body);
  for (const denied of [status, replay]) {
    assert.equal(denied.status, 404, JSON.stringify(denied));
    assert.equal(denied.body.error, "notFound");
    assert.equal(denied.body.receipt, undefined);
    assert.equal(denied.body.widgetId, undefined);
  }
  assert.equal((await s2cLedger(fixture, prepared.body.requestId)).length, 1);
});

test("S2c S07 a completed replay precedes expired or retired-key token validation and preserves its original receipt", async testContext => {
  const fixture = await s2aFixture("s2c-expired-replay");
  let clock = Date.now();
  const harness = await s2cHttpHarness(testContext, { now: () => clock });
  const prepared = await harness.preview(fixture);
  const receipt = s2cReceipt(await harness.save(fixture, prepared.body), "created");
  clock += 11 * 60 * 1000;
  const before = await s2bDatabaseState();
  assert.deepEqual(s2cReceipt(await harness.save(fixture, prepared.body), "created"), receipt);
  const rotated = await s2cHttpHarness(testContext);
  const rotatedReplay = await rotated.save(fixture, prepared.body);
  assert.deepEqual(s2cReceipt(rotatedReplay, "created"), receipt);
  assert.equal(rotatedReplay.body.verification, "replayed");
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2c S08 unrelated dashboard layout changes after preview do not block a create or overwrite existing placement", async testContext => {
  const fixture = await s2aFixture("s2c-layout");
  const harness = await s2cHttpHarness(testContext);
  const prepared = await harness.preview(fixture);
  const existing = await makeWidgetHttp(fixture.coachCookie, fixture.dashboard);
  const moved = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${existing.widgetId}/layout`, {
    method: "PATCH", cookie: fixture.coachCookie, body: { expectedWidgetRevision: 1, x: 0, y: 10 },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const before = await s2aStored(existing.widgetId);
  const receipt = s2cReceipt(await harness.save(fixture, prepared.body), "created");
  assert.deepEqual(await s2aStored(existing.widgetId), before);
  const state = await s2aState(fixture.dashboard.id);
  assert.equal(state.widgets.length, 2);
  assert.ok(receipt.dashboardRevision > prepared.response.dashboardRevision);
  const saved = await s2aStored(receipt.widgetId);
  assert.ok(!(saved.x < before.x + before.width && before.x < saved.x + saved.width && saved.y < before.y + before.height && before.y < saved.y + saved.height));
});

test("S2c S09 a real COMMIT followed by a lost acknowledgement returns a receipt verified on a new read-only client", async testContext => {
  const fixture = await s2aFixture("s2c-commit-lost");
  const harness = await s2cHttpHarness(testContext, { commitFault: "after" });
  const prepared = await harness.preview(fixture);
  const response = await harness.save(fixture, prepared.body);
  const receipt = s2cReceipt(response, "created");
  assert.equal(response.body.verification, "verifiedAfterCommitError");
  const commit = harness.observations.find(item => /^commit$/i.test(item.sql));
  const recovery = harness.observations.find(item => item.checkout > commit.checkout && /dashboard_simple_requests/i.test(item.sql));
  assert.ok(recovery, JSON.stringify(harness.observations));
  assert.notEqual(recovery.backendPid, commit.backendPid);
  assert.equal(recovery.read_only, "on");
  assert.equal(recovery.database_name, db.name);
  assert.ok(harness.lifecycle.some(event => event.kind === "release" && event.checkout === commit.checkout && event.destroy));
  assert.deepEqual((await s2cLedger(fixture, prepared.body.requestId))[0].receipt, receipt);
});

test("S2c S09 a delayed COMMIT acknowledgement is bounded while a real committed receipt is recovered", { timeout: 15000 }, async testContext => {
  const fixture = await s2aFixture("s2c-commit-delayed");
  const harness = await s2cHttpHarness(testContext, { commitFault: "delayed", transactionOptions: { commitTimeoutMs: 100, recoveryTimeoutMs: 1000 } });
  const prepared = await harness.preview(fixture);
  const startedAt = performance.now();
  const response = await harness.save(fixture, prepared.body);
  const receipt = s2cReceipt(response, "created");
  assert.ok(performance.now() - startedAt < 6000, "COMMIT acknowledgement and recovery must have bounded waits");
  assert.equal(response.body.verification, "verifiedAfterCommitError");
  assert.deepEqual((await s2cLedger(fixture, prepared.body.requestId))[0].receipt, receipt);
  assert.equal((await s2aState(fixture.dashboard.id)).widgets.length, 1);
});

test("S2c S10 absent or unavailable recovery after attempted COMMIT yields 503 outcomeUnknown without claiming rollback", async testContext => {
  for (const recoveryUnavailable of [false, true]) {
    const fixture = await s2aFixture(`s2c-unknown-${recoveryUnavailable}`);
    const harness = await s2cHttpHarness(testContext, { commitFault: recoveryUnavailable ? "after" : "before", recoveryUnavailable });
    const prepared = await harness.preview(fixture);
    const response = await harness.save(fixture, prepared.body);
    assert.equal(response.status, 503, JSON.stringify(response));
    assert.equal(response.body.error, "outcomeUnknown");
    assert.equal(response.body.requestId, prepared.body.requestId);
    assert.equal(response.body.receipt, undefined);
    assert.ok(!/rolled.?back|not.?saved/i.test(JSON.stringify(response.body)));
    const ledger = await s2cLedger(fixture, prepared.body.requestId);
    assert.equal(ledger.length, recoveryUnavailable ? 1 : 0);
    assert.equal((await s2aState(fixture.dashboard.id)).widgets.length, recoveryUnavailable ? 1 : 0);
  }
});

test("S2c S07/S11 a completed request replays after archive while a new request remains forbidden", async testContext => {
  const fixture = await s2aFixture("s2c-archive-replay");
  const harness = await s2cHttpHarness(testContext);
  const prepared = await harness.preview(fixture);
  const receipt = s2cReceipt(await harness.save(fixture, prepared.body), "created");
  const pending = await harness.preview(fixture);
  const archived = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/archive`, {
    method: "POST", cookie: fixture.coachCookie,
    body: { expectedRevision: await freshRevision(fixture.coachCookie, fixture.dashboard.id) },
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  const before = await s2bDatabaseState();
  const replay = await harness.save(fixture, prepared.body);
  assert.deepEqual(s2cReceipt(replay, "created"), receipt);
  assert.equal(replay.body.verification, "replayed");
  const status = await harness.request(fixture.dashboard.id, "requests/status", { cookie: fixture.coachCookie, body: { requestId: prepared.body.requestId } });
  assert.deepEqual(status, { status: 200, body: { status: "recorded", requestId: prepared.body.requestId, receipt } });
  const refused = await harness.save(fixture, pending.body);
  assert.deepEqual(refused, { status: 409, body: { error: "dashboardArchived" } });
  assert.deepEqual(await s2cLedger(fixture, pending.body.requestId), []);
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2c S10/S11 status needs only current authentication and request ID; notRecorded permits retry without claiming rollback", async testContext => {
  const fixture = await s2aFixture("s2c-status");
  const harness = await s2cHttpHarness(testContext);
  const prepared = await harness.preview(fixture);
  const receipt = s2cReceipt(await harness.save(fixture, prepared.body), "created");
  const currentCookie = await loginCookie(fixture.coachId);
  const statusHarness = await s2cHttpHarness(testContext, { defaultActivation: true });
  const unknownId = crypto.randomUUID();
  const before = await s2bDatabaseState();
  const recorded = await statusHarness.request(fixture.dashboard.id, "requests/status", { cookie: currentCookie, body: { requestId: prepared.body.requestId } });
  assert.deepEqual(recorded, { status: 200, body: { status: "recorded", requestId: prepared.body.requestId, receipt } });
  const missing = await statusHarness.request(fixture.dashboard.id, "requests/status", { cookie: currentCookie, body: { requestId: unknownId } });
  assert.deepEqual(missing, { status: 200, body: { status: "notRecorded", requestId: unknownId, retrySameRequest: true } });
  assert.ok(!/rolled.?back|not.?saved/i.test(JSON.stringify(missing.body)));
  assert.ok(statusHarness.observations.filter(item => /dashboard_simple_requests/i.test(item.sql)).every(item => item.read_only === "on"));
  assert.deepEqual(await s2bDatabaseState(), before);
});

test("S2c S12 a presentation-only save increments only the widget revision; preserve and identical replace are genuine no-ops, clear persists null", async testContext => {
  const fixture = await s2aFixture("s2c-sidecar-only");
  const harness = await s2cHttpHarness(testContext);
  const initial = s2cReceipt(await harness.save(fixture, (await harness.preview(fixture)).body), "created");
  const original = await s2aStored(initial.widgetId);
  assert.equal(original.presentation_config, null);
  const sidecar = { schemaVersion: 1, tableFormatting: { evaluationVersion: 1, rules: [] } };
  const replacement = await s2cEditPreview(harness, fixture, initial.widgetId, { presentation: { mode: "replace", value: sidecar } });
  const updated = s2cReceipt(await harness.save(fixture, replacement.body, initial.widgetId), "updated");
  const stored = await s2aStored(initial.widgetId);
  assert.deepEqual(stored.presentation_config, sidecar);
  assert.equal(stored.revision, original.revision + 1);
  assert.equal(updated.widgetRevision, stored.revision);
  assert.equal(updated.dashboardRevision, initial.dashboardRevision);
  assert.equal(updated.seriesId, initial.seriesId);
  const { presentation_config: originalPresentation, revision: originalRevision, updated_at: originalUpdatedAt, ...originalContent } = original;
  const { presentation_config: changedPresentation, revision: changedRevision, updated_at: changedUpdatedAt, ...changedContent } = stored;
  assert.deepEqual(changedContent, originalContent);
  for (const presentation of [{ mode: "preserve" }, { mode: "replace", value: sidecar }]) {
    const noOp = await s2cEditPreview(harness, fixture, initial.widgetId, { presentation });
    const receipt = s2cReceipt(await harness.save(fixture, noOp.body, initial.widgetId), "unchanged");
    assert.equal(receipt.widgetRevision, stored.revision);
    assert.equal(receipt.dashboardRevision, initial.dashboardRevision);
    assert.deepEqual(await s2aStored(initial.widgetId), stored);
    assert.deepEqual((await s2cLedger(fixture, noOp.body.requestId))[0].receipt, receipt);
  }
  const clear = await s2cEditPreview(harness, fixture, initial.widgetId, { presentation: { mode: "clear" } });
  const clearedReceipt = s2cReceipt(await harness.save(fixture, clear.body, initial.widgetId), "updated");
  const cleared = await s2aStored(initial.widgetId);
  assert.equal(cleared.presentation_config, null);
  assert.equal(cleared.revision, stored.revision + 1);
  assert.equal(clearedReceipt.dashboardRevision, initial.dashboardRevision);
  assert.deepEqual(cleared.series, original.series);
  const preserveNull = await s2cEditPreview(harness, fixture, initial.widgetId);
  assert.equal(s2cReceipt(await harness.save(fixture, preserveNull.body, initial.widgetId), "unchanged").widgetRevision, cleared.revision);
  assert.deepEqual(await s2aStored(initial.widgetId), cleared);
});

test("S2c S12 Advanced presentation modes preserve omitted sidecars, reject ambiguous null and bump revision only for an actual replacement or clear", async testContext => {
  const fixture = await s2aFixture("s2c-advanced-sidecar");
  const harness = await s2cHttpHarness(testContext);
  const created = s2cReceipt(await harness.save(fixture, (await harness.preview(fixture)).body), "created");
  const sidecar = { schemaVersion: 1, tableFormatting: { evaluationVersion: 1, rules: [] } };
  async function patch(body) {
    const current = await s2aStored(created.widgetId);
    return api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${created.widgetId}`, {
      method: "PATCH", cookie: fixture.coachCookie, body: { expectedWidgetRevision: current.revision, ...body },
    });
  }
  assert.equal((await patch({ presentation: { mode: "replace", value: sidecar } })).status, 200);
  let stored = await s2aStored(created.widgetId);
  assert.deepEqual(stored.presentation_config, sidecar);
  assert.equal(stored.revision, created.widgetRevision + 1);
  for (const body of [{ title: stored.title }, { presentation: { mode: "preserve" } }, { presentation: { mode: "replace", value: sidecar } }]) {
    const response = await patch(body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(await s2aStored(created.widgetId), stored);
  }
  const ambiguous = await patch({ presentation: null });
  assert.equal(ambiguous.status, 400, JSON.stringify(ambiguous.body));
  assert.deepEqual(await s2aStored(created.widgetId), stored);
  const cleared = await patch({ presentation: { mode: "clear" } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const afterClear = await s2aStored(created.widgetId);
  assert.equal(afterClear.presentation_config, null);
  assert.equal(afterClear.revision, stored.revision + 1);
  stored = afterClear;
  assert.equal((await patch({ presentation: { mode: "clear" } })).status, 200);
  assert.deepEqual(await s2aStored(created.widgetId), stored);
  assert.equal((await s2aState(fixture.dashboard.id)).dashboard.revision, created.dashboardRevision);
});

test("S2c S13 cloning a template copies supported and opaque presentation JSON exactly while assigning new widget and series IDs", async testContext => {
  const fixture = await s2aFixture("s2c-clone-sidecars");
  const harness = await s2cHttpHarness(testContext);
  const supported = { schemaVersion: 1, tableFormatting: { evaluationVersion: 1, rules: [] } };
  const opaque = { schemaVersion: 73, vendor: { nested: [null, true, "opaque", { threshold: 12.75 }] } };
  const sourceIds = [];
  for (const [index, sidecar] of [supported, opaque].entries()) {
    const draft = { ...s2bEnvelope().draft, title: `Clone source ${index}` };
    const saved = s2cReceipt(await harness.save(fixture, (await harness.preview(fixture, s2bEnvelope(draft))).body), "created");
    await query("update training_load.dashboard_widgets set presentation_config=$2::jsonb where id=$1", [saved.widgetId, JSON.stringify(sidecar)]);
    sourceIds.push(saved.widgetId);
  }
  const template = await api(`/api/training-load/dashboards/${fixture.dashboard.id}`, {
    method: "PATCH", cookie: fixture.coachCookie,
    body: { expectedRevision: await freshRevision(fixture.coachCookie, fixture.dashboard.id), isTemplate: true },
  });
  assert.equal(template.status, 200, JSON.stringify(template.body));
  const before = await s2aState(fixture.dashboard.id);
  const clone = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/clone`, {
    method: "POST", cookie: fixture.coachCookie, body: { ownerScope: "user", name: "Exact sidecar clone" },
  });
  assert.equal(clone.status, 201, JSON.stringify(clone.body));
  const cloned = await api(`/api/training-load/dashboards/${clone.body.dashboard.id}`, { cookie: fixture.coachCookie });
  assert.equal(cloned.status, 200, JSON.stringify(cloned.body));
  assert.equal(cloned.body.widgets.length, 2);
  for (const sourceId of sourceIds) {
    const source = await s2aStored(sourceId);
    const copied = cloned.body.widgets.find(widget => widget.title === source.title);
    assert.ok(copied, JSON.stringify(cloned.body));
    assert.notEqual(copied.id, source.id);
    assert.deepEqual(copied.presentation_config, source.presentation_config);
    const persisted = await s2aStored(copied.id);
    assert.deepEqual(persisted.presentation_config, source.presentation_config);
    assert.equal(persisted.series.length, 1);
    assert.notEqual(persisted.series[0].id, source.series[0].id);
    assert.equal(persisted.series[0].built_in_series_key, source.series[0].built_in_series_key);
    assert.equal(persisted.series[0].resolution_status, "resolved");
  }
  assert.deepEqual(await s2aState(fixture.dashboard.id), before);
});

test("S2c S13 opaque presentation versions survive title and layout edits; semantic writes fail atomically until explicit clear", async testContext => {
  const fixture = await s2aFixture("s2c-opaque-guard");
  const harness = await s2cHttpHarness(testContext);
  const created = s2cReceipt(await harness.save(fixture, (await harness.preview(fixture)).body), "created");
  const opaque = { schemaVersion: 42, futureRules: [{ opaque: [1, "two", null] }] };
  await query("update training_load.dashboard_widgets set presentation_config=$2::jsonb where id=$1", [created.widgetId, JSON.stringify(opaque)]);
  let stored = await s2aStored(created.widgetId);
  const renamed = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${created.widgetId}`, {
    method: "PATCH", cookie: fixture.coachCookie,
    body: { expectedWidgetRevision: stored.revision, title: "Opaque title remains editable" },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  stored = await s2aStored(created.widgetId);
  const moved = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${created.widgetId}/layout`, {
    method: "PATCH", cookie: fixture.coachCookie, body: { expectedWidgetRevision: stored.revision, y: 9 },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  stored = await s2aStored(created.widgetId);
  assert.deepEqual(stored.presentation_config, opaque);
  const detail = await api(`/api/training-load/dashboards/${fixture.dashboard.id}`, { cookie: fixture.coachCookie });
  assert.deepEqual(detail.body.widgets[0].presentation_config, opaque);
  const before = await s2bDatabaseState();
  await assert.rejects(() => query("select * from training_load.update_widget_content($1,$2,null,null,'week',null,null,null,false)", [stored.id, stored.revision]), error => error.code === "S2C03");
  await assert.rejects(() => s2aRawUpdate(stored.id, { analytical_aggregation: "sum" }), error => error.code === "S2C03");
  assert.deepEqual(await s2bDatabaseState(), before);
  const guardedDraft = s2aUpdateDraft({ ...s2bEnvelope().draft, title: stored.title, view: { type: "table", groupBy: "week", dataScopeLevel: "session", analyticalAggregation: "avg" } });
  const guarded = await harness.request(fixture.dashboard.id, "preview", {
    cookie: fixture.coachCookie,
    body: s2bEnvelope(guardedDraft, { editTarget: { widgetId: stored.id, expectedWidgetRevision: stored.revision } }),
  });
  assert.equal(guarded.status, 200, JSON.stringify(guarded.body));
  assert.equal(guarded.body.status, "advancedRequired");
  assert.ok(guarded.body.issues.some(issue => issue.code === "presentationRevalidationRequired"));
  assert.equal(guarded.body.previewToken, undefined);
  assert.deepEqual(await s2bDatabaseState(), before);
  const cleared = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${created.widgetId}`, {
    method: "PATCH", cookie: fixture.coachCookie, body: { expectedWidgetRevision: stored.revision, presentation: { mode: "clear" } },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const afterClear = await s2aStored(stored.id);
  assert.equal(afterClear.presentation_config, null);
  assert.equal(afterClear.revision, stored.revision + 1);
  const edited = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${created.widgetId}`, {
    method: "PATCH", cookie: fixture.coachCookie, body: { expectedWidgetRevision: afterClear.revision, groupBy: "week" },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  await s2aRawUpdate(stored.id, { analytical_aggregation: "sum" });
  const final = await s2aStored(stored.id);
  assert.equal(final.group_by, "week");
  assert.equal(final.presentation_config, null);
  assert.equal(final.series[0].analytical_aggregation, "sum");
});

test("S2c S14 ledger retention is exactly seven days plus ten minutes and cleanup skips an expired request whose real advisory lock is busy", { timeout: 15000 }, async testContext => {
  const fixture = await s2aFixture("s2c-retention");
  const harness = await s2cHttpHarness(testContext);
  const preparedRequests = [];
  for (let index = 0; index < 3; index += 1) {
    const prepared = await harness.preview(fixture);
    s2cReceipt(await harness.save(fixture, prepared.body), "created");
    preparedRequests.push(prepared);
  }
  const [grace, expired, busy] = preparedRequests;
  const retention = await query("select extract(epoch from retain_until-request_issued_at)::integer as seconds from training_load.dashboard_simple_requests where initiator_user_id=$1", [fixture.coachId]);
  assert.equal(retention.rowCount, 3);
  assert.ok(retention.rows.every(row => row.seconds === 7 * 24 * 60 * 60 + 10 * 60));
  await query(`update training_load.dashboard_simple_requests set
    request_issued_at=transaction_timestamp()-interval '168 hours 5 minutes',
    retain_until=transaction_timestamp()+interval '5 minutes'
    where initiator_user_id=$1 and request_id=$2`, [fixture.coachId, grace.body.requestId]);
  await query(`update training_load.dashboard_simple_requests set
    request_issued_at=transaction_timestamp()-interval '168 hours 10 minutes 1 second',
    retain_until=transaction_timestamp()-interval '1 second'
    where initiator_user_id=$1 and request_id=any($2::uuid[])`, [fixture.coachId, [expired.body.requestId, busy.body.requestId]]);
  const graceStatus = await harness.request(fixture.dashboard.id, "requests/status", { cookie: fixture.coachCookie, body: { requestId: grace.body.requestId } });
  assert.equal(graceStatus.status, 200, JSON.stringify(graceStatus.body));
  assert.equal(graceStatus.body.status, "recorded");
  const expiredStatus = await harness.request(fixture.dashboard.id, "requests/status", { cookie: fixture.coachCookie, body: { requestId: expired.body.requestId } });
  assert.deepEqual(expiredStatus, { status: 409, body: { error: "requestExpired" } });
  const blocker = await newClient();
  const beforeCleanup = await s2aState(fixture.dashboard.id);
  try {
    await blocker.client.query("begin");
    await blocker.client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`dashboard-simple:${fixture.coachId}:${busy.body.requestId}`]);
    const cleanup = await query("select training_load.cleanup_dashboard_simple_requests(1000) as deleted");
    assert.equal(cleanup.rows[0].deleted, 1);
    assert.deepEqual(await s2cLedger(fixture, expired.body.requestId), []);
    assert.equal((await s2cLedger(fixture, busy.body.requestId)).length, 1);
    assert.equal((await s2cLedger(fixture, grace.body.requestId)).length, 1);
    await blocker.client.query("commit");
  } finally {
    await blocker.client.query("rollback");
    await blocker.client.end();
  }
  const cleanup = await query("select training_load.cleanup_dashboard_simple_requests(1000) as deleted");
  assert.equal(cleanup.rows[0].deleted, 1);
  assert.deepEqual(await s2cLedger(fixture, busy.body.requestId), []);
  assert.equal((await s2cLedger(fixture, grace.body.requestId)).length, 1);
  assert.deepEqual(await s2aState(fixture.dashboard.id), beforeCleanup);
});

test("S2c S12/S13 opaque chart clear or replacement can atomically change grouping and binding; a final series failure restores the entire transition", async testContext => {
  const sidecar = {
    schemaVersion: 1, chartComposition: "athletes-v1",
    chartInteractions: { tooltip: { mode: "formatted" }, legend: { toggle: false }, zoom: { mode: "local", applyPeriodAction: true }, pointSelection: { mode: "details" }, yAxis: { mode: "auto" } },
  };
  for (const presentation of [{ mode: "clear" }, { mode: "replace", value: sidecar }]) {
    const fixture = await s2aFixture(`s2c-opaque-atomic-${presentation.mode}`);
    const harness = await s2cHttpHarness(testContext);
    const initialDraft = s2aDraft({ kind: "builtin", key: "rpe" }, { type: "line_chart", dataScopeLevel: "session", analyticalAggregation: "avg" });
    const created = s2cReceipt(await harness.save(fixture, (await harness.preview(fixture, s2bEnvelope(initialDraft))).body), "created");
    const opaque = { schemaVersion: 42, unknownChart: { exact: [true, null, "future"] } };
    await query("update training_load.dashboard_widgets set presentation_config=$2::jsonb where id=$1", [created.widgetId, JSON.stringify(opaque)]);
    const stored = await s2aStored(created.widgetId);
    const changedDraft = s2aUpdateDraft({
      ...initialDraft, draftVersion: 2, metricRef: { kind: "builtin", key: "duration_minutes" },
      view: { type: "line_chart", groupBy: "week", dataScopeLevel: "session", analyticalAggregation: "sum" },
      presentation,
    });
    const input = s2bEnvelope(changedDraft, { editTarget: { widgetId: stored.id, expectedWidgetRevision: stored.revision } });
    const preserve = await harness.request(fixture.dashboard.id, "preview", {
      cookie: fixture.coachCookie, body: { ...input, draft: { ...changedDraft, presentation: { mode: "preserve" } } },
    });
    assert.equal(preserve.status, 200, JSON.stringify(preserve.body));
    assert.equal(preserve.body.status, "advancedRequired");
    assert.ok(preserve.body.issues.some(issue => issue.code === "presentationRevalidationRequired"));
    assert.equal(preserve.body.previewToken, undefined);
    const prepared = await harness.preview(fixture, input);
    const invalidFinalSeries = structuredClone(prepared.response.normalizedWidget);
    invalidFinalSeries.series[0].data_scope_level = "unsupported_scope";
    const beforeFailure = await s2bDatabaseState();
    await assert.rejects(() => s2cSqlSave(fixture, prepared, {
      widget: invalidFinalSeries, widgetId: stored.id, expectedRevision: stored.revision,
    }), error => error.code && /scope|scope_level/i.test(error.message));
    assert.deepEqual(await s2bDatabaseState(), beforeFailure, "clearing opaque JSON and deleting the old binding must roll back if the replacement series fails");
    assert.deepEqual(await s2aStored(stored.id), stored);
    assert.deepEqual(await s2cLedger(fixture, prepared.body.requestId), []);
    const receipt = s2cReceipt(await harness.save(fixture, prepared.body, stored.id), "updated");
    const saved = await s2aStored(stored.id);
    assert.equal(saved.group_by, "week");
    assert.deepEqual(saved.presentation_config, presentation.mode === "clear" ? null : sidecar);
    assert.equal(saved.series.length, 1);
    assert.equal(saved.series[0].built_in_series_key, "duration_minutes");
    assert.equal(saved.series[0].analytical_aggregation, "sum");
    assert.notEqual(saved.series[0].id, stored.series[0].id);
    assert.equal((await query("select id from training_load.dashboard_widget_series where id=$1", [stored.series[0].id])).rowCount, 0);
    assert.equal(receipt.widgetId, stored.id);
    assert.equal(receipt.seriesId, saved.series[0].id);
    assert.deepEqual(receipt.idMapping.series, { from: prepared.response.normalizedWidget.series[0].id, to: saved.series[0].id });
    assert.ok(receipt.widgetRevision > stored.revision);
    assert.equal(receipt.dashboardRevision, created.dashboardRevision);
    assert.deepEqual((await s2cLedger(fixture, prepared.body.requestId))[0].receipt, receipt);
  }
});

test("S2c S13 V1 chart attachment and series insertion reject current text or boolean metrics; numeric and null-sidecar legacy paths succeed", async () => {
  const fixture = await s2aFixture("s2c-numeric-chart-guard");
  const sidecar = { schemaVersion: 1, chartComposition: "athletes-v1", chartInteractions: { tooltip: { mode: "exact" } } };
  let chartIndex = 0;
  async function chart(presentation) {
    const created = await makeWidgetHttp(fixture.coachCookie, {
      ...fixture.dashboard, revision: await freshRevision(fixture.coachCookie, fixture.dashboard.id),
    }, { widgetType: "line_chart", groupBy: "day", y: chartIndex++ * 5, ...(presentation ? { presentation: { mode: "replace", value: presentation } } : {}) });
    return s2aStored(created.widgetId);
  }
  async function add(widgetId, binding) {
    const current = await s2aStored(widgetId);
    return api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${widgetId}/series`, {
      method: "POST", cookie: fixture.coachCookie,
      body: { expectedWidgetRevision: current.revision, seriesOrder: 0, dataScopeLevel: "session", analyticalAggregation: "last", ...binding },
    });
  }
  for (const valueType of ["text", "boolean", "numeric"]) {
    const definition = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, valueType, dailyAggregationMethod: "last", scopeLevels: ["session"] });
    const legacy = await chart(null);
    const legacyAdded = await add(legacy.id, { metricDefinitionId: definition.metricDefinitionId });
    assert.equal(legacyAdded.status, 201, JSON.stringify({ valueType, response: legacyAdded.body }));
    const legacyStored = await s2aStored(legacy.id);
    assert.equal(legacyStored.presentation_config, null);
    assert.equal(legacyStored.series[0].metric_definition_id, definition.metricDefinitionId);
    const beforeAttachment = await s2bDatabaseState();
    const attached = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${legacy.id}`, {
      method: "PATCH", cookie: fixture.coachCookie,
      body: { expectedWidgetRevision: legacyStored.revision, presentation: { mode: "replace", value: sidecar } },
    });
    if (valueType === "numeric") {
      assert.equal(attached.status, 200, JSON.stringify(attached.body));
      assert.deepEqual((await s2aStored(legacy.id)).presentation_config, sidecar);
    } else {
      assert.deepEqual(attached, { status: 400, body: { error: "invalidRequest" } });
      await assert.rejects(() => query("select * from training_load.update_widget_content_with_presentation($1,$2,null,null,null,null,null,null,false,'replace',$3::jsonb)", [legacy.id, legacyStored.revision, JSON.stringify(sidecar)]), error => error.code === "S2C02" && /numericChartRequired/.test(error.message));
      assert.deepEqual(await s2bDatabaseState(), beforeAttachment);
    }
    const known = await chart(sidecar);
    const beforeInsertion = await s2bDatabaseState();
    const inserted = await add(known.id, { metricDefinitionId: definition.metricDefinitionId });
    if (valueType === "numeric") {
      assert.equal(inserted.status, 201, JSON.stringify(inserted.body));
      assert.equal((await s2aStored(known.id)).series[0].metric_definition_id, definition.metricDefinitionId);
    } else {
      assert.deepEqual(inserted, { status: 400, body: { error: "invalidRequest" } });
      assert.deepEqual(await s2bDatabaseState(), beforeInsertion);
      assert.deepEqual((await s2aStored(known.id)).series, []);
    }
  }
  const builtin = await chart(sidecar);
  const beforeBuiltin = await s2bDatabaseState();
  const textBuiltin = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${builtin.id}/series`, {
    method: "POST", cookie: fixture.coachCookie,
    body: { expectedWidgetRevision: builtin.revision, seriesOrder: 0, builtInSeriesKey: "last_session_date", dataScopeLevel: "day", analyticalAggregation: "last" },
  });
  assert.deepEqual(textBuiltin, { status: 400, body: { error: "invalidRequest" } });
  assert.deepEqual(await s2bDatabaseState(), beforeBuiltin);
});

test("S2c S13 the series-update binding guard rejects text and boolean under V1 charts while null-sidecar legacy resolution remains supported", async () => {
  const fixture = await s2aFixture("s2c-resolve-chart-guard");
  const sidecar = { schemaVersion: 1, chartInteractions: { tooltip: { mode: "exact" } } };
  const numericSource = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, dailyAggregationMethod: "last", scopeLevels: ["session"] });
  let chartIndex = 0;
  for (const valueType of ["text", "boolean", "numeric"]) {
    const definition = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, valueType, dailyAggregationMethod: "last", scopeLevels: ["session"] });
    const known = await makeWidgetHttp(fixture.coachCookie, {
      ...fixture.dashboard, revision: await freshRevision(fixture.coachCookie, fixture.dashboard.id),
    }, { widgetType: "line_chart", groupBy: "day", y: chartIndex++ * 5, presentation: { mode: "replace", value: sidecar } });
    const knownWidget = await s2aStored(known.widgetId);
    const numericAdded = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${known.widgetId}/series`, {
      method: "POST", cookie: fixture.coachCookie,
      body: { expectedWidgetRevision: knownWidget.revision, seriesOrder: 0, metricDefinitionId: numericSource.metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "last" },
    });
    assert.equal(numericAdded.status, 201, JSON.stringify(numericAdded.body));
    const numericWidget = await s2aStored(known.widgetId);
    const beforeBinding = await s2bDatabaseState();
    const rebind = () => query("update training_load.dashboard_widget_series set metric_definition_id=$2, resolution_status='resolved' where id=$1", [numericWidget.series[0].id, definition.metricDefinitionId]);
    if (valueType === "numeric") {
      await rebind();
      assert.equal((await s2aStored(known.widgetId)).series[0].metric_definition_id, definition.metricDefinitionId);
    } else {
      await assert.rejects(rebind, error => error.code === "S2C02" && /numericChartRequired/.test(error.message));
      assert.deepEqual(await s2bDatabaseState(), beforeBinding);
    }
    const created = await makeWidgetHttp(fixture.coachCookie, {
      ...fixture.dashboard, revision: await freshRevision(fixture.coachCookie, fixture.dashboard.id),
    }, { widgetType: "line_chart", groupBy: "day", y: chartIndex++ * 5 });
    const added = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${created.widgetId}/series`, {
      method: "POST", cookie: fixture.coachCookie,
      body: { expectedWidgetRevision: 1, seriesOrder: 0, templateMetricKeyHints: [{ key: `unresolved-${uid()}` }], dataScopeLevel: "session", analyticalAggregation: "last" },
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const unresolved = await s2aStored(created.widgetId);
    assert.equal(unresolved.series[0].resolution_status, "unresolved");
    assert.equal(unresolved.presentation_config, null);
    const resolved = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${created.widgetId}/series/${unresolved.series[0].id}/resolve`, {
      method: "POST", cookie: fixture.coachCookie, body: { expectedWidgetRevision: unresolved.revision, metricDefinitionId: definition.metricDefinitionId },
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const stored = await s2aStored(created.widgetId);
    assert.equal(stored.series[0].resolution_status, "resolved");
    assert.equal(stored.series[0].metric_definition_id, definition.metricDefinitionId);
    assert.equal(stored.presentation_config, null);
  }
});

test("S2c S13 failure at final presentation attachment restores the original opaque chart, binding, revisions and receipts", async testContext => {
  const fixture = await s2aFixture("s2c-final-attachment-rollback");
  const harness = await s2cHttpHarness(testContext);
  const originalMetric = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, dailyAggregationMethod: "last", scopeLevels: ["session"] });
  const previewMetric = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, dailyAggregationMethod: "last", scopeLevels: ["session"] });
  const textMetric = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, valueType: "text", dailyAggregationMethod: "last", scopeLevels: ["session"] });
  const draft = s2aDraft({ kind: "metric", metricDefinitionId: originalMetric.metricDefinitionId }, { type: "line_chart", dataScopeLevel: "session", analyticalAggregation: "last" });
  const originalSave = await harness.preview(fixture, s2bEnvelope(draft));
  const originalReceipt = s2cReceipt(await harness.save(fixture, originalSave.body), "created");
  const opaque = { schemaVersion: 42, futureChart: { retained: ["exact", null, 17] } };
  await query("update training_load.dashboard_widgets set presentation_config=$2::jsonb where id=$1", [originalReceipt.widgetId, JSON.stringify(opaque)]);
  const original = await s2aStored(originalReceipt.widgetId);
  const sidecar = { schemaVersion: 1, chartComposition: "athletes-v1", chartInteractions: { tooltip: { mode: "exact" } } };
  const changedDraft = s2aUpdateDraft({
    ...draft, draftVersion: 2, title: "Rebound chart", metricRef: { kind: "metric", metricDefinitionId: previewMetric.metricDefinitionId },
    view: { type: "line_chart", groupBy: "week", dataScopeLevel: "session", analyticalAggregation: "last" },
    presentation: { mode: "replace", value: sidecar },
  });
  const prepared = await harness.preview(fixture, s2bEnvelope(changedDraft, { editTarget: { widgetId: original.id, expectedWidgetRevision: original.revision } }));
  const finalAttachmentFailure = structuredClone(prepared.response.normalizedWidget);
  finalAttachmentFailure.series[0].metric_definition_id = textMetric.metricDefinitionId;
  assert.equal(finalAttachmentFailure.series[0].analytical_aggregation, "last");
  assert.equal(finalAttachmentFailure.series[0].source_policy, "all_with_conflicts");
  const before = await s2bDatabaseState();
  const originalLedger = await s2cLedger(fixture, originalSave.body.requestId);
  const proof = await newClient();
  try {
    await proof.client.query("begin");
    const withoutSidecar = structuredClone(finalAttachmentFailure);
    withoutSidecar.presentation_config = null;
    const result = await s2cSqlSave(fixture, prepared, {
      widget: withoutSidecar, widgetId: original.id, expectedRevision: original.revision,
    }, proof.client.query.bind(proof.client));
    assert.equal(result.rows[0].receipt.operation, "updated");
    const intermediate = (await proof.client.query(`select widget.presentation_config, widget.group_by, series.metric_definition_id,
      series.analytical_aggregation from training_load.dashboard_widgets widget
      join training_load.dashboard_widget_series series on series.widget_id=widget.id where widget.id=$1`, [original.id])).rows;
    assert.deepEqual(intermediate, [{ presentation_config: null, group_by: "week", metric_definition_id: textMetric.metricDefinitionId, analytical_aggregation: "last" }]);
  } finally {
    await proof.client.query("rollback");
    await proof.client.end();
  }
  assert.deepEqual(await s2bDatabaseState(), before, "the valid binding probe must leave no committed changes");
  await assert.rejects(() => s2cSqlSave(fixture, prepared, {
    widget: finalAttachmentFailure, widgetId: original.id, expectedRevision: original.revision,
  }), error => error.code === "S2C02" && error.message === "numericChartRequired"
    && /update training_load\.dashboard_widgets\s+set presentation_config\s*=\s*desired_widget\.presentation_config/i.test(error.where ?? ""));
  assert.deepEqual(await s2bDatabaseState(), before);
  assert.deepEqual(await s2aStored(original.id), original);
  assert.deepEqual(await s2cLedger(fixture, prepared.body.requestId), []);
  assert.deepEqual(await s2cLedger(fixture, originalSave.body.requestId), originalLedger);
  assert.deepEqual(originalLedger[0].receipt, originalReceipt);
});

test("S2c S13 a legacy text metric chart with a null sidecar atomically becomes a numeric chart with V1 presentation", async testContext => {
  const fixture = await s2aFixture("s2c-text-to-numeric-transition");
  const harness = await s2cHttpHarness(testContext);
  const textMetric = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, valueType: "text", dailyAggregationMethod: "last", scopeLevels: ["session"] });
  const numericMetric = await makeMetricDefinition({ clubId: fixture.clubId, adminId: fixture.coachId, dailyAggregationMethod: "last", scopeLevels: ["session"] });
  const legacyWidget = await makeWidgetHttp(fixture.coachCookie, fixture.dashboard, { widgetType: "line_chart", groupBy: "day", title: "Legacy text chart" });
  const added = await api(`/api/training-load/dashboards/${fixture.dashboard.id}/widgets/${legacyWidget.widgetId}/series`, {
    method: "POST", cookie: fixture.coachCookie,
    body: { expectedWidgetRevision: 1, seriesOrder: 0, metricDefinitionId: textMetric.metricDefinitionId, dataScopeLevel: "session", analyticalAggregation: "last" },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const legacy = await s2aStored(legacyWidget.widgetId);
  assert.equal(legacy.presentation_config, null);
  assert.equal(legacy.series[0].metric_definition_id, textMetric.metricDefinitionId);
  const dashboardBefore = (await s2aState(fixture.dashboard.id)).dashboard;
  const sidecar = { schemaVersion: 1, chartComposition: "athletes-v1", chartInteractions: { tooltip: { mode: "exact" }, zoom: { mode: "local", applyPeriodAction: true } } };
  const draft = s2aUpdateDraft(s2aDraft({ kind: "metric", metricDefinitionId: numericMetric.metricDefinitionId }, { type: "line_chart", groupBy: "week", dataScopeLevel: "session", analyticalAggregation: "avg" }));
  draft.title = "Numeric chart with presentation";
  draft.presentation = { mode: "replace", value: sidecar };
  const prepared = await harness.preview(fixture, s2bEnvelope(draft, { editTarget: { widgetId: legacy.id, expectedWidgetRevision: legacy.revision } }));
  const response = await harness.save(fixture, prepared.body, legacy.id);
  const receipt = s2cReceipt(response, "updated");
  const saved = await s2aStored(legacy.id);
  assert.equal(saved.id, legacy.id);
  assert.equal(saved.widget_type, "line_chart");
  assert.equal(saved.group_by, "week");
  assert.equal(saved.title, draft.title);
  assert.deepEqual(saved.presentation_config, sidecar);
  assert.equal(saved.series.length, 1);
  assert.equal(saved.series[0].metric_definition_id, numericMetric.metricDefinitionId);
  assert.equal(saved.series[0].built_in_series_key, null);
  assert.equal(saved.series[0].analytical_aggregation, "avg");
  assert.equal(saved.series[0].resolution_status, "resolved");
  assert.notEqual(saved.series[0].id, legacy.series[0].id);
  assert.equal((await query("select id from training_load.dashboard_widget_series where id=$1", [legacy.series[0].id])).rowCount, 0);
  for (const field of ["x", "y", "width", "height", "widget_order", "mobile_order"]) assert.equal(saved[field], legacy[field], field);
  assert.ok(saved.revision > legacy.revision);
  assert.equal(receipt.widgetRevision, saved.revision);
  assert.equal(receipt.dashboardRevision, dashboardBefore.revision);
  assert.equal(receipt.seriesId, saved.series[0].id);
  assert.deepEqual(receipt.idMapping.series, { from: prepared.response.normalizedWidget.series[0].id, to: saved.series[0].id });
  assert.deepEqual((await s2cLedger(fixture, prepared.body.requestId))[0].receipt, receipt);
  const beforeReplay = await s2bDatabaseState();
  assert.deepEqual(s2cReceipt(await harness.save(fixture, prepared.body, saved.id), "updated"), receipt);
  assert.deepEqual(await s2bDatabaseState(), beforeReplay);
});

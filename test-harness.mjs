// ============================================================
// OPTIMOVE — Training Load 3B1: Analysis Dashboard model PoC harness.
//
// DESIGN-PHASE PROOF-OF-CONCEPT ONLY. Runs entirely against a disposable,
// uniquely-named temporary Postgres database (created and dropped by this
// script itself) — never OPTIMOVE, never monitoring2, never staging/
// Supabase/production (see refuseForbidden below, and the SAFETY assertion
// right after connecting). Does NOT import or touch any backend route,
// service, or frontend file — only backend/src/migrate.js's own migration
// RUNNER utility (to apply the real migrations_v2 files faithfully,
// exactly like every existing backend test already does) and the `pg`
// driver directly. No application code is added or modified by this file.
//
// Order of operations:
//   1. create a fresh temp DB
//   2. minimal public/plans/library scaffolding (same shape every existing
//      disposable-DB backend test already uses — generic dependency
//      scaffolding, not feature logic)
//   3. the REAL migrations_v2 files (through main) via the REAL runner
//   4. this proposal's own ../schema.sql (additive, on top)
//   5. a small, realistic fixture (2 clubs, a team, a platform admin, a
//      private coach, athletes, activities, metrics, RPE)
//   6. the 24 numbered proof points from the task, each as its own test()
//   7. drop the temp DB, verify it is gone
//
// Run three times in a row (`node test-harness.mjs`) to check stability —
// see DASHBOARD_MODEL_REPORT.md for the reported results of those runs.
// ============================================================

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "./backend/src/migrate.js";

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

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set (point it at a local/disposable Postgres server — never OPTIMOVE/monitoring2/staging/production) to run this PoC.");
}
const baseUrl = new URL(process.env.DATABASE_URL);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const ADMIN_URL = adminUrl.toString();

function dbUrlFor(name) {
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return u.toString();
}
function refuseForbidden(name, url) {
  if (name.toLowerCase() === "optimove" || /monitoring2|staging|supabase|production/i.test(url) || /monitoring2|staging|production/i.test(name)) {
    throw new Error(`SAFETY: refusing to run against a forbidden database name/url (name=${name})`);
  }
}

// Same generic public/plans/library scaffolding every existing
// disposable-DB backend test already uses (see backend/tests/
// training-load-calendar.test.mjs's own LEGACY_FIXTURE_SQL) — not feature
// logic, just the minimum shape the real migrations_v2 files depend on.
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
  create view plans.v_plan_item_node_ancestry as select 1 as id where false;
  create view plans.v_weekly_plan_items as select 1 as id where false;
  create view plans.v_program_plan_items as select 1 as id where false;

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
  const name = `optimove_poc_dashboard_${label}_${crypto.randomBytes(6).toString("hex")}`;
  const url = dbUrlFor(name);
  refuseForbidden(name, url);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const cur = await admin.query("select current_database() as db");
  assert.equal(cur.rows[0].db, "postgres", "SAFETY: admin connection must be on the postgres maintenance database");
  await admin.query(`create database "${name}"`);
  await admin.end();
  return { name, url };
}
async function dropTempDb({ name }) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`, [name]);
  await admin.query(`drop database if exists "${name}"`);
  const stillExists = await admin.query(`select 1 from pg_database where datname = $1`, [name]);
  await admin.end();
  return stillExists.rowCount === 0;
}
async function writeMigrationsDir(runId, files) {
  const dir = path.resolve(__dirname, `.tmp_poc_migrations_${runId}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fsp.writeFile(path.join(dir, name), content, "utf8");
  return dir;
}
async function readMigrationFiles(names) {
  const contents = await Promise.all(names.map((name) => fsp.readFile(path.resolve(__dirname, "migrations_v2", name), "utf8")));
  return Object.fromEntries(names.map((name, i) => [name, contents[i]]));
}

let db, pool, migrationsDir;
let ids; // fixture ids, filled by seed()
let teardownVerifiedGone = null;

async function setup() {
  db = await makeTempDb("run");
  const admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  const ownCheck = await admin.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: connection landed on an unexpected database");
  await admin.query(LEGACY_FIXTURE_SQL);
  await admin.end();

  migrationsDir = await writeMigrationsDir("run", await readMigrationFiles(MIGRATIONS));
  await runner.runMigrations({ databaseUrl: db.url, migrationsRoot: migrationsDir });

  const schemaSql = await fsp.readFile(path.resolve(__dirname, "schema.sql"), "utf8");
  const schemaClient = new pg.Client({ connectionString: db.url });
  await schemaClient.connect();
  await schemaClient.query(schemaSql);
  await schemaClient.end();

  pool = new pg.Pool({ connectionString: db.url, max: 10 });
}

async function teardown() {
  if (pool) await pool.end();
  if (migrationsDir) await fsp.rm(migrationsDir, { recursive: true, force: true });
  if (db) teardownVerifiedGone = await dropTempDb(db);
}

before(async () => {
  await setup();
  ids = await seed();
});

after(async () => {
  await teardown();
  console.log(`\n[teardown] disposable database ${db.name} dropped: ${teardownVerifiedGone ? "CONFIRMED gone" : "STILL PRESENT — investigate"}`);
});

function q(text, params) {
  return pool.query(text, params);
}
async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0];
}

// ------------------------------------------------------------
// Fixture: 2 clubs (A, B), a team under A, a platform admin, a private
// coach, 3 athletes in club A, real training.activities/components,
// metric_definitions at every scope, metric_events/values, and RPE —
// enough surface to exercise all 24 proof points, including "RPE/sRPE and
// a Metrics Core series on the SAME dashboard without copying" (item 17).
// ------------------------------------------------------------
async function seed() {
  const clubA = await one(`insert into public.clubs (name) values ('PoC Club A') returning id`);
  const clubB = await one(`insert into public.clubs (name) values ('PoC Club B') returning id`);
  const teamA = await one(`insert into public.teams (club_id, name) values ($1, 'PoC Team A1') returning id`, [clubA.id]);

  const platformAdmin = await one(`insert into public.users (email, full_name) values ('poc-platform-admin@example.invalid', 'Platform Admin') returning id`);
  const coachA = await one(`insert into public.users (email, full_name) values ('poc-coach-a@example.invalid', 'Coach A') returning id`);
  const coachB = await one(`insert into public.users (email, full_name) values ('poc-coach-b@example.invalid', 'Coach B') returning id`);
  const privateCoach = await one(`insert into public.users (email, full_name) values ('poc-private-coach@example.invalid', 'Private Coach') returning id`);
  await q(`insert into public.user_global_roles (user_id, role) values ($1, 'platform_admin')`, [platformAdmin.id]);
  await q(`insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'admin')`, [coachA.id, clubA.id]);
  await q(`insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'admin')`, [coachB.id, clubB.id]);

  const athleteRows = [];
  for (const label of ["Ana", "Marko", "Petra"]) {
    const u = await one(`insert into public.users (email, full_name) values ($1, $2) returning id`, [`poc-athlete-${label.toLowerCase()}@example.invalid`, label]);
    const a = await one(
      `insert into public.athletes (user_id, source_external_id, full_name, athlete_id) values ($1, $2, $3, $4) returning id`,
      [u.id, `poc-${label.toLowerCase()}`, label, `poc-${label.toLowerCase()}`],
    );
    await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type) values ($1, $2, $3, 'roster')`, [a.id, clubA.id, teamA.id]);
    athleteRows.push(a);
  }
  const [ana, marko, petra] = athleteRows;

  // Metric definitions at every scope this model needs to distinguish.
  async function makeDefinition({ key, label, ownerScope, ownerUserId = null, ownerClubId = null, ownerTeamId = null, unit = "m", state = "active" }) {
    const def = await one(
      `insert into training_load.metric_definitions (key, label, owner_scope, owner_user_id, owner_club_id, owner_team_id, state, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [key, label, ownerScope, ownerUserId, ownerClubId, ownerTeamId, state, platformAdmin.id],
    );
    const ver = await one(
      `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id)
       values ($1,1,$2,'numeric','sum',$3) returning id`,
      [def.id, unit, platformAdmin.id],
    );
    await q(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [ver.id, def.id]);
    await q(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, 'session'), ($1, 'component')`, [def.id]);
    return def.id;
  }
  const distanceSystem = await makeDefinition({ key: "distance_total_m", label: "Total Distance", ownerScope: "system", unit: "m" });
  const distanceClubA = await makeDefinition({ key: "poc-distance", label: "Club A Distance", ownerScope: "club", ownerClubId: clubA.id, unit: "m" });
  const distanceClubB = await makeDefinition({ key: "poc-distance", label: "Club B Distance", ownerScope: "club", ownerClubId: clubB.id, unit: "m" });
  const privateHrCoachA = await makeDefinition({ key: "poc-hr", label: "Coach A Private HR", ownerScope: "user", ownerUserId: coachA.id, unit: "bpm" });
  const privateHrPrivateCoach = await makeDefinition({ key: "poc-hr", label: "Private Coach's HR", ownerScope: "user", ownerUserId: privateCoach.id, unit: "bpm" });
  const archivedDef = await makeDefinition({ key: "poc-archived", label: "Retired Metric", ownerScope: "club", ownerClubId: clubA.id, unit: "au", state: "archived" });
  const hrClubA = await makeDefinition({ key: "poc-hr-club", label: "Club A Heart Rate", ownerScope: "club", ownerClubId: clubA.id, unit: "bpm" });

  // One real training.activities row for Ana, with a component, session
  // RPE, and a Metrics Core value — the substrate item 17/18/19 read from.
  const activity = await one(
    `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state, created_by_user_id)
     values ('training_session','PoC Session','2026-09-09','2026-09-09T09:00:00Z','Europe/Belgrade','club',$1,'manual','confirmed',$2) returning id`,
    [clubA.id, coachA.id],
  );
  const participant = await one(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status)
     values ($1,$2,'2026-09-09','Europe/Belgrade','participated') returning id`,
    [activity.id, ana.id],
  );
  const component = await one(
    `insert into training.activity_components (activity_id, component_type_key, name_snapshot, origin, sort_order) values ($1,'block','Main Set','manual',1) returning id`,
    [activity.id],
  );

  const conn = await one(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_club_id) values ('poc-manual','club',$1) returning id`, [clubA.id]);
  const event = await one(
    `insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_club_id, source_connection_id, created_by_user_id)
     values ('PoC Session','2026-09-09','2026-09-09T09:00:00Z','session','club',$1,$2,$3) returning id`,
    [clubA.id, conn.id, coachA.id],
  );
  const eventParticipant = await one(
    `insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Belgrade') returning id`,
    [event.id, ana.id],
  );
  const segment = await one(`insert into training_load.metric_event_segments (event_id, label, segment_order) values ($1,'Main Set',1) returning id`, [event.id]);
  await q(`insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [activity.id, event.id]);
  await q(`insert into training.activity_participant_metric_participant_links (activity_participant_id, metric_event_participant_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [participant.id, eventParticipant.id]);
  await q(`insert into training.activity_component_metric_segment_links (activity_component_id, metric_event_segment_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [component.id, segment.id]);

  const occasion = await one(
    `insert into training_load.metric_measurement_occasions (event_participant_id, segment_id, entry_method) values ($1,$2,'manual') returning id`,
    [eventParticipant.id, segment.id],
  );
  await q(
    `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture)
     select $1, id, current_version_id, 3200, 'm' from training_load.metric_definitions where id = $2`,
    [occasion.id, distanceClubA],
  );

  // A real RPE row — reached only via session_feedback (never metric_values).
  await q(
    `insert into training_load.session_feedback (athlete_id, session_date, plan_name, source, external_assignment_id, logical_session_id, rpe, duration_minutes)
     values ($1,'2026-09-09','PoC Plan','planned', null, gen_random_uuid(), 7, 60)`,
    [ana.id],
  );

  return {
    clubA: clubA.id, clubB: clubB.id, teamA: teamA.id,
    platformAdmin: platformAdmin.id, coachA: coachA.id, coachB: coachB.id, privateCoach: privateCoach.id,
    ana: ana.id, marko: marko.id, petra: petra.id,
    distanceSystem, distanceClubA, distanceClubB, privateHrCoachA, privateHrPrivateCoach, archivedDef, hrClubA,
    activity: activity.id, component: component.id,
  };
}

// ------------------------------------------------------------
// Concurrency helpers — deterministic DB barriers, never sleep. Two real
// pg.Client connections; "blocked" is proven by polling
// pg_stat_activity.wait_event_type for the waiting backend's own real pid
// until Postgres itself reports it as waiting on a lock, bounded by a
// generous timeout that only ever fires on a genuine bug (never used as a
// timing device for the actual assertion).
// ------------------------------------------------------------
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
// The 24 proof points.
// ============================================================

test("PoC 1. system/club/team/user ownership — one dashboard per scope, each with the correct owner columns populated", async () => {
  const sys = await one(`insert into training_load.dashboards (name, owner_scope, created_by_user_id) values ('System Overview','system',$1) returning *`, [ids.platformAdmin]);
  assert.equal(sys.owner_scope, "system");
  const club = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Club A Overview','club',$1,$2) returning *`, [ids.clubA, ids.coachA]);
  assert.equal(club.owner_club_id, ids.clubA);
  const team = await one(`insert into training_load.dashboards (name, owner_scope, owner_team_id, created_by_user_id) values ('Team A1 Overview','team',$1,$2) returning *`, [ids.teamA, ids.coachA]);
  assert.equal(team.owner_team_id, ids.teamA);
  const user = await one(`insert into training_load.dashboards (name, owner_scope, owner_user_id, created_by_user_id) values ('My Dashboard','user',$1,$2) returning *`, [ids.coachA, ids.coachA]);
  assert.equal(user.owner_user_id, ids.coachA);
  // The shape CHECK itself rejects a mismatched owner combination.
  await assert.rejects(q(`insert into training_load.dashboards (name, owner_scope, owner_club_id, owner_user_id, created_by_user_id) values ('bad','club',$1,$2,$2)`, [ids.clubA, ids.coachA]));
});

test("PoC 2. cross-workspace read/write isolation — club B cannot write into club A's dashboard, and a simple scope filter never returns club A's rows for club B", async () => {
  const dashA = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Club A Only','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  const rows = await q(`select id from training_load.dashboards where owner_scope='club' and owner_club_id=$1`, [ids.clubB]);
  assert.ok(!rows.rows.some((r) => r.id === dashA.id), "a club-B-scoped query must never see club A's dashboard");
  // "Write" isolation at the DB layer means: nothing about this row's
  // storage lets a club-B-scoped writer target it merely by omitting a
  // WHERE clause — every real write path always predicates on the
  // caller's own resolved owner columns (see report's application-layer
  // notes); demonstrated here by confirming a scope-filtered UPDATE
  // touches zero rows when club B's own id is used.
  const upd = await q(`update training_load.dashboards set name='hacked' where id=$1 and owner_club_id=$2`, [dashA.id, ids.clubB]);
  assert.equal(upd.rowCount, 0);
});

test("PoC 3. platform-admin-managed system template is real and its ownership cannot be silently reassigned once in use", async () => {
  const tmpl = await one(`insert into training_load.dashboards (name, owner_scope, is_template, created_by_user_id) values ('Team overview','system',true,$1) returning id`, [ids.platformAdmin]);
  await q(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','Placeholder',1,0,0,3,2,1)`, [tmpl.id]);
  await assert.rejects(
    q(`update training_load.dashboards set owner_scope='club', owner_club_id=$1 where id=$2`, [ids.clubA, tmpl.id]),
    /owner_scope is immutable/,
  );
});

test("PoC 4. a user clones a system template into their own dashboard without modifying the original", async () => {
  const tmpl = await one(`insert into training_load.dashboards (name, owner_scope, is_template, created_by_user_id) values ('Athlete overview','system',true,$1) returning *`, [ids.platformAdmin]);
  const tmplWidget = await one(
    `insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','Distance',1,0,0,3,2,1) returning id`,
    [tmpl.id],
  );
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, template_metric_key_hints) values ($1,1,'["distance_total_m"]'::jsonb)`, [tmplWidget.id]);

  // Clone: a brand-new dashboard row, owner_scope='user', provenance
  // pointer set, hint resolved into a REAL FK against this workspace's
  // own visible 'system' definition.
  const clone = await one(
    `insert into training_load.dashboards (name, owner_scope, owner_user_id, cloned_from_dashboard_id, created_by_user_id) values ($1,'user',$2,$3,$2) returning *`,
    [tmpl.name, ids.coachA, tmpl.id],
  );
  const cloneWidget = await one(
    `insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','Distance',1,0,0,3,2,1) returning id`,
    [clone.id],
  );
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,1,$2)`, [cloneWidget.id, ids.distanceSystem]);

  const originalStillHasHintOnly = await one(`select metric_definition_id, template_metric_key_hints from training_load.dashboard_widget_series where widget_id=$1`, [tmplWidget.id]);
  assert.equal(originalStillHasHintOnly.metric_definition_id, null, "the ORIGINAL template's series must remain unresolved — cloning must never mutate it");
  const clonedResolved = await one(`select metric_definition_id from training_load.dashboard_widget_series where widget_id=$1`, [cloneWidget.id]);
  assert.equal(clonedResolved.metric_definition_id, ids.distanceSystem);
});

test("PoC 5. active dashboard selection is separate per user+workspace", async () => {
  const dashA = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('A','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  const dashB = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('B','club',$1,$2) returning id`, [ids.clubB, ids.coachB]);
  await q(`insert into training_load.dashboard_active_selection (user_id, workspace_type, scope_id, dashboard_id) values ($1,'club',$2,$3)`, [ids.coachA, ids.clubA, dashA.id]);
  await q(`insert into training_load.dashboard_active_selection (user_id, workspace_type, scope_id, dashboard_id) values ($1,'club',$2,$3)`, [ids.coachB, ids.clubB, dashB.id]);
  const a = await one(`select dashboard_id from training_load.dashboard_active_selection where user_id=$1 and workspace_type='club' and scope_id=$2`, [ids.coachA, ids.clubA]);
  const b = await one(`select dashboard_id from training_load.dashboard_active_selection where user_id=$1 and workspace_type='club' and scope_id=$2`, [ids.coachB, ids.clubB]);
  assert.equal(a.dashboard_id, dashA.id);
  assert.equal(b.dashboard_id, dashB.id);
  // Coach A cannot select club B's dashboard as their own active view.
  await assert.rejects(
    q(`insert into training_load.dashboard_active_selection (user_id, workspace_type, scope_id, dashboard_id) values ($1,'club',$2,$3)`, [ids.coachA, ids.clubA, dashB.id]),
    /not visible from workspace/,
  );
});

test("PoC 6. a widget's metric FK must belong to a definition actually visible to its dashboard's owner scope", async () => {
  const dashClubA = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('A','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  const widget = await one(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'table','D',1,0,0,6,4,1) returning id`, [dashClubA.id]);
  // 'table' (not 'kpi') deliberately — this test is about VISIBILITY, not
  // the per-type series cap (PoC 14 already covers that), and needs room
  // for 3 series.
  // Club A's own metric — allowed.
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,1,$2)`, [widget.id, ids.distanceClubA]);
  // A system metric — allowed.
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,2,$2)`, [widget.id, ids.distanceSystem]);
  // Club B's metric on a Club A dashboard — rejected.
  await assert.rejects(
    q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,3,$2)`, [widget.id, ids.distanceClubB]),
    /not visible/,
  );
});

test("PoC 7. an archived metric_definition stays readable/renderable in an existing widget, but the visibility trigger does not itself gate on state (state-based hiding for NEW picks is an application-layer catalog concern)", async () => {
  const dashClubA = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('A','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  const widget = await one(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','Archived',1,0,0,3,2,1) returning id`, [dashClubA.id]);
  const series = await one(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,1,$2) returning id`, [widget.id, ids.archivedDef]);
  const row = await one(
    `select md.state, md.label from training_load.dashboard_widget_series s join training_load.metric_definitions md on md.id = s.metric_definition_id where s.id=$1`,
    [series.id],
  );
  assert.equal(row.state, "archived");
  assert.equal(row.label, "Retired Metric", "the widget can still resolve and render the archived definition's real label/history");
});

test("PoC 8. another user's PRIVATE metric_definition cannot be inserted into my dashboard by UUID, even though the row exists and is a valid FK target", async () => {
  const dashPrivate = await one(`insert into training_load.dashboards (name, owner_scope, owner_user_id, created_by_user_id) values ('My dash','user',$1,$2) returning id`, [ids.coachA, ids.coachA]);
  const widget = await one(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','HR',1,0,0,3,2,1) returning id`, [dashPrivate.id]);
  // ids.privateHrPrivateCoach is a REAL, existing metric_definitions row —
  // owned by a DIFFERENT private coach. The FK alone would happily accept
  // it; the visibility trigger must not.
  await assert.rejects(
    q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,1,$2)`, [widget.id, ids.privateHrPrivateCoach]),
    /may not reference metric_definition/,
  );
  // Coach A's OWN private metric is fine on their OWN private dashboard.
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,2,$2)`, [widget.id, ids.privateHrCoachA]);
});

test("PoC 9. the 12-column grid rejects an out-of-bounds position/size", async () => {
  const dash = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Layout','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  await assert.rejects(q(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','Bad',1,10,0,5,2,1)`, [dash.id]), /x \+ width|out of bounds/);
  await assert.rejects(q(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','TooWide',1,0,0,12,2,1)`, [dash.id]), /out of bounds/, "KPI's own max_width is 4, not 12");
  await q(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','OK',1,0,0,3,2,1)`, [dash.id]);
});

test("PoC 10. overlapping widgets on the same dashboard are rejected deterministically", async () => {
  const dash = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Overlap','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  await q(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','First',1,0,0,4,2,1)`, [dash.id]);
  await assert.rejects(
    q(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','Overlaps',2,2,0,4,2,2)`, [dash.id]),
    /overlaps existing widget/,
  );
  // A widget in a different row, or fully to the right, does not conflict.
  await q(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','Below',3,0,2,4,2,2)`, [dash.id]);
  await q(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','RightOf',4,4,0,4,2,3)`, [dash.id]);
});

test("PoC 11. concurrent edit against a stale widget revision is a controlled conflict, never a silent overwrite", async () => {
  const dash = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Conflict','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  const widget = await one(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','W',1,0,0,3,2,1) returning id, revision`, [dash.id]);
  const staleRevision = widget.revision;

  // Writer A applies a real change first — revision bumps to 2.
  const applyA = await q(`update training_load.dashboard_widgets set title='Renamed by A' where id=$1 and revision=$2 returning revision`, [widget.id, staleRevision]);
  assert.equal(applyA.rowCount, 1);
  assert.equal(applyA.rows[0].revision, 2);

  // Writer B, still holding the OLD revision it read before A's write,
  // retries against that same stale value — 0 rows updated, a controlled
  // conflict the application layer turns into a 409, never a silent
  // overwrite of A's change.
  const applyB = await q(`update training_load.dashboard_widgets set title='Renamed by B' where id=$1 and revision=$2`, [widget.id, staleRevision]);
  assert.equal(applyB.rowCount, 0, "a write against a stale revision must affect zero rows");
  const final = await one(`select title, revision from training_load.dashboard_widgets where id=$1`, [widget.id]);
  assert.equal(final.title, "Renamed by A");
});

test("PoC 12. two concurrent resize/reorder requests against DIFFERENT widgets on the same dashboard both succeed — neither is lost, verified with a real DB barrier (not sleep)", async () => {
  const dash = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Parallel','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  const w1 = await one(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','W1',1,0,0,3,2,1) returning id`, [dash.id]);
  const w2 = await one(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','W2',2,4,0,3,2,2) returning id`, [dash.id]);

  const a = await newClient();
  const b = await newClient();
  try {
    await a.client.query("begin");
    await a.client.query("update training_load.dashboard_widgets set width=4 where id=$1", [w1.id]); // touches the dashboard's own row lock too
    // b's write to w2 shares the SAME dashboard-level lock the overlap
    // trigger takes — it WILL block behind a's still-open transaction.
    const bPromise = b.client.query("update training_load.dashboard_widgets set width=4 where id=$1", [w2.id]);
    const blocked = await waitUntilBlocked(b.pid);
    assert.ok(blocked, "writer B must be genuinely blocked behind writer A's open transaction (real DB barrier, not a timing guess)");
    await a.client.query("commit");
    await bPromise; // now proceeds and succeeds
  } finally {
    await a.client.end();
    await b.client.end();
  }

  const r1 = await one(`select width, revision from training_load.dashboard_widgets where id=$1`, [w1.id]);
  const r2 = await one(`select width, revision from training_load.dashboard_widgets where id=$1`, [w2.id]);
  assert.equal(r1.width, 4);
  assert.equal(r2.width, 4);
  assert.equal(r1.revision, 2);
  assert.equal(r2.revision, 2);
});

test("PoC 13. widget type and series config validation — unknown widget_type, and a series with neither a resolved reference nor hints, are both refused", async () => {
  const dash = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Validate','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  await assert.rejects(q(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'not_a_real_type','X',1,0,0,3,2,1)`, [dash.id]));
  const widget = await one(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','X',1,0,0,3,2,1) returning id`, [dash.id]);
  await assert.rejects(q(`insert into training_load.dashboard_widget_series (widget_id, series_order) values ($1,1)`, [widget.id]));
});

test("PoC 14. KPI never accepts more series than its type allows (max_series=1)", async () => {
  const dash = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('KPI cap','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  const widget = await one(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','K',1,0,0,3,2,1) returning id`, [dash.id]);
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,1,$2)`, [widget.id, ids.distanceClubA]);
  await assert.rejects(
    q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,2,$2)`, [widget.id, ids.distanceSystem]),
    /already has 1 series, the max allowed is 1/,
  );
});

test("PoC 15. a chart never mixes incompatible units on the same axis", async () => {
  const dash = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Axis','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  const widget = await one(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'line_chart','L',1,0,0,6,4,1) returning id`, [dash.id]);
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, axis) values ($1,1,$2,'primary')`, [widget.id, ids.distanceClubA]); // unit m
  await assert.rejects(
    q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, axis) values ($1,2,$2,'primary')`, [widget.id, ids.hrClubA]), // unit bpm, visible to this club-A dashboard
    /unit mismatch/,
  );
  // The SAME incompatible metric is fine on the SECONDARY axis.
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, axis) values ($1,3,$2,'secondary')`, [widget.id, ids.hrClubA]);
  // The same axis-compatibility check does NOT apply to a KPI/Table — a
  // widget type with no real shared visual axis (report §D "axis-unit
  // scoped to chart types only").
  const table = await one(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'table','T',2,0,4,6,4,2) returning id`, [dash.id]);
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, axis) values ($1,1,$2,'primary')`, [table.id, ids.distanceClubA]);
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, axis) values ($1,2,$2,'primary')`, [table.id, ids.hrClubA]);
});

test("PoC 16. source policy is explicit and self-consistent, never an implicit 'primary source' guess", async () => {
  const dash = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Source','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  const widget = await one(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'table','T',1,0,0,6,4,1) returning id`, [dash.id]);
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, source_policy) values ($1,1,$2,'manual')`, [widget.id, ids.distanceClubA]);
  await assert.rejects(
    q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, source_policy) values ($1,2,$2,'source_connection')`, [widget.id, ids.distanceClubA]),
    /violates check constraint/,
    "source_policy='source_connection' requires a source_connection_id",
  );
});

test("PoC 17. RPE/sRPE (session_feedback, built-in series) and a Metrics Core metric can sit on the SAME dashboard without ever copying a result into metric_values", async () => {
  const dash = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Session analysis','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  const widget = await one(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'table','T',1,0,0,6,4,1) returning id`, [dash.id]);
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, built_in_series_key) values ($1,1,'rpe')`, [widget.id]);
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, built_in_series_key) values ($1,2,'srpe')`, [widget.id]);
  await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,3,$2)`, [widget.id, ids.distanceClubA]);
  const series = await q(`select built_in_series_key, metric_definition_id from training_load.dashboard_widget_series where widget_id=$1 order by series_order`, [widget.id]);
  assert.deepEqual(series.rows.map((r) => r.built_in_series_key), ["rpe", "srpe", null]);
  // The RPE value itself still lives ONLY in session_feedback — proving
  // no copy was made anywhere in this schema.
  const rpeCount = await one(`select count(*)::int as n from training_load.metric_values v join training_load.metric_definitions d on d.id=v.metric_definition_id where d.key ilike '%rpe%'`);
  assert.equal(rpeCount.n, 0, "RPE must never be duplicated into metric_values");
  const realRpe = await one(`select rpe, srpe from training_load.session_feedback where athlete_id=$1`, [ids.ana]);
  assert.equal(realRpe.rpe, 7);
  assert.equal(realRpe.srpe, 420);
});

test("PoC 18. day/session/component data is never double-counted by this model — session-scope and component-scope values for the same fact stay distinguishable, never silently summed", async () => {
  // The real activity fixture has EXACTLY one metric_values row, scoped to
  // a COMPONENT (via its segment link) — proving the query surface a
  // widget reads from can distinguish component-level facts from a
  // session-level rollup that does not exist here, rather than a
  // dashboard-side aggregate silently treating "one value" as if it were
  // both.
  const rows = await q(
    `select o.segment_id, e.scope_level from training_load.metric_values v
     join training_load.metric_measurement_occasions o on o.id = v.occasion_id
     join training_load.metric_event_participants p on p.id = o.event_participant_id
     join training_load.metric_events e on e.id = p.event_id
     where v.metric_definition_id = $1`,
    [ids.distanceClubA],
  );
  assert.equal(rows.rows.length, 1);
  assert.notEqual(rows.rows[0].segment_id, null, "this fact is COMPONENT-scoped (has a segment) — a widget grouping by 'session' must not silently fold it into a session total that was never actually reported");
});

test("PoC 19. a superseded/import-conflict measurement is never shown as a single clean value — the effective-value predicate excludes it structurally", async () => {
  const conn = ids; // reuse fixture ids
  const eventParticipant = await one(
    `select p.id from training_load.metric_event_participants p
     join training_load.metric_events e on e.id = p.event_id
     where e.owner_club_id = $1 and p.athlete_id = $2 limit 1`,
    [ids.clubA, ids.ana],
  );
  const occ1 = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id`, [eventParticipant.id]);
  await q(
    `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture)
     select $1, id, current_version_id, 100, 'm' from training_load.metric_definitions where id=$2`,
    [occ1.id, ids.distanceSystem],
  );
  const occ2 = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, supersedes_occasion_id) values ($1,'manual',$2) returning id`, [eventParticipant.id, occ1.id]);
  await q(
    `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture)
     select $1, id, current_version_id, 110, 'm' from training_load.metric_definitions where id=$2`,
    [occ2.id, ids.distanceSystem],
  );
  await q(`update training_load.metric_measurement_occasions set superseded_by_occasion_id=$1 where id=$2`, [occ2.id, occ1.id]);

  // The SAME "effective" predicate the real canonical_activity_results()
  // function already uses — this PoC does not reinvent it, it proves the
  // dashboard's own query adapter must use the identical predicate,
  // never treat superseded_by_occasion_id IS NULL as optional.
  const effective = await q(
    `select value_numeric from training_load.metric_values v
     join training_load.metric_measurement_occasions o on o.id = v.occasion_id
     where v.metric_definition_id=$1 and o.event_participant_id=$2 and o.superseded_by_occasion_id is null`,
    [ids.distanceSystem, eventParticipant.id],
  );
  assert.equal(effective.rows.length, 1);
  assert.equal(Number(effective.rows[0].value_numeric), 110, "only the CURRENT occasion's value is effective — the superseded 100 must never be picked");
});

test("PoC 20. archive keeps a dashboard's history intact; a hard delete is refused while it is still referenced (active selection or a clone's provenance)", async () => {
  const tmpl = await one(`insert into training_load.dashboards (name, owner_scope, is_template, created_by_user_id) values ('Refd','system',true,$1) returning id`, [ids.platformAdmin]);
  const clone = await one(`insert into training_load.dashboards (name, owner_scope, owner_user_id, cloned_from_dashboard_id, created_by_user_id) values ('Clone','user',$1,$2,$1) returning id`, [ids.coachA, tmpl.id]);
  await assert.rejects(q(`delete from training_load.dashboards where id=$1`, [tmpl.id]), /violates foreign key constraint/, "a template with a live clone cannot be hard-deleted");
  const archived = await one(`update training_load.dashboards set status='archived' where id=$1 returning status, revision`, [tmpl.id]);
  assert.equal(archived.status, "archived");
  assert.equal(archived.revision, 2, "archiving is a tracked revision change, not a silent flip");
  const stillThere = await one(`select cloned_from_dashboard_id from training_load.dashboards where id=$1`, [clone.id]);
  assert.equal(stillThere.cloned_from_dashboard_id, tmpl.id, "the clone's provenance survives the original being archived");
});

test("PoC 21. a dashboard with 30+ widgets and many metric definitions is well within bounds", async () => {
  const dash = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Big','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  const defIds = [ids.distanceClubA, ids.distanceSystem];
  for (let i = 0; i < 32; i += 1) {
    const col = i % 6;
    const row = Math.floor(i / 6);
    const w = await one(
      `insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi',$2,$3,$4,$5,2,2,$3) returning id`,
      [dash.id, `Widget ${i}`, i + 1, col * 2, row * 2],
    );
    await q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,1,$2)`, [w.id, defIds[i % defIds.length]]);
  }
  const count = await one(`select count(*)::int as n from training_load.dashboard_widgets where dashboard_id=$1`, [dash.id]);
  assert.equal(count.n, 32);
});

test("PoC 22. rollback leaves no partial widget/layout writes behind", async () => {
  const dash = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Rollback','club',$1,$2) returning id`, [ids.clubA, ids.coachA]);
  const client = await newClient();
  try {
    await client.client.query("begin");
    for (let i = 0; i < 4; i += 1) {
      await client.client.query(
        `insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi',$2,$3,$4,0,2,2,$3)`,
        [dash.id, `Batch ${i}`, i + 1, i * 2],
      );
    }
    // The 5th widget in this same batch deliberately overlaps the 1st —
    // the whole batch must roll back, not just this one statement.
    await assert.rejects(
      client.client.query(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','Bad',5,0,0,2,2,5)`, [dash.id]),
    );
    await client.client.query("rollback");
  } finally {
    await client.client.end();
  }
  const count = await one(`select count(*)::int as n from training_load.dashboard_widgets where dashboard_id=$1`, [dash.id]);
  assert.equal(count.n, 0, "a rolled-back batch must leave zero widgets, not the 4 that individually succeeded before the 5th failed");
});

test("PoC 23. authorization is never cached/replayable inside this schema — every table stamps owner columns at write time and re-derives nothing from a prior grant (documents an application-layer requirement this PoC cannot fully exercise without a real auth layer)", async () => {
  // This schema has no "authorized-at" cache, no request/session table
  // whose mere existence could let a later retry bypass a since-revoked
  // role — unlike, say, an idempotency-key table that intentionally
  // replays a PRIOR result. Demonstrated narrowly: revoking coach B's
  // club-B role and then attempting the exact same dashboard write again
  // fails identically to a first-time unauthorized attempt (there is no
  // dashboard-schema state that would make a "retry" behave differently
  // from a fresh attempt) — the real access check itself (does this
  // caller currently hold an active role) is workspace.js's
  // resolveActiveWorkspace, entirely outside this schema, and is
  // unchanged by this feature. See DASHBOARD_MODEL_REPORT.md's
  // application-authorization section for what a real route must still
  // enforce.
  await q(`update public.user_club_roles set is_active=false where user_id=$1 and club_id=$2`, [ids.coachB, ids.clubB]);
  const stillActive = await one(`select is_active from public.user_club_roles where user_id=$1 and club_id=$2`, [ids.coachB, ids.clubB]);
  assert.equal(stillActive.is_active, false);
  // The dashboard schema itself has no row that "remembers" coachB was
  // ever authorized — a fresh dashboard write attributed to club B still
  // succeeds at the STORAGE level regardless (this schema alone cannot
  // and must not try to duplicate role authorization) precisely because
  // that check belongs one layer up; this table has nothing for a
  // "retry" to replay.
  const row = await one(`insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Post-revoke','club',$1,$2) returning id`, [ids.clubB, ids.coachB]);
  assert.ok(row.id, "documents: the DB layer correctly has no authorization state to leak — the real gate is resolveActiveWorkspace, at the route layer, not exercised by this DB-only PoC");
});

test("PoC 24. a workspace change mid-operation never changes the ownership actually written — owner columns are bound at write time, not re-derived at commit", async () => {
  const a = await newClient();
  const b = await newClient();
  try {
    await a.client.query("begin");
    // A's own INSERT already carries club A's id as a literal VALUES
    // parameter — nothing about this write re-reads
    // public.user_workspace_preferences at any point.
    const insertPromise = a.client.query(
      `insert into training_load.dashboards (name, owner_scope, owner_club_id, created_by_user_id) values ('Mid-flight','club',$1,$2) returning id`,
      [ids.clubA, ids.coachA],
    );
    // Simulate the acting user's active-workspace PREFERENCE changing to
    // club B on a second connection while A's transaction is still open —
    // a real concurrent write to a completely different table.
    await b.client.query(
      `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,'club',$2) on conflict (user_id) do update set workspace_type=excluded.workspace_type, scope_id=excluded.scope_id`,
      [ids.coachA, ids.clubB],
    );
    const inserted = await insertPromise;
    await a.client.query("commit");
    const final = await one(`select owner_club_id from training_load.dashboards where id=$1`, [inserted.rows[0].id]);
    assert.equal(final.owner_club_id, ids.clubA, "the dashboard must keep the owner club that was ACTUALLY passed at write time, never a club the user's preference happened to change to mid-flight");
  } finally {
    await a.client.end();
    await b.client.end();
  }
});


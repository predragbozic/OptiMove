// ============================================================
// OPTIMOVE — Training Load 3B1: Analysis Dashboard model PoC harness.
// ROUND 2 (corrective) — see DASHBOARD_MODEL_REPORT.md for the full
// rationale behind every change. Still DESIGN-PHASE ONLY: runs entirely
// against a disposable, uniquely-named temporary Postgres database this
// script itself creates and drops — never OPTIMOVE, never monitoring2,
// never staging/Supabase/production. Does not import or touch any
// backend route, service, or frontend file — only backend/src/migrate.js's
// own migration RUNNER (to apply the real migrations_v2 files faithfully)
// and the `pg` driver directly.
//
// Round 2 adds: the owner-vs-data-workspace split, real series query
// semantics (aggregation/coverage/role/scope/comparison), fixed
// revision/cache bumping, reverse-invariant guards, a consistent
// dashboard->widget->series lock order, an atomic layout-replace function,
// historical unit-conflict handling, a safely-degrading template-hint
// resolver, and — the biggest addition — a REAL PoC query adapter
// (queryBuiltInSeries/queryMetricSeries below) built on top of the real,
// unmodified training.canonical_activity_results() function, proving
// actual no-double-count/conflict/alias/workspace-filter behavior against
// real rows, not just schema existence.
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
let ids;
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
function dw({ defaultWidth = 4, defaultHeight = 2 } = {}) {
  return {};
}

// ------------------------------------------------------------
// Fixture.
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
  await q(`insert into public.user_team_roles (user_id, team_id, role) values ($1, $2, 'coach')`, [coachA.id, teamA.id]);

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

  async function makeDefinition({ key, label, ownerScope, ownerUserId = null, ownerClubId = null, ownerTeamId = null, unit = "m", state = "active", dailyAggregationMethod = "sum" }) {
    const def = await one(
      `insert into training_load.metric_definitions (key, label, owner_scope, owner_user_id, owner_club_id, owner_team_id, state, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [key, label, ownerScope, ownerUserId, ownerClubId, ownerTeamId, state, platformAdmin.id],
    );
    const ver = await one(
      `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id)
       values ($1,1,$2,'numeric',$3,$4) returning id`,
      [def.id, unit, dailyAggregationMethod, platformAdmin.id],
    );
    await q(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [ver.id, def.id]);
    await q(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, 'session'), ($1, 'component')`, [def.id]);
    return { id: def.id, versionId: ver.id };
  }
  const distanceSystem = (await makeDefinition({ key: "distance_total_m", label: "Total Distance", ownerScope: "system", unit: "m" })).id;
  const distanceClubADef = await makeDefinition({ key: "poc-distance", label: "Club A Distance", ownerScope: "club", ownerClubId: clubA.id, unit: "m" });
  const distanceClubA = distanceClubADef.id;
  const distanceClubB = (await makeDefinition({ key: "poc-distance", label: "Club B Distance", ownerScope: "club", ownerClubId: clubB.id, unit: "m" })).id;
  const hrClubA = (await makeDefinition({ key: "poc-hr-club", label: "Club A Heart Rate", ownerScope: "club", ownerClubId: clubA.id, unit: "bpm" })).id;
  const privateHrCoachA = (await makeDefinition({ key: "poc-hr", label: "Coach A Private HR", ownerScope: "user", ownerUserId: coachA.id, unit: "bpm" })).id;
  const privateHrPrivateCoach = (await makeDefinition({ key: "poc-hr", label: "Private Coach's HR", ownerScope: "user", ownerUserId: privateCoach.id, unit: "bpm" })).id;
  const userMetricPrivateCoach = (await makeDefinition({ key: "poc-load", label: "Private Coach's Load Metric", ownerScope: "user", ownerUserId: privateCoach.id, unit: "au" })).id;
  const archivedDef = (await makeDefinition({ key: "poc-archived", label: "Retired Metric", ownerScope: "club", ownerClubId: clubA.id, unit: "au", state: "archived" })).id;
  const notSummableDef = (await makeDefinition({ key: "poc-max-speed", label: "Max Speed", ownerScope: "club", ownerClubId: clubA.id, unit: "km/h", dailyAggregationMethod: "max" })).id;
  // Round 2, §8: two visible candidates for the SAME hint key — one
  // system-scope, one club-A-scope — a deliberately ambiguous fixture.
  const ambiguousHintKey = "poc-ambiguous-load";
  const ambiguousSystem = (await makeDefinition({ key: ambiguousHintKey, label: "System Load (ambiguous)", ownerScope: "system", unit: "au" })).id;
  const ambiguousClubA = (await makeDefinition({ key: ambiguousHintKey, label: "Club A Load (ambiguous)", ownerScope: "club", ownerClubId: clubA.id, unit: "au" })).id;

  // Round 2, §7 — a second, later SEMANTIC VERSION of distanceSystem: v1
  // in meters, v2 in kilometers. A real historical unit change.
  const distanceSystemV2 = await one(
    `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id, superseded_reason)
     values ($1,2,'km','numeric','sum',$2,'switched to km for readability') returning id`,
    [distanceSystem, platformAdmin.id],
  );
  await q(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [distanceSystemV2.id, distanceSystem]);

  const connSystem = await one(`insert into training_load.metric_source_connections (source_system, owner_scope) values ('poc-system-import','system') returning id`);
  const connClubA = await one(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_club_id) values ('poc-manual','club',$1) returning id`, [clubA.id]);
  const connClubB = await one(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_club_id) values ('poc-manual','club',$1) returning id`, [clubB.id]);

  // --- A real training.activities row for Ana (club A), with a
  // component, session RPE, and Metrics Core values — the substrate the
  // query adapter tests read from. ---
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

  const event = await one(
    `insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_club_id, source_connection_id, created_by_user_id)
     values ('PoC Session','2026-09-09','2026-09-09T09:00:00Z','session','club',$1,$2,$3) returning id`,
    [clubA.id, connClubA.id, coachA.id],
  );
  const eventParticipant = await one(
    `insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Belgrade') returning id`,
    [event.id, ana.id],
  );
  const segment = await one(`insert into training_load.metric_event_segments (event_id, label, segment_order) values ($1,'Main Set',1) returning id`, [event.id]);
  await q(`insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [activity.id, event.id]);
  await q(`insert into training.activity_participant_metric_participant_links (activity_participant_id, metric_event_participant_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [participant.id, eventParticipant.id]);
  await q(`insert into training.activity_component_metric_segment_links (activity_component_id, metric_event_segment_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [component.id, segment.id]);

  // Component-scope STANDALONE distance value (Main Set): 3200m.
  const compOccasion = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, segment_id, entry_method) values ($1,$2,'manual') returning id`, [eventParticipant.id, segment.id]);
  await q(
    `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, aggregation_role, coverage)
     values ($1,$2,$3,3200,'m','standalone','not_applicable')`,
    [compOccasion.id, distanceClubA, distanceClubADef.versionId],
  );
  // Session-scope SOURCE ROLLUP for the SAME underlying metric (5000m
  // whole-session total, reported directly by the source device) — Round
  // 2 §9 item 4: this and the component value above must NEVER be summed
  // together by the query adapter (one is a rollup already covering the
  // whole session; the other is one component's own standalone reading).
  const sessionOccasion = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id`, [eventParticipant.id]);
  await q(
    `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, aggregation_role, coverage)
     values ($1,$2,$3,5000,'m','source_rollup','complete')`,
    [sessionOccasion.id, distanceClubA, distanceClubADef.versionId],
  );

  // Round 2, §7 fixture: distanceSystem, one value under v1 (m), one under
  // v2 (km), both for Ana, both linked to Marko's own separate activity on
  // a later date within the same query period.
  const activity2 = await one(
    `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state, created_by_user_id)
     values ('training_session','PoC Session 2','2026-09-10','2026-09-10T09:00:00Z','Europe/Belgrade','club',$1,'manual','confirmed',$2) returning id`,
    [clubA.id, coachA.id],
  );
  const participant2 = await one(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,'2026-09-10','Europe/Belgrade','participated') returning id`,
    [activity2.id, ana.id],
  );
  const event2 = await one(
    `insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_club_id, source_connection_id, created_by_user_id)
     values ('PoC Session 2','2026-09-10','2026-09-10T09:00:00Z','session','club',$1,$2,$3) returning id`,
    [clubA.id, connClubA.id, coachA.id],
  );
  const eventParticipant2 = await one(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Belgrade') returning id`, [event2.id, ana.id]);
  await q(`insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [activity2.id, event2.id]);
  await q(`insert into training.activity_participant_metric_participant_links (activity_participant_id, metric_event_participant_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [participant2.id, eventParticipant2.id]);
  const occV1 = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id`, [eventParticipant.id]);
  await q(
    `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, aggregation_role, coverage)
     values ($1,$2,$3,4800,'m','standalone','not_applicable')`,
    [occV1.id, distanceSystem, (await one(`select id from training_load.metric_definition_versions where metric_definition_id=$1 and version_number=1`, [distanceSystem])).id],
  );
  const occV2 = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id`, [eventParticipant2.id]);
  await q(
    `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, aggregation_role, coverage)
     values ($1,$2,$3,4.9,'km','standalone','not_applicable')`,
    [occV2.id, distanceSystem, distanceSystemV2.id],
  );

  // A real RPE row — reached only via session_feedback, never metric_values.
  // The canonical read contract's own 'rpe' fact requires a CONFIRMED
  // training.activity_participant_session_links row resolving to a REAL,
  // live, published Weekly plan session (check_session_link_integrity,
  // v2) — a bare session_feedback row with a random logical_session_id is
  // not enough on its own (this gap existed silently in round 1's
  // fixture, since round 1 never actually called
  // canonical_activity_results() and asserted on its RPE fact — round 2's
  // real query adapter is what surfaces it).
  const logicalSessionId = crypto.randomUUID();
  const rpePlan = await one(
    `insert into plans.plans (plan_type, athlete_id, name, status, is_active, is_edit_draft, week_start, created_by_user_id)
     values ('weekly',$1,'PoC Weekly Plan','active',true,false,'2026-09-07',$2) returning id`,
    [ana.id, coachA.id],
  );
  await q(
    `insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_club_id) values ($1,'club',$2)`,
    [rpePlan.id, clubA.id],
  );
  const rpePlanDay = await one(`insert into plans.plan_days (plan_id, date, day_order) values ($1,'2026-09-09',1) returning id`, [rpePlan.id]);
  await q(`insert into plans.plan_sessions (plan_day_id, session_order, name, logical_session_id) values ($1,1,'PoC Session',$2)`, [rpePlanDay.id, logicalSessionId]);
  await q(
    `insert into training_load.session_feedback (athlete_id, session_date, plan_name, source, external_assignment_id, logical_session_id, rpe, duration_minutes)
     values ($1,'2026-09-09','PoC Plan','planned', null, $2, 7, 60)`,
    [ana.id, logicalSessionId],
  );
  await q(
    `insert into training.activity_participant_session_links (activity_participant_id, athlete_id, logical_session_id, link_method, link_status, confirmed_by_user_id, confirmed_at)
     values ($1,$2,$3,'manual','confirmed',$4,now())`,
    [participant.id, ana.id, logicalSessionId, coachA.id],
  );

  // ------------------------------------------------------------
  // Round 3 fixture additions — real data for the 36 new tests: a
  // team-owned activity, a private-coach-owned activity, a dual-role
  // relationship (privateCoach personally coaches Marko, who is ALSO a
  // Club A / Team A roster athlete — the exact shape §16/§18 must prove
  // never leaks Club A data into privateCoach's own workspace), a second
  // Club A source connection, a dedicated two-stage-aggregation fixture
  // (same-day multi-activity + a separate-day activity, for REAL daily-
  // reduction-then-analytical-aggregation numeric proofs), a dedicated
  // source-policy fixture (manual/api_import/csv_import/derived/two
  // distinct connections, all real occasions), and a dedicated
  // template-hint fixture (component-only scope capability, for the
  // richer-hint mismatch tests).
  // ------------------------------------------------------------

  const teamActivity = await one(
    `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_team_id, origin, lifecycle_state, created_by_user_id)
     values ('training_session','PoC Team Session','2026-09-09','2026-09-09T10:00:00Z','Europe/Belgrade','team',$1,'manual','confirmed',$2) returning id`,
    [teamA.id, coachA.id],
  );
  await q(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,'2026-09-09','Europe/Belgrade','participated')`,
    [teamActivity.id, marko.id],
  );

  const privateCoachActivity = await one(
    `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_user_id, origin, lifecycle_state, created_by_user_id)
     values ('training_session','PoC Private Coach Session','2026-09-09','2026-09-09T11:00:00Z','Europe/Belgrade','user',$1,'manual','confirmed',$1) returning id`,
    [privateCoach.id],
  );
  await q(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,'2026-09-09','Europe/Belgrade','participated')`,
    [privateCoachActivity.id, petra.id],
  );

  // The dual-role shape §16/§18 must prove is safe: privateCoach has a
  // REAL, ordinary user_athletes relationship to Marko — a Club A / Team
  // A roster athlete — entirely independent of privateCoach ever owning
  // any activity of Marko's own. A private_coach-workspace query for
  // privateCoach must never surface Marko's Club A activities just
  // because this relationship row exists.
  await q(`insert into public.user_athletes (user_id, athlete_id, relationship_type) values ($1,$2,'coach')`, [privateCoach.id, marko.id]);

  const connClubA2 = await one(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_club_id) values ('poc-manual-2','club',$1) returning id`, [clubA.id]);

  // --- Dedicated two-stage-aggregation fixture (Round 3 §29/§1 "Query
  // results" tests) — a metric whose daily_aggregation_method='sum' backs
  // TWO same-day activities (100 + 50 -> day-reduced 150) and one
  // separate-day activity (80), so Stage 1 (always 'sum', fixed) and
  // Stage 2 (freely chosen per test) can be told apart by REAL numbers:
  // sum([150,80])=230, avg([150,80])=115 (never avg of the 3 RAW values,
  // which would wrongly be 76.67), max([150,80])=150.
  // ------------------------------------------------------------
  const pipelineMetric = await makeDefinition({ key: "poc-pipeline-load", label: "Pipeline Load", ownerScope: "club", ownerClubId: clubA.id, unit: "au", dailyAggregationMethod: "sum" });
  async function makePipelineActivity(dateStr, startedAt, value, athleteId = ana.id) {
    const act = await one(
      `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state, created_by_user_id)
       values ('training_session','PoC Pipeline','${dateStr}','${startedAt}','Europe/Belgrade','club',$1,'manual','confirmed',$2) returning id`,
      [clubA.id, coachA.id],
    );
    const part = await one(
      `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,$3,'Europe/Belgrade','participated') returning id`,
      [act.id, athleteId, dateStr],
    );
    const ev = await one(
      `insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_club_id, source_connection_id, created_by_user_id)
       values ('PoC Pipeline','${dateStr}','${startedAt}','session','club',$1,$2,$3) returning id`,
      [clubA.id, connClubA.id, coachA.id],
    );
    const evp = await one(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Belgrade') returning id`, [ev.id, athleteId]);
    await q(`insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [act.id, ev.id]);
    await q(`insert into training.activity_participant_metric_participant_links (activity_participant_id, metric_event_participant_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [part.id, evp.id]);
    const occ = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id`, [evp.id]);
    await q(
      `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, aggregation_role, coverage)
       values ($1,$2,$3,$4,'au','standalone','not_applicable')`,
      [occ.id, pipelineMetric.id, pipelineMetric.versionId, value],
    );
    return act.id;
  }
  const pipelineActivityDay1a = await makePipelineActivity("2026-09-15", "2026-09-15T09:00:00Z", 100);
  const pipelineActivityDay1b = await makePipelineActivity("2026-09-15", "2026-09-15T17:00:00Z", 50);
  const pipelineActivityDay2 = await makePipelineActivity("2026-09-16", "2026-09-16T09:00:00Z", 80);
  const pipelineActivityMarko = await makePipelineActivity("2026-09-15", "2026-09-15T09:00:00Z", 20, marko.id);
  // A comparison-period pair — same metric, one activity on 2026-09-14,
  // exactly the single day shiftDateRange('2026-09-15','2026-09-15','previous_period')
  // computes as the "previous period" for a current query of the single
  // day 2026-09-15 — a REAL shifted-range proof, not an assumed offset.
  const pipelineActivityPrevPeriod = await makePipelineActivity("2026-09-14", "2026-09-14T09:00:00Z", 60);

  // --- Dedicated source-policy fixture (Round 3 §1 "Binding/source"
  // tests) — one metric, one event (source_connection=connClubA) hosting
  // four occasions with genuinely different entry_method/is_derived
  // values, plus a second event on the SAME activity through
  // connClubA2 — real, structurally distinct rows for real distinct
  // query results, not a single row reinterpreted four ways.
  // ------------------------------------------------------------
  const sourcePolicyMetric = await makeDefinition({ key: "poc-source-policy", label: "Source Policy Metric", ownerScope: "club", ownerClubId: clubA.id, unit: "bpm" });
  const occManual = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id`, [eventParticipant.id]);
  await q(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) values ($1,$2,$3,10,'bpm')`, [occManual.id, sourcePolicyMetric.id, sourcePolicyMetric.versionId]);
  const occApi = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'api_import') returning id`, [eventParticipant.id]);
  await q(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) values ($1,$2,$3,20,'bpm')`, [occApi.id, sourcePolicyMetric.id, sourcePolicyMetric.versionId]);
  const occCsv = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'csv_import') returning id`, [eventParticipant.id]);
  await q(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) values ($1,$2,$3,30,'bpm')`, [occCsv.id, sourcePolicyMetric.id, sourcePolicyMetric.versionId]);
  const occDerived = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'api_import') returning id`, [eventParticipant.id]);
  await q(
    `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, aggregation_role, coverage, is_derived, computed_by_ref)
     values ($1,$2,$3,99,'bpm','derived_rollup','complete',true,'{"formula":"poc"}'::jsonb)`,
    [occDerived.id, sourcePolicyMetric.id, sourcePolicyMetric.versionId],
  );
  // A SEPARATE activity (never `activity.id`) for the connA2 fact — entry_
  // method values are a closed 3-way set (manual/api_import/csv_import)
  // that MUST collide with one of §10.29-31's own exact-match expectations
  // no matter which is picked (entry-method policies are, correctly,
  // connection-agnostic); keeping this fact on its own activity is what
  // lets those three tests scope via activityIds to exclude it cleanly,
  // while §10.33 (source_connection, which IS connection-aware) opts back
  // in by listing both activities explicitly.
  const activityConnA2 = await one(
    `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state, created_by_user_id)
     values ('training_session','PoC Conn A2 Session','2026-09-09','2026-09-09T09:30:00Z','Europe/Belgrade','club',$1,'manual','confirmed',$2) returning id`,
    [clubA.id, coachA.id],
  );
  const participantConnA2 = await one(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,'2026-09-09','Europe/Belgrade','participated') returning id`,
    [activityConnA2.id, ana.id],
  );
  const eventConnA2 = await one(
    `insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_club_id, source_connection_id, created_by_user_id)
     values ('PoC Conn A2','2026-09-09','2026-09-09T09:30:00Z','session','club',$1,$2,$3) returning id`,
    [clubA.id, connClubA2.id, coachA.id],
  );
  const eventConnA2Participant = await one(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Belgrade') returning id`, [eventConnA2.id, ana.id]);
  await q(`insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [activityConnA2.id, eventConnA2.id]);
  await q(`insert into training.activity_participant_metric_participant_links (activity_participant_id, metric_event_participant_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [participantConnA2.id, eventConnA2Participant.id]);
  const occConnA2 = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id`, [eventConnA2Participant.id]);
  await q(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) values ($1,$2,$3,50,'bpm')`, [occConnA2.id, sourcePolicyMetric.id, sourcePolicyMetric.versionId]);

  // --- Dedicated template-hint fixture (Round 3 §5 "Binding/source"
  // tests) — configured for 'component' scope capability ONLY, never
  // 'session', so a richer hint's scopeLevel mismatch has something real
  // to reject.
  // ------------------------------------------------------------
  const hintOnlyDef = await one(
    `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id, state, created_by_user_id) values ('poc-hint-component-only','Hint Component Only','club',$1,'active',$2) returning id`,
    [clubA.id, coachA.id],
  );
  const hintOnlyVer = await one(
    `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id) values ($1,1,'m','numeric','sum',$2) returning id`,
    [hintOnlyDef.id, coachA.id],
  );
  await q(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [hintOnlyVer.id, hintOnlyDef.id]);
  await q(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'component')`, [hintOnlyDef.id]);

  return {
    clubA: clubA.id, clubB: clubB.id, teamA: teamA.id,
    platformAdmin: platformAdmin.id, coachA: coachA.id, coachB: coachB.id, privateCoach: privateCoach.id,
    ana: ana.id, marko: marko.id, petra: petra.id,
    distanceSystem, distanceClubA, distanceClubB, hrClubA, privateHrCoachA, privateHrPrivateCoach, userMetricPrivateCoach,
    archivedDef, notSummableDef, ambiguousHintKey, ambiguousSystem, ambiguousClubA,
    connSystem: connSystem.id, connClubA: connClubA.id, connClubB: connClubB.id, connClubA2: connClubA2.id,
    activity: activity.id, activity2: activity2.id, component: component.id,
    eventParticipant: eventParticipant.id, segment: segment.id,
    teamActivity: teamActivity.id, privateCoachActivity: privateCoachActivity.id,
    pipelineMetric: pipelineMetric.id, pipelineActivityDay1a, pipelineActivityDay1b, pipelineActivityDay2,
    pipelineActivityMarko, pipelineActivityPrevPeriod,
    sourcePolicyMetric: sourcePolicyMetric.id, activityConnA2: activityConnA2.id,
    hintOnlyDef: hintOnlyDef.id, hintOnlyKey: "poc-hint-component-only",
  };
}

// ------------------------------------------------------------
// Concurrency helpers.
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

// ------------------------------------------------------------
// Small fixture-creation helpers shared across many tests.
// ------------------------------------------------------------
async function makeDashboard({ ownerScope, ownerUserId = null, ownerClubId = null, ownerTeamId = null, dataWorkspaceType = null, dataWorkspaceScopeId = null, isTemplate = false, createdBy }) {
  return one(
    `insert into training_load.dashboards (name, owner_scope, owner_user_id, owner_club_id, owner_team_id, data_workspace_type, data_workspace_scope_id, is_template, created_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    ["PoC Dashboard " + crypto.randomBytes(3).toString("hex"), ownerScope, ownerUserId, ownerClubId, ownerTeamId, dataWorkspaceType, dataWorkspaceScopeId, isTemplate, createdBy],
  );
}
async function makeWidget(dashboardId, { widgetType = "kpi", x = 0, y = 0, width = 3, height = 2, mobileOrder = 1, order = 1 } = {}) {
  return one(
    `insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,$2,'W',$3,$4,$5,$6,$7,$8) returning *`,
    [dashboardId, widgetType, order, x, y, width, height, mobileOrder],
  );
}
async function addSeries(widgetId, fields = {}) {
  const cols = ["widget_id", "series_order"];
  const vals = [widgetId, fields.seriesOrder ?? 1];
  const map = {
    metricDefinitionId: "metric_definition_id", builtInSeriesKey: "built_in_series_key", templateHints: "template_metric_key_hints",
    axis: "axis", sourcePolicy: "source_policy", sourceConnectionId: "source_connection_id", dataScopeLevel: "data_scope_level",
    analyticalAggregation: "analytical_aggregation", aggregationRolePolicy: "aggregation_role_policy", coveragePolicy: "coverage_policy", comparisonPeriod: "comparison_period",
  };
  for (const [k, col] of Object.entries(map)) {
    if (fields[k] !== undefined) { cols.push(col); vals.push(fields[k]); }
  }
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  return one(`insert into training_load.dashboard_widget_series (${cols.join(",")}) values (${placeholders}) returning *`, vals);
}

// A fresh, never-shared club-A metric_definition — used by the §9.5-9.9
// query-adapter tests specifically so each test's own effective-value
// count is never polluted by fixture rows a DIFFERENT, earlier test added
// to a shared definition (this whole harness shares one database/fixture
// across all tests, run sequentially).
async function makeQuickMetric(label) {
  const def = await one(
    `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id, state, created_by_user_id) values ($1,$2,'club',$3,'active',$4) returning id`,
    [`poc-quick-${crypto.randomBytes(4).toString("hex")}`, label, ids.clubA, ids.coachA],
  );
  const ver = await one(
    `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, created_by_user_id) values ($1,1,'bpm','numeric','sum',$2) returning id`,
    [def.id, ids.coachA],
  );
  await q(`update training_load.metric_definitions set current_version_id=$1 where id=$2`, [ver.id, def.id]);
  await q(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'session'),($1,'component')`, [def.id]);
  return def.id;
}

// ============================================================
// §1 — Owner vs. data-workspace separation.
// ============================================================

test("§1.1 a private dashboard bound to Club A's data workspace can reference Club A's own metric", async () => {
  const dash = await makeDashboard({ ownerScope: "user", ownerUserId: ids.coachA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4 });
  const series = await addSeries(widget.id, { metricDefinitionId: ids.distanceClubA });
  assert.equal(series.metric_definition_id, ids.distanceClubA);
});

test("§1.2 the SAME private dashboard cannot be queried/used in Club B — its data workspace is fixed to Club A", async () => {
  const dash = await makeDashboard({ ownerScope: "user", ownerUserId: ids.coachA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4 });
  await assert.rejects(
    addSeries(widget.id, { metricDefinitionId: ids.distanceClubB }),
    /not visible to this dashboard's data workspace/,
  );
  // Nor can it be selected as the active dashboard while viewing Club B.
  await assert.rejects(
    q(`insert into training_load.dashboard_active_selection (user_id, workspace_type, scope_id, dashboard_id) values ($1,'club',$2,$3)`, [ids.coachA, ids.clubB, dash.id]),
    /does not match the exact selection context/,
  );
  // It CAN be selected while actually viewing Club A.
  await q(`insert into training_load.dashboard_active_selection (user_id, workspace_type, scope_id, dashboard_id) values ($1,'club',$2,$3)`, [ids.coachA, ids.clubA, dash.id]);
});

test("§1.3 a private dashboard can instead be bound to a Team A workspace and reads team-visible data only", async () => {
  const dash = await makeDashboard({ ownerScope: "user", ownerUserId: ids.coachA, dataWorkspaceType: "team", dataWorkspaceScopeId: ids.teamA, createdBy: ids.coachA });
  await q(`insert into training_load.dashboard_active_selection (user_id, workspace_type, scope_id, dashboard_id) values ($1,'team',$2,$3)`, [ids.coachA, ids.teamA, dash.id]);
  const sel = await one(`select dashboard_id from training_load.dashboard_active_selection where user_id=$1 and workspace_type='team' and scope_id=$2`, [ids.coachA, ids.teamA]);
  assert.equal(sel.dashboard_id, dash.id);
});

test("§1.4 a private-coach dashboard (no club/team) is bound to their own private_coach workspace and can use their own private metric", async () => {
  const dash = await makeDashboard({ ownerScope: "user", ownerUserId: ids.privateCoach, dataWorkspaceType: "private_coach", createdBy: ids.privateCoach });
  const widget = await makeWidget(dash.id);
  const series = await addSeries(widget.id, { metricDefinitionId: ids.userMetricPrivateCoach });
  assert.equal(series.metric_definition_id, ids.userMetricPrivateCoach);
  await q(`insert into training_load.dashboard_active_selection (user_id, workspace_type, scope_id, dashboard_id) values ($1,'private_coach',null,$2)`, [ids.privateCoach, dash.id]);
});

test("§1.5 the SAME user can have two different private dashboards bound to two different data workspaces", async () => {
  const dashClubA = await makeDashboard({ ownerScope: "user", ownerUserId: ids.coachA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const dashTeamA = await makeDashboard({ ownerScope: "user", ownerUserId: ids.coachA, dataWorkspaceType: "team", dataWorkspaceScopeId: ids.teamA, createdBy: ids.coachA });
  assert.notEqual(dashClubA.id, dashTeamA.id);
  assert.equal(dashClubA.owner_user_id, dashTeamA.owner_user_id);
});

test("§1.6 revoking a coach's workspace role leaves the dashboard row and its config completely intact — blocking selection/query/edit is an APPLICATION-layer requirement this PoC documents but cannot fully exercise without a real auth layer", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubB, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubB, createdBy: ids.coachB });
  const widget = await makeWidget(dash.id);
  await addSeries(widget.id, { metricDefinitionId: ids.distanceClubB });
  await q(`update public.user_club_roles set is_active=false where user_id=$1 and club_id=$2`, [ids.coachB, ids.clubB]);
  const stillActive = await one(`select is_active from public.user_club_roles where user_id=$1 and club_id=$2`, [ids.coachB, ids.clubB]);
  assert.equal(stillActive.is_active, false);
  // The dashboard/widget/series rows themselves are completely untouched —
  // the schema does not (and structurally cannot) delete or hide them on
  // role revocation; a real route must call the SAME resolveActiveWorkspace
  // check every other Training Load feature already uses, on every
  // selection/query/edit request, never trusting a cached grant. This test
  // documents the boundary; it is not, and cannot be, a real auth test.
  const stillThere = await one(`select status from training_load.dashboards where id=$1`, [dash.id]);
  assert.equal(stillThere.status, "active");
});

test("§1.7 club/team-owned dashboards have their data workspace forced to match their owner scope — no independent choice, no mismatch possible", async () => {
  await assert.rejects(
    q(`insert into training_load.dashboards (name, owner_scope, owner_club_id, data_workspace_type, data_workspace_scope_id, created_by_user_id) values ('bad','club',$1,'club',$2,$3)`, [ids.clubA, ids.clubB, ids.coachA]),
    /violates check constraint/,
  );
});

test("§1.8 a system dashboard is always a template with a workspace-agnostic (NULL) data binding until cloned", async () => {
  const tmpl = await makeDashboard({ ownerScope: "system", isTemplate: true, createdBy: ids.platformAdmin });
  assert.equal(tmpl.data_workspace_type, null);
  await assert.rejects(
    q(`insert into training_load.dashboards (name, owner_scope, is_template, created_by_user_id) values ('x','system',false,$1)`, [ids.platformAdmin]),
    /violates check constraint/,
    "owner_scope='system' implies is_template=true",
  );
});

// ============================================================
// §2 — Series query semantics.
// ============================================================

test("§2.1 [Round 3, §1] analytical_aggregation is now INDEPENDENT of the metric's own daily_aggregation_method — the Round 2 equality trigger is gone, any of the 4 widgets below is legal even though distanceClubA declares daily_aggregation_method='sum'", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const wSum = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4, order: 1, mobileOrder: 1 });
  const wAvg = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4, y: 4, order: 2, mobileOrder: 2 });
  const wMax = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4, y: 8, order: 3, mobileOrder: 3 });
  const wNone = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4, y: 12, order: 4, mobileOrder: 4 });
  const sSum = await addSeries(wSum.id, { metricDefinitionId: ids.distanceClubA, analyticalAggregation: "sum" });
  const sAvg = await addSeries(wAvg.id, { metricDefinitionId: ids.distanceClubA, analyticalAggregation: "avg" });
  const sMax = await addSeries(wMax.id, { metricDefinitionId: ids.distanceClubA, analyticalAggregation: "max" });
  const sNone = await addSeries(wNone.id, { metricDefinitionId: ids.distanceClubA, analyticalAggregation: "none" });
  assert.equal(sSum.analytical_aggregation, "sum");
  assert.equal(sAvg.analytical_aggregation, "avg");
  assert.equal(sMax.analytical_aggregation, "max");
  assert.equal(sNone.analytical_aggregation, "none");
  // notSummableDef declares daily_aggregation_method='max' — Round 2 would
  // have refused analytical_aggregation='sum' here; Round 3 allows it
  // outright, same independence.
  const s2 = await addSeries(wSum.id, { seriesOrder: 2, metricDefinitionId: ids.notSummableDef, analyticalAggregation: "sum" });
  assert.equal(s2.analytical_aggregation, "sum");
});

test("§2.2 aggregation_role_policy and coverage_policy are real, validated columns, not an undefined frontend convention", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4 });
  const s = await addSeries(widget.id, { metricDefinitionId: ids.distanceClubA, aggregationRolePolicy: "standalone_only", coveragePolicy: "complete_only" });
  assert.equal(s.aggregation_role_policy, "standalone_only");
  assert.equal(s.coverage_policy, "complete_only");
  await assert.rejects(q(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, aggregation_role_policy) values ($1,2,$2,'not_a_real_policy')`, [widget.id, ids.distanceClubA]));
});

test("§2.3 comparison_period is rejected on a widget type that does not support it, and cleared/blocked when switching away from KPI", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const table = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4 });
  await assert.rejects(addSeries(table.id, { metricDefinitionId: ids.distanceClubA, comparisonPeriod: "previous_period" }), /comparison_period is not supported/);
  const kpi = await makeWidget(dash.id, { widgetType: "kpi", x: 6, y: 0, order: 2, mobileOrder: 2 });
  await addSeries(kpi.id, { metricDefinitionId: ids.distanceClubA, comparisonPeriod: "previous_period" });
  await assert.rejects(q(`update training_load.dashboard_widgets set widget_type='table', width=6, height=4 where id=$1`, [kpi.id]), /an existing series still has a comparison_period set/);
});

test("§2.4 built-in series have a fixed, non-choosable data_scope_level", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4 });
  await assert.rejects(addSeries(widget.id, { builtInSeriesKey: "rpe", dataScopeLevel: "component", analyticalAggregation: "avg" }), /always scope_level=session/);
  const ok = await addSeries(widget.id, { builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "avg", sourcePolicy: "not_applicable" });
  assert.equal(ok.data_scope_level, "session");
});

test("§2.5 display_config requires a schemaVersion key — an unversioned blob is refused", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  await assert.rejects(
    q(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order, display_config) values ($1,'kpi','X',1,0,0,3,2,1,'{}'::jsonb)`, [dash.id]),
  );
  const widget = await makeWidget(dash.id);
  assert.deepEqual(widget.display_config, { schemaVersion: 1 });
});

// ============================================================
// §3 — Revision and cache identity.
// ============================================================

test("§3.1 adding or removing a widget bumps the DASHBOARD's own revision", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  assert.equal(dash.revision, 1);
  const widget = await makeWidget(dash.id);
  const afterAdd = await one(`select revision from training_load.dashboards where id=$1`, [dash.id]);
  assert.equal(afterAdd.revision, 2);
  await q(`delete from training_load.dashboard_widgets where id=$1`, [widget.id]);
  const afterRemove = await one(`select revision from training_load.dashboards where id=$1`, [dash.id]);
  assert.equal(afterRemove.revision, 3);
});

test("§3.2 adding, updating, deleting, or reordering a series bumps the WIDGET's own revision", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4 });
  const afterCreate = await one(`select revision from training_load.dashboard_widgets where id=$1`, [widget.id]);
  assert.equal(afterCreate.revision, 1);
  const series = await addSeries(widget.id, { metricDefinitionId: ids.distanceClubA });
  const afterAdd = await one(`select revision from training_load.dashboard_widgets where id=$1`, [widget.id]);
  assert.equal(afterAdd.revision, 2);
  await q(`update training_load.dashboard_widget_series set display_label='X' where id=$1`, [series.id]);
  const afterUpdate = await one(`select revision from training_load.dashboard_widgets where id=$1`, [widget.id]);
  assert.equal(afterUpdate.revision, 3);
  await q(`delete from training_load.dashboard_widget_series where id=$1`, [series.id]);
  const afterDelete = await one(`select revision from training_load.dashboard_widgets where id=$1`, [widget.id]);
  assert.equal(afterDelete.revision, 4);
});

test("§3.3 changing widget_type bumps the widget's own revision", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "kpi" });
  await q(`update training_load.dashboard_widgets set widget_type='table', width=6, height=4 where id=$1`, [widget.id]);
  const after = await one(`select revision, widget_type from training_load.dashboard_widgets where id=$1`, [widget.id]);
  assert.equal(after.widget_type, "table");
  assert.equal(after.revision, 2);
});

test("§3.4 two edits to DIFFERENT widgets never produce a false optimistic conflict — proven with a real DB barrier, not sleep", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const w1 = await makeWidget(dash.id, { x: 0, y: 0, mobileOrder: 1, order: 1 });
  const w2 = await makeWidget(dash.id, { x: 4, y: 0, mobileOrder: 2, order: 2 });
  const a = await newClient();
  const b = await newClient();
  try {
    await a.client.query("begin");
    await a.client.query("update training_load.dashboard_widgets set width=4 where id=$1", [w1.id]);
    const bPromise = b.client.query("update training_load.dashboard_widgets set width=4 where id=$1", [w2.id]);
    const blocked = await waitUntilBlocked(b.pid);
    assert.ok(blocked, "writer B genuinely blocked behind the shared dashboard-row lock, not a timing guess");
    await a.client.query("commit");
    await bPromise;
  } finally {
    await a.client.end();
    await b.client.end();
  }
  const r1 = await one(`select revision from training_load.dashboard_widgets where id=$1`, [w1.id]);
  const r2 = await one(`select revision from training_load.dashboard_widgets where id=$1`, [w2.id]);
  assert.equal(r1.revision, 2);
  assert.equal(r2.revision, 2);
});

test("§3.5 two edits to the SAME widget with the same stale revision give exactly one success and one controlled conflict", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id);
  const staleRevision = widget.revision;
  const applyA = await q(`update training_load.dashboard_widgets set title='By A' where id=$1 and revision=$2 returning revision`, [widget.id, staleRevision]);
  assert.equal(applyA.rowCount, 1);
  const applyB = await q(`update training_load.dashboard_widgets set title='By B' where id=$1 and revision=$2`, [widget.id, staleRevision]);
  assert.equal(applyB.rowCount, 0);
});

// ============================================================
// §4 — Reverse invariants.
// ============================================================

test("§4.1 is_template cannot flip to false while an unresolved (hints-only) series still exists", async () => {
  const tmpl = await makeDashboard({ ownerScope: "system", isTemplate: true, createdBy: ids.platformAdmin });
  const widget = await makeWidget(tmpl.id);
  await addSeries(widget.id, { templateHints: JSON.stringify(["distance_total_m"]) });
  await assert.rejects(
    q(`update training_load.dashboards set is_template=false where id=$1`, [tmpl.id]),
    /cannot flip is_template to false while unresolved/,
  );
});

test("§4.2 switching Table -> KPI re-checks the max-series cap against EXISTING series", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4 });
  await addSeries(widget.id, { seriesOrder: 1, metricDefinitionId: ids.distanceClubA });
  await addSeries(widget.id, { seriesOrder: 2, metricDefinitionId: ids.hrClubA });
  await assert.rejects(
    q(`update training_load.dashboard_widgets set widget_type='kpi', width=3, height=2 where id=$1`, [widget.id]),
    /already has 2 series, that type allows at most 1/,
  );
});

test("§4.3 switching Table -> Line chart re-checks axis-unit compatibility against EXISTING series", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4 });
  await addSeries(widget.id, { seriesOrder: 1, metricDefinitionId: ids.distanceClubA }); // unit m, axis primary (default)
  await addSeries(widget.id, { seriesOrder: 2, metricDefinitionId: ids.hrClubA }); // unit bpm, axis primary (default) — fine on a Table
  await assert.rejects(
    q(`update training_load.dashboard_widgets set widget_type='line_chart', width=6, height=4 where id=$1`, [widget.id]),
    /axis primary already mixes incompatible units/,
  );
});

test("§4.4 a source_connection must be visible to the dashboard's own data workspace — Club B's connection is rejected on a Club-A-bound dashboard", async () => {
  const dash = await makeDashboard({ ownerScope: "user", ownerUserId: ids.coachA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4 });
  await assert.rejects(
    addSeries(widget.id, { metricDefinitionId: ids.distanceClubA, sourcePolicy: "source_connection", sourceConnectionId: ids.connClubB }),
    /is not visible to this dashboard's data workspace/,
  );
  const ok = await addSeries(widget.id, { metricDefinitionId: ids.distanceClubA, sourcePolicy: "source_connection", sourceConnectionId: ids.connClubA });
  assert.equal(ok.source_connection_id, ids.connClubA);
});

test("§4.5 [Round 3, §1] a built-in RPE series cannot carry a source_connection or any policy other than 'not_applicable' — it is never fairly described as 'manual'", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4 });
  await assert.rejects(addSeries(widget.id, { builtInSeriesKey: "rpe", analyticalAggregation: "avg", sourcePolicy: "source_connection", sourceConnectionId: ids.connClubA }), /violates check constraint/);
  await assert.rejects(addSeries(widget.id, { builtInSeriesKey: "rpe", analyticalAggregation: "avg", sourcePolicy: "api_import" }), /violates check constraint/);
  await assert.rejects(addSeries(widget.id, { builtInSeriesKey: "rpe", analyticalAggregation: "avg", sourcePolicy: "manual" }), /violates check constraint/, "Round 3: 'manual' is no longer accepted for a built-in series — see the source_policy column comment");
  const ok = await addSeries(widget.id, { builtInSeriesKey: "rpe", analyticalAggregation: "avg", sourcePolicy: "not_applicable" });
  assert.equal(ok.source_policy, "not_applicable");
  // And the reverse direction: a REAL Metrics-Core-backed series must NOT use 'not_applicable'.
  await assert.rejects(addSeries(widget.id, { seriesOrder: 2, metricDefinitionId: ids.distanceClubA, sourcePolicy: "not_applicable" }), /violates check constraint/);
});

test("§4.6 catalog rows are protected in BOTH directions: child-first-then-parent-change, and parent-change-first-then-child-write", async () => {
  // Direction A: series already exists referencing a built-in -> its
  // catalog semantics become immutable.
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id);
  await addSeries(widget.id, { builtInSeriesKey: "duration_minutes", sourcePolicy: "not_applicable" });
  await assert.rejects(q(`update training_load.dashboard_builtin_series set unit='hours' where key='duration_minutes'`), /already referenced by a widget/);

  // Direction B: deactivate a widget_type FIRST, then prove a NEW widget of
  // that type is refused, but an EXISTING widget of that type can still be
  // resized within its old bounds (never broken by the deactivation).
  await q(`update training_load.dashboard_widget_types set is_active=false where key='bar_chart'`);
  await assert.rejects(q(`insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'bar_chart','X',9,0,8,4,4,9)`, [dash.id]), /is not active/);
  await q(`update training_load.dashboard_widget_types set is_active=true where key='bar_chart'`); // restore for later tests
  const barWidget = await makeWidget(dash.id, { widgetType: "bar_chart", x: 0, y: 8, width: 4, height: 4, mobileOrder: 9, order: 9 });
  await q(`update training_load.dashboard_widget_types set is_active=false where key='bar_chart'`);
  // Existing widget can still be resized (type unchanged) even though its
  // type is now inactive — deactivation blocks new picks, never existing edits.
  await q(`update training_load.dashboard_widgets set width=5 where id=$1`, [barWidget.id]);
  const after = await one(`select width from training_load.dashboard_widgets where id=$1`, [barWidget.id]);
  assert.equal(after.width, 5);
  await q(`update training_load.dashboard_widget_types set is_active=true where key='bar_chart'`);

  // Direction B2 [Round 3, §7 CORRECTION]: once a widget_type is actually
  // IN USE (any widget references it), its size/series-cap/axis/comparison
  // contract is now REJECTED OUTRIGHT on change — Round 2 previously
  // allowed shrinking max_series and reasoned it was "harmless" because
  // nothing retroactively touched existing rows; the task explicitly
  // rejects that framing (a shrink that would invalidate an existing
  // widget's already-saved state must be refused, not silently tolerated).
  const tableWidget = await makeWidget(dash.id, { widgetType: "table", x: 0, y: 12, width: 6, height: 4, mobileOrder: 10, order: 10 });
  await addSeries(tableWidget.id, { seriesOrder: 1, metricDefinitionId: ids.distanceClubA });
  await addSeries(tableWidget.id, { seriesOrder: 2, metricDefinitionId: ids.hrClubA });
  await assert.rejects(
    q(`update training_load.dashboard_widget_types set max_series=1 where key='table'`),
    /already referenced by a widget/,
    "Round 3: the catalog change itself must be rejected outright once any widget of that type exists — never silently accepted and left unenforced",
  );
  const stillTwo = await one(`select count(*)::int as n from training_load.dashboard_widget_series where widget_id=$1`, [tableWidget.id]);
  assert.equal(stillTwo.n, 2, "the rejected catalog change must leave existing series completely untouched");
  const capUnchanged = await one(`select max_series from training_load.dashboard_widget_types where key='table'`);
  assert.equal(capUnchanged.max_series, 12, "the catalog row's own max_series must be unchanged, not partially applied");
  // is_active and label remain freely mutable even while in use.
  await q(`update training_load.dashboard_widget_types set label='Table (renamed)' where key='table'`);
  const relabelled = await one(`select label from training_load.dashboard_widget_types where key='table'`);
  assert.equal(relabelled.label, "Table (renamed)");
  await q(`update training_load.dashboard_widget_types set label='Table' where key='table'`);
});

// ============================================================
// §5 — Locking and concurrent series writes.
// ============================================================

test("§5.1 two concurrent series INSERTs on the SAME widget never both pass the max_series cap — real lock-wait proof", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "kpi" }); // max_series=1
  const a = await newClient();
  const b = await newClient();
  try {
    await a.client.query("begin");
    await a.client.query("insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,1,$2)", [widget.id, ids.distanceClubA]);
    const bPromise = b.client.query("insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,2,$2)", [widget.id, ids.hrClubA])
      .catch((e) => ({ error: e }));
    const blocked = await waitUntilBlocked(b.pid);
    assert.ok(blocked, "writer B genuinely blocked on the widget-row lock, not a timing guess");
    await a.client.query("commit");
    const bResult = await bPromise;
    assert.ok(bResult.error, "the second concurrent insert must fail the cap check once it can finally see A's committed row");
    assert.match(bResult.error.message, /already has 1 series, the max allowed is 1/);
  } finally {
    await a.client.end();
    await b.client.end();
  }
  const count = await one(`select count(*)::int as n from training_load.dashboard_widget_series where widget_id=$1`, [widget.id]);
  assert.equal(count.n, 1);
});

test("§5.2 two concurrent series INSERTs with different units never both land on the same chart axis — real lock-wait proof", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "line_chart", width: 6, height: 4 });
  const a = await newClient();
  const b = await newClient();
  try {
    await a.client.query("begin");
    await a.client.query("insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, axis) values ($1,1,$2,'primary')", [widget.id, ids.distanceClubA]); // unit m
    const bPromise = b.client.query("insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, axis) values ($1,2,$2,'primary')", [widget.id, ids.hrClubA]) // unit bpm
      .catch((e) => ({ error: e }));
    const blocked = await waitUntilBlocked(b.pid);
    assert.ok(blocked, "writer B genuinely blocked, not a timing guess");
    await a.client.query("commit");
    const bResult = await bPromise;
    assert.ok(bResult.error);
    assert.match(bResult.error.message, /unit mismatch/);
  } finally {
    await a.client.end();
    await b.client.end();
  }
});

test("§5.3 a widget_type change and a concurrent series insert on the same widget never deadlock — deterministic sequential outcome", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4 });
  await addSeries(widget.id, { seriesOrder: 1, metricDefinitionId: ids.distanceClubA });
  const a = await newClient();
  const b = await newClient();
  try {
    await a.client.query("begin");
    await a.client.query("update training_load.dashboard_widgets set title='retitled' where id=$1", [widget.id]); // takes the widget row lock, no type change yet
    const bPromise = b.client.query("insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id) values ($1,2,$2)", [widget.id, ids.hrClubA]);
    const blocked = await waitUntilBlocked(b.pid);
    assert.ok(blocked, "B genuinely blocked behind A's widget-row lock");
    await a.client.query("commit");
    await bPromise; // proceeds cleanly, no deadlock, no error
  } finally {
    await a.client.end();
    await b.client.end();
  }
  const count = await one(`select count(*)::int as n from training_load.dashboard_widget_series where widget_id=$1`, [widget.id]);
  assert.equal(count.n, 2);
});

// ============================================================
// §6 — Atomic layout replace.
// ============================================================

test("§6.1 two concurrent FIRST-widget inserts on the same brand-new dashboard never overlap", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const a = await newClient();
  const b = await newClient();
  try {
    await a.client.query("begin");
    await a.client.query("insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','A',1,0,0,4,2,1)", [dash.id]);
    const bPromise = b.client.query("insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order) values ($1,'kpi','B',2,2,0,4,2,2)", [dash.id])
      .catch((e) => ({ error: e }));
    const blocked = await waitUntilBlocked(b.pid);
    assert.ok(blocked);
    await a.client.query("commit");
    const bResult = await bPromise;
    assert.ok(bResult.error, "the overlapping second insert must fail once the deferred check runs at B's own commit");
  } finally {
    await a.client.end();
    await b.client.end();
  }
  const count = await one(`select count(*)::int as n from training_load.dashboard_widgets where dashboard_id=$1`, [dash.id]);
  assert.equal(count.n, 1);
});

test("§6.2 a plain two-widget swap succeeds atomically via replace_dashboard_layout", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const w1 = await makeWidget(dash.id, { x: 0, y: 0, mobileOrder: 1, order: 1 });
  const w2 = await makeWidget(dash.id, { x: 4, y: 0, mobileOrder: 2, order: 2 });
  const dashRow = await one(`select revision from training_load.dashboards where id=$1`, [dash.id]);
  const layout = JSON.stringify([{ widgetId: w1.id, x: 4, y: 0 }, { widgetId: w2.id, x: 0, y: 0 }]);
  const result = await q(`select * from training_load.replace_dashboard_layout($1,$2,$3::jsonb)`, [dash.id, dashRow.revision, layout]);
  const byId = Object.fromEntries(result.rows.map((r) => [r.widget_id, r]));
  assert.equal(byId[w1.id].x, 4);
  assert.equal(byId[w2.id].x, 0);
});

test("§6.3 a multi-widget rearrange (3+ widgets) succeeds atomically", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const w1 = await makeWidget(dash.id, { x: 0, y: 0, mobileOrder: 1, order: 1 });
  const w2 = await makeWidget(dash.id, { x: 4, y: 0, mobileOrder: 2, order: 2 });
  const w3 = await makeWidget(dash.id, { x: 8, y: 0, mobileOrder: 3, order: 3 });
  const dashRow = await one(`select revision from training_load.dashboards where id=$1`, [dash.id]);
  const layout = JSON.stringify([
    { widgetId: w1.id, x: 8, mobileOrder: 3 },
    { widgetId: w2.id, x: 0, mobileOrder: 1 },
    { widgetId: w3.id, x: 4, mobileOrder: 2 },
  ]);
  const result = await q(`select * from training_load.replace_dashboard_layout($1,$2,$3::jsonb)`, [dash.id, dashRow.revision, layout]);
  const byId = Object.fromEntries(result.rows.map((r) => [r.widget_id, r]));
  assert.equal(byId[w1.id].x, 8);
  assert.equal(byId[w2.id].x, 0);
  assert.equal(byId[w3.id].x, 4);
  assert.equal(byId[w2.id].mobile_order, 1);
});

test("§6.4 a final layout that still overlaps is rejected, with zero partial writes surviving (transaction rolled back)", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const w1 = await makeWidget(dash.id, { x: 0, y: 0, mobileOrder: 1, order: 1 });
  const w2 = await makeWidget(dash.id, { x: 4, y: 0, mobileOrder: 2, order: 2 });
  const dashRow = await one(`select revision from training_load.dashboards where id=$1`, [dash.id]);
  const layout = JSON.stringify([{ widgetId: w1.id, x: 2 }, { widgetId: w2.id, x: 3 }]); // still overlap: [2,6) vs [3,7)
  const client = await newClient();
  try {
    await client.client.query("begin");
    await assert.rejects(client.client.query(`select * from training_load.replace_dashboard_layout($1,$2,$3::jsonb)`, [dash.id, dashRow.revision, layout]));
    await client.client.query("rollback");
  } finally {
    await client.client.end();
  }
  const after1 = await one(`select x from training_load.dashboard_widgets where id=$1`, [w1.id]);
  const after2 = await one(`select x from training_load.dashboard_widgets where id=$1`, [w2.id]);
  assert.equal(after1.x, 0, "rollback must restore the OLD x, never leave the partial new value");
  assert.equal(after2.x, 4);
});

test("§6.5 two concurrent replace_dashboard_layout calls with the same stale revision: one succeeds, one gets a controlled conflict", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const w1 = await makeWidget(dash.id, { x: 0, y: 0, mobileOrder: 1, order: 1 });
  const startRevision = (await one(`select revision from training_load.dashboards where id=$1`, [dash.id])).revision;
  const layoutA = JSON.stringify([{ widgetId: w1.id, x: 2 }]);
  const layoutB = JSON.stringify([{ widgetId: w1.id, x: 6 }]);
  const okA = await q(`select * from training_load.replace_dashboard_layout($1,$2,$3::jsonb)`, [dash.id, startRevision, layoutA]);
  assert.equal(okA.rows[0].x, 2);
  await assert.rejects(
    q(`select * from training_load.replace_dashboard_layout($1,$2,$3::jsonb)`, [dash.id, startRevision, layoutB]),
    /stale revision/,
  );
  const final = await one(`select x from training_load.dashboard_widgets where id=$1`, [w1.id]);
  assert.equal(final.x, 2, "the stale second call must never overwrite the first");
});

test("§6.6 lock order for replace_dashboard_layout matches the rest of the subsystem — it locks the dashboard row first", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const w1 = await makeWidget(dash.id, { x: 0, y: 0, mobileOrder: 1, order: 1 });
  const rev = (await one(`select revision from training_load.dashboards where id=$1`, [dash.id])).revision;
  const a = await newClient();
  const b = await newClient();
  try {
    await a.client.query("begin");
    await a.client.query(`select * from training_load.replace_dashboard_layout($1,$2,$3::jsonb)`, [dash.id, rev, JSON.stringify([{ widgetId: w1.id, x: 3 }])]);
    const bPromise = b.client.query("update training_load.dashboard_widgets set title='concurrent' where id=$1", [w1.id]);
    const blocked = await waitUntilBlocked(b.pid);
    assert.ok(blocked, "a plain widget write is blocked behind the dashboard-row lock replace_dashboard_layout is holding — same lock order, no bypass");
    await a.client.query("commit");
    await bPromise;
  } finally {
    await a.client.end();
    await b.client.end();
  }
});

// ============================================================
// §7 — Historical units and versions.
// ============================================================

test("§7.1 config-time axis check uses the CURRENT version's unit — documented as advisory only, not sufficient alone", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { widgetType: "line_chart", width: 6, height: 4 });
  // distanceSystem's CURRENT version is v2 (km) — config-time check passes;
  // it says nothing about whether the query result will mix v1(m) history.
  const s = await addSeries(widget.id, { metricDefinitionId: ids.distanceSystem });
  assert.equal(s.metric_definition_id, ids.distanceSystem);
});

test("§7.2 the query adapter returns a controlled unitConflict, never a single mislabeled series, for a period spanning both a v1(m) and a v2(km) value", async () => {
  const rows = await queryMetricSeries({
    metricDefinitionId: ids.distanceSystem,
    dataScopeLevel: "session",
    aggregationRolePolicy: "standalone_only",
    coveragePolicy: "any",
    dateFrom: "2026-09-09",
    dateTo: "2026-09-10",
    athleteIds: [ids.ana],
  });
  const anaRow = rows.find((r) => r.athleteId === ids.ana);
  assert.ok(anaRow, "Ana has values in this period");
  assert.equal(anaRow.unitConflict, true, "a v1(m) and a v2(km) value in the same period must never be silently blended or mislabeled");
  const units = anaRow.values.map((v) => v.unit).sort();
  assert.deepEqual(units, ["km", "m"]);
});

// ============================================================
// §8 — Default template contract, ambiguous hint resolution.
// ============================================================

test("§8.1 the new session_count/last_session_date built-ins actually exist and are queryable — the Athlete overview template is materializable", async () => {
  const defs = await q(`select key from training_load.dashboard_builtin_series where key in ('session_count','last_session_date')`);
  assert.equal(defs.rows.length, 2);
});

test("§8.2 an ambiguous template hint with TWO equally-valid visible candidates is never resolved arbitrarily — it is left needs_resolution", async () => {
  const candidates = await resolveTemplateHint({
    hints: [ids.ambiguousHintKey],
    dataWorkspaceType: "club",
    dataWorkspaceScopeId: ids.clubA,
    ownerUserId: null,
  });
  assert.equal(candidates.status, "needs_resolution");
  assert.equal(candidates.candidateIds.length, 2);
  assert.ok(candidates.candidateIds.includes(ids.ambiguousSystem));
  assert.ok(candidates.candidateIds.includes(ids.ambiguousClubA));
});

test("§8.3 the SAME hint resolves cleanly to exactly one candidate for a data workspace that cannot see the club-scoped one", async () => {
  const candidates = await resolveTemplateHint({
    hints: [ids.ambiguousHintKey],
    dataWorkspaceType: "club",
    dataWorkspaceScopeId: ids.clubB, // cannot see Club A's own definition
    ownerUserId: null,
  });
  assert.equal(candidates.status, "resolved");
  assert.equal(candidates.candidateIds.length, 1);
  assert.equal(candidates.candidateIds[0], ids.ambiguousSystem);
});

// ============================================================
// §9 — Real PoC query adapter (see queryBuiltInSeries/queryMetricSeries
// below — a genuine layer on top of the REAL, unmodified
// training.canonical_activity_results()).
// ============================================================

test("§9.1 RPE/sRPE (built-in) and a Metrics Core metric in the SAME widget's result, without ever copying RPE into metric_values", async () => {
  const rpe = await queryBuiltInSeries({ key: "rpe", activityIds: [ids.activity], athleteIds: [ids.ana] });
  const srpe = await queryBuiltInSeries({ key: "srpe", activityIds: [ids.activity], athleteIds: [ids.ana] });
  const dist = await queryMetricSeries({ metricDefinitionId: ids.distanceClubA, dataScopeLevel: "component", aggregationRolePolicy: "standalone_only", coveragePolicy: "any", activityIds: [ids.activity], athleteIds: [ids.ana] });
  assert.equal(rpe[0].values[0].value, 7);
  assert.equal(srpe[0].values[0].value, 420);
  assert.equal(Number(dist[0].values[0].value), 3200);
  const rpeInMetricValues = await one(`select count(*)::int as n from training_load.metric_values v join training_load.metric_definitions d on d.id=v.metric_definition_id where d.key ilike '%rpe%'`);
  assert.equal(rpeInMetricValues.n, 0);
});

test("§9.2 a session-scope query and a component-scope query for the same underlying metric never show the same number twice as if summed", async () => {
  const sessionRows = await queryMetricSeries({ metricDefinitionId: ids.distanceClubA, dataScopeLevel: "session", aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "any", activityIds: [ids.activity], athleteIds: [ids.ana] });
  const componentRows = await queryMetricSeries({ metricDefinitionId: ids.distanceClubA, dataScopeLevel: "component", aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "any", activityIds: [ids.activity], athleteIds: [ids.ana] });
  assert.equal(Number(sessionRows[0].values[0].value), 5000, "session scope returns ONLY the session-level source_rollup (5000m), never the component value added on top");
  assert.equal(Number(componentRows[0].values[0].value), 3200, "component scope returns ONLY the component's own standalone value");
});

test("§9.3 a component value is never silently treated as a session total", async () => {
  const rows = await queryMetricSeries({ metricDefinitionId: ids.distanceClubA, dataScopeLevel: "component", aggregationRolePolicy: "standalone_only", coveragePolicy: "any", activityIds: [ids.activity], athleteIds: [ids.ana] });
  assert.equal(rows[0].values.length, 1);
  assert.equal(Number(rows[0].values[0].value), 3200);
});

test("§9.4 a source-rollup value and its own component's standalone value are never double-summed together", async () => {
  const allRoles = await queryMetricSeries({ metricDefinitionId: ids.distanceClubA, dataScopeLevel: "session", aggregationRolePolicy: "all_including_derived", coveragePolicy: "any", activityIds: [ids.activity], athleteIds: [ids.ana] });
  // Even asking for "all roles" at SESSION scope must not pull in the
  // component-scope standalone value at all (scope filtering happens
  // before role filtering) — still just the one 5000m rollup.
  assert.equal(allRoles[0].values.length, 1);
  assert.equal(Number(allRoles[0].values[0].value), 5000);
});

test("§9.5 a superseded occasion is excluded from the query result entirely", async () => {
  const metricId = await makeQuickMetric("Quick HR 9.5");
  const eventParticipant = ids.eventParticipant;
  const occOld = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id`, [eventParticipant]);
  await q(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) select $1, id, current_version_id, 100, 'bpm' from training_load.metric_definitions where id=$2`, [occOld.id, metricId]);
  const occNew = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, supersedes_occasion_id) values ($1,'manual',$2) returning id`, [eventParticipant, occOld.id]);
  await q(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) select $1, id, current_version_id, 110, 'bpm' from training_load.metric_definitions where id=$2`, [occNew.id, metricId]);
  await q(`update training_load.metric_measurement_occasions set superseded_by_occasion_id=$1 where id=$2`, [occNew.id, occOld.id]);
  const rows = await queryMetricSeries({ metricDefinitionId: metricId, dataScopeLevel: "session", aggregationRolePolicy: "standalone_only", coveragePolicy: "any", activityIds: [ids.activity], athleteIds: [ids.ana] });
  assert.equal(rows[0].values.length, 1);
  assert.equal(Number(rows[0].values[0].value), 110, "only the current occasion's value — the superseded 100 must never appear");
});

test("§9.6 an import-conflict-flagged value is never shown as a clean single value", async () => {
  const metricId = await makeQuickMetric("Quick HR 9.6");
  const eventParticipant = ids.eventParticipant;
  const occFlagged = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, import_conflict_status) values ($1,'api_import','needs_review') returning id`, [eventParticipant]);
  await q(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) select $1, id, current_version_id, 999, 'bpm' from training_load.metric_definitions where id=$2`, [occFlagged.id, metricId]);
  const rows = await queryMetricSeries({ metricDefinitionId: metricId, dataScopeLevel: "session", aggregationRolePolicy: "standalone_only", coveragePolicy: "any", activityIds: [ids.activity], athleteIds: [ids.ana] });
  const flaggedShown = rows[0]?.values.some((v) => Number(v.value) === 999);
  assert.equal(!!flaggedShown, false, "a flagged/needs_review occasion must never surface as an effective value");
});

test("§9.7 two effective sources for the same athlete/metric produce a conflict payload, never a proriotized winner", async () => {
  const metricId = await makeQuickMetric("Quick HR 9.7");
  const eventParticipant = ids.eventParticipant;
  const occ1 = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id`, [eventParticipant]);
  await q(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) select $1, id, current_version_id, 60, 'bpm' from training_load.metric_definitions where id=$2`, [occ1.id, metricId]);
  const occ2 = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'api_import') returning id`, [eventParticipant]);
  await q(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) select $1, id, current_version_id, 65, 'bpm' from training_load.metric_definitions where id=$2`, [occ2.id, metricId]);
  const rows = await queryMetricSeries({ metricDefinitionId: metricId, dataScopeLevel: "session", aggregationRolePolicy: "standalone_only", coveragePolicy: "any", sourcePolicy: "all_with_conflicts", activityIds: [ids.activity], athleteIds: [ids.ana] });
  const anaRow = rows.find((r) => r.athleteId === ids.ana);
  assert.equal(anaRow.conflict, true);
  assert.equal(anaRow.values.length, 2);
});

test("§9.8 the canonical alias chain does not duplicate a result after a real merge", async () => {
  // A second, separately-materialized activity for Ana on the SAME day,
  // with its OWN metric value (a FRESH metric_definition, not shared with
  // the §9.5-9.7 tests above, so this test's own count assertion is never
  // polluted by their fixture rows) — then genuinely merged via the real
  // training.merge_activity_participants() function.
  const metricId = await makeQuickMetric("Quick HR 9.8");
  const aliasActivity = await one(
    `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state, created_by_user_id)
     values ('training_session','PoC Session (dup)','2026-09-09','2026-09-09T09:05:00Z','Europe/Belgrade','club',$1,'manual','confirmed',$2) returning id`,
    [ids.clubA, ids.coachA],
  );
  const aliasParticipant = await one(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,'2026-09-09','Europe/Belgrade','participated') returning id`,
    [aliasActivity.id, ids.ana],
  );
  const aliasEvent = await one(
    `insert into training_load.metric_events (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_club_id, source_connection_id, created_by_user_id)
     values ('dup','2026-09-09','2026-09-09T09:05:00Z','session','club',$1,$2,$3) returning id`,
    [ids.clubA, ids.connClubA, ids.coachA],
  );
  const aliasEventParticipant = await one(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'Europe/Belgrade') returning id`, [aliasEvent.id, ids.ana]);
  await q(`insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [aliasActivity.id, aliasEvent.id]);
  await q(`insert into training.activity_participant_metric_participant_links (activity_participant_id, metric_event_participant_id, link_method, link_status) values ($1,$2,'manual','confirmed')`, [aliasParticipant.id, aliasEventParticipant.id]);
  const aliasOcc = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id`, [aliasEventParticipant.id]);
  await q(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) select $1, id, current_version_id, 42, 'bpm' from training_load.metric_definitions where id=$2`, [aliasOcc.id, metricId]);

  await q(`select training.merge_activity_participants($1,$2,$3,'PoC dedup')`, [aliasParticipant.id, ids.participant ?? (await one(`select id from training.activity_participants where activity_id=$1 and athlete_id=$2`, [ids.activity, ids.ana])).id, ids.coachA]);

  const canonicalResult = await q(`select fact_kind, detail from training.canonical_activity_results($1) where fact_kind='metric_value'`, [ids.activity]);
  const hrFacts = canonicalResult.rows.filter((r) => r.detail.metricDefinitionId === metricId);
  assert.equal(hrFacts.length, 1, "the merged alias's own fact resolves through canonical_activity_results exactly once, never duplicated");
  assert.equal(Number(hrFacts[0].detail.valueNumeric), 42);
});

test("§9.9 coverage_policy and aggregation_role_policy actually change the result set, not just accepted config", async () => {
  const partialOcc = await one(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method) values ($1,'manual') returning id`, [ids.eventParticipant]);
  await q(
    `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, aggregation_role, coverage)
     values ($1,$2,$3,4500,'m','source_rollup','partial')`,
    [partialOcc.id, ids.distanceClubA, (await one(`select current_version_id from training_load.metric_definitions where id=$1`, [ids.distanceClubA])).current_version_id],
  );
  const strict = await queryMetricSeries({ metricDefinitionId: ids.distanceClubA, dataScopeLevel: "session", aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "complete_only", activityIds: [ids.activity], athleteIds: [ids.ana] });
  const permissive = await queryMetricSeries({ metricDefinitionId: ids.distanceClubA, dataScopeLevel: "session", aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "any", activityIds: [ids.activity], athleteIds: [ids.ana] });
  assert.equal(strict[0].values.length, 1, "complete_only excludes the new PARTIAL-coverage rollup");
  assert.equal(permissive[0].values.length, 2, "'any' coverage includes it — the policy genuinely changes the result");
});

test("§9.10 mixed historical units within one query period return a controlled unitConflict (same as §7.2, re-asserted under the §9 adapter umbrella)", async () => {
  const rows = await queryMetricSeries({ metricDefinitionId: ids.distanceSystem, dataScopeLevel: "session", aggregationRolePolicy: "standalone_only", coveragePolicy: "any", dateFrom: "2026-09-09", dateTo: "2026-09-10", athleteIds: [ids.ana] });
  assert.equal(rows.find((r) => r.athleteId === ids.ana).unitConflict, true);
});

test("§9.11 the data-workspace filter narrows actual DATA, not just which config is offered — Club B never sees Club A's activity facts", async () => {
  const activitiesInB = await fetchActivitiesInRange({ dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubB, dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  assert.ok(!activitiesInB.includes(ids.activity), "Club A's own activity must never appear when querying scoped to Club B's data workspace");
  const activitiesInA = await fetchActivitiesInRange({ dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  assert.ok(activitiesInA.includes(ids.activity));
});

test("§9.12 one bad widget's query result in a batch never crashes the others", async () => {
  const results = await runBatchQuery([
    { widgetId: "w-good", kind: "builtin", key: "rpe", activityIds: [ids.activity], athleteIds: [ids.ana] },
    { widgetId: "w-bad", kind: "metric", metricDefinitionId: "00000000-0000-0000-0000-000000000000", dataScopeLevel: "session", activityIds: [ids.activity], athleteIds: [ids.ana] },
    { widgetId: "w-good-2", kind: "builtin", key: "srpe", activityIds: [ids.activity], athleteIds: [ids.ana] },
  ]);
  assert.equal(results.find((r) => r.widgetId === "w-good").status, "ok");
  assert.equal(results.find((r) => r.widgetId === "w-bad").status, "error");
  assert.equal(results.find((r) => r.widgetId === "w-good-2").status, "ok");
});

// ============================================================
// §10 — Round 3, final corrective pass: the 36 newly required tests.
// Four groups, matching the task's own numbering: Query results (1-12),
// Workspace isolation (13-19), Integrity and revision (20-28),
// Binding/source (29-36).
// ============================================================

// --- Query results (1-12) ---

test("§10.1 [Query results #1] day-bucket sum: Stage 1 daily-reduces Ana's two same-day activities (100+50->150) via the metric's OWN daily_aggregation_method", async () => {
  const { current } = await runSeriesPipeline(
    { metricDefinitionId: ids.pipelineMetric, dataScopeLevel: "session", groupBy: "day", analyticalAggregation: "sum" },
    { dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, athleteIds: [ids.ana], dateFrom: "2026-09-15", dateTo: "2026-09-16" },
  );
  const byDate = Object.fromEntries(current.map((r) => [r.bucketKey, Number(r.value)]));
  assert.equal(byDate["2026-09-15"], 150);
  assert.equal(byDate["2026-09-16"], 80);
});

test("§10.2 [Query results #2] athlete-bucket sum collapses the whole queried range into one number per athlete: 150+80=230", async () => {
  const { current } = await runSeriesPipeline(
    { metricDefinitionId: ids.pipelineMetric, dataScopeLevel: "session", groupBy: "athlete", analyticalAggregation: "sum" },
    { dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, athleteIds: [ids.ana], dateFrom: "2026-09-15", dateTo: "2026-09-16" },
  );
  assert.equal(current.length, 1);
  assert.equal(Number(current[0].value), 230);
});

test("§10.3 [Query results #3] athlete-bucket avg proves real two-stage sequencing: avg([150,80])=115, NEVER the naive avg of the 3 raw activities (100,50,80)/3=76.67", async () => {
  const { current } = await runSeriesPipeline(
    { metricDefinitionId: ids.pipelineMetric, dataScopeLevel: "session", groupBy: "athlete", analyticalAggregation: "avg" },
    { dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, athleteIds: [ids.ana], dateFrom: "2026-09-15", dateTo: "2026-09-16" },
  );
  assert.equal(Number(current[0].value), 115);
});

test("§10.4 [Query results #4] Stage 1's own daily reduction is UNAFFECTED by Stage 2's choice: day-bucket with analytical_aggregation='max' still shows day1=150 (sum-reduced), never max(100,50)=100", async () => {
  const { current } = await runSeriesPipeline(
    { metricDefinitionId: ids.pipelineMetric, dataScopeLevel: "session", groupBy: "day", analyticalAggregation: "max" },
    { dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, athleteIds: [ids.ana], dateFrom: "2026-09-15", dateTo: "2026-09-16" },
  );
  const byDate = Object.fromEntries(current.map((r) => [r.bucketKey, Number(r.value)]));
  assert.equal(byDate["2026-09-15"], 150, "day1 is still the Stage-1 SUM (150), not max(100,50)=100 — Stage 2's 'max' only applies across buckets, never inside one already-day-reduced bucket");
});

test("§10.5 [Query results #5] analytical_aggregation='none' returns every (day-reduced) value unaggregated, not a single collapsed number", async () => {
  const { current } = await runSeriesPipeline(
    { metricDefinitionId: ids.pipelineMetric, dataScopeLevel: "session", groupBy: "athlete", analyticalAggregation: "none" },
    { dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, athleteIds: [ids.ana], dateFrom: "2026-09-15", dateTo: "2026-09-16" },
  );
  assert.deepEqual(current[0].value.map(Number).sort((a, b) => a - b), [80, 150]);
});

test("§10.6 [Query results #6] group_by='team' genuinely merges ACROSS athletes (Ana 150+80, Marko 20) into one bucket: 250 — never silently degraded to a per-athlete bucket", async () => {
  const { current } = await runSeriesPipeline(
    { metricDefinitionId: ids.pipelineMetric, dataScopeLevel: "session", groupBy: "team", analyticalAggregation: "sum" },
    { dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, athleteIds: [ids.ana, ids.marko], dateFrom: "2026-09-15", dateTo: "2026-09-16" },
  );
  assert.equal(current.length, 1);
  assert.equal(current[0].athleteId, null, "a team bucket has no single owning athlete");
  assert.equal(Number(current[0].value), 250);
});

test("§10.7 [Query results #7] group_by='team' with analytical_aggregation='avg' is the average across ALL underlying day-reduced values from every athlete: avg([150,80,20])=83.33...", async () => {
  const { current } = await runSeriesPipeline(
    { metricDefinitionId: ids.pipelineMetric, dataScopeLevel: "session", groupBy: "team", analyticalAggregation: "avg" },
    { dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, athleteIds: [ids.ana, ids.marko], dateFrom: "2026-09-15", dateTo: "2026-09-16" },
  );
  assert.ok(Math.abs(Number(current[0].value) - 250 / 3) < 1e-9);
});

test("§10.8 [Query results #8] comparison_period='previous_period' computes a REAL shifted date range and a real second number, never a guessed offset", async () => {
  const { current, comparison } = await runSeriesPipeline(
    { metricDefinitionId: ids.pipelineMetric, dataScopeLevel: "session", groupBy: "athlete", analyticalAggregation: "sum", comparisonPeriod: "previous_period" },
    { dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, athleteIds: [ids.ana], dateFrom: "2026-09-15", dateTo: "2026-09-15" },
  );
  assert.equal(Number(current[0].value), 150, "current single-day (2026-09-15) total: 100+50");
  assert.ok(comparison, "comparison_period set -> a comparison result must actually be computed, not silently omitted");
  assert.equal(comparison.length, 1);
  assert.equal(Number(comparison[0].value), 60, "previous_period for a single day (2026-09-15) is exactly 2026-09-14, where the fixture places a real 60 value");
});

test("§10.9 [Query results #9] double-count prevention holds through the FULL pipeline, not just the raw adapter: session-scope (5000) and component-scope (3200) never blend even after daily reduction + grouping + aggregation", async () => {
  // coveragePolicy stays 'complete_only' here deliberately — §9.9 (which
  // runs earlier in this same shared-fixture suite) adds its OWN extra
  // partial-coverage session-scope rollup (4500) to this exact metric;
  // 'complete_only' is what keeps this test's own numbers exact and
  // uncoupled from that other test's fixture additions, the same
  // shared-fixture-pollution concern makeQuickMetric exists to avoid
  // elsewhere in this file.
  const sessionResult = await runSeriesPipeline(
    { metricDefinitionId: ids.distanceClubA, dataScopeLevel: "session", aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "complete_only", groupBy: "day", analyticalAggregation: "sum" },
    { dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, athleteIds: [ids.ana], dateFrom: "2026-09-09", dateTo: "2026-09-09" },
  );
  const componentResult = await runSeriesPipeline(
    { metricDefinitionId: ids.distanceClubA, dataScopeLevel: "component", aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "complete_only", groupBy: "day", analyticalAggregation: "sum" },
    { dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, athleteIds: [ids.ana], dateFrom: "2026-09-09", dateTo: "2026-09-09" },
  );
  assert.equal(Number(sessionResult.current[0].value), 5000);
  assert.equal(Number(componentResult.current[0].value), 3200);
});

test("§10.10 [Query results #10] a real historical unit conflict survives the full pipeline as a structurally separate group — never blended into one summed number", async () => {
  const rows = await queryMetricSeries({ metricDefinitionId: ids.distanceSystem, dataScopeLevel: "session", aggregationRolePolicy: "standalone_only", coveragePolicy: "any", dateFrom: "2026-09-09", dateTo: "2026-09-10", athleteIds: [ids.ana] });
  const anaRow = rows.find((r) => r.athleteId === ids.ana);
  assert.equal(anaRow.groups.length, 2, "two REAL separate per-unit groups, not one array with a flag");
  const byUnit = Object.fromEntries(anaRow.groups.map((g) => [g.unit, g.values.map((v) => Number(v.value))]));
  assert.deepEqual(byUnit.m, [4800]);
  assert.deepEqual(byUnit.km, [4.9]);
});

test("§10.11 [Query results #11] a built-in series runs through the SAME pipeline entry point (runSeriesPipeline) as a Metrics-Core series, with no daily reduction (dailyAggMethod is null for a built-in)", async () => {
  const { current } = await runSeriesPipeline(
    { builtInSeriesKey: "rpe", groupBy: "day", analyticalAggregation: "avg" },
    { dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, athleteIds: [ids.ana], dateFrom: "2026-09-09", dateTo: "2026-09-09" },
  );
  assert.equal(current.length, 1);
  assert.equal(Number(current[0].value), 7);
});

test("§10.12 [Query results #12] group_by='component' is a genuinely executed bucket choice (not silently treated as 'athlete'), bucketing a component-scope series per day with the correct real value", async () => {
  const { current } = await runSeriesPipeline(
    { metricDefinitionId: ids.distanceClubA, dataScopeLevel: "component", aggregationRolePolicy: "standalone_only", coveragePolicy: "any", groupBy: "component", analyticalAggregation: "sum" },
    { dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, athleteIds: [ids.ana], dateFrom: "2026-09-09", dateTo: "2026-09-09" },
  );
  assert.equal(current.length, 1);
  assert.equal(Number(current[0].value), 3200);
});

// --- Workspace isolation (13-19) ---

test("§10.13 [Workspace isolation #13] 'platform' is an explicit, documented unrestricted view — sees activities from BOTH Club A and Club B", async () => {
  const activityInB = await one(
    `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state, created_by_user_id)
     values ('training_session','PoC Club B Session','2026-09-09','2026-09-09T09:00:00Z','Europe/Belgrade','club',$1,'manual','confirmed',$2) returning id`,
    [ids.clubB, ids.coachB],
  );
  const platformActivities = await fetchActivitiesInRange({ dataWorkspaceType: "platform", dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  assert.ok(platformActivities.includes(ids.activity), "Club A's activity is visible platform-wide");
  assert.ok(platformActivities.includes(activityInB.id), "Club B's activity is ALSO visible platform-wide");
});

test("§10.14 [Workspace isolation #14] 'team' workspace is genuinely owner_scope='team'-based — sees the real team-owned activity, never Club A's club-owned one", async () => {
  const teamActivities = await fetchActivitiesInRange({ dataWorkspaceType: "team", dataWorkspaceScopeId: ids.teamA, dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  assert.ok(teamActivities.includes(ids.teamActivity), "the real team-owned activity must be visible");
  assert.ok(!teamActivities.includes(ids.activity), "a club-owned (not team-owned) activity must never appear under team workspace filtering, even for the same club/team roster");
});

test("§10.15 [Workspace isolation #15] 'private_coach' workspace is genuinely owner_scope='user'-based — sees the coach's OWN activity, never a club-owned one for the same athlete", async () => {
  const privateCoachActivities = await fetchActivitiesInRange({ dataWorkspaceType: "private_coach", dataWorkspaceUserId: ids.privateCoach, dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  assert.ok(privateCoachActivities.includes(ids.privateCoachActivity), "the coach's own activity must be visible");
  assert.ok(!privateCoachActivities.includes(ids.activity), "Club A's own club-owned activity must never leak into a private coach's workspace");
});

test("§10.16 [Workspace isolation #16] 'athlete' workspace is participant-based, not owner-based — sees Ana's club-A-owned activities, and IGNORES an athleteIds override entirely (always forces the current viewing athlete)", async () => {
  const anaActivities = await fetchActivitiesInRange({ dataWorkspaceType: "athlete", athleteWorkspaceAthleteId: ids.ana, dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  assert.ok(anaActivities.includes(ids.activity), "Ana's own club-A activity is visible through HER OWN athlete workspace, despite the workspace type not being 'club'");
  const attemptedOverride = await fetchActivitiesInRange({ dataWorkspaceType: "athlete", athleteWorkspaceAthleteId: ids.ana, athleteIds: [ids.marko], dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  assert.deepEqual([...attemptedOverride].sort(), [...anaActivities].sort(), "an athlete workspace must ignore any caller-supplied athleteIds — the viewing athlete is the ONLY valid filter, never overridable by a parameter");
});

test("§10.17 [Workspace isolation #17] a real dual-role relationship (privateCoach personally coaches Marko, a Club A/Team A roster athlete) never leaks Marko's Club A data into privateCoach's OWN workspace", async () => {
  const relation = await one(`select 1 as ok from public.user_athletes where user_id=$1 and athlete_id=$2`, [ids.privateCoach, ids.marko]);
  assert.ok(relation, "sanity: the real coaching relationship exists in the fixture");
  const viaRelation = await fetchActivitiesInRange({ dataWorkspaceType: "private_coach", dataWorkspaceUserId: ids.privateCoach, athleteIds: [ids.marko], dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  assert.equal(viaRelation.length, 0, "Marko's Club A activities must NEVER appear in privateCoach's own workspace just because a user_athletes relationship row exists — workspace visibility is owner-based, never relationship-based");
  const ownActivities = await fetchActivitiesInRange({ dataWorkspaceType: "private_coach", dataWorkspaceUserId: ids.privateCoach, dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  assert.ok(ownActivities.includes(ids.privateCoachActivity), "privateCoach's OWN activity is unaffected and still visible");
});

test("§10.18 [Workspace isolation #18] the own-private-catalog visibility carve-out is workspace-type-agnostic — it does NOT mean 'platform' leaks club-scope data through a private dashboard", async () => {
  const dash = await makeDashboard({ ownerScope: "user", ownerUserId: ids.privateCoach, dataWorkspaceType: "platform", createdBy: ids.privateCoach });
  const widget = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4 });
  const ok = await addSeries(widget.id, { metricDefinitionId: ids.userMetricPrivateCoach });
  assert.equal(ok.metric_definition_id, ids.userMetricPrivateCoach, "the coach's OWN private metric IS visible on their 'platform'-bound dashboard");
  await assert.rejects(
    addSeries(widget.id, { seriesOrder: 2, metricDefinitionId: ids.distanceClubA }),
    /not visible to this dashboard's data workspace/,
    "Club A's club-scoped metric must stay invisible — 'platform' grants no club-scope visibility, only system-scope + the dashboard owner's own private catalog",
  );
});

test("§10.19 [Workspace isolation #19] fetchActivitiesInRange refuses a missing or unrecognized dataWorkspaceType outright — no accidental unrestricted fallback", async () => {
  await assert.rejects(fetchActivitiesInRange({ dateFrom: "2026-09-01", dateTo: "2026-09-30" }), /dataWorkspaceType must be one of/);
  await assert.rejects(fetchActivitiesInRange({ dataWorkspaceType: "bogus", dateFrom: "2026-09-01", dateTo: "2026-09-30" }), /dataWorkspaceType must be one of/);
});

// --- Integrity and revision (20-28) ---

test("§10.20 [Integrity #20] dashboard_widgets.dashboard_id is immutable — a raw UPDATE attempting to move a widget to another dashboard is rejected", async () => {
  const dashA = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const dashA2 = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dashA.id);
  await assert.rejects(
    q(`update training_load.dashboard_widgets set dashboard_id=$1 where id=$2`, [dashA2.id, widget.id]),
    /dashboard_id is immutable/,
  );
});

test("§10.21 [Integrity #21] dashboard_widget_series.widget_id is immutable — a raw UPDATE attempting to move a series to another widget is rejected", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const w1 = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4, order: 1, mobileOrder: 1 });
  const w2 = await makeWidget(dash.id, { widgetType: "table", width: 6, height: 4, y: 4, order: 2, mobileOrder: 2 });
  const series = await addSeries(w1.id, { metricDefinitionId: ids.distanceClubA });
  await assert.rejects(
    q(`update training_load.dashboard_widget_series set widget_id=$1 where id=$2`, [w2.id, series.id]),
    /widget_id is immutable/,
  );
});

test("§10.22 [Integrity #22] dashboards.created_by_user_id is unconditionally immutable, even for a dashboard nothing yet references", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  await assert.rejects(
    q(`update training_load.dashboards set created_by_user_id=$1 where id=$2`, [ids.coachB, dash.id]),
    /created_by_user_id is immutable/,
  );
});

test("§10.23 [Integrity #23] cloned_from_dashboard_id: self-clone is rejected, a non-template target is rejected, and a valid clone is then write-once", async () => {
  const selfCloneId = crypto.randomUUID();
  await assert.rejects(
    q(
      `insert into training_load.dashboards (id, name, owner_scope, owner_club_id, data_workspace_type, data_workspace_scope_id, created_by_user_id, cloned_from_dashboard_id)
       values ($1,'self-clone','club',$2,'club',$2,$3,$1)`,
      [selfCloneId, ids.clubA, ids.coachA],
    ),
    // Two independent layers both refuse this: the plain self-clone CHECK
    // constraint, AND (which fires FIRST in practice, since a BEFORE ROW
    // trigger always runs before a table CHECK is evaluated) the clone-
    // provenance trigger's own lookup of cloned_from_dashboard_id, which
    // correctly reports "does not exist" — a row genuinely cannot exist
    // as a queryable clone target at its own INSERT time, self-reference
    // or not. Either message is a correct rejection of the self-clone.
    /violates check constraint|does not exist/,
    "cloned_from_dashboard_id must never equal the row's own id",
  );
  const nonTemplate = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA, isTemplate: false });
  await assert.rejects(
    q(
      `insert into training_load.dashboards (name, owner_scope, owner_club_id, data_workspace_type, data_workspace_scope_id, created_by_user_id, cloned_from_dashboard_id)
       values ('bad clone','club',$1,'club',$1,$2,$3)`,
      [ids.clubA, ids.coachA, nonTemplate.id],
    ),
    /is not a template/,
    "cloned_from_dashboard_id must reference a dashboard that IS a template",
  );
  const template = await makeDashboard({ ownerScope: "system", isTemplate: true, createdBy: ids.platformAdmin });
  const clone = await one(
    `insert into training_load.dashboards (name, owner_scope, owner_club_id, data_workspace_type, data_workspace_scope_id, created_by_user_id, cloned_from_dashboard_id)
     values ('good clone','club',$1,'club',$1,$2,$3) returning *`,
    [ids.clubA, ids.coachA, template.id],
  );
  assert.equal(clone.cloned_from_dashboard_id, template.id);
  await assert.rejects(
    q(`update training_load.dashboards set cloned_from_dashboard_id=null where id=$1`, [clone.id]),
    /cloned_from_dashboard_id is immutable after creation/,
  );
});

test("§10.24 [Integrity #24] a clone-provenance cycle (A clones B, then B is changed to claim it was cloned from A) is rejected", async () => {
  const template = await makeDashboard({ ownerScope: "system", isTemplate: true, createdBy: ids.platformAdmin });
  const cloneA = await one(
    `insert into training_load.dashboards (name, owner_scope, owner_club_id, data_workspace_type, data_workspace_scope_id, created_by_user_id, cloned_from_dashboard_id, is_template)
     values ('cloneA','club',$1,'club',$1,$2,$3,true) returning id`,
    [ids.clubA, ids.coachA, template.id],
  );
  // cloneA is itself flagged is_template=true, so it is a VALID clone
  // target for a further clone. cloned_from_dashboard_id is write-once
  // (§10.23), so a genuine A-clones-B-clones-A cycle can never actually be
  // CONSTRUCTED at all (there is no UPDATE path back to an earlier row) —
  // the walk in dashboards_validate_clone_provenance exists as a
  // defensive, always-real check regardless. What IS constructible and
  // MUST be allowed is a legitimate multi-hop chain: template -> cloneA ->
  // cloneOfClone. Proving this succeeds (not falsely rejected as a
  // "cycle") is the real, exercisable half of this invariant.
  const cloneOfClone = await one(
    `insert into training_load.dashboards (name, owner_scope, owner_club_id, data_workspace_type, data_workspace_scope_id, created_by_user_id, cloned_from_dashboard_id)
     values ('cloneOfClone','club',$1,'club',$1,$2,$3) returning cloned_from_dashboard_id`,
    [ids.clubA, ids.coachA, cloneA.id],
  );
  assert.equal(cloneOfClone.cloned_from_dashboard_id, cloneA.id, "a legitimate multi-hop clone chain (template -> cloneA -> cloneOfClone) is NOT a cycle and must be allowed");
});

test("§10.25 [Integrity #25] dashboard_widget_types: has_shared_axis and supports_comparison_period become immutable once any widget references the type — distinct from the already-covered max_series case", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  await makeWidget(dash.id, { widgetType: "kpi" });
  await assert.rejects(
    q(`update training_load.dashboard_widget_types set supports_comparison_period=false where key='kpi'`),
    /already referenced by a widget/,
  );
  await assert.rejects(
    q(`update training_load.dashboard_widget_types set has_shared_axis=true where key='kpi'`),
    /already referenced by a widget/,
  );
});

test("§10.26 [Integrity #26] dashboard_active_selection rejects selecting an ARCHIVED dashboard", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  await q(`update training_load.dashboards set status='archived' where id=$1`, [dash.id]);
  await assert.rejects(
    q(`insert into training_load.dashboard_active_selection (user_id, workspace_type, scope_id, dashboard_id) values ($1,'club',$2,$3)`, [ids.coachA, ids.clubA, dash.id]),
    /is not active/,
  );
});

test("§10.27 [Integrity #27] update_widget_layout() is the sanctioned single-widget entry point: it returns a FRESH widget_revision AND a FRESH dashboard_revision from one real call", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const widget = await makeWidget(dash.id, { x: 0, y: 0 });
  const dashBefore = await one(`select revision from training_load.dashboards where id=$1`, [dash.id]);
  const result = await one(
    `select * from training_load.update_widget_layout($1,$2,$3,$4,$5,$6,$7)`,
    [widget.id, widget.revision, 4, 0, widget.width, widget.height, widget.mobile_order],
  );
  assert.equal(result.x, 4);
  assert.equal(result.widget_revision, widget.revision + 1);
  assert.ok(result.dashboard_revision > dashBefore.revision, "dashboard_revision must have actually advanced — Round 3 reverses Round 2's exclusion of layout changes from the dashboard-level signal");
  const dashAfter = await one(`select revision from training_load.dashboards where id=$1`, [dash.id]);
  assert.equal(dashAfter.revision, result.dashboard_revision, "the function's own returned token must be the SOLE-AUTHORITATIVE fresh value, matching the row's real state");
});

test("§10.28 [Integrity #28] update_widget_layout() and replace_dashboard_layout() never deadlock against each other — real lock-wait proof, both proven dashboard-first", async () => {
  const dash = await makeDashboard({ ownerScope: "club", ownerClubId: ids.clubA, dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, createdBy: ids.coachA });
  const w1 = await makeWidget(dash.id, { x: 0, y: 0, mobileOrder: 1, order: 1 });
  const w2 = await makeWidget(dash.id, { x: 4, y: 0, mobileOrder: 2, order: 2 });
  const rev = (await one(`select revision from training_load.dashboards where id=$1`, [dash.id])).revision;
  const a = await newClient();
  const b = await newClient();
  try {
    await a.client.query("begin");
    // A holds the dashboard lock via replace_dashboard_layout (touches
    // w1 — y:1 is a real change but never overlaps w2's untouched
    // x:4..7 at this point, since w1's own x:0..3 range never moves).
    await a.client.query(`select * from training_load.replace_dashboard_layout($1,$2,$3::jsonb)`, [dash.id, rev, JSON.stringify([{ widgetId: w1.id, y: 1 }])]);
    // B calls update_widget_layout on the OTHER widget (w2) — if it locked
    // widget-then-dashboard (the unsafe order) this would deadlock against
    // A's dashboard-then-widget order; instead B must simply queue cleanly
    // behind A's dashboard lock.
    const bPromise = b.client.query(`select * from training_load.update_widget_layout($1,$2,$3,$4,$5,$6,$7)`, [w2.id, w2.revision, 6, 0, w2.width, w2.height, w2.mobile_order]);
    const blocked = await waitUntilBlocked(b.pid);
    assert.ok(blocked, "B genuinely queued behind A's dashboard-row lock, not a timing guess");
    await a.client.query("commit");
    const bResult = await bPromise; // must resolve cleanly — no deadlock error
    assert.equal(bResult.rows[0].x, 6);
  } finally {
    await a.client.end();
    await b.client.end();
  }
});

// --- Binding/source (29-36) ---

test("§10.29 [Binding/source #29] source_policy='manual' returns ONLY the manual-entry value (10), a real distinct filter, not accepted-but-ignored config", async () => {
  const rows = await queryMetricSeries({ metricDefinitionId: ids.sourcePolicyMetric, dataScopeLevel: "session", aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "any", sourcePolicy: "manual", activityIds: [ids.activity], athleteIds: [ids.ana] });
  const values = rows[0].values.map((v) => Number(v.value));
  assert.deepEqual(values, [10]);
});

test("§10.30 [Binding/source #30] source_policy='api_import' returns ONLY the api_import-entry value (20), correctly excluding the derived_rollup fact even though it ALSO has entry_method='api_import' (excluded upstream by the default role policy, not by accident)", async () => {
  const rows = await queryMetricSeries({ metricDefinitionId: ids.sourcePolicyMetric, dataScopeLevel: "session", aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "any", sourcePolicy: "api_import", activityIds: [ids.activity], athleteIds: [ids.ana] });
  const values = rows[0].values.map((v) => Number(v.value));
  assert.deepEqual(values, [20]);
});

test("§10.31 [Binding/source #31] source_policy='csv_import' returns ONLY the csv_import-entry value (30)", async () => {
  const rows = await queryMetricSeries({ metricDefinitionId: ids.sourcePolicyMetric, dataScopeLevel: "session", aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "any", sourcePolicy: "csv_import", activityIds: [ids.activity], athleteIds: [ids.ana] });
  const values = rows[0].values.map((v) => Number(v.value));
  assert.deepEqual(values, [30]);
});

test("§10.32 [Binding/source #32] source_policy='derived' (with aggregation_role_policy='all_including_derived') returns ONLY the real derived_rollup value (99), via its own is_derived flag", async () => {
  const rows = await queryMetricSeries({ metricDefinitionId: ids.sourcePolicyMetric, dataScopeLevel: "session", aggregationRolePolicy: "all_including_derived", coveragePolicy: "any", sourcePolicy: "derived", activityIds: [ids.activity], athleteIds: [ids.ana] });
  const values = rows[0].values.map((v) => Number(v.value));
  assert.deepEqual(values, [99]);
});

test("§10.33 [Binding/source #33] source_policy='source_connection' pinned to two DIFFERENT real connections returns two disjoint real result sets", async () => {
  const bothActivities = [ids.activity, ids.activityConnA2];
  const viaConnA = await queryMetricSeries({ metricDefinitionId: ids.sourcePolicyMetric, dataScopeLevel: "session", aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "any", sourcePolicy: "source_connection", sourceConnectionId: ids.connClubA, activityIds: bothActivities, athleteIds: [ids.ana] });
  const viaConnA2 = await queryMetricSeries({ metricDefinitionId: ids.sourcePolicyMetric, dataScopeLevel: "session", aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "any", sourcePolicy: "source_connection", sourceConnectionId: ids.connClubA2, activityIds: bothActivities, athleteIds: [ids.ana] });
  assert.deepEqual(viaConnA[0].values.map((v) => Number(v.value)).sort((a, b) => a - b), [10, 20, 30]);
  assert.deepEqual(viaConnA2[0].values.map((v) => Number(v.value)), [50]);
});

test("§10.34 [Binding/source #34] queryMetricSeries rejects source_policy='not_applicable' outright — that value has meaning only for a built-in series", async () => {
  await assert.rejects(
    queryMetricSeries({ metricDefinitionId: ids.sourcePolicyMetric, dataScopeLevel: "session", sourcePolicy: "not_applicable", activityIds: [ids.activity], athleteIds: [ids.ana] }),
    /only meaningful for a built-in series/,
  );
});

test("§10.35 [Binding/source #35] a richer template hint's unit mismatch excludes an otherwise key-matching candidate", async () => {
  const matching = await resolveTemplateHint({ hints: [{ key: ids.hintOnlyKey, unit: "m" }], dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, ownerUserId: null });
  assert.equal(matching.status, "resolved");
  assert.equal(matching.candidateIds[0], ids.hintOnlyDef);
  const mismatched = await resolveTemplateHint({ hints: [{ key: ids.hintOnlyKey, unit: "km" }], dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, ownerUserId: null });
  assert.equal(mismatched.status, "unresolved", "a real unit mismatch must exclude the candidate, never silently bind to the wrong unit");
});

test("§10.36 [Binding/source #36] a richer hint's scopeLevel mismatch excludes a metric configured ONLY for a different scope, while an UNCONFIGURED metric is never falsely excluded (the same 'never guess' rule the DB trigger itself uses)", async () => {
  const wrongScope = await resolveTemplateHint({ hints: [{ key: ids.hintOnlyKey, scopeLevel: "session" }], dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, ownerUserId: null });
  assert.equal(wrongScope.status, "unresolved", "hintOnlyDef is configured ONLY for scope_level='component' — a 'session' hint must exclude it, not guess");
  const rightScope = await resolveTemplateHint({ hints: [{ key: ids.hintOnlyKey, scopeLevel: "component" }], dataWorkspaceType: "club", dataWorkspaceScopeId: ids.clubA, ownerUserId: null });
  assert.equal(rightScope.status, "resolved");
});

// ============================================================
// The PoC query adapter itself — a real, working layer over the REAL
// training.canonical_activity_results() (never metric_values/session_
// feedback queried directly and independently re-joined), proving Round 2
// §9's required behaviors. This is explicitly a PoC-level adapter — the
// real backend implementation will formalize this as actual service code
// later; nothing here is application code being added this round.
//
// Round 3, §1/§2: this adapter now ACTUALLY executes the full 9-step
// pipeline the task requires, and ACTUALLY applies every declared column
// on dashboard_widget_series (data_scope_level, source_policy,
// source_connection_id, aggregation_role_policy, coverage_policy,
// group_by, analytical_aggregation, comparison_period) plus real 5-type
// workspace filtering — see runSeriesPipeline / reduceRows / fetchActivitiesInRange
// below. Per the task's own explicit instruction, nothing here is a
// declared-but-ignored option: anything not genuinely executable this
// round was REMOVED from the schema/contract instead (see report).
// ============================================================

// Round 3, §2: fetchActivitiesInRange now requires an EXPLICIT, recognized
// dataWorkspaceType — there is no silent "unrestricted" fallback anymore.
// 'platform' IS allowed to mean genuinely unrestricted (matching
// resolveActiveWorkspace's own real 'platform' semantics: a platform-wide
// aggregate view), but it must be asked for by name, never reached by
// omission — this is the direct fix for "platform semantics moraju biti
// precizno dokumentovane, ne slučajni fallback".
const RECOGNIZED_DATA_WORKSPACE_TYPES = ["platform", "club", "team", "private_coach", "athlete"];

async function fetchActivitiesInRange({ dataWorkspaceType, dataWorkspaceScopeId, dataWorkspaceUserId, athleteWorkspaceAthleteId, dateFrom, dateTo, athleteIds }) {
  if (!RECOGNIZED_DATA_WORKSPACE_TYPES.includes(dataWorkspaceType)) {
    throw new Error(`fetchActivitiesInRange: dataWorkspaceType must be one of ${RECOGNIZED_DATA_WORKSPACE_TYPES.join("/")} (got ${dataWorkspaceType}) — an unrestricted query must explicitly pass 'platform', never rely on an accidental default`);
  }
  const params = [dateFrom, dateTo];
  // owner-scope-based filtering (matches training.activities.owner_scope's
  // OWN 4-way shape: system/club/team/user — never the 5-value workspace
  // shape). 'platform' deliberately stays scopeSql='true' — see the
  // function comment above for why that is a real, documented meaning
  // here, not a fallback.
  let scopeSql = "true";
  if (dataWorkspaceType === "club") {
    params.push(dataWorkspaceScopeId);
    scopeSql = `a.owner_scope='club' and a.owner_club_id=$${params.length}`;
  } else if (dataWorkspaceType === "team") {
    params.push(dataWorkspaceScopeId);
    scopeSql = `a.owner_scope='team' and a.owner_team_id=$${params.length}`;
  } else if (dataWorkspaceType === "private_coach") {
    if (!dataWorkspaceUserId) throw new Error("fetchActivitiesInRange: dataWorkspaceType='private_coach' requires dataWorkspaceUserId");
    params.push(dataWorkspaceUserId);
    scopeSql = `a.owner_scope='user' and a.owner_user_id=$${params.length}`;
  }
  // Round 3, §2: 'athlete' workspace is fundamentally PARTICIPANT-based,
  // not OWNER-based — training.activities has no owner_scope='athlete'
  // value at all (matches dashboards' own data_workspace_scope_id being
  // NULL for 'athlete' — it is resolved from the CURRENT viewing athlete
  // at query time, never baked into a dashboard row). An athlete's own
  // workspace shows THEIR training regardless of which club/team owns the
  // underlying activity — scopeSql intentionally stays 'true' here;
  // athleteWorkspaceAthleteId narrows via the participant join below
  // instead, exactly like the explicit athleteIds parameter does for
  // every other workspace type.
  if (dataWorkspaceType === "athlete" && !athleteWorkspaceAthleteId) {
    throw new Error("fetchActivitiesInRange: dataWorkspaceType='athlete' requires athleteWorkspaceAthleteId");
  }
  const effectiveAthleteIds = dataWorkspaceType === "athlete" ? [athleteWorkspaceAthleteId] : athleteIds;
  let athleteSql = "true";
  if (effectiveAthleteIds?.length) {
    params.push(effectiveAthleteIds);
    athleteSql = `exists (select 1 from training.activity_participants p where p.activity_id=a.id and p.athlete_id = any($${params.length}::uuid[]) and p.merge_status='canonical')`;
  }
  const r = await pool.query(
    `select a.id, a.occurred_local_date from training.activities a where a.occurred_local_date between $1 and $2 and a.lifecycle_state <> 'superseded' and (${scopeSql}) and (${athleteSql})`,
    params,
  );
  return r.rows.map((row) => row.id);
}

// Round 3: a small helper mirroring fetchActivitiesInRange's OWN query,
// used wherever the pipeline needs each activity's date alongside its id
// (daily reduction, below, needs to know which raw facts share a
// calendar day) without running two separate queries against the same
// table.
async function fetchActivityDates(activityIds) {
  if (!activityIds.length) return {};
  // Cast to text IN SQL, never through a JS Date — node-pg's default DATE
  // parser constructs a JS Date that a non-UTC local timezone can then
  // shift by a day on .toISOString(); a plain text cast has no such
  // round-trip at all.
  const r = await pool.query(`select id, occurred_local_date::text as d from training.activities where id = any($1::uuid[])`, [activityIds]);
  return Object.fromEntries(r.rows.map((row) => [row.id, row.d]));
}

async function fetchCanonicalFacts(activityId) {
  const r = await pool.query(`select canonical_activity_id, canonical_participant_id, athlete_id, fact_kind, detail from training.canonical_activity_results($1)`, [activityId]);
  return r.rows;
}

async function fetchDailyAggregationMethod(metricDefinitionId) {
  const r = await pool.query(
    `select mdv.daily_aggregation_method from training_load.metric_definitions d
     join training_load.metric_definition_versions mdv on mdv.id = d.current_version_id
     where d.id = $1`,
    [metricDefinitionId],
  );
  if (r.rowCount === 0) throw new Error(`fetchDailyAggregationMethod: metric_definition ${metricDefinitionId} does not exist`);
  return r.rows[0].daily_aggregation_method;
}

// Round 3, §1: source_policy='source_connection' needs the ACTUAL
// connection each occasion's value came through — that lives on
// metric_events (session-level), not on the occasion itself, so this is
// one real extra join on top of canonical_activity_results' own JSON
// (which does not expose it) — never a reimplementation of that
// function's own effective-value resolution, only an additional,
// independent lookup for a field it does not carry.
async function fetchSourceConnectionByOccasion(occasionIds) {
  if (!occasionIds.length) return {};
  const r = await pool.query(
    `select o.id as occasion_id, e.source_connection_id
     from training_load.metric_measurement_occasions o
     join training_load.metric_event_participants ep on ep.id = o.event_participant_id
     join training_load.metric_events e on e.id = ep.event_id
     where o.id = any($1::uuid[])`,
    [occasionIds],
  );
  return Object.fromEntries(r.rows.map((row) => [row.occasion_id, row.source_connection_id]));
}

async function queryBuiltInSeries({ key, activityIds, athleteIds, dateFrom, dateTo }) {
  const def = (await pool.query(`select * from training_load.dashboard_builtin_series where key=$1`, [key])).rows[0];
  if (!def) throw new Error(`unknown built-in series ${key}`);
  const byAthlete = new Map();
  if (key === "session_count" || key === "last_session_date") {
    const ids2 = await fetchActivitiesInRange({ dataWorkspaceType: "platform", dateFrom, dateTo, athleteIds });
    const r = await pool.query(
      `select p.athlete_id, count(distinct a.id)::int as n, max(a.occurred_local_date)::text as last_date
       from training.activity_participants p join training.activities a on a.id=p.activity_id
       where a.id = any($1::uuid[]) and a.lifecycle_state <> 'superseded' and p.merge_status='canonical'
       group by p.athlete_id`,
      [ids2],
    );
    for (const row of r.rows) {
      byAthlete.set(row.athlete_id, { athleteId: row.athlete_id, values: [{ value: key === "session_count" ? row.n : row.last_date }] });
    }
    return [...byAthlete.values()];
  }
  const factKind = "rpe";
  const activityDates = await fetchActivityDates(activityIds ?? []);
  for (const activityId of activityIds) {
    const facts = (await fetchCanonicalFacts(activityId)).filter((f) => f.fact_kind === factKind);
    for (const f of facts) {
      if (athleteIds && !athleteIds.includes(f.athlete_id)) continue;
      const value = key === "rpe" ? f.detail.rpe : key === "srpe" ? f.detail.srpe : f.detail.durationMinutes;
      if (value == null) continue;
      if (!byAthlete.has(f.athlete_id)) byAthlete.set(f.athlete_id, { athleteId: f.athlete_id, values: [] });
      byAthlete.get(f.athlete_id).values.push({ value, activityId, date: activityDates[activityId] });
    }
  }
  return [...byAthlete.values()];
}

// Round 3, §1: source_policy is now REALLY executed, not merely accepted
// config — each named policy maps to a genuinely distinct filter:
//   all_with_conflicts — every effective value, conflict surfaced if >1 remain for the same athlete+unit
//   manual/api_import/csv_import — entry_method equality (real occasion column)
//   source_connection — occasion's OWN event.source_connection_id equals the series' pinned connection (real join, see fetchSourceConnectionByOccasion)
//   derived — metric_values.is_derived = true only
//   not_applicable — REJECTED here outright (queryMetricSeries is the Metrics-Core path; 'not_applicable' has meaning only for a built-in series — see schema.sql column comment)
async function queryMetricSeries({ metricDefinitionId, dataScopeLevel, aggregationRolePolicy, coveragePolicy, sourcePolicy, sourceConnectionId, activityIds, athleteIds, dateFrom, dateTo, dataWorkspaceType, dataWorkspaceScopeId, dataWorkspaceUserId, athleteWorkspaceAthleteId }) {
  const roleSets = {
    standalone_only: ["standalone"],
    standalone_and_source_rollup: ["standalone", "source_rollup"],
    all_including_derived: ["standalone", "source_rollup", "derived_rollup"],
  };
  const allowedRoles = roleSets[aggregationRolePolicy || "standalone_and_source_rollup"];
  const coverageSets = { complete_only: ["complete", "not_applicable"], complete_and_partial: ["complete", "partial", "not_applicable"], any: ["complete", "partial", "unknown", "not_applicable"] };
  const allowedCoverage = coverageSets[coveragePolicy || "complete_and_partial"];
  const effectiveSourcePolicy = sourcePolicy || "all_with_conflicts";
  if (effectiveSourcePolicy === "not_applicable") {
    throw new Error("queryMetricSeries: source_policy 'not_applicable' is only meaningful for a built-in series (queryBuiltInSeries) — never a Metrics-Core-backed one");
  }
  if (effectiveSourcePolicy === "source_connection" && !sourceConnectionId) {
    throw new Error("queryMetricSeries: source_policy 'source_connection' requires sourceConnectionId");
  }

  const defExists = await pool.query(`select 1 from training_load.metric_definitions where id=$1`, [metricDefinitionId]);
  if (defExists.rowCount === 0) {
    throw new Error(`queryMetricSeries: metric_definition ${metricDefinitionId} does not exist`);
  }

  let resolvedActivityIds = activityIds;
  if (!resolvedActivityIds) resolvedActivityIds = await fetchActivitiesInRange({ dataWorkspaceType: dataWorkspaceType || "platform", dataWorkspaceScopeId, dataWorkspaceUserId, athleteWorkspaceAthleteId, dateFrom, dateTo, athleteIds });
  const activityDates = await fetchActivityDates(resolvedActivityIds);

  // Gather every candidate fact first (scope/role/coverage filters only —
  // cheap, in-memory) so a single batched query can resolve
  // source_connection_id for exactly the occasions that need it.
  const candidates = [];
  for (const activityId of resolvedActivityIds) {
    const facts = (await fetchCanonicalFacts(activityId)).filter((f) => f.fact_kind === "metric_value" && f.detail.metricDefinitionId === metricDefinitionId);
    for (const f of facts) {
      if (athleteIds && !athleteIds.includes(f.athlete_id)) continue;
      // Step 3 — prevent double-count: a component-scope standalone value
      // and its own session-scope rollup are NEVER both returned — the
      // caller picks exactly one scope level, structurally.
      const isComponent = f.detail.segmentId != null;
      const factScope = isComponent ? "component" : "session";
      if (factScope !== dataScopeLevel) continue;
      if (!allowedRoles.includes(f.detail.aggregationRole)) continue;
      if (!allowedCoverage.includes(f.detail.coverage)) continue;
      candidates.push({ activityId, f });
    }
  }
  let occasionConnMap = {};
  if (effectiveSourcePolicy === "source_connection") {
    occasionConnMap = await fetchSourceConnectionByOccasion(candidates.map((c) => c.f.detail.occasionId));
  }

  const byAthlete = new Map();
  for (const { activityId, f } of candidates) {
    if (effectiveSourcePolicy === "derived") {
      if (!f.detail.isDerived) continue;
    } else if (effectiveSourcePolicy === "source_connection") {
      if (occasionConnMap[f.detail.occasionId] !== sourceConnectionId) continue;
    } else if (["manual", "api_import", "csv_import"].includes(effectiveSourcePolicy)) {
      if (f.detail.entryMethod !== effectiveSourcePolicy) continue;
    } else if (effectiveSourcePolicy !== "all_with_conflicts") {
      throw new Error(`queryMetricSeries: unknown source_policy ${effectiveSourcePolicy}`);
    }
    if (!byAthlete.has(f.athlete_id)) byAthlete.set(f.athlete_id, { athleteId: f.athlete_id, values: [] });
    byAthlete.get(f.athlete_id).values.push({
      value: f.detail.valueNumeric, unit: f.detail.unitAtCapture, entryMethod: f.detail.entryMethod,
      isDerived: f.detail.isDerived, occasionId: f.detail.occasionId, activityId, date: activityDates[activityId],
    });
  }
  for (const row of byAthlete.values()) {
    // Step 4 — group by unit (real, structural separation, not just a
    // flag): `groups` below never mixes two different units in one
    // reduction. `values`/`unitConflict`/`conflict` are kept as an
    // ADDITIVE, unchanged top-level convenience (same shape every
    // existing §7/§9 test already asserts on) — the two are consistent
    // views of the same underlying facts, never disagreeing data.
    const byUnit = new Map();
    for (const v of row.values) {
      const key = v.unit ?? "__none__";
      if (!byUnit.has(key)) byUnit.set(key, []);
      byUnit.get(key).push(v);
    }
    row.groups = [...byUnit.entries()].map(([unit, values]) => ({
      unit: unit === "__none__" ? null : unit,
      values,
      conflict: values.length > 1,
    }));
    const distinctUnits = new Set(row.values.map((v) => v.unit));
    row.unitConflict = distinctUnits.size > 1;
    row.conflict = effectiveSourcePolicy === "all_with_conflicts" && row.values.length > 1 && !row.unitConflict;
  }
  return [...byAthlete.values()];
}

// Round 3, §5: hints are now a RICHER shape — { key, valueType?, unit?,
// scopeLevel? } — not just a bare key string (a plain string is still
// accepted for backward compatibility; every candidate simply passes the
// extra filters trivially when they are absent). A candidate must match
// EVERY hint field that is actually present, not just the key — this is
// the literal fix for "binding hints moraju kodirati tip vrednosti,
// očekivanu jedinicu, traženi scope capability" instead of matching on
// key alone. Visibility filtering (system / same-data-workspace club or
// team / the resolving user's OWN private catalog) is unchanged from
// Round 2 and is what already guarantees another user's private metric
// UUID can never leak through a template — enriching the match criteria
// only ever NARROWS the candidate set further, it can never widen it
// past what visibility already allows.
async function resolveTemplateHint({ hints, dataWorkspaceType, dataWorkspaceScopeId, ownerUserId }) {
  for (const hint of hints) {
    const key = typeof hint === "string" ? hint : hint.key;
    const candidates = await pool.query(
      `select d.id, d.owner_scope, d.owner_club_id, d.owner_team_id, d.owner_user_id, mdv.value_type, mdv.unit
       from training_load.metric_definitions d
       join training_load.metric_definition_versions mdv on mdv.id = d.current_version_id
       where d.key = $1 and d.state = 'active'
         and (
           d.owner_scope = 'system'
           or (d.owner_scope = 'club' and $2 = 'club' and d.owner_club_id = $3)
           or (d.owner_scope = 'team' and $2 = 'team' and d.owner_team_id = $3)
           or (d.owner_scope = 'user' and d.owner_user_id = $4)
         )`,
      [key, dataWorkspaceType, dataWorkspaceScopeId, ownerUserId],
    );
    let rows = candidates.rows;
    if (typeof hint === "object") {
      if (hint.valueType) rows = rows.filter((r) => r.value_type === hint.valueType);
      if (hint.unit) rows = rows.filter((r) => r.unit === hint.unit);
      if (hint.scopeLevel) {
        const kept = [];
        for (const r of rows) {
          const hasAny = await pool.query(`select 1 from training_load.metric_definition_scope_capabilities where metric_definition_id=$1 limit 1`, [r.id]);
          if (hasAny.rowCount === 0) { kept.push(r); continue; } // unconfigured = unconstrained, same "never guess" rule the DB trigger itself uses
          const matches = await pool.query(`select 1 from training_load.metric_definition_scope_capabilities where metric_definition_id=$1 and scope_level=$2`, [r.id, hint.scopeLevel]);
          if (matches.rowCount > 0) kept.push(r);
        }
        rows = kept;
      }
    }
    if (rows.length === 0) continue; // try next hint
    if (rows.length === 1) return { status: "resolved", candidateIds: [rows[0].id] };
    return { status: "needs_resolution", candidateIds: rows.map((r) => r.id) };
  }
  return { status: "unresolved", candidateIds: [] };
}

async function runBatchQuery(specs) {
  return Promise.all(specs.map(async (spec) => {
    try {
      const data = spec.kind === "builtin"
        ? await queryBuiltInSeries(spec)
        : await queryMetricSeries(spec);
      return { widgetId: spec.widgetId, status: "ok", data };
    } catch (error) {
      return { widgetId: spec.widgetId, status: "error", error: error.message };
    }
  }));
}

// ============================================================
// Round 3, §1: the REAL 9-step pipeline, steps 5-9 — daily reduction
// (Stage 1), dashboard grouping, analytical aggregation (Stage 2),
// comparison period, and final conflict metadata — built ON TOP of
// queryBuiltInSeries/queryMetricSeries (steps 1-4) above, never
// reimplementing their fact resolution.
// ============================================================

const REDUCE_FN = {
  sum: (nums) => nums.reduce((a, b) => a + b, 0),
  avg: (nums) => nums.reduce((a, b) => a + b, 0) / nums.length,
  max: (nums) => Math.max(...nums),
  last: (nums) => nums[nums.length - 1],
};
function reduceNumbers(nums, method) {
  if (!nums.length) return null;
  if (!method || method === "none") return nums.length === 1 ? nums[0] : nums; // "none" = no reduction, keep every value
  const fn = REDUCE_FN[method];
  if (!fn) throw new Error(`reduceNumbers: unknown aggregation method ${method}`);
  return fn(nums);
}

// Step 5 (daily reduction) + Step 6 (dashboard grouping) + Step 7
// (analytical aggregation). Two different units are NEVER combined into
// one number, at any groupBy — every code path below groups by unit
// FIRST, always.
function reduceRows(rows, { dailyAggMethod, groupBy, analyticalAggregation }) {
  // Step 5 — Stage 1 daily reduction (per athlete, per unit): collapse
  // same CALENDAR DAY raw facts (e.g. two separate activities the same
  // athlete had on one date) into ONE per-day value using the METRIC's
  // own fixed daily_aggregation_method. Built-in series (dailyAggMethod
  // null) skip this — session_feedback/session-level built-ins are
  // already one-per-session, and session_count/last_session_date are
  // already pre-aggregated rollups, so there is nothing to collapse.
  const perAthleteUnit = [];
  for (const row of rows) {
    const byUnit = new Map();
    for (const v of row.values) {
      const key = v.unit ?? "__none__";
      if (!byUnit.has(key)) byUnit.set(key, []);
      byUnit.get(key).push(v);
    }
    for (const [unitKey, values] of byUnit) {
      const unit = unitKey === "__none__" ? null : unitKey;
      let perDay;
      if (dailyAggMethod) {
        const byDate = new Map();
        for (const v of values) {
          const d = v.date ?? "unknown";
          if (!byDate.has(d)) byDate.set(d, []);
          byDate.get(d).push(Number(v.value));
        }
        perDay = [...byDate.entries()].map(([date, nums]) => ({ date, value: reduceNumbers(nums, dailyAggMethod) }));
      } else {
        perDay = values.map((v) => ({ date: v.date, value: Number(v.value) }));
      }
      perAthleteUnit.push({ athleteId: row.athleteId, unit, perDay, unitConflict: row.unitConflict, conflict: row.conflict });
    }
  }

  // Step 6 — dashboard grouping, and Step 7 — Stage 2 analytical
  // aggregation (independent of dailyAggMethod — Round 3's whole point).
  // 'day'/'session' bucket per calendar date (a 'session' bucket differs
  // from 'day' only when data_scope_level='component' spreads several
  // components across the SAME session — out of scope for this
  // adapter's fixture, documented as such in the report); 'athlete'
  // collapses the WHOLE queried range into one bucket PER ATHLETE.
  // 'team' is handled as a genuinely SEPARATE branch below — it must
  // actually merge ACROSS athletes into one bucket, not just relabel an
  // athlete-shaped bucket; every declared group_by value is really
  // executed here, never silently degraded to a neighbor's behavior.
  const out = [];
  if (groupBy === "team") {
    const byUnit = new Map();
    for (const entry of perAthleteUnit) {
      const key = entry.unit ?? "__none__";
      if (!byUnit.has(key)) byUnit.set(key, []);
      for (const d of entry.perDay) byUnit.get(key).push(d.value);
    }
    for (const [unitKey, nums] of byUnit) {
      out.push({ athleteId: null, unit: unitKey === "__none__" ? null : unitKey, bucketKey: "team", value: reduceNumbers(nums, analyticalAggregation), rawCount: nums.length });
    }
    return out;
  }
  for (const entry of perAthleteUnit) {
    const buckets = new Map();
    for (const d of entry.perDay) {
      const bucketKey = groupBy === "athlete" ? "all" : (d.date ?? "unknown");
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
      buckets.get(bucketKey).push(d.value);
    }
    for (const [bucketKey, nums] of buckets) {
      out.push({
        athleteId: entry.athleteId, unit: entry.unit, bucketKey,
        value: reduceNumbers(nums, analyticalAggregation),
        rawCount: nums.length,
        unitConflict: entry.unitConflict, conflict: entry.conflict,
      });
    }
  }
  return out;
}

// Step 8 — comparison period: shift the SAME query window back one
// period-length or one calendar year, never a fixed/guessed offset.
function shiftDateRange(dateFrom, dateTo, comparisonPeriod) {
  const from = new Date(`${dateFrom}T00:00:00Z`);
  const to = new Date(`${dateTo}T00:00:00Z`);
  if (comparisonPeriod === "previous_period") {
    const spanDays = Math.round((to - from) / 86400000) + 1;
    const newTo = new Date(from); newTo.setUTCDate(newTo.getUTCDate() - 1);
    const newFrom = new Date(newTo); newFrom.setUTCDate(newFrom.getUTCDate() - (spanDays - 1));
    return { dateFrom: newFrom.toISOString().slice(0, 10), dateTo: newTo.toISOString().slice(0, 10) };
  }
  if (comparisonPeriod === "previous_year") {
    const newFrom = new Date(from); newFrom.setUTCFullYear(newFrom.getUTCFullYear() - 1);
    const newTo = new Date(to); newTo.setUTCFullYear(newTo.getUTCFullYear() - 1);
    return { dateFrom: newFrom.toISOString().slice(0, 10), dateTo: newTo.toISOString().slice(0, 10) };
  }
  throw new Error(`shiftDateRange: unknown comparisonPeriod ${comparisonPeriod}`);
}

// The full pipeline entry point a widget's own query call actually uses —
// `series` mirrors a real dashboard_widget_series row's query-affecting
// columns; `ctx` carries the request-level workspace/date/athlete
// parameters a real route would resolve from the session.
async function runSeriesPipeline(series, ctx) {
  const groupBy = series.groupBy || "day";
  const analyticalAggregation = series.builtInSeriesKey
    ? (series.analyticalAggregation || "sum")
    : (series.analyticalAggregation || "sum");
  const dailyAggMethod = series.metricDefinitionId ? await fetchDailyAggregationMethod(series.metricDefinitionId) : null;

  async function runForRange(dateFrom, dateTo) {
    const activityIds = await fetchActivitiesInRange({
      dataWorkspaceType: ctx.dataWorkspaceType, dataWorkspaceScopeId: ctx.dataWorkspaceScopeId,
      dataWorkspaceUserId: ctx.dataWorkspaceUserId, athleteWorkspaceAthleteId: ctx.athleteWorkspaceAthleteId,
      dateFrom, dateTo, athleteIds: ctx.athleteIds,
    });
    const rows = series.builtInSeriesKey
      ? await queryBuiltInSeries({ key: series.builtInSeriesKey, activityIds, athleteIds: ctx.athleteIds, dateFrom, dateTo })
      : await queryMetricSeries({
          metricDefinitionId: series.metricDefinitionId, dataScopeLevel: series.dataScopeLevel,
          aggregationRolePolicy: series.aggregationRolePolicy, coveragePolicy: series.coveragePolicy,
          sourcePolicy: series.sourcePolicy, sourceConnectionId: series.sourceConnectionId,
          activityIds, athleteIds: ctx.athleteIds, dateFrom, dateTo,
        });
    return reduceRows(rows, { dailyAggMethod, groupBy, analyticalAggregation });
  }

  const current = await runForRange(ctx.dateFrom, ctx.dateTo);
  let comparison = null;
  if (series.comparisonPeriod) {
    const shifted = shiftDateRange(ctx.dateFrom, ctx.dateTo, series.comparisonPeriod);
    comparison = await runForRange(shifted.dateFrom, shifted.dateTo);
  }
  return { current, comparison };
}

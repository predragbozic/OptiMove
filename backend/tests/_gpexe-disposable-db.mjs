// Disposable-database harness for the GPEXE pilot import (tests and
// backend/scripts/gpexe-pilot-disposable-run.mjs). Same convention as
// training-load-dashboard.test.mjs: a uniquely-named database on the
// server behind DATABASE_URL, never OPTIMOVE or monitoring2, with the legacy
// scaffold Strategy B's fingerprint preflight needs and the real
// migrations_v2 files applied through the real runner.
//
// It also writes a marker table that backend/scripts/gpexe-import-pilot.mjs requires
// before --apply: a database without it (OPTIMOVE included) is refused.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DISPOSABLE_MARKER_TABLE = "public.optimove_disposable_test_database";
export const DISPOSABLE_DB_NAME_PATTERN = /^optimove_tests_gpexe_[a-z0-9_]+$/;

export const GPEXE_TEST_MIGRATIONS = [
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
  "202609100900_training_load_v15_dashboard_catalog_and_dashboards.sql",
  "202609101000_training_load_v16_dashboard_widgets_series_selection.sql",
  "202609101100_training_load_v17_dashboard_sanctioned_functions.sql",
  "202609101200_training_load_v18_dashboard_catalog_seed.sql",
  "202609170900_training_load_v19_dashboard_delete.sql",
  "202609171800_training_load_v20_gpexe_source_bindings.sql",
  "202609181000_training_load_v21_import_deletion_log.sql",
  "202609191000_training_load_v22_gpexe_in_app_import.sql",
  "202609201000_training_load_v23_gpexe_import_approval.sql",
  "202609211000_training_load_v24_gpexe_settings_change_guard.sql",
  "202609251000_training_load_v25_activity_roster_foundation.sql",
  "202609252000_training_load_v26_activity_roster_decisions.sql",
];

// Copied from training-load-dashboard.test.mjs (identical to
// training-load-metrics.test.mjs).
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
  -- Same shape as the real table (migrations/20260801_athlete_memberships.sql):
  -- v25 records membership periods from starts_at / archived_at / updated_at.
  create table public.athlete_memberships (
    id uuid primary key default gen_random_uuid(),
    athlete_id uuid not null references public.athletes(id) on delete cascade,
    club_id uuid not null references public.clubs(id) on delete cascade,
    team_id uuid references public.teams(id) on delete cascade,
    membership_type varchar(20) not null,
    status varchar(20) not null default 'active',
    starts_at timestamptz not null default now(),
    ends_at timestamptz,
    archived_at timestamptz,
    archived_by_user_id uuid references public.users(id) on delete set null,
    archive_reason text,
    created_by_user_id uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint athlete_memberships_type_check check (membership_type in ('club', 'team')),
    constraint athlete_memberships_status_check check (status in ('active', 'paused', 'archived')),
    constraint athlete_memberships_team_shape_check check (
      (membership_type = 'club' and team_id is null) or (membership_type = 'team' and team_id is not null)
    ),
    constraint athlete_memberships_team_club_fkey foreign key (team_id, club_id) references public.teams(id, club_id)
  );
  create unique index athlete_memberships_one_active_club_idx on public.athlete_memberships (athlete_id, club_id)
    where status = 'active' and membership_type = 'club';
  create unique index athlete_memberships_one_active_team_idx on public.athlete_memberships (athlete_id, team_id)
    where status = 'active' and membership_type = 'team';
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

// The runner records a migration as "<folder name>/<file>", so the copies
// live in a folder named migrations_v2 (the name a real deploy records):
// a database created with some of the files can be brought up to date later
// from another temporary copy without re-running what it already has.
async function migrationsFolder() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-gpexe-migrations-"));
  const migrationsDir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(migrationsDir);
  return { tempRoot, migrationsDir };
}

function assertDisposableName(name, url) {
  if (!DISPOSABLE_DB_NAME_PATTERN.test(name) || name.toLowerCase() === "optimove" || /monitoring2/i.test(url)) {
    throw new Error(`SAFETY: refusing a database name that is not a disposable GPEXE test database: ${name}`);
  }
}

// `migrations` applies only the first files of GPEXE_TEST_MIGRATIONS (e.g. to
// write rows as they were before a migration); applyGpexeTestMigrations then
// brings the database up to date through the real runner.
export async function createGpexeDisposableDb({ baseDatabaseUrl, label, migrations = GPEXE_TEST_MIGRATIONS }) {
  if (!baseDatabaseUrl) throw new Error("baseDatabaseUrl (DATABASE_URL) is required to reach the local Postgres server.");
  const base = new URL(baseDatabaseUrl);
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  const name = `optimove_tests_gpexe_${label}_${crypto.randomBytes(6).toString("hex")}`;
  const url = new URL(base);
  url.pathname = `/${name}`;
  assertDisposableName(name, url.toString());

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const current = await admin.query("select current_database() as db");
    assert.equal(current.rows[0].db, "postgres", "SAFETY: admin connection must be on the postgres database");
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  const { tempRoot, migrationsDir } = await migrationsFolder();
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const own = await client.query("select current_database() as db");
    assert.equal(own.rows[0].db, name, "SAFETY: connection landed on an unexpected database");
    await client.query(LEGACY_FIXTURE_SQL);
    for (const file of migrations) {
      await fsp.copyFile(path.resolve(__dirname, "../../migrations_v2", file), path.join(migrationsDir, file));
    }
    await runner.runMigrations({ databaseUrl: url.toString(), migrationsRoot: migrationsDir });
    await client.query(`create table ${DISPOSABLE_MARKER_TABLE} (purpose text not null, created_at timestamptz not null default now())`);
    await client.query(`insert into ${DISPOSABLE_MARKER_TABLE} (purpose) values ('gpexe-pilot')`);
  } finally {
    await client.end();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }

  async function drop() {
    const dropClient = new pg.Client({ connectionString: adminUrl.toString() });
    await dropClient.connect();
    try {
      await dropClient.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [name]);
      await dropClient.query(`drop database if exists "${name}"`);
    } finally {
      await dropClient.end();
    }
  }
  return { name, url: url.toString(), drop };
}

export async function applyGpexeTestMigrations(databaseUrl, migrations = GPEXE_TEST_MIGRATIONS) {
  const name = new URL(databaseUrl).pathname.slice(1);
  assertDisposableName(name, databaseUrl);
  const { tempRoot, migrationsDir } = await migrationsFolder();
  try {
    for (const file of migrations) {
      await fsp.copyFile(path.resolve(__dirname, "../../migrations_v2", file), path.join(migrationsDir, file));
    }
    return await runner.runMigrations({ databaseUrl, migrationsRoot: migrationsDir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

// Minimal org fixture the importer needs: a user, club, team, and athletes
// with an active team membership.
export async function createGpexePilotOrg(client, { athleteNames }) {
  const suffix = crypto.randomBytes(4).toString("hex");
  const user = await client.query(`insert into public.users (email, full_name, display_name) values ($1,'GPEXE Pilot Importer','GPEXE Pilot Importer') returning id`, [`gpexe-pilot-${suffix}@test.local`]);
  const club = await client.query(`insert into public.clubs (name) values ('GPEXE Pilot Club') returning id`);
  const team = await client.query(`insert into public.teams (club_id, name) values ($1,'GPEXE Pilot Team') returning id`, [club.rows[0].id]);
  const athleteIds = [];
  for (const name of athleteNames) {
    const athlete = await client.query(`insert into public.athletes (full_name, display_name, device_timezone) values ($1,$1,'Europe/Sarajevo') returning id`, [name]);
    await client.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status) values ($1,$2,$3,'team','active')`, [athlete.rows[0].id, club.rows[0].id, team.rows[0].id]);
    athleteIds.push(athlete.rows[0].id);
  }
  return { userId: user.rows[0].id, clubId: club.rows[0].id, teamId: team.rows[0].id, athleteIds };
}

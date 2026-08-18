import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrationPaths } from "../src/migrate.js";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(__dirname, "../../migrations/20260818_seed_pankov_programs.sql");
const packageId = "pankov-cleaned-2026-08-18";
const sourceType = "pankov_cleaned_import";
const sourceRefs = ["2026-06-15", "2026-06-22", "2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"].map((week) => `${packageId}:weekly:${week}`);

const createdDatabases = [];

function adminUrl() {
  const raw = process.env.TEST_DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  assert.ok(raw, "DATABASE_URL or TEST_DATABASE_ADMIN_URL is required for migration tests");
  const url = new URL(raw);
  assert.match(url.hostname, /^(localhost|127\.0\.0\.1|::1)$/i, "migration tests only run against localhost");
  return url;
}

function dbUrl(name) {
  const url = adminUrl();
  url.pathname = `/${name}`;
  return url.toString();
}

function ident(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function withDatabase(fn) {
  const name = `optimove_pankov_migration_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl().toString() });
  await admin.connect();
  await admin.query(`create database ${ident(name)}`);
  await admin.end();
  createdDatabases.push(name);
  const client = new Client({ connectionString: dbUrl(name) });
  await client.connect();
  try {
    await createMinimalSchema(client);
    await seedOwnerAthleteAndExercises(client);
    return await fn(client);
  } finally {
    await client.end();
  }
}

after(async () => {
  const admin = new Client({ connectionString: adminUrl().toString() });
  await admin.connect();
  for (const name of createdDatabases.reverse()) {
    await admin.query(`drop database if exists ${ident(name)} with (force)`);
  }
  await admin.end();
});

async function createMinimalSchema(client) {
  await client.query(`
    create extension if not exists pgcrypto;
    create schema if not exists plans;
    create schema if not exists library;
    create table public.users (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      password_hash text not null default 'x',
      full_name text,
      display_name text,
      role_hint text not null default 'coach',
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table public.athletes (
      id uuid primary key default gen_random_uuid(),
      athlete_id text,
      source_external_id text,
      full_name text,
      display_name text,
      user_id uuid references public.users(id) on delete set null,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table library.exercises (
      id uuid primary key default gen_random_uuid(),
      owner_scope varchar(20) not null default 'system',
      owner_user_id uuid references public.users(id) on delete set null,
      owner_club_id uuid,
      owner_team_id uuid,
      created_by_user_id uuid references public.users(id) on delete set null,
      exercise_code varchar(80),
      slug varchar(180),
      name varchar(255) not null,
      place_id uuid,
      complexity_level_id uuid,
      starting_position_id uuid,
      aim text,
      execution_notes text,
      instruction text,
      video_url text,
      image_url text,
      image_mime_type varchar(80),
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      attractor_id uuid
    );
    create unique index exercises_exercise_code_unique on library.exercises (exercise_code) where exercise_code is not null;
    create unique index exercises_slug_unique on library.exercises (slug) where slug is not null;
    create table plans.plans (
      id uuid primary key default gen_random_uuid(),
      plan_type varchar(40) not null,
      created_by_user_id uuid not null references public.users(id) on delete cascade,
      club_id uuid,
      team_id uuid,
      athlete_id uuid references public.athletes(id) on delete cascade,
      name varchar(255),
      note text,
      icon_url text,
      week_start date,
      start_date date,
      duration_days integer,
      program_order numeric,
      status varchar(32) not null default 'draft',
      source_type varchar(80),
      source_ref text,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      source_external_id varchar(80),
      is_template boolean not null default false,
      color varchar(32),
      visibility varchar(32) not null default 'private',
      edit_source_plan_id uuid references plans.plans(id) on delete cascade,
      is_edit_draft boolean not null default false,
      library_scope varchar(32) not null default 'my',
      library_category varchar(80),
      cover_image_url text,
      is_free boolean not null default true,
      price_cents integer,
      available_until date,
      owner_type varchar(32) not null default 'coach',
      access_model varchar(32) not null default 'free_forever',
      access_duration_days integer,
      subscription_period varchar(16),
      can_copy boolean not null default true,
      can_edit_copy boolean not null default true,
      can_assign_to_athlete boolean not null default true,
      athlete_can_view_directly boolean not null default false,
      requires_approval boolean not null default false,
      builder_batch_id uuid
    );
    create unique index plans_weekly_unique on plans.plans (athlete_id, created_by_user_id, week_start) where plan_type = 'weekly' and is_active = true;
    create table plans.plan_days (
      id uuid primary key default gen_random_uuid(),
      plan_id uuid not null references plans.plans(id) on delete cascade,
      date date,
      day_note varchar(255),
      day_order numeric,
      source_row_ref text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      block_index integer,
      block_name varchar(255),
      block_type varchar(40),
      block_order numeric
    );
    create table plans.plan_sessions (
      id uuid primary key default gen_random_uuid(),
      plan_day_id uuid not null references plans.plan_days(id) on delete cascade,
      am_pm varchar(20),
      bta varchar(20),
      session_order numeric,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      session_time time
    );
    create table plans.plan_nodes (
      id uuid primary key default gen_random_uuid(),
      plan_session_id uuid not null references plans.plan_sessions(id) on delete cascade,
      parent_id uuid references plans.plan_nodes(id) on delete cascade,
      node_type varchar(20) not null,
      name varchar(255) not null,
      color varchar(32),
      icon_url text,
      short_note text,
      note text,
      node_order numeric not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table plans.plan_items (
      id uuid primary key default gen_random_uuid(),
      plan_session_id uuid not null references plans.plan_sessions(id) on delete cascade,
      item_type varchar(30) not null,
      exercise_id uuid references library.exercises(id) on delete set null,
      domain_id uuid,
      category_id uuid,
      section_id uuid,
      title varchar(255),
      description text,
      short_note text,
      note text,
      image_url text,
      video_url text,
      sets varchar(255),
      reps varchar(255),
      load varchar(255),
      item_order numeric,
      exercise_order numeric,
      source_row_ref text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      domain_name varchar(255),
      category_name varchar(255),
      section_name varchar(255),
      domain_color varchar(32),
      category_color varchar(32),
      section_color varchar(32),
      domain_icon_url text,
      category_icon_url text,
      section_icon_url text,
      domain_short_note text,
      category_short_note text,
      section_short_note text,
      domain_note text,
      category_note text,
      section_note text,
      domain_order numeric,
      category_order numeric,
      section_order numeric,
      plan_node_id uuid references plans.plan_nodes(id) on delete set null
    );
    create table library.program_tags (
      plan_id uuid not null references plans.plans(id) on delete cascade,
      tag_id uuid not null,
      created_at timestamptz not null default now(),
      primary key (plan_id, tag_id)
    );
    create table library.program_reviews (
      id uuid primary key default gen_random_uuid(),
      plan_id uuid not null references plans.plans(id) on delete cascade,
      reviewer_user_id uuid references public.users(id) on delete set null,
      rating smallint not null default 5,
      comment text,
      status varchar(32) not null default 'pending',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table library.program_access (
      id uuid primary key default gen_random_uuid(),
      plan_id uuid not null references plans.plans(id) on delete cascade,
      user_id uuid not null references public.users(id) on delete cascade,
      access_type varchar(32) not null default 'copied',
      status varchar(32) not null default 'accessed',
      related_plan_id uuid references plans.plans(id) on delete set null,
      accessed_at timestamptz not null default now(),
      starts_at timestamptz not null default now(),
      expires_at timestamptz,
      source varchar(32),
      license_snapshot jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
}

function extractJson(sql, variableName) {
  const marker = `${variableName} jsonb := '`;
  const start = sql.indexOf(marker);
  assert.notEqual(start, -1, `${variableName} must exist in migration SQL`);
  let index = start + marker.length;
  let text = "";
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'") {
      if (sql[index + 1] === "'") {
        text += "'";
        index += 2;
        continue;
      }
      break;
    }
    text += char;
    index += 1;
  }
  return JSON.parse(text);
}

async function migrationSql() {
  return readFile(migrationPath, "utf8");
}

async function seedOwnerAthleteAndExercises(client) {
  const sql = await migrationSql();
  const required = extractJson(sql, "v_required_exercises");
  await client.query(`insert into public.users (email, full_name, display_name, role_hint) values ('predrag.bozic@rzsport.gov.rs', 'Predrag Bozic', 'Predrag Bozic', 'coach')`);
  const athleteUser = await client.query(`insert into public.users (email, full_name, display_name, role_hint) values ('radovan.pankov@example.com', 'Radovan Pankov', 'Radovan Pankov', 'athlete') returning id`);
  await client.query(`insert into public.athletes (athlete_id, source_external_id, full_name, display_name, user_id) values ('101', '101', 'Radovan Pankov', 'Radovan Pankov', $1)`, [athleteUser.rows[0].id]);
  for (const item of required) {
    if (item.keyType === "code") {
      await client.query("insert into library.exercises (owner_scope, exercise_code, slug, name) values ('system', $1, $2, $3)", [item.key, `code-${item.key}`, `Exercise ${item.key}`]);
    } else if (!String(item.key).startsWith(`${packageId}:custom:`)) {
      await client.query("insert into library.exercises (owner_scope, owner_user_id, created_by_user_id, exercise_code, slug, name) select 'user', u.id, u.id, null, $1, $2 from public.users u where u.email = 'predrag.bozic@rzsport.gov.rs'", [item.key, item.expectedName]);
    }
  }
}

async function applyMigration(client) {
  await client.query(await migrationSql());
}

async function expectMigrationRejects(client, expected) {
  await assert.rejects(async () => {
    try {
      await applyMigration(client);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  }, expected);
}

async function packageCounts(client) {
  const result = await client.query(
    `select count(distinct p.id)::int plans,
            count(distinct pd.id)::int days,
            count(distinct ps.id)::int sessions,
            count(distinct pi.id) filter (where pi.item_type = 'exercise')::int exercise_items,
            count(distinct pi.id) filter (where pi.item_type = 'note')::int note_items,
            count(distinct e.id) filter (where e.slug like $2)::int custom_exercises,
            count(distinct p.source_ref)::int source_refs,
            bool_and(p.status = 'draft') all_draft,
            bool_and(a.athlete_id = '101' or a.source_external_id = '101') all_athlete_101
     from plans.plans p
     left join public.athletes a on a.id = p.athlete_id
     left join plans.plan_days pd on pd.plan_id = p.id
     left join plans.plan_sessions ps on ps.plan_day_id = pd.id
     left join plans.plan_items pi on pi.plan_session_id = ps.id
     left join library.exercises e on e.id = pi.exercise_id
     where p.source_type = $1 and p.source_ref = any($3::text[])`,
    [sourceType, `${packageId}:custom:%`, sourceRefs],
  );
  return result.rows[0];
}

async function makeLegacyConflict(client, overrides = {}) {
  const coach = (await client.query("select id from public.users where email = 'predrag.bozic@rzsport.gov.rs'")).rows[0];
  const athlete = (await client.query("select id from public.athletes where athlete_id = '101'")).rows[0];
  const plan = await client.query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, week_start, status, source_type, source_ref, is_active)
     values ('weekly', $1, $2, $3, date '2026-07-20', $4, $5, $6, true) returning id`,
    [coach.id, athlete.id, overrides.name || "KOmpetitive 2026-07-20", overrides.status || "active", overrides.sourceType || "builder", overrides.sourceRef ?? null],
  );
  const day = await client.query("insert into plans.plan_days (plan_id, date, day_order) values ($1, date '2026-07-20', 1) returning id", [plan.rows[0].id]);
  const session = await client.query("insert into plans.plan_sessions (plan_day_id, session_order) values ($1, 1) returning id", [day.rows[0].id]);
  const exercise = (await client.query("select id from library.exercises where exercise_code is not null limit 1")).rows[0];
  const itemCount = overrides.itemCount ?? 7;
  for (let i = 1; i <= itemCount; i += 1) {
    await client.query("insert into plans.plan_items (plan_session_id, item_type, exercise_id, title, item_order) values ($1, 'exercise', $2, $3, $4)", [session.rows[0].id, exercise.id, `Legacy ${i}`, i]);
  }
  return plan.rows[0].id;
}

async function restoreFirstBackup(client) {
  const backup = (await client.query("select payload from public.data_migration_backups order by created_at limit 1")).rows[0]?.payload;
  assert.ok(backup, "backup payload must exist");
  const tables = backup.tables;
  for (const ref of sourceRefs) {
    const ids = await client.query("select id from plans.plans where source_ref = $1", [ref]);
    for (const row of ids.rows) await deletePlanTree(client, row.id);
  }
  for (const plan of tables["plans.plans"]) await insertJsonRow(client, "plans.plans", plan);
  for (const day of tables["plans.plan_days"]) await insertJsonRow(client, "plans.plan_days", day);
  for (const session of tables["plans.plan_sessions"]) await insertJsonRow(client, "plans.plan_sessions", session);
  for (const node of tables["plans.plan_nodes"]) await insertJsonRow(client, "plans.plan_nodes", node);
  for (const item of tables["plans.plan_items"]) await insertJsonRow(client, "plans.plan_items", item);
  for (const tag of tables["library.program_tags"]) await insertJsonRow(client, "library.program_tags", tag);
}

async function deletePlanTree(client, planId) {
  await client.query("delete from plans.plan_items pi using plans.plan_sessions ps, plans.plan_days pd where pi.plan_session_id = ps.id and ps.plan_day_id = pd.id and pd.plan_id = $1", [planId]);
  await client.query("delete from plans.plan_nodes pn using plans.plan_sessions ps, plans.plan_days pd where pn.plan_session_id = ps.id and ps.plan_day_id = pd.id and pd.plan_id = $1", [planId]);
  await client.query("delete from plans.plan_sessions ps using plans.plan_days pd where ps.plan_day_id = pd.id and pd.plan_id = $1", [planId]);
  await client.query("delete from plans.plan_days where plan_id = $1", [planId]);
  await client.query("delete from plans.plans where id = $1", [planId]);
}

async function insertJsonRow(client, table, row) {
  const cols = Object.keys(row);
  await client.query(
    `insert into ${table} (${cols.map((col) => `"${col}"`).join(", ")}) values (${cols.map((_, index) => `$${index + 1}`).join(", ")})`,
    cols.map((col) => row[col]),
  );
}

test("Pankov program migration inserts the full package and is idempotent", async () => {
  await withDatabase(async (client) => {
    const beforeUsers = (await client.query("select count(*)::int c from public.users")).rows[0].c;
    await applyMigration(client);
    assert.deepEqual(await packageCounts(client), {
      plans: 7,
      days: 25,
      sessions: 47,
      exercise_items: 670,
      note_items: 13,
      custom_exercises: 16,
      source_refs: 7,
      all_draft: true,
      all_athlete_101: true,
    });
    const customCount = (await client.query("select count(*)::int c from library.exercises where slug like $1", [`${packageId}:custom:%`])).rows[0].c;
    await applyMigration(client);
    assert.equal((await client.query("select count(*)::int c from library.exercises where slug like $1", [`${packageId}:custom:%`])).rows[0].c, customCount);
    assert.equal((await client.query("select count(*)::int c from public.users")).rows[0].c, beforeUsers);
  });
});

test("Pankov program migration backs up and replaces the expected legacy 2026-07-20 conflict", async () => {
  await withDatabase(async (client) => {
    const legacyId = await makeLegacyConflict(client);
    await applyMigration(client);
    assert.equal((await client.query("select count(*)::int c from plans.plans where id = $1", [legacyId])).rows[0].c, 0);
    assert.equal((await client.query("select count(*)::int c from public.data_migration_backups where original_entity_id = $1", [legacyId])).rows[0].c, 1);
    const week = await client.query("select name, status from plans.plans where source_ref = $1", [`${packageId}:weekly:2026-07-20`]);
    assert.equal(week.rows[0].name, "20.07-26.07.2026");
    assert.equal(week.rows[0].status, "draft");
    await restoreFirstBackup(client);
    const restored = await client.query("select name, status, source_type, source_ref from plans.plans where id = $1", [legacyId]);
    assert.deepEqual(restored.rows[0], { name: "KOmpetitive 2026-07-20", status: "active", source_type: "builder", source_ref: null });
  });
});

test("Pankov program migration rolls back unexpected conflicts and missing prerequisites", async () => {
  await withDatabase(async (client) => {
    await makeLegacyConflict(client, { itemCount: 8 });
    await expectMigrationRejects(client, /unexpected 2026-07-20 conflict signature/);
    assert.equal((await client.query("select count(*)::int c from plans.plans where source_type = $1", [sourceType])).rows[0].c, 0);
    assert.equal((await client.query("select to_regclass('public.data_migration_backups') is not null as exists")).rows[0].exists, false);
  });

  await withDatabase(async (client) => {
    await client.query("delete from public.athletes");
    await expectMigrationRejects(client, /expected exactly one active athlete 101/);
    assert.equal((await client.query("select count(*)::int c from plans.plans where source_type = $1", [sourceType])).rows[0].c, 0);
  });

  await withDatabase(async (client) => {
    await client.query("delete from public.users where email = 'predrag.bozic@rzsport.gov.rs'");
    await expectMigrationRejects(client, /expected exactly one active owner user/);
    assert.equal((await client.query("select count(*)::int c from plans.plans where source_type = $1", [sourceType])).rows[0].c, 0);
  });

  await withDatabase(async (client) => {
    await client.query("delete from library.exercises where exercise_code = '1004'");
    await expectMigrationRejects(client, /required exercise code:1004 was not found/);
    assert.equal((await client.query("select count(*)::int c from plans.plans where source_type = $1", [sourceType])).rows[0].c, 0);
  });
});

test("Pankov program migration rejects a partial package", async () => {
  await withDatabase(async (client) => {
    const coach = (await client.query("select id from public.users where email = 'predrag.bozic@rzsport.gov.rs'")).rows[0];
    const athlete = (await client.query("select id from public.athletes where athlete_id = '101'")).rows[0];
    await client.query(
      "insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, week_start, status, source_type, source_ref) values ('weekly', $1, $2, 'partial', date '2026-06-15', 'draft', $3, $4)",
      [coach.id, athlete.id, sourceType, sourceRefs[0]],
    );
    await expectMigrationRejects(client, /partial package exists/);
    assert.equal((await client.query("select count(*)::int c from plans.plans where source_type = $1", [sourceType])).rows[0].c, 1);
  });
});

test("Pankov program migration is registered in the deploy runner", () => {
  const index = migrationPaths.findIndex((p) => path.basename(p) === "20260818_seed_pankov_programs.sql");
  assert.notEqual(index, -1);
  assert.ok(index > migrationPaths.findIndex((p) => path.basename(p) === "create_reviews_schema.sql"));
});

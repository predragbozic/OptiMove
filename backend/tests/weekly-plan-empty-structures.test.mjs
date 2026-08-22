// Empty domain/category/section visibility in the Weekly Plan calendar.
//
// Root cause: plans.v_weekly_plan_items (create_plan_read_views.sql) was
// built entirely from `plan_items` via an INNER JOIN, so a plan_node with
// zero plan_items contributed zero rows - its name never reached the
// frontend at all, however deep the athlete had nested it. The fix adds a
// second branch (UNION ALL) that emits exactly one row per EMPTY LEAF node
// (a plan_node with no plan_items and no child plan_nodes anywhere under
// it), with item_type set to the node's own node_type
// ('domain'/'category'/'section') and every exercise-specific column null.
// frontend/exercise-view.js's isExerciseItem() already treats that
// item_type as non-exercise organizational content (see
// renderOrganizationSummaryHtml) - this is not a fake/empty exercise, it is
// the row shape the frontend already expects for a structure with nothing
// under it. No frontend change was needed.
//
// Runs entirely against a disposable, uniquely-named temporary database
// (never the app's pool/local OPTIMOVE) with a minimal, hand-written schema
// covering only the tables/columns create_plan_read_views.sql actually
// touches - not a clone of the real database - so this test has no external
// tool dependency (no pg_dump/psql) beyond the `pg` client already used
// throughout this test suite.
import "dotenv/config";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_SQL_PATH = path.resolve(__dirname, "../../create_plan_read_views.sql");

const RUN_ID = crypto.randomBytes(6).toString("hex");
const DB_NAME = `optimove_weekly_empty_structures_test_${RUN_ID}`;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const baseUrl = new URL(process.env.DATABASE_URL);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const dbUrl = new URL(baseUrl);
dbUrl.pathname = `/${DB_NAME}`;
const DATABASE_URL = dbUrl.toString();
if (DB_NAME.toLowerCase() === "optimove" || /monitoring2/i.test(DATABASE_URL)) {
  throw new Error("SAFETY: refusing to run against a forbidden database name");
}

let adminClient;
let client;

const MINIMAL_SCHEMA_SQL = `
  create extension if not exists pgcrypto;

  create schema library;
  create schema plans;

  create table public.clubs (
    id uuid primary key default gen_random_uuid(),
    name character varying not null default 'Test Club'
  );

  create table public.users (
    id uuid primary key default gen_random_uuid(),
    first_name character varying not null,
    last_name character varying not null,
    full_name character varying not null
  );

  create table public.athletes (
    id uuid primary key default gen_random_uuid(),
    athlete_id character varying not null,
    club_id uuid references public.clubs(id),
    first_name character varying not null,
    last_name character varying not null,
    full_name character varying not null,
    image_url text,
    is_active boolean not null default true,
    created_by_user_id uuid references public.users(id),
    source_external_id character varying
  );

  create table library.exercises (
    id uuid primary key default gen_random_uuid(),
    exercise_code character varying,
    name character varying not null
  );

  create table plans.plans (
    id uuid primary key default gen_random_uuid(),
    plan_type character varying not null,
    created_by_user_id uuid not null references public.users(id),
    athlete_id uuid references public.athletes(id),
    name character varying,
    week_start date,
    start_date date,
    duration_days integer,
    program_order numeric,
    status character varying not null default 'draft',
    source_type character varying,
    source_external_id character varying,
    is_active boolean not null default true,
    is_template boolean not null default false,
    is_edit_draft boolean not null default false,
    library_scope character varying not null default 'my',
    library_category character varying,
    cover_image_url text,
    is_free boolean not null default true,
    price_cents integer,
    available_until date,
    owner_type character varying not null default 'coach',
    visibility character varying not null default 'private',
    access_model character varying not null default 'free_forever',
    access_duration_days integer,
    subscription_period character varying,
    can_copy boolean not null default true,
    can_edit_copy boolean not null default true,
    can_assign_to_athlete boolean not null default true,
    athlete_can_view_directly boolean not null default false,
    requires_approval boolean not null default false
  );

  create table plans.plan_days (
    id uuid primary key default gen_random_uuid(),
    plan_id uuid not null references plans.plans(id),
    date date,
    day_note character varying,
    day_order numeric,
    block_index integer,
    block_name character varying,
    block_type character varying,
    block_order numeric
  );

  create table plans.plan_sessions (
    id uuid primary key default gen_random_uuid(),
    plan_day_id uuid not null references plans.plan_days(id),
    am_pm character varying,
    bta character varying,
    session_order numeric,
    session_time time,
    name character varying(120)
  );

  create table plans.plan_nodes (
    id uuid primary key default gen_random_uuid(),
    plan_session_id uuid not null references plans.plan_sessions(id) on delete cascade,
    parent_id uuid references plans.plan_nodes(id) on delete cascade,
    node_type character varying(20) not null check (node_type in ('domain', 'category', 'section')),
    name character varying(255) not null,
    color character varying(32),
    icon_url text,
    short_note text,
    note text,
    node_order numeric not null default 1
  );

  create table plans.plan_items (
    id uuid primary key default gen_random_uuid(),
    plan_session_id uuid not null references plans.plan_sessions(id),
    item_type character varying(30) not null,
    exercise_id uuid references library.exercises(id),
    title character varying(255),
    description text,
    image_url text,
    video_url text,
    sets character varying(80),
    reps character varying(80),
    load character varying(80),
    item_order numeric,
    exercise_order numeric,
    source_row_ref text,
    domain_name character varying(255),
    category_name character varying(255),
    section_name character varying(255),
    domain_color character varying(40),
    category_color character varying(40),
    section_color character varying(40),
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
`;

async function truncateFixtures() {
  await client.query("truncate table plans.plans, public.athletes, public.users, public.clubs restart identity cascade");
}

async function seed() {
  const club = await client.query(`insert into public.clubs (name) values ('Test Club') returning id`);
  const clubId = club.rows[0].id;
  const coach = await client.query(
    `insert into public.users (first_name, last_name, full_name) values ('Test', 'Coach', 'Test Coach') returning id`,
  );
  const coachId = coach.rows[0].id;
  const athlete = await client.query(
    `insert into public.athletes (athlete_id, club_id, first_name, last_name, full_name, created_by_user_id) values ('TEST-001', $1, 'Test', 'Athlete', 'Test Athlete', $2) returning id`,
    [clubId, coachId],
  );
  const athleteId = athlete.rows[0].id;
  const plan = await client.query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, week_start, status) values ('weekly', $1, $2, '2026-08-24', 'active') returning id`,
    [coachId, athleteId],
  );
  const planId = plan.rows[0].id;
  const day = await client.query(`insert into plans.plan_days (plan_id, date, day_order) values ($1, '2026-08-24', 1) returning id`, [planId]);
  const dayId = day.rows[0].id;
  const session = await client.query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, 'AM', 'T', 1) returning id`,
    [dayId],
  );
  const sessionId = session.rows[0].id;
  return { planId, sessionId };
}

async function node(sessionId, type, name, order, parentId = null) {
  const r = await client.query(
    `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, node_order) values ($1, $2, $3, $4, $5) returning id`,
    [sessionId, parentId, type, name, order],
  );
  return r.rows[0].id;
}

// Mirrors backend/src/routes/builder.js's real insert: domain_order/
// category_order/section_order are snapshotted from each ancestor's own
// node_order onto the item, exactly like domain_name/category_name/
// section_name are - a test that omits them (as an earlier version of this
// helper did) produces item rows with those columns null, which is not what
// the real Builder ever writes and made ordering assertions unreliable.
async function realItem(sessionId, nodeId, title, order, { domain, category, section } = {}) {
  await client.query(
    `insert into plans.plan_items (
      plan_session_id, plan_node_id, item_type, title, item_order,
      domain_name, domain_order, category_name, category_order, section_name, section_order
    ) values ($1, $2, 'exercise', $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      sessionId, nodeId, title, order,
      domain?.name ?? null, domain?.order ?? null,
      category?.name ?? null, category?.order ?? null,
      section?.name ?? null, section?.order ?? null,
    ],
  );
}

async function weeklyRows(planId) {
  const r = await client.query(
    `select plan_item_id, item_type, domain_name, category_name, section_name,
            domain_node_id, category_node_id, section_node_id, domain_order, category_order, section_order, title
     from plans.v_weekly_plan_items where plan_id = $1
     order by domain_order, category_order, section_order, item_order`,
    [planId],
  );
  return r.rows;
}

before(async () => {
  adminClient = new pg.Client({ connectionString: adminUrl.toString() });
  await adminClient.connect();
  const cur = await adminClient.query("select current_database() as db");
  assert.equal(cur.rows[0].db, "postgres", "SAFETY: admin connection must be on the postgres database");
  await adminClient.query(`create database "${DB_NAME}"`);

  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const ownCheck = await client.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, DB_NAME, "SAFETY: test connection landed on an unexpected database");

  await client.query(MINIMAL_SCHEMA_SQL);
  const viewsSql = await readFile(VIEWS_SQL_PATH, "utf8");
  await client.query(viewsSql);
});

after(async () => {
  await client.end();
  await adminClient.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`, [DB_NAME]);
  await adminClient.query(`drop database if exists "${DB_NAME}"`);
  await adminClient.end();
});

test("1. an empty domain (no categories, no sections, no items) appears with its own name", async () => {
  await truncateFixtures();
  const { planId, sessionId } = await seed();
  await node(sessionId, "domain", "Recovery", 1);

  const rows = await weeklyRows(planId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_type, "domain");
  assert.equal(rows[0].domain_name, "Recovery");
  assert.equal(rows[0].category_name, null);
  assert.equal(rows[0].section_name, null);
  assert.equal(rows[0].plan_item_id, null, "no plan_item row was created for the empty structure");
});

test("2. an empty category (no sections, no items) under a populated domain appears with domain+category names", async () => {
  await truncateFixtures();
  const { planId, sessionId } = await seed();
  const domainId = await node(sessionId, "domain", "Strength", 1);
  await node(sessionId, "category", "Mobility", 1, domainId);

  const rows = await weeklyRows(planId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_type, "category");
  assert.equal(rows[0].domain_name, "Strength");
  assert.equal(rows[0].category_name, "Mobility");
  assert.equal(rows[0].section_name, null);
});

test("3. an empty section under a populated category appears with the full domain+category+section chain", async () => {
  await truncateFixtures();
  const { planId, sessionId } = await seed();
  const domainId = await node(sessionId, "domain", "Strength", 1);
  const categoryId = await node(sessionId, "category", "Legs", 1, domainId);
  const warmupId = await node(sessionId, "section", "Warm-up", 1, categoryId);
  await node(sessionId, "section", "Cooldown", 2, categoryId); // empty sibling

  await realItem(sessionId, warmupId, "Squat", 1, {
    domain: { name: "Strength", order: 1 },
    category: { name: "Legs", order: 1 },
    section: { name: "Warm-up", order: 1 },
  });

  const rows = await weeklyRows(planId);
  assert.equal(rows.length, 2, "one real item row (Warm-up) + one empty-section placeholder (Cooldown)");

  const cooldown = rows.find((r) => r.section_name === "Cooldown");
  assert.equal(cooldown.item_type, "section");
  assert.equal(cooldown.domain_name, "Strength");
  assert.equal(cooldown.category_name, "Legs");
  assert.equal(cooldown.plan_item_id, null);

  const warmup = rows.find((r) => r.section_name === "Warm-up");
  assert.equal(warmup.item_type, "exercise");
  assert.equal(warmup.title, "Squat");
  assert.notEqual(warmup.plan_item_id, null);
});

test("4. a fully-nested empty chain (empty domain > empty category > empty section) produces exactly ONE row, carrying the full chain, not one row per level", async () => {
  await truncateFixtures();
  const { planId, sessionId } = await seed();
  const domainId = await node(sessionId, "domain", "Massage", 1);
  const categoryId = await node(sessionId, "category", "Therapy", 1, domainId);
  await node(sessionId, "section", "Deep tissue", 1, categoryId);

  const rows = await weeklyRows(planId);
  assert.equal(rows.length, 1, "the domain and category must not ALSO get their own separate placeholder rows");
  assert.equal(rows[0].item_type, "section");
  assert.equal(rows[0].domain_name, "Massage");
  assert.equal(rows[0].category_name, "Therapy");
  assert.equal(rows[0].section_name, "Deep tissue");
});

test("5. structures with exercises are completely unaffected - same rows, same columns, no placeholder mixed in", async () => {
  await truncateFixtures();
  const { planId, sessionId } = await seed();
  const domainId = await node(sessionId, "domain", "Strength", 1);
  const categoryId = await node(sessionId, "category", "Legs", 1, domainId);
  const sectionId = await node(sessionId, "section", "Warm-up", 1, categoryId);
  const ancestry = { domain: { name: "Strength", order: 1 }, category: { name: "Legs", order: 1 }, section: { name: "Warm-up", order: 1 } };
  await realItem(sessionId, sectionId, "Squat", 1, ancestry);
  await realItem(sessionId, sectionId, "Lunge", 2, ancestry);

  const rows = await weeklyRows(planId);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.item_type === "exercise" && r.plan_item_id !== null));
  assert.deepEqual(rows.map((r) => r.title), ["Squat", "Lunge"], "item order within the section is unchanged");
});

test("6. order across empty and non-empty siblings follows domain/category/section node_order, empty structures included in the right position", async () => {
  await truncateFixtures();
  const { planId, sessionId } = await seed();
  const domainId = await node(sessionId, "domain", "Strength", 1);
  const categoryLegsId = await node(sessionId, "category", "Legs", 1, domainId);
  await node(sessionId, "category", "Mobility", 2, domainId); // empty, ordered AFTER Legs
  const sectionId = await node(sessionId, "section", "Warm-up", 1, categoryLegsId);
  await realItem(sessionId, sectionId, "Squat", 1, {
    domain: { name: "Strength", order: 1 },
    category: { name: "Legs", order: 1 },
    section: { name: "Warm-up", order: 1 },
  });

  const rows = await weeklyRows(planId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].category_name, "Legs", "Legs (order 1) must sort before Mobility (order 2)");
  assert.equal(rows[1].category_name, "Mobility");
});

test("7. node ids on placeholder rows point at the actual empty node, not some other node at the same level", async () => {
  await truncateFixtures();
  const { planId, sessionId } = await seed();
  const domainId = await node(sessionId, "domain", "Recovery", 1);

  const rows = await weeklyRows(planId);
  assert.equal(rows[0].domain_node_id, domainId);
});

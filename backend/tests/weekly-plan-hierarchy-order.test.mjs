// Weekly must show exercises in the same order Builder does: real
// hierarchical position (root nodes -> domain -> category -> section ->
// exercises), not the item_order column alone.
//
// Root cause (confirmed live, reported against a real plan): item_order on
// plans.plan_items is a session-wide INSERTION-sequence counter (see
// nextOrder() in backend/src/routes/builder.js, scoped by plan_session_id -
// not by plan_node_id), so two items added to the session in a different
// order than their sections were later arranged end up sorted wrong by a
// flat `order by item_order`. Moving a section in Builder only updates
// plans.plan_nodes.node_order (the live tree Builder's own read path,
// buildDraft(), already orders by correctly) - it never touches the
// domain_order/category_order/section_order snapshot columns already
// sitting on plan_items rows, so those go stale the moment a sibling moves.
//
// Fix: migrations_v2/202608231000_weekly_plan_items_hierarchy_order.sql
// (mirrored in create_plan_read_views.sql, the file this test applies)
// adds plans.v_plan_node_sort_path (each node's live root-to-leaf
// node_order path as a numeric[]) and orders plans.v_weekly_plan_items by
// it ahead of item_order.
//
// Runs entirely against a disposable, uniquely-named temporary database
// (never OPTIMOVE/monitoring2), with a hand-written schema matching the
// established pattern in weekly-plan-empty-structures.test.mjs, and applies
// the REAL create_plan_read_views.sql file - not a hand-simulated view.
import "dotenv/config";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_SQL_PATH = path.resolve(__dirname, "../../create_plan_read_views.sql");
const MIGRATION_SQL_PATH = path.resolve(__dirname, "../../migrations_v2/202608231000_weekly_plan_items_hierarchy_order.sql");
// v_weekly_plan_items itself was touched again after 202608231000 (session
// name + draft-hidden-from-calendar) - the bootstrap file's CURRENT
// v_weekly_plan_items definition reflects that later migration, not this
// one, so test "0" below compares that specific view against ITS latest
// source instead. v_plan_node_sort_path (also defined by 202608231000) was
// never touched again, so it still compares against MIGRATION_SQL_PATH.
const LATEST_WEEKLY_VIEW_MIGRATION_SQL_PATH = path.resolve(__dirname, "../../migrations_v2/202608231700_weekly_calendar_draft_hidden_and_session_name.sql");

const RUN_ID = crypto.randomBytes(6).toString("hex");
const DB_NAME = `optimove_weekly_hierarchy_order_test_${RUN_ID}`;

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

let coachId;
let athleteId;

async function seedWeeklyPlan({ weekStart = "2026-08-17", date = "2026-08-22", dayOrder = 6 } = {}) {
  const plan = await client.query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, week_start, status) values ('weekly', $1, $2, $3, $4, 'active') returning id`,
    [coachId, athleteId, `plan for ${date}`, weekStart],
  );
  const planId = plan.rows[0].id;
  const day = await client.query(
    `insert into plans.plan_days (plan_id, date, day_order) values ($1, $2, $3) returning id`,
    [planId, date, dayOrder],
  );
  const session = await client.query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, 'AM', 'T', 1) returning id`,
    [day.rows[0].id],
  );
  return { planId, sessionId: session.rows[0].id };
}

async function addNode(sessionId, { type, name, parentId = null, order }) {
  const r = await client.query(
    `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, node_order) values ($1,$2,$3,$4,$5) returning id`,
    [sessionId, parentId, type, name, order],
  );
  return r.rows[0].id;
}

async function addItem(sessionId, nodeId, { title, itemOrder }) {
  await client.query(
    `insert into plans.plan_items (plan_session_id, plan_node_id, item_type, title, item_order) values ($1,$2,'exercise',$3,$4)`,
    [sessionId, nodeId, title, itemOrder],
  );
}

async function weeklyTitles(planId) {
  // Mirrors the real consumer queries' own final ORDER BY exactly
  // (backend/src/routes/athletes.js's loadWeeklyData, backend/src/routes/plans.js's
  // GET /:planId/weekly) - a `select *` from a view is not guaranteed
  // pre-sorted, so both this test and the real consumers re-apply it.
  const r = await client.query(
    `select coalesce(title, initcap(item_type)) as label
     from plans.v_weekly_plan_items
     where plan_id = $1
     order by date, day_order, session_order, hierarchy_sort_path, item_order, plan_item_id, plan_node_id`,
    [planId],
  );
  return r.rows.map((row) => row.label);
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

  const coach = await client.query(`insert into public.users (first_name, last_name, full_name) values ('Test','Coach','Test Coach') returning id`);
  coachId = coach.rows[0].id;
  const athlete = await client.query(
    `insert into public.athletes (athlete_id, first_name, last_name, full_name, created_by_user_id) values ('101','Radovan','Pankov','Radovan Pankov',$1) returning id`,
    [coachId],
  );
  athleteId = athlete.rows[0].id;
});

after(async () => {
  await client.end();
  await adminClient.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`, [DB_NAME]);
  await adminClient.query(`drop database if exists "${DB_NAME}"`);
  await adminClient.end();
});

test("0. sanity: create_plan_read_views.sql and the new migration define the SAME v_plan_node_sort_path / v_weekly_plan_items SQL (byte-identical modulo line endings, matching the migration file's own claim)", async () => {
  // \r\n-normalized rather than a strict byte comparison - Windows git
  // checkouts (core.autocrlf) can legitimately convert one file's line
  // endings without touching the other's, which would make a literal byte
  // comparison flaky across environments despite the SQL content genuinely
  // being identical.
  const normalize = (text) => text.replace(/\r\n/g, "\n");
  const bootstrap = normalize(await readFile(VIEWS_SQL_PATH, "utf8"));
  const migration = normalize(await readFile(MIGRATION_SQL_PATH, "utf8"));
  const latestWeeklyViewMigration = normalize(await readFile(LATEST_WEEKLY_VIEW_MIGRATION_SQL_PATH, "utf8"));
  const extract = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `${startMarker} must exist`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end >= 0, `${endMarker} must exist after ${startMarker}`);
    return source.slice(start, end);
  };
  const bootstrapSortPath = extract(bootstrap, "create or replace view plans.v_plan_node_sort_path", "create or replace view plans.v_weekly_plan_items");
  const migrationSortPath = extract(migration, "create or replace view plans.v_plan_node_sort_path", "create or replace view plans.v_weekly_plan_items");
  assert.equal(migrationSortPath, bootstrapSortPath);

  const bootstrapWeekly = extract(bootstrap, "create or replace view plans.v_weekly_plan_items", "create or replace view plans.v_program_plan_items");
  const latestMigrationWeekly = latestWeeklyViewMigration.slice(latestWeeklyViewMigration.indexOf("create or replace view plans.v_weekly_plan_items"));
  assert.equal(latestMigrationWeekly.trim(), bootstrapWeekly.trim());
});

test("1+2. five sections directly under the session (no domain/category), each with one exercise added in a DIFFERENT order than the sections - Weekly must still show them in section order", async () => {
  const { planId, sessionId } = await seedWeeklyPlan();
  const names = ["Bike", "Izo protocol", "Ice bath", "Compressive pants", "Compressive leggings"];
  const nodeIds = [];
  for (let i = 0; i < names.length; i++) {
    nodeIds.push(await addNode(sessionId, { type: "section", name: names[i], order: i + 1 }));
  }
  // Add items in a shuffled order relative to the sections themselves -
  // item_order (global insertion sequence) will NOT match section order.
  const insertSequence = [0, 1, 3, 2, 4]; // Bike, Izo protocol, Compressive pants, Ice bath, Compressive leggings
  for (let i = 0; i < insertSequence.length; i++) {
    const sectionIndex = insertSequence[i];
    await addItem(sessionId, nodeIds[sectionIndex], { title: `${names[sectionIndex]} exercise`, itemOrder: i + 1 });
  }

  const titles = await weeklyTitles(planId);
  assert.deepEqual(titles, names.map((n) => `${n} exercise`), "Weekly must follow the sections' real node_order, not the items' insertion order");
});

test("3. moving Ice bath above Compressive pants (swapping their node_order, exactly like Builder's move-up/down) reorders Weekly to match", async () => {
  const { planId, sessionId } = await seedWeeklyPlan({ date: "2026-08-23", dayOrder: 7 });
  const iceBath = await addNode(sessionId, { type: "section", name: "Ice bath", order: 1 });
  const pants = await addNode(sessionId, { type: "section", name: "Compressive pants", order: 2 });
  await addItem(sessionId, pants, { title: "Compressive pants exercise", itemOrder: 1 });
  await addItem(sessionId, iceBath, { title: "Ice bath exercise", itemOrder: 2 });

  const before = await weeklyTitles(planId);
  assert.deepEqual(before, ["Ice bath exercise", "Compressive pants exercise"]);

  // Swap node_order the same way backend/src/routes/builder.js's move-node
  // handler does (swap the two neighbors' node_order values) - simulates
  // dragging Compressive pants above Ice bath in Builder.
  await client.query(`update plans.plan_nodes set node_order = case when id = $1 then 2 when id = $2 then 1 end where id in ($1, $2)`, [iceBath, pants]);

  const after = await weeklyTitles(planId);
  assert.deepEqual(after, ["Compressive pants exercise", "Ice bath exercise"], "Weekly must reflect the moved node_order - the stale section_order snapshot on the already-existing items must not win");
});

test("4. Weekly's item order matches exactly the order Builder's own buildDraft() query would produce (pn.node_order, pi.item_order)", async () => {
  const { planId, sessionId } = await seedWeeklyPlan({ date: "2026-08-24", dayOrder: 1 });
  const sectionA = await addNode(sessionId, { type: "section", name: "A", order: 2 });
  const sectionB = await addNode(sessionId, { type: "section", name: "B", order: 1 });
  await addItem(sessionId, sectionA, { title: "A1", itemOrder: 10 });
  await addItem(sessionId, sectionA, { title: "A2", itemOrder: 11 });
  await addItem(sessionId, sectionB, { title: "B1", itemOrder: 1 });

  // Exactly Builder's own ORDER BY (backend/src/routes/builder.js buildDraft()):
  // "pn.node_order nulls last, pi.item_order nulls last".
  const builderOrder = await client.query(
    `select pi.title
     from plans.plan_items pi
     join plans.plan_nodes pn on pn.id = pi.plan_node_id
     where pi.plan_session_id = $1
     order by pn.node_order nulls last, pi.item_order nulls last`,
    [sessionId],
  );
  const weeklyOrder = await weeklyTitles(planId);
  assert.deepEqual(weeklyOrder, builderOrder.rows.map((r) => r.title));
  assert.deepEqual(weeklyOrder, ["B1", "A1", "A2"]);
});

test("5. a mix of empty and populated sections interleave at their correct real positions, not all pushed to the end", async () => {
  const { planId, sessionId } = await seedWeeklyPlan({ date: "2026-08-25", dayOrder: 2 });
  const s1 = await addNode(sessionId, { type: "section", name: "Warm-up", order: 1 });
  const s2 = await addNode(sessionId, { type: "section", name: "Empty middle", order: 2 }); // stays empty
  const s3 = await addNode(sessionId, { type: "section", name: "Main", order: 3 });
  await addItem(sessionId, s1, { title: "Jog", itemOrder: 1 });
  await addItem(sessionId, s3, { title: "Squat", itemOrder: 2 });
  void s2;

  const titles = await weeklyTitles(planId);
  assert.deepEqual(titles, ["Jog", "Section", "Squat"], "the empty section's placeholder row (item_type='section', no title) must sit BETWEEN Jog and Squat, not after both");
});

test("6. Domain -> Category -> Section hierarchy orders correctly across multiple domains/categories", async () => {
  const { planId, sessionId } = await seedWeeklyPlan({ date: "2026-08-26", dayOrder: 3 });
  const domainB = await addNode(sessionId, { type: "domain", name: "Domain B", order: 2 });
  const domainA = await addNode(sessionId, { type: "domain", name: "Domain A", order: 1 });
  const catA1 = await addNode(sessionId, { type: "category", name: "Cat A1", parentId: domainA, order: 1 });
  const catB1 = await addNode(sessionId, { type: "category", name: "Cat B1", parentId: domainB, order: 1 });
  const secA1a = await addNode(sessionId, { type: "section", name: "Sec A1a", parentId: catA1, order: 1 });
  const secB1a = await addNode(sessionId, { type: "section", name: "Sec B1a", parentId: catB1, order: 1 });

  // Insert items in reverse hierarchy order (Domain B's item first) to
  // prove ordering comes from the live tree, not insertion sequence.
  await addItem(sessionId, secB1a, { title: "B-exercise", itemOrder: 1 });
  await addItem(sessionId, secA1a, { title: "A-exercise", itemOrder: 2 });

  const titles = await weeklyTitles(planId);
  assert.deepEqual(titles, ["A-exercise", "B-exercise"], "Domain A (node_order=1) must come before Domain B (node_order=2), regardless of insertion order");
});

test("7. a deterministic final tie-breaker: two items with the EXACT SAME item_order under the same section never produce a different order across repeated queries", async () => {
  const { planId, sessionId } = await seedWeeklyPlan({ date: "2026-08-27", dayOrder: 4 });
  const section = await addNode(sessionId, { type: "section", name: "Tied", order: 1 });
  await addItem(sessionId, section, { title: "Tie X", itemOrder: 5 });
  await addItem(sessionId, section, { title: "Tie Y", itemOrder: 5 });

  const first = await weeklyTitles(planId);
  const second = await weeklyTitles(planId);
  const third = await weeklyTitles(planId);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.deepEqual(new Set(first), new Set(["Tie X", "Tie Y"]));
});

test("8. no artificial limit on domains/categories/sections/exercises per session - 12 sections with 6 exercises each all come back, in order", async () => {
  const { planId, sessionId } = await seedWeeklyPlan({ date: "2026-08-28", dayOrder: 5 });
  const sectionCount = 12;
  const itemsPerSection = 6;
  let itemOrderCounter = 1;
  const expectedTitles = [];
  for (let s = 0; s < sectionCount; s++) {
    const nodeId = await addNode(sessionId, { type: "section", name: `Section ${s}`, order: s + 1 });
    for (let i = 0; i < itemsPerSection; i++) {
      const title = `S${s}-item${i}`;
      await addItem(sessionId, nodeId, { title, itemOrder: itemOrderCounter++ });
      expectedTitles.push(title);
    }
  }
  const titles = await weeklyTitles(planId);
  assert.equal(titles.length, sectionCount * itemsPerSection, "every single row must come back - no LIMIT anywhere truncates the result");
  assert.deepEqual(titles, expectedTitles);
});

// ==================================================================
// Migration mechanics: the new migration applies through the real Strategy
// B runner (backend/src/migrate.js), coexists with the already-applied
// 202608211200 migration (never edited - see the "does not touch" note in
// its own header comment above), and is idempotent. Separate disposable DB
// from the functional tests above - a fresh legacy-fingerprint fixture is
// needed for the runner's own preconditions, unrelated to hierarchy-order
// scenario data.
// ==================================================================
const LEGACY_FIXTURE_SQL = `
  create table public.clubs (id uuid primary key default gen_random_uuid());
  create table public.teams (id uuid primary key default gen_random_uuid(), club_id uuid references public.clubs(id));
  alter table public.teams add constraint teams_id_club_id_unique unique (id, club_id);
  create table public.users (id uuid primary key default gen_random_uuid());
  create table public.athletes (id uuid primary key default gen_random_uuid(), athlete_id text, source_external_id text, full_name text, image_url text);
  create table public.user_global_roles (id uuid primary key default gen_random_uuid(), revoked_at timestamptz);
  create table public.athlete_memberships (id uuid primary key default gen_random_uuid());
  create table public.athlete_invites (id uuid primary key default gen_random_uuid(), context_type text);
  create table public.account_email_change_tokens (id uuid primary key default gen_random_uuid());

  create schema library;
  create table library.exercises (id uuid primary key default gen_random_uuid(), exercise_code text, name text);

  create schema plans;
  create table plans.plans (id uuid primary key default gen_random_uuid(), plan_type text, week_start date, is_active boolean default true, is_edit_draft boolean default false, athlete_id uuid, name text);
  create table plans.plan_days (id uuid primary key default gen_random_uuid(), plan_id uuid references plans.plans(id), date date, day_note text, day_order numeric);
  create table plans.plan_sessions (id uuid primary key default gen_random_uuid(), plan_day_id uuid references plans.plan_days(id), am_pm text, bta text, session_order numeric, session_time time);
  create table plans.plan_items (id uuid primary key default gen_random_uuid(), plan_session_id uuid references plans.plan_sessions(id), item_type text, plan_node_id uuid, item_order numeric, domain_order numeric, category_order numeric, section_order numeric, exercise_order numeric, domain_name text, category_name text, section_name text, domain_color text, category_color text, section_color text, domain_icon_url text, category_icon_url text, section_icon_url text, domain_short_note text, category_short_note text, section_short_note text, domain_note text, category_note text, section_note text, title text, description text, image_url text, video_url text, sets text, reps text, load text, exercise_id uuid, source_row_ref text);
  create table plans.plan_nodes (id uuid primary key default gen_random_uuid(), plan_session_id uuid references plans.plan_sessions(id), parent_id uuid references plans.plan_nodes(id), node_type text, name text, color text, icon_url text, short_note text, note text, node_order numeric);
  create view plans.v_plan_summary as select id from plans.plans;
  create view plans.v_plan_item_node_ancestry as select id as plan_node_id, null::uuid as domain_node_id, null::uuid as category_node_id, null::uuid as section_node_id from plans.plan_nodes;
  create view plans.v_weekly_plan_items as select id as plan_id from plans.plan_items;
  create view plans.v_program_plan_items as select id as plan_id from plans.plan_items;
`;

async function makeMigrationTestDb(label) {
  const name = `optimove_weekly_order_migration_${label}_${crypto.randomBytes(6).toString("hex")}`;
  const url = dbUrl.href.replace(`/${DB_NAME}`, `/${name}`);
  if (name.toLowerCase() === "optimove" || /monitoring2/i.test(url)) throw new Error("SAFETY: refusing forbidden db name");
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  await admin.end();
  return { name, url };
}
async function dropMigrationTestDb({ name }) {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`, [name]);
  await admin.query(`drop database if exists "${name}"`);
  await admin.end();
}

test("9. the migration applies through the real runMigrations(), after the already-applied empty-structures migration, and is idempotent on re-run", async () => {
  const db = await makeMigrationTestDb("mechanics");
  const c = new pg.Client({ connectionString: db.url });
  const priorMigrationSql = await readFile(path.resolve(__dirname, "../../migrations_v2/202608211200_weekly_plan_items_empty_structures.sql"), "utf8");
  const newMigrationSql = await readFile(MIGRATION_SQL_PATH, "utf8");
  const dir = path.resolve(__dirname, `weekly_order_migrations_${crypto.randomBytes(4).toString("hex")}`);
  try {
    await c.connect();
    await c.query(LEGACY_FIXTURE_SQL);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "202608211200_weekly_plan_items_empty_structures.sql"), priorMigrationSql, "utf8");
    await fsp.writeFile(path.join(dir, "202608231000_weekly_plan_items_hierarchy_order.sql"), newMigrationSql, "utf8");

    await runner.runMigrations({ databaseUrl: db.url, migrationsRoot: dir });
    const applied = await c.query(
      `select migration_name from public.schema_migrations where migration_name like $1 order by migration_name`,
      [`${path.basename(dir)}/%`],
    );
    assert.equal(applied.rowCount, 2, "both migrations must be recorded");

    const kind = await c.query(
      `select relkind from pg_class cl join pg_namespace n on n.oid=cl.relnamespace where n.nspname='plans' and cl.relname='v_plan_node_sort_path'`,
    );
    assert.equal(kind.rows[0]?.relkind, "v", "the new helper view must exist after migration");

    // Idempotent re-run: both skip (checksum match), no error, no duplicate rows.
    await runner.runMigrations({ databaseUrl: db.url, migrationsRoot: dir });
    const stillTwo = await c.query(
      `select count(*) c from public.schema_migrations where migration_name like $1`,
      [`${path.basename(dir)}/%`],
    );
    assert.equal(stillTwo.rows[0].c, "2");
  } finally {
    await c.end();
    await fsp.rm(dir, { recursive: true, force: true });
    await dropMigrationTestDb(db);
  }
});

test("10. the new migration file contains no top-level transaction-control statements (BEGIN/COMMIT/ROLLBACK)", async () => {
  const sql = await readFile(MIGRATION_SQL_PATH, "utf8");
  assert.doesNotThrow(() => runner.assertNoTransactionControl(sql, "202608231000_weekly_plan_items_hierarchy_order.sql"));
});

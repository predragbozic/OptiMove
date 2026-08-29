// Regression guard for the Builder N+1 tree-copy fix (backend/src/routes/
// builder.js's copySessionContent(), which replaced the recursive
// copyNodeTreeWithClient()/copyPlanItem() pair that copyProgramTree(),
// copyWeeklyPlanTree(), and POST /blocks/:blockId/copy all used).
//
// The old code issued one round-trip per node PLUS one round-trip per item,
// recursively - copying a program's whole node/item tree (which happens on
// every "open an existing program for editing" via POST /plans/:planId/edit,
// and again on every "save"/"re-save" via submit -> applyEditDraft, which
// copies the draft tree back onto the original) scaled linearly with how
// much content the program had. copySessionContent() instead inserts nodes
// level-by-level and items in one shot, in a small, CONSTANT number of
// batched round-trips regardless of how many domains/categories/sections/
// exercises exist.
//
// This asserts that constant-ish bound directly (query count stays low even
// as the fixture size grows substantially), rather than a specific
// millisecond budget, which would be flaky across machines/CI. See the PR
// description for the actual before/after measurement this fix was based on
// (2737 -> 97 queries, 889.8ms -> 157.5ms wall time, on a 324-node/
// 1080-item program on this dev machine).
//
// Runs entirely against a disposable, uniquely-named temporary database
// (never the app's pool/local OPTIMOVE), with the same minimal hand-written
// schema used by weekly-plan-empty-structures.test.mjs.
import "dotenv/config";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { copySessionContent, copyProgramTree, copyDaySessions } from "../src/routes/builder.js";

const RUN_ID = crypto.randomBytes(6).toString("hex");
const DB_NAME = `optimove_builder_copy_perf_test_${RUN_ID}`;

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
  create table plans.plan_days (
    id uuid primary key default gen_random_uuid(),
    plan_id uuid not null,
    date date,
    day_note text,
    day_order numeric,
    block_index numeric,
    block_name character varying(255),
    block_type character varying(20),
    block_order numeric
  );

  create table plans.plan_sessions (
    id uuid primary key default gen_random_uuid(),
    label text,
    plan_day_id uuid references plans.plan_days(id) on delete cascade,
    am_pm character varying(4),
    bta character varying(4),
    session_order numeric,
    name character varying(255),
    rpe_enabled boolean not null default true
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
  create index plan_nodes_session_order_idx on plans.plan_nodes (plan_session_id, parent_id, node_order);

  create table plans.plan_items (
    id uuid primary key default gen_random_uuid(),
    plan_session_id uuid not null references plans.plan_sessions(id),
    item_type character varying(30) not null,
    exercise_id uuid,
    title character varying(255),
    description text,
    short_note text,
    note text,
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
  create index plan_items_plan_node_order_idx on plans.plan_items (plan_node_id, item_order);
`;

// Wraps pgClient.query for the duration of fn(), counting calls, then
// always restores the original - so counting one call never leaks into the
// next (unwrapped query methods stacking on top of each other would still
// produce a correct count, since each layer ultimately calls the real
// query exactly once, but leaving client.query permanently wrapped after
// the first use is needless and confusing).
async function countQueriesDuring(pgClient, fn) {
  let count = 0;
  const originalQuery = pgClient.query.bind(pgClient);
  pgClient.query = (...args) => {
    count += 1;
    return originalQuery(...args);
  };
  try {
    await fn();
  } finally {
    pgClient.query = originalQuery;
  }
  return count;
}

async function buildTree(sessionId, { domains, categoriesPerDomain, sectionsPerCategory, exercisesPerSection }) {
  for (let d = 1; d <= domains; d++) {
    const domain = await client.query(
      `insert into plans.plan_nodes (plan_session_id, node_type, name, node_order) values ($1,'domain',$2,$3) returning id`,
      [sessionId, `Domain ${d}`, d],
    );
    for (let c = 1; c <= categoriesPerDomain; c++) {
      const category = await client.query(
        `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, node_order) values ($1,$2,'category',$3,$4) returning id`,
        [sessionId, domain.rows[0].id, `Category ${d}.${c}`, c],
      );
      for (let s = 1; s <= sectionsPerCategory; s++) {
        const section = await client.query(
          `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, node_order) values ($1,$2,'section',$3,$4) returning id`,
          [sessionId, category.rows[0].id, `Section ${d}.${c}.${s}`, s],
        );
        for (let e = 1; e <= exercisesPerSection; e++) {
          await client.query(
            `insert into plans.plan_items (plan_session_id, plan_node_id, item_type, title, item_order, domain_name, domain_order, category_name, category_order, section_name, section_order)
             values ($1,$2,'exercise',$3,$4,$5,$6,$7,$8,$9,$10)`,
            [sessionId, section.rows[0].id, `Exercise ${e}`, e, `Domain ${d}`, d, `Category ${d}.${c}`, c, `Section ${d}.${c}.${s}`, s],
          );
        }
      }
    }
  }
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

  await client.query("create schema plans");
  await client.query(MINIMAL_SCHEMA_SQL);
});

after(async () => {
  await client.end();
  await adminClient.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`, [DB_NAME]);
  await adminClient.query(`drop database if exists "${DB_NAME}"`);
  await adminClient.end();
});

test("copySessionContent(): query count does not scale linearly with node/item count", async () => {
  const smallSession = (await client.query(`insert into plans.plan_sessions (label) values ('small') returning id`)).rows[0].id;
  await buildTree(smallSession, { domains: 1, categoriesPerDomain: 1, sectionsPerCategory: 1, exercisesPerSection: 2 }); // 3 nodes, 2 items
  const smallTarget = (await client.query(`insert into plans.plan_sessions (label) values ('small-target') returning id`)).rows[0].id;
  const smallQueries = await countQueriesDuring(client, () => copySessionContent(client, smallSession, smallTarget));

  const largeSession = (await client.query(`insert into plans.plan_sessions (label) values ('large') returning id`)).rows[0].id;
  await buildTree(largeSession, { domains: 4, categoriesPerDomain: 3, sectionsPerCategory: 3, exercisesPerSection: 6 }); // 4+12+36=52 nodes, 216 items
  const largeTarget = (await client.query(`insert into plans.plan_sessions (label) values ('large-target') returning id`)).rows[0].id;
  const largeCount = await countQueriesDuring(client, () => copySessionContent(client, largeSession, largeTarget));

  // The old, replaced algorithm issued roughly (1 + 1 + itemCount + 1) per
  // node plus its own recursion - for 52 nodes / 216 items that was on the
  // order of 52*3 + 216 ~= 370+ queries. The batched version issues one
  // query per node LEVEL (domain, category, section = 3) plus one for items
  // plus the initial node fetch - a small constant, independent of how many
  // nodes/items exist at each level.
  assert.ok(largeCount <= 10, `expected a small constant number of queries regardless of tree size, got ${largeCount} for 52 nodes/216 items`);
  assert.equal(largeCount, smallQueries, "query count for a 1-node/2-item tree and a 52-node/216-item tree must be identical - proof the cost is per LEVEL, not per node or per item");

  const verify = await client.query(
    `select (select count(*) from plans.plan_nodes where plan_session_id=$1) as nodes, (select count(*) from plans.plan_items where plan_session_id=$1) as items`,
    [largeTarget],
  );
  assert.equal(verify.rows[0].nodes, "52");
  assert.equal(verify.rows[0].items, "216");
});

test("copySessionContent(): correctly falls back to copyLegacySession() behavior (no node tree) by doing nothing when the session has no nodes", async () => {
  const emptySession = (await client.query(`insert into plans.plan_sessions (label) values ('no-nodes') returning id`)).rows[0].id;
  const target = (await client.query(`insert into plans.plan_sessions (label) values ('no-nodes-target') returning id`)).rows[0].id;
  await assert.doesNotReject(() => copySessionContent(client, emptySession, target));
  const nodeCount = await client.query(`select count(*) c from plans.plan_nodes where plan_session_id=$1`, [target]);
  assert.equal(nodeCount.rows[0].c, "0");
});

// Regression guard for the "Step 1" performance fix: copyProgramTree() used
// to INSERT one day at a time, and for EACH day query then INSERT one
// session at a time - a multi-week program's "open for editing"/"save"
// path meant one sequential awaited query per day PLUS one per session,
// before a single node/item was ever copied (the dominant cost behind
// Edit/Copy taking 5-10s to open the Builder on a large program). It now
// batch-inserts every day, then every session across every one of those
// days, in two round trips total, regardless of day/session count.
async function buildDays(planId, dayCount, sessionsPerDay) {
  for (let d = 1; d <= dayCount; d++) {
    const day = await client.query(
      `insert into plans.plan_days (plan_id, day_order, block_index, block_order) values ($1,$2,$3,$4) returning id`,
      [planId, d, d, d],
    );
    for (let s = 1; s <= sessionsPerDay; s++) {
      await client.query(
        `insert into plans.plan_sessions (plan_day_id, am_pm, session_order, name) values ($1,$2,$3,$4)`,
        [day.rows[0].id, s % 2 === 0 ? "PM" : "AM", s, `Session ${d}.${s}`],
      );
    }
  }
}

// Each session copyProgramTree/copyDaySessions creates still gets its own
// copySessionContent() call (that function's own already-constant
// per-session cost, proven separately above, is untouched by this fix) -
// so the query count for the SKELETON build (day/session rows themselves)
// is isolated below by subtracting exactly that many session-content
// copies' worth of queries, measured empirically against a real
// content-less session rather than hard-coded, so this stays correct even
// if copySessionContent's own internals change later.
async function measurePerSessionContentCost() {
  const source = (await client.query(`insert into plans.plan_sessions (label) values ('baseline') returning id`)).rows[0].id;
  const target = (await client.query(`insert into plans.plan_sessions (label) values ('baseline-target') returning id`)).rows[0].id;
  return countQueriesDuring(client, () => copySessionContent(client, source, target));
}

test("copyProgramTree(): the day/session skeleton's own query count does not scale with day/session count", async () => {
  const perSessionCost = await measurePerSessionContentCost();

  const smallPlan = crypto.randomUUID();
  const smallTargetPlan = crypto.randomUUID();
  await buildDays(smallPlan, 1, 1); // 1 day, 1 session
  const smallCount = await countQueriesDuring(client, () => copyProgramTree(client, smallPlan, smallTargetPlan));

  const largePlan = crypto.randomUUID();
  const largeTargetPlan = crypto.randomUUID();
  await buildDays(largePlan, 12, 4); // 12 days, 4 sessions/day = 48 sessions
  const largeCount = await countQueriesDuring(client, () => copyProgramTree(client, largePlan, largeTargetPlan));

  const smallSkeletonCost = smallCount - perSessionCost * 1;
  const largeSkeletonCost = largeCount - perSessionCost * 48;
  assert.ok(smallSkeletonCost <= 4, `expected a small constant skeleton cost, got ${smallSkeletonCost}`);
  assert.equal(largeSkeletonCost, smallSkeletonCost, "the day/session skeleton's own query count (days query+insert, sessions query+insert) must be identical for a 1-day/1-session program and a 12-day/48-session program - proof it no longer scales per day or per session");

  const verify = await client.query(
    `select (select count(*) from plans.plan_days where plan_id=$1) as days,
            (select count(*) from plans.plan_sessions ps join plans.plan_days pd on pd.id=ps.plan_day_id where pd.plan_id=$1) as sessions`,
    [largeTargetPlan],
  );
  assert.equal(verify.rows[0].days, "12");
  assert.equal(verify.rows[0].sessions, "48");
});

test("copyDaySessions(): the session-batch's own query count does not scale with session count", async () => {
  const perSessionCost = await measurePerSessionContentCost();

  const smallDay = (await client.query(`insert into plans.plan_days (plan_id) values ($1) returning id`, [crypto.randomUUID()])).rows[0].id;
  await client.query(`insert into plans.plan_sessions (plan_day_id, am_pm, session_order) values ($1,'AM',1)`, [smallDay]);
  const smallTarget = (await client.query(`insert into plans.plan_days (plan_id) values ($1) returning id`, [crypto.randomUUID()])).rows[0].id;
  const smallCount = await countQueriesDuring(client, () => copyDaySessions(client, smallDay, smallTarget));

  const largeDay = (await client.query(`insert into plans.plan_days (plan_id) values ($1) returning id`, [crypto.randomUUID()])).rows[0].id;
  for (let s = 1; s <= 20; s++) {
    await client.query(`insert into plans.plan_sessions (plan_day_id, am_pm, session_order) values ($1,$2,$3)`, [largeDay, s % 2 === 0 ? "PM" : "AM", s]);
  }
  const largeTarget = (await client.query(`insert into plans.plan_days (plan_id) values ($1) returning id`, [crypto.randomUUID()])).rows[0].id;
  const largeCount = await countQueriesDuring(client, () => copyDaySessions(client, largeDay, largeTarget));

  const smallSkeletonCost = smallCount - perSessionCost * 1;
  const largeSkeletonCost = largeCount - perSessionCost * 20;
  assert.ok(smallSkeletonCost <= 2, `expected a small constant skeleton cost, got ${smallSkeletonCost}`);
  assert.equal(largeSkeletonCost, smallSkeletonCost, "the session batch's own query count (sessions query+insert) must be identical for a 1-session day and a 20-session day - proof it no longer scales per session");

  const verify = await client.query(`select count(*) c from plans.plan_sessions where plan_day_id=$1`, [largeTarget]);
  assert.equal(verify.rows[0].c, "20");
});

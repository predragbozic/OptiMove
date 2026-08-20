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
import { copySessionContent } from "../src/routes/builder.js";

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
  create table plans.plan_sessions (
    id uuid primary key default gen_random_uuid(),
    label text
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

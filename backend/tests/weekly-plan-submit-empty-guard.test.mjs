// Regression guard: submitting a weekly plan must not treat it as "empty"
// (and silently delete it - see removeEmptyDraftOnSubmit in
// backend/src/routes/builder.js) just because it has no plan_items. A plan
// consisting solely of organizational structure - an empty "Massage"
// domain, an empty category, an empty section - represents a real planning
// decision by the coach and must survive a submit exactly like a plan with
// real exercises does. Only a plan with neither a real plan_item nor a
// meaningfully-named plan_node counts as empty.
//
// planHasWeeklyTrainingContentWithClient() is the exact function
// removeEmptyDraftOnSubmit() calls to decide this - tested directly here
// (exported from backend/src/routes/builder.js for this purpose) against a
// disposable, uniquely-named temporary database (never the app's pool/local
// OPTIMOVE), with a minimal hand-written schema.
import "dotenv/config";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { planHasWeeklyTrainingContentWithClient } from "../src/routes/builder.js";

const RUN_ID = crypto.randomBytes(6).toString("hex");
const DB_NAME = `optimove_weekly_submit_guard_test_${RUN_ID}`;

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
  create schema plans;

  create table public.users (
    id uuid primary key default gen_random_uuid(),
    first_name character varying not null,
    last_name character varying not null,
    full_name character varying not null
  );

  create table plans.plans (
    id uuid primary key default gen_random_uuid(),
    plan_type character varying not null,
    created_by_user_id uuid not null references public.users(id),
    status character varying not null default 'draft'
  );

  create table plans.plan_days (
    id uuid primary key default gen_random_uuid(),
    plan_id uuid not null references plans.plans(id),
    date date,
    day_order numeric
  );

  create table plans.plan_sessions (
    id uuid primary key default gen_random_uuid(),
    plan_day_id uuid not null references plans.plan_days(id),
    am_pm character varying,
    bta character varying,
    session_order numeric
  );

  create table plans.plan_nodes (
    id uuid primary key default gen_random_uuid(),
    plan_session_id uuid not null references plans.plan_sessions(id) on delete cascade,
    parent_id uuid references plans.plan_nodes(id) on delete cascade,
    node_type character varying(20) not null check (node_type in ('domain', 'category', 'section')),
    name character varying(255) not null,
    node_order numeric not null default 1
  );

  create table plans.plan_items (
    id uuid primary key default gen_random_uuid(),
    plan_session_id uuid not null references plans.plan_sessions(id),
    item_type character varying(30) not null,
    title character varying(255),
    item_order numeric,
    plan_node_id uuid references plans.plan_nodes(id) on delete set null
  );
`;

async function seedEmptyWeeklyPlan() {
  const coach = await client.query(
    `insert into public.users (first_name, last_name, full_name) values ('Test','Coach','Test Coach') returning id`,
  );
  const plan = await client.query(
    `insert into plans.plans (plan_type, created_by_user_id, status) values ('weekly', $1, 'draft') returning id`,
    [coach.rows[0].id],
  );
  const day = await client.query(`insert into plans.plan_days (plan_id, date, day_order) values ($1, '2026-08-24', 1) returning id`, [plan.rows[0].id]);
  const session = await client.query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, 'AM', 'T', 1) returning id`,
    [day.rows[0].id],
  );
  return { planId: plan.rows[0].id, sessionId: session.rows[0].id };
}

async function addNode(sessionId, type, name, parentId = null, order = 1) {
  const r = await client.query(
    `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, node_order) values ($1,$2,$3,$4,$5) returning id`,
    [sessionId, parentId, type, name, order],
  );
  return r.rows[0].id;
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
});

after(async () => {
  await client.end();
  await adminClient.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`, [DB_NAME]);
  await adminClient.query(`drop database if exists "${DB_NAME}"`);
  await adminClient.end();
});

test("1. a plan with only an empty domain is treated as having content, not empty", async () => {
  const { planId, sessionId } = await seedEmptyWeeklyPlan();
  await addNode(sessionId, "domain", "Recovery");
  const hasContent = await planHasWeeklyTrainingContentWithClient(client, planId);
  assert.equal(hasContent, true, "a plan consisting solely of an empty domain must survive submit, not be deleted as empty");
});

test("2. a plan with only an empty category is treated as having content, not empty", async () => {
  const { planId, sessionId } = await seedEmptyWeeklyPlan();
  const domainId = await addNode(sessionId, "domain", "Strength");
  await addNode(sessionId, "category", "Mobility", domainId);
  const hasContent = await planHasWeeklyTrainingContentWithClient(client, planId);
  assert.equal(hasContent, true);
});

test("3. a plan with only an empty section named 'Massage' is treated as having content, not empty", async () => {
  const { planId, sessionId } = await seedEmptyWeeklyPlan();
  const domainId = await addNode(sessionId, "domain", "Recovery");
  const categoryId = await addNode(sessionId, "category", "Therapy", domainId);
  await addNode(sessionId, "section", "Massage", categoryId);
  const hasContent = await planHasWeeklyTrainingContentWithClient(client, planId);
  assert.equal(hasContent, true, "the exact reported case - a planned but exercise-less 'Massage' section - must survive submit");
});

test("4. a genuinely empty draft (no plan_items, no plan_nodes at all) is still treated as empty, exactly as before", async () => {
  const { planId } = await seedEmptyWeeklyPlan();
  const hasContent = await planHasWeeklyTrainingContentWithClient(client, planId);
  assert.equal(hasContent, false, "a plan with nothing planned at all must still be removed on submit, unchanged from before this fix");
});

test("5. a plan with a real exercise item continues to be treated as having content (unchanged behavior)", async () => {
  const { planId, sessionId } = await seedEmptyWeeklyPlan();
  const domainId = await addNode(sessionId, "domain", "Strength");
  const categoryId = await addNode(sessionId, "category", "Legs", domainId);
  const sectionId = await addNode(sessionId, "section", "Warm-up", categoryId);
  await client.query(
    `insert into plans.plan_items (plan_session_id, plan_node_id, item_type, title, item_order) values ($1,$2,'exercise','Squat',1)`,
    [sessionId, sectionId],
  );
  const hasContent = await planHasWeeklyTrainingContentWithClient(client, planId);
  assert.equal(hasContent, true);
});

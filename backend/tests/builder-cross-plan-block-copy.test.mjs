// Regression coverage for Phase 2 of the Builder day-copy/paste feature:
// copying a block from a Template or another Specific Program into a day of
// the weekly plan currently open in the Builder.
//
// POST /api/builder/blocks/:blockId/copy-into/:targetDayId - same
// content-only-paste/overwrite-confirm contract as Phase 1's
// POST /api/builder/days/:dayId/copy-into/:targetDayId (backend/tests/
// builder-day-copy-paste.test.mjs), but the source block can belong to ANY
// plan the coach has read/copy access to (getCopySourceBlock), not just the
// plan being edited.
//
// GET /api/builder/plans/:planId/blocks - the lightweight per-block summary
// (session/item counts, no full node/item tree) that powers the "pick a
// block to copy" picker.
//
// Runs against the real local OPTIMOVE database (same established pattern as
// backend/tests/builder-day-copy-paste.test.mjs), with every created row
// tracked and deleted in after().
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupAthleteIds = new Set();
const cleanupPlanIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await runCleanupSteps([
    ["plan trees", () => cleanupPlanIds.size && query(
      `delete from plans.plan_days where plan_id = any($1::uuid[])`, [[...cleanupPlanIds]],
    )],
    ["plans", () => cleanupPlanIds.size && query(`delete from plans.plans where id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["program_access", () => cleanupPlanIds.size && query(`delete from library.program_access where plan_id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["athletes", () => cleanupAthleteIds.size && query(`delete from public.athletes where id = any($1::uuid[])`, [[...cleanupAthleteIds]])],
    ["users", () => cleanupUserIds.size && query(`delete from public.users where id = any($1::uuid[])`, [[...cleanupUserIds]])],
    ["server close", () => new Promise((resolve) => server.close(resolve))],
    ["pool end", () => pool.end()],
  ]);
});

async function api(path, { method = "GET", cookie, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function makeCoach(label) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Test', 'Coach', $2, 'Test Coach', 'Test Coach', 'independent_coach', true)
     returning id`,
    [`cross-plan-block-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, hashPassword("irrelevant-password-123")],
  );
  cleanupUserIds.add(result.rows[0].id);
  await query(
    `insert into public.user_global_roles (user_id, role, is_active) values ($1, 'independent_coach', true)
     on conflict (user_id, role) do update set is_active = true, updated_at = now()`,
    [result.rows[0].id],
  );
  const token = await createSession(result.rows[0].id);
  return { id: result.rows[0].id, cookie: `optimove_session=${token}` };
}

async function makeAthlete(coachUserId) {
  const externalId = `cpb${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, is_active)
     values ($1, $1, 'Test', 'Athlete', 'Test Athlete', 'Test Athlete', true)
     returning id`,
    [externalId],
  );
  const athleteId = result.rows[0].id;
  cleanupAthleteIds.add(athleteId);
  await query(
    `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', true)`,
    [coachUserId, athleteId],
  );
  return { id: athleteId, externalId };
}

async function makeWeeklyPlan(coachUserId, athleteId, weekStart, days) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'Cross-plan copy test week', 'active', 'builder', 'private', $3)
     returning id`,
    [coachUserId, athleteId, weekStart],
  );
  const planId = plan.rows[0].id;
  cleanupPlanIds.add(planId);
  const dayIdByOrder = new Map();
  for (const dayOrder of days) {
    const dayRow = await query(
      `insert into plans.plan_days (plan_id, date, day_order, block_index, block_order, block_type)
       values ($1, $2::date + ($3::integer - 1), $3, $3, $3, 'session') returning id`,
      [planId, weekStart, dayOrder],
    );
    dayIdByOrder.set(dayOrder, dayRow.rows[0].id);
  }
  return { planId, dayIdByOrder };
}

// One block with one session holding a small domain>category>section>item
// tree, so tests can confirm the WHOLE tree (not just a flat item list)
// lands on the target day.
async function addBlockWithTree(planId, { blockIndex = 1, blockName = null, itemTitle = "Exercise" } = {}) {
  const dayRow = await query(
    `insert into plans.plan_days (plan_id, block_index, block_order, block_name, block_type)
     values ($1, $2, $3, $4, 'session') returning id`,
    [planId, blockIndex, blockIndex, blockName],
  );
  const blockId = dayRow.rows[0].id;
  const session = await query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, 'AM', 'T', 0) returning id`,
    [blockId],
  );
  const domain = await query(
    `insert into plans.plan_nodes (plan_session_id, node_type, name, node_order) values ($1, 'domain', 'Rehab', 0) returning id`,
    [session.rows[0].id],
  );
  const category = await query(
    `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, node_order) values ($1, $2, 'category', 'Mobility', 0) returning id`,
    [session.rows[0].id, domain.rows[0].id],
  );
  const section = await query(
    `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, node_order) values ($1, $2, 'section', 'Ankle', 0) returning id`,
    [session.rows[0].id, category.rows[0].id],
  );
  await query(
    `insert into plans.plan_items (plan_session_id, plan_node_id, item_type, title, item_order)
     values ($1, $2, 'exercise', $3, 0)`,
    [session.rows[0].id, section.rows[0].id, itemTitle],
  );
  return blockId;
}

async function makeTemplate(coachUserId, { visibility = "private", canCopy = true } = {}) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, status, source_type, visibility, is_template, can_copy)
     values ('program', $1, 'Cross-plan test template', 'active', 'builder', $2, true, $3) returning id`,
    [coachUserId, visibility, canCopy],
  );
  cleanupPlanIds.add(plan.rows[0].id);
  return plan.rows[0].id;
}

async function makeSpecificProgram(coachUserId, athleteId) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, is_template)
     values ('program', $1, $2, 'Cross-plan test program', 'active', 'builder', 'private', false) returning id`,
    [coachUserId, athleteId],
  );
  cleanupPlanIds.add(plan.rows[0].id);
  return plan.rows[0].id;
}

async function dayTree(dayId) {
  const rows = await query(
    `select pn.node_type, pn.name as node_name, pi.title
     from plans.plan_sessions ps
     join plans.plan_nodes pn on pn.plan_session_id = ps.id
     left join plans.plan_items pi on pi.plan_node_id = pn.id
     where ps.plan_day_id = $1
     order by pn.node_type, pi.item_order`,
    [dayId],
  );
  return rows.rows;
}

test("1. copying a block from the coach's OWN template into an empty weekly day succeeds and brings the whole tree", async () => {
  const coach = await makeCoach("own-template");
  const athlete = await makeAthlete(coach.id);
  const templateId = await makeTemplate(coach.id);
  const blockId = await addBlockWithTree(templateId, { itemTitle: "Ankle mobility drill" });
  const { dayIdByOrder } = await makeWeeklyPlan(coach.id, athlete.id, "2026-11-02", [1]);

  const res = await api(`/api/builder/blocks/${blockId}/copy-into/${dayIdByOrder.get(1)}`, {
    method: "POST", cookie: coach.cookie, body: {},
  });

  assert.equal(res.status, 200, `expected the copy to succeed, got ${res.status}: ${JSON.stringify(res.body)}`);
  const tree = await dayTree(dayIdByOrder.get(1));
  assert.ok(tree.some((row) => row.node_type === "domain" && row.node_name === "Rehab"));
  assert.ok(tree.some((row) => row.node_type === "category" && row.node_name === "Mobility"));
  assert.ok(tree.some((row) => row.node_type === "section" && row.node_name === "Ankle"));
  assert.ok(tree.some((row) => row.title === "Ankle mobility drill"), "the whole domain>category>section>item tree must land on the target day, not just a flattened item list");
});

test("2. copying a block from another athlete's Specific Program (same coach) into a weekly day succeeds", async () => {
  const coach = await makeCoach("other-athlete-program");
  const sourceAthlete = await makeAthlete(coach.id);
  const targetAthlete = await makeAthlete(coach.id);
  const programId = await makeSpecificProgram(coach.id, sourceAthlete.id);
  const blockId = await addBlockWithTree(programId, { itemTitle: "Program block exercise" });
  const { dayIdByOrder } = await makeWeeklyPlan(coach.id, targetAthlete.id, "2026-11-09", [1]);

  const res = await api(`/api/builder/blocks/${blockId}/copy-into/${dayIdByOrder.get(1)}`, {
    method: "POST", cookie: coach.cookie, body: {},
  });

  assert.equal(res.status, 200, `expected the copy to succeed, got ${res.status}: ${JSON.stringify(res.body)}`);
  const tree = await dayTree(dayIdByOrder.get(1));
  assert.ok(tree.some((row) => row.title === "Program block exercise"));
});

test("3. a coach with no access at all to the source plan is rejected", async () => {
  const owner = await makeCoach("stranger-owner");
  const ownerAthlete = await makeAthlete(owner.id);
  const programId = await makeSpecificProgram(owner.id, ownerAthlete.id);
  const blockId = await addBlockWithTree(programId, { itemTitle: "Private exercise" });

  const stranger = await makeCoach("stranger");
  const strangerAthlete = await makeAthlete(stranger.id);
  const { dayIdByOrder } = await makeWeeklyPlan(stranger.id, strangerAthlete.id, "2026-11-16", [1]);

  const res = await api(`/api/builder/blocks/${blockId}/copy-into/${dayIdByOrder.get(1)}`, {
    method: "POST", cookie: stranger.cookie, body: {},
  });

  assert.equal(res.status, 404, "a coach with no relationship to the source athlete/plan must not even learn it exists");
  const tree = await dayTree(dayIdByOrder.get(1));
  assert.equal(tree.length, 0);
});

test("4. a public template explicitly marked can_copy=false is rejected even though it's otherwise readable", async () => {
  const owner = await makeCoach("noncopy-owner");
  const templateId = await makeTemplate(owner.id, { visibility: "public", canCopy: false });
  const blockId = await addBlockWithTree(templateId, { itemTitle: "Should not be copyable" });

  const coach = await makeCoach("noncopy-requester");
  const athlete = await makeAthlete(coach.id);
  const { dayIdByOrder } = await makeWeeklyPlan(coach.id, athlete.id, "2026-11-23", [1]);

  const res = await api(`/api/builder/blocks/${blockId}/copy-into/${dayIdByOrder.get(1)}`, {
    method: "POST", cookie: coach.cookie, body: {},
  });

  assert.equal(res.status, 404, "must be refused the same way POST /plans/:id/duplicate already refuses a non-copyable template");
});

test("5. pasting a cross-plan block into a day that already has content is refused with 409, and confirmOverwrite: true then replaces it", async () => {
  const coach = await makeCoach("cross-plan-overwrite");
  const athlete = await makeAthlete(coach.id);
  const templateId = await makeTemplate(coach.id);
  const blockId = await addBlockWithTree(templateId, { itemTitle: "New content" });
  const { dayIdByOrder } = await makeWeeklyPlan(coach.id, athlete.id, "2026-11-30", [1]);
  // Give the target day existing content directly (not via the API).
  const existingSession = await query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, 'AM', 'T', 0) returning id`,
    [dayIdByOrder.get(1)],
  );
  const existingSection = await query(
    `insert into plans.plan_nodes (plan_session_id, node_type, name, node_order) values ($1, 'section', 'Old section', 0) returning id`,
    [existingSession.rows[0].id],
  );
  await query(
    `insert into plans.plan_items (plan_session_id, plan_node_id, item_type, title, item_order) values ($1, $2, 'exercise', 'Old content', 0)`,
    [existingSession.rows[0].id, existingSection.rows[0].id],
  );

  const refused = await api(`/api/builder/blocks/${blockId}/copy-into/${dayIdByOrder.get(1)}`, {
    method: "POST", cookie: coach.cookie, body: {},
  });
  assert.equal(refused.status, 409);
  assert.ok((await dayTree(dayIdByOrder.get(1))).some((row) => row.title === "Old content"), "refused paste must leave the old content in place");

  const confirmed = await api(`/api/builder/blocks/${blockId}/copy-into/${dayIdByOrder.get(1)}`, {
    method: "POST", cookie: coach.cookie, body: { confirmOverwrite: true },
  });
  assert.equal(confirmed.status, 200);
  const finalTree = await dayTree(dayIdByOrder.get(1));
  assert.ok(finalTree.some((row) => row.title === "New content"));
  assert.ok(!finalTree.some((row) => row.title === "Old content"), "confirmed overwrite must replace the old content, not merge alongside it");
});

test("6. GET /plans/:planId/blocks returns a lightweight per-block summary (session/item counts) for an accessible plan", async () => {
  const coach = await makeCoach("blocks-listing");
  const templateId = await makeTemplate(coach.id);
  await addBlockWithTree(templateId, { blockIndex: 1, blockName: "Phase 1", itemTitle: "Ex A" });
  await addBlockWithTree(templateId, { blockIndex: 2, blockName: null, itemTitle: "Ex B" });

  const res = await api(`/api/builder/plans/${templateId}/blocks`, { cookie: coach.cookie });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.blocks.length, 2);
  const named = res.body.blocks.find((block) => block.name === "Phase 1");
  assert.ok(named, "a block's own name must be used when it has one");
  assert.equal(named.sessionCount, 1);
  assert.equal(named.itemCount, 1);
  const unnamed = res.body.blocks.find((block) => block.name === "Block 2");
  assert.ok(unnamed, "a block with no custom name must fall back to 'Block <index>'");
});

test("7. GET /plans/:planId/blocks 404s for a plan the coach has no access to", async () => {
  const owner = await makeCoach("blocks-listing-owner");
  const templateId = await makeTemplate(owner.id);

  const stranger = await makeCoach("blocks-listing-stranger");
  const res = await api(`/api/builder/plans/${templateId}/blocks`, { cookie: stranger.cookie });

  assert.equal(res.status, 404);
});

// "Weekly plan" as a cross-plan source (round 2 of Builder feedback): a
// weekly plan's own day is just a plan_days row like any block/day, so it
// goes through the exact same /blocks/:blockId/copy-into/:targetDayId route
// - the only change needed was relaxing respondCopyIntoDay's guard for THIS
// route specifically (allowCrossPlan: true), while /days/:dayId/copy-into
// (Phase 1's same-plan route, getEditableBlock on both sides) keeps
// rejecting cross-plan entirely - see backend/tests/builder-day-copy-paste
// .test.mjs test 5, unchanged and still passing.

test("8. copying a day from a DIFFERENT weekly plan (same coach, different athlete) into a weekly day succeeds and brings the whole tree", async () => {
  const coach = await makeCoach("weekly-source");
  const sourceAthlete = await makeAthlete(coach.id);
  const targetAthlete = await makeAthlete(coach.id);
  const { planId: sourcePlanId } = await makeWeeklyPlan(coach.id, sourceAthlete.id, "2026-12-07", []);
  const sourceDayId = await addBlockWithTree(sourcePlanId, { blockIndex: 1, itemTitle: "Weekly source exercise" });
  const { dayIdByOrder } = await makeWeeklyPlan(coach.id, targetAthlete.id, "2026-12-07", [1]);

  const res = await api(`/api/builder/blocks/${sourceDayId}/copy-into/${dayIdByOrder.get(1)}`, {
    method: "POST", cookie: coach.cookie, body: {},
  });

  assert.equal(res.status, 200, `expected the copy to succeed, got ${res.status}: ${JSON.stringify(res.body)}`);
  const tree = await dayTree(dayIdByOrder.get(1));
  assert.ok(tree.some((row) => row.title === "Weekly source exercise"), "content from the source weekly plan's day must land on the target day");
});

test("9. a coach with no access to the source weekly plan's athlete is rejected", async () => {
  const owner = await makeCoach("weekly-source-owner");
  const ownerAthlete = await makeAthlete(owner.id);
  const { planId: sourcePlanId } = await makeWeeklyPlan(owner.id, ownerAthlete.id, "2026-12-14", []);
  const sourceDayId = await addBlockWithTree(sourcePlanId, { blockIndex: 1, itemTitle: "Private weekly exercise" });

  const stranger = await makeCoach("weekly-source-stranger");
  const strangerAthlete = await makeAthlete(stranger.id);
  const { dayIdByOrder } = await makeWeeklyPlan(stranger.id, strangerAthlete.id, "2026-12-14", [1]);

  const res = await api(`/api/builder/blocks/${sourceDayId}/copy-into/${dayIdByOrder.get(1)}`, {
    method: "POST", cookie: stranger.cookie, body: {},
  });

  assert.equal(res.status, 404, "a coach with no relationship to the source athlete/plan must not even learn it exists");
  const tree = await dayTree(dayIdByOrder.get(1));
  assert.equal(tree.length, 0);
});

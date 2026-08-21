// Regression coverage for "Templates -> Specific Programs" assignment
// (Programs overhaul, item 3). Both UI entry points - the existing
// templates-list "Copy" action and the new open-Builder "Assign to
// athlete" button (frontend/builder-view.js, frontend/builder-actions.js)
// - call the exact same, pre-existing POST /api/builder/plans/:planId/duplicate
// endpoint with the exact same payload shape, so a single HTTP-level test
// against that endpoint covers both paths' backend behavior identically -
// there is no separate backend logic to duplicate or diverge between them.
//
// Runs against the real local OPTIMOVE database (same established pattern as
// backend/tests/program-access-batch-authorization.test.mjs), with every
// created row tracked and deleted in after().
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

async function grantGlobalRole(userId, role) {
  await query(
    `insert into public.user_global_roles (user_id, role, is_active) values ($1, $2, true)
     on conflict (user_id, role) do update set is_active = true, updated_at = now()`,
    [userId, role],
  );
}

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
    [`assign-flow-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, hashPassword("irrelevant-password-123")],
  );
  cleanupUserIds.add(result.rows[0].id);
  await grantGlobalRole(result.rows[0].id, "independent_coach");
  const token = await createSession(result.rows[0].id);
  return { id: result.rows[0].id, cookie: `optimove_session=${token}` };
}

async function makeAthlete(coachUserId) {
  const externalId = `atat${Math.floor(Math.random() * 900000 + 100000)}`;
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

// Builds a template with: one populated section (one exercise item) AND one
// EMPTY named domain > empty category > empty section chain, matching the
// exact "prazne imenovane strukture" (empty named structures) requirement.
async function makeTemplate(coachUserId, { name = "Assign Flow Template" } = {}) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, status, source_type, visibility)
     values ('program', $1, $2, true, 'active', 'builder', 'private')
     returning id`,
    [coachUserId, name],
  );
  const planId = plan.rows[0].id;
  cleanupPlanIds.add(planId);

  const day = await query(
    `insert into plans.plan_days (plan_id, block_index, block_name, block_order) values ($1, 0, 'Day 1', 0) returning id`,
    [planId],
  );
  const session = await query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, 'AM', 'T', 0) returning id`,
    [day.rows[0].id],
  );

  const populatedSection = await query(
    `insert into plans.plan_nodes (plan_session_id, node_type, name, node_order) values ($1, 'section', 'Warm-up', 0) returning id`,
    [session.rows[0].id],
  );
  await query(
    `insert into plans.plan_items (plan_session_id, plan_node_id, item_type, title, item_order) values ($1, $2, 'exercise', 'Squat', 0)`,
    [session.rows[0].id, populatedSection.rows[0].id],
  );

  const emptyDomain = await query(
    `insert into plans.plan_nodes (plan_session_id, node_type, name, node_order) values ($1, 'domain', 'Recovery', 1) returning id`,
    [session.rows[0].id],
  );
  const emptyCategory = await query(
    `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, node_order) values ($1, $2, 'category', 'Therapy', 0) returning id`,
    [session.rows[0].id, emptyDomain.rows[0].id],
  );
  await query(
    `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, node_order) values ($1, $2, 'section', 'Massage', 0)`,
    [session.rows[0].id, emptyCategory.rows[0].id],
  );

  return { id: planId, name };
}

async function nodeNames(planId) {
  const r = await query(
    `select pn.name, pn.node_type
     from plans.plan_nodes pn
     join plans.plan_sessions ps on ps.id = pn.plan_session_id
     join plans.plan_days pd on pd.id = ps.plan_day_id
     where pd.plan_id = $1
     order by pn.node_order, pn.node_type`,
    [planId],
  );
  return r.rows;
}

async function planRow(planId) {
  const r = await query(`select * from plans.plans where id = $1`, [planId]);
  return r.rows[0];
}

test("1+2+3. assigning creates an independent Specific Program with the identical tree shape - the same endpoint two athletes both go through", async () => {
  const coach = await makeCoach("basic");
  const athleteA = await makeAthlete(coach.id);
  const athleteB = await makeAthlete(coach.id);
  const template = await makeTemplate(coach.id);

  const resA = await api(`/api/builder/plans/${template.id}/duplicate`, { method: "POST", cookie: coach.cookie, body: { athleteId: athleteA.externalId, athleteIds: [athleteA.externalId] } });
  assert.equal(resA.status, 201);
  cleanupPlanIds.add(resA.body.plan.id);
  const resB = await api(`/api/builder/plans/${template.id}/duplicate`, { method: "POST", cookie: coach.cookie, body: { athleteId: athleteB.externalId, athleteIds: [athleteB.externalId] } });
  assert.equal(resB.status, 201);
  cleanupPlanIds.add(resB.body.plan.id);

  for (const res of [resA, resB]) {
    assert.equal(res.body.plan.isTemplate, false, "an assigned copy must not itself be a template");
    assert.equal(res.body.blocks.length, 1);
    assert.equal(res.body.blocks[0].sessions[0].nodes.length, 4, "populated section + empty domain + empty category + empty section");
  }
  const rowA = await planRow(resA.body.plan.id);
  const rowB = await planRow(resB.body.plan.id);
  assert.equal(rowA.athlete_id, athleteA.id);
  assert.equal(rowB.athlete_id, athleteB.id);
  assert.equal(rowA.status, "draft");
  assert.equal(rowB.status, "draft");
});

test("3b. a single /duplicate call with two athleteIds creates BOTH Specific Programs and returns an assignments entry for each - not just the first plan", async () => {
  // The frontend "Assign to athlete" flow (frontend/builder-actions.js)
  // sends one /duplicate call with every selected athlete's id and reads
  // back created.assignments to link to EACH resulting Specific Program in
  // its confirmation banner - res.body.plan/blocks/batch alone only ever
  // describe the FIRST created plan, so this response field is what makes
  // a multi-athlete assign actually usable end to end.
  const coach = await makeCoach("multi-assign");
  const athleteA = await makeAthlete(coach.id);
  const athleteB = await makeAthlete(coach.id);
  const template = await makeTemplate(coach.id);

  const res = await api(`/api/builder/plans/${template.id}/duplicate`, {
    method: "POST",
    cookie: coach.cookie,
    body: { athleteIds: [athleteA.externalId, athleteB.externalId] },
  });
  assert.equal(res.status, 201);

  assert.ok(Array.isArray(res.body.assignments), "the response must include an assignments array");
  assert.equal(res.body.assignments.length, 2, "one assignments entry per requested athlete");
  const byAthlete = Object.fromEntries(res.body.assignments.map((entry) => [entry.athleteId, entry.planId]));
  assert.equal(byAthlete[athleteA.externalId], res.body.plan.id, "the first assignments entry must match the top-level plan (the first created)");
  assert.ok(byAthlete[athleteB.externalId], "the second athlete's plan id must also be present");
  assert.notEqual(byAthlete[athleteA.externalId], byAthlete[athleteB.externalId], "each athlete must get its own independent plan id");
  [byAthlete[athleteA.externalId], byAthlete[athleteB.externalId]].forEach((id) => cleanupPlanIds.add(id));

  const rowA = await planRow(byAthlete[athleteA.externalId]);
  const rowB = await planRow(byAthlete[athleteB.externalId]);
  assert.equal(rowA.athlete_id, athleteA.id, "the plan linked to athlete A's assignments entry must actually belong to athlete A");
  assert.equal(rowB.athlete_id, athleteB.id, "the plan linked to athlete B's assignments entry must actually belong to athlete B");
  assert.equal(rowA.is_template, false);
  assert.equal(rowB.is_template, false);
});

test("4. the template itself is completely unchanged after being assigned", async () => {
  const coach = await makeCoach("unchanged");
  const athlete = await makeAthlete(coach.id);
  const template = await makeTemplate(coach.id);
  const before = await planRow(template.id);
  const beforeNodes = await nodeNames(template.id);

  const res = await api(`/api/builder/plans/${template.id}/duplicate`, { method: "POST", cookie: coach.cookie, body: { athleteId: athlete.externalId, athleteIds: [athlete.externalId] } });
  assert.equal(res.status, 201);
  cleanupPlanIds.add(res.body.plan.id);

  const after = await planRow(template.id);
  const afterNodes = await nodeNames(template.id);
  assert.equal(after.is_template, true);
  assert.equal(after.name, before.name);
  assert.equal(after.status, before.status);
  assert.equal(after.updated_at.getTime(), before.updated_at.getTime(), "the template row must not even be touched, not just unchanged in content");
  assert.deepEqual(afterNodes, beforeNodes);
});

test("5. a LATER edit to the template does not change the already-assigned copy", async () => {
  const coach = await makeCoach("later-edit");
  const athlete = await makeAthlete(coach.id);
  const template = await makeTemplate(coach.id);

  const res = await api(`/api/builder/plans/${template.id}/duplicate`, { method: "POST", cookie: coach.cookie, body: { athleteId: athlete.externalId, athleteIds: [athlete.externalId] } });
  assert.equal(res.status, 201);
  const assignedPlanId = res.body.plan.id;
  cleanupPlanIds.add(assignedPlanId);
  const assignedNodesBefore = await nodeNames(assignedPlanId);

  // Rename a node on the TEMPLATE directly (simulates the coach editing it later).
  await query(
    `update plans.plan_nodes set name = 'Renamed after assignment'
     where plan_session_id in (
       select ps.id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1
     ) and node_type = 'section' and name = 'Warm-up'`,
    [template.id],
  );

  const assignedNodesAfter = await nodeNames(assignedPlanId);
  assert.deepEqual(assignedNodesAfter, assignedNodesBefore, "the assigned copy's tree must be completely independent of later template edits");
  assert.ok(!assignedNodesAfter.some((n) => n.name === "Renamed after assignment"));
});

test("6. an unauthorized coach (no ownership, no roster access, template private) cannot assign/duplicate the template", async () => {
  const owner = await makeCoach("owner");
  const stranger = await makeCoach("stranger");
  const athlete = await makeAthlete(owner.id); // stranger has no relationship to this athlete either
  const template = await makeTemplate(owner.id);

  const res = await api(`/api/builder/plans/${template.id}/duplicate`, { method: "POST", cookie: stranger.cookie, body: { athleteId: athlete.externalId, athleteIds: [athlete.externalId] } });
  assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);

  const templateStillIntact = await planRow(template.id);
  assert.equal(templateStillIntact.is_template, true);
});

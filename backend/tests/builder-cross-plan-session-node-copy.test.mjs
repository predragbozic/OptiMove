// Phase F2 of the cross-plan copy feature (round 2 of Builder feedback):
// drilling into a session, or a specific domain/category/section, instead
// of only ever copying a whole day.
//
// GET /api/builder/blocks/:blockId/sessions - lightweight session list for
// the picker's "drill into a day" step.
// GET /api/builder/sessions/:sessionId/nodes - flat node list for the
// picker's "drill into a session" step.
// POST /api/builder/sessions/:sessionId/copy-into/:targetDayId - new
// endpoint: appends a whole session (never overwrites, unlike day-paste).
// POST /api/builder/nodes/:nodeId/copy - widened to accept a cross-plan
// source (read/copy access), reusing the pre-existing same-plan node
// clipboard/paste mechanism.
//
// Runs against the real local OPTIMOVE database (same established pattern
// as backend/tests/builder-cross-plan-block-copy.test.mjs), with every
// created row tracked and deleted in after().
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
    ["plan trees", () => cleanupPlanIds.size && query(`delete from plans.plan_days where plan_id = any($1::uuid[])`, [[...cleanupPlanIds]])],
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
    [`cross-plan-drill-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, hashPassword("irrelevant-password-123")],
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
  const externalId = `cpd${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, is_active)
     values ($1, $1, 'Test', 'Athlete', 'Test Athlete', 'Test Athlete', true)
     returning id`,
    [externalId],
  );
  const athleteId = result.rows[0].id;
  cleanupAthleteIds.add(athleteId);
  await query(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', true)`, [coachUserId, athleteId]);
  return { id: athleteId, externalId };
}

async function makeWeeklyPlan(coachUserId, athleteId, weekStart, dayOrders) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'Cross-plan drill test week', 'active', 'builder', 'private', $3)
     returning id`,
    [coachUserId, athleteId, weekStart],
  );
  const planId = plan.rows[0].id;
  cleanupPlanIds.add(planId);
  const dayIdByOrder = new Map();
  for (const dayOrder of dayOrders) {
    const dayRow = await query(
      `insert into plans.plan_days (plan_id, date, day_order, block_index, block_order, block_type)
       values ($1, $2::date + ($3::integer - 1), $3, $3, $3, 'session') returning id`,
      [planId, weekStart, dayOrder],
    );
    dayIdByOrder.set(dayOrder, dayRow.rows[0].id);
  }
  return { planId, dayIdByOrder };
}

async function makeTemplate(coachUserId) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, status, source_type, visibility, is_template, can_copy)
     values ('program', $1, 'Cross-plan drill test template', 'active', 'builder', 'private', true, true) returning id`,
    [coachUserId],
  );
  cleanupPlanIds.add(plan.rows[0].id);
  return plan.rows[0].id;
}

// One block with two sessions - AM and PM - the AM session holding a
// domain>category>section>item tree, so tests can confirm the picker's
// session/node granularity independently (a session-level copy brings the
// whole session; a node-level copy brings only that one node+subtree).
async function addBlockWithTwoSessions(planId, { blockIndex = 1 } = {}) {
  const dayRow = await query(
    `insert into plans.plan_days (plan_id, block_index, block_order, block_type) values ($1, $2, $3, 'session') returning id`,
    [planId, blockIndex, blockIndex],
  );
  const blockId = dayRow.rows[0].id;
  const amSession = await query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order, name) values ($1, 'AM', 'T', 0, 'Morning drill session') returning id`,
    [blockId],
  );
  const amSessionId = amSession.rows[0].id;
  const domain = await query(
    `insert into plans.plan_nodes (plan_session_id, node_type, name, node_order) values ($1, 'domain', 'Rehab', 0) returning id`,
    [amSessionId],
  );
  const domainId = domain.rows[0].id;
  const category = await query(
    `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, node_order) values ($1, $2, 'category', 'Mobility', 0) returning id`,
    [amSessionId, domainId],
  );
  const categoryId = category.rows[0].id;
  const section = await query(
    `insert into plans.plan_nodes (plan_session_id, parent_id, node_type, name, node_order) values ($1, $2, 'section', 'Ankle', 0) returning id`,
    [amSessionId, categoryId],
  );
  const sectionId = section.rows[0].id;
  await query(
    `insert into plans.plan_items (plan_session_id, plan_node_id, item_type, title, item_order) values ($1, $2, 'exercise', 'Ankle mobility drill', 0)`,
    [amSessionId, sectionId],
  );
  const pmSession = await query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order, name) values ($1, 'PM', 'A', 1, 'Evening session') returning id`,
    [blockId],
  );
  return { blockId, amSessionId, pmSessionId: pmSession.rows[0].id, domainId, categoryId, sectionId };
}

async function sessionRows(dayId) {
  const rows = await query("select id, am_pm, bta, name, session_order from plans.plan_sessions where plan_day_id = $1 order by session_order", [dayId]);
  return rows.rows;
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

test("1. GET /blocks/:blockId/sessions lists both sessions with correct labels and item counts", async () => {
  const coach = await makeCoach("sessions-list");
  const templateId = await makeTemplate(coach.id);
  const { blockId } = await addBlockWithTwoSessions(templateId);

  const res = await api(`/api/builder/blocks/${blockId}/sessions`, { cookie: coach.cookie });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.sessions.length, 2);
  const am = res.body.sessions.find((s) => s.amPm === "AM");
  assert.equal(am.name, "Morning drill session");
  assert.equal(am.itemCount, 1);
  const pm = res.body.sessions.find((s) => s.amPm === "PM");
  assert.equal(pm.name, "Evening session");
  assert.equal(pm.itemCount, 0);
});

test("2. GET /blocks/:blockId/sessions 404s for a coach with no access to the plan", async () => {
  const owner = await makeCoach("sessions-list-owner");
  const templateId = await makeTemplate(owner.id);
  const { blockId } = await addBlockWithTwoSessions(templateId);

  const stranger = await makeCoach("sessions-list-stranger");
  const res = await api(`/api/builder/blocks/${blockId}/sessions`, { cookie: stranger.cookie });

  assert.equal(res.status, 404);
});

test("3. GET /sessions/:sessionId/nodes lists the flat domain>category>section tree with parentId links and item counts", async () => {
  const coach = await makeCoach("nodes-list");
  const templateId = await makeTemplate(coach.id);
  const { amSessionId, domainId, categoryId, sectionId } = await addBlockWithTwoSessions(templateId);

  const res = await api(`/api/builder/sessions/${amSessionId}/nodes`, { cookie: coach.cookie });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.nodes.length, 3);
  const domain = res.body.nodes.find((n) => n.id === domainId);
  assert.equal(domain.type, "domain");
  assert.equal(domain.parentId, "");
  const category = res.body.nodes.find((n) => n.id === categoryId);
  assert.equal(category.parentId, domainId);
  const section = res.body.nodes.find((n) => n.id === sectionId);
  assert.equal(section.parentId, categoryId);
  assert.equal(section.itemCount, 1);
});

test("4. GET /sessions/:sessionId/nodes 404s for a coach with no access to the plan", async () => {
  const owner = await makeCoach("nodes-list-owner");
  const templateId = await makeTemplate(owner.id);
  const { amSessionId } = await addBlockWithTwoSessions(templateId);

  const stranger = await makeCoach("nodes-list-stranger");
  const res = await api(`/api/builder/sessions/${amSessionId}/nodes`, { cookie: stranger.cookie });

  assert.equal(res.status, 404);
});

test("5. POST /sessions/:sessionId/copy-into/:targetDayId appends a whole session (with its full tree) without touching an existing session on the target day", async () => {
  const coach = await makeCoach("session-copy");
  const athlete = await makeAthlete(coach.id);
  const templateId = await makeTemplate(coach.id);
  const { amSessionId } = await addBlockWithTwoSessions(templateId);
  const { dayIdByOrder } = await makeWeeklyPlan(coach.id, athlete.id, "2027-01-04", [1]);
  const targetDayId = dayIdByOrder.get(1);
  // Give the target day a pre-existing session, to prove this is additive.
  await query(`insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order, name) values ($1, 'AM', 'B', 0, 'Pre-existing warmup') returning id`, [targetDayId]);

  const res = await api(`/api/builder/sessions/${amSessionId}/copy-into/${targetDayId}`, { method: "POST", cookie: coach.cookie, body: {} });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  const sessions = await sessionRows(targetDayId);
  assert.equal(sessions.length, 2, "the pre-existing session must survive - session copy is additive, never an overwrite");
  assert.ok(sessions.some((s) => s.name === "Pre-existing warmup"));
  assert.ok(sessions.some((s) => s.name === "Morning drill session"));
  const tree = await dayTree(targetDayId);
  assert.ok(tree.some((row) => row.node_type === "domain" && row.node_name === "Rehab"));
  assert.ok(tree.some((row) => row.node_type === "section" && row.node_name === "Ankle"));
  assert.ok(tree.some((row) => row.title === "Ankle mobility drill"), "the whole session's tree must land, not just a flattened item list");
});

test("6. POST /sessions/:sessionId/copy-into/:targetDayId is rejected for a coach with no access to the source session's plan", async () => {
  const owner = await makeCoach("session-copy-owner");
  const templateId = await makeTemplate(owner.id);
  const { amSessionId } = await addBlockWithTwoSessions(templateId);

  const stranger = await makeCoach("session-copy-stranger");
  const strangerAthlete = await makeAthlete(stranger.id);
  const { dayIdByOrder } = await makeWeeklyPlan(stranger.id, strangerAthlete.id, "2027-01-11", [1]);

  const res = await api(`/api/builder/sessions/${amSessionId}/copy-into/${dayIdByOrder.get(1)}`, { method: "POST", cookie: stranger.cookie, body: {} });

  assert.equal(res.status, 404);
  assert.equal((await sessionRows(dayIdByOrder.get(1))).length, 0);
});

test("7. POST /nodes/:nodeId/copy now succeeds for a node from another plan the coach only has READ/copy access to (not edit access)", async () => {
  const coach = await makeCoach("node-copy-cross-plan");
  const athlete = await makeAthlete(coach.id);
  const templateId = await makeTemplate(coach.id);
  const { sectionId } = await addBlockWithTwoSessions(templateId);
  const { planId: weeklyPlanId, dayIdByOrder } = await makeWeeklyPlan(coach.id, athlete.id, "2027-01-18", [1]);
  const targetSession = await query(`insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, 'AM', 'T', 0) returning id`, [dayIdByOrder.get(1)]);

  const res = await api("/api/builder/nodes/" + sectionId + "/copy", {
    method: "POST", cookie: coach.cookie, body: { targetSessionId: targetSession.rows[0].id },
  });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  const tree = await dayTree(dayIdByOrder.get(1));
  assert.ok(tree.some((row) => row.node_type === "section" && row.node_name === "Ankle"));
  assert.ok(tree.some((row) => row.title === "Ankle mobility drill"), "only the picked section+its exercises must land, not the whole session/day");
  assert.ok(!tree.some((row) => row.node_type === "domain"), "must not also bring the section's own ancestors from the source - it copies the picked node+its subtree only, same as same-plan node copy already does");
});

test("8. POST /nodes/:nodeId/copy is still rejected for a coach with no access at all to the source node's plan", async () => {
  const owner = await makeCoach("node-copy-owner");
  const templateId = await makeTemplate(owner.id);
  const { sectionId } = await addBlockWithTwoSessions(templateId);

  const stranger = await makeCoach("node-copy-stranger");
  const strangerAthlete = await makeAthlete(stranger.id);
  const { dayIdByOrder } = await makeWeeklyPlan(stranger.id, strangerAthlete.id, "2027-01-25", [1]);
  const targetSession = await query(`insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, 'AM', 'T', 0) returning id`, [dayIdByOrder.get(1)]);

  const res = await api("/api/builder/nodes/" + sectionId + "/copy", {
    method: "POST", cookie: stranger.cookie, body: { targetSessionId: targetSession.rows[0].id },
  });

  assert.equal(res.status, 404);
});

// Regression coverage for the actual reported bug: "Source node or target
// session not found" on both same-plan and cross-plan node copy, whenever
// the plan involved had already been published once and re-opened for
// editing. POST /plans/:planId/edit (backend/src/routes/builder.js) creates
// that hidden "edit draft" row with is_active = FALSE on purpose (so it
// never shows up in normal plan listings) - every test above only ever
// inserts plans directly, which default to is_active = true, so none of
// them exercised this path at all. getCopySource's `is_active = true`
// filter (before the fix) silently treated the coach's own currently-open
// edit draft as "not found".
async function markAsEditDraft(planId, sourcePlanId) {
  await query(`update plans.plans set is_active = false, is_edit_draft = true, edit_source_plan_id = $2 where id = $1`, [planId, sourcePlanId]);
}

test("9. POST /nodes/:nodeId/copy works for a same-plan copy where BOTH source and target live in the coach's own currently-open edit draft (is_active = false)", async () => {
  const coach = await makeCoach("node-copy-same-plan-editdraft");
  const athlete = await makeAthlete(coach.id);
  const { planId, dayIdByOrder } = await makeWeeklyPlan(coach.id, athlete.id, "2027-02-01", [1]);
  const { sectionId } = await addBlockWithTwoSessions(planId, { blockIndex: 2 });
  await markAsEditDraft(planId, planId); // edit_source_plan_id value is irrelevant to this endpoint - only is_active/is_edit_draft matter here
  const targetSession = await query(`insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, 'AM', 'T', 0) returning id`, [dayIdByOrder.get(1)]);

  const res = await api("/api/builder/nodes/" + sectionId + "/copy", {
    method: "POST", cookie: coach.cookie, body: { targetSessionId: targetSession.rows[0].id },
  });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  const tree = await dayTree(dayIdByOrder.get(1));
  assert.ok(tree.some((row) => row.node_type === "section" && row.node_name === "Ankle"));
});

test("10. POST /nodes/:nodeId/copy works when the SOURCE plan (a template) has been edited-and-republished before, not just freshly created", async () => {
  const coach = await makeCoach("node-copy-cross-plan-editdraft");
  const athlete = await makeAthlete(coach.id);
  const templateId = await makeTemplate(coach.id);
  const { sectionId } = await addBlockWithTwoSessions(templateId);
  await markAsEditDraft(templateId, templateId);
  const { dayIdByOrder } = await makeWeeklyPlan(coach.id, athlete.id, "2027-02-08", [1]);
  const targetSession = await query(`insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, 'AM', 'T', 0) returning id`, [dayIdByOrder.get(1)]);

  const res = await api("/api/builder/nodes/" + sectionId + "/copy", {
    method: "POST", cookie: coach.cookie, body: { targetSessionId: targetSession.rows[0].id },
  });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  const tree = await dayTree(dayIdByOrder.get(1));
  assert.ok(tree.some((row) => row.node_type === "section" && row.node_name === "Ankle"));
});

test("11. GET /blocks/:blockId/sessions and GET /sessions/:sessionId/nodes also work against an edit-draft source plan", async () => {
  const coach = await makeCoach("edit-draft-picker-list");
  const templateId = await makeTemplate(coach.id);
  const { blockId, amSessionId } = await addBlockWithTwoSessions(templateId);
  await markAsEditDraft(templateId, templateId);

  const sessionsRes = await api(`/api/builder/blocks/${blockId}/sessions`, { cookie: coach.cookie });
  assert.equal(sessionsRes.status, 200, `expected 200, got ${sessionsRes.status}: ${JSON.stringify(sessionsRes.body)}`);
  assert.equal(sessionsRes.body.sessions.length, 2);

  const nodesRes = await api(`/api/builder/sessions/${amSessionId}/nodes`, { cookie: coach.cookie });
  assert.equal(nodesRes.status, 200, `expected 200, got ${nodesRes.status}: ${JSON.stringify(nodesRes.body)}`);
  assert.equal(nodesRes.body.nodes.length, 3);
});

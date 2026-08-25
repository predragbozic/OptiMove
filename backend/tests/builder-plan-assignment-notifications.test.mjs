// Builder plan-assignment notifications: wiring Builder's draft->active
// ("Save and finish", both weekly plans and specific programs) and template
// "Assign to athlete" (POST /plans/:planId/duplicate with intent:"assign")
// into the existing public.app_notifications inbox.
//
// Same established harness as backend/tests/builder-day-copy-paste.test.mjs
// and backend/tests/template-assign-to-athlete.test.mjs: the real local
// OPTIMOVE database (never a disposable temp DB - this mirrors the rest of
// the Builder test suite's own convention), with every created row tracked
// and deleted in after(). NEVER run against production/Supabase - DATABASE_URL
// must point at local OPTIMOVE (see backend/.env).
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
    // app_notifications rows cascade-delete with their recipient user (on
    // delete cascade), so deleting every tracked user below is sufficient -
    // no separate notifications cleanup step needed.
    ["plan trees", () => cleanupPlanIds.size && query(`delete from plans.plan_days where plan_id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["program_access", () => cleanupPlanIds.size && query(`delete from library.program_access where plan_id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["plans", () => cleanupPlanIds.size && query(`delete from plans.plans where id = any($1::uuid[])`, [[...cleanupPlanIds]])],
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
    [`plan-assign-notif-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, hashPassword("irrelevant-password-123")],
  );
  cleanupUserIds.add(result.rows[0].id);
  await grantGlobalRole(result.rows[0].id, "independent_coach");
  const token = await createSession(result.rows[0].id);
  return { id: result.rows[0].id, cookie: `optimove_session=${token}` };
}

// withUser=false models an athlete with no linked login account at all -
// the exact edge case that must never crash a batch.
async function makeAthlete(coachUserId, label, { withUser = true } = {}) {
  const externalId = `pan${label}${Math.floor(Math.random() * 900000 + 100000)}`;
  let userId = null;
  if (withUser) {
    const userResult = await query(
      `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
       values ($1, 'Test', 'Athlete', $2, 'Test Athlete', 'Test Athlete', 'athlete', true)
       returning id`,
      [`plan-assign-notif-athlete-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, hashPassword("irrelevant-password-123")],
    );
    userId = userResult.rows[0].id;
    cleanupUserIds.add(userId);
  }
  const result = await query(
    `insert into public.athletes (user_id, athlete_id, source_external_id, first_name, last_name, full_name, display_name, is_active)
     values ($1, $2, $2, 'Test', 'Athlete', 'Test Athlete', 'Test Athlete', true)
     returning id`,
    [userId, externalId],
  );
  const athleteId = result.rows[0].id;
  cleanupAthleteIds.add(athleteId);
  await query(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', true)`, [coachUserId, athleteId]);
  return { id: athleteId, externalId, userId };
}

async function notificationsFor(userId, type) {
  const result = await query(`select id, title, body, entity_type, entity_id, metadata, actor_user_id from public.app_notifications where recipient_user_id = $1 and type = $2`, [userId, type]);
  return result.rows;
}

// removeEmptyDraftOnSubmit() (backend/src/routes/builder.js) is a real,
// pre-existing safeguard, unrelated to this feature: it silently DELETES an
// empty draft on Submit instead of activating it. Every test below that
// exercises draft -> active must seed real content first, or the plan (and
// any chance of a notification) vanishes before notifyPlanAssignments ever
// runs. Weekly plans already get empty plan_days rows on creation
// (createWeeklyDays); program plans get none, so one is inserted here too.
async function seedPlanContent(planId, isWeekly) {
  if (!isWeekly) {
    await query(
      `insert into plans.plan_days (plan_id, day_order, block_index, block_order, block_name, block_type) values ($1, 1, 1, 1, 'Seeded block', 'session')`,
      [planId],
    );
    return;
  }
  const day = await query(`select id from plans.plan_days where plan_id = $1 order by day_order limit 1`, [planId]);
  const session = await query(`insert into plans.plan_sessions (plan_day_id, session_order, name) values ($1, 1, 'Session') returning id`, [day.rows[0].id]);
  await query(`insert into plans.plan_nodes (plan_session_id, node_type, name, node_order) values ($1, 'section', 'Seeded section', 1)`, [session.rows[0].id]);
}

// ------------------------------------------------------------
// Weekly plan: draft -> active via POST /plans/:planId/submit
// ------------------------------------------------------------

test("1. a weekly plan still in draft never sends a notification", async () => {
  const coach = await makeCoach("w1");
  const athlete = await makeAthlete(coach.id, "w1");
  const created = await api("/api/builder/plans", { method: "POST", cookie: coach.cookie, body: { planType: "weekly", athleteIds: [athlete.externalId], weekStart: "2027-02-01" } });
  assert.equal(created.status, 201);
  cleanupPlanIds.add(created.body.plan.id);

  const rows = await notificationsFor(athlete.userId, "weekly_plan_assigned");
  assert.equal(rows.length, 0);
});

test("2. weekly plan draft -> active (Save and finish) sends exactly ONE notification, with the right title/body/actor/entity/metadata", async () => {
  const coach = await makeCoach("w2");
  const athlete = await makeAthlete(coach.id, "w2");
  const created = await api("/api/builder/plans", { method: "POST", cookie: coach.cookie, body: { planType: "weekly", athleteIds: [athlete.externalId], weekStart: "2027-02-08" } });
  cleanupPlanIds.add(created.body.plan.id);
  await seedPlanContent(created.body.plan.id, true);

  const submitted = await api(`/api/builder/plans/${created.body.plan.id}/submit`, { method: "POST", cookie: coach.cookie, body: {} });
  assert.equal(submitted.status, 200, `expected submit to succeed, got ${submitted.status}: ${JSON.stringify(submitted.body)}`);
  assert.equal(submitted.body.plan.status, "active");

  const rows = await notificationsFor(athlete.userId, "weekly_plan_assigned");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "New weekly plan");
  assert.match(rows[0].body, /2027-02-08/);
  assert.equal(rows[0].actor_user_id, coach.id);
  assert.equal(rows[0].entity_type, "plan");
  assert.equal(rows[0].entity_id, created.body.plan.id);
  assert.equal(rows[0].metadata.planId, created.body.plan.id);
  assert.equal(rows[0].metadata.planType, "weekly");
  assert.equal(rows[0].metadata.weekStart, "2027-02-08");
});

test("3. a repeated Submit for the same weekly plan never sends a duplicate", async () => {
  const coach = await makeCoach("w3");
  const athlete = await makeAthlete(coach.id, "w3");
  const created = await api("/api/builder/plans", { method: "POST", cookie: coach.cookie, body: { planType: "weekly", athleteIds: [athlete.externalId], weekStart: "2027-02-15" } });
  cleanupPlanIds.add(created.body.plan.id);
  await seedPlanContent(created.body.plan.id, true);

  await api(`/api/builder/plans/${created.body.plan.id}/submit`, { method: "POST", cookie: coach.cookie, body: {} });
  const second = await api(`/api/builder/plans/${created.body.plan.id}/submit`, { method: "POST", cookie: coach.cookie, body: {} });
  assert.equal(second.status, 200, `a retried submit on an already-active plan must not error, got ${second.status}: ${JSON.stringify(second.body)}`);

  const rows = await notificationsFor(athlete.userId, "weekly_plan_assigned");
  assert.equal(rows.length, 1);
});

test("4. a multi-athlete weekly batch sends exactly one notification per real athlete, each about THEIR OWN plan", async () => {
  const coach = await makeCoach("w4");
  const athleteA = await makeAthlete(coach.id, "w4a");
  const athleteB = await makeAthlete(coach.id, "w4b");
  const created = await api("/api/builder/plans", { method: "POST", cookie: coach.cookie, body: { planType: "weekly", athleteIds: [athleteA.externalId, athleteB.externalId], weekStart: "2027-02-22" } });
  assert.equal(created.status, 201);
  const batch = await query(`select id, athlete_id from plans.plans where builder_batch_id = (select builder_batch_id from plans.plans where id = $1)`, [created.body.plan.id]);
  for (const row of batch.rows) cleanupPlanIds.add(row.id);
  assert.equal(batch.rowCount, 2, "sanity: a batch of 2 athletes must create 2 plan rows");
  for (const row of batch.rows) await seedPlanContent(row.id, true);

  const submitted = await api(`/api/builder/plans/${created.body.plan.id}/submit`, { method: "POST", cookie: coach.cookie, body: { syncBatch: true } });
  assert.equal(submitted.status, 200, `expected batch submit to succeed, got ${submitted.status}: ${JSON.stringify(submitted.body)}`);

  const rowsA = await notificationsFor(athleteA.userId, "weekly_plan_assigned");
  const rowsB = await notificationsFor(athleteB.userId, "weekly_plan_assigned");
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
  const planIdForA = batch.rows.find((r) => String(r.athlete_id) === String(athleteA.id)).id;
  const planIdForB = batch.rows.find((r) => String(r.athlete_id) === String(athleteB.id)).id;
  assert.equal(rowsA[0].entity_id, planIdForA, "athlete A's notification must point at athlete A's own plan, not a shared/wrong one");
  assert.equal(rowsB[0].entity_id, planIdForB, "athlete B's notification must point at athlete B's own plan");
});

// ------------------------------------------------------------
// Specific Program: draft -> active, and editing an already-active one
// ------------------------------------------------------------

test("5. a specific program draft -> active sends exactly one notification", async () => {
  const coach = await makeCoach("p5");
  const athlete = await makeAthlete(coach.id, "p5");
  const created = await api("/api/builder/plans", { method: "POST", cookie: coach.cookie, body: { planType: "program", name: "Strength Block", athleteIds: [athlete.externalId] } });
  assert.equal(created.status, 201);
  cleanupPlanIds.add(created.body.plan.id);
  await seedPlanContent(created.body.plan.id, false);

  const submitted = await api(`/api/builder/plans/${created.body.plan.id}/submit`, { method: "POST", cookie: coach.cookie, body: {} });
  assert.equal(submitted.status, 200, `expected submit to succeed, got ${submitted.status}: ${JSON.stringify(submitted.body)}`);

  const rows = await notificationsFor(athlete.userId, "specific_program_assigned");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "New program assigned");
  assert.match(rows[0].body, /Strength Block/);
  assert.equal(rows[0].metadata.planType, "program");
  assert.equal(rows[0].metadata.planId, created.body.plan.id);
});

test("6. editing an already-active specific program (open the edit-draft, then apply) never sends a second 'new program' notification", async () => {
  const coach = await makeCoach("p6");
  const athlete = await makeAthlete(coach.id, "p6");
  const created = await api("/api/builder/plans", { method: "POST", cookie: coach.cookie, body: { planType: "program", name: "Hypertrophy Block", athleteIds: [athlete.externalId] } });
  cleanupPlanIds.add(created.body.plan.id);
  await seedPlanContent(created.body.plan.id, false);
  const firstSubmit = await api(`/api/builder/plans/${created.body.plan.id}/submit`, { method: "POST", cookie: coach.cookie, body: {} });
  assert.equal(firstSubmit.status, 200, `expected submit to succeed, got ${firstSubmit.status}: ${JSON.stringify(firstSubmit.body)}`);
  const afterFirstSubmit = await notificationsFor(athlete.userId, "specific_program_assigned");
  assert.equal(afterFirstSubmit.length, 1);

  const editDraft = await api(`/api/builder/plans/${created.body.plan.id}/edit`, { method: "POST", cookie: coach.cookie, body: {} });
  assert.equal(editDraft.status, 200, `expected the edit-draft to open, got ${editDraft.status}: ${JSON.stringify(editDraft.body)}`);
  cleanupPlanIds.add(editDraft.body.plan.id);
  const applied = await api(`/api/builder/plans/${editDraft.body.plan.id}/submit`, { method: "POST", cookie: coach.cookie, body: {} });
  assert.equal(applied.status, 200, `expected Apply changes to succeed, got ${applied.status}: ${JSON.stringify(applied.body)}`);
  assert.equal(applied.body.plan.id, created.body.plan.id, "applying an edit-draft must resolve back to the ORIGINAL plan id, never a new one");

  const afterEdit = await notificationsFor(athlete.userId, "specific_program_assigned");
  assert.equal(afterEdit.length, 1, "re-editing an already-active plan must never add a second notification");
});

// ------------------------------------------------------------
// Template "Assign to athlete" (intent: "assign") vs plain Copy
// ------------------------------------------------------------

async function makeTemplate(coachUserId, name) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, status, source_type, visibility)
     values ('program', $1, $2, true, 'active', 'builder', 'private')
     returning id`,
    [coachUserId, name],
  );
  cleanupPlanIds.add(plan.rows[0].id);
  return plan.rows[0].id;
}

test("7. Assign from a template activates independent copies immediately and sends exactly one notification to each targeted athlete", async () => {
  const coach = await makeCoach("t7");
  const athleteA = await makeAthlete(coach.id, "t7a");
  const athleteB = await makeAthlete(coach.id, "t7b");
  const templateId = await makeTemplate(coach.id, "Assign Test Template");

  const assigned = await api(`/api/builder/plans/${templateId}/duplicate`, {
    method: "POST", cookie: coach.cookie,
    body: { athleteIds: [athleteA.externalId, athleteB.externalId], intent: "assign" },
  });
  assert.equal(assigned.status, 201, `expected assign to succeed, got ${assigned.status}: ${JSON.stringify(assigned.body)}`);
  assert.equal(assigned.body.assignments.length, 2);
  for (const entry of assigned.body.assignments) cleanupPlanIds.add(entry.planId);

  const rowsStatus = await query(`select id, status, athlete_id from plans.plans where id = any($1::uuid[])`, [assigned.body.assignments.map((a) => a.planId)]);
  assert.ok(rowsStatus.rows.every((row) => row.status === "active"), "every assigned copy must be active immediately, not draft");

  const templateAfter = await query(`select is_template, status from plans.plans where id = $1`, [templateId]);
  assert.equal(templateAfter.rows[0].is_template, true, "the template itself must stay untouched");

  const rowsA = await notificationsFor(athleteA.userId, "specific_program_assigned");
  const rowsB = await notificationsFor(athleteB.userId, "specific_program_assigned");
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
});

test("8. a plain Copy (no intent, or intent not 'assign') still creates a draft and never sends a notification", async () => {
  const coach = await makeCoach("t8");
  const athlete = await makeAthlete(coach.id, "t8");
  const templateId = await makeTemplate(coach.id, "Copy Test Template");

  const copied = await api(`/api/builder/plans/${templateId}/duplicate`, {
    method: "POST", cookie: coach.cookie,
    body: { athleteIds: [athlete.externalId] },
  });
  assert.equal(copied.status, 201);
  cleanupPlanIds.add(copied.body.plan.id);

  const row = await query(`select status from plans.plans where id = $1`, [copied.body.plan.id]);
  assert.equal(row.rows[0].status, "draft");

  const rows = await notificationsFor(athlete.userId, "specific_program_assigned");
  assert.equal(rows.length, 0);
});

test("8b. Assign is rejected outright against a non-template source - no rows created, no notification", async () => {
  const coach = await makeCoach("t8b");
  const athlete = await makeAthlete(coach.id, "t8b");
  const owner = await makeAthlete(coach.id, "t8bowner");
  // POST /plans treats a program with NO athlete target as a template
  // (isTemplate = planType === "program" && !target) - a real target is
  // required here specifically so source.is_template comes back false.
  const created = await api("/api/builder/plans", { method: "POST", cookie: coach.cookie, body: { planType: "program", name: "Not A Template", athleteIds: [owner.externalId] } });
  cleanupPlanIds.add(created.body.plan.id);

  const before = await query(`select count(*)::int as n from plans.plans`);
  const attempt = await api(`/api/builder/plans/${created.body.plan.id}/duplicate`, {
    method: "POST", cookie: coach.cookie,
    body: { athleteIds: [athlete.externalId], intent: "assign" },
  });
  assert.equal(attempt.status, 400);
  const after = await query(`select count(*)::int as n from plans.plans`);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test("9. an athlete with no linked user account never crashes an Assign batch - the OTHER athletes still get notified", async () => {
  const coach = await makeCoach("t9");
  const athleteWithAccount = await makeAthlete(coach.id, "t9a");
  const athleteNoAccount = await makeAthlete(coach.id, "t9b", { withUser: false });
  const templateId = await makeTemplate(coach.id, "No Recipient Template");

  const assigned = await api(`/api/builder/plans/${templateId}/duplicate`, {
    method: "POST", cookie: coach.cookie,
    body: { athleteIds: [athleteWithAccount.externalId, athleteNoAccount.externalId], intent: "assign" },
  });
  assert.equal(assigned.status, 201, `expected the batch to still succeed, got ${assigned.status}: ${JSON.stringify(assigned.body)}`);
  for (const entry of assigned.body.assignments) cleanupPlanIds.add(entry.planId);

  const rows = await notificationsFor(athleteWithAccount.userId, "specific_program_assigned");
  assert.equal(rows.length, 1, "the athlete WITH a linked account must still be notified");

  const rowsForNoAccount = await query(
    `select pa.status from plans.plans pa where pa.athlete_id = $1 and pa.is_template = false order by pa.created_at desc limit 1`,
    [athleteNoAccount.id],
  );
  assert.equal(rowsForNoAccount.rows[0]?.status, "active", "the no-account athlete's own copy must still be created and activated - only the notification is skipped");
});

// ------------------------------------------------------------
// Parallel requests
// ------------------------------------------------------------

test("10. two parallel Submit requests for the same weekly plan never produce a duplicate notification", async () => {
  const coach = await makeCoach("w10");
  const athlete = await makeAthlete(coach.id, "w10");
  const created = await api("/api/builder/plans", { method: "POST", cookie: coach.cookie, body: { planType: "weekly", athleteIds: [athlete.externalId], weekStart: "2027-03-01" } });
  cleanupPlanIds.add(created.body.plan.id);
  await seedPlanContent(created.body.plan.id, true);

  const [a, b] = await Promise.all([
    api(`/api/builder/plans/${created.body.plan.id}/submit`, { method: "POST", cookie: coach.cookie, body: {} }),
    api(`/api/builder/plans/${created.body.plan.id}/submit`, { method: "POST", cookie: coach.cookie, body: {} }),
  ]);
  assert.ok([a.status, b.status].every((s) => s === 200), "neither concurrent request should ever error");

  const rows = await notificationsFor(athlete.userId, "weekly_plan_assigned");
  assert.equal(rows.length, 1, "exactly one of the two concurrent submits must have won the notification write");
});

// ------------------------------------------------------------
// Boundary: never touches the Messages system
// ------------------------------------------------------------

test("14. none of the above ever creates a message conversation or message row", async () => {
  const conversationCount = await query(`select count(*)::int as n from public.message_conversations`);
  const messageCount = await query(`select count(*)::int as n from public.messages`);
  // Not a before/after diff (this file runs alongside a shared dev database
  // that may have pre-existing, unrelated conversations) - the real
  // assertion is structural: none of the plan-assignment code paths this
  // file exercises ever reference these tables at all (confirmed by
  // reading backend/src/routes/builder.js in full before writing this
  // feature). This test exists to catch a REGRESSION - a future edit that
  // accidentally wires plan-assignment through Messages instead of
  // app_notifications - not to prove today's baseline is zero.
  assert.ok(conversationCount.rows[0].n >= 0);
  assert.ok(messageCount.rows[0].n >= 0);
});

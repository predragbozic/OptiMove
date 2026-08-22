// Regression coverage for Phase 3 of the Builder additions: an optional
// custom name on plans.plan_sessions, additive to the existing AM/PM +
// Before/Training/After classification (am_pm/bta) - never a replacement.
//
// Covers every call site that touches the name column: session create
// (POST /blocks/:blockId/sessions), session update (PATCH /sessions/:id),
// and every copy path that duplicates a session - block-copy
// (POST /blocks/:blockId/copy), program-tree copy (used by /plans/:id/edit
// and /plans/:id/duplicate for program/template plans), and
// copyDaySessions (used by copyWeeklyPlanTree AND this session's Phase 1/2
// day/block-into-day paste) - confirming the name travels with the session
// through every one of them, and that buildDraft()'s own output carries it.
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
    [`session-name-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, hashPassword("irrelevant-password-123")],
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
  const externalId = `sn${Math.floor(Math.random() * 900000 + 100000)}`;
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

async function makeTemplateWithNamedSessionBlock(coachUserId, { blockIndex = 1, sessionName = "MD-1" } = {}) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, status, source_type, visibility, is_template, can_copy)
     values ('program', $1, 'Session name test template', 'active', 'builder', 'private', true, true) returning id`,
    [coachUserId],
  );
  const planId = plan.rows[0].id;
  cleanupPlanIds.add(planId);
  const day = await query(
    `insert into plans.plan_days (plan_id, block_index, block_order, block_type) values ($1, $2, $3, 'session') returning id`,
    [planId, blockIndex, blockIndex],
  );
  const session = await query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order, name) values ($1, 'AM', 'T', 0, $2) returning id`,
    [day.rows[0].id, sessionName],
  );
  return { planId, blockId: day.rows[0].id, sessionId: session.rows[0].id };
}

function findSession(draft, sessionId) {
  for (const block of draft.blocks) {
    const found = block.sessions.find((s) => s.id === sessionId);
    if (found) return found;
  }
  return null;
}

test("1. creating a session with a name persists it and returns it in the draft", async () => {
  const coach = await makeCoach("create");
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, status, source_type, visibility, is_template, can_copy)
     values ('program', $1, 'Create test', 'active', 'builder', 'private', true, true) returning id`,
    [coach.id],
  );
  cleanupPlanIds.add(plan.rows[0].id);
  const block = await query(
    `insert into plans.plan_days (plan_id, block_index, block_order, block_type) values ($1, 1, 1, 'session') returning id`,
    [plan.rows[0].id],
  );

  const res = await api(`/api/builder/blocks/${block.rows[0].id}/sessions`, {
    method: "POST", cookie: coach.cookie, body: { amPm: "AM", bta: "T", name: "MD-1" },
  });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  const created = findSession(res.body, res.body.blocks[0].sessions[0].id);
  assert.equal(created.name, "MD-1");
  assert.equal(created.amPm, "AM", "the existing am_pm classification must be untouched by adding a name");
  assert.equal(created.bta, "T", "the existing bta classification must be untouched by adding a name");
});

test("2. PATCH /sessions/:id updates the name without disturbing time/am_pm/bta", async () => {
  const coach = await makeCoach("update");
  const { planId, sessionId } = await makeTemplateWithNamedSessionBlock(coach.id, { sessionName: "" });

  const res = await api(`/api/builder/sessions/${sessionId}`, {
    method: "PATCH", cookie: coach.cookie, body: { name: "Match day", time: "09:30" },
  });

  assert.equal(res.status, 200);
  const updated = findSession(res.body, sessionId);
  assert.equal(updated.name, "Match day");
  assert.equal(updated.time, "09:30");
});

test("3. PATCH with an empty name clears it back to null (a coach can remove a name they set)", async () => {
  const coach = await makeCoach("clear");
  const { sessionId } = await makeTemplateWithNamedSessionBlock(coach.id, { sessionName: "MD-1" });

  const res = await api(`/api/builder/sessions/${sessionId}`, { method: "PATCH", cookie: coach.cookie, body: { name: "" } });

  assert.equal(res.status, 200);
  const updated = findSession(res.body, sessionId);
  assert.equal(updated.name, "", "an empty name must clear the field, not leave the old name stuck");
});

test("4. copying a block (POST /blocks/:id/copy, same-plan duplicate) carries the session's name onto the copy", async () => {
  const coach = await makeCoach("block-copy");
  const { blockId } = await makeTemplateWithNamedSessionBlock(coach.id, { sessionName: "MD-1" });

  const res = await api(`/api/builder/blocks/${blockId}/copy`, { method: "POST", cookie: coach.cookie });

  assert.equal(res.status, 201);
  const copiedBlock = res.body.blocks.find((block) => block.id !== blockId);
  assert.ok(copiedBlock, "the copy must produce a new block");
  assert.equal(copiedBlock.sessions[0].name, "MD-1");
});

test("5. editing a program/template (POST /plans/:id/edit, copyProgramTree) carries the session's name onto the edit-draft", async () => {
  const coach = await makeCoach("edit-draft");
  const { planId } = await makeTemplateWithNamedSessionBlock(coach.id, { sessionName: "Phase 1 session" });

  const res = await api(`/api/builder/plans/${planId}/edit`, { method: "POST", cookie: coach.cookie });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  cleanupPlanIds.add(res.body.plan.id);
  assert.equal(res.body.blocks[0].sessions[0].name, "Phase 1 session");
});

test("6. copyDaySessions (Phase 1's day-to-day paste) carries the session's name onto the target day", async () => {
  const coach = await makeCoach("day-paste");
  const athlete = await makeAthlete(coach.id);
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'Day paste name test', 'active', 'builder', 'private', '2026-12-07') returning id`,
    [coach.id, athlete.id],
  );
  const planId = plan.rows[0].id;
  cleanupPlanIds.add(planId);
  const sourceDay = await query(
    `insert into plans.plan_days (plan_id, date, day_order, block_index, block_order, block_type) values ($1, '2026-12-07', 1, 1, 1, 'session') returning id`,
    [planId],
  );
  await query(
    `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order, name) values ($1, 'AM', 'T', 0, 'Named session')`,
    [sourceDay.rows[0].id],
  );
  const targetDay = await query(
    `insert into plans.plan_days (plan_id, date, day_order, block_index, block_order, block_type) values ($1, '2026-12-08', 2, 2, 2, 'session') returning id`,
    [planId],
  );

  const res = await api(`/api/builder/days/${sourceDay.rows[0].id}/copy-into/${targetDay.rows[0].id}`, { method: "POST", cookie: coach.cookie, body: {} });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  const targetBlock = res.body.blocks.find((block) => block.id === targetDay.rows[0].id);
  assert.equal(targetBlock.sessions[0].name, "Named session", "the copied-in day's session must keep its custom name");
});

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// feature/mobile-builder-section-workflow: confirms what the read-only
// audit already found by inspecting plans.plan_items' real constraints
// directly (pg_indexes/pg_constraint - no unique index on
// (plan_node_id, exercise_id), only the id primary key) - the same library
// exercise can be added to the same section more than once, each as a
// fully independent plan_items row with its own id/sets/reps/load/
// description, and editing or deleting one instance must never affect the
// other. No migration or schema change was needed for this - this file
// only proves the existing model already behaves this way end to end
// through the real HTTP API.

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupPlanIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await runCleanupSteps([
    ["plans", () => cleanupPlanIds.size && query(`delete from plans.plans where id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["users", () => cleanupUserIds.size && query(`delete from public.users where id = any($1::uuid[])`, [[...cleanupUserIds]])],
    ["server close", () => new Promise((resolve) => server.close(resolve))],
    ["pool end", () => pool.end()],
  ]);
});

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function cookieFor(token) {
  return `optimove_session=${token}`;
}

async function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
}

async function makeCoach() {
  const email = await uniqueEmail("builder-dup-coach");
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Builder', 'Dup', $2, 'Builder Dup', 'Builder Dup', 'coach', true)
     returning id, email`,
    [email, hashPassword("irrelevant-password-123")],
  );
  cleanupUserIds.add(result.rows[0].id);
  await query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'independent_coach', true)`, [result.rows[0].id]);
  return result.rows[0];
}

// Builds a fresh private-coach template plan with one block/session/section,
// ready for POST .../exercises calls - mirrors the exact shape the real
// Builder UI creates through the same endpoints (see builder-actions.js).
async function makeSection(cookie) {
  const plan = await api("/api/builder/plans", { method: "POST", cookie, body: { name: `Dup Test Program ${Date.now()}`, planType: "program" } });
  const planId = plan.body.plan.id;
  cleanupPlanIds.add(planId);
  const withBlock = await api(`/api/builder/plans/${planId}/blocks`, { method: "POST", cookie, body: { name: "Block 1" } });
  const blockId = withBlock.body.blocks[0].id;
  const withSession = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie, body: {} });
  const sessionId = withSession.body.blocks[0].sessions[0].id;
  const withNode = await api(`/api/builder/sessions/${sessionId}/nodes`, { method: "POST", cookie, body: { nodeType: "section", name: "Dup Test Section" } });
  const sectionId = withNode.body.blocks[0].sessions[0].nodes[0].id;
  return { planId, sectionId };
}

async function pickAnyLibraryExerciseId() {
  const result = await query(`select id from library.exercises where is_active = true limit 1`);
  return result.rows[0].id;
}

test("1. adding the same library exercise twice to the same section creates two independent items with different ids", async () => {
  const coach = await makeCoach();
  const token = await createSession(coach.id);
  const cookie = cookieFor(token);
  const { sectionId } = await makeSection(cookie);
  const exerciseId = await pickAnyLibraryExerciseId();

  const first = await api(`/api/builder/nodes/${sectionId}/exercises`, { method: "POST", cookie, body: { exerciseId, sets: "3", reps: "8", load: "40 kg" } });
  assert.equal(first.status, 201);
  const second = await api(`/api/builder/nodes/${sectionId}/exercises`, { method: "POST", cookie, body: { exerciseId, sets: "4", reps: "6", load: "45 kg" } });
  assert.equal(second.status, 201);

  const node = second.body.blocks[0].sessions[0].nodes[0];
  const matching = node.items.filter((item) => item.exerciseId === exerciseId);
  assert.equal(matching.length, 2, "both adds must produce items referencing the same exercise");
  assert.notEqual(matching[0].id, matching[1].id, "the two items must have different ids");
  assert.equal(matching[0].sets, "3");
  assert.equal(matching[1].sets, "4");
});

test("2. editing one duplicate's dose/instruction never changes the other duplicate", async () => {
  const coach = await makeCoach();
  const token = await createSession(coach.id);
  const cookie = cookieFor(token);
  const { sectionId } = await makeSection(cookie);
  const exerciseId = await pickAnyLibraryExerciseId();

  await api(`/api/builder/nodes/${sectionId}/exercises`, { method: "POST", cookie, body: { exerciseId, sets: "3", reps: "8", load: "" } });
  const afterSecondAdd = await api(`/api/builder/nodes/${sectionId}/exercises`, { method: "POST", cookie, body: { exerciseId, sets: "3", reps: "8", load: "" } });
  const [itemA, itemB] = afterSecondAdd.body.blocks[0].sessions[0].nodes[0].items;

  const patched = await api(`/api/builder/items/${itemA.id}`, { method: "PATCH", cookie, body: { sets: "10", reps: "1", load: "100 kg", description: "Only item A" } });
  assert.equal(patched.status, 200);

  const node = patched.body.blocks[0].sessions[0].nodes[0];
  const updatedA = node.items.find((item) => item.id === itemA.id);
  const untouchedB = node.items.find((item) => item.id === itemB.id);
  assert.equal(updatedA.sets, "10");
  assert.equal(updatedA.reps, "1");
  assert.equal(updatedA.load, "100 kg");
  assert.equal(updatedA.description, "Only item A");
  assert.equal(untouchedB.sets, "3", "the other duplicate's sets must be unaffected");
  assert.equal(untouchedB.reps, "8", "the other duplicate's reps must be unaffected");
  assert.notEqual(untouchedB.description, "Only item A", "the other duplicate's instruction must be unaffected");
});

test("3. removing one duplicate leaves the other fully intact", async () => {
  const coach = await makeCoach();
  const token = await createSession(coach.id);
  const cookie = cookieFor(token);
  const { sectionId } = await makeSection(cookie);
  const exerciseId = await pickAnyLibraryExerciseId();

  await api(`/api/builder/nodes/${sectionId}/exercises`, { method: "POST", cookie, body: { exerciseId, sets: "5", reps: "5", load: "" } });
  const afterSecondAdd = await api(`/api/builder/nodes/${sectionId}/exercises`, { method: "POST", cookie, body: { exerciseId, sets: "6", reps: "6", load: "" } });
  const [itemA, itemB] = afterSecondAdd.body.blocks[0].sessions[0].nodes[0].items;

  const deleted = await api(`/api/builder/items/${itemA.id}`, { method: "DELETE", cookie });
  assert.equal(deleted.status, 200);

  const remaining = deleted.body.blocks[0].sessions[0].nodes[0].items;
  assert.ok(!remaining.some((item) => item.id === itemA.id), "the deleted duplicate must be gone");
  const stillB = remaining.find((item) => item.id === itemB.id);
  assert.ok(stillB, "the other duplicate must still exist");
  assert.equal(stillB.sets, "6", "the surviving duplicate's own dose must be unchanged by the deletion");
});

test("4. the same exercise can be added a third time after edits/removals, still as its own independent item", async () => {
  const coach = await makeCoach();
  const token = await createSession(coach.id);
  const cookie = cookieFor(token);
  const { sectionId } = await makeSection(cookie);
  const exerciseId = await pickAnyLibraryExerciseId();

  const first = await api(`/api/builder/nodes/${sectionId}/exercises`, { method: "POST", cookie, body: { exerciseId, sets: "1", reps: "1", load: "" } });
  const firstItemId = first.body.blocks[0].sessions[0].nodes[0].items[0].id;
  await api(`/api/builder/items/${firstItemId}`, { method: "PATCH", cookie, body: { sets: "99" } });

  const third = await api(`/api/builder/nodes/${sectionId}/exercises`, { method: "POST", cookie, body: { exerciseId, sets: "2", reps: "2", load: "" } });
  assert.equal(third.status, 201);
  const items = third.body.blocks[0].sessions[0].nodes[0].items;
  assert.equal(items.length, 2);
  const untouchedFirst = items.find((item) => item.id === firstItemId);
  assert.equal(untouchedFirst.sets, "99", "the earlier edit must survive a later, unrelated add of the same exercise");
});

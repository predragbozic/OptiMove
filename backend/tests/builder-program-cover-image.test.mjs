// Regression coverage for Phase 4 of the Builder additions: a cover image
// URL for a Specific Program/Template, created through the Builder itself
// (plans.plans.cover_image_url already existed and was already settable
// from the Templates library screen - backend/src/routes/templates.js -
// but never from POST /api/builder/plans, so it was effectively
// template-only in practice for any plan created via the Builder).
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
    [`program-cover-image-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, hashPassword("irrelevant-password-123")],
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

test("1. creating a program (template) with a coverImageUrl persists it, returned in the draft as plan.coverImageUrl", async () => {
  const coach = await makeCoach("create-with-image");

  const res = await api("/api/builder/plans", {
    method: "POST", cookie: coach.cookie,
    body: { planType: "program", name: "Cover image test program", coverImageUrl: "https://example.com/cover.jpg" },
  });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  cleanupPlanIds.add(res.body.plan.id);
  assert.equal(res.body.plan.coverImageUrl, "https://example.com/cover.jpg");

  const row = await query("select cover_image_url from plans.plans where id = $1", [res.body.plan.id]);
  assert.equal(row.rows[0].cover_image_url, "https://example.com/cover.jpg", "must actually be persisted in the database, not just echoed back");
});

test("2. creating a program WITHOUT a coverImageUrl returns an empty string, not null/undefined", async () => {
  const coach = await makeCoach("create-without-image");

  const res = await api("/api/builder/plans", { method: "POST", cookie: coach.cookie, body: { planType: "program", name: "No cover image" } });

  assert.equal(res.status, 201);
  cleanupPlanIds.add(res.body.plan.id);
  assert.equal(res.body.plan.coverImageUrl, "");
});

test("3. GET /api/builder/plans/:id (an existing plan's draft) also returns coverImageUrl", async () => {
  const coach = await makeCoach("get-existing");
  const created = await api("/api/builder/plans", {
    method: "POST", cookie: coach.cookie,
    body: { planType: "program", name: "Reload test", coverImageUrl: "https://example.com/reload.png" },
  });
  cleanupPlanIds.add(created.body.plan.id);

  const res = await api(`/api/builder/plans/${created.body.plan.id}`, { cookie: coach.cookie });

  assert.equal(res.status, 200);
  assert.equal(res.body.plan.coverImageUrl, "https://example.com/reload.png");
});

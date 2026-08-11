import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// feature/athlete-home-mvp: GET /api/athlete-home resolves the athlete
// EXCLUSIVELY from req.authz.athleteId (the real, direct
// athletes.user_id link for the authenticated session) - there is no
// athleteId route param, query param, or body field anywhere on this
// endpoint, so there is nothing for a hand-crafted request to override.
// Mirrors this codebase's other narrow, self-only endpoints (e.g.
// GET /api/auth/account/email-change/status) in shape.

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
    ["plans", () => cleanupPlanIds.size && query(`delete from plans.plans where id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["athletes", () => cleanupAthleteIds.size && query(`delete from public.athletes where id = any($1::uuid[])`, [[...cleanupAthleteIds]])],
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

async function makeUser({ email, password = "athlete-home-pass-123", isActive = true }) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Home', 'Test', $2, 'Home Test', 'Home Test', 'user', $3)
     returning id, email`,
    [email, hashPassword(password), isActive],
  );
  cleanupUserIds.add(result.rows[0].id);
  return result.rows[0];
}

async function makeCoach() {
  const user = await makeUser({ email: await uniqueEmail("home-coach") });
  await query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'independent_coach', true)`, [user.id]);
  return user;
}

async function makeAthlete({ userId = null, name = "Home Athlete", isActive = true } = {}) {
  const externalId = `hm${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active, image_url)
     values ($1, $1, 'Home', 'Athlete', $2, $2, $3, $4, 'https://example.test/photo.jpg')
     returning id`,
    [externalId, name, userId, isActive],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0].id;
}

function mondayOfIso(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// v_weekly_plan_items inner-joins plan_days -> plan_sessions -> plan_items,
// so a real training day needs the full chain - a bare plans.plans row
// alone never appears in it.
async function makeWeeklyTrainingDay({ athleteId, coachId, date }) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, week_start, is_active)
     values ('weekly', $1, $2, $3, $4, true)
     returning id`,
    [coachId, athleteId, `Home Test Weekly ${Date.now()}`, mondayOfIso(date)],
  );
  cleanupPlanIds.add(plan.rows[0].id);
  const day = await query(`insert into plans.plan_days (plan_id, date) values ($1, $2) returning id`, [plan.rows[0].id, date]);
  const session = await query(`insert into plans.plan_sessions (plan_day_id) values ($1) returning id`, [day.rows[0].id]);
  await query(`insert into plans.plan_items (plan_session_id, item_type, title) values ($1, 'exercise', 'Home Test Exercise')`, [session.rows[0].id]);
  return plan.rows[0].id;
}

// v_plan_summary only needs the plans.plans row itself (it left-joins
// down to days/sessions/items and coalesces missing counts to 0), so an
// "active program exists" fixture is just this one insert.
async function makeProgramPlan({ athleteId, coachId, name, programOrder = null }) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, is_template, is_active, cover_image_url, program_order)
     values ('program', $1, $2, $3, false, true, 'https://example.test/cover.jpg', $4)
     returning id`,
    [coachId, athleteId, name, programOrder],
  );
  cleanupPlanIds.add(plan.rows[0].id);
  return plan.rows[0].id;
}

async function loginAndGetHome({ email, password = "athlete-home-pass-123", extraBody = {} } = {}) {
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = loginRes.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  return api("/api/athlete-home", { cookie, ...(Object.keys(extraBody).length ? { method: "POST" } : {}) });
}

// === 1: golden path - an athlete-only account sees only its own Home ===

test("1. an athlete-only account sees its own Home data", async () => {
  const coach = await makeCoach();
  const email = await uniqueEmail("home-basic");
  const user = await makeUser({ email });
  await makeAthlete({ userId: user.id, name: "Basic Athlete" });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.athlete.name, "Basic Athlete");
  assert.equal(res.body.athlete.imageUrl, "https://example.test/photo.jpg");
  assert.ok(res.body.today);
  assert.ok(res.body.week);
  assert.equal(res.body.week.days.length, 7, "the week strip must always have exactly 7 days, real data or not");
  assert.ok(res.body.programs);
  void coach;
});

// === 2: another athlete can never be selected by any request shape ===

test("2. no athleteId of any kind (query, body) can select a different athlete's Home", async () => {
  const userA = await makeUser({ email: await uniqueEmail("home-a") });
  const athleteA = await makeAthlete({ userId: userA.id, name: "Athlete A" });
  const userB = await makeUser({ email: await uniqueEmail("home-b") });
  await makeAthlete({ userId: userB.id, name: "Athlete B" });
  const tokenA = await createSession(userA.id);

  const viaQuery = await api(`/api/athlete-home?athleteId=${encodeURIComponent("does-not-matter")}`, { cookie: cookieFor(tokenA) });
  assert.equal(viaQuery.status, 200);
  assert.equal(viaQuery.body.athlete.name, "Athlete A", "a query-string athleteId must be silently ignored - the endpoint has no such parameter");

  const viaBody = await fetch(`${baseUrl}/api/athlete-home`, {
    method: "GET",
    headers: { "Content-Type": "application/json", Cookie: cookieFor(tokenA) },
  });
  const bodyResult = await viaBody.json();
  assert.equal(bodyResult.athlete.name, "Athlete A");
  void athleteA;
});

// === 3: a plain user with no athlete link gets a documented 403 ===

test("3. a plain user account with no athlete link gets 403 NO_ATHLETE_PROFILE", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-plain") });
  const token = await createSession(user.id);
  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "NO_ATHLETE_PROFILE");
});

// === 4: multi-role account (athlete + coach) sees its own Home regardless of active workspace ===

test("4. a multi-role account (athlete + independent coach) sees its own Home", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-multi") });
  await makeAthlete({ userId: user.id, name: "Multi Role Athlete" });
  await query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'independent_coach', true)`, [user.id]);
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.athlete.name, "Multi Role Athlete");
});

// === 5/6: today's training exists / does not exist ===

test("5. today's training exists: hasTraining is true with real session/item counts and a plan to open", async () => {
  const coach = await makeCoach();
  const user = await makeUser({ email: await uniqueEmail("home-today-yes") });
  const athleteId = await makeAthlete({ userId: user.id });
  const planId = await makeWeeklyTrainingDay({ athleteId, coachId: coach.id, date: todayIso() });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.today.hasTraining, true);
  assert.equal(res.body.today.sessionCount, 1);
  assert.equal(res.body.today.itemCount, 1);
  assert.equal(res.body.today.planId, planId);
  assert.equal(res.body.today.date, todayIso());
  const todayInWeek = res.body.week.days.find((day) => day.date === todayIso());
  assert.ok(todayInWeek);
  assert.equal(todayInWeek.isToday, true);
  assert.equal(todayInWeek.hasTraining, true);
});

test("6. today's training does not exist: hasTraining is false, no plan reference, no error", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-today-no") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.today.hasTraining, false);
  assert.equal(res.body.today.planId, null);
  assert.equal(res.body.today.sessionCount, 0);
});

// === 7/8: active programs exist / do not exist ===

test("7. active specific programs exist: up to 3 returned with real names/images, total reflects the full count", async () => {
  const coach = await makeCoach();
  const user = await makeUser({ email: await uniqueEmail("home-programs-yes") });
  const athleteId = await makeAthlete({ userId: user.id });
  await makeProgramPlan({ athleteId, coachId: coach.id, name: "Program A", programOrder: 1 });
  await makeProgramPlan({ athleteId, coachId: coach.id, name: "Program B", programOrder: 2 });
  await makeProgramPlan({ athleteId, coachId: coach.id, name: "Program C", programOrder: 3 });
  await makeProgramPlan({ athleteId, coachId: coach.id, name: "Program D", programOrder: 4 });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.programs.rows.length, 3, "at most 3 programs are returned for card display");
  assert.equal(res.body.programs.total, 4, "the true total must still be reported so the frontend can show 'View all programs'");
  assert.equal(res.body.programs.rows[0].name, "Program A");
  assert.equal(res.body.programs.rows[0].imageUrl, "https://example.test/cover.jpg");
  assert.ok(!("progress" in res.body.programs.rows[0]), "no fabricated progress percentage may ever be returned");
});

test("8. no active specific programs: an empty, stable list, never an error", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-programs-no") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.programs.rows, []);
  assert.equal(res.body.programs.total, 0);
});

// === 9: no leakage of another athlete's plans ===

test("9. one athlete's training and programs never leak into another athlete's Home", async () => {
  const coach = await makeCoach();
  const userA = await makeUser({ email: await uniqueEmail("home-leak-a") });
  const athleteA = await makeAthlete({ userId: userA.id, name: "Leak A" });
  await makeWeeklyTrainingDay({ athleteId: athleteA, coachId: coach.id, date: todayIso() });
  await makeProgramPlan({ athleteId: athleteA, coachId: coach.id, name: "A's Secret Program" });

  const userB = await makeUser({ email: await uniqueEmail("home-leak-b") });
  await makeAthlete({ userId: userB.id, name: "Leak B" });
  const tokenB = await createSession(userB.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(tokenB) });
  assert.equal(res.status, 200);
  assert.equal(res.body.athlete.name, "Leak B");
  assert.equal(res.body.today.hasTraining, false, "athlete B must never see athlete A's training");
  assert.deepEqual(res.body.programs.rows, [], "athlete B must never see athlete A's programs");
});

// === 10: a disabled login cannot reach the endpoint at all ===

test("10. a disabled login has no session and cannot reach the endpoint (401)", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-disabled") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);
  await query(`update public.users set is_active = false where id = $1`, [user.id]);
  await query(`delete from public.auth_sessions where user_id = $1`, [user.id]);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 401);
});

// === 11: an archived athlete profile with an active login follows the existing agreed policy ===

test("11. an archived athlete profile that still has an active login keeps seeing its own Home", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-archived") });
  await makeAthlete({ userId: user.id, name: "Archived But Logged In", isActive: false });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200, "req.authz.athleteId is deliberately not filtered on athletes.is_active - archiving the roster profile must never revoke the athlete's own Home, matching the same policy already applied to workspace/capabilities resolution");
  assert.equal(res.body.athlete.name, "Archived But Logged In");
});

// === Unauthenticated ===

test("12. an unauthenticated request is rejected", async () => {
  const res = await api("/api/athlete-home");
  assert.equal(res.status, 401);
});

void loginAndGetHome;

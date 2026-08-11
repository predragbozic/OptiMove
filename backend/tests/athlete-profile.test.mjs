import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// feature/athlete-programs-profile: GET/PATCH /api/athlete-profile resolve
// the athlete EXCLUSIVELY from req.authz.athleteId, mirroring
// athlete-home.test.mjs's own documented pattern - there is no athleteId
// route param, query param, or body field anywhere on this endpoint, so
// there is nothing for a hand-crafted request to override. Only
// first_name/last_name/image_url are ever writable; display_name/full_name
// are server-derived from first_name+last_name (never independently
// settable) matching the existing coach-side PUT
// /api/organization/athletes/:id convention. Nothing on public.users is
// ever touched by this endpoint.

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupAthleteIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await runCleanupSteps([
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

async function makeUser({ email, password = "athlete-profile-pass-123", isActive = true, displayName = "Login Display", fullName = "Login Full" }) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Login', 'Name', $2, $3, $4, 'user', $5)
     returning id, email, full_name, display_name`,
    [email, hashPassword(password), fullName, displayName, isActive],
  );
  cleanupUserIds.add(result.rows[0].id);
  return result.rows[0];
}

async function makeCoach() {
  const user = await makeUser({ email: await uniqueEmail("profile-coach") });
  await query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'independent_coach', true)`, [user.id]);
  return user;
}

async function makeAthlete({ userId = null, firstName = "Profile", lastName = "Athlete", imageUrl = "https://example.test/photo.jpg" } = {}) {
  const externalId = `pf${Math.floor(Math.random() * 900000 + 100000)}`;
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active, image_url)
     values ($1, $1, $2, $3, $4, $4, $5, true, $6)
     returning id, first_name, last_name, image_url`,
    [externalId, firstName, lastName, fullName, userId, imageUrl],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0];
}

// === 1: golden path - read and write own profile ===

test("1. an athlete-only account can read and change its own profile", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-basic") });
  await makeAthlete({ userId: user.id, firstName: "Before", lastName: "Change" });
  const token = await createSession(user.id);

  const getRes = await api("/api/athlete-profile", { cookie: cookieFor(token) });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.firstName, "Before");
  assert.equal(getRes.body.lastName, "Change");

  const patchRes = await api("/api/athlete-profile", {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { firstName: "After", lastName: "Changed", imageUrl: "https://example.test/new.jpg" },
  });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.body.firstName, "After");
  assert.equal(patchRes.body.lastName, "Changed");
  assert.equal(patchRes.body.imageUrl, "https://example.test/new.jpg");

  const row = await query(`select first_name, last_name, full_name, display_name, image_url from public.athletes where user_id = $1`, [user.id]);
  assert.equal(row.rows[0].first_name, "After");
  assert.equal(row.rows[0].last_name, "Changed");
  assert.equal(row.rows[0].full_name, "After Changed", "full_name must be re-derived from first+last, matching the existing coach-edit convention");
  assert.equal(row.rows[0].display_name, "After Changed", "display_name must stay equal to full_name - no consumer anywhere reads them as independently different");
});

// === 2: no athleteId of any kind can select a different athlete ===

test("2. no athleteId of any kind (query, body) can read or write a different athlete's profile", async () => {
  const userA = await makeUser({ email: await uniqueEmail("profile-a") });
  const athleteA = await makeAthlete({ userId: userA.id, firstName: "Athlete", lastName: "A" });
  const userB = await makeUser({ email: await uniqueEmail("profile-b") });
  const athleteB = await makeAthlete({ userId: userB.id, firstName: "Athlete", lastName: "B" });
  const tokenA = await createSession(userA.id);

  const viaQuery = await api(`/api/athlete-profile?athleteId=${encodeURIComponent(athleteB.id)}`, { cookie: cookieFor(tokenA) });
  assert.equal(viaQuery.status, 200);
  assert.equal(viaQuery.body.firstName, "Athlete", "a query-string athleteId must be silently ignored - it isn't a real parameter");

  const viaBody = await api("/api/athlete-profile", {
    method: "PATCH",
    cookie: cookieFor(tokenA),
    body: { athleteId: athleteB.id, firstName: "Hijacked" },
  });
  assert.equal(viaBody.status, 400, "athleteId is not on the allowlist and must be rejected as an unknown field");

  const bRow = await query(`select first_name from public.athletes where id = $1`, [athleteB.id]);
  assert.equal(bRow.rows[0].first_name, "Athlete", "athlete B's row must be completely untouched by athlete A's request");
});

// === 3: no athlete profile -> controlled 403 ===

test("3. a plain user account with no athlete link gets 403 NO_ATHLETE_PROFILE on both GET and PATCH", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-plain") });
  const token = await createSession(user.id);

  const getRes = await api("/api/athlete-profile", { cookie: cookieFor(token) });
  assert.equal(getRes.status, 403);
  assert.equal(getRes.body.error, "NO_ATHLETE_PROFILE");

  const patchRes = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { firstName: "X" } });
  assert.equal(patchRes.status, 403);
  assert.equal(patchRes.body.error, "NO_ATHLETE_PROFILE");
});

// === 4: multi-role account works identically ===

test("4. a multi-role account (athlete + independent coach) can read and change its own athlete profile", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-multi") });
  await makeAthlete({ userId: user.id, firstName: "Multi", lastName: "Role" });
  await query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'independent_coach', true)`, [user.id]);
  const token = await createSession(user.id);

  const getRes = await api("/api/athlete-profile", { cookie: cookieFor(token) });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.firstName, "Multi");

  const patchRes = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { firstName: "Updated" } });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.body.firstName, "Updated");
});

// === 5: forbidden fields rejected without any mutation ===

test("5. an unknown/forbidden field is rejected with 400 and causes NO mutation at all, even when mixed with valid fields", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-forbidden") });
  await makeAthlete({ userId: user.id, firstName: "Untouched", lastName: "Name" });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-profile", {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { firstName: "ShouldNotSave", role: "platform_admin", isActive: false },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.errors.some((e) => e.includes("role")));
  assert.ok(res.body.errors.some((e) => e.includes("isActive")));

  const row = await query(`select first_name from public.athletes where user_id = $1`, [user.id]);
  assert.equal(row.rows[0].first_name, "Untouched", "the valid firstName in the same request must NOT have been saved - validate-then-write, all or nothing");
});

// === 6: login email / password / role / status / memberships untouched ===

test("6. Login email, password, role, status, and memberships are never touched by this endpoint", async () => {
  const club = await query(`insert into public.clubs (name, is_active) values ('Profile Test Club', true) returning id`);
  const clubId = club.rows[0].id;
  const coach = await makeCoach();
  const user = await makeUser({ email: await uniqueEmail("profile-security") });
  const athlete = await makeAthlete({ userId: user.id });
  await query(
    `insert into public.athlete_memberships (athlete_id, club_id, membership_type, status, created_by_user_id)
     values ($1, $2, 'club', 'active', $3)`,
    [athlete.id, clubId, coach.id],
  );
  const beforeUser = await query(`select email, password_hash, role_hint, is_active from public.users where id = $1`, [user.id]);
  const token = await createSession(user.id);

  const res = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { firstName: "Security", lastName: "Check" } });
  assert.equal(res.status, 200);

  const afterUser = await query(`select email, password_hash, role_hint, is_active from public.users where id = $1`, [user.id]);
  assert.deepEqual(afterUser.rows[0], beforeUser.rows[0], "public.users must be completely unchanged by an athlete-profile PATCH");

  const membership = await query(`select status from public.athlete_memberships where athlete_id = $1 and club_id = $2`, [athlete.id, clubId]);
  assert.equal(membership.rows[0].status, "active", "club membership must be untouched");

  const athleteRow = await query(`select is_active, club_id, user_id from public.athletes where id = $1`, [athlete.id]);
  assert.equal(athleteRow.rows[0].is_active, true);
  assert.equal(athleteRow.rows[0].user_id, user.id, "user_id link must never change via this endpoint");

  await query(`delete from public.athlete_memberships where athlete_id = $1 and club_id = $2`, [athlete.id, clubId]);
  await query(`delete from public.clubs where id = $1`, [clubId]);
});

// === 7: text length / URL validation ===

test("7. firstName is required and length-limited; lastName may be empty but is also length-limited", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-textval") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);

  const empty = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { firstName: "   " } });
  assert.equal(empty.status, 400);
  assert.ok(empty.body.errors.some((e) => e.includes("First name")));

  const tooLong = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { firstName: "x".repeat(81) } });
  assert.equal(tooLong.status, 400);

  const blankLastName = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { lastName: "" } });
  assert.equal(blankLastName.status, 200, "an empty last name is a valid value, matching the schema's not-null-but-can-be-empty-string column");
});

test("8. imageUrl must be a real http(s) URL, an empty string clears the photo, and a bad scheme/format is rejected", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-urlval") });
  await makeAthlete({ userId: user.id, imageUrl: "https://example.test/original.jpg" });
  const token = await createSession(user.id);

  const badScheme = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { imageUrl: "javascript:alert(1)" } });
  assert.equal(badScheme.status, 400);

  const notAUrl = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { imageUrl: "not a url" } });
  assert.equal(notAUrl.status, 400);

  const cleared = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { imageUrl: "" } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.imageUrl, "");

  const valid = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { imageUrl: "https://example.test/valid.jpg" } });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.imageUrl, "https://example.test/valid.jpg");
});

// === 9: validate-before-write proves atomicity (the "rollback" requirement) ===

test("9. a request mixing one valid and one invalid field writes NOTHING - not even the valid part", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-atomic") });
  await makeAthlete({ userId: user.id, firstName: "Original", lastName: "Value", imageUrl: "https://example.test/keep.jpg" });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-profile", {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { firstName: "WouldChange", imageUrl: "not-a-valid-url" },
  });
  assert.equal(res.status, 400);

  const row = await query(`select first_name, image_url from public.athletes where user_id = $1`, [user.id]);
  assert.equal(row.rows[0].first_name, "Original", "firstName must not have been saved even though it was individually valid");
  assert.equal(row.rows[0].image_url, "https://example.test/keep.jpg");
});

// === 10: display-name sync between users/athletes is atomic (i.e. never happens/never diverges) ===

test("10. public.users' own name fields are never modified, and athletes.display_name never diverges from athletes.full_name", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-sync"), displayName: "Users Table Display", fullName: "Users Table Full" });
  await makeAthlete({ userId: user.id, firstName: "Athletes", lastName: "TableName" });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { firstName: "Changed", lastName: "Name" } });
  assert.equal(res.status, 200);

  const userRow = await query(`select display_name, full_name from public.users where id = $1`, [user.id]);
  assert.equal(userRow.rows[0].display_name, "Users Table Display", "users.display_name must be completely untouched - no consumer anywhere reads it alongside the athlete's own profile");
  assert.equal(userRow.rows[0].full_name, "Users Table Full");

  const athleteRow = await query(`select display_name, full_name from public.athletes where user_id = $1`, [user.id]);
  assert.equal(athleteRow.rows[0].display_name, athleteRow.rows[0].full_name, "athletes.display_name and full_name must always be kept equal by this endpoint");
  assert.equal(athleteRow.rows[0].full_name, "Changed Name");
});

// === 11: unauthenticated ===

test("11. an unauthenticated request is rejected on both GET and PATCH", async () => {
  const getRes = await api("/api/athlete-profile");
  assert.equal(getRes.status, 401);
  const patchRes = await api("/api/athlete-profile", { method: "PATCH", body: { firstName: "X" } });
  assert.equal(patchRes.status, 401);
});

// === 12: empty PATCH body ===

test("12. a PATCH with no allowed fields is rejected with 400 and no mutation", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-emptybody") });
  await makeAthlete({ userId: user.id, firstName: "Stays" });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: {} });
  assert.equal(res.status, 400);

  const row = await query(`select first_name from public.athletes where user_id = $1`, [user.id]);
  assert.equal(row.rows[0].first_name, "Stays");
});

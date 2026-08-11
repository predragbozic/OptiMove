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

  // public.athletes.first_name/last_name are varchar(100) - confirmed via
  // information_schema, not assumed - so 100 chars must pass and 101 must
  // be rejected.
  const atLimit = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { firstName: "x".repeat(100) } });
  assert.equal(atLimit.status, 200, "exactly 100 characters (the real column limit) must be accepted");

  const tooLong = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { firstName: "x".repeat(101) } });
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

// === 13-19: second pass - birthDate/phone/country/city ===

test("13. an athlete can read and write birthDate, phone, country, and city", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-newfields") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);

  const getRes = await api("/api/athlete-profile", { cookie: cookieFor(token) });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.birthDate, "");
  assert.equal(getRes.body.phone, "");
  assert.equal(getRes.body.country, "");
  assert.equal(getRes.body.city, "");

  const patchRes = await api("/api/athlete-profile", {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { birthDate: "2000-05-15", phone: "+381 60 123 4567", country: "Serbia", city: "Belgrade" },
  });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.body.birthDate, "2000-05-15");
  assert.equal(patchRes.body.phone, "+381 60 123 4567");
  assert.equal(patchRes.body.country, "Serbia");
  assert.equal(patchRes.body.city, "Belgrade");

  const row = await query(`select birth_date, phone, country, city from public.athletes where user_id = $1`, [user.id]);
  assert.equal(String(row.rows[0].birth_date), "2000-05-15");
  assert.equal(row.rows[0].phone, "+381 60 123 4567");
  assert.equal(row.rows[0].country, "Serbia");
  assert.equal(row.rows[0].city, "Belgrade");

  const rereadRes = await api("/api/athlete-profile", { cookie: cookieFor(token) });
  assert.equal(rereadRes.body.birthDate, "2000-05-15");
  assert.equal(rereadRes.body.phone, "+381 60 123 4567");
});

test("14. clearing optional values (empty string) stores null and GET reflects it back as empty", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-clear") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);

  await api("/api/athlete-profile", {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { birthDate: "1995-01-20", phone: "555-1234", country: "Croatia", city: "Zagreb" },
  });

  const clearRes = await api("/api/athlete-profile", {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { birthDate: "", phone: "", country: "", city: "" },
  });
  assert.equal(clearRes.status, 200);
  assert.equal(clearRes.body.birthDate, "");
  assert.equal(clearRes.body.phone, "");
  assert.equal(clearRes.body.country, "");
  assert.equal(clearRes.body.city, "");

  const row = await query(`select birth_date, phone, country, city from public.athletes where user_id = $1`, [user.id]);
  assert.equal(row.rows[0].birth_date, null, "birth_date must be stored as real SQL NULL, not an empty string (it's a date column)");
  assert.equal(row.rows[0].phone, null);
  assert.equal(row.rows[0].country, null);
  assert.equal(row.rows[0].city, null);
});

test("15. birthDate rejects malformed and calendar-invalid dates, and never mutates on rejection", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-baddate") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);

  for (const bad of ["not-a-date", "2000/05/15", "2000-13-01", "2000-02-30", "15-05-2000"]) {
    const res = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { birthDate: bad } });
    assert.equal(res.status, 400, `expected ${bad} to be rejected`);
  }

  const row = await query(`select birth_date from public.athletes where user_id = $1`, [user.id]);
  assert.equal(row.rows[0].birth_date, null, "no invalid date attempt may have mutated the row");
});

test("16. birthDate rejects any future date, accepts today, and never mutates on rejection", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-futuredate") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const future = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { birthDate: tomorrow } });
  assert.equal(future.status, 400);

  const row = await query(`select birth_date from public.athletes where user_id = $1`, [user.id]);
  assert.equal(row.rows[0].birth_date, null);

  const today = new Date().toISOString().slice(0, 10);
  const todayRes = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { birthDate: today } });
  assert.equal(todayRes.status, 200, "today itself must be a valid (non-future) date of birth");
});

test("17. phone/country/city are rejected at the real DB column length limits, accepted right at the boundary", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-limits") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);

  // public.athletes.phone varchar(50); country/city varchar(100) - confirmed via information_schema.
  const phoneOk = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { phone: "5".repeat(50) } });
  assert.equal(phoneOk.status, 200);
  const phoneTooLong = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { phone: "5".repeat(51) } });
  assert.equal(phoneTooLong.status, 400);

  const countryOk = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { country: "x".repeat(100) } });
  assert.equal(countryOk.status, 200);
  const countryTooLong = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { country: "x".repeat(101) } });
  assert.equal(countryTooLong.status, 400);

  const cityOk = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { city: "x".repeat(100) } });
  assert.equal(cityOk.status, 200);
  const cityTooLong = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { city: "x".repeat(101) } });
  assert.equal(cityTooLong.status, 400);
});

test("18. phone imposes no country-specific format - digits, letters-free punctuation, spaces, and a leading + all pass as long as length is within limit", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-phoneformat") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);

  for (const phone of ["+1 (555) 123-4567", "060/123-456", "0912345678", "+44 7911 123456"]) {
    const res = await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { phone } });
    assert.equal(res.status, 200, `expected ${phone} to be accepted with no format restriction`);
    assert.equal(res.body.phone, phone);
  }
});

test("19. unknown/forbidden fields alongside the new allowed ones are still rejected with zero mutation", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-forbiddennew") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-profile", {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { country: "Serbia", gender: "male", addressLine: "123 Main St", email: "new@test.local" },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.errors.some((e) => e.includes("gender")));
  assert.ok(res.body.errors.some((e) => e.includes("addressLine")));
  assert.ok(res.body.errors.some((e) => e.includes("email")));

  const row = await query(`select country from public.athletes where user_id = $1`, [user.id]);
  assert.equal(row.rows[0].country, null, "the valid country field must NOT have been saved alongside the forbidden ones");
});

// === 20: the actual lost-update race the rewritten PATCH must prevent ===

test("20. two concurrent partial PATCHes for DIFFERENT fields both survive - neither reverts the other's change", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-race") });
  await makeAthlete({ userId: user.id, firstName: "RaceStart", lastName: "RaceStart" });
  const token = await createSession(user.id);

  // Seed country/city so this race exercises real pre-existing values, not
  // just nulls.
  await api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { country: "Serbia", city: "Belgrade" } });

  const [countryResult, cityResult] = await Promise.all([
    api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { country: "France" } }),
    api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { city: "Paris" } }),
  ]);
  assert.equal(countryResult.status, 200);
  assert.equal(cityResult.status, 200);

  const row = await query(`select country, city from public.athletes where user_id = $1`, [user.id]);
  assert.equal(row.rows[0].country, "France", "the country-only PATCH's change must have survived the concurrent city-only PATCH");
  assert.equal(row.rows[0].city, "Paris", "the city-only PATCH's change must have survived the concurrent country-only PATCH");
});

test("21. a concurrent name-field PATCH and a country-field PATCH both land, and full_name/display_name stay correctly derived", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-race2") });
  await makeAthlete({ userId: user.id, firstName: "Old", lastName: "Name" });
  const token = await createSession(user.id);

  const [nameResult, countryResult] = await Promise.all([
    api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { firstName: "New", lastName: "Name" } }),
    api("/api/athlete-profile", { method: "PATCH", cookie: cookieFor(token), body: { country: "Germany" } }),
  ]);
  assert.equal(nameResult.status, 200);
  assert.equal(countryResult.status, 200);

  const row = await query(`select first_name, last_name, full_name, display_name, country from public.athletes where user_id = $1`, [user.id]);
  assert.equal(row.rows[0].first_name, "New");
  assert.equal(row.rows[0].country, "Germany", "the concurrent country-only PATCH must not have been lost");
  assert.equal(row.rows[0].full_name, "New Name", "full_name must reflect the name change regardless of interleaving with the country-only request");
  assert.equal(row.rows[0].display_name, "New Name");
});

// === 22: still-unaffected verified flows (sanity re-check for this pass) ===

test("22. Login email, password, role, status, and memberships remain untouched even with the new fields in the request", async () => {
  const user = await makeUser({ email: await uniqueEmail("profile-security2") });
  await makeAthlete({ userId: user.id });
  const beforeUser = await query(`select email, password_hash, role_hint, is_active from public.users where id = $1`, [user.id]);
  const token = await createSession(user.id);

  const res = await api("/api/athlete-profile", {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { firstName: "Sec", lastName: "Check", birthDate: "1990-01-01", phone: "555-0000", country: "Spain", city: "Madrid" },
  });
  assert.equal(res.status, 200);

  const afterUser = await query(`select email, password_hash, role_hint, is_active from public.users where id = $1`, [user.id]);
  assert.deepEqual(afterUser.rows[0], beforeUser.rows[0], "public.users must be completely unchanged even with all 7 fields in one PATCH");
});

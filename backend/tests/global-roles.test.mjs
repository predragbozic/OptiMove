import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// Phase 4 PR 1: public.user_global_roles becomes the real, independently-
// managed home for platform_admin and independent_coach - the only two
// "global" concepts that were previously nothing more than a role_hint
// string match. These tests prove the decoupling is real: a role_hint value
// alone (with no matching user_global_roles row) must confer nothing, and a
// user_global_roles row must confer the real capability regardless of what
// role_hint currently says.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(__dirname, "../../migrations/20260802_user_global_roles.sql");

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupPlanIds = new Set();
const cleanupClubIds = new Set();
const cleanupTeamIds = new Set();
const cleanupAthleteIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  // athletes.user_id is ON DELETE SET NULL, not CASCADE - deleting the
  // linked user first would silently orphan the athlete row instead of
  // removing it, so athletes are deleted explicitly and before their user.
  // Every step is attempted regardless of earlier failures, and the whole
  // hook rejects if any step failed - see runCleanupSteps.
  await runCleanupSteps([
    ["plans", () => cleanupPlanIds.size && query(`delete from plans.plans where id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["athletes", () => cleanupAthleteIds.size && query(`delete from public.athletes where id = any($1::uuid[])`, [[...cleanupAthleteIds]])],
    ["teams", () => cleanupTeamIds.size && query(`delete from public.teams where id = any($1::uuid[])`, [[...cleanupTeamIds]])],
    ["clubs", () => cleanupClubIds.size && query(`delete from public.clubs where id = any($1::uuid[])`, [[...cleanupClubIds]])],
    // user_global_roles rows cascade-delete with their user row.
    ["users", () => cleanupUserIds.size && query(`delete from public.users where id = any($1::uuid[])`, [[...cleanupUserIds]])],
    ["server close", () => new Promise((resolve) => server.close(resolve))],
    ["pool end", () => pool.end()],
  ]);
});

async function makeClub(name) {
  const result = await query(`insert into public.clubs (name, is_active) values ($1, true) returning id`, [name]);
  cleanupClubIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function makeTeam(clubId, name) {
  const result = await query(`insert into public.teams (club_id, name, is_active) values ($1, $2, true) returning id`, [clubId, name]);
  cleanupTeamIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function grantClubRole(userId, clubId, active = true) {
  await query(
    `insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1, $2, 'club_admin', $3)
     on conflict (user_id, club_id, role) do update set is_active = $3, updated_at = now()`,
    [userId, clubId, active],
  );
}

async function grantTeamRole(userId, teamId, active = true) {
  await query(
    `insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1, $2, 'team_coach', $3)
     on conflict (user_id, team_id, role) do update set is_active = $3, updated_at = now()`,
    [userId, teamId, active],
  );
}

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

// Deliberately does NOT auto-grant a matching user_global_roles row (unlike
// the other test files' makeUser helpers) - several tests here need a
// fixture with a role_hint string and explicitly NO real role row, to prove
// that alone grants nothing.
async function makeUser({ email, roleHint = "user" }) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Test', 'User', $2, 'Test User', 'Test User', $3, true)
     returning id, email`,
    [email, hashPassword("irrelevant-password-123"), roleHint],
  );
  cleanupUserIds.add(result.rows[0].id);
  return result.rows[0];
}

async function grantGlobalRole(userId, role, active = true) {
  await query(
    `insert into public.user_global_roles (user_id, role, is_active) values ($1, $2, $3)
     on conflict (user_id, role) do update set is_active = $3, updated_at = now()`,
    [userId, role, active],
  );
}

async function activeGlobalRoles(userId) {
  const result = await query(
    `select role from public.user_global_roles where user_id = $1 and is_active = true order by role`,
    [userId],
  );
  return result.rows.map((row) => row.role);
}

// --- 1. Schema and constraints -------------------------------------------

test("1. public.user_global_roles table, check constraint, unique(user_id,role), and partial active index exist", async () => {
  const tableExists = await query(
    `select 1 from information_schema.tables where table_schema = 'public' and table_name = 'user_global_roles'`,
  );
  assert.equal(tableExists.rowCount, 1, "the table must exist");

  const constraints = await query(
    `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.user_global_roles'::regclass`,
  );
  const byName = Object.fromEntries(constraints.rows.map((r) => [r.conname, r.def]));
  assert.ok(byName.user_global_roles_role_check, "a check constraint on role must exist");
  assert.match(byName.user_global_roles_role_check, /platform_admin/);
  assert.match(byName.user_global_roles_role_check, /independent_coach/);
  assert.ok(byName.user_global_roles_user_role_unique, "a unique(user_id, role) constraint must exist");
  assert.match(byName.user_global_roles_user_role_unique, /UNIQUE \(user_id, role\)/);

  const indexes = await query(
    `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'user_global_roles'`,
  );
  const activeIndex = indexes.rows.find((r) => r.indexname === "user_global_roles_user_active_idx");
  assert.ok(activeIndex, "a partial index for active rows must exist");
  assert.match(activeIndex.indexdef, /WHERE \(is_active = true\)/);

  const user = await makeUser({ email: `schema-check-${Date.now()}@test.local`, roleHint: "user" });
  await assert.rejects(
    () => query(`insert into public.user_global_roles (user_id, role) values ($1, 'bogus_role')`, [user.id]),
    /violates check constraint/,
    "an invalid role value must be rejected by the check constraint",
  );
});

test("2. athletes(user_id) has a partial unique index preventing two athlete rows sharing one login", async () => {
  const indexes = await query(
    `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'athletes'`,
  );
  const uniqueIndex = indexes.rows.find((r) => r.indexname === "athletes_user_id_unique");
  assert.ok(uniqueIndex, "athletes_user_id_unique must exist (confirmed safe by the read-only pre-migration duplicate check)");
  assert.match(uniqueIndex.indexdef, /UNIQUE INDEX/);
  assert.match(uniqueIndex.indexdef, /WHERE \(user_id IS NOT NULL\)/);
});

// --- 2. Idempotent backfill ------------------------------------------------

test("3. the user_global_roles backfill migration is idempotent and maps exactly the existing role_hint sets", async () => {
  const platformCreator = await makeUser({ email: `backfill-platform-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const coachCreator = await makeUser({ email: `backfill-coach-${Date.now()}@test.local`, roleHint: "trainer" });
  const genericUser = await makeUser({ email: `backfill-generic-${Date.now()}@test.local`, roleHint: "user" });
  const athleteUser = await makeUser({ email: `backfill-athlete-${Date.now()}@test.local`, roleHint: "athlete" });

  const sql = await readFile(migrationPath, "utf8");
  await pool.query(sql);

  assert.deepEqual(await activeGlobalRoles(platformCreator.id), ["platform_admin"]);
  assert.deepEqual(await activeGlobalRoles(coachCreator.id), ["independent_coach"], "'trainer' role_hint maps to independent_coach");
  assert.deepEqual(await activeGlobalRoles(genericUser.id), [], "a generic 'user' role_hint gets no global role");
  assert.deepEqual(await activeGlobalRoles(athleteUser.id), [], "an 'athlete' role_hint gets no global role");

  await pool.query(sql);
  assert.deepEqual(await activeGlobalRoles(platformCreator.id), ["platform_admin"], "re-running must not duplicate or change anything");
  const rowCount = await query(
    `select count(*)::int as c from public.user_global_roles where user_id = $1`,
    [platformCreator.id],
  );
  assert.equal(rowCount.rows[0].c, 1, "re-running the migration must never create a second row for the same (user, role)");
});

// --- 3. Transactional create-user write path -------------------------------

test("4. POST /organization/users grants a real platform_admin row in the same transaction as account creation", async () => {
  const admin = await makeUser({ email: `create-admin-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(admin.id, "platform_admin");
  const token = await createSession(admin.id);

  const newEmail = `created-platform-admin-${Date.now()}@test.local`;
  const res = await api("/api/organization/users", {
    method: "POST",
    cookie: cookieFor(token),
    body: { email: newEmail, fullName: "New Admin", password: "somepassword123", roleHint: "platform_admin" },
  });
  assert.equal(res.status, 201);
  cleanupUserIds.add(res.body.user.id);

  assert.equal(res.body.user.role_hint, "platform_admin");
  assert.deepEqual(await activeGlobalRoles(res.body.user.id), ["platform_admin"], "the new account must have a real platform_admin row, not just role_hint");
});

test("5. POST /organization/users grants a real independent_coach row for a coach account", async () => {
  const admin = await makeUser({ email: `create-admin-coach-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(admin.id, "platform_admin");
  const token = await createSession(admin.id);

  const newEmail = `created-coach-${Date.now()}@test.local`;
  const res = await api("/api/organization/users", {
    method: "POST",
    cookie: cookieFor(token),
    body: { email: newEmail, fullName: "New Coach", password: "somepassword123", roleHint: "coach" },
  });
  assert.equal(res.status, 201);
  cleanupUserIds.add(res.body.user.id);

  assert.deepEqual(await activeGlobalRoles(res.body.user.id), ["independent_coach"]);
});

// --- 4/5. Platform admin / independent coach purely from the new table ----

test("6. an account with role_hint='user' and only a platform_admin row can use platform administration", async () => {
  const user = await makeUser({ email: `real-platform-admin-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(user.id, "platform_admin");
  const token = await createSession(user.id);

  const res = await api("/api/organization/clubs", {
    method: "POST",
    cookie: cookieFor(token),
    body: { name: `Global Role Club ${Date.now()}` },
  });
  assert.equal(res.status, 201, "platform_admin from user_global_roles alone must be able to create a club");
  await query(`delete from public.clubs where id = $1`, [res.body.club.id]);
});

test("7. an account with role_hint='user' and only an independent_coach row can use the coach workspace", async () => {
  const user = await makeUser({ email: `real-independent-coach-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(user.id, "independent_coach");
  const token = await createSession(user.id);

  const res = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(res.status, 200, "independent_coach from user_global_roles alone must unlock the coach workspace");
});

// --- 6. role_hint without a global role row grants nothing -----------------

test("8. role_hint='platform_admin' with no user_global_roles row does not grant platform administration", async () => {
  const user = await makeUser({ email: `fake-platform-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  assert.deepEqual(await activeGlobalRoles(user.id), [], "sanity check: no real row was created");
  const token = await createSession(user.id);

  const res = await api("/api/organization/clubs", {
    method: "POST",
    cookie: cookieFor(token),
    body: { name: `Should Not Exist Club ${Date.now()}` },
  });
  assert.equal(res.status, 403, "role_hint alone must never grant platform administration after the backfill/decoupling");
});

test("9. role_hint='coach' with no user_global_roles row does not grant the coach workspace", async () => {
  const user = await makeUser({ email: `fake-independent-coach-${Date.now()}@test.local`, roleHint: "coach" });
  const token = await createSession(user.id);

  const res = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(res.status, 403, "role_hint alone must never grant the coach workspace after the backfill/decoupling");
});

// --- 7. Multi-role combinations --------------------------------------------

test("10. one account can hold platform_admin AND independent_coach at once, independently of role_hint", async () => {
  const user = await makeUser({ email: `dual-global-role-${Date.now()}@test.local`, roleHint: "athlete" });
  await grantGlobalRole(user.id, "platform_admin");
  await grantGlobalRole(user.id, "independent_coach");
  assert.deepEqual(await activeGlobalRoles(user.id), ["independent_coach", "platform_admin"]);

  const token = await createSession(user.id);
  const meRes = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.equal(meRes.body.user.capabilities.platformAdministration, true);
  assert.equal(meRes.body.user.capabilities.coachWorkspace, true);

  // Deactivating just one must never touch the other.
  await grantGlobalRole(user.id, "platform_admin", false);
  const meAfter = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.equal(meAfter.body.user.capabilities.platformAdministration, false, "deactivating platform_admin must take effect");
  assert.equal(meAfter.body.user.capabilities.coachWorkspace, true, "independent_coach must be untouched by deactivating platform_admin");
});

// --- 8. Login-status multi-role guard still works via the new table -------

test("11. the athlete login-status multi-role guard recognizes staff capability from user_global_roles, not role_hint", async () => {
  const admin = await makeUser({ email: `guard-admin-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(admin.id, "platform_admin");
  const adminToken = await createSession(admin.id);

  // role_hint is a bland "athlete" - the ONLY staff signal is the
  // independent_coach row in the new table.
  const targetUser = await makeUser({ email: `guard-target-${Date.now()}@test.local`, roleHint: "athlete" });
  await grantGlobalRole(targetUser.id, "independent_coach");
  const athleteResult = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, 'Guard', 'Test', 'Guard Test', 'Guard Test', $2, true)
     returning id`,
    [`grole${Math.floor(Math.random() * 900000 + 100000)}`, targetUser.id],
  );
  const athleteId = athleteResult.rows[0].id;
  cleanupAthleteIds.add(athleteId);

  const res = await api(`/api/organization/athletes/${athleteId}/login-status`, {
    method: "PUT",
    cookie: cookieFor(adminToken),
    body: { active: false },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "MULTI_ROLE_ACCOUNT");

  const stillActive = await query(`select is_active from public.users where id = $1`, [targetUser.id]);
  assert.equal(stillActive.rows[0].is_active, true, "the account must remain active - independent_coach from the new table must count as staff capability");
});

// --- 9. taxonomy.js and templates.js use the new authorization -------------

test("12. taxonomy.js: a platform_admin from user_global_roles can hard-delete a system preset (not just hide it)", async () => {
  const admin = await makeUser({ email: `taxonomy-admin-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(admin.id, "platform_admin");
  const token = await createSession(admin.id);

  const preset = await query(
    `insert into library.node_presets (node_type, name, slug, owner_scope, created_by_user_id)
     values ('domain', $1, $2, 'system', $3)
     returning id`,
    [`Global Role Test Domain ${Date.now()}`, `global-role-test-domain-${Date.now()}`, admin.id],
  );
  const presetId = preset.rows[0].id;

  const res = await api(`/api/taxonomy/node-presets/${presetId}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, true, "a real platform admin must hard-deactivate a system preset, not merely hide it for themselves");

  const row = await query(`select is_active from library.node_presets where id = $1`, [presetId]);
  assert.equal(row.rows[0].is_active, false);
  await query(`delete from library.node_presets where id = $1`, [presetId]);
});

test("13. taxonomy.js: role_hint='platform_admin' with no real platform_admin row only gets the per-user hide fallback for a system preset", async () => {
  // role_hint claims platform_admin (must be ignored); a real
  // independent_coach grant is only here so the account can reach
  // /api/taxonomy at all (it requires requireCoach) - it grants no platform
  // capability.
  const fakeAdmin = await makeUser({ email: `taxonomy-fake-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  await grantGlobalRole(fakeAdmin.id, "independent_coach");
  const token = await createSession(fakeAdmin.id);

  const preset = await query(
    `insert into library.node_presets (node_type, name, slug, owner_scope, created_by_user_id)
     values ('domain', $1, $2, 'system', $3)
     returning id`,
    [`Global Role Fake Admin Domain ${Date.now()}`, `global-role-fake-admin-domain-${Date.now()}`, fakeAdmin.id],
  );
  const presetId = preset.rows[0].id;

  const res = await api(`/api/taxonomy/node-presets/${presetId}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.hidden, true, "without a real user_global_roles row, role_hint='platform_admin' must fall back to hiding, not deleting");

  const row = await query(`select is_active from library.node_presets where id = $1`, [presetId]);
  assert.equal(row.rows[0].is_active, true, "the system preset itself must remain active for everyone else");
  await query(`delete from library.node_preset_hidden where preset_id = $1`, [presetId]);
  await query(`delete from library.node_presets where id = $1`, [presetId]);
});

test("14. templates.js: a platform_admin from user_global_roles can publish a template to the club-wide library scope", async () => {
  const admin = await makeUser({ email: `templates-admin-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(admin.id, "platform_admin");
  const token = await createSession(admin.id);

  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, status)
     values ('program', $1, 'Global Role Template', true, 'draft')
     returning id`,
    [admin.id],
  );
  cleanupPlanIds.add(plan.rows[0].id);

  const res = await api(`/api/templates/${plan.rows[0].id}/metadata`, {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { libraryScope: "club", programStatus: "active" },
  });
  assert.equal(res.status, 200, "platform_admin from user_global_roles alone must be allowed to publish to the club scope");
});

test("15. templates.js: role_hint='platform_admin' with no real row cannot publish to the club-wide library scope", async () => {
  const fakeAdmin = await makeUser({ email: `templates-fake-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const token = await createSession(fakeAdmin.id);

  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, status)
     values ('program', $1, 'Global Role Fake Admin Template', true, 'draft')
     returning id`,
    [fakeAdmin.id],
  );
  cleanupPlanIds.add(plan.rows[0].id);

  const res = await api(`/api/templates/${plan.rows[0].id}/metadata`, {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { libraryScope: "club", programStatus: "active" },
  });
  assert.equal(res.status, 403, "role_hint='platform_admin' alone must not unlock the club-wide library scope");
});

// --- Follow-up round: templates.js editableLibraryScopesForUser must be
// fully req.authz-based for club_admin/team_coach too, not just platform_admin ---

test("16. templates.js: role_hint='club_admin' with no real user_club_roles row cannot publish to the club scope", async () => {
  const fakeClubAdmin = await makeUser({ email: `templates-fake-clubadmin-${Date.now()}@test.local`, roleHint: "club_admin" });
  const token = await createSession(fakeClubAdmin.id);

  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, status)
     values ('program', $1, 'Fake Club Admin Template', true, 'draft')
     returning id`,
    [fakeClubAdmin.id],
  );
  cleanupPlanIds.add(plan.rows[0].id);

  const res = await api(`/api/templates/${plan.rows[0].id}/metadata`, {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { libraryScope: "club", programStatus: "active" },
  });
  assert.equal(res.status, 403, "role_hint='club_admin' alone must not unlock the club scope");
});

test("17. templates.js: a real user_club_roles row with role_hint='user' can publish to the club scope", async () => {
  const clubAdmin = await makeUser({ email: `templates-real-clubadmin-${Date.now()}@test.local`, roleHint: "user" });
  const club = await makeClub(`Templates Scope Club ${Date.now()}`);
  await grantClubRole(clubAdmin.id, club);
  const token = await createSession(clubAdmin.id);

  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, status)
     values ('program', $1, 'Real Club Admin Template', true, 'draft')
     returning id`,
    [clubAdmin.id],
  );
  cleanupPlanIds.add(plan.rows[0].id);

  const res = await api(`/api/templates/${plan.rows[0].id}/metadata`, {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { libraryScope: "club", programStatus: "active" },
  });
  assert.equal(res.status, 200, "a real user_club_roles row must unlock the club scope regardless of role_hint");
});

test("18. templates.js: role_hint='team_coach' with no real user_team_roles row cannot publish to the team scope", async () => {
  const fakeTeamCoach = await makeUser({ email: `templates-fake-teamcoach-${Date.now()}@test.local`, roleHint: "team_coach" });
  const token = await createSession(fakeTeamCoach.id);

  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, status)
     values ('program', $1, 'Fake Team Coach Template', true, 'draft')
     returning id`,
    [fakeTeamCoach.id],
  );
  cleanupPlanIds.add(plan.rows[0].id);

  const res = await api(`/api/templates/${plan.rows[0].id}/metadata`, {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { libraryScope: "team", programStatus: "active" },
  });
  assert.equal(res.status, 403, "role_hint='team_coach' alone must not unlock the team scope");
});

test("19. templates.js: a real user_team_roles row with role_hint='user' can publish to the team scope", async () => {
  const teamCoach = await makeUser({ email: `templates-real-teamcoach-${Date.now()}@test.local`, roleHint: "user" });
  const club = await makeClub(`Templates Scope Team Club ${Date.now()}`);
  const team = await makeTeam(club, "Templates Scope Team");
  await grantTeamRole(teamCoach.id, team);
  const token = await createSession(teamCoach.id);

  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, status)
     values ('program', $1, 'Real Team Coach Template', true, 'draft')
     returning id`,
    [teamCoach.id],
  );
  cleanupPlanIds.add(plan.rows[0].id);

  const res = await api(`/api/templates/${plan.rows[0].id}/metadata`, {
    method: "PATCH",
    cookie: cookieFor(token),
    body: { libraryScope: "team", programStatus: "active" },
  });
  assert.equal(res.status, 200, "a real user_team_roles row must unlock the team scope regardless of role_hint");
});

// --- Follow-up round: loadManagedAthletes' login_is_multi_role must come
// from real active role rows, never role_hint ---

test("20. login_is_multi_role is true for role_hint='athlete' with a real independent_coach row", async () => {
  const viewerAdmin = await makeUser({ email: `multirole-viewer-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(viewerAdmin.id, "platform_admin");
  const viewerToken = await createSession(viewerAdmin.id);

  const targetUser = await makeUser({ email: `multirole-target-${Date.now()}@test.local`, roleHint: "athlete" });
  await grantGlobalRole(targetUser.id, "independent_coach");
  const athleteResult = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, 'Multi', 'Role', 'Multi Role', 'Multi Role', $2, true)
     returning id`,
    [`mrole${Math.floor(Math.random() * 900000 + 100000)}`, targetUser.id],
  );
  const athleteId = athleteResult.rows[0].id;
  cleanupAthleteIds.add(athleteId);

  const res = await api("/api/organization", { cookie: cookieFor(viewerToken) });
  const row = res.body.athletes.find((a) => a.id === athleteId);
  assert.ok(row, "the platform admin viewer must see the athlete");
  assert.equal(row.login_is_multi_role, true, "a real independent_coach row must mark the login as multi-role, even though role_hint says 'athlete'");
});

test("21. login_is_multi_role is false for a stale staff role_hint with no real role row", async () => {
  const viewerAdmin = await makeUser({ email: `multirole-viewer2-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(viewerAdmin.id, "platform_admin");
  const viewerToken = await createSession(viewerAdmin.id);

  const targetUser = await makeUser({ email: `multirole-fake-target-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const athleteResult = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, 'Fake', 'MultiRole', 'Fake MultiRole', 'Fake MultiRole', $2, true)
     returning id`,
    [`mrole${Math.floor(Math.random() * 900000 + 100000)}`, targetUser.id],
  );
  const athleteId = athleteResult.rows[0].id;
  cleanupAthleteIds.add(athleteId);

  const res = await api("/api/organization", { cookie: cookieFor(viewerToken) });
  const row = res.body.athletes.find((a) => a.id === athleteId);
  assert.ok(row, "the platform admin viewer must see the athlete");
  assert.equal(row.login_is_multi_role, false, "role_hint='platform_admin' with no real user_global_roles row must not be reported as multi-role");
});

// --- Follow-up round: coaches.js canUseClubProfiles must be req.authz-based ---

test("22. coaches.js: role_hint='club_admin' with no real user_club_roles row cannot see a club-shared coach profile", async () => {
  const club = await makeClub(`Coach Profile Fake Club ${Date.now()}`);
  const coachOwner = await makeUser({ email: `coachprofile-owner-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubRole(coachOwner.id, club);
  await query(
    `insert into public.coach_profiles (user_id, contact_email, visibility) values ($1, $2, 'club')`,
    [coachOwner.id, coachOwner.email],
  );

  const fakeClubAdmin = await makeUser({ email: `coachprofile-fake-viewer-${Date.now()}@test.local`, roleHint: "club_admin" });
  const token = await createSession(fakeClubAdmin.id);

  const res = await api("/api/coaches", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.ok(!res.body.coaches.some((c) => c.user_id === coachOwner.id), "role_hint='club_admin' alone must not unlock club-shared coach profiles");

  await query(`delete from public.coach_profiles where user_id = $1`, [coachOwner.id]);
});

test("23. coaches.js: a real user_club_roles row (shared with the profile owner's club) unlocks a club-shared coach profile", async () => {
  const club = await makeClub(`Coach Profile Real Club ${Date.now()}`);
  const coachOwner = await makeUser({ email: `coachprofile-owner2-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubRole(coachOwner.id, club);
  await query(
    `insert into public.coach_profiles (user_id, contact_email, visibility) values ($1, $2, 'club')`,
    [coachOwner.id, coachOwner.email],
  );

  const realClubAdmin = await makeUser({ email: `coachprofile-real-viewer-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubRole(realClubAdmin.id, club);
  const token = await createSession(realClubAdmin.id);

  const res = await api("/api/coaches", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.ok(res.body.coaches.some((c) => c.user_id === coachOwner.id), "a real, shared user_club_roles row must unlock the club-shared coach profile");

  await query(`delete from public.coach_profiles where user_id = $1`, [coachOwner.id]);
});

test("24. coaches.js: a platform_admin from user_global_roles can see a club-shared coach profile with no club role of their own", async () => {
  const club = await makeClub(`Coach Profile Admin Club ${Date.now()}`);
  const coachOwner = await makeUser({ email: `coachprofile-owner3-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubRole(coachOwner.id, club);
  await query(
    `insert into public.coach_profiles (user_id, contact_email, visibility) values ($1, $2, 'club')`,
    [coachOwner.id, coachOwner.email],
  );

  const admin = await makeUser({ email: `coachprofile-admin-viewer-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(admin.id, "platform_admin");
  const token = await createSession(admin.id);

  const res = await api("/api/coaches", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.ok(res.body.coaches.some((c) => c.user_id === coachOwner.id), "platform_admin from user_global_roles must see club-shared coach profiles even without a club role of their own");

  await query(`delete from public.coach_profiles where user_id = $1`, [coachOwner.id]);
});

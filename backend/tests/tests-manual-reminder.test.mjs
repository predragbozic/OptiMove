// Mobile scheduling hotfix, items 4-6: POST /api/tests/schedules/:scheduleId/remind
// (backend/src/routes/tests.js) - a coach-triggered nudge for whichever
// assignments they pick right now, independent of the automated
// athlete_reminder worker rule (testsNotificationWorker.js, untouched).
//
// Same disposable-temp-database harness as tests-notification-worker.test.mjs
// (never OPTIMOVE, never monitoring2) - the real Strategy B runner, the real
// Express app over real HTTP with real session cookies.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILES = [
  "202608220900_tests_v42_schema.sql",
  "202608221000_tests_v42_seed_wellness_fms.sql",
  "202608240900_tests_v42_phase1_scheduling_execution.sql",
  "202608250900_tests_v42_presentation_metadata.sql",
  "202608250901_tests_v42_supersede_generated_column_fix.sql",
  "202608260900_tests_v42_occurrence_generation_lock_fix.sql",
  "202608270900_tests_v42_phase3_notification_dispatch_link.sql",
  "202608280900_app_notifications_dedupe_key.sql",
  "202608300900_tests_v42_phase4_assignment_timezone_window.sql",
];

const WELLNESS_TEST_VERSION_ID = "7a386bd1-d25e-4651-9012-e76d9dc32559";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const baseUrl = new URL(ORIGINAL_DATABASE_URL);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const ADMIN_URL = adminUrl.toString();

function dbUrlFor(name) {
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return u.toString();
}
function refuseForbidden(name, url) {
  if (name.toLowerCase() === "optimove" || /monitoring2/i.test(url)) {
    throw new Error("SAFETY: refusing to run against a forbidden database name");
  }
}

const LEGACY_FIXTURE_SQL = `
  create extension if not exists pgcrypto;

  create table public.clubs (id uuid primary key default gen_random_uuid(), name text, is_active boolean not null default true);
  create table public.teams (id uuid primary key default gen_random_uuid(), club_id uuid references public.clubs(id), name text, is_active boolean not null default true);
  alter table public.teams add constraint teams_id_club_id_unique unique (id, club_id);

  create table public.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    password_hash text,
    full_name text,
    display_name text,
    first_name text,
    last_name text,
    role_hint text not null default 'user',
    is_active boolean not null default true
  );
  create table public.auth_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  );
  create table public.user_global_roles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    role text not null,
    is_active boolean not null default true,
    revoked_at timestamptz
  );
  create table public.user_club_roles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    club_id uuid not null references public.clubs(id) on delete cascade,
    role text not null,
    is_active boolean not null default true,
    updated_at timestamptz not null default now()
  );
  create table public.user_team_roles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    team_id uuid not null references public.teams(id) on delete cascade,
    role text not null,
    is_active boolean not null default true,
    updated_at timestamptz not null default now()
  );
  create table public.user_workspace_preferences (
    user_id uuid primary key references public.users(id) on delete cascade,
    workspace_type text not null,
    scope_id uuid,
    updated_at timestamptz not null default now()
  );

  create table public.athletes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references public.users(id) on delete set null,
    source_external_id text,
    full_name text,
    display_name text,
    first_name text,
    last_name text,
    athlete_id text,
    image_url text
  );
  create table public.user_athletes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    athlete_id uuid not null references public.athletes(id) on delete cascade,
    relationship_type text not null default 'coach',
    is_active boolean not null default true
  );
  create table public.athlete_memberships (
    id uuid primary key default gen_random_uuid(),
    athlete_id uuid not null references public.athletes(id),
    club_id uuid references public.clubs(id),
    team_id uuid references public.teams(id),
    membership_type varchar not null,
    status varchar not null default 'active'
  );
  create table public.athlete_invites (id uuid primary key default gen_random_uuid(), context_type text);
  create table public.account_email_change_tokens (id uuid primary key default gen_random_uuid());

  create table public.app_notifications (
    id uuid primary key default gen_random_uuid(),
    recipient_user_id uuid not null references public.users(id) on delete cascade,
    actor_user_id uuid references public.users(id) on delete set null,
    type varchar(80) not null,
    title text not null,
    body text,
    entity_type varchar(80),
    entity_id uuid,
    href text,
    metadata jsonb not null default '{}'::jsonb,
    read_at timestamptz,
    created_at timestamptz not null default now()
  );

  create schema library;
  create table library.exercises (id uuid primary key default gen_random_uuid());

  create schema plans;
  create table plans.plans (id uuid primary key default gen_random_uuid());
  create table plans.plan_days (id uuid primary key default gen_random_uuid());
  create table plans.plan_sessions (id uuid primary key default gen_random_uuid(), session_time time);
  create table plans.plan_items (id uuid primary key default gen_random_uuid());
  create table plans.plan_nodes (id uuid primary key default gen_random_uuid());
  create view plans.v_plan_summary as select id from plans.plans;
  create view plans.v_plan_item_node_ancestry as select id from plans.plan_items;
  create view plans.v_weekly_plan_items as select id from plans.plan_items;
  create view plans.v_program_plan_items as select id from plans.plan_items;
`;

async function makeTempDb(label) {
  const name = `optimove_tests_manualremind_${label}_${crypto.randomBytes(6).toString("hex")}`;
  const url = dbUrlFor(name);
  refuseForbidden(name, url);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const cur = await admin.query("select current_database() as db");
  assert.equal(cur.rows[0].db, "postgres", "SAFETY: admin connection must be on the postgres database");
  await admin.query(`create database "${name}"`);
  await admin.end();
  return { name, url };
}
async function dropTempDb({ name }) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`, [name]);
  await admin.query(`drop database if exists "${name}"`);
  await admin.end();
}
async function writeMigrationsDir(runId, files) {
  const dir = path.resolve(__dirname, `tests_manualremind_migrations_${runId}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

let db, adminClient, migrationsDir;
let server, apiBaseUrl;
let query, pool, createSession, hashPassword, ensureCurrentOccurrence;

before(async () => {
  const contents = await Promise.all(
    MIGRATION_FILES.map((name) => fsp.readFile(path.resolve(__dirname, "../../migrations_v2", name), "utf8")),
  );

  db = await makeTempDb("primary");
  adminClient = new pg.Client({ connectionString: db.url });
  await adminClient.connect();
  const ownCheck = await adminClient.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");

  await adminClient.query(LEGACY_FIXTURE_SQL);
  const files = {};
  MIGRATION_FILES.forEach((name, i) => { files[name] = contents[i]; });
  migrationsDir = await writeMigrationsDir("primary", files);
  await runner.runMigrations({ databaseUrl: db.url, migrationsRoot: migrationsDir });

  process.env.DATABASE_URL = db.url;
  const dbModule = await import("../src/db.js");
  query = dbModule.query;
  pool = dbModule.pool;
  const authModule = await import("../src/auth.js");
  createSession = authModule.createSession;
  hashPassword = authModule.hashPassword;
  const occurrenceServiceModule = await import("../src/testsOccurrenceService.js");
  ensureCurrentOccurrence = occurrenceServiceModule.ensureCurrentOccurrence;
  const serverModule = await import("../src/server.js");

  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBaseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await adminClient.end();
  await fsp.rm(migrationsDir, { recursive: true, force: true });
  await dropTempDb(db);
});

// ------------------------------------------------------------
// Fixture helpers (same shapes as tests-notification-worker.test.mjs)
// ------------------------------------------------------------

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}
function cookieFor(token) {
  return `optimove_session=${token}`;
}
async function makeUser({ email, roleHint = "user" }) {
  const result = await query(
    `insert into public.users (email, password_hash, full_name, display_name, role_hint, is_active) values ($1,$2,$3,$3,$4,true) returning id`,
    [email, hashPassword("irrelevant-password-123"), email.split("@")[0], roleHint],
  );
  return result.rows[0].id;
}
async function makeClub(name) {
  const result = await query(`insert into public.clubs (name) values ($1) returning id`, [name]);
  return result.rows[0].id;
}
async function makeAthlete({ name, userId = null }) {
  const result = await query(`insert into public.athletes (user_id, full_name, display_name) values ($1,$2,$2) returning id`, [userId, name]);
  return result.rows[0].id;
}
async function grantClubAdmin(userId, clubId) {
  await query(`insert into public.user_club_roles (user_id, club_id, role) values ($1,$2,'club_admin')`, [userId, clubId]);
}
async function addMembership(athleteId, { clubId = null }) {
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
}
async function loginCookie(userId) {
  const token = await createSession(userId);
  return cookieFor(token);
}

const TODAY = new Date().toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Polls pg_stat_activity until some OTHER backend is genuinely blocked on a
// lock held by `blockerPid` (via pg_blocking_pids(), not a fixed sleep) -
// same helper already established elsewhere in this test suite, for
// deterministic (never timing-dependent) concurrency tests.
async function waitUntilBlockedBy(blockerPid, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await adminClient.query(`select pid from pg_stat_activity where pg_blocking_pids(pid) @> array[$1]::int[]`, [blockerPid]);
    if (result.rowCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for a backend to be blocked by pid ${blockerPid}`);
}

async function makeClubWithAthletes(label, count, { withUserAccount = true } = {}) {
  const clubId = await makeClub(`${label} Club`);
  const coachId = await makeUser({ email: `${label}-coach-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local` });
  await grantClubAdmin(coachId, clubId);
  const coachCookie = await loginCookie(coachId);
  const athletes = [];
  for (let i = 0; i < count; i += 1) {
    const userId = withUserAccount
      ? await makeUser({ email: `${label}-athlete${i}-${Date.now()}-${crypto.randomBytes(2).toString("hex")}@test.local`, roleHint: "athlete" })
      : null;
    const athleteId = await makeAthlete({ name: `${label} Athlete ${i}`, userId });
    await addMembership(athleteId, { clubId });
    athletes.push({ athleteId, userId, cookie: userId ? await loginCookie(userId) : null });
  }
  return { clubId, coachId, coachCookie, athletes };
}

function baseCreateBody(targets, overrides = {}) {
  return {
    testVersionId: WELLNESS_TEST_VERSION_ID,
    scheduleKind: "one_time",
    timezone: "UTC",
    startDate: TODAY,
    opensTime: "00:00",
    closesTime: "23:59",
    targets,
    ...overrides,
  };
}

async function createSchedule(coachCookie, targets, overrides = {}) {
  const created = await api("/api/tests/schedules", { method: "POST", cookie: coachCookie, body: baseCreateBody(targets, overrides) });
  assert.equal(created.status, 201, `expected schedule creation to succeed: ${JSON.stringify(created.body)}`);
  return created.body.schedule;
}

async function ensureOccurrenceAndAssignments(scheduleId) {
  const scheduleResult = await query(`select * from tests.test_schedules where id = $1`, [scheduleId]);
  await ensureCurrentOccurrence(pool, scheduleResult.rows[0]);
  const occurrenceResult = await query(`select * from tests.test_schedule_occurrences where schedule_id = $1`, [scheduleId]);
  return { occurrence: occurrenceResult.rows[0] };
}

async function getAssignmentId(occurrenceId, athleteId) {
  const result = await query(`select id from tests.test_assignments where occurrence_id = $1 and athlete_id = $2`, [occurrenceId, athleteId]);
  return result.rows[0]?.id;
}

async function remind(scheduleId, coachCookie, assignmentIds) {
  return api(`/api/tests/schedules/${encodeURIComponent(scheduleId)}/remind`, {
    method: "POST", cookie: coachCookie, body: { assignmentIds },
  });
}

// ------------------------------------------------------------
// 1. Only incomplete assignments are ever notified
// ------------------------------------------------------------

test("1. a completed assignment is skipped (skippedCompleted), an incomplete one is notified - both in the same request", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n1", 2);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const [a0, a1] = athletes;
  const a0AssignmentId = await getAssignmentId(occurrence.id, a0.athleteId);
  const a1AssignmentId = await getAssignmentId(occurrence.id, a1.athleteId);

  await query(`update tests.test_assignments set status = 'completed', completed_at = now() where id = $1`, [a0AssignmentId]);

  const result = await remind(schedule.id, coachCookie, [a0AssignmentId, a1AssignmentId]);
  assert.equal(result.status, 200);
  assert.equal(result.body.notifiedCount, 1);
  const byId = Object.fromEntries(result.body.results.map((r) => [r.assignmentId, r.outcome]));
  assert.equal(byId[a0AssignmentId], "skippedCompleted");
  assert.equal(byId[a1AssignmentId], "notified");
});

// ------------------------------------------------------------
// 2. Multiple athletes selected - all appropriately notified
// ------------------------------------------------------------

test("2. selecting multiple athletes notifies every one of them, each getting their own notification row", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n2", 3);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentIds = await Promise.all(athletes.map((a) => getAssignmentId(occurrence.id, a.athleteId)));

  const result = await remind(schedule.id, coachCookie, assignmentIds);
  assert.equal(result.status, 200);
  assert.equal(result.body.notifiedCount, 3);
  assert.ok(result.body.results.every((r) => r.outcome === "notified"));

  const rows = await query(`select recipient_user_id from public.app_notifications where type = 'test_manual_reminder' and entity_id = any($1::uuid[])`, [assignmentIds]);
  assert.equal(rows.rowCount, 3);
  const recipientSet = new Set(rows.rows.map((r) => r.recipient_user_id));
  assert.equal(recipientSet.size, 3, "each athlete must get their own distinct notification");
});

// ------------------------------------------------------------
// 3 & 4. Schedule-level rejections
// ------------------------------------------------------------

test("3. a cancelled schedule rejects the whole request with a controlled 400", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n3", 1);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);
  const cancelled = await api(`/api/tests/schedules/${schedule.id}`, { method: "DELETE", cookie: coachCookie });
  assert.equal(cancelled.status, 200);

  const result = await remind(schedule.id, coachCookie, [assignmentId]);
  assert.equal(result.status, 400);
  const notifCount = await query(`select count(*)::int as n from public.app_notifications where type = 'test_manual_reminder' and entity_id = $1`, [assignmentId]);
  assert.equal(notifCount.rows[0].n, 0, "no reminder must ever be sent for a cancelled schedule");
});

test("4. a paused schedule rejects the whole request with a controlled 400 - a reminder would be pointless (no new submission is possible)", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n4", 1);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);
  const paused = await api(`/api/tests/schedules/${schedule.id}`, { method: "PATCH", cookie: coachCookie, body: { status: "paused" } });
  assert.equal(paused.status, 200);

  const result = await remind(schedule.id, coachCookie, [assignmentId]);
  assert.equal(result.status, 400);
  const notifCount = await query(`select count(*)::int as n from public.app_notifications where type = 'test_manual_reminder' and entity_id = $1`, [assignmentId]);
  assert.equal(notifCount.rows[0].n, 0);
});

// ------------------------------------------------------------
// 5. A closed assignment window is skipped
// ------------------------------------------------------------

test("5. an assignment whose own window has already closed is skipped (skippedClosed), never notified", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n5", 1);
  // A schedule whose window closes at 00:01 UTC - almost certainly already
  // in the past by the time this test runs (see the deterministic
  // precondition check below, which skips rather than flakes in the rare
  // case this suite happens to run inside that exact 1-minute window).
  const pastSchedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { opensTime: "00:00", closesTime: "00:01" });
  const { occurrence: pastOccurrence } = await ensureOccurrenceAndAssignments(pastSchedule.id);
  const pastAssignmentId = await getAssignmentId(pastOccurrence.id, athletes[0].athleteId);
  // Wait past 00:01 UTC closes_at is almost certainly already in the past
  // relative to "now" for any normal test run time except the ~1-minute
  // window right at UTC midnight - to stay fully deterministic regardless
  // of when this suite runs, assert the fixture's own precondition first.
  const assignmentRow = await query(`select closes_at from tests.test_assignments where id = $1`, [pastAssignmentId]);
  if (new Date(assignmentRow.rows[0].closes_at) >= new Date()) {
    // Extremely rare (this test happened to run in the ~1 minute window
    // where 00:00-00:01 UTC today hasn't closed yet) - skip deterministically
    // rather than flake.
    return;
  }
  const result = await remind(pastSchedule.id, coachCookie, [pastAssignmentId]);
  assert.equal(result.status, 200);
  assert.equal(result.body.results[0].outcome, "skippedClosed");
  assert.equal(result.body.notifiedCount, 0);
});

// ------------------------------------------------------------
// 6. An athlete with no linked user_id is skipped, never crashes the batch
// ------------------------------------------------------------

test("6. an athlete with no linked user_id is skipped (skippedNoUser) and shown in the result - the rest of the batch still succeeds", async () => {
  const { clubId, coachCookie } = await makeClubWithAthletes("n6", 0);
  const withUser = await makeUser({ email: `n6-withuser-${Date.now()}@test.local`, roleHint: "athlete" });
  const withUserAthleteId = await makeAthlete({ name: "Has Account", userId: withUser });
  await addMembership(withUserAthleteId, { clubId });
  const noUserAthleteId = await makeAthlete({ name: "No Account" });
  await addMembership(noUserAthleteId, { clubId });

  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const withUserAssignmentId = await getAssignmentId(occurrence.id, withUserAthleteId);
  const noUserAssignmentId = await getAssignmentId(occurrence.id, noUserAthleteId);

  const result = await remind(schedule.id, coachCookie, [withUserAssignmentId, noUserAssignmentId]);
  assert.equal(result.status, 200, "a no-account athlete in the batch must never crash the whole request");
  assert.equal(result.body.notifiedCount, 1);
  assert.equal(result.body.noUserCount, 1);
  const byId = Object.fromEntries(result.body.results.map((r) => [r.assignmentId, r.outcome]));
  assert.equal(byId[noUserAssignmentId], "skippedNoUser");
  assert.equal(byId[withUserAssignmentId], "notified");
});

// ------------------------------------------------------------
// 7. Unauthorized coach
// ------------------------------------------------------------

test("7. a coach who does not manage this schedule gets a controlled 403, never sends anything", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n7owner", 1);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);

  const { coachCookie: outsiderCookie } = await makeClubWithAthletes("n7outsider", 0);
  const result = await remind(schedule.id, outsiderCookie, [assignmentId]);
  assert.equal(result.status, 403);
  const notifCount = await query(`select count(*)::int as n from public.app_notifications where type = 'test_manual_reminder' and entity_id = $1`, [assignmentId]);
  assert.equal(notifCount.rows[0].n, 0);
});

// ------------------------------------------------------------
// 8. Retry / double-click never duplicates
// ------------------------------------------------------------

test("8. two back-to-back requests for the SAME assignment (double-click/retry) never produce two notifications - the second is skippedCooldown", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n8", 1);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);

  const first = await remind(schedule.id, coachCookie, [assignmentId]);
  assert.equal(first.status, 200);
  assert.equal(first.body.results[0].outcome, "notified");

  const second = await remind(schedule.id, coachCookie, [assignmentId]);
  assert.equal(second.status, 200);
  assert.equal(second.body.results[0].outcome, "skippedCooldown");
  assert.equal(second.body.notifiedCount, 0);

  const rows = await query(`select count(*)::int as n from public.app_notifications where type = 'test_manual_reminder' and entity_id = $1`, [assignmentId]);
  assert.equal(rows.rows[0].n, 1, "exactly one notification, never two, regardless of the retry");
});

test("8b. two genuinely PARALLEL requests for the SAME assignment (a real double-click, not just sequential) never produce two notifications", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n8b", 1);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);

  const [r1, r2] = await Promise.all([
    remind(schedule.id, coachCookie, [assignmentId]),
    remind(schedule.id, coachCookie, [assignmentId]),
  ]);
  const outcomes = [r1.body.results[0].outcome, r2.body.results[0].outcome].sort();
  assert.deepEqual(outcomes, ["notified", "skippedCooldown"], "exactly one of the two parallel requests must win - the assignment row's own FOR UPDATE lock is what makes this atomic: the second request can only run its own cooldown check after the first has already committed");

  const rows = await query(`select count(*)::int as n from public.app_notifications where type = 'test_manual_reminder' and entity_id = $1`, [assignmentId]);
  assert.equal(rows.rows[0].n, 1);
});

// ------------------------------------------------------------
// 9. A real SLIDING 5-minute cooldown - never a fixed bucket
// ------------------------------------------------------------

// Round 2 correction: the FIRST version of this route used
// Math.floor(now / 5min) as a "bucket" and relied on a unique index
// collision to detect a repeat - which meant two requests seconds apart,
// straddling a bucket boundary, could both succeed (a real bug). The
// route now checks a genuine sliding window (`created_at > now() -
// interval '5 minutes'`) under the assignment's own row lock - these tests
// prove that directly, by inserting a notification row with a REAL
// created_at timestamp (never a fabricated bucket-shaped dedupe_key) and
// checking the boundary on actual elapsed time.

test("9. a notification sent only a few SECONDS ago (well inside the 5-minute window) blocks a new send - skippedCooldown, regardless of any bucket boundary", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n9", 1);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);

  const athleteRow = await query(`select user_id from public.athletes where id = $1`, [athletes[0].athleteId]);
  await query(
    `insert into public.app_notifications (recipient_user_id, type, title, body, entity_type, entity_id, metadata, dedupe_key, created_at)
     values ($1, 'test_manual_reminder', 'WELLNESS reminder', 'earlier reminder', 'test_assignment', $2, '{}'::jsonb, $3, now() - interval '4 seconds')`,
    [athleteRow.rows[0].user_id, assignmentId, `manual_reminder:v1:${assignmentId}:test-old`],
  );

  const result = await remind(schedule.id, coachCookie, [assignmentId]);
  assert.equal(result.status, 200);
  assert.equal(result.body.results[0].outcome, "skippedCooldown", "4 seconds ago is well inside the real 5-minute window");
  const rows = await query(`select count(*)::int as n from public.app_notifications where type = 'test_manual_reminder' and entity_id = $1`, [assignmentId]);
  assert.equal(rows.rows[0].n, 1, "no second row must have been inserted");
});

test("10. a notification sent 6+ real minutes ago (past the 5-minute window) is a legitimate later resend - notified", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n10", 1);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);

  const athleteRow = await query(`select user_id from public.athletes where id = $1`, [athletes[0].athleteId]);
  await query(
    `insert into public.app_notifications (recipient_user_id, type, title, body, entity_type, entity_id, metadata, dedupe_key, created_at)
     values ($1, 'test_manual_reminder', 'WELLNESS reminder', 'earlier reminder', 'test_assignment', $2, '{}'::jsonb, $3, now() - interval '6 minutes')`,
    [athleteRow.rows[0].user_id, assignmentId, `manual_reminder:v1:${assignmentId}:test-expired`],
  );

  const result = await remind(schedule.id, coachCookie, [assignmentId]);
  assert.equal(result.status, 200);
  assert.equal(result.body.results[0].outcome, "notified", "an expired (6+ minute old) reminder must never block a genuinely new one");
  const rows = await query(`select count(*)::int as n from public.app_notifications where type = 'test_manual_reminder' and entity_id = $1`, [assignmentId]);
  assert.equal(rows.rows[0].n, 2, "the old (expired) row and the new one both exist - two real, distinct sends");
});

// ------------------------------------------------------------
// 11. Item 1: an assignment that hasn't opened yet
// ------------------------------------------------------------

test("11. an assignment whose own window has NOT opened yet is skipped (skippedNotOpen), never notified - opens_at is genuinely checked, not just closes_at", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n11", 1);

  // Materialization eligibility is DATE-only (the athlete's own real
  // current date must equal the occurrence's scheduled_date - see
  // testsOccurrenceService.js/the phase4 migration, untouched this round);
  // it is never gated by TIME-of-day. So today's own date, with an
  // opens_time a few minutes past the real current UTC time, is what
  // materializes a real assignment whose window genuinely hasn't opened
  // yet - not a future scheduled_date, which would simply never
  // materialize at all under the real target-derived generation rules.
  const nowUtc = await query(`select (now() at time zone 'UTC')::time as t`);
  const nowSeconds = (() => {
    const [h, m, s] = nowUtc.rows[0].t.split(":").map(Number);
    return h * 3600 + m * 60 + s;
  })();
  if (nowSeconds > 23 * 3600 + 50 * 60) {
    // Extremely rare (this test happened to run in the last ~10 minutes of
    // the UTC day, where "a few minutes from now" would wrap past
    // midnight) - skip deterministically rather than flake, same
    // convention already used elsewhere in this module (test 5).
    return;
  }
  const futureSeconds = nowSeconds + 180;
  const futureTime = `${String(Math.floor(futureSeconds / 3600)).padStart(2, "0")}:${String(Math.floor((futureSeconds % 3600) / 60)).padStart(2, "0")}`;

  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }], { startDate: TODAY, endDate: TODAY, opensTime: futureTime, closesTime: "23:59" });
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);
  assert.ok(assignmentId, "sanity: the assignment must exist - today's own date is eligible regardless of opens_time");

  const assignmentRow = await query(`select opens_at from tests.test_assignments where id = $1`, [assignmentId]);
  assert.ok(new Date(assignmentRow.rows[0].opens_at) > new Date(), "sanity: opens_at must genuinely be in the future");

  const result = await remind(schedule.id, coachCookie, [assignmentId]);
  assert.equal(result.status, 200);
  assert.equal(result.body.results[0].outcome, "skippedNotOpen");
  assert.equal(result.body.notifiedCount, 0);
  const notifCount = await query(`select count(*)::int as n from public.app_notifications where type = 'test_manual_reminder' and entity_id = $1`, [assignmentId]);
  assert.equal(notifCount.rows[0].n, 0);
});

// ------------------------------------------------------------
// 12. Item 3: races against a concurrent pause/cancel and a concurrent completion
// ------------------------------------------------------------

test("12. a concurrent PATCH that pauses the schedule mid-request never lets the reminder through - the whole request sees the fresh (paused) status", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n12", 1);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);

  const clientA = await pool.connect();
  try {
    const pidResult = await clientA.query("select pg_backend_pid() as pid");
    const blockerPid = pidResult.rows[0].pid;

    await clientA.query("begin");
    // Mirrors PATCH .../schedules/:id's own first step: lock the schedule
    // row FOR UPDATE, but do not commit yet.
    await clientA.query(`select * from tests.test_schedules where id = $1 for update`, [schedule.id]);

    const remindPromise = remind(schedule.id, coachCookie, [assignmentId]);
    await waitUntilBlockedBy(blockerPid);

    await clientA.query(`update tests.test_schedules set status = 'paused' where id = $1`, [schedule.id]);
    await clientA.query("commit");

    const result = await remindPromise;
    assert.equal(result.status, 400, "must see the FRESH (paused) status, never the stale 'active' it started with");
    const notifCount = await query(`select count(*)::int as n from public.app_notifications where type = 'test_manual_reminder' and entity_id = $1`, [assignmentId]);
    assert.equal(notifCount.rows[0].n, 0, "no reminder may ever be sent once the schedule is paused, even if the request started before the pause");
  } finally {
    clientA.release();
  }
});

test("13. a concurrent submit that completes the assignment mid-request never lets the reminder through for it - skippedCompleted, not notified", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n13", 1);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const assignmentId = await getAssignmentId(occurrence.id, athletes[0].athleteId);

  const clientA = await pool.connect();
  try {
    const pidResult = await clientA.query("select pg_backend_pid() as pid");
    const blockerPid = pidResult.rows[0].pid;

    await clientA.query("begin");
    // Mirrors POST /assignments/:id/submit's own lock on this exact row.
    await clientA.query(`select * from tests.test_assignments where id = $1 for update`, [assignmentId]);

    const remindPromise = remind(schedule.id, coachCookie, [assignmentId]);
    await waitUntilBlockedBy(blockerPid);

    await clientA.query(`update tests.test_assignments set status = 'completed', completed_at = now() where id = $1`, [assignmentId]);
    await clientA.query("commit");

    const result = await remindPromise;
    assert.equal(result.status, 200);
    assert.equal(result.body.results[0].outcome, "skippedCompleted", "must see the assignment as completed, the moment its own row lock is finally granted");
    const notifCount = await query(`select count(*)::int as n from public.app_notifications where type = 'test_manual_reminder' and entity_id = $1`, [assignmentId]);
    assert.equal(notifCount.rows[0].n, 0);
  } finally {
    clientA.release();
  }
});

// ------------------------------------------------------------
// 14. Item 3: a batch error leaves no partial writes
// ------------------------------------------------------------

test("14. a malformed id anywhere in the batch fails the WHOLE request - never a partial write for the OTHER, genuinely valid assignments in the same call", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("n14", 2);
  const schedule = await createSchedule(coachCookie, [{ kind: "club", id: clubId }]);
  const { occurrence } = await ensureOccurrenceAndAssignments(schedule.id);
  const validId1 = await getAssignmentId(occurrence.id, athletes[0].athleteId);
  const validId2 = await getAssignmentId(occurrence.id, athletes[1].athleteId);

  // A non-empty, non-UUID string reaches the DB's own ::uuid[] cast inside
  // the route's very first query, inside the SAME transaction as
  // everything else - a real SQL-level error, not a benign "not found"
  // skip, so it proves the WHOLE request rolls back together, never
  // "process what you can, skip the bad one".
  const result = await remind(schedule.id, coachCookie, [validId1, "not-a-valid-uuid", validId2]);
  assert.ok(result.status >= 400, `expected a controlled error status, got ${result.status}`);

  const notifCount = await query(
    `select count(*)::int as n from public.app_notifications where type = 'test_manual_reminder' and entity_id = any($1::uuid[])`,
    [[validId1, validId2]],
  );
  assert.equal(notifCount.rows[0].n, 0, "neither valid assignment may have been notified - the malformed id in the same batch must roll back everything");
});

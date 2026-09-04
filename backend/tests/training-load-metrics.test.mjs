// Training Load metrics — catalog + measurements, first backend phase.
// Same disposable-DB harness convention as training-load.test.mjs /
// tests-weekly-calendar.test.mjs: a uniquely-named temporary database
// (never OPTIMOVE, never monitoring2), through the real Strategy B
// runner, with the real Express app driven over real HTTP with real
// session cookies. No frontend, no GPEXE/CSV connector routes exist to
// test — every scenario here goes through real HTTP requests hitting the
// real trainingLoadMetrics router + real service modules, or (for the
// source-identity/import-side flows, which have no public route in this
// phase) direct calls into the real service functions against the same
// disposable database.
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

const MIGRATIONS = [
  "202608310900_training_load_v1_session_feedback.sql",
  "202608320900_training_load_v2_logical_session_identity.sql",
  "202609010900_training_load_v3_rpe_enabled.sql",
  "202609011000_training_load_v4_external_scheduling.sql",
  "202609011100_training_load_v5_unified_result_source.sql",
  "202609040900_training_load_v9_planned_rpe_workspace_toggle.sql",
  "202609041400_training_load_v10_metrics_catalog.sql",
  "202609041500_training_load_v11_metrics_provenance.sql",
  "202609041600_training_load_v12_metrics_events.sql",
  "202609041700_training_load_v13_metrics_measurements.sql",
];

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

// Same legacy scaffold as training-load.test.mjs — required ONLY to
// satisfy migrate.js's Strategy B legacy-fingerprint preflight, not
// because this feature's own routes read any of it beyond the
// "extra columns" ALTER block at the end.
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
    image_url text,
    device_timezone text,
    device_timezone_updated_at timestamptz,
    is_active boolean not null default true
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

  alter table plans.plans
    add column plan_type text not null default 'weekly',
    add column athlete_id uuid references public.athletes(id),
    add column name text,
    add column status text not null default 'draft',
    add column is_active boolean not null default true,
    add column is_edit_draft boolean not null default false,
    add column edit_source_plan_id uuid references plans.plans(id),
    add column week_start date,
    add column created_by_user_id uuid references public.users(id),
    add column created_at timestamptz not null default now(),
    add column updated_at timestamptz not null default now();
  alter table plans.plan_days
    add column plan_id uuid not null references plans.plans(id) on delete cascade,
    add column date date,
    add column day_order int;
  alter table plans.plan_sessions
    add column plan_day_id uuid not null references plans.plan_days(id) on delete cascade,
    add column am_pm text,
    add column bta text,
    add column session_order int not null default 0,
    add column name text,
    add column logical_session_id uuid,
    add column created_at timestamptz not null default now(),
    add column updated_at timestamptz not null default now();
`;

async function makeTempDb(label) {
  const name = `optimove_tests_tlmetrics_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_tlmetrics_migrations_${runId}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

let db, adminClient, migrationsDir;
let server, apiBaseUrl;
let query, pool, createSession, hashPassword;
let measurementsService, catalogService, accessModule;

before(async () => {
  const migrationSqls = await Promise.all(MIGRATIONS.map((name) => fsp.readFile(path.resolve(__dirname, "../../migrations_v2", name), "utf8")));

  db = await makeTempDb("primary");
  adminClient = new pg.Client({ connectionString: db.url });
  await adminClient.connect();
  const ownCheck = await adminClient.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");

  await adminClient.query(LEGACY_FIXTURE_SQL);
  migrationsDir = await writeMigrationsDir("primary", Object.fromEntries(MIGRATIONS.map((name, i) => [name, migrationSqls[i]])));
  await runner.runMigrations({ databaseUrl: db.url, migrationsRoot: migrationsDir });

  process.env.DATABASE_URL = db.url;
  const dbModule = await import("../src/db.js");
  query = dbModule.query;
  pool = dbModule.pool;
  const authModule = await import("../src/auth.js");
  createSession = authModule.createSession;
  hashPassword = authModule.hashPassword;
  const serverModule = await import("../src/server.js");
  measurementsService = await import("../src/trainingLoadMetricsMeasurements.js");
  catalogService = await import("../src/trainingLoadMetricsCatalog.js");
  accessModule = await import("../src/trainingLoadMetricsAccess.js");

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
// Fixture helpers (mirrors training-load.test.mjs's own conventions)
// ------------------------------------------------------------

async function api(urlPath, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBaseUrl}${urlPath}`, {
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
function uid() {
  return crypto.randomBytes(4).toString("hex");
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
async function makeTeam(clubId, name) {
  const result = await query(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, name]);
  return result.rows[0].id;
}
async function makeAthlete({ name, userId = null }) {
  const result = await query(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,$2,$2,'UTC') returning id`, [userId, name]);
  return result.rows[0].id;
}
async function grantClubAdmin(userId, clubId) {
  await query(`insert into public.user_club_roles (user_id, club_id, role) values ($1,$2,'club_admin')`, [userId, clubId]);
}
async function grantTeamCoach(userId, teamId) {
  await query(`insert into public.user_team_roles (user_id, team_id, role) values ($1,$2,'team_coach')`, [userId, teamId]);
}
async function grantGlobalRole(userId, role) {
  await query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,$2,true)`, [userId, role]);
}
async function linkPrivateCoachAthlete(userId, athleteId) {
  await query(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1,$2,'coach',true)`, [userId, athleteId]);
}
async function setActiveWorkspace(userId, type, scopeId = null) {
  await query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id, updated_at) values ($1,$2,$3,now())
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id, updated_at = now()`,
    [userId, type, scopeId],
  );
}
async function loginCookie(userId) {
  const token = await createSession(userId);
  return cookieFor(token);
}
async function makeClubWithAthletes(label, count) {
  const clubId = await makeClub(`${label} Club ${uid()}`);
  const coachId = await makeUser({ email: `${label}-coach-${uid()}@test.local` });
  await grantClubAdmin(coachId, clubId);
  await setActiveWorkspace(coachId, "club", clubId);
  const coachCookie = await loginCookie(coachId);
  const athletes = [];
  for (let i = 0; i < count; i += 1) {
    const userId = await makeUser({ email: `${label}-athlete${i}-${uid()}@test.local`, roleHint: "athlete" });
    const athleteId = await makeAthlete({ name: `${label} Athlete ${i}` , userId });
    await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
    await setActiveWorkspace(userId, "athlete", null);
    athletes.push({ athleteId, userId, cookie: await loginCookie(userId) });
  }
  return { clubId, coachId, coachCookie, athletes };
}

// A ready-to-use system-scoped metric definition (numeric, m, sum) —
// created via the REAL API as platform admin, so every test that just
// needs "some valid metric" doesn't hand-roll SQL for it.
let sysAdminId, sysAdminCookie, distanceDefId;
async function ensureSystemDefinition() {
  if (distanceDefId) return distanceDefId;
  sysAdminId = await makeUser({ email: `sysadmin-${uid()}@test.local` });
  await grantGlobalRole(sysAdminId, "platform_admin");
  await setActiveWorkspace(sysAdminId, "platform", null);
  sysAdminCookie = await loginCookie(sysAdminId);
  const res = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: sysAdminCookie,
    body: { key: `total_distance_${uid()}`, label: "Total Distance", ownerScope: "system", unit: "m", valueType: "numeric", dailyAggregationMethod: "sum" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  distanceDefId = res.body.row.id;
  return distanceDefId;
}

async function makePlanSessionForAthlete(athleteId, { date = "2026-09-08", name = "Ponedeljak - Snaga", planName = "Sept Blok" } = {}) {
  const planId = crypto.randomUUID();
  await query(`insert into plans.plans (id, athlete_id, name, plan_type) values ($1,$2,$3,'weekly')`, [planId, athleteId, planName]);
  const dayId = crypto.randomUUID();
  await query(`insert into plans.plan_days (id, plan_id, date, day_order) values ($1,$2,$3,1)`, [dayId, planId, date]);
  const logicalSessionId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await query(`insert into plans.plan_sessions (id, plan_day_id, name, logical_session_id, session_order) values ($1,$2,$3,$4,1)`, [sessionId, dayId, name, logicalSessionId]);
  return { planId, dayId, sessionId, logicalSessionId };
}

async function makeExternalAssignmentForAthlete(athleteId, { date = "2026-09-08" } = {}) {
  const scheduleId = crypto.randomUUID();
  await query(
    `insert into training_load.external_schedules (id, schedule_kind, timezone, start_date, opens_time, closes_time, status, event_name, created_by_user_id, owner_scope)
     values ($1,'one_time','UTC',$2,'00:00','23:59','active','Fixture event',$3,'system')`,
    [scheduleId, date, sysAdminId || (await ensureSystemDefinition(), sysAdminId)],
  );
  const occurrenceId = crypto.randomUUID();
  await query(
    `insert into training_load.external_schedule_occurrences (id, schedule_id, scheduled_date, opens_at, closes_at)
     values ($1,$2,$3,$4,$5)`,
    [occurrenceId, scheduleId, date, `${date}T00:00:00Z`, `${date}T23:59:00Z`],
  );
  const assignmentId = crypto.randomUUID();
  await query(
    `insert into training_load.external_assignments (id, occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at)
     values ($1,$2,$3,'UTC',$4,$5,$6)`,
    [assignmentId, occurrenceId, athleteId, date, `${date}T00:00:00Z`, `${date}T23:59:00Z`],
  );
  return { scheduleId, occurrenceId, assignmentId };
}

async function waitUntilBlocked(monitorClient, pid, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await monitorClient.query(`select wait_event_type from pg_stat_activity where pid=$1`, [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((res) => setTimeout(res, 15));
  }
  return false;
}

// =========================================================================
// 1. Solo measurement, no plan, no RPE
// =========================================================================
test("1. solo measurement without a plan or RPE link", async () => {
  const { clubId, coachCookie, athletes } = await makeClubWithAthletes("solo", 1);
  const defId = await ensureSystemDefinition();
  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: crypto.randomUUID(), occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [{ athleteId: athletes[0].athleteId, timezone: "Europe/Sarajevo", values: [{ metricDefinitionId: defId, value: 6200 }] }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.participants.length, 1);
  const resultsRes = await api(`/api/training-load/metrics/results?dateFrom=2026-09-08&dateTo=2026-09-08&athleteIds=${athletes[0].athleteId}`, { cookie: coachCookie });
  assert.equal(resultsRes.status, 200);
  assert.equal(resultsRes.body.rows.length, 1);
  assert.equal(Number(resultsRes.body.rows[0].value), 6200);
});

// =========================================================================
// 2. Group event, real plan-session link, real external-assignment link
// =========================================================================
test("2. group event with a real planned-session link and a real external-assignment link", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("group", 2);
  const defId = await ensureSystemDefinition();
  const { logicalSessionId } = await makePlanSessionForAthlete(athletes[0].athleteId, { date: "2026-09-08" });
  const { assignmentId } = await makeExternalAssignmentForAthlete(athletes[1].athleteId, { date: "2026-09-08" });

  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: crypto.randomUUID(), occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [
        { athleteId: athletes[0].athleteId, timezone: "Europe/Sarajevo", logicalSessionId, values: [{ metricDefinitionId: defId, value: 5000 }] },
        { athleteId: athletes[1].athleteId, timezone: "Europe/Sarajevo", externalAssignmentId: assignmentId, values: [{ metricDefinitionId: defId, value: 4200 }] },
      ],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.participants.length, 2);

  const detail = await api(`/api/training-load/metrics/occasions/${res.body.participants[0].occasionIds[0]}`, { cookie: coachCookie });
  assert.equal(detail.status, 200);
});

test("2b. knowing a valid UUID alone is not enough — a session/assignment not belonging to the athlete is rejected, whole request fails", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("linkcheck", 2);
  const defId = await ensureSystemDefinition();
  const { logicalSessionId } = await makePlanSessionForAthlete(athletes[0].athleteId, { date: "2026-09-08" });
  const before_ = await query(`select count(*)::int as n from training_load.metric_events`);

  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: crypto.randomUUID(), occurredDate: "2026-09-08", scopeLevel: "session",
      participants: [
        // logicalSessionId genuinely exists, but belongs to athletes[0], not athletes[1] below.
        { athleteId: athletes[1].athleteId, timezone: "Europe/Sarajevo", logicalSessionId, values: [{ metricDefinitionId: defId, value: 1000 }] },
      ],
    },
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  const after_ = await query(`select count(*)::int as n from training_load.metric_events`);
  assert.equal(after_.rows[0].n, before_.rows[0].n, "rejected link must not create any event at all");
});

// =========================================================================
// 3. Unauthorized athlete in a group request — zero partial writes
// =========================================================================
test("3. an unauthorized athlete anywhere in the group request rejects the WHOLE request, zero partial writes", async () => {
  const clubA = await makeClubWithAthletes("clubA-partial", 1);
  const clubB = await makeClubWithAthletes("clubB-partial", 1);
  const defId = await ensureSystemDefinition();

  const before_ = await query(`select count(*)::int as n from training_load.metric_events`);
  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: clubA.coachCookie,
    body: {
      requestKey: crypto.randomUUID(), occurredDate: "2026-09-09", scopeLevel: "session",
      participants: [
        { athleteId: clubA.athletes[0].athleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, value: 100 }] },
        { athleteId: clubB.athletes[0].athleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, value: 200 }] },
      ],
    },
  });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  const after_ = await query(`select count(*)::int as n from training_load.metric_events`);
  assert.equal(after_.rows[0].n, before_.rows[0].n, "no event must be created when any participant is unauthorized");
  const participantCount = await query(`select count(*)::int as n from training_load.metric_event_participants where athlete_id = $1`, [clubA.athletes[0].athleteId]);
  assert.equal(participantCount.rows[0].n, 0, "not even the authorized participant should have been written");
});

test("3b. an invalid value anywhere in the group request rejects the WHOLE request, zero partial writes", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("clubC-invalidval", 2);
  const defId = await ensureSystemDefinition();
  const before_ = await query(`select count(*)::int as n from training_load.metric_events`);
  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: crypto.randomUUID(), occurredDate: "2026-09-09", scopeLevel: "session",
      participants: [
        { athleteId: athletes[0].athleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, value: 100 }] },
        { athleteId: athletes[1].athleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, value: "" }] }, // empty string must never silently become 0
      ],
    },
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  const after_ = await query(`select count(*)::int as n from training_load.metric_events`);
  assert.equal(after_.rows[0].n, before_.rows[0].n);
});

// =========================================================================
// 4. Two workspaces, same athlete, no data leak
// =========================================================================
test("4. two workspaces with the same (dual-membership) athlete do not see each other's measurements", async () => {
  const clubX = await makeClubWithAthletes("dualX", 0);
  const clubY = await makeClubWithAthletes("dualY", 0);
  const defId = await ensureSystemDefinition();
  const sharedAthleteUserId = await makeUser({ email: `dual-athlete-${uid()}@test.local`, roleHint: "athlete" });
  const sharedAthleteId = await makeAthlete({ name: "Dual Athlete", userId: sharedAthleteUserId });
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [sharedAthleteId, clubX.clubId]);
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [sharedAthleteId, clubY.clubId]);

  const resX = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: clubX.coachCookie,
    body: { requestKey: crypto.randomUUID(), occurredDate: "2026-09-10", scopeLevel: "session", participants: [{ athleteId: sharedAthleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, value: 111 }] }] },
  });
  assert.equal(resX.status, 201, JSON.stringify(resX.body));

  const viewFromY = await api(`/api/training-load/metrics/results?dateFrom=2026-09-10&dateTo=2026-09-10&athleteIds=${sharedAthleteId}`, { cookie: clubY.coachCookie });
  assert.equal(viewFromY.status, 200);
  assert.equal(viewFromY.body.rows.length, 0, "club Y must not see club X's measurement for the same shared athlete");

  const viewFromX = await api(`/api/training-load/metrics/results?dateFrom=2026-09-10&dateTo=2026-09-10&athleteIds=${sharedAthleteId}`, { cookie: clubX.coachCookie });
  assert.equal(viewFromX.body.rows.length, 1);
});

// =========================================================================
// 5. Revoked rights at retry
// =========================================================================
test("5. a retry after rights are revoked is rejected, not silently reused", async () => {
  const { clubId, coachId, coachCookie, athletes } = await makeClubWithAthletes("revoke", 1);
  const defId = await ensureSystemDefinition();
  const requestKey = crypto.randomUUID();
  const body = { requestKey, occurredDate: "2026-09-11", scopeLevel: "session", participants: [{ athleteId: athletes[0].athleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, value: 500 }] }] };
  const first = await api("/api/training-load/metrics/events", { method: "POST", cookie: coachCookie, body });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  await query(`update public.user_club_roles set is_active = false where user_id = $1 and club_id = $2`, [coachId, clubId]);
  const retry = await api("/api/training-load/metrics/events", { method: "POST", cookie: coachCookie, body });
  assert.equal(retry.status, 403, JSON.stringify(retry.body));
});

// =========================================================================
// 6. Workspace change mid-"session" (between two requests using the same key)
// =========================================================================
test("6. the same request_key resubmitted under a DIFFERENT workspace is rejected, not reused", async () => {
  const clubA = await makeClubWithAthletes("wsA", 1);
  const clubB = await makeClubWithAthletes("wsB", 1);
  const defId = await ensureSystemDefinition();
  // Make the same physical coach account a club_admin of BOTH clubs.
  await grantClubAdmin(clubA.coachId, clubB.clubId);
  const requestKey = crypto.randomUUID();

  await setActiveWorkspace(clubA.coachId, "club", clubA.clubId);
  const first = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: clubA.coachCookie,
    body: { requestKey, occurredDate: "2026-09-12", scopeLevel: "session", participants: [{ athleteId: clubA.athletes[0].athleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, value: 700 }] }] },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  await setActiveWorkspace(clubA.coachId, "club", clubB.clubId);
  const retryDifferentWorkspace = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: clubA.coachCookie,
    body: { requestKey, occurredDate: "2026-09-12", scopeLevel: "session", participants: [{ athleteId: clubA.athletes[0].athleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, value: 700 }] }] },
  });
  assert.equal(retryDifferentWorkspace.status, 409, JSON.stringify(retryDifferentWorkspace.body));
});

// =========================================================================
// 7. Private/system catalog + structure-link target visibility
// =========================================================================
test("7. a private coach's own definition is invisible to other coaches; system definitions are visible to all", async () => {
  const coachOneId = await makeUser({ email: `priv1-${uid()}@test.local` });
  await grantGlobalRole(coachOneId, "independent_coach");
  await setActiveWorkspace(coachOneId, "private_coach", null);
  const coachOneCookie = await loginCookie(coachOneId);

  const coachTwoId = await makeUser({ email: `priv2-${uid()}@test.local` });
  await grantGlobalRole(coachTwoId, "independent_coach");
  await setActiveWorkspace(coachTwoId, "private_coach", null);
  const coachTwoCookie = await loginCookie(coachTwoId);

  const created = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: coachOneCookie,
    body: { key: `my_metric_${uid()}`, label: "My Private Metric", ownerScope: "user", unit: "m", valueType: "numeric" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const seenByOwner = await api(`/api/training-load/metrics/definitions/${created.body.row.id}`, { cookie: coachOneCookie });
  assert.equal(seenByOwner.status, 200);
  const seenByOther = await api(`/api/training-load/metrics/definitions/${created.body.row.id}`, { cookie: coachTwoCookie });
  assert.equal(seenByOther.status, 404, "a private definition must not be visible to a different coach");

  const sysDefId = await ensureSystemDefinition();
  const seenSystem = await api(`/api/training-load/metrics/definitions/${sysDefId}`, { cookie: coachTwoCookie });
  assert.equal(seenSystem.status, 200, "a system definition must be visible to any coach");
});

test("7b. a private domain never leaks through a club-scoped structure link, but a domain-only link is still reachable", async () => {
  const { coachCookie } = await makeClubWithAthletes("linkvis", 0);
  const otherClub = await makeClubWithAthletes("linkvis-other", 0);
  const privDomainOwnerId = await makeUser({ email: `linkowner-${uid()}@test.local` });
  await grantGlobalRole(privDomainOwnerId, "independent_coach");
  await setActiveWorkspace(privDomainOwnerId, "private_coach", null);
  const privDomainOwnerCookie = await loginCookie(privDomainOwnerId);

  const domainRes = await api("/api/training-load/metrics/domains", { method: "POST", cookie: privDomainOwnerCookie, body: { name: "Moj fokus", ownerScope: "user" } });
  assert.equal(domainRes.status, 201, JSON.stringify(domainRes.body));

  // Someone else (a club coach with no rights over the private domain)
  // must not be able to publish a club-scoped link referencing it.
  const illegalLink = await api("/api/training-load/metrics/structure-links", {
    method: "POST", cookie: otherClub.coachCookie,
    body: { domainId: domainRes.body.row.id, ownerScope: "club", ownerClubId: otherClub.clubId },
  });
  assert.equal(illegalLink.status, 404, JSON.stringify(illegalLink.body));

  // A domain-only link (no metricDefinitionId) to a visible SYSTEM domain
  // must remain reachable — proves visibility isn't accidentally requiring
  // metric_definition_id to be set.
  const sysDomain = await api("/api/training-load/metrics/domains", { method: "POST", cookie: sysAdminCookie, body: { name: "Volume", ownerScope: "system" } });
  assert.equal(sysDomain.status, 201);
  const domainOnlyLink = await api("/api/training-load/metrics/structure-links", { method: "POST", cookie: otherClub.coachCookie, body: { domainId: sysDomain.body.row.id, ownerScope: "user" } });
  assert.equal(domainOnlyLink.status, 201, JSON.stringify(domainOnlyLink.body));
  const listed = await api(`/api/training-load/metrics/structure-links?domainId=${sysDomain.body.row.id}`, { cookie: otherClub.coachCookie });
  assert.ok(listed.body.rows.some((r) => r.id === domainOnlyLink.body.row.id));
});

// =========================================================================
// 8. Versioning without changing historical values
// =========================================================================
test("8. a new semantic version never reinterprets an already-captured value", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("versioning", 1);
  const created = await api("/api/training-load/metrics/definitions", {
    method: "POST", cookie: sysAdminCookie,
    body: { key: `explosive_${uid()}`, label: "Explosive Distance", ownerScope: "system", unit: "m", valueType: "numeric", conditionDescription: { operator: ">", value: 60, unit: "W/kg" } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const defId = created.body.row.id;

  const entry = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: crypto.randomUUID(), occurredDate: "2026-09-13", scopeLevel: "session", participants: [{ athleteId: athletes[0].athleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, value: 320 }] }] },
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  const occasionId = entry.body.participants[0].occasionIds[0];
  const beforeDetail = await api(`/api/training-load/metrics/occasions/${occasionId}`, { cookie: coachCookie });
  const v1VersionId = beforeDetail.body.values[0].metric_definition_version_id;

  const newVersion = await api(`/api/training-load/metrics/definitions/${defId}/versions`, {
    method: "POST", cookie: sysAdminCookie,
    body: { unit: "m", valueType: "numeric", conditionDescription: { operator: ">", value: 55, unit: "W/kg" }, reason: "threshold corrected" },
  });
  assert.equal(newVersion.status, 201, JSON.stringify(newVersion.body));
  assert.equal(newVersion.body.row.version_number, 2);

  const afterDetail = await api(`/api/training-load/metrics/occasions/${occasionId}`, { cookie: coachCookie });
  assert.equal(afterDetail.body.values[0].metric_definition_version_id, v1VersionId, "the historical value must keep pointing at v1, never silently move to v2");
  assert.equal(Number(afterDetail.body.values[0].value_numeric), 320, "the historical value itself is untouched");
});

// =========================================================================
// 9. Manual correction, retry-safe, complete value set
// =========================================================================
test("9. manual correction preserves history, is retry-safe, and requires the complete value set", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("correction", 1);
  const distDef = await ensureSystemDefinition();
  const speedDef = (await api("/api/training-load/metrics/definitions", { method: "POST", cookie: sysAdminCookie, body: { key: `max_speed_${uid()}`, label: "Max Speed", ownerScope: "system", unit: "km/h", valueType: "numeric" } })).body.row.id;

  const entry = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: {
      requestKey: crypto.randomUUID(), occurredDate: "2026-09-14", scopeLevel: "session",
      participants: [{ athleteId: athletes[0].athleteId, timezone: "UTC", values: [{ metricDefinitionId: distDef, value: 6000 }, { metricDefinitionId: speedDef, value: 27.5 }] }],
    },
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  const occasionId = entry.body.participants[0].occasionIds[0];

  // Partial correction (missing the speed metric) must be rejected.
  const partial = await api(`/api/training-load/metrics/occasions/${occasionId}/correct`, {
    method: "POST", cookie: coachCookie,
    body: { requestKey: crypto.randomUUID(), values: [{ metricDefinitionId: distDef, value: 6300 }] },
  });
  assert.equal(partial.status, 400, JSON.stringify(partial.body));

  const requestKey = crypto.randomUUID();
  const correctBody = { requestKey, values: [{ metricDefinitionId: distDef, value: 6300 }, { metricDefinitionId: speedDef, value: 27.5 }] };
  const first = await api(`/api/training-load/metrics/occasions/${occasionId}/correct`, { method: "POST", cookie: coachCookie, body: correctBody });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const retry = await api(`/api/training-load/metrics/occasions/${occasionId}/correct`, { method: "POST", cookie: coachCookie, body: correctBody });
  assert.equal(retry.status, 201);
  assert.equal(retry.body.occasionId, first.body.occasionId, "identical retry must be idempotent");

  const history = await api(`/api/training-load/metrics/occasions/${first.body.occasionId}/history`, { cookie: coachCookie });
  assert.equal(history.status, 200);
  assert.equal(history.body.rows.length, 2, "the old and new revision must both be visible in history");
  assert.equal(Number(history.body.rows[1].values.find((v) => v.metric_definition_id === distDef).value_numeric), 6000, "the original value must remain readable");
});

// =========================================================================
// 10. Conflict: two independent effective values for the same coverage
// =========================================================================
test("10. two independent effective occasions for the SAME participation+metric are flagged as a conflict, never summed", async () => {
  // Two independently-entered values for the SAME participation (e.g. a
  // GPS-device value and a separately-entered manual estimate) — no
  // supersede relationship between them. This is deliberately created via
  // direct SQL: the public API's own createGroupEvent always creates
  // exactly one occasion per (participant, segment) at event-creation
  // time, so a second, INDEPENDENT occasion for an EXISTING participation
  // (as opposed to a correction, which supersedes) is not reachable
  // through the API surface built in this phase — it is the shape a
  // future import landing on top of a manual entry would produce.
  const { coachCookie, athletes } = await makeClubWithAthletes("conflict", 1);
  const defId = await ensureSystemDefinition();
  const first = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: crypto.randomUUID(), occurredDate: "2026-09-15", scopeLevel: "session", participants: [{ athleteId: athletes[0].athleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, value: 6100 }] }] },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const participantId = (await query(`select id from training_load.metric_event_participants where event_id = $1`, [first.body.eventId])).rows[0].id;
  const versionId = (await query(`select current_version_id from training_load.metric_definitions where id = $1`, [defId])).rows[0].current_version_id;
  const secondOccRes = await query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, content_hash) values ($1,'manual','conflict-h') returning id`, [participantId]);
  await query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) values ($1,$2,$3,5800,'m')`, [secondOccRes.rows[0].id, defId, versionId]);

  const results = await api(`/api/training-load/metrics/results?dateFrom=2026-09-15&dateTo=2026-09-15&athleteIds=${athletes[0].athleteId}`, { cookie: coachCookie });
  assert.equal(results.body.rows.length, 2, "both independent values must remain visible");
  assert.ok(results.body.rows.every((r) => r.conflict === true), "both must be flagged as a conflict");
  const values = results.body.rows.map((r) => Number(r.value)).sort();
  assert.deepEqual(values, [5800, 6100]);
});

// =========================================================================
// 11. Concurrent group-event retry — real HTTP concurrency
// =========================================================================
test("11. concurrent identical group-event submissions never create two events", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("concurrent-create", 1);
  const defId = await ensureSystemDefinition();
  const requestKey = crypto.randomUUID();
  const body = { requestKey, eventName: "Concurrent HTTP retry", occurredDate: "2026-09-16", scopeLevel: "session", participants: [{ athleteId: athletes[0].athleteId, timezone: "UTC", values: [{ metricDefinitionId: defId, value: 900 }] }] };
  const [a, b] = await Promise.all([
    api("/api/training-load/metrics/events", { method: "POST", cookie: coachCookie, body }),
    api("/api/training-load/metrics/events", { method: "POST", cookie: coachCookie, body }),
  ]);
  assert.ok([a.status, b.status].every((s) => s === 201), JSON.stringify([a.body, b.body]));
  const evCount = await query(`select count(*)::int as n from training_load.metric_events where event_name = 'Concurrent HTTP retry'`);
  assert.equal(evCount.rows[0].n, 1, "concurrent identical retries must produce exactly one event");
});

// =========================================================================
// 12. Pagination
// =========================================================================
test("12. definitions catalog paginates with a keyset cursor, never returns everything at once", async () => {
  const seeded = [];
  for (let i = 0; i < 5; i += 1) {
    const res = await api("/api/training-load/metrics/definitions", { method: "POST", cookie: sysAdminCookie, body: { key: `page_metric_${uid()}_${i}`, label: `ZZPage Metric ${uid()}`, ownerScope: "system", unit: "u", valueType: "numeric" } });
    assert.equal(res.status, 201);
    seeded.push(res.body.row.id);
  }
  const firstPage = await api(`/api/training-load/metrics/definitions?search=ZZPage&limit=2`, { cookie: sysAdminCookie });
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.rows.length, 2);
  assert.ok(firstPage.body.nextCursor);
  const secondPage = await api(`/api/training-load/metrics/definitions?search=ZZPage&limit=2&cursorLabel=${encodeURIComponent(firstPage.body.nextCursor.label)}&cursorId=${firstPage.body.nextCursor.id}`, { cookie: sysAdminCookie });
  assert.equal(secondPage.body.rows.length, 2);
  assert.notEqual(secondPage.body.rows[0].id, firstPage.body.rows[0].id);
});

test("12b. results query rejects an oversized date range instead of scanning everything", async () => {
  const { coachCookie } = await makeClubWithAthletes("bigrange", 0);
  const res = await api(`/api/training-load/metrics/results?dateFrom=2020-01-01&dateTo=2026-12-31`, { cookie: coachCookie });
  assert.equal(res.status, 400);
});

// =========================================================================
// 13. History preserved through the existing Builder edit-draft lifecycle
// =========================================================================
test("13. a measurement's linked session name survives the session being renamed/replaced (Builder edit-draft pattern)", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("builderedit", 1);
  const defId = await ensureSystemDefinition();
  const { sessionId, logicalSessionId } = await makePlanSessionForAthlete(athletes[0].athleteId, { date: "2026-09-17", name: "Ponedeljak - Snaga" });

  const entry = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: crypto.randomUUID(), occurredDate: "2026-09-17", scopeLevel: "session", participants: [{ athleteId: athletes[0].athleteId, timezone: "UTC", logicalSessionId, values: [{ metricDefinitionId: defId, value: 4500 }] }] },
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));

  // Simulate Builder's own edit-draft lifecycle: the physical plan_sessions
  // row is renamed then deleted outright (exactly what an edit-draft
  // replace does) — logical_session_id has no FK, so this must not touch
  // the already-recorded measurement at all.
  await query(`update plans.plan_sessions set name = 'Renamed' where id = $1`, [sessionId]);
  await query(`delete from plans.plan_sessions where id = $1`, [sessionId]);

  const detail = await api(`/api/training-load/metrics/occasions/${entry.body.participants[0].occasionIds[0]}`, { cookie: coachCookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.occasion.linked_session_name_snapshot, "Ponedeljak - Snaga", "the snapshot must survive the underlying session being renamed and deleted");
});

// =========================================================================
// 14. Tightened PoC test 17 — deterministic success + pointer/effective
// checks, real service functions, real concurrency, against synthetic
// source data (no public import endpoint exists in this phase).
// =========================================================================
test("14. real correction service vs. a direct raw insert on the same identity+participant — deterministic success, correct final state", async () => {
  const { coachId, athletes } = await makeClubWithAthletes("sourceidentity", 1);
  const connRes = await query(`insert into training_load.metric_source_connections (source_system, owner_scope) values ('synthetic_test_source','system') returning id`);
  const connId = connRes.rows[0].id;
  const eventRes = await query(`insert into training_load.metric_events (occurred_date, scope_level, owner_scope) values ('2026-09-18','session','system') returning id`);
  const eventId = eventRes.rows[0].id;
  const partRes = await query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'UTC') returning id`, [eventId, athletes[0].athleteId]);
  const participantId = partRes.rows[0].id;
  const identityRes = await query(`insert into training_load.metric_source_identities (source_connection_id, source_external_id) values ($1,'SESS-DEADLOCK-TEST') returning id`, [connId]);
  const identityId = identityRes.rows[0].id;
  const defId = await ensureSystemDefinition();
  const versionRes = await query(`select current_version_id from training_load.metric_definitions where id = $1`, [defId]);
  const versionId = versionRes.rows[0].current_version_id;
  const origOccRes = await query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, content_hash, source_identity_id) values ($1,'api_import','orig-h',$2) returning id`, [participantId, identityId]);
  const origOccId = origOccRes.rows[0].id;
  await query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture) values ($1,$2,$3,1000,'m')`, [origOccId, defId, versionId]);
  await query(`update training_load.metric_source_identities set current_occasion_id = $1 where id = $2`, [origOccId, identityId]);

  const clientA = await pool.connect();
  const clientB = await pool.connect();
  const monitor = await pool.connect();
  let releaseA = () => {};
  let aPromise = Promise.resolve();
  let bPromise = Promise.resolve();
  try {
    let signalAReached;
    const aReachedBarrier = new Promise((res) => { signalAReached = res; });
    const aBarrier = new Promise((res) => { releaseA = res; });
    aPromise = measurementsService.correctSourceIdentityOccasion(clientA, {
      sourceIdentityId: identityId, expectedCurrentOccasionId: origOccId,
      newValues: [{ metric_definition_id: defId, metric_definition_version_id: versionId, value_numeric: 1200, unit: "m" }],
      recordedBy: coachId,
      onLocked: async () => { signalAReached(); await aBarrier; },
    });
    await aReachedBarrier;

    bPromise = clientB.query(
      `insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, content_hash, source_identity_id) values ($1,'manual','race-h',$2)`,
      [participantId, identityId],
    );
    const blocked = await waitUntilBlocked(monitor, clientB.processID);
    assert.equal(blocked, true, "B must be directly observed Lock-waiting on the identity row");

    releaseA();
    const aResult = await aPromise;
    assert.equal(aResult.changed, true, "A's correction must deterministically succeed, not just 'not deadlock'");
    await bPromise; // must complete without a deadlock error once unblocked

    const pointerAfter = await monitor.query(`select current_occasion_id from training_load.metric_source_identities where id = $1`, [identityId]);
    assert.equal(pointerAfter.rows[0].current_occasion_id, aResult.occasionId, "the identity's pointer must point at A's new occasion");
    const valueAfter = await monitor.query(`select value_numeric from training_load.metric_values where occasion_id = $1`, [aResult.occasionId]);
    assert.equal(Number(valueAfter.rows[0].value_numeric), 1200, "the effective value must be A's corrected value");
  } finally {
    releaseA();
    await Promise.allSettled([aPromise, bPromise]);
    clientA.release();
    clientB.release();
    monitor.release();
  }
});

// =========================================================================
// 15. RPE-off must not block other metrics
// =========================================================================
test("15. a session with RPE explicitly disabled still accepts other metric measurements", async () => {
  const { coachCookie, athletes } = await makeClubWithAthletes("rpeoff", 1);
  const defId = await ensureSystemDefinition();
  const { logicalSessionId, sessionId } = await makePlanSessionForAthlete(athletes[0].athleteId, { date: "2026-09-19" });
  await query(`alter table plans.plan_sessions add column if not exists rpe_enabled boolean not null default true`);
  await query(`update plans.plan_sessions set rpe_enabled = false where id = $1`, [sessionId]);

  const res = await api("/api/training-load/metrics/events", {
    method: "POST", cookie: coachCookie,
    body: { requestKey: crypto.randomUUID(), occurredDate: "2026-09-19", scopeLevel: "session", participants: [{ athleteId: athletes[0].athleteId, timezone: "UTC", logicalSessionId, values: [{ metricDefinitionId: defId, value: 3000 }] }] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

// =========================================================================
// 16. Platform administrator across a coach's workspace
// =========================================================================
test("16. a platform administrator can manage the system catalog regardless of any club/team workspace", async () => {
  const res = await api("/api/training-load/metrics/domains", { method: "POST", cookie: sysAdminCookie, body: { name: `Platform Domain ${uid()}`, ownerScope: "system" } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test("16b. a non-admin coach cannot create system-scoped catalog content", async () => {
  const { coachCookie } = await makeClubWithAthletes("nonadmin", 0);
  const res = await api("/api/training-load/metrics/domains", { method: "POST", cookie: coachCookie, body: { name: "Should fail", ownerScope: "system" } });
  assert.equal(res.status, 403, JSON.stringify(res.body));
});

// =========================================================================
// 17. Per-user hide/unhide and archive — quick contract smoke tests for
// the remaining catalog routes not otherwise exercised above.
// =========================================================================
test("17. hiding a definition is per-user and does not change its global availability", async () => {
  const defId = await ensureSystemDefinition();
  const { coachCookie: coachA } = await makeClubWithAthletes("hideA", 0);
  const { coachCookie: coachB } = await makeClubWithAthletes("hideB", 0);
  const hideRes = await api(`/api/training-load/metrics/definitions/${defId}/hide`, { method: "POST", cookie: coachA });
  assert.equal(hideRes.status, 200);
  const stillVisibleToB = await api(`/api/training-load/metrics/definitions/${defId}`, { cookie: coachB });
  assert.equal(stillVisibleToB.status, 200, "hiding for coach A must not affect coach B's own catalog view");
  const unhideRes = await api(`/api/training-load/metrics/definitions/${defId}/hide`, { method: "DELETE", cookie: coachA });
  assert.equal(unhideRes.status, 200);
});

test("17b. archiving a definition/domain/category requires management rights and preserves the row (soft archive)", async () => {
  const { coachCookie: ownerCookie } = await makeClubWithAthletes("archiveOwner", 0);
  const domainRes = await api("/api/training-load/metrics/domains", { method: "POST", cookie: ownerCookie, body: { name: "Archivable Domain", ownerScope: "user" } });
  assert.equal(domainRes.status, 201);
  const { coachCookie: otherCookie } = await makeClubWithAthletes("archiveOther", 0);
  const forbidden = await api(`/api/training-load/metrics/domains/${domainRes.body.row.id}/archive`, { method: "POST", cookie: otherCookie });
  assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  const archived = await api(`/api/training-load/metrics/domains/${domainRes.body.row.id}/archive`, { method: "POST", cookie: ownerCookie });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.row.is_active, false);
  const stillInDb = await query(`select id from training_load.metric_domains where id = $1`, [domainRes.body.row.id]);
  assert.equal(stillInDb.rowCount, 1, "archiving must be a soft update, never a delete");
});

test("17c. deleting a structure link requires management rights over the link itself", async () => {
  const { coachCookie: ownerCookie } = await makeClubWithAthletes("linkdelOwner", 0);
  const defId = await ensureSystemDefinition();
  const linkRes = await api("/api/training-load/metrics/structure-links", { method: "POST", cookie: ownerCookie, body: { metricDefinitionId: defId, ownerScope: "user" } });
  assert.equal(linkRes.status, 201, JSON.stringify(linkRes.body));
  const { coachCookie: otherCookie } = await makeClubWithAthletes("linkdelOther", 0);
  const forbidden = await api(`/api/training-load/metrics/structure-links/${linkRes.body.row.id}`, { method: "DELETE", cookie: otherCookie });
  assert.equal(forbidden.status, 403);
  const deleted = await api(`/api/training-load/metrics/structure-links/${linkRes.body.row.id}`, { method: "DELETE", cookie: ownerCookie });
  assert.equal(deleted.status, 200);
});

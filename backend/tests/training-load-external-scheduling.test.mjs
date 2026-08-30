// Training load: RPE sessions scheduled OUTSIDE any Weekly plan
// (migrations_v2/202609011000_training_load_v4_external_scheduling.sql).
// Phase 4 - schema/function/trigger coverage only, direct SQL against the
// new training_load.external_* objects - no API routes exist yet (those
// land in a later phase). Same disposable-DB harness convention as
// training-load.test.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_V1_PATH = path.resolve(__dirname, "../../migrations_v2/202608310900_training_load_v1_session_feedback.sql");
const MIGRATION_V1_NAME = "202608310900_training_load_v1_session_feedback.sql";
const MIGRATION_V2_PATH = path.resolve(__dirname, "../../migrations_v2/202608320900_training_load_v2_logical_session_identity.sql");
const MIGRATION_V2_NAME = "202608320900_training_load_v2_logical_session_identity.sql";
const MIGRATION_V3_PATH = path.resolve(__dirname, "../../migrations_v2/202609010900_training_load_v3_rpe_enabled.sql");
const MIGRATION_V3_NAME = "202609010900_training_load_v3_rpe_enabled.sql";
const MIGRATION_V4_PATH = path.resolve(__dirname, "../../migrations_v2/202609011000_training_load_v4_external_scheduling.sql");
const MIGRATION_V4_NAME = "202609011000_training_load_v4_external_scheduling.sql";

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

// Same legacy-fingerprint stand-in as training-load.test.mjs - required
// scaffolding only, see that file's own header comment for why.
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
    add column created_at timestamptz not null default now(),
    add column updated_at timestamptz not null default now();
`;

async function makeTempDb(label) {
  const name = `optimove_tests_tlext_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_tlext_migrations_${runId}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

let db, adminClient, migrationsDir;
let query, pool;

before(async () => {
  const [v1, v2, v3, v4] = await Promise.all([
    fsp.readFile(MIGRATION_V1_PATH, "utf8"),
    fsp.readFile(MIGRATION_V2_PATH, "utf8"),
    fsp.readFile(MIGRATION_V3_PATH, "utf8"),
    fsp.readFile(MIGRATION_V4_PATH, "utf8"),
  ]);

  db = await makeTempDb("primary");
  adminClient = new pg.Client({ connectionString: db.url });
  await adminClient.connect();
  const ownCheck = await adminClient.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");

  await adminClient.query(LEGACY_FIXTURE_SQL);
  migrationsDir = await writeMigrationsDir("primary", {
    [MIGRATION_V1_NAME]: v1,
    [MIGRATION_V2_NAME]: v2,
    [MIGRATION_V3_NAME]: v3,
    [MIGRATION_V4_NAME]: v4,
  });
  await runner.runMigrations({ databaseUrl: db.url, migrationsRoot: migrationsDir });

  process.env.DATABASE_URL = db.url;
  const dbModule = await import("../src/db.js");
  query = dbModule.query;
  pool = dbModule.pool;
});

after(async () => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  await pool.end();
  await adminClient.end();
  await fsp.rm(migrationsDir, { recursive: true, force: true });
  await dropTempDb(db);
});

// ------------------------------------------------------------
// Fixture helpers
// ------------------------------------------------------------

async function makeClub(name) {
  const result = await query(`insert into public.clubs (name) values ($1) returning id`, [name]);
  return result.rows[0].id;
}
async function makeTeam(clubId, name) {
  const result = await query(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, name]);
  return result.rows[0].id;
}
async function makeUser(label) {
  const result = await query(
    `insert into public.users (email, password_hash, full_name, display_name, role_hint, is_active) values ($1,'x',$1,$1,'user',true) returning id`,
    [`${label}-${crypto.randomBytes(4).toString("hex")}@test.local`],
  );
  return result.rows[0].id;
}
async function makeAthlete(name, deviceTimezone = "UTC") {
  const result = await query(`insert into public.athletes (full_name, display_name, device_timezone) values ($1,$1,$2) returning id`, [name, deviceTimezone]);
  return result.rows[0].id;
}
async function addClubMembership(athleteId, clubId, status = "active") {
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club',$3)`, [athleteId, clubId, status]);
}
async function addTeamMembership(athleteId, teamId, status = "active") {
  await query(`insert into public.athlete_memberships (athlete_id, team_id, membership_type, status) values ($1,$2,'team',$3)`, [athleteId, teamId, status]);
}

const TODAY = new Date().toISOString().slice(0, 10);
function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function makeSchedule(coachUserId, overrides = {}) {
  const {
    scheduleKind = "one_time",
    timezone = "UTC",
    startDate = TODAY,
    endDate = null,
    recurrenceRule = null,
    opensTime = "06:00:00",
    dueTime = null,
    closesTime = "23:59:00",
    status = "active",
    eventName = "National team camp",
    ownerScope = "system",
    ownerUserId = null,
    ownerClubId = null,
    ownerTeamId = null,
  } = overrides;
  const result = await query(
    `insert into training_load.external_schedules
       (schedule_kind, timezone, start_date, end_date, recurrence_rule, recurrence_rule_version, opens_time, due_time, closes_time, status, event_name, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     returning id`,
    [scheduleKind, timezone, startDate, endDate, recurrenceRule ? JSON.stringify(recurrenceRule) : null, opensTime, dueTime, closesTime, status, eventName, coachUserId, ownerScope, ownerUserId, ownerClubId, ownerTeamId],
  );
  return result.rows[0].id;
}
async function addAthleteTarget(scheduleId, athleteId) {
  await query(`insert into training_load.external_schedule_targets (schedule_id, target_kind, target_athlete_id) values ($1,'athlete',$2)`, [scheduleId, athleteId]);
}
async function addTeamTarget(scheduleId, teamId) {
  await query(`insert into training_load.external_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2)`, [scheduleId, teamId]);
}
async function addClubTarget(scheduleId, clubId) {
  await query(`insert into training_load.external_schedule_targets (schedule_id, target_kind, target_club_id) values ($1,'club',$2)`, [scheduleId, clubId]);
}
async function generateOccurrence(scheduleId, date) {
  const result = await query(`select training_load.generate_external_schedule_occurrence($1,$2) as id`, [scheduleId, date]);
  return result.rows[0].id;
}
async function materialize(occurrenceId) {
  const result = await query(`select training_load.materialize_external_assignments_for_occurrence($1) as n`, [occurrenceId]);
  return result.rows[0].n;
}

// ------------------------------------------------------------
// A. external_schedules - CHECK constraints + validation trigger
// ------------------------------------------------------------

test("A1. owner_scope requires exactly one matching owner_*_id set", async () => {
  const coach = await makeUser("a1coach");
  await assert.rejects(() => makeSchedule(coach, { ownerScope: "club", ownerClubId: null }), /check constraint|violates/i);
  const clubId = await makeClub("A1 Club");
  const id = await makeSchedule(coach, { ownerScope: "club", ownerClubId: clubId });
  assert.ok(id);
});

test("A2. schedule_kind='one_time' rejects a non-null recurrence_rule or an end_date different from start_date", async () => {
  const coach = await makeUser("a2coach");
  await assert.rejects(() => makeSchedule(coach, { scheduleKind: "one_time", recurrenceRule: { version: 1, freq: "daily" } }), /check constraint|violates/i);
  await assert.rejects(() => makeSchedule(coach, { scheduleKind: "one_time", endDate: addDaysIso(TODAY, 5) }), /check constraint|violates/i);
});

test("A3. schedule_kind='recurring' requires a non-null recurrence_rule", async () => {
  const coach = await makeUser("a3coach");
  await assert.rejects(() => makeSchedule(coach, { scheduleKind: "recurring", recurrenceRule: null }), /check constraint|violates/i);
  const id = await makeSchedule(coach, { scheduleKind: "recurring", recurrenceRule: { version: 1, freq: "daily" }, endDate: addDaysIso(TODAY, 30) });
  assert.ok(id);
});

test("A4. a recurrence_rule with a mismatched version (vs the recurrence_rule_version column) is rejected by the trigger, not an uncontrolled cast error", async () => {
  const coach = await makeUser("a4coach");
  await assert.rejects(
    () => query(
      `insert into training_load.external_schedules
         (schedule_kind, timezone, start_date, end_date, recurrence_rule, recurrence_rule_version, opens_time, closes_time, status, event_name, created_by_user_id, owner_scope)
       values ('recurring','UTC',$1,$2,$3,1,'06:00','23:00','active','Camp',$4,'system')`,
      [TODAY, addDaysIso(TODAY, 10), JSON.stringify({ version: 2, freq: "daily" }), coach],
    ),
    /version/i,
  );
});

test("A5. an invalid IANA timezone is rejected by the trigger", async () => {
  const coach = await makeUser("a5coach");
  await assert.rejects(() => makeSchedule(coach, { timezone: "Not/A_Real_Zone" }), /not a recognized IANA timezone/i);
});

// ------------------------------------------------------------
// B. external_schedule_targets - NULLS NOT DISTINCT uniqueness
// ------------------------------------------------------------

test("B1. inserting the exact same athlete target twice is rejected, even though target_team_id/target_club_id are both NULL on both rows", async () => {
  const coach = await makeUser("b1coach");
  const scheduleId = await makeSchedule(coach);
  const athleteId = await makeAthlete("B1 Athlete");
  await addAthleteTarget(scheduleId, athleteId);
  await assert.rejects(() => addAthleteTarget(scheduleId, athleteId), /unique|duplicate/i);
});

// ------------------------------------------------------------
// C. Occurrence generation - idempotency + immutability
// ------------------------------------------------------------

test("C1. generate_external_schedule_occurrence is idempotent - two calls with the same (schedule, date) return the same occurrence id", async () => {
  const coach = await makeUser("c1coach");
  const scheduleId = await makeSchedule(coach);
  const first = await generateOccurrence(scheduleId, TODAY);
  const second = await generateOccurrence(scheduleId, TODAY);
  assert.equal(first, second);
  const count = (await query(`select count(*)::int as n from training_load.external_schedule_occurrences where schedule_id = $1`, [scheduleId])).rows[0].n;
  assert.equal(count, 1);
});

test("C2. an occurrence's identity/window columns are immutable after creation; only status and a one-way assignments_materialized_at may change", async () => {
  const coach = await makeUser("c2coach");
  const scheduleId = await makeSchedule(coach);
  const occurrenceId = await generateOccurrence(scheduleId, TODAY);
  await assert.rejects(() => query(`update training_load.external_schedule_occurrences set scheduled_date = $1 where id = $2`, [addDaysIso(TODAY, 1), occurrenceId]), /immutable/i);
  await query(`update training_load.external_schedule_occurrences set status = 'open' where id = $1`, [occurrenceId]);
  await query(`update training_load.external_schedule_occurrences set assignments_materialized_at = now() where id = $1`, [occurrenceId]);
  await assert.rejects(() => query(`update training_load.external_schedule_occurrences set assignments_materialized_at = now() where id = $1`, [occurrenceId]), /immutable/i);
});

// ------------------------------------------------------------
// D. Membership snapshot + materialization
// ------------------------------------------------------------

test("D1. materializing a direct athlete target inserts exactly one assignment, with a per-athlete window derived from the athlete's own device_timezone", async () => {
  const coach = await makeUser("d1coach");
  const scheduleId = await makeSchedule(coach, { opensTime: "06:00:00", closesTime: "22:00:00" });
  const athleteId = await makeAthlete("D1 Athlete", "UTC");
  await addAthleteTarget(scheduleId, athleteId);
  const occurrenceId = await generateOccurrence(scheduleId, TODAY);
  const inserted = await materialize(occurrenceId);
  assert.equal(inserted, 1);
  const assignment = (await query(`select * from training_load.external_assignments where occurrence_id = $1`, [occurrenceId])).rows[0];
  assert.equal(assignment.athlete_id, athleteId);
  assert.equal(assignment.timezone, "UTC");
  assert.equal(assignment.local_scheduled_date, TODAY);
});

test("D2. materializing is safe to call repeatedly - the membership snapshot is taken exactly once, and already-inserted assignments are never duplicated", async () => {
  const coach = await makeUser("d2coach");
  const scheduleId = await makeSchedule(coach);
  const athleteId = await makeAthlete("D2 Athlete");
  await addAthleteTarget(scheduleId, athleteId);
  const occurrenceId = await generateOccurrence(scheduleId, TODAY);
  await materialize(occurrenceId);
  const materializedAtFirst = (await query(`select assignments_materialized_at from training_load.external_schedule_occurrences where id = $1`, [occurrenceId])).rows[0].assignments_materialized_at;
  const secondInserted = await materialize(occurrenceId);
  const materializedAtSecond = (await query(`select assignments_materialized_at from training_load.external_schedule_occurrences where id = $1`, [occurrenceId])).rows[0].assignments_materialized_at;
  assert.equal(secondInserted, 0, "no new rows on the second call - already inserted");
  assert.deepEqual(materializedAtFirst, materializedAtSecond, "the snapshot timestamp must never change once set");
  const count = (await query(`select count(*)::int as n from training_load.external_assignments where occurrence_id = $1`, [occurrenceId])).rows[0].n;
  assert.equal(count, 1);
});

test("D3. a team target resolves via ACTIVE membership only - a paused/removed membership is never resolved", async () => {
  const coach = await makeUser("d3coach");
  const club = await makeClub("D3 Club");
  const team = await makeTeam(club, "D3 Team");
  const activeAthlete = await makeAthlete("D3 Active");
  const pausedAthlete = await makeAthlete("D3 Paused");
  await addTeamMembership(activeAthlete, team, "active");
  await addTeamMembership(pausedAthlete, team, "paused");
  const scheduleId = await makeSchedule(coach);
  await addTeamTarget(scheduleId, team);
  const occurrenceId = await generateOccurrence(scheduleId, TODAY);
  await materialize(occurrenceId);
  const athleteIds = (await query(`select athlete_id from training_load.external_assignments where occurrence_id = $1`, [occurrenceId])).rows.map((r) => r.athlete_id);
  assert.deepEqual(athleteIds, [activeAthlete]);
});

test("D4. a club target resolves via ACTIVE club membership", async () => {
  const coach = await makeUser("d4coach");
  const club = await makeClub("D4 Club");
  const athleteId = await makeAthlete("D4 Athlete");
  await addClubMembership(athleteId, club, "active");
  const scheduleId = await makeSchedule(coach);
  await addClubTarget(scheduleId, club);
  const occurrenceId = await generateOccurrence(scheduleId, TODAY);
  await materialize(occurrenceId);
  const count = (await query(`select count(*)::int as n from training_load.external_assignments where occurrence_id = $1`, [occurrenceId])).rows[0].n;
  assert.equal(count, 1);
});

test("D5. a late joiner (added to a targeted team AFTER the occurrence's membership snapshot) never appears in that occurrence, even after a later materialize call - but is picked up by the NEXT occurrence generated after they joined", async () => {
  const coach = await makeUser("d5coach");
  const club = await makeClub("D5 Club");
  const team = await makeTeam(club, "D5 Team");
  const original = await makeAthlete("D5 Original");
  await addTeamMembership(original, team, "active");
  const scheduleId = await makeSchedule(coach, { scheduleKind: "recurring", recurrenceRule: { version: 1, freq: "daily" }, endDate: addDaysIso(TODAY, 10) });
  await addTeamTarget(scheduleId, team);
  const occurrence1 = await generateOccurrence(scheduleId, TODAY);
  await materialize(occurrence1);

  const lateJoiner = await makeAthlete("D5 Late Joiner");
  await addTeamMembership(lateJoiner, team, "active");
  // Re-materializing the SAME (already-snapshotted) occurrence must never
  // pick up the late joiner - the snapshot is frozen.
  await materialize(occurrence1);
  const occurrence1Athletes = (await query(`select athlete_id from training_load.external_occurrence_target_snapshot where occurrence_id = $1`, [occurrence1])).rows.map((r) => r.athlete_id);
  assert.ok(!occurrence1Athletes.includes(lateJoiner), "the late joiner must never be in the already-snapshotted occurrence");

  // A freshly-generated occurrence for a FUTURE date only snapshots
  // membership - it never immediately materializes an assignment (nobody's
  // local "today" has reached a future scheduled_date yet), so the late
  // joiner's inclusion is checked against the SNAPSHOT table here, not
  // external_assignments (that eligibility gate is already covered by D1).
  const occurrence2 = await generateOccurrence(scheduleId, addDaysIso(TODAY, 1));
  await materialize(occurrence2);
  const occurrence2SnapshotAthletes = (await query(`select athlete_id from training_load.external_occurrence_target_snapshot where occurrence_id = $1`, [occurrence2])).rows.map((r) => r.athlete_id);
  assert.ok(occurrence2SnapshotAthletes.includes(lateJoiner), "a NEW occurrence generated after they joined must resolve them as a normal current target");
});

// ------------------------------------------------------------
// E. Candidate-date resolution - the Round-1 timezone regression test
// ------------------------------------------------------------

test("E1 (Round-1 regression). a schedule in Pacific/Kiritimati (UTC+14) targeting an athlete in America/Adak (UTC-12, ~26h behind) still resolves and materializes that athlete's own real local date - never silently dropped by a schedule-timezone-only guess", async () => {
  const coach = await makeUser("e1coach");
  const athleteId = await makeAthlete("E1 Athlete", "America/Adak");
  const scheduleId = await makeSchedule(coach, {
    timezone: "Pacific/Kiritimati",
    scheduleKind: "recurring",
    recurrenceRule: { version: 1, freq: "daily" },
    startDate: addDaysIso(TODAY, -2),
    endDate: addDaysIso(TODAY, 2),
  });
  await addAthleteTarget(scheduleId, athleteId);

  const datesResult = await query(`select local_date from training_load.resolve_current_external_target_dates($1) order by local_date`, [scheduleId]);
  const dates = datesResult.rows.map((r) => String(r.local_date));
  // The athlete's own real local date (America/Adak) must be among the
  // resolved candidates - this is what a schedule-timezone-only "today +/-
  // one adjacent day" guess (the original WELLNESS bug) could fail to
  // reach for a ~26h-apart pair like this one.
  const adakLocalDateResult = await query(`select (now() at time zone 'America/Adak')::date as d`);
  const adakLocalDate = String(adakLocalDateResult.rows[0].d);
  assert.ok(dates.includes(adakLocalDate), `expected the athlete's own local date (${adakLocalDate}) among resolved candidates, got: ${dates.join(", ")}`);

  const occurrenceId = await generateOccurrence(scheduleId, adakLocalDate);
  const inserted = await materialize(occurrenceId);
  assert.equal(inserted, 1, "the athlete must actually be materialized for their own real local date");
  const assignment = (await query(`select athlete_id, timezone, local_scheduled_date from training_load.external_assignments where occurrence_id = $1`, [occurrenceId])).rows[0];
  assert.equal(assignment.athlete_id, athleteId);
  assert.equal(assignment.timezone, "America/Adak");
});

test("E2. an athlete already snapshotted into an occurrence but not yet materialized, whose team membership is later removed, STILL gets materialized once eligible (outstanding-snapshot candidate)", async () => {
  const coach = await makeUser("e2coach");
  const club = await makeClub("E2 Club");
  const team = await makeTeam(club, "E2 Team");
  const athleteId = await makeAthlete("E2 Athlete", "UTC");
  await addTeamMembership(athleteId, team, "active");
  const scheduleId = await makeSchedule(coach, { timezone: "UTC" });
  await addTeamTarget(scheduleId, team);

  const occurrenceId = await generateOccurrence(scheduleId, TODAY);
  // Manufactures "snapshotted but not yet actually materialized" directly,
  // rather than depending on a real device_timezone offset that happens to
  // diverge from UTC's own calendar date at THIS exact moment - no fixed
  // IANA offset (max +/-14h) can ever guarantee a date divergence across
  // the FULL UTC day, so relying on real wall-clock timing here would be
  // exactly the kind of fragile timezone assumption this whole feature
  // exists to avoid (see this migration's own header comment on the
  // Round-1 bug). Direct INSERT is a real, schema-honest state - it is
  // exactly the row shape materialize_external_assignments_for_occurrence()
  // itself would have produced had it been called between the schedule's
  // snapshot-taking and the athlete's own eligibility window.
  await query(`insert into training_load.external_occurrence_target_snapshot (occurrence_id, athlete_id) values ($1,$2)`, [occurrenceId, athleteId]);
  await query(`update training_load.external_schedule_occurrences set assignments_materialized_at = now() where id = $1`, [occurrenceId]);
  const snapshotRows = (await query(`select 1 from training_load.external_occurrence_target_snapshot where occurrence_id = $1 and athlete_id = $2`, [occurrenceId, athleteId])).rowCount;
  assert.equal(snapshotRows, 1);
  const assignmentRowsBefore = (await query(`select count(*)::int as n from training_load.external_assignments where occurrence_id = $1`, [occurrenceId])).rows[0].n;
  assert.equal(assignmentRowsBefore, 0, "setup check: snapshotted but not yet actually materialized into an assignment");

  // Membership is removed AFTER the snapshot - resolve_external_schedule_
  // target_athletes would no longer resolve this athlete as a current
  // target, but the outstanding-snapshot branch must keep TODAY a
  // candidate date until they're actually materialized.
  await query(`update public.athlete_memberships set status = 'removed' where athlete_id = $1 and team_id = $2`, [athleteId, team]);
  const datesResult = await query(`select local_date from training_load.resolve_current_external_target_dates($1)`, [scheduleId]);
  const dates = datesResult.rows.map((r) => String(r.local_date));
  assert.ok(dates.includes(TODAY), "TODAY must remain a candidate date via the outstanding-snapshot branch, even though membership was removed");

  // Once eligible (UTC athlete, occurrence dated TODAY in UTC - eligible
  // immediately), a later materialize() call for this SAME occurrence must
  // still insert the snapshotted athlete's assignment, even though their
  // membership is now gone - eligibility reads the snapshot, not current
  // membership.
  const inserted = await materialize(occurrenceId);
  assert.equal(inserted, 1);
  const assignmentAthleteIds = (await query(`select athlete_id from training_load.external_assignments where occurrence_id = $1`, [occurrenceId])).rows.map((r) => r.athlete_id);
  assert.deepEqual(assignmentAthleteIds, [athleteId]);
});

// ------------------------------------------------------------
// F. external_assignments - immutability + status lifecycle
// ------------------------------------------------------------

test("F1. an assignment's timezone/window columns are immutable once materialized", async () => {
  const coach = await makeUser("f1coach");
  const scheduleId = await makeSchedule(coach);
  const athleteId = await makeAthlete("F1 Athlete");
  await addAthleteTarget(scheduleId, athleteId);
  const occurrenceId = await generateOccurrence(scheduleId, TODAY);
  await materialize(occurrenceId);
  const assignmentId = (await query(`select id from training_load.external_assignments where occurrence_id = $1`, [occurrenceId])).rows[0].id;
  await assert.rejects(() => query(`update training_load.external_assignments set local_scheduled_date = $1 where id = $2`, [addDaysIso(TODAY, 1), assignmentId]), /immutable/i);
});

test("F2. status transitions only move forward through the rank order, never backward and never out of a terminal state", async () => {
  const coach = await makeUser("f2coach");
  const scheduleId = await makeSchedule(coach);
  const athleteId = await makeAthlete("F2 Athlete");
  await addAthleteTarget(scheduleId, athleteId);
  const occurrenceId = await generateOccurrence(scheduleId, TODAY);
  await materialize(occurrenceId);
  const assignmentId = (await query(`select id from training_load.external_assignments where occurrence_id = $1`, [occurrenceId])).rows[0].id;

  await query(`update training_load.external_assignments set status = 'open' where id = $1`, [assignmentId]);
  await assert.rejects(() => query(`update training_load.external_assignments set status = 'pending' where id = $1`, [assignmentId]), /backward/i);
  await query(`update training_load.external_assignments set status = 'completed', completed_at = now() where id = $1`, [assignmentId]);
  await assert.rejects(() => query(`update training_load.external_assignments set status = 'open' where id = $1`, [assignmentId]), /terminal/i);
});

test("F3. the occurrence-level idempotency key: two athletes both targeted (direct + via team) resolve to only ONE assignment each, never duplicated by the union", async () => {
  const coach = await makeUser("f3coach");
  const club = await makeClub("F3 Club");
  const team = await makeTeam(club, "F3 Team");
  const athleteId = await makeAthlete("F3 Athlete");
  await addTeamMembership(athleteId, team, "active");
  const scheduleId = await makeSchedule(coach);
  await addAthleteTarget(scheduleId, athleteId);
  await addTeamTarget(scheduleId, team);
  const occurrenceId = await generateOccurrence(scheduleId, TODAY);
  await materialize(occurrenceId);
  const count = (await query(`select count(*)::int as n from training_load.external_assignments where occurrence_id = $1 and athlete_id = $2`, [occurrenceId, athleteId])).rows[0].n;
  assert.equal(count, 1, "an athlete targeted both directly and via a team must still get exactly one assignment");
});

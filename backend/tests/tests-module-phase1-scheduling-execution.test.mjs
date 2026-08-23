// Validates migrations_v2/202608240900_tests_v42_phase1_scheduling_execution.sql -
// the generic scheduling/assignment/execution/results/access-link/
// notification-rule layer built ON TOP of the already-applied Tests v4.2
// catalog (202608220900_tests_v42_schema.sql,
// 202608221000_tests_v42_seed_wellness_fms.sql - NOT modified here).
//
// Runs entirely against a disposable, uniquely-named temporary database
// (never OPTIMOVE, never monitoring2) through the real Strategy B runner
// (backend/src/migrate.js) - not a hand-simulated apply. WELLNESS is used
// throughout as the end-to-end proof case, using its REAL seeded ids from
// the seed migration (read directly, not re-derived).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";
import { computeAndStoreTestAssessmentDerivedResults } from "../src/testAssessmentCalculations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, "../../migrations_v2/202608220900_tests_v42_schema.sql");
const SEED_PATH = path.resolve(__dirname, "../../migrations_v2/202608221000_tests_v42_seed_wellness_fms.sql");
const PHASE1_PATH = path.resolve(__dirname, "../../migrations_v2/202608240900_tests_v42_phase1_scheduling_execution.sql");
const SCHEMA_NAME = "202608220900_tests_v42_schema.sql";
const SEED_NAME = "202608221000_tests_v42_seed_wellness_fms.sql";
const PHASE1_NAME = "202608240900_tests_v42_phase1_scheduling_execution.sql";

// Real seeded WELLNESS ids, copied from the seed migration (source of truth,
// not re-derived at runtime).
const WELLNESS_TEST_VERSION_ID = "7a386bd1-d25e-4651-9012-e76d9dc32559";
const WELLNESS_PARAM = {
  fatigue: "f33abe4e-f2c2-48f7-89b0-e4c96ca0f6ea",
  sleep: "bde22df8-ecaa-41db-878f-e377b236772e",
  soreness: "82793b38-757b-48c5-a2ae-b677bf2bb653",
  stress: "4d71286c-911e-4a86-9541-0fd189c41e59",
  mood: "08144417-8f16-4fd5-b35f-a2c983e0f180",
  injury: "a98f2afb-b458-40ff-98a7-c6b5108bba9e",
};
const WELLNESS_TOTAL_DERIVED_ID = "a342af02-52cb-4b39-83d5-3b7861fe2069";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const baseUrl = new URL(process.env.DATABASE_URL);
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

// Extends the established legacy-fingerprint fixture (see
// tests-module-v42-migrations.test.mjs) with the REAL columns Phase 1 needs:
// athlete_memberships (for team/club materialization), and enough columns
// on users/clubs/teams/athletes for Phase 1's own FKs to resolve.
const LEGACY_FIXTURE_SQL = `
  create extension if not exists pgcrypto;

  create table public.clubs (id uuid primary key default gen_random_uuid(), name text);
  create table public.teams (id uuid primary key default gen_random_uuid(), club_id uuid references public.clubs(id));
  alter table public.teams add constraint teams_id_club_id_unique unique (id, club_id);
  create table public.users (id uuid primary key default gen_random_uuid(), full_name text);
  create table public.athletes (id uuid primary key default gen_random_uuid(), source_external_id text, full_name text);
  create table public.athlete_memberships (
    id uuid primary key default gen_random_uuid(),
    athlete_id uuid not null references public.athletes(id),
    club_id uuid references public.clubs(id),
    team_id uuid references public.teams(id),
    membership_type varchar not null,
    status varchar not null default 'active'
  );
  create table public.user_global_roles (id uuid primary key default gen_random_uuid(), revoked_at timestamptz);
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
`;

async function makeTempDb(label) {
  const name = `optimove_tests_phase1_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_phase1_migrations_${runId}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

let db, client, migrationsDir, schemaSql, seedSql, phase1Sql;
let clubId, teamId, coachUserId, athleteAId, athleteBId, athleteCId;

before(async () => {
  schemaSql = await fsp.readFile(SCHEMA_PATH, "utf8");
  seedSql = await fsp.readFile(SEED_PATH, "utf8");
  phase1Sql = await fsp.readFile(PHASE1_PATH, "utf8");

  db = await makeTempDb("primary");
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
  const ownCheck = await client.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");

  await client.query(LEGACY_FIXTURE_SQL);
  migrationsDir = await writeMigrationsDir("primary", {
    [SCHEMA_NAME]: schemaSql,
    [SEED_NAME]: seedSql,
    [PHASE1_NAME]: phase1Sql,
  });
  await runner.runMigrations({ databaseUrl: db.url, migrationsRoot: migrationsDir });

  const club = await client.query(`insert into public.clubs (name) values ('QA Club') returning id`);
  clubId = club.rows[0].id;
  const team = await client.query(`insert into public.teams (club_id) values ($1) returning id`, [clubId]);
  teamId = team.rows[0].id;
  const coach = await client.query(`insert into public.users (full_name) values ('QA Coach') returning id`);
  coachUserId = coach.rows[0].id;
  const a = await client.query(`insert into public.athletes (full_name) values ('Athlete A') returning id`);
  athleteAId = a.rows[0].id;
  const b = await client.query(`insert into public.athletes (full_name) values ('Athlete B') returning id`);
  athleteBId = b.rows[0].id;
  const c = await client.query(`insert into public.athletes (full_name) values ('Athlete C (no membership)') returning id`);
  athleteCId = c.rows[0].id;
  await client.query(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status) values ($1,$2,$3,'team','active'), ($4,$2,$3,'team','active')`,
    [athleteAId, clubId, teamId, athleteBId],
  );
});

after(async () => {
  await client.end();
  await fsp.rm(migrationsDir, { recursive: true, force: true });
  await dropTempDb(db);
});

// ==================================================================
// A. Migration mechanics
// ==================================================================

test("A1. all three migrations apply and are recorded, in order", async () => {
  const rows = await client.query(
    `select migration_name from public.schema_migrations where migration_name = any($1) order by migration_name`,
    [[SCHEMA_NAME, SEED_NAME, PHASE1_NAME].map((n) => `${path.basename(migrationsDir)}/${n}`)],
  );
  assert.equal(rows.rowCount, 3);
});

test("A2. re-run is idempotent: skipped by checksum, no duplicate rows/tables", async () => {
  await assert.doesNotReject(() => runner.runMigrations({ databaseUrl: db.url, migrationsRoot: migrationsDir }));
  const rows = await client.query(
    `select count(*) c from public.schema_migrations where migration_name = any($1)`,
    [[SCHEMA_NAME, SEED_NAME, PHASE1_NAME].map((n) => `${path.basename(migrationsDir)}/${n}`)],
  );
  assert.equal(rows.rows[0].c, "3");
});

test("A3. a deliberately broken Phase 1 migration variant leaves zero new tables and is never recorded (full rollback)", async () => {
  const broken = await makeTempDb("broken");
  const brokenClient = new pg.Client({ connectionString: broken.url });
  await brokenClient.connect();
  try {
    await brokenClient.query(LEGACY_FIXTURE_SQL);
    const brokenPhase1 = phase1Sql + "\ncreate table tests.this_will_fail (id uuid references tests.does_not_exist(id));\n";
    const dir = await writeMigrationsDir("broken", {
      [SCHEMA_NAME]: schemaSql,
      [SEED_NAME]: seedSql,
      [PHASE1_NAME]: brokenPhase1,
    });
    try {
      await assert.rejects(() => runner.runMigrations({ databaseUrl: broken.url, migrationsRoot: dir }));
      const recorded = await brokenClient.query(
        `select count(*) c from public.schema_migrations where migration_name = $1`,
        [`${path.basename(dir)}/${PHASE1_NAME}`],
      );
      assert.equal(recorded.rows[0].c, "0", "the broken migration must never be recorded as applied");
      const tableExists = await brokenClient.query(
        `select 1 from information_schema.tables where table_schema='tests' and table_name='test_schedules'`,
      );
      assert.equal(tableExists.rowCount, 0, "no Phase 1 table may exist after a rolled-back migration");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  } finally {
    await brokenClient.end();
    await dropTempDb(broken);
  }
});

test("A4. the Phase 1 migration file has no top-level transaction-control statements", () => {
  assert.doesNotThrow(() => runner.assertNoTransactionControl(phase1Sql, PHASE1_NAME));
});

// ==================================================================
// B. Schedule XOR references and target XOR
// ==================================================================

function futureDate(daysFromNow) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function makeDailyWellnessSchedule({ startDate = futureDate(1), timezone = "Europe/Belgrade" } = {}) {
  // owner_scope='team' carries ONLY owner_team_id (not owner_club_id too) -
  // same mutual-exclusivity convention as tests.test/tests.test_battery's
  // own owner_scope CHECK; the team's own club is reachable via
  // public.teams.club_id, not duplicated here.
  const r = await client.query(
    `insert into tests.test_schedules
       (test_version_id, schedule_kind, timezone, start_date, recurrence_rule, opens_time, due_time, closes_time, status, created_by_user_id, owner_scope, owner_team_id)
     values ($1, 'recurring', $2, $3, $4, '06:00', '20:00', '23:59', 'active', $5, 'team', $6)
     returning id`,
    [WELLNESS_TEST_VERSION_ID, timezone, startDate, JSON.stringify({ version: 1, freq: "daily" }), coachUserId, teamId],
  );
  return r.rows[0].id;
}

// Point 2: an independent coach has no club/team at all - owner_scope='user'
// must work standalone, matching the existing OptiMove ownership model
// (tests.test/tests.test_battery already support this scope).
async function makeIndependentCoachSchedule({ startDate = futureDate(1) } = {}) {
  const r = await client.query(
    `insert into tests.test_schedules
       (test_version_id, schedule_kind, timezone, start_date, opens_time, closes_time, status, created_by_user_id, owner_scope, owner_user_id)
     values ($1, 'one_time', 'UTC', $2, '06:00', '23:59', 'active', $3, 'user', $3)
     returning id`,
    [WELLNESS_TEST_VERSION_ID, startDate, coachUserId],
  );
  return r.rows[0].id;
}

test("B1. a schedule with BOTH test_version_id and test_battery_version_id is rejected (XOR)", async () => {
  const fmsBatteryVersion = await client.query(`select id from tests.test_battery_versions limit 1`);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedules (test_version_id, test_battery_version_id, schedule_kind, timezone, start_date, opens_time, closes_time, status, created_by_user_id, owner_scope, owner_club_id)
       values ($1, $2, 'one_time', 'UTC', $3, '06:00', '23:59', 'active', $4, 'club', $5)`,
      [WELLNESS_TEST_VERSION_ID, fmsBatteryVersion.rows[0].id, futureDate(1), coachUserId, clubId],
    ),
  );
});

test("B2. a schedule with NEITHER test_version_id nor test_battery_version_id is rejected (XOR)", async () => {
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedules (schedule_kind, timezone, start_date, opens_time, closes_time, status, created_by_user_id, owner_scope, owner_club_id)
       values ('one_time', 'UTC', $1, '06:00', '23:59', 'active', $2, 'club', $3)`,
      [futureDate(1), coachUserId, clubId],
    ),
  );
});

test("B1b. an owner_scope='club' schedule with no owner_club_id is rejected (ownership CHECK)", async () => {
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedules (test_version_id, schedule_kind, timezone, start_date, opens_time, closes_time, status, created_by_user_id, owner_scope)
       values ($1, 'one_time', 'UTC', $2, '06:00', '23:59', 'active', $3, 'club')`,
      [WELLNESS_TEST_VERSION_ID, futureDate(1), coachUserId],
    ),
  );
});

test("B7. an independent coach (owner_scope='user', no club/team at all) can create and use a schedule end to end", async () => {
  const scheduleId = await makeIndependentCoachSchedule();
  const row = await client.query(`select owner_scope, owner_user_id, owner_club_id, owner_team_id from tests.test_schedules where id=$1`, [scheduleId]);
  assert.equal(row.rows[0].owner_scope, "user");
  assert.equal(row.rows[0].owner_user_id, coachUserId);
  assert.equal(row.rows[0].owner_club_id, null);
  assert.equal(row.rows[0].owner_team_id, null);

  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id) values ($1,'athlete',$2)`, [scheduleId, athleteAId]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(1)])).rows[0].id;
  const materialized = await client.query(`select tests.materialize_test_assignments_for_occurrence($1) as n`, [occId]);
  assert.equal(materialized.rows[0].n, 1);
});

test("B3. a valid daily WELLNESS schedule is accepted", async () => {
  const id = await makeDailyWellnessSchedule();
  assert.ok(id);
});

test("B4. a schedule target row with two target FKs set at once is rejected", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id, target_team_id) values ($1,'athlete',$2,$3)`,
      [scheduleId, athleteAId, teamId],
    ),
  );
});

test("B5. a schedule target row with NO target FK set is rejected", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await assert.rejects(() =>
    client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind) values ($1,'team')`, [scheduleId]),
  );
});

test("B6. a team target is accepted", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const r = await client.query(
    `insert into tests.test_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2) returning id`,
    [scheduleId, teamId],
  );
  assert.ok(r.rows[0].id);
});

test("B8. the identical athlete target added twice is rejected (NULLS NOT DISTINCT duplicate detection)", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id) values ($1,'athlete',$2)`, [scheduleId, athleteAId]);
  await assert.rejects(() =>
    client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id) values ($1,'athlete',$2)`, [scheduleId, athleteAId]),
  );
});

test("B9. the identical team target added twice is rejected", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2)`, [scheduleId, teamId]);
  await assert.rejects(() => client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2)`, [scheduleId, teamId]));
});

test("B10. the identical club target added twice is rejected", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_club_id) values ($1,'club',$2)`, [scheduleId, clubId]);
  await assert.rejects(() => client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_club_id) values ($1,'club',$2)`, [scheduleId, clubId]));
});

test("B11. a well-formed IANA timezone (America/New_York) is accepted; a made-up one is rejected", async () => {
  const good = await client.query(
    `insert into tests.test_schedules (test_version_id, schedule_kind, timezone, start_date, opens_time, closes_time, status, created_by_user_id, owner_scope, owner_club_id)
     values ($1,'one_time','America/New_York',$2,'06:00','23:59','active',$3,'club',$4) returning id`,
    [WELLNESS_TEST_VERSION_ID, futureDate(1), coachUserId, clubId],
  );
  assert.ok(good.rows[0].id);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedules (test_version_id, schedule_kind, timezone, start_date, opens_time, closes_time, status, created_by_user_id, owner_scope, owner_club_id)
       values ($1,'one_time','Not/A_Real_Zone',$2,'06:00','23:59','active',$3,'club',$4)`,
      [WELLNESS_TEST_VERSION_ID, futureDate(1), coachUserId, clubId],
    ),
  );
});

test("B12. a recurrence_rule.version that is a JSON boolean (not a number) is rejected with a controlled error, not a raw cast crash", async () => {
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedules (test_version_id, schedule_kind, timezone, start_date, recurrence_rule, opens_time, closes_time, status, created_by_user_id, owner_scope, owner_club_id)
       values ($1,'recurring','UTC',$2,$3,'06:00','23:59','active',$4,'club',$5)`,
      [WELLNESS_TEST_VERSION_ID, futureDate(1), JSON.stringify({ version: true, freq: "daily" }), coachUserId, clubId],
    ),
  );
});

test("B13. a recurrence_rule.version that mismatches the recurrence_rule_version column is rejected", async () => {
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedules (test_version_id, schedule_kind, timezone, start_date, recurrence_rule, recurrence_rule_version, opens_time, closes_time, status, created_by_user_id, owner_scope, owner_club_id)
       values ($1,'recurring','UTC',$2,$3,1,'06:00','23:59','active',$4,'club',$5)`,
      [WELLNESS_TEST_VERSION_ID, futureDate(1), JSON.stringify({ version: 2, freq: "daily" }), coachUserId, clubId],
    ),
  );
});

// ==================================================================
// C. Occurrence generation: idempotency, snapshot, timezone
// ==================================================================

test("C1. generating the same occurrence twice returns the SAME row (idempotent)", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const date = futureDate(2);
  const first = await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, date]);
  const second = await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, date]);
  assert.equal(first.rows[0].id, second.rows[0].id);
  const count = await client.query(`select count(*) c from tests.test_schedule_occurrences where schedule_id=$1 and scheduled_date=$2`, [scheduleId, date]);
  assert.equal(count.rows[0].c, "1");
});

test("C2. an occurrence snapshots the schedule's test_version_id automatically", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(3)])).rows[0].id;
  const row = await client.query(`select snapshot_test_version_id, snapshot_test_battery_version_id from tests.test_schedule_occurrences where id=$1`, [occId]);
  assert.equal(row.rows[0].snapshot_test_version_id, WELLNESS_TEST_VERSION_ID);
  assert.equal(row.rows[0].snapshot_test_battery_version_id, null);
});

test("C3. generating an occurrence for a cancelled schedule is rejected", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`update tests.test_schedules set status='cancelled' where id=$1`, [scheduleId]);
  await assert.rejects(() => client.query(`select tests.generate_test_schedule_occurrence($1,$2)`, [scheduleId, futureDate(2)]));
});

test("C4. timezone conversion: a schedule opening at 06:00 in a UTC-8 timezone opens 14:00 UTC (date boundary handled correctly)", async () => {
  const scheduleId = await makeDailyWellnessSchedule({ timezone: "America/Los_Angeles", startDate: futureDate(5) });
  const date = futureDate(5);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, date])).rows[0].id;
  const row = await client.query(`select opens_at at time zone 'UTC' as opens_utc, closes_at at time zone 'UTC' as closes_utc from tests.test_schedule_occurrences where id=$1`, [occId]);
  const opensUtc = row.rows[0].opens_utc;
  // 06:00 America/Los_Angeles is UTC-7 or UTC-8 depending on DST; assert the
  // UTC hour differs from the naive local hour, proving real tz conversion
  // happened rather than a bare "treat as UTC" bug.
  assert.notEqual(opensUtc.getUTCHours(), 6, "opens_at must be converted through the schedule's own timezone, not stored as if it were already UTC");
});

test("C5. generating an occurrence for a PAUSED (not just cancelled) schedule is rejected", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`update tests.test_schedules set status='paused' where id=$1`, [scheduleId]);
  await assert.rejects(() => client.query(`select tests.generate_test_schedule_occurrence($1,$2)`, [scheduleId, futureDate(2)]));
});

test("C6. an occurrence's identity/snapshot columns are immutable after creation", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(12)])).rows[0].id;
  await assert.rejects(() => client.query(`update tests.test_schedule_occurrences set scheduled_date = scheduled_date + 1 where id=$1`, [occId]));
  await assert.rejects(() => client.query(`update tests.test_schedule_occurrences set opens_at = opens_at + interval '1 hour' where id=$1`, [occId]));
  // status IS allowed to change.
  await assert.doesNotReject(() => client.query(`update tests.test_schedule_occurrences set status='open' where id=$1`, [occId]));
});

// ==================================================================
// D. Assignment materialization: idempotency, team snapshot, duplicates
// ==================================================================

test("D1. materializing a team target creates one assignment per active team member, idempotently", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2)`, [scheduleId, teamId]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(4)])).rows[0].id;

  const first = await client.query(`select tests.materialize_test_assignments_for_occurrence($1) as n`, [occId]);
  assert.equal(first.rows[0].n, 2, "athlete A and B are active team members, athlete C is not");

  const second = await client.query(`select tests.materialize_test_assignments_for_occurrence($1) as n`, [occId]);
  assert.equal(second.rows[0].n, 0, "second call must insert nothing new - idempotent");

  const count = await client.query(`select count(*) c from tests.test_assignments where occurrence_id=$1`, [occId]);
  assert.equal(count.rows[0].c, "2");
});

test("D2. a team member added AFTER materialization does not retroactively appear in that occurrence's assignments", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2)`, [scheduleId, teamId]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(6)])).rows[0].id;
  await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occId]);

  // Athlete C joins the team AFTER this occurrence already materialized.
  await client.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status) values ($1,$2,$3,'team','active')`, [athleteCId, clubId, teamId]);
  await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occId]); // re-run, simulating a periodic re-materialize job

  const hasC = await client.query(`select 1 from tests.test_assignments where occurrence_id=$1 and athlete_id=$2`, [occId, athleteCId]);
  assert.equal(hasC.rowCount, 0, "membership snapshot at generation/first-materialization time must not change after the fact");
});

test("D3. inserting a duplicate (occurrence_id, athlete_id) assignment directly is rejected", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(7)])).rows[0].id;
  await client.query(`insert into tests.test_assignments (occurrence_id, athlete_id) values ($1,$2)`, [occId, athleteAId]);
  await assert.rejects(() => client.query(`insert into tests.test_assignments (occurrence_id, athlete_id) values ($1,$2)`, [occId, athleteAId]));
});

test("D4. a target that resolves to ZERO athletes still completes materialization (assignments_materialized_at is set), and a member added afterward is still excluded", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const emptyTeam = await client.query(`insert into public.teams (club_id) values ($1) returning id`, [clubId]);
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2)`, [scheduleId, emptyTeam.rows[0].id]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(13)])).rows[0].id;

  const first = await client.query(`select tests.materialize_test_assignments_for_occurrence($1) as n`, [occId]);
  assert.equal(first.rows[0].n, 0, "the team has no members yet");
  const flagged = await client.query(`select assignments_materialized_at from tests.test_schedule_occurrences where id=$1`, [occId]);
  assert.ok(flagged.rows[0].assignments_materialized_at, "materialization must be marked complete even though it produced zero assignments");

  await client.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status) values ($1,$2,$3,'team','active')`, [athleteCId, clubId, emptyTeam.rows[0].id]);
  const second = await client.query(`select tests.materialize_test_assignments_for_occurrence($1) as n`, [occId]);
  assert.equal(second.rows[0].n, 0, "already materialized (even at zero) must stay a no-op forever, not retroactively pick up the new member");
});

test("D5. two concurrent materialization calls for the same occurrence converge on the same final snapshot (row-locked, no duplicate work)", async () => {
  // A fresh, isolated team/membership pair - not the shared teamId/athleteA/
  // athleteB fixture other tests (e.g. D2) also add members to over time -
  // so this test's expected count can never drift from cross-test coupling.
  const isolatedTeam = await client.query(`insert into public.teams (club_id) values ($1) returning id`, [clubId]);
  const isolatedAthlete1 = await client.query(`insert into public.athletes (full_name) values ('D5 Athlete 1') returning id`);
  const isolatedAthlete2 = await client.query(`insert into public.athletes (full_name) values ('D5 Athlete 2') returning id`);
  await client.query(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status) values ($1,$2,$3,'team','active'), ($4,$2,$3,'team','active')`,
    [isolatedAthlete1.rows[0].id, clubId, isolatedTeam.rows[0].id, isolatedAthlete2.rows[0].id],
  );

  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2)`, [scheduleId, isolatedTeam.rows[0].id]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(14)])).rows[0].id;

  const clientA = new pg.Client({ connectionString: db.url });
  const clientB = new pg.Client({ connectionString: db.url });
  await clientA.connect();
  await clientB.connect();
  try {
    const [resultA, resultB] = await Promise.all([
      clientA.query(`select tests.materialize_test_assignments_for_occurrence($1) as n`, [occId]),
      clientB.query(`select tests.materialize_test_assignments_for_occurrence($1) as n`, [occId]),
    ]);
    const counts = [resultA.rows[0].n, resultB.rows[0].n].sort((a, b) => a - b);
    assert.deepEqual(counts, [0, 2], "exactly one of the two concurrent calls does the real work (2 team members), the other sees it already materialized and returns 0");
    const finalCount = await client.query(`select count(*) c from tests.test_assignments where occurrence_id=$1`, [occId]);
    assert.equal(finalCount.rows[0].c, "2", "no duplicate assignments from the race");
  } finally {
    await clientA.end();
    await clientB.end();
  }
});

// ==================================================================
// E-M. Execution/results
// ==================================================================

async function makeStandaloneWellnessAssessment(athleteId, { status = "draft" } = {}) {
  const r = await client.query(
    `insert into tests.test_assessments (athlete_id, test_version_id, attempt_number, source, status, assessed_at)
     values ($1, $2, 1, 'athlete_self', $3, now()) returning id`,
    [athleteId, WELLNESS_TEST_VERSION_ID, status],
  );
  return r.rows[0].id;
}

test("E1. a standalone assessment (no schedule, no assignment) is accepted", async () => {
  const id = await makeStandaloneWellnessAssessment(athleteAId);
  assert.ok(id);
});

test("F1. multiple attempts of the same test on the same day are independent rows (CMJ-style)", async () => {
  // WELLNESS itself is single-attempt in practice, but attempt_number is
  // generic - prove it against a throwaway ad hoc test_version (CMJ is not
  // part of the seeded catalog), same shape as any real multi-attempt test.
  const test1 = await client.query(`insert into tests.test (owner_scope) values ('system') returning id`);
  const version1 = await client.query(
    `insert into tests.test_versions (test_id, version_number, status, name) values ($1,1,'draft','CMJ') returning id`,
    [test1.rows[0].id],
  );
  const jumpHeight = await client.query(
    `insert into tests.test_parameters (test_version_id, parameter_key, parameter, value_type) values ($1,'jump_height_cm','Jump height','numeric') returning id`,
    [version1.rows[0].id],
  );
  await client.query(`update tests.test_versions set status='active', published_at=now() where id=$1`, [version1.rows[0].id]);
  const a1 = await client.query(`insert into tests.test_assessments (athlete_id, test_version_id, attempt_number, source, status) values ($1,$2,1,'coach_manual','draft') returning id`, [athleteAId, version1.rows[0].id]);
  const a2 = await client.query(`insert into tests.test_assessments (athlete_id, test_version_id, attempt_number, source, status) values ($1,$2,2,'coach_manual','draft') returning id`, [athleteAId, version1.rows[0].id]);
  assert.notEqual(a1.rows[0].id, a2.rows[0].id);
  await client.query(`insert into tests.test_assessment_values (assessment_id, test_version_id, test_parameter_id, value_numeric) values ($1,$2,$3,38.2)`, [a1.rows[0].id, version1.rows[0].id, jumpHeight.rows[0].id]);
  await client.query(`insert into tests.test_assessment_values (assessment_id, test_version_id, test_parameter_id, value_numeric) values ($1,$2,$3,40.1)`, [a2.rows[0].id, version1.rows[0].id, jumpHeight.rows[0].id]);
  const rows = await client.query(`select attempt_number from tests.test_assessments where athlete_id=$1 and test_version_id=$2 order by attempt_number`, [athleteAId, version1.rows[0].id]);
  assert.deepEqual(rows.rows.map((r) => r.attempt_number), [1, 2]);
});

test("G1. an FMS battery assessment with a correctly-linked item assessment is accepted", async () => {
  const battery = await client.query(`select id, battery_version_id from tests.test_battery_items limit 1`);
  const batteryVersionId = battery.rows[0].battery_version_id;
  const itemId = battery.rows[0].id;
  const item = await client.query(`select test_version_id from tests.test_battery_items where id=$1`, [itemId]);

  const ba = await client.query(
    `insert into tests.test_battery_assessments (athlete_id, battery_version_id, status) values ($1,$2,'draft') returning id`,
    [athleteAId, batteryVersionId],
  );
  const itemAssessment = await client.query(
    `insert into tests.test_assessments (athlete_id, test_version_id, battery_assessment_id, battery_version_id, battery_item_id, attempt_number, source, status)
     values ($1,$2,$3,$4,$5,1,'coach_manual','draft') returning id`,
    [athleteAId, item.rows[0].test_version_id, ba.rows[0].id, batteryVersionId, itemId],
  );
  assert.ok(itemAssessment.rows[0].id);
});

test("G2. an item assessment whose battery_item_id belongs to a DIFFERENT battery_version than declared is rejected", async () => {
  const items = await client.query(`select id, battery_version_id, test_version_id from tests.test_battery_items limit 2`);
  const realItem = items.rows[0];
  const otherBatteryVersionId = (await client.query(`select id from tests.test_battery_versions where id <> $1 limit 1`, [realItem.battery_version_id])).rows[0]?.id;
  const ba = await client.query(`insert into tests.test_battery_assessments (athlete_id, battery_version_id, status) values ($1,$2,'draft') returning id`, [athleteAId, realItem.battery_version_id]);
  if (!otherBatteryVersionId) return; // only one battery version exists in this seed - nothing to mismatch against
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_assessments (athlete_id, test_version_id, battery_assessment_id, battery_version_id, battery_item_id, attempt_number, source, status)
       values ($1,$2,$3,$4,$5,1,'coach_manual','draft')`,
      [athleteAId, realItem.test_version_id, ba.rows[0].id, otherBatteryVersionId, realItem.id],
    ),
  );
});

test("G3. an item assessment with a DIFFERENT athlete than its parent battery assessment is rejected", async () => {
  const battery = await client.query(`select id, battery_version_id, test_version_id from tests.test_battery_items limit 1`);
  const ba = await client.query(`insert into tests.test_battery_assessments (athlete_id, battery_version_id, status) values ($1,$2,'draft') returning id`, [athleteAId, battery.rows[0].battery_version_id]);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_assessments (athlete_id, test_version_id, battery_assessment_id, battery_version_id, battery_item_id, attempt_number, source, status)
       values ($1,$2,$3,$4,$5,1,'coach_manual','draft')`,
      [athleteBId, battery.rows[0].test_version_id, ba.rows[0].id, battery.rows[0].battery_version_id, battery.rows[0].id],
    ),
  );
});

test("G4. an item assessment can inherit the parent battery assessment's own assignment, or have NULL - but never a DIFFERENT assignment/occurrence", async () => {
  const scheduleId = await makeDailyWellnessSchedule({ startDate: futureDate(15) });
  await client.query(`update tests.test_schedules set test_version_id=null, test_battery_version_id=(select id from tests.test_battery_versions limit 1) where id=$1`, [scheduleId]);
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id) values ($1,'athlete',$2)`, [scheduleId, athleteAId]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(15)])).rows[0].id;
  await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occId]);
  const assignment = await client.query(`select id from tests.test_assignments where occurrence_id=$1 and athlete_id=$2`, [occId, athleteAId]);
  const assignmentId = assignment.rows[0].id;

  const battery = await client.query(`select id, battery_version_id, test_version_id from tests.test_battery_items limit 1`);
  const ba = await client.query(
    `insert into tests.test_battery_assessments (athlete_id, battery_version_id, assignment_id, status) values ($1,$2,$3,'draft') returning id`,
    [athleteAId, battery.rows[0].battery_version_id, assignmentId],
  );

  // Inheriting the SAME assignment is accepted.
  await assert.doesNotReject(() =>
    client.query(
      `insert into tests.test_assessments (athlete_id, test_version_id, assignment_id, battery_assessment_id, battery_version_id, battery_item_id, attempt_number, source, status)
       values ($1,$2,$3,$4,$5,$6,1,'coach_manual','draft')`,
      [athleteAId, battery.rows[0].test_version_id, assignmentId, ba.rows[0].id, battery.rows[0].battery_version_id, battery.rows[0].id],
    ),
  );

  // A DIFFERENT (unrelated) assignment is rejected, even if that assignment
  // itself would otherwise be individually valid for a standalone test.
  const otherSchedule = await makeDailyWellnessSchedule({ startDate: futureDate(16) });
  await client.query(`update tests.test_schedules set test_version_id=null, test_battery_version_id=$2 where id=$1`, [otherSchedule, battery.rows[0].battery_version_id]);
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id) values ($1,'athlete',$2)`, [otherSchedule, athleteAId]);
  const otherOccId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [otherSchedule, futureDate(16)])).rows[0].id;
  await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [otherOccId]);
  const otherAssignment = await client.query(`select id from tests.test_assignments where occurrence_id=$1 and athlete_id=$2`, [otherOccId, athleteAId]);

  await assert.rejects(() =>
    client.query(
      `insert into tests.test_assessments (athlete_id, test_version_id, assignment_id, battery_assessment_id, battery_version_id, battery_item_id, attempt_number, source, status)
       values ($1,$2,$3,$4,$5,$6,1,'coach_manual','draft')`,
      [athleteAId, battery.rows[0].test_version_id, otherAssignment.rows[0].id, ba.rows[0].id, battery.rows[0].battery_version_id, battery.rows[0].id],
    ),
  );
});

test("point 3 (positive). a standalone test assessment using an assignment whose occurrence snapshot IS this test_version is accepted", async () => {
  const scheduleId = await makeDailyWellnessSchedule({ startDate: futureDate(17) });
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id) values ($1,'athlete',$2)`, [scheduleId, athleteAId]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(17)])).rows[0].id;
  await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occId]);
  const assignment = await client.query(`select id from tests.test_assignments where occurrence_id=$1 and athlete_id=$2`, [occId, athleteAId]);

  await assert.doesNotReject(() =>
    client.query(
      `insert into tests.test_assessments (athlete_id, test_version_id, assignment_id, attempt_number, source, status)
       values ($1,$2,$3,1,'athlete_self','draft')`,
      [athleteAId, WELLNESS_TEST_VERSION_ID, assignment.rows[0].id],
    ),
  );
});

test("point 3 (negative). a test assessment cannot use an assignment that belongs to a BATTERY occurrence (wrong kind of snapshot)", async () => {
  const scheduleId = await makeDailyWellnessSchedule({ startDate: futureDate(18) });
  const batteryVersion = await client.query(`select id from tests.test_battery_versions limit 1`);
  await client.query(`update tests.test_schedules set test_version_id=null, test_battery_version_id=$2 where id=$1`, [scheduleId, batteryVersion.rows[0].id]);
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id) values ($1,'athlete',$2)`, [scheduleId, athleteAId]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(18)])).rows[0].id;
  await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occId]);
  const assignment = await client.query(`select id from tests.test_assignments where occurrence_id=$1 and athlete_id=$2`, [occId, athleteAId]);

  await assert.rejects(() =>
    client.query(
      `insert into tests.test_assessments (athlete_id, test_version_id, assignment_id, attempt_number, source, status)
       values ($1,$2,$3,1,'athlete_self','draft')`,
      [athleteAId, WELLNESS_TEST_VERSION_ID, assignment.rows[0].id],
    ),
  );
});

test("point 3 (negative, battery side). a battery assessment cannot use an assignment that belongs to a TEST occurrence", async () => {
  const scheduleId = await makeDailyWellnessSchedule({ startDate: futureDate(19) }); // test_version_id schedule, not battery
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id) values ($1,'athlete',$2)`, [scheduleId, athleteAId]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(19)])).rows[0].id;
  await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occId]);
  const assignment = await client.query(`select id from tests.test_assignments where occurrence_id=$1 and athlete_id=$2`, [occId, athleteAId]);
  const batteryVersion = await client.query(`select id from tests.test_battery_versions limit 1`);

  await assert.rejects(() =>
    client.query(
      `insert into tests.test_battery_assessments (athlete_id, battery_version_id, assignment_id, status) values ($1,$2,$3,'draft')`,
      [athleteAId, batteryVersion.rows[0].id, assignment.rows[0].id],
    ),
  );
});

test("H1. a test_assessment_values row referencing a parameter from a DIFFERENT test_version is rejected", async () => {
  const assessmentId = await makeStandaloneWellnessAssessment(athleteAId);
  const foreignParam = await client.query(`select id, test_version_id from tests.test_parameters where test_version_id <> $1 limit 1`, [WELLNESS_TEST_VERSION_ID]);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_assessment_values (assessment_id, test_version_id, test_parameter_id, value_numeric) values ($1,$2,$3,5)`,
      [assessmentId, WELLNESS_TEST_VERSION_ID, foreignParam.rows[0].id],
    ),
  );
});

test("I1. the wrong value column for a parameter's value_type is rejected (text for a numeric parameter)", async () => {
  const assessmentId = await makeStandaloneWellnessAssessment(athleteAId);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_assessment_values (assessment_id, test_version_id, test_parameter_id, value_text) values ($1,$2,$3,'high')`,
      [assessmentId, WELLNESS_TEST_VERSION_ID, WELLNESS_PARAM.fatigue],
    ),
  );
});

test("I2. a value outside [minimum_value, maximum_value] is rejected", async () => {
  const assessmentId = await makeStandaloneWellnessAssessment(athleteAId);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_assessment_values (assessment_id, test_version_id, test_parameter_id, value_numeric) values ($1,$2,$3,15)`, // fatigue is 0-10
      [assessmentId, WELLNESS_TEST_VERSION_ID, WELLNESS_PARAM.fatigue],
    ),
  );
});

async function submitFullWellness(athleteId, values) {
  const assessmentId = await makeStandaloneWellnessAssessment(athleteId);
  for (const [key, value] of Object.entries(values)) {
    if (key === "injury") {
      await client.query(
        `insert into tests.test_assessment_values (assessment_id, test_version_id, test_parameter_id, value_boolean) values ($1,$2,$3,$4)`,
        [assessmentId, WELLNESS_TEST_VERSION_ID, WELLNESS_PARAM.injury, value],
      );
    } else {
      await client.query(
        `insert into tests.test_assessment_values (assessment_id, test_version_id, test_parameter_id, value_numeric) values ($1,$2,$3,$4)`,
        [assessmentId, WELLNESS_TEST_VERSION_ID, WELLNESS_PARAM[key], value],
      );
    }
  }
  return assessmentId;
}

test("J1. WELLNESS Total is the average of exactly fatigue/sleep/soreness/stress/mood - injury and RPE never affect it - computed by the REAL backend service, not hand-computed in the test", async () => {
  // Confirm structurally first: derived parameter's own declared inputs are
  // exactly those 5 native parameters, RPE isn't even a WELLNESS parameter.
  const inputs = await client.query(
    `select tp.parameter_key from tests.test_version_derived_parameter_inputs i join tests.test_parameters tp on tp.id = i.source_test_parameter_id where i.derived_parameter_id = $1 order by tp.parameter_key`,
    [WELLNESS_TOTAL_DERIVED_ID],
  );
  assert.deepEqual(inputs.rows.map((r) => r.parameter_key), ["fatigue", "mood", "sleep", "soreness", "stress"]);
  const rpe = await client.query(`select 1 from tests.test_parameters where test_version_id=$1 and parameter_key='rpe'`, [WELLNESS_TEST_VERSION_ID]);
  assert.equal(rpe.rowCount, 0, "RPE must not exist as a WELLNESS parameter in this phase");

  // Point 8: computeAndStoreTestAssessmentDerivedResults() (backend/src/
  // testAssessmentCalculations.js) is the ONLY thing that writes this
  // result - it reads the real stored values and the real derived-parameter
  // definition, never a caller-supplied total. Run it in the SAME
  // transaction that completes the assessment, matching the required
  // integration pattern.
  const values = { fatigue: 2, sleep: 4, soreness: 6, stress: 8, mood: 10, injury: false };
  const assessmentId = await submitFullWellness(athleteAId, values);

  await client.query("begin");
  try {
    await client.query(`update tests.test_assessments set status='completed', completed_at=now() where id=$1`, [assessmentId]);
    const results = await computeAndStoreTestAssessmentDerivedResults(client, assessmentId);
    await client.query("commit");
    assert.equal(results.length, 1);
    assert.equal(results[0].parameterKey, "wellness_total");
    assert.equal(results[0].value, 6);
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  const stored = await client.query(`select result_numeric from tests.test_assessment_derived_results where assessment_id=$1 and test_version_derived_parameter_id=$2`, [assessmentId, WELLNESS_TOTAL_DERIVED_ID]);
  assert.equal(Number(stored.rows[0].result_numeric), 6);
});

test("J2. the calculation service rejects an unsupported calculation_method explicitly, rather than silently accepting a manual value", async () => {
  const test1 = await client.query(`insert into tests.test (owner_scope) values ('system') returning id`);
  const version1 = await client.query(`insert into tests.test_versions (test_id, version_number, status, name) values ($1,1,'draft','QA sum test') returning id`, [test1.rows[0].id]);
  const param = await client.query(`insert into tests.test_parameters (test_version_id, parameter_key, parameter, value_type) values ($1,'a','A','numeric') returning id`, [version1.rows[0].id]);
  const derived = await client.query(
    `insert into tests.test_version_derived_parameters (test_version_id, parameter_key, name, calculation_method, result_type, missing_input_behavior) values ($1,'total','Total','sum','numeric','error') returning id`,
    [version1.rows[0].id],
  );
  await client.query(
    `insert into tests.test_version_derived_parameter_inputs (test_version_id, derived_parameter_id, input_source_kind, source_test_parameter_id, role) values ($1,$2,'native',$3,'a')`,
    [version1.rows[0].id, derived.rows[0].id, param.rows[0].id],
  );
  await client.query(`update tests.test_versions set status='active', published_at=now() where id=$1`, [version1.rows[0].id]);

  const assessment = await client.query(`insert into tests.test_assessments (athlete_id, test_version_id, attempt_number, source, status) values ($1,$2,1,'coach_manual','draft') returning id`, [athleteAId, version1.rows[0].id]);
  await client.query(`insert into tests.test_assessment_values (assessment_id, test_version_id, test_parameter_id, value_numeric) values ($1,$2,$3,5)`, [assessment.rows[0].id, version1.rows[0].id, param.rows[0].id]);

  await assert.rejects(
    () => computeAndStoreTestAssessmentDerivedResults(client, assessment.rows[0].id),
    /not supported/i,
    "calculation_method 'sum' must be explicitly rejected, not silently skipped or replaced by a client value",
  );
  const noResult = await client.query(`select 1 from tests.test_assessment_derived_results where assessment_id=$1`, [assessment.rows[0].id]);
  assert.equal(noResult.rowCount, 0, "a rejected calculation must never leave a partial/wrong result row behind");
});

test("J3. the derived-result trigger rejects a numeric result written into the wrong (boolean) typed column", async () => {
  const assessmentId = await makeStandaloneWellnessAssessment(athleteAId);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_assessment_derived_results (assessment_id, test_version_id, test_version_derived_parameter_id, result_boolean, definition_version)
       values ($1,$2,$3,true,1)`,
      [assessmentId, WELLNESS_TEST_VERSION_ID, WELLNESS_TOTAL_DERIVED_ID],
    ),
  );
});

test("J4. the derived-result trigger rejects a definition_version that doesn't match the derived parameter's current definition_version", async () => {
  const assessmentId = await makeStandaloneWellnessAssessment(athleteAId);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_assessment_derived_results (assessment_id, test_version_id, test_version_derived_parameter_id, result_numeric, definition_version)
       values ($1,$2,$3,6,99)`,
      [assessmentId, WELLNESS_TEST_VERSION_ID, WELLNESS_TOTAL_DERIVED_ID],
    ),
  );
});

test("J5. NaN and Infinity are rejected for a derived result's numeric column", async () => {
  const assessmentId = await makeStandaloneWellnessAssessment(athleteAId);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_assessment_derived_results (assessment_id, test_version_id, test_version_derived_parameter_id, result_numeric, definition_version)
       values ($1,$2,$3,'NaN'::numeric,1)`,
      [assessmentId, WELLNESS_TEST_VERSION_ID, WELLNESS_TOTAL_DERIVED_ID],
    ),
  );
});

test("J6. NaN is rejected for a plain assessment value's numeric column too", async () => {
  const assessmentId = await makeStandaloneWellnessAssessment(athleteAId);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_assessment_values (assessment_id, test_version_id, test_parameter_id, value_numeric) values ($1,$2,$3,'NaN'::numeric)`,
      [assessmentId, WELLNESS_TEST_VERSION_ID, WELLNESS_PARAM.fatigue],
    ),
  );
});

test("K1. a derived result referencing a derived-parameter id from a DIFFERENT test_version is rejected (forged result)", async () => {
  const assessmentId = await makeStandaloneWellnessAssessment(athleteAId);
  const foreignDerived = await client.query(`select id from tests.test_version_derived_parameters where test_version_id <> $1 limit 1`, [WELLNESS_TEST_VERSION_ID]);
  if (!foreignDerived.rowCount) return; // no other derived parameter exists in this seed to forge against
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_assessment_derived_results (assessment_id, test_version_id, test_version_derived_parameter_id, result_numeric, definition_version)
       values ($1,$2,$3,5,1)`,
      [assessmentId, WELLNESS_TEST_VERSION_ID, foreignDerived.rows[0].id],
    ),
  );
});

test("L1. a concurrent double-submit with the same idempotency_key never creates two assessments", async () => {
  const key = `qa-idem-${crypto.randomUUID()}`;
  const insertOnce = () =>
    client.query(
      `insert into tests.test_assessments (athlete_id, test_version_id, attempt_number, source, status, idempotency_key) values ($1,$2,1,'athlete_self','draft',$3)`,
      [athleteAId, WELLNESS_TEST_VERSION_ID, key],
    );
  await insertOnce();
  await assert.rejects(insertOnce, "a second insert with the same idempotency_key must be rejected");
});

test("M1. a completed assessment's values become immutable", async () => {
  const assessmentId = await submitFullWellness(athleteBId, { fatigue: 5, sleep: 5, soreness: 5, stress: 5, mood: 5, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now() where id=$1`, [assessmentId]);
  await assert.rejects(() =>
    client.query(`update tests.test_assessment_values set value_numeric=9 where assessment_id=$1 and test_parameter_id=$2`, [assessmentId, WELLNESS_PARAM.fatigue]),
  );
});

test("M2. a completed assessment cannot be silently mutated (e.g. re-pointed to a different athlete)", async () => {
  const assessmentId = await submitFullWellness(athleteBId, { fatigue: 3, sleep: 3, soreness: 3, stress: 3, mood: 3, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now() where id=$1`, [assessmentId]);
  await assert.rejects(() => client.query(`update tests.test_assessments set athlete_id=$1 where id=$2`, [athleteCId, assessmentId]));
});

test("M3. a completed assessment cannot be physically deleted", async () => {
  const assessmentId = await submitFullWellness(athleteBId, { fatigue: 1, sleep: 1, soreness: 1, stress: 1, mood: 1, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now() where id=$1`, [assessmentId]);
  await assert.rejects(() => client.query(`delete from tests.test_assessments where id=$1`, [assessmentId]));
});

test("M4. a draft assessment CAN be deleted", async () => {
  const assessmentId = await makeStandaloneWellnessAssessment(athleteAId);
  await assert.doesNotReject(() => client.query(`delete from tests.test_assessments where id=$1`, [assessmentId]));
});

test("M5. the correct correction path (completed -> invalidated + superseded_by a new assessment) is allowed and auditable", async () => {
  const originalId = await submitFullWellness(athleteCId, { fatigue: 5, sleep: 5, soreness: 5, stress: 5, mood: 5, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now() where id=$1`, [originalId]);

  const correctedId = await submitFullWellness(athleteCId, { fatigue: 4, sleep: 4, soreness: 4, stress: 4, mood: 4, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now(), supersedes_assessment_id=$1 where id=$2`, [originalId, correctedId]);

  await client.query(`update tests.test_assessments set status='invalidated', superseded_by_assessment_id=$1 where id=$2`, [correctedId, originalId]);

  const row = await client.query(`select status, superseded_by_assessment_id from tests.test_assessments where id=$1`, [originalId]);
  assert.equal(row.rows[0].status, "invalidated");
  assert.equal(row.rows[0].superseded_by_assessment_id, correctedId);
  const correctedRow = await client.query(`select supersedes_assessment_id from tests.test_assessments where id=$1`, [correctedId]);
  assert.equal(correctedRow.rows[0].supersedes_assessment_id, originalId);
});

test("M5b. invalidated is fully immutable - even a no-op re-write of the same values is rejected", async () => {
  const originalId = await submitFullWellness(athleteCId, { fatigue: 5, sleep: 5, soreness: 5, stress: 5, mood: 5, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now() where id=$1`, [originalId]);
  const correctedId = await submitFullWellness(athleteCId, { fatigue: 4, sleep: 4, soreness: 4, stress: 4, mood: 4, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now(), supersedes_assessment_id=$1 where id=$2`, [originalId, correctedId]);
  await client.query(`update tests.test_assessments set status='invalidated', superseded_by_assessment_id=$1 where id=$2`, [correctedId, originalId]);

  await assert.rejects(() => client.query(`update tests.test_assessments set status='invalidated' where id=$1`, [originalId]), "re-applying the exact same status is still a mutation of an invalidated row");
  await assert.rejects(() => client.query(`update tests.test_assessments set idempotency_key = 'anything' where id=$1`, [originalId]));
});

test("M6. completed -> invalidated is rejected if ANY other column (source, assignment, attempt_number, ...) also changes in the same statement", async () => {
  const originalId = await submitFullWellness(athleteCId, { fatigue: 5, sleep: 5, soreness: 5, stress: 5, mood: 5, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now() where id=$1`, [originalId]);

  const correctedId = await submitFullWellness(athleteCId, { fatigue: 4, sleep: 4, soreness: 4, stress: 4, mood: 4, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now(), supersedes_assessment_id=$1 where id=$2`, [originalId, correctedId]);

  // source changes alongside the transition - must be rejected as a whole.
  await assert.rejects(() =>
    client.query(`update tests.test_assessments set status='invalidated', superseded_by_assessment_id=$1, source='device_import' where id=$2`, [correctedId, originalId]),
  );
  // attempt_number changing alongside the transition - also rejected.
  await assert.rejects(() =>
    client.query(`update tests.test_assessments set status='invalidated', superseded_by_assessment_id=$1, attempt_number=99 where id=$2`, [correctedId, originalId]),
  );
  // The original must still be untouched (completed, not invalidated) after both rejected attempts.
  const row = await client.query(`select status from tests.test_assessments where id=$1`, [originalId]);
  assert.equal(row.rows[0].status, "completed");
});

test("M7. a successor cannot supersede an original whose identity (athlete/test_version/attempt) doesn't match its own", async () => {
  const originalId = await submitFullWellness(athleteBId, { fatigue: 5, sleep: 5, soreness: 5, stress: 5, mood: 5, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now() where id=$1`, [originalId]);

  // A "corrected" row for a DIFFERENT athlete (athleteC, not athleteB) trying to supersede athleteB's original.
  const mismatchedId = await submitFullWellness(athleteCId, { fatigue: 4, sleep: 4, soreness: 4, stress: 4, mood: 4, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now(), supersedes_assessment_id=$1 where id=$2`, [originalId, mismatchedId]);

  await assert.rejects(() =>
    client.query(`update tests.test_assessments set status='invalidated', superseded_by_assessment_id=$1 where id=$2`, [mismatchedId, originalId]),
  );
});

test("M8. two DIFFERENT successor assessments cannot both claim to supersede the SAME original (at most one successor per original)", async () => {
  const originalId = await submitFullWellness(athleteBId, { fatigue: 5, sleep: 5, soreness: 5, stress: 5, mood: 5, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now() where id=$1`, [originalId]);

  const successor1 = await submitFullWellness(athleteBId, { fatigue: 4, sleep: 4, soreness: 4, stress: 4, mood: 4, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now(), supersedes_assessment_id=$1 where id=$2`, [originalId, successor1]);

  const successor2 = await submitFullWellness(athleteBId, { fatigue: 3, sleep: 3, soreness: 3, stress: 3, mood: 3, injury: false });
  // The unique(supersedes_assessment_id) constraint must reject this at
  // INSERT/UPDATE time - two rows can never both point at the same original.
  await assert.rejects(() =>
    client.query(`update tests.test_assessments set status='completed', completed_at=now(), supersedes_assessment_id=$1 where id=$2`, [originalId, successor2]),
  );
});

test("M9. once superseded_by_assessment_id is set on the original, it cannot ALSO be superseded again by a second successor (unique(superseded_by_assessment_id) is per-successor, but the original itself is now invalidated+immutable, blocking any further link change)", async () => {
  const originalId = await submitFullWellness(athleteBId, { fatigue: 5, sleep: 5, soreness: 5, stress: 5, mood: 5, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now() where id=$1`, [originalId]);
  const successor1 = await submitFullWellness(athleteBId, { fatigue: 4, sleep: 4, soreness: 4, stress: 4, mood: 4, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now(), supersedes_assessment_id=$1 where id=$2`, [originalId, successor1]);
  await client.query(`update tests.test_assessments set status='invalidated', superseded_by_assessment_id=$1 where id=$2`, [successor1, originalId]);

  const successor2 = await submitFullWellness(athleteBId, { fatigue: 3, sleep: 3, soreness: 3, stress: 3, mood: 3, injury: false });
  await client.query(`update tests.test_assessments set status='completed', completed_at=now(), supersedes_assessment_id=$1 where id=$2`, [originalId, successor2]).catch(() => {});
  await assert.rejects(() =>
    client.query(`update tests.test_assessments set status='invalidated', superseded_by_assessment_id=$1 where id=$2`, [successor2, originalId]),
    "the original is already invalidated - fully immutable, cannot be re-linked to a second successor",
  );
});

// ==================================================================
// N-O. Access links
// ==================================================================

async function makeGroupScheduleLink(scheduleId) {
  const r = await client.query(
    `insert into tests.test_access_links (link_kind, schedule_id, auth_mode, public_token, status, created_by_user_id)
     values ('schedule', $1, 'authenticated_group', $2, 'active', $3) returning id, public_token`,
    [scheduleId, crypto.randomBytes(16).toString("hex"), coachUserId],
  );
  return r.rows[0];
}

test("N1. a revoked link is stored with revoked_at/revoked_by and status='revoked' consistently", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const link = await makeGroupScheduleLink(scheduleId);
  await client.query(`update tests.test_access_links set status='revoked', revoked_at=now(), revoked_by_user_id=$1 where id=$2`, [coachUserId, link.id]);
  const row = await client.query(`select status, revoked_at, revoked_by_user_id from tests.test_access_links where id=$1`, [link.id]);
  assert.equal(row.rows[0].status, "revoked");
  assert.ok(row.rows[0].revoked_at);
  assert.equal(row.rows[0].revoked_by_user_id, coachUserId);
});

test("N2. marking a link revoked WITHOUT revoked_at/revoked_by is rejected (status/timestamp consistency)", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const link = await makeGroupScheduleLink(scheduleId);
  await assert.rejects(() => client.query(`update tests.test_access_links set status='revoked' where id=$1`, [link.id]));
});

test("N3. an expired-but-still-active-status link is correctly excluded by the standard usability query (status='active' and (expires_at is null or expires_at > now()))", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const link = await makeGroupScheduleLink(scheduleId);
  await client.query(`update tests.test_access_links set expires_at = now() - interval '1 hour' where id=$1`, [link.id]);
  const usable = await client.query(
    `select 1 from tests.test_access_links where id=$1 and status='active' and (expires_at is null or expires_at > now())`,
    [link.id],
  );
  assert.equal(usable.rowCount, 0, "an expired link must be excluded by the standard access-check query even though its status column is still 'active'");
});

test("N4. rotating a link (revoke old, create new pointing back via rotated_from_link_id) preserves lineage", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const oldLink = await makeGroupScheduleLink(scheduleId);
  await client.query(`update tests.test_access_links set status='revoked', revoked_at=now(), revoked_by_user_id=$1 where id=$2`, [coachUserId, oldLink.id]);
  const newLink = await client.query(
    `insert into tests.test_access_links (link_kind, schedule_id, auth_mode, public_token, status, created_by_user_id, rotated_from_link_id)
     values ('schedule', $1, 'authenticated_group', $2, 'active', $3, $4) returning id`,
    [scheduleId, crypto.randomBytes(16).toString("hex"), coachUserId, oldLink.id],
  );
  const row = await client.query(`select rotated_from_link_id from tests.test_access_links where id=$1`, [newLink.rows[0].id]);
  assert.equal(row.rows[0].rotated_from_link_id, oldLink.id);
});

test("N5. only one ACTIVE link may exist per schedule at a time (old must be revoked before a new one can be 'active')", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await makeGroupScheduleLink(scheduleId);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_access_links (link_kind, schedule_id, auth_mode, public_token, status, created_by_user_id) values ('schedule',$1,'authenticated_group',$2,'active',$3)`,
      [scheduleId, crypto.randomBytes(16).toString("hex"), coachUserId],
    ),
  );
});

async function makeRealAssignment(dateOffset) {
  const scheduleId = await makeDailyWellnessSchedule({ startDate: futureDate(dateOffset) });
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id) values ($1,'athlete',$2)`, [scheduleId, athleteAId]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(dateOffset)])).rows[0].id;
  await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occId]);
  const assignment = await client.query(`select id from tests.test_assignments where occurrence_id=$1 and athlete_id=$2`, [occId, athleteAId]);
  return assignment.rows[0].id;
}

test("N6. an authenticated_group link may NOT carry a magic_token_hash", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_access_links (link_kind, schedule_id, auth_mode, public_token, magic_token_hash, status, created_by_user_id)
       values ('schedule',$1,'authenticated_group',$2,'somehash','active',$3)`,
      [scheduleId, crypto.randomBytes(16).toString("hex"), coachUserId],
    ),
  );
});

test("N6b. a personal_magic link WITHOUT a magic_token_hash is rejected (iff, not just a one-way rule)", async () => {
  const assignmentId = await makeRealAssignment(30);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_access_links (link_kind, assignment_id, auth_mode, public_token, status, created_by_user_id)
       values ('assignment',$1,'personal_magic',$2,'active',$3)`,
      [assignmentId, crypto.randomBytes(16).toString("hex"), coachUserId],
    ),
  );
});

test("N6c. a personal_magic link WITH a magic_token_hash on an assignment link is accepted", async () => {
  const assignmentId = await makeRealAssignment(31);
  const r = await client.query(
    `insert into tests.test_access_links (link_kind, assignment_id, auth_mode, public_token, magic_token_hash, status, created_by_user_id)
     values ('assignment',$1,'personal_magic',$2,'somehash','active',$3) returning id`,
    [assignmentId, crypto.randomBytes(16).toString("hex"), coachUserId],
  );
  assert.ok(r.rows[0].id);
});

test("N6d. personal_magic is rejected on a schedule/occurrence link - reserved for assignment links only", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_access_links (link_kind, schedule_id, auth_mode, public_token, magic_token_hash, status, created_by_user_id)
       values ('schedule',$1,'personal_magic',$2,'somehash','active',$3)`,
      [scheduleId, crypto.randomBytes(16).toString("hex"), coachUserId],
    ),
  );
});

test("N7. a link cannot be rotated from itself (self-reference guard)", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const link = await makeGroupScheduleLink(scheduleId);
  await assert.rejects(() => client.query(`update tests.test_access_links set rotated_from_link_id = id where id=$1`, [link.id]));
});

test("O1. after 'login', the group-link query pattern finds ONLY the logged-in athlete's own assignment on that occurrence - never another athlete's", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2)`, [scheduleId, teamId]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(8)])).rows[0].id;
  await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occId]);

  // Simulates: coach shares ONE group link for the schedule; athlete A logs
  // in; backend resolves ONLY athlete A's assignment for the schedule's
  // currently-open occurrence - never the roster, never athlete B's row.
  const myAssignment = await client.query(
    `select a.id, a.athlete_id from tests.test_assignments a
     join tests.test_schedule_occurrences o on o.id = a.occurrence_id
     where o.schedule_id = $1 and a.athlete_id = $2`,
    [scheduleId, athleteAId],
  );
  assert.equal(myAssignment.rowCount, 1);
  assert.equal(myAssignment.rows[0].athlete_id, athleteAId);
  assert.notEqual(myAssignment.rows[0].athlete_id, athleteBId);
});

test("O2. the same query for a DIFFERENT logged-in athlete on the same occurrence returns only THEIR row, proving no cross-athlete leakage through the shared link/schedule", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2)`, [scheduleId, teamId]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(9)])).rows[0].id;
  await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occId]);

  const forB = await client.query(
    `select athlete_id from tests.test_assignments a join tests.test_schedule_occurrences o on o.id=a.occurrence_id where o.schedule_id=$1 and a.athlete_id=$2`,
    [scheduleId, athleteBId],
  );
  assert.equal(forB.rowCount, 1);
  assert.equal(forB.rows[0].athlete_id, athleteBId);
});

// ==================================================================
// P. Notification rules and dedupe/aggregation
// ==================================================================

test("P1. an athlete_reminder rule without reminder_offset_minutes is rejected", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await assert.rejects(() =>
    client.query(`insert into tests.test_schedule_notification_rules (schedule_id, notification_kind, enabled) values ($1,'athlete_reminder',true)`, [scheduleId]),
  );
});

test("P2. a coach_digest rule without digest_trigger is rejected", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await assert.rejects(() =>
    client.query(`insert into tests.test_schedule_notification_rules (schedule_id, notification_kind, enabled) values ($1,'coach_digest',true)`, [scheduleId]),
  );
});

test("P3. a valid full set of notification rules for a schedule is accepted, one row per kind", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`insert into tests.test_schedule_notification_rules (schedule_id, notification_kind) values ($1,'athlete_invitation')`, [scheduleId]);
  await client.query(`insert into tests.test_schedule_notification_rules (schedule_id, notification_kind, reminder_offset_minutes) values ($1,'athlete_reminder',60)`, [scheduleId]);
  await client.query(`insert into tests.test_schedule_notification_rules (schedule_id, notification_kind, digest_trigger) values ($1,'coach_digest','periodic')`, [scheduleId]);
  await client.query(`insert into tests.test_schedule_notification_rules (schedule_id, notification_kind, digest_trigger) values ($1,'final_digest','on_close')`, [scheduleId]);
  const count = await client.query(`select count(*) c from tests.test_schedule_notification_rules where schedule_id=$1`, [scheduleId]);
  assert.equal(count.rows[0].c, "4");
});

test("P4. a duplicate notification rule (same schedule + kind) is rejected", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`insert into tests.test_schedule_notification_rules (schedule_id, notification_kind) values ($1,'athlete_invitation')`, [scheduleId]);
  await assert.rejects(() => client.query(`insert into tests.test_schedule_notification_rules (schedule_id, notification_kind) values ($1,'athlete_invitation')`, [scheduleId]));
});

test("P5. re-upserting a coach_digest dispatch by dedupe_key updates counts in place - one row per coach per occurrence, never one per athlete", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await client.query(`insert into tests.test_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2)`, [scheduleId, teamId]);
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(10)])).rows[0].id;
  await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occId]);
  const dedupeKey = `coach_digest:${occId}:${coachUserId}`;

  const upsert = (completed, total) =>
    client.query(
      `insert into tests.test_schedule_notification_dispatches (occurrence_id, notification_kind, recipient_user_id, dedupe_key, completed_count, total_count, last_computed_at)
       values ($1,'coach_digest',$2,$3,$4,$5,now())
       on conflict (dedupe_key) do update set completed_count=excluded.completed_count, total_count=excluded.total_count, last_computed_at=excluded.last_computed_at, updated_at=now()
       returning id`,
      [occId, coachUserId, dedupeKey, completed, total],
    );

  const first = await upsert(0, 2);
  await client.query(`update tests.test_assignments set status='completed', completed_at=now() where occurrence_id=$1 and athlete_id=$2`, [occId, athleteAId]);
  const second = await upsert(1, 2);

  assert.equal(first.rows[0].id, second.rows[0].id, "the SAME dispatch row must be updated, not a new one inserted, when the same coach/occurrence combination recomputes");
  const count = await client.query(`select count(*) c from tests.test_schedule_notification_dispatches where dedupe_key=$1`, [dedupeKey]);
  assert.equal(count.rows[0].c, "1");
  const row = await client.query(`select completed_count, total_count from tests.test_schedule_notification_dispatches where dedupe_key=$1`, [dedupeKey]);
  assert.equal(row.rows[0].completed_count, 1);
  assert.equal(row.rows[0].total_count, 2);
});

test("P6. an athlete_reminder dispatch must carry an assignment_id; a coach_digest dispatch must NOT", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(11)])).rows[0].id;
  const assignment = await client.query(`insert into tests.test_assignments (occurrence_id, athlete_id) values ($1,$2) returning id`, [occId, athleteAId]);
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedule_notification_dispatches (occurrence_id, notification_kind, recipient_user_id, dedupe_key) values ($1,'athlete_reminder',$2,$3)`,
      [occId, coachUserId, `athlete_reminder:${crypto.randomUUID()}`],
    ),
  );
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedule_notification_dispatches (occurrence_id, assignment_id, notification_kind, recipient_user_id, dedupe_key) values ($1,$2,'coach_digest',$3,$4)`,
      [occId, assignment.rows[0].id, coachUserId, `coach_digest:${crypto.randomUUID()}`],
    ),
  );
});

test("P7. recipient_user_id is required on every dispatch", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(20)])).rows[0].id;
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedule_notification_dispatches (occurrence_id, notification_kind, dedupe_key) values ($1,'coach_digest',$2)`,
      [occId, `coach_digest:${crypto.randomUUID()}`],
    ),
  );
});

test("P8. an assignment from a DIFFERENT occurrence than the dispatch is rejected", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const occ1 = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(21)])).rows[0].id;
  const occ2 = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(22)])).rows[0].id;
  const assignmentOnOcc2 = await client.query(`insert into tests.test_assignments (occurrence_id, athlete_id) values ($1,$2) returning id`, [occ2, athleteAId]);

  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedule_notification_dispatches (occurrence_id, assignment_id, notification_kind, recipient_user_id, dedupe_key) values ($1,$2,'athlete_reminder',$3,$4)`,
      [occ1, assignmentOnOcc2.rows[0].id, coachUserId, `athlete_reminder:${crypto.randomUUID()}`],
    ),
  );
});

test("P9. completed_count/total_count must be non-negative, and completed_count must never exceed total_count", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  const occId = (await client.query(`select tests.generate_test_schedule_occurrence($1,$2) as id`, [scheduleId, futureDate(23)])).rows[0].id;
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedule_notification_dispatches (occurrence_id, notification_kind, recipient_user_id, dedupe_key, completed_count, total_count) values ($1,'coach_digest',$2,$3,-1,5)`,
      [occId, coachUserId, `coach_digest:${crypto.randomUUID()}`],
    ),
  );
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedule_notification_dispatches (occurrence_id, notification_kind, recipient_user_id, dedupe_key, completed_count, total_count) values ($1,'coach_digest',$2,$3,10,5)`,
      [occId, coachUserId, `coach_digest:${crypto.randomUUID()}`],
    ),
  );
});

test("P10. an athlete_reminder rule with a digest_trigger set is rejected (rules must not mix athlete and digest fields)", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedule_notification_rules (schedule_id, notification_kind, reminder_offset_minutes, digest_trigger) values ($1,'athlete_reminder',60,'on_close')`,
      [scheduleId],
    ),
  );
});

test("P11. a coach_digest rule with reminder_offset_minutes set is rejected", async () => {
  const scheduleId = await makeDailyWellnessSchedule();
  await assert.rejects(() =>
    client.query(
      `insert into tests.test_schedule_notification_rules (schedule_id, notification_kind, digest_trigger, reminder_offset_minutes) values ($1,'coach_digest','on_close',60)`,
      [scheduleId],
    ),
  );
});

// ==================================================================
// Q. FK index coverage
// ==================================================================

test("Q1. every FK column on the new tables has a supporting index", async () => {
  const rows = await client.query(`
    select
      tc.table_name, kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema = 'tests'
      and tc.table_name in (
        'test_schedules','test_schedule_targets','test_schedule_occurrences','test_assignments',
        'test_battery_assessments','test_assessments','test_assessment_values',
        'test_assessment_derived_results','test_battery_assessment_derived_results',
        'test_assessment_evaluations','test_access_links',
        'test_schedule_notification_rules','test_schedule_notification_dispatches'
      )
  `);
  const indexed = await client.query(`
    select tablename, indexdef from pg_indexes where schemaname='tests'
  `);
  const missing = [];
  for (const { table_name, column_name } of rows.rows) {
    const hasLeadingIndex = indexed.rows.some(
      (idx) => idx.tablename === table_name && new RegExp(`\\(${column_name}[,)]`).test(idx.indexdef.replace(/\s+/g, "")),
    );
    if (!hasLeadingIndex) missing.push(`${table_name}.${column_name}`);
  }
  assert.deepEqual(missing, [], `every FK column must have an index leading with that column: ${missing.join(", ")}`);
});

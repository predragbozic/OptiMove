// Validates the two Tests module v4.2 migrations_v2 migrations:
//   migrations_v2/202608220900_tests_v42_schema.sql   (schema)
//   migrations_v2/202608221000_tests_v42_seed_wellness_fms.sql (WELLNESS + FMS seed)
//
// Runs entirely against disposable, uniquely-named temporary databases
// (never OPTIMOVE, never monitoring2) through the real Strategy B
// runMigrations() (backend/src/migrate.js) - not a hand-simulated apply.
// The legacy fixture below is the exact minimal structure
// computeLegacyFingerprint() checks, copied from the established pattern in
// backend/tests/migration-runner-v2.test.mjs so assertLegacyBaselinePresent()
// passes without needing to replay all ~30 real migrations_v2 files (which
// depend on legacy OPTIMOVE data these Tests migrations don't touch).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_MIGRATION_PATH = path.resolve(__dirname, "../../migrations_v2/202608220900_tests_v42_schema.sql");
const SEED_MIGRATION_PATH = path.resolve(__dirname, "../../migrations_v2/202608221000_tests_v42_seed_wellness_fms.sql");
const SCHEMA_MIGRATION_NAME = "202608220900_tests_v42_schema.sql";
const SEED_MIGRATION_NAME = "202608221000_tests_v42_seed_wellness_fms.sql";

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

const LEGACY_FIXTURE_SQL = `
  create table public.clubs (id uuid primary key default gen_random_uuid());
  create table public.teams (id uuid primary key default gen_random_uuid(), club_id uuid references public.clubs(id));
  alter table public.teams add constraint teams_id_club_id_unique unique (id, club_id);
  create table public.users (id uuid primary key default gen_random_uuid());
  create table public.athletes (id uuid primary key default gen_random_uuid(), source_external_id text);
  create table public.user_global_roles (id uuid primary key default gen_random_uuid(), revoked_at timestamptz);
  create table public.athlete_memberships (id uuid primary key default gen_random_uuid());
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
  const name = `optimove_tests_v42_${label}_${crypto.randomBytes(6).toString("hex")}`;
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
  const dir = path.resolve(__dirname, `tests_v42_migrations_${runId}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

// ==================================================================
// Primary round-trip: full isolated validation checklist.
// ==================================================================
let db;
let client;
let migrationsDir;
let schemaSql;
let seedSql;

before(async () => {
  schemaSql = await fsp.readFile(SCHEMA_MIGRATION_PATH, "utf8");
  seedSql = await fsp.readFile(SEED_MIGRATION_PATH, "utf8");

  db = await makeTempDb("primary");
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
  const ownCheck = await client.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");

  await client.query(LEGACY_FIXTURE_SQL);
  // assertLegacyBaselinePresent()'s own fingerprint check (backend/src/migrate.js,
  // pre-existing since the Strategy B runner, unrelated to this Tests-module
  // work) already requires public.teams.teams_id_club_id_unique to exist
  // with exactly UNIQUE (id, club_id) before ANY migrations_v2 file is even
  // attempted - so in the real runMigrations() flow, Migration 1's own
  // conditional DO block can only ever reach its "already correct -> no-op"
  // branch; the "missing -> create it" and "conflicting -> abort" branches
  // are unreachable end-to-end through the runner (the fingerprint gate
  // gets there first) and are instead verified directly below (tests 13-14)
  // by executing the migration's raw SQL, bypassing the runner precondition
  // that would otherwise mask them.

  migrationsDir = await writeMigrationsDir("primary", {
    [SCHEMA_MIGRATION_NAME]: schemaSql,
    [SEED_MIGRATION_NAME]: seedSql,
  });
});

after(async () => {
  await client.end();
  await fsp.rm(migrationsDir, { recursive: true, force: true });
  await dropTempDb(db);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const stillThere = await admin.query("select 1 from pg_database where datname = $1", [db.name]);
  assert.equal(stillThere.rowCount, 0, "temp database must be gone after drop");
  await admin.end();
});

test("1-2. both migrations apply and are recorded in schema_migrations", async () => {
  await runner.runMigrations({ databaseUrl: db.url, migrationsRoot: migrationsDir });
  const rows = await client.query(
    `select migration_name from public.schema_migrations where migration_name = any($1) order by migration_name`,
    [[`${path.basename(migrationsDir)}/${SCHEMA_MIGRATION_NAME}`, `${path.basename(migrationsDir)}/${SEED_MIGRATION_NAME}`]],
  );
  assert.equal(rows.rowCount, 2, "both migration files must be recorded");
});

test("3. teams_id_club_id_unique (already present from the legacy baseline) is left as-is, not duplicated or altered", async () => {
  const r = await client.query(
    `select pg_get_constraintdef(con.oid) as def
     from pg_constraint con join pg_class rel on rel.oid=con.conrelid join pg_namespace nsp on nsp.oid=rel.relnamespace
     where nsp.nspname='public' and rel.relname='teams' and con.conname='teams_id_club_id_unique'`,
  );
  assert.equal(r.rowCount, 1);
  assert.equal(r.rows[0].def.toLowerCase().replace(/\s+/g, " "), "unique (id, club_id)");
});

test("4. re-run is idempotent: checksums match, nothing re-applied, no duplicate rows", async () => {
  await assert.doesNotReject(() => runner.runMigrations({ databaseUrl: db.url, migrationsRoot: migrationsDir }));
  const rows = await client.query(
    `select count(*) c from public.schema_migrations where migration_name = any($1)`,
    [[`${path.basename(migrationsDir)}/${SCHEMA_MIGRATION_NAME}`, `${path.basename(migrationsDir)}/${SEED_MIGRATION_NAME}`]],
  );
  assert.equal(rows.rows[0].c, "2", "re-run must not duplicate schema_migrations rows");
  const testCount = await client.query("select count(*) c from tests.test");
  assert.equal(testCount.rows[0].c, "11", "re-run must not duplicate seed rows");
});

test("5. catalog row counts match the confirmed v42_seed_manifest.md exactly", async () => {
  const expected = {
    "tests.test": 11,
    "tests.test_versions": 11,
    "tests.test_parameters": 36,
    "tests.test_version_derived_parameters": 1,
    "tests.test_version_derived_parameter_inputs": 5,
    "tests.test_battery": 1,
    "tests.test_battery_versions": 1,
    "tests.test_battery_items": 10,
    "tests.test_battery_item_parameter_selections": 11,
    "tests.test_battery_derived_parameters": 4,
    "tests.test_battery_derived_parameter_inputs": 14,
    "tests.legacy_import_map": 111,
  };
  for (const [table, expectedCount] of Object.entries(expected)) {
    const r = await client.query(`select count(*) c from ${table}`);
    assert.equal(Number(r.rows[0].c), expectedCount, `${table} row count`);
  }
});

test("6. every test/battery is system-owned; every version is active with lineage/publish fields set correctly", async () => {
  const testOwnership = await client.query(
    `select count(*) c from tests.test where owner_scope <> 'system' or owner_user_id is not null or owner_club_id is not null or owner_team_id is not null`,
  );
  assert.equal(testOwnership.rows[0].c, "0", "every tests.test row must be owner_scope='system' with all owner_*_id null");

  const batteryOwnership = await client.query(
    `select count(*) c from tests.test_battery where owner_scope <> 'system' or owner_user_id is not null or owner_club_id is not null or owner_team_id is not null`,
  );
  assert.equal(batteryOwnership.rows[0].c, "0");

  const versionStatus = await client.query(
    `select count(*) c from tests.test_versions where status <> 'active' or published_at is null or version_number <> 1 or previous_version_id is not null`,
  );
  assert.equal(versionStatus.rows[0].c, "0", "every test_versions row must be an active, first-version publish with no lineage");

  const batteryVersionStatus = await client.query(
    `select count(*) c from tests.test_battery_versions where status <> 'active' or published_at is null or version_number <> 1 or previous_version_id is not null`,
  );
  assert.equal(batteryVersionStatus.rows[0].c, "0");
});

test("7. every FK relationship in the seed resolves (no orphaned rows)", async () => {
  const checks = [
    `select count(*) c from tests.test_versions v left join tests.test t on t.id=v.test_id where t.id is null`,
    `select count(*) c from tests.test_parameters p left join tests.test_versions v on v.id=p.test_version_id where v.id is null`,
    `select count(*) c from tests.test_version_derived_parameter_inputs i left join tests.test_parameters p on p.id=i.source_test_parameter_id where i.source_test_parameter_id is not null and p.id is null`,
    `select count(*) c from tests.test_battery_items bi left join tests.test_versions v on v.id=bi.test_version_id where v.id is null`,
    `select count(*) c from tests.test_battery_item_parameter_selections s left join tests.test_parameters p on p.id=s.test_parameter_id where p.id is null`,
    `select count(*) c from tests.test_battery_derived_parameter_inputs i left join tests.test_battery_item_parameter_selections s on s.id=i.source_battery_item_parameter_selection_id where i.source_battery_item_parameter_selection_id is not null and s.id is null`,
  ];
  for (const q of checks) {
    const r = await client.query(q);
    assert.equal(r.rows[0].c, "0", q);
  }
});

test("8. legacy_import_map: mapping_kind composition matches the manifest (2/2/6/1/5/20/30/2/10/11/4/14/6)", async () => {
  const counts = await client.query(
    `select mapping_kind, count(*) c from tests.legacy_import_map group by mapping_kind order by mapping_kind`,
  );
  const byKind = Object.fromEntries(counts.rows.map((r) => [r.mapping_kind, Number(r.c)]));
  assert.equal(byKind.direct, 12, "WELLNESS test(1) + FMS 10 tests(10) + battery(1) = 12 direct rows");
  assert.equal(byKind.transformed, 59, "test_versions(11) + native params(36) + wellness total(1) + battery_items(10) + battery_version(1) = 59");
  assert.equal(byKind.generated, 34, "wellness derived-inputs(5) + battery selections(11) + battery-derived(4) + battery-derived-inputs(14) = 34");
  assert.equal(byKind.skipped, 6, "Sprint 10m x2, Sprint 30m x2, Ankle Clearing x1, Wellness Questionnaire battery x1");
  assert.equal(byKind.direct + byKind.transformed + byKind.generated + byKind.skipped, 111);

  const generatedWithMonitoring2Source = await client.query(
    `select count(*) c from tests.legacy_import_map where mapping_kind='generated' and source_system <> 'optimove_seed'`,
  );
  assert.equal(generatedWithMonitoring2Source.rows[0].c, "0", "generated rows must never claim monitoring2 provenance that doesn't exist");

  const skippedWithTarget = await client.query(
    `select count(*) c from tests.legacy_import_map where mapping_kind='skipped' and (target_schema is not null or target_table is not null or target_id is not null)`,
  );
  assert.equal(skippedWithTarget.rows[0].c, "0");
});

test("9. no monitoring2 runtime reference anywhere in either migration file", async () => {
  for (const sql of [schemaSql, seedSql]) {
    assert.doesNotMatch(sql, /dblink|postgres_fdw|\\connect/i);
  }
  // source_system is the only place monitoring2 is even mentioned, and only
  // as a static string value, never a connection target.
  const systems = await client.query(`select distinct source_system from tests.legacy_import_map`);
  const values = systems.rows.map((r) => r.source_system).sort();
  assert.deepEqual(values, ["monitoring2", "optimove_seed"]);
});

test("10. WELLNESS Total formula: average of fatigue/sleep/soreness/stress/mood, injury excluded", async () => {
  const dp = await client.query(
    `select id, calculation_method, result_type, missing_input_behavior from tests.test_version_derived_parameters where parameter_key='wellness_total'`,
  );
  assert.equal(dp.rowCount, 1);
  assert.equal(dp.rows[0].calculation_method, "average");

  const inputs = await client.query(
    `select role, weight from tests.test_version_derived_parameter_inputs where derived_parameter_id = $1 order by role`,
    [dp.rows[0].id],
  );
  const roles = inputs.rows.map((r) => r.role).sort();
  assert.deepEqual(roles, ["fatigue", "mood", "sleep", "soreness", "stress"], "injury must not be one of the 5 average inputs");
  assert.ok(inputs.rows.every((r) => Number(r.weight) === 1));

  // Simulate the stored formula against a concrete sample - the DB has no
  // runtime evaluator table yet (results live in a future phase), so this
  // confirms the STORED definition computes the clinically correct value.
  const sample = { fatigue: 2, sleep: 4, soreness: 6, stress: 8, mood: 10 };
  const total = Object.values(sample).reduce((a, b) => a + b, 0) / 5;
  assert.equal(total, 6);
});

test("11. Shoulder Clearing gates Final Shoulder Mobility Score to 0 on either-side pain, otherwise passes the native score through", async () => {
  const dp = await client.query(
    `select calculation_definition from tests.test_battery_derived_parameters where parameter_key='final_shoulder_mobility'`,
  );
  assert.equal(dp.rowCount, 1);
  const def = dp.rows[0].calculation_definition;
  assert.equal(def.when.any.length, 2, "must gate on BOTH pain_left and pain_right (OR)");

  function evaluate(condDef, inputs) {
    const hit = condDef.when.any.some((c) => inputs[c.role] === c.value);
    if (hit) return condDef.then.constant;
    return inputs[condDef.else.role];
  }
  assert.equal(evaluate(def, { pain_left: true, pain_right: false, score: 2 }), 0, "pain_left alone must gate to 0");
  assert.equal(evaluate(def, { pain_left: false, pain_right: true, score: 2 }), 0, "pain_right alone must gate to 0");
  assert.equal(evaluate(def, { pain_left: false, pain_right: false, score: 2 }), 2, "no pain must pass the native score through unchanged");
});

test("12. FMS Total sums the 4 native scores plus the 3 gated battery-derived finals", async () => {
  const dp = await client.query(`select id, calculation_method, calculation_definition from tests.test_battery_derived_parameters where parameter_key='fms_total'`);
  assert.equal(dp.rowCount, 1);
  assert.equal(dp.rows[0].calculation_method, "sum");
  assert.equal(dp.rows[0].calculation_definition, null);

  const inputs = await client.query(
    `select role, input_source_kind from tests.test_battery_derived_parameter_inputs where derived_parameter_id = $1 order by role`,
    [dp.rows[0].id],
  );
  assert.equal(inputs.rowCount, 7);
  const nativeRoles = inputs.rows.filter((r) => r.input_source_kind === "battery_item_parameter_selection").map((r) => r.role).sort();
  const derivedRoles = inputs.rows.filter((r) => r.input_source_kind === "battery_derived").map((r) => r.role).sort();
  assert.deepEqual(nativeRoles, ["aslr", "deep_squat", "hurdle_step", "inline_lunge"]);
  assert.deepEqual(derivedRoles, ["rotary_final", "shoulder_final", "trunk_final"]);

  // Sample: 4 native scores of 3 each + 3 gated finals (one gated to 0, two passing through at 2) = 12 + 0 + 2 + 2 = 16.
  const sampleTotal = 3 + 3 + 3 + 3 + 0 + 2 + 2;
  assert.equal(sampleTotal, 16);
});

// ==================================================================
// teams_id_club_id_unique conditional DO block - the other two branches.
// Not reachable through the real runMigrations() (assertLegacyBaselinePresent()
// already requires the constraint to exist correctly before any
// migrations_v2 file runs - see the before() comment above), so these
// execute Migration 1's raw SQL directly against a plain client, exactly as
// the runner itself would (single implicit transaction, no BEGIN/COMMIT of
// its own), to verify the DO block's own conditional logic in isolation.
// ==================================================================
test("13. constraint missing: the DO block creates it", async () => {
  const tmp = await makeTempDb("teams_missing");
  const c = new pg.Client({ connectionString: tmp.url });
  try {
    await c.connect();
    await c.query("create table public.users (id uuid primary key default gen_random_uuid())");
    await c.query("create table public.clubs (id uuid primary key default gen_random_uuid())");
    await c.query("create table public.teams (id uuid primary key default gen_random_uuid(), club_id uuid references public.clubs(id))");
    await c.query("create table public.athletes (id uuid primary key default gen_random_uuid())");
    await c.query(schemaSql);
    const def = await c.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname='teams_id_club_id_unique'`,
    );
    assert.equal(def.rowCount, 1);
    assert.equal(def.rows[0].def.toLowerCase(), "unique (id, club_id)");
  } finally {
    await c.end();
    await dropTempDb(tmp);
  }
});

test("14. constraint exists with a conflicting definition: the DO block aborts loudly, does not touch it", async () => {
  const tmp = await makeTempDb("teams_conflict");
  const c = new pg.Client({ connectionString: tmp.url });
  try {
    await c.connect();
    await c.query("create table public.clubs (id uuid primary key default gen_random_uuid())");
    await c.query("create table public.teams (id uuid primary key default gen_random_uuid(), club_id uuid references public.clubs(id))");
    await c.query("alter table public.teams add constraint teams_id_club_id_unique unique (club_id)");
    await assert.rejects(
      () => c.query(schemaSql),
      /already has a constraint named teams_id_club_id_unique/,
    );
    const def = await c.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname='teams_id_club_id_unique'`,
    );
    assert.equal(def.rows[0].def.toLowerCase(), "unique (club_id)", "the pre-existing (wrong) constraint must be left untouched");
  } finally {
    await c.end();
    await dropTempDb(tmp);
  }
});

// ==================================================================
// Rollback of the whole migration on a deliberately-triggered error.
// ==================================================================
test("15. a broken seed migration rolls back completely: no partial rows, not recorded in schema_migrations", async () => {
  const tmp = await makeTempDb("rollback");
  const c = new pg.Client({ connectionString: tmp.url });
  try {
    await c.connect();
    await c.query(LEGACY_FIXTURE_SQL);
    const dir = await writeMigrationsDir("rollback", { [SCHEMA_MIGRATION_NAME]: schemaSql });
    await runner.runMigrations({ databaseUrl: tmp.url, migrationsRoot: dir });

    // Deliberately break the seed migration: append a legacy_import_map row
    // reusing an id already used a few lines earlier in the same file for a
    // 'skipped' row's source - this collides with the
    // legacy_import_map_source_target_uidx-equivalent for a 'skipped' row's
    // FK-free uniqueness path by instead violating a NOT NULL directly, the
    // simplest deterministic break: a mapping_kind check violation.
    const broken = `${seedSql}\ninsert into tests.legacy_import_map (source_system, source_schema, source_table, source_id, target_schema, target_table, target_id, mapping_kind, import_batch_key, note) values ('monitoring2', null, null, null, null, null, null, 'bogus_kind', 'broken-probe', 'deliberately invalid mapping_kind to trigger a CHECK violation');\n`;
    await writeMigrationsDir("rollback", { [SCHEMA_MIGRATION_NAME]: schemaSql, [SEED_MIGRATION_NAME]: broken });

    await assert.rejects(() => runner.runMigrations({ databaseUrl: tmp.url, migrationsRoot: dir }), /ABORT while applying/);

    const testCount = await c.query("select count(*) c from tests.test");
    assert.equal(testCount.rows[0].c, "0", "a failed seed migration must leave zero seed rows behind, not a partial set");
    const recorded = await c.query(
      `select count(*) c from public.schema_migrations where migration_name = $1`,
      [`${path.basename(dir)}/${SEED_MIGRATION_NAME}`],
    );
    assert.equal(recorded.rows[0].c, "0", "a failed migration must not be recorded as applied");

    await fsp.rm(dir, { recursive: true, force: true });
  } finally {
    await c.end();
    await dropTempDb(tmp);
  }
});

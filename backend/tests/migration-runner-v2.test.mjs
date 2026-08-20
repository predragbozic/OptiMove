// Tests for the Strategy B migration runner (backend/src/migrate.js).
//
// Deliberately does NOT use the app's `pool` (backend/src/db.js, bound to
// the local OPTIMOVE database) - everything here runs against a disposable,
// uniquely-named temporary database created in before() and dropped in
// after(), so this file cannot affect OPTIMOVE state (see
// scripts/verify-test-suite-isolation.mjs, which checks exactly that).
//
// This is a lean, representative subset - not the full ~120-scenario matrix
// from the isolated pre-implementation test rounds. It covers: the
// transaction-control lexer, UTF-8 validation, checksum-mismatch abort,
// first cutover, idempotent repeated startup, empty-database abort (no
// CREATE), wrong metadata relkind, metadata shape, advisory-lock
// concurrency, a migration applying exactly once, rollback of a failed
// migration, per-migration lock_timeout/statement_timeout, the two
// targeted preflight-timeout tests for the read-only-preflight timeout gap
// fixed in this same change, and the Supabase SSL client-config regression
// found in PR #49 review.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(6).toString("hex");
const DB_NAME = `optimove_migration_runner_test_${RUN_ID}`;

// Derived from the local DATABASE_URL (loaded via dotenv by migrate.js's own
// import) rather than hardcoded, so this test file carries no credentials
// and works with whatever local Postgres each developer/CI runner has
// configured. Only the database name in the path is swapped - host, port,
// user, and password are reused as-is.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run migration-runner-v2 tests.");
const baseUrl = new URL(process.env.DATABASE_URL);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const ADMIN_URL = adminUrl.toString();
const dbUrl = new URL(baseUrl);
dbUrl.pathname = `/${DB_NAME}`;
const DATABASE_URL = dbUrl.toString();

if (DB_NAME.toLowerCase() === "optimove" || /monitoring2/i.test(DATABASE_URL)) {
  throw new Error("SAFETY: refusing to run against a forbidden database name");
}

const MIGRATIONS_DIR = path.resolve(__dirname, `migrations_v2_test_${RUN_ID}`);

let adminClient;

async function freshClient() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  return c;
}

async function assertOnTestDb(client) {
  const r = await client.query("select current_database() as db");
  assert.equal(r.rows[0].db, DB_NAME, "SAFETY: query ran against an unexpected database");
}

// Minimal stub objects - only the structure computeLegacyFingerprint()
// checks for, no real OptiMove data.
async function installLegacyFixture(client) {
  await client.query(`
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
  `);
}

async function writeMigrationFile(name, sql) {
  await fsp.mkdir(MIGRATIONS_DIR, { recursive: true });
  await fsp.writeFile(path.join(MIGRATIONS_DIR, name), sql, "utf8");
}
async function clearMigrationFiles() {
  await fsp.rm(MIGRATIONS_DIR, { recursive: true, force: true });
  await fsp.mkdir(MIGRATIONS_DIR, { recursive: true });
}

async function dropMetadataObject(client, name) {
  const kind = await runner.getRelationKind(client, "public", name);
  if (kind === null) return;
  const stmt = { r: "drop table", p: "drop table", v: "drop view", m: "drop materialized view", S: "drop sequence" }[kind];
  await client.query(`${stmt} public.${name} cascade`);
}

before(async () => {
  adminClient = new pg.Client({ connectionString: ADMIN_URL });
  await adminClient.connect();
  const cur = await adminClient.query("select current_database() as db");
  assert.equal(cur.rows[0].db, "postgres", "SAFETY: admin connection must be on the postgres database");
  await adminClient.query(`create database "${DB_NAME}"`);
  await fsp.mkdir(MIGRATIONS_DIR, { recursive: true });
});

after(async () => {
  await fsp.rm(MIGRATIONS_DIR, { recursive: true, force: true });
  await adminClient.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`, [DB_NAME]);
  await adminClient.query(`drop database if exists "${DB_NAME}"`);
  await adminClient.end();
});

// ==================== transaction-control lexer ====================
test("lexer: rejects a migration containing its own COMMIT, accepts one that merely mentions it in a string/comment", () => {
  assert.throws(() => runner.assertNoTransactionControl("create table x(id int); COMMIT;", "t1"), /contains transaction-control statement/);
  assert.doesNotThrow(() => runner.assertNoTransactionControl("-- do not COMMIT this by hand\ncreate table x(id int);", "t2"));
  assert.doesNotThrow(() => runner.assertNoTransactionControl("do $$\nbegin\n  perform 1;\nend\n$$;", "t3"), "PL/pgSQL BEGIN/END inside a dollar-quoted block is not top-level transaction control");
  assert.doesNotThrow(() => runner.assertNoTransactionControl("savepoint sp1;\nrollback to savepoint sp1;", "t4"), "ROLLBACK TO SAVEPOINT is legitimate mid-transaction control flow");
  assert.throws(() => runner.assertNoTransactionControl("insert into log(msg) values ('never closes);", "t5"), /LEXER ERROR/, "an unterminated string must raise a distinct lexer error, not silently pass");
});

// ==================== UTF-8 canonical validation ====================
test("UTF-8: accepts valid canonical UTF-8, rejects a lone continuation byte", () => {
  assert.doesNotThrow(() => runner.assertCanonicalUtf8(Buffer.from("create table x(id int);", "utf8"), "u1"));
  assert.throws(
    () => runner.assertCanonicalUtf8(Buffer.from([0x63, 0x72, 0x65, 0x61, 0x74, 0x65, 0x80]), "u2"),
    /not valid canonical UTF-8/,
  );
});

// ==================== empty database aborts without CREATE ====================
test("empty database: preflight aborts with no schema objects created", async () => {
  const client = await freshClient();
  try {
    await assertOnTestDb(client);
    const before = await client.query(`select count(*) c from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'`);
    assert.equal(before.rows[0].c, "0", "test database must start empty");

    await assert.rejects(() => runner.assertLegacyBaselinePresent(client), /does not match the expected legacy/);

    const cutover = await runner.getRelationKind(client, "public", "migration_cutovers");
    const schemaMig = await runner.getRelationKind(client, "public", "schema_migrations");
    assert.equal(cutover, null, "migration_cutovers must not be created on abort");
    assert.equal(schemaMig, null, "schema_migrations must not be created on abort");
  } finally {
    await client.end();
  }
});

// ==================== first cutover ====================
test("first cutover: legacy fingerprint passing establishes migration_cutovers + schema_migrations atomically", async () => {
  const client = await freshClient();
  try {
    await installLegacyFixture(client);
    await runner.assertLegacyBaselinePresent(client);

    const cutoverRow = await client.query(`select fingerprint_version, fingerprint_checksum from public.migration_cutovers where cutover_key = $1`, [runner.LEGACY_CUTOVER_KEY]);
    assert.equal(cutoverRow.rowCount, 1);
    assert.equal(cutoverRow.rows[0].fingerprint_version, runner.FINGERPRINT_VERSION);

    const smKind = await runner.getRelationKind(client, "public", "schema_migrations");
    assert.equal(smKind, "r");
    await assert.doesNotReject(() => runner.assertSchemaMigrationsShape(client));
  } finally {
    await client.end();
  }
});

// ==================== repeated startup is idempotent ====================
test("repeated startup: running the preflight again does not duplicate the cutover row or error", async () => {
  const client = await freshClient();
  try {
    await runner.assertLegacyBaselinePresent(client);
    const rows = await client.query(`select count(*) c from public.migration_cutovers where cutover_key = $1`, [runner.LEGACY_CUTOVER_KEY]);
    assert.equal(rows.rows[0].c, "1");
  } finally {
    await client.end();
  }
});

// ==================== wrong metadata relkind ====================
test("wrong metadata relkind: a VIEW occupying public.schema_migrations is rejected, not silently left behind", async () => {
  const client = await freshClient();
  try {
    await dropMetadataObject(client, "schema_migrations");
    await client.query("create view public.schema_migrations as select 1 as x");

    await assert.rejects(() => runner.assertLegacyBaselinePresent(client), (err) => {
      const chain = `${err.message} ${err.cause?.message ?? ""}`;
      return /occupied by a non-table object/.test(chain) && /relkind='v'/.test(chain);
    });

    const kind = await runner.getRelationKind(client, "public", "schema_migrations");
    assert.equal(kind, "v", "the pre-existing view must be left untouched, not silently replaced");

    // restore for subsequent tests
    await dropMetadataObject(client, "schema_migrations");
    await runner.assertLegacyBaselinePresent(client);
  } finally {
    await client.end();
  }
});

// ==================== metadata shape ====================
test("metadata shape: a schema_migrations table missing a required column is rejected", async () => {
  const client = await freshClient();
  try {
    await dropMetadataObject(client, "schema_migrations");
    await client.query("create table public.schema_migrations (migration_name text primary key)");

    await assert.rejects(() => runner.assertSchemaMigrationsShape(client), /is missing column/);

    // restore for subsequent tests
    await dropMetadataObject(client, "schema_migrations");
    await runner.assertLegacyBaselinePresent(client);
  } finally {
    await client.end();
  }
});

// ==================== checksum mismatch / migration applies exactly once / rollback of a failed migration ====================
test("apply lifecycle: applies once, skips on re-run, rejects on checksum mismatch, rolls back a broken migration", async () => {
  await clearMigrationFiles();
  await writeMigrationFile("202601010000_probe_a.sql", "create table public.probe_a (id int primary key);\n");

  await runner.runMigrations({ databaseUrl: DATABASE_URL, migrationsRoot: MIGRATIONS_DIR });
  const client = await freshClient();
  try {
    const applied = await client.query(`select checksum from public.schema_migrations where migration_name = $1`, [`${path.basename(MIGRATIONS_DIR)}/202601010000_probe_a.sql`]);
    assert.equal(applied.rowCount, 1);

    // re-run: must skip, not duplicate or error
    await assert.doesNotReject(() => runner.runMigrations({ databaseUrl: DATABASE_URL, migrationsRoot: MIGRATIONS_DIR }));
    const stillOne = await client.query(`select count(*) c from public.schema_migrations where migration_name = $1`, [`${path.basename(MIGRATIONS_DIR)}/202601010000_probe_a.sql`]);
    assert.equal(stillOne.rows[0].c, "1");

    // checksum mismatch: edit the already-applied file
    await writeMigrationFile("202601010000_probe_a.sql", "create table public.probe_a (id int primary key);\n-- edited after being applied\n");
    await assert.rejects(() => runner.runMigrations({ databaseUrl: DATABASE_URL, migrationsRoot: MIGRATIONS_DIR }), /recorded checksum differs/);
    await writeMigrationFile("202601010000_probe_a.sql", "create table public.probe_a (id int primary key);\n"); // restore

    // broken migration: syntax error must roll back fully, leave no row
    await writeMigrationFile("202601010001_broken.sql", "create table public.probe_b (id int primary keyyyyy);\n");
    await assert.rejects(() => runner.runMigrations({ databaseUrl: DATABASE_URL, migrationsRoot: MIGRATIONS_DIR }), /ABORT while applying/);
    const probeBExists = await runner.tableExists(client, "public", "probe_b");
    assert.equal(probeBExists, false, "a failed migration must not leave its target table behind");
    const brokenRow = await client.query(`select count(*) c from public.schema_migrations where migration_name = $1`, [`${path.basename(MIGRATIONS_DIR)}/202601010001_broken.sql`]);
    assert.equal(brokenRow.rows[0].c, "0", "a failed migration must not be recorded");
    await fsp.rm(path.join(MIGRATIONS_DIR, "202601010001_broken.sql"));
  } finally {
    await client.end();
  }
});

// ==================== advisory lock concurrency ====================
test("advisory lock: two concurrent runMigrations() calls both succeed and the migration is recorded exactly once", async () => {
  await clearMigrationFiles();
  await writeMigrationFile("202601020000_concurrency_probe.sql", "create table public.concurrency_probe (id int primary key);\n");

  const [r1, r2] = await Promise.allSettled([
    runner.runMigrations({ databaseUrl: DATABASE_URL, migrationsRoot: MIGRATIONS_DIR }),
    runner.runMigrations({ databaseUrl: DATABASE_URL, migrationsRoot: MIGRATIONS_DIR }),
  ]);
  assert.equal(r1.status, "fulfilled", r1.reason?.message);
  assert.equal(r2.status, "fulfilled", r2.reason?.message);

  const client = await freshClient();
  try {
    const rows = await client.query(`select count(*) c from public.schema_migrations where migration_name = $1`, [`${path.basename(MIGRATIONS_DIR)}/202601020000_concurrency_probe.sql`]);
    assert.equal(rows.rows[0].c, "1");
    const tableCount = await client.query(`select count(*) c from information_schema.tables where table_schema='public' and table_name='concurrency_probe'`);
    assert.equal(tableCount.rows[0].c, "1", "the migration's DDL must not have run twice");
  } finally {
    await client.end();
  }
});

// ==================== per-migration lock_timeout / statement_timeout ====================
test("per-migration timeouts: a migration blocked on a row lock aborts with SQLSTATE 55P03, not indefinitely", async () => {
  process.env.MIGRATION_LOCK_TIMEOUT_MS = "1000";
  process.env.MIGRATION_STATEMENT_TIMEOUT_MS = "120000";
  const shortTimeoutRunner = await import(`../src/migrate.js?lockTimeoutTest=${Date.now()}`);

  await clearMigrationFiles();
  const setupClient = await freshClient();
  await setupClient.query("create table if not exists public.lock_probe (id int primary key)");
  await setupClient.query("insert into public.lock_probe values (1) on conflict do nothing");

  const blocker = await freshClient();
  await blocker.query("begin");
  await blocker.query("update public.lock_probe set id = id where id = 1");

  await writeMigrationFile("202601030000_locked_update.sql", "update public.lock_probe set id = id where id = 1;\n");

  const t0 = Date.now();
  await assert.rejects(
    () => shortTimeoutRunner.runMigrations({ databaseUrl: DATABASE_URL, migrationsRoot: MIGRATIONS_DIR }),
    (err) => /55P03/.test(err.message),
  );
  assert.ok(Date.now() - t0 < 5000, "must abort near the configured lock_timeout, not hang");

  await blocker.query("rollback");
  await blocker.end();
  await setupClient.query("drop table if exists public.lock_probe");
  await setupClient.end();
  delete process.env.MIGRATION_LOCK_TIMEOUT_MS;
  delete process.env.MIGRATION_STATEMENT_TIMEOUT_MS;
  await clearMigrationFiles();
});

test("per-migration timeouts: a migration exceeding statement_timeout aborts with SQLSTATE 57014, not indefinitely", async () => {
  process.env.MIGRATION_STATEMENT_TIMEOUT_MS = "1000";
  const shortTimeoutRunner = await import(`../src/migrate.js?stmtTimeoutTest=${Date.now()}`);

  await clearMigrationFiles();
  await writeMigrationFile("202601030001_slow_sleep.sql", "select pg_sleep(5);\n");

  const t0 = Date.now();
  await assert.rejects(
    () => shortTimeoutRunner.runMigrations({ databaseUrl: DATABASE_URL, migrationsRoot: MIGRATIONS_DIR }),
    (err) => /57014/.test(err.message),
  );
  assert.ok(Date.now() - t0 < 4000, "must abort near the configured statement_timeout, not wait for the full pg_sleep(5)");

  delete process.env.MIGRATION_STATEMENT_TIMEOUT_MS;
  await clearMigrationFiles();
});

// ==================== Finding #3 fix: preflight session-level timeouts ====================
// Before this fix, the read-only preflight queries at the top of
// assertLegacyBaselinePresent() (which run before any transaction, hence
// before any SET LOCAL) had no timeout at all and could block indefinitely.
// applyPreflightSessionTimeouts() now sets session-level lock_timeout/
// statement_timeout right after the advisory lock is acquired, before that
// preflight runs - exactly mirroring what runMigrations() itself does.
test("Finding #3 fix, test 1/2: preflight blocked on a lock aborts with SQLSTATE 55P03, not indefinitely", async () => {
  process.env.MIGRATION_LOCK_TIMEOUT_MS = "1000";
  const shortTimeoutRunner = await import(`../src/migrate.js?preflightLockTest=${Date.now()}`);

  const client = await freshClient();
  await shortTimeoutRunner.createMigrationCutoversTable(client); // correct shape, no cutover row yet

  const blocker = await freshClient();
  await blocker.query("begin");
  await blocker.query("lock table public.migration_cutovers in access exclusive mode");

  await shortTimeoutRunner.applyPreflightSessionTimeouts(client);
  const t0 = Date.now();
  await assert.rejects(() => shortTimeoutRunner.assertLegacyBaselinePresent(client), (err) => /55P03/.test(err.message) || err.code === "55P03");
  assert.ok(Date.now() - t0 < 5000, "the preflight read must abort near lock_timeout, not hang indefinitely");

  await blocker.query("rollback");
  await blocker.end();
  await client.end();
  delete process.env.MIGRATION_LOCK_TIMEOUT_MS;
});

test("Finding #3 fix, test 2/2: preflight session statement_timeout aborts a slow query with SQLSTATE 57014", async () => {
  process.env.MIGRATION_STATEMENT_TIMEOUT_MS = "1000";
  const shortTimeoutRunner = await import(`../src/migrate.js?preflightStmtTest=${Date.now()}`);

  const client = await freshClient();
  await shortTimeoutRunner.applyPreflightSessionTimeouts(client);
  const t0 = Date.now();
  await assert.rejects(() => client.query("select pg_sleep(5)"), (err) => err.code === "57014");
  assert.ok(Date.now() - t0 < 4000, "session statement_timeout applied by applyPreflightSessionTimeouts must actually cancel a slow query");

  await client.end();
  delete process.env.MIGRATION_STATEMENT_TIMEOUT_MS;
});

// ==================== PR #49 review fix: Supabase SSL config regression ====================
// The runner's dedicated pg.Client (used instead of the app's pool - see the
// timeout comments in migrate.js for why) must carry the same
// `ssl: { rejectUnauthorized: false }` for Supabase connection strings that
// backend/src/db.js's pool already applies, or a Supabase-hosted deploy
// would fail to connect (or silently skip the certificate check it's
// relying on) the moment this runner replaced the old pool-based one.
test("Supabase SSL config: buildPgClientConfig() sets rejectUnauthorized:false for a supabase.com URL, and no ssl option otherwise", () => {
  const supabaseConfig = runner.buildPgClientConfig("postgresql://user:pass@db.abcdefgh.supabase.com:5432/postgres");
  assert.deepEqual(supabaseConfig.ssl, { rejectUnauthorized: false });

  const localConfig = runner.buildPgClientConfig(DATABASE_URL);
  assert.equal(localConfig.ssl, undefined);

  // Confirm the config actually flows into a real pg.Client's connection
  // parameters, not just the plain object this function returns -
  // construction alone does not open a network connection.
  const supabaseClient = new pg.Client(supabaseConfig);
  assert.deepEqual(supabaseClient.connectionParameters.ssl, { rejectUnauthorized: false });

  const localClient = new pg.Client(localConfig);
  assert.equal(localClient.connectionParameters.ssl, false);
});

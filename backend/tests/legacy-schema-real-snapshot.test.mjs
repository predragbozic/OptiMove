// Step 0 of T3, the REAL snapshot: backend/tests/support/legacy-schema.sql is the file the
// owner generated offline from the verified production dump (tools/legacy-schema-from-dump.mjs).
// It is committed byte for byte; this test pins that and proves it still bootstraps:
//   1. the file's sha256 is the one in legacy-schema.sql.sha256 and the header names a migration
//      that exists in migrations_v2;
//   2. the bootstrap helper applies it to a fresh disposable database, records every migration up to
//      the header's last one, and the REAL runner applies every later migration (the runner is up to date);
//   3. the CHECK constraints the bootstrap could not re-validate are EXACTLY the listed ones: a new
//      NOT VALID constraint fails this test by name, never silently.
// Disposable optimove_tests_* databases only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDisposableDatabase, dropDisposableDatabase } from "./support/disposable-db.mjs";
import { bootstrapLegacySnapshot } from "./support/legacy-bootstrap.mjs";
import { runMigrations } from "../src/migrate.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL = process.env.DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(here, "support/legacy-schema.sql");
const HASH_FILE = `${SNAPSHOT}.sha256`;
const MIGRATIONS = path.resolve(here, "../../migrations_v2");

// Why these two: the seed of tests_v42 activates a version ('active') and a trigger, which does not run
// while the seeds are replayed with triggers off, would have set published_at. The row is left as the seed
// wrote it (no data is invented) and the constraint is enforced for every new row.
const EXPECTED_NOT_VALID = ["tests.test_battery_versions.test_battery_versions_check3", "tests.test_versions.test_versions_check3"];

// The dump itself carries one constraint NOT VALID (production has it so); the snapshot keeps it as it is.
const IN_SNAPSHOT_NOT_VALID = ["training_load.metric_write_requests.metric_write_requests_request_key_length"];

let db;
after(async () => {
  if (db) await dropDisposableDatabase({ name: db.name, adminUrl: db.adminUrl, baseDatabaseUrl: ORIGINAL }).catch(() => {});
});

test("1. the committed snapshot is byte for byte the file the generator wrote (its sha256), and its header names a real migration", () => {
  const bytes = fs.readFileSync(SNAPSHOT);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const line = fs.readFileSync(HASH_FILE, "utf8").trim();
  assert.equal(line, `${sha}  legacy-schema.sql`);
  const head = bytes.toString("utf8").slice(0, 2000);
  const last = head.match(/^-- Last migration contained in the dump: (\S+)\.$/m)?.[1];
  assert.ok(last, "the header names the dump's last migration");
  assert.ok(fs.existsSync(path.join(MIGRATIONS, last)), `${last} exists in migrations_v2`);
  assert.ok(!/\u0000/.test(bytes.toString("utf8")) && !/^(INSERT INTO|COPY )/m.test(bytes.toString("utf8")), "structure only: no top-level data statement");
});

test("2. the snapshot bootstraps on a fresh disposable database and the real runner applies every later migration; the NOT VALID list is exactly the accepted one", async () => {
  const snapshotSql = fs.readFileSync(SNAPSHOT, "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  db = await createDisposableDatabase({ prefix: "legacy", label: "real_snapshot", baseDatabaseUrl: ORIGINAL });
  const boot = await bootstrapLegacySnapshot({ databaseUrl: db.url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
  assert.equal(boot.recorded, files.indexOf(last) + 1);
  assert.ok(boot.replayed.statements > 0, "the repository's seed rows were replayed");
  assert.deepEqual([...boot.replayed.checksNotValidated].sort(), EXPECTED_NOT_VALID, "the constraints left NOT VALID are exactly the accepted ones");

  await runMigrations({ databaseUrl: db.url, migrationsRoot: MIGRATIONS });
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    const recorded = (await client.query("select count(*)::int n from public.schema_migrations")).rows[0].n;
    assert.equal(recorded, files.length, "every migration file is recorded once the runner has run");
    const invalid = (await client.query(`select n.nspname || '.' || c.relname || '.' || k.conname as name from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where not k.convalidated and n.nspname not like 'pg\\_%' order by 1`)).rows.map((r) => r.name);
    assert.deepEqual(invalid, [...EXPECTED_NOT_VALID, ...IN_SNAPSHOT_NOT_VALID].sort(), "no other constraint is NOT VALID in the bootstrapped database");
    // The legacy users table keeps its required first_name / last_name (a T3 seed must set them).
    const req = (await client.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'users' and is_nullable = 'NO' and column_default is null and column_name in ('first_name','last_name') order by 1`)).rows.map((r) => r.column_name);
    assert.deepEqual(req, ["first_name", "last_name"]);
  } finally {
    await client.end();
  }
});

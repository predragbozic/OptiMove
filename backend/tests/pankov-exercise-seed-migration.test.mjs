import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { pool } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(__dirname, "../../migrations/20260818_seed_pankov_exercises.sql");
const ownerEmail = "predrag.bozic@rzsport.gov.rs";
const exerciseCodes = Array.from({ length: 31 }, (_, index) => String(1188 + index));
const customName = "Kontinuirano trčanje (12km/h, 100m 30s, 1000m 5min)";
const customSlug = "kontinuirano-trcanje-12km-h-100m-30s-1000m-5min-custom-pankov-exercises-2026-08-18";

after(async () => {
  await pool.end();
});

async function runInRollbackTransaction(fn) {
  const client = await pool.connect();
  const q = (text, params = []) => client.query(text, params);
  await q("begin");
  try {
    await fn(q);
  } finally {
    await q("rollback");
    client.release();
  }
}

async function seedOwnerUser(q) {
  await q(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Predrag', 'Bozic', 'test-hash', 'Predrag Bozic', 'Predrag Bozic', 'coach', true)
     on conflict (email) do nothing`,
    [ownerEmail],
  );
  const result = await q(
    "select id from public.users where lower(email) = lower($1)",
    [ownerEmail],
  );
  return result.rows[0].id;
}

async function packageExerciseIds(q) {
  const result = await q(
    `select id
     from library.exercises
     where exercise_code = any($1::text[])
        or (exercise_code is null and (slug = $2 or name = $3))`,
    [exerciseCodes, customSlug, customName],
  );
  return result.rows.map((row) => row.id);
}

async function cleanPackageExercises(q) {
  const ids = await packageExerciseIds(q);
  if (!ids.length) return;
  for (const table of [
    "exercise_favorites",
    "exercise_domains",
    "exercise_categories",
    "exercise_sections",
    "exercise_body_parts",
    "exercise_movement_patterns",
    "exercise_tags",
  ]) {
    await q(`delete from library.${table} where exercise_id = any($1::uuid[])`, [ids]);
  }
  await q("delete from library.exercises where id = any($1::uuid[])", [ids]);
}

async function packageCount(q) {
  const result = await q(
    `select count(*)::int as count
     from library.exercises
     where exercise_code = any($1::text[])
        or (exercise_code is null and (slug = $2 or name = $3))`,
    [exerciseCodes, customSlug, customName],
  );
  return result.rows[0].count;
}

async function guardedTableCounts(q) {
  const result = await q(`
    select 'public.users' as table_name, count(*)::int as count from public.users
    union all select 'public.athletes', count(*)::int from public.athletes
    union all select 'plans.plans', count(*)::int from plans.plans
    union all select 'plans.plan_nodes', count(*)::int from plans.plan_nodes
    union all select 'plans.plan_items', count(*)::int from plans.plan_items
  `);
  return Object.fromEntries(result.rows.map((row) => [row.table_name, row.count]));
}

async function runSeedMigration(q) {
  const sql = await readFile(migrationPath, "utf8");
  await q(sql);
}

test("Pankov exercise seed migration inserts exactly 32 exercises from an empty package state", async () => {
  await runInRollbackTransaction(async (q) => {
    await seedOwnerUser(q);
    await cleanPackageExercises(q);

    assert.equal(await packageCount(q), 0, "test setup should start with no package exercises");
    await runSeedMigration(q);

    assert.equal(await packageCount(q), 32, "migration should insert the 31 coded exercises plus one custom exercise");
  });
});

test("Pankov exercise seed migration is idempotent on rerun", async () => {
  await runInRollbackTransaction(async (q) => {
    await seedOwnerUser(q);
    await cleanPackageExercises(q);

    await runSeedMigration(q);
    assert.equal(await packageCount(q), 32);

    await runSeedMigration(q);
    assert.equal(await packageCount(q), 32, "second run must not insert duplicates");
  });
});

test("Pankov exercise seed migration leaves an existing identical exercise untouched", async () => {
  await runInRollbackTransaction(async (q) => {
    await seedOwnerUser(q);
    await cleanPackageExercises(q);

    await runSeedMigration(q);
    const before = await q(
      `select id, created_at, updated_at, name, aim
       from library.exercises
       where exercise_code = '1188'`,
    );
    assert.equal(before.rowCount, 1);

    await runSeedMigration(q);
    const after = await q(
      `select id, created_at, updated_at, name, aim
       from library.exercises
       where exercise_code = '1188'`,
    );

    assert.deepEqual(after.rows[0], before.rows[0], "existing identical exercise row should not be updated");
  });
});

test("Pankov exercise seed migration stops on same-code different-content conflict and rolls back the package", async () => {
  await runInRollbackTransaction(async (q) => {
    const ownerUserId = await seedOwnerUser(q);
    await cleanPackageExercises(q);

    await q(
      `insert into library.exercises (owner_scope, owner_user_id, created_by_user_id, exercise_code, slug, name, is_active)
       values ('user', $1, $1, '1200', 'test-conflicting-pankov-1200', 'Conflicting exercise name', true)`,
      [ownerUserId],
    );

    await q("savepoint before_pankov_seed");
    await assert.rejects(
      runSeedMigration(q),
      /Pankov exercise seed conflict for key 1200/,
      "migration should reject a same-code exercise with different content",
    );
    await q("rollback to savepoint before_pankov_seed");

    const insertedBeforeConflict = await q(
      `select count(*)::int as count
       from library.exercises
       where exercise_code = any($1::text[])`,
      [exerciseCodes.filter((code) => code !== "1200")],
    );
    const custom = await q("select count(*)::int as count from library.exercises where slug = $1", [customSlug]);

    assert.equal(insertedBeforeConflict.rows[0].count, 0, "earlier package inserts must roll back after the later conflict");
    assert.equal(custom.rows[0].count, 0, "custom package exercise must not be inserted after rollback");
    assert.equal(await packageCount(q), 1, "only the pre-existing conflicting exercise should remain inside the outer test transaction");
  });
});

test("Pankov exercise seed migration does not change users, athletes, plans, plan nodes, or plan items", async () => {
  await runInRollbackTransaction(async (q) => {
    await seedOwnerUser(q);
    await cleanPackageExercises(q);
    const before = await guardedTableCounts(q);

    await runSeedMigration(q);

    assert.deepEqual(await guardedTableCounts(q), before);
  });
});

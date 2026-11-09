// Step 0, the proof on a real PostgreSQL: the generated snapshot applies to a
// fresh database, the miniature migrations then apply on top of it, and the
// resulting catalog is the expected one. On a disposable optimove_tests_* database
// only. The dump and the migrations are the SYNTHETIC fixtures of
// tests/fixtures/legacy-schema; no real dump is read.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDisposableDatabase, dropDisposableDatabase } from "./support/disposable-db.mjs";
import { buildInventory } from "../../tools/legacy-schema/inventory.mjs";
import { generateSnapshot } from "../../tools/legacy-schema/generate.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/legacy-schema");
const ORIGINAL = process.env.DATABASE_URL;
let db;
let client;

before(async () => {
  db = await createDisposableDatabase({ prefix: "optimove_tests_legacy", label: "snapshot", baseDatabaseUrl: ORIGINAL });
  client = new pg.Client({ connectionString: db.url });
  await client.connect();
});
after(async () => {
  if (client) await client.end();
  if (db) await dropDisposableDatabase({ name: db.name, adminUrl: db.adminUrl, baseDatabaseUrl: ORIGINAL });
});

const catalog = async () => {
  const q = async (sql) => (await client.query(sql)).rows;
  return {
    columns: (await q(`select table_schema || '.' || table_name || '.' || column_name as c from information_schema.columns
                         where table_schema in ('public','plans','training_load') order by 1`)).map((r) => r.c),
    constraints: (await q(`select n.nspname || '.' || t.relname || '.' || c.conname as c from pg_constraint c join pg_class t on t.oid = c.conrelid
                             join pg_namespace n on n.oid = t.relnamespace where n.nspname in ('public','plans','training_load') order by 1`)).map((r) => r.c),
    indexes: (await q(`select schemaname || '.' || indexname as c from pg_indexes where schemaname in ('public','plans','training_load') order by 1`)).map((r) => r.c),
    triggers: (await q(`select n.nspname || '.' || t.relname || '.' || g.tgname as c from pg_trigger g join pg_class t on t.oid = g.tgrelid
                          join pg_namespace n on n.oid = t.relnamespace where not g.tgisinternal and n.nspname in ('public','plans','training_load') order by 1`)).map((r) => r.c),
    functions: (await q(`select n.nspname || '.' || p.proname as c from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','plans','training_load') order by 1`)).map((r) => r.c),
    sequences: (await q(`select schemaname || '.' || sequencename as c from pg_sequences where schemaname in ('public','plans','training_load') order by 1`)).map((r) => r.c),
  };
};

test("the snapshot applies to a fresh database, the migrations apply on top of it, and the catalog is the expected one (the content_language column and its constraints come from the migration, once)", async () => {
  const inventory = buildInventory(path.join(fixtures, "migrations"));
  const { sql } = generateSnapshot({ dumpText: fs.readFileSync(path.join(fixtures, "synthetic-dump.sql"), "utf8"), inventory });
  await client.query(sql);
  const afterSnapshot = await catalog();
  assert.ok(!afterSnapshot.columns.includes("public.users.content_language"), "the snapshot has not the column the migration adds");
  assert.deepEqual(afterSnapshot.columns.filter((c) => c.startsWith("training_load.")), [], "nothing of the migrations' schema");
  // The miniature migration, exactly as it is on disk.
  await client.query(fs.readFileSync(path.join(fixtures, "migrations/001_mini_v2.sql"), "utf8"));
  const final = await catalog();
  assert.deepEqual(final, {
    columns: [
      "plans.plan_items.id", "plans.plan_items.note", "plans.plan_items.plan_id",
      "public.app_audit.id", "public.app_audit.note",
      "public.teams.id", "public.teams.name", "public.teams.owner_id",
      "public.users.content_language", "public.users.email", "public.users.full_name", "public.users.id", "public.users.updated_at",
      "training_load.items.id", "training_load.items.team_id",
    ],
    constraints: [
      "plans.plan_items.plan_items_pkey", "public.app_audit.app_audit_pkey", "public.teams.teams_owner_fk", "public.teams.teams_pkey",
      "public.users.users_email_check", "public.users.users_email_key", "public.users.users_language_check", "public.users.users_language_known", "public.users.users_pkey",
      "training_load.items.items_pkey",
    ],
    indexes: [
      "plans.plan_items_pkey", "public.app_audit_pkey", "public.teams_owner_idx", "public.teams_pkey", "public.users_email_key", "public.users_language_idx", "public.users_pkey",
      "training_load.items_pkey", "training_load.items_team_idx",
    ],
    triggers: ["public.users.users_touch", "training_load.items.items_touch"],
    functions: ["public.touch_updated_at"],
    sequences: ["plans.plan_items_id_seq"],
  });
  // The sequence is owned by its column and the default points at it.
  const owner = (await client.query(`select d.refobjid::regclass::text as t from pg_depend d where d.objid = 'plans.plan_items_id_seq'::regclass and d.deptype = 'a'`)).rows[0];
  assert.equal(owner.t, "plans.plan_items");
});

test("a snapshot is applied exactly once: applying it again to the same database fails (it is a bootstrap, not an idempotent patch)", async () => {
  const inventory = buildInventory(path.join(fixtures, "migrations"));
  const { sql } = generateSnapshot({ dumpText: fs.readFileSync(path.join(fixtures, "synthetic-dump.sql"), "utf8"), inventory });
  await assert.rejects(() => client.query(sql), /already exists/);
});

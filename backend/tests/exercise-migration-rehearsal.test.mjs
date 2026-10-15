import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDisposableDatabase } from "./support/disposable-db.mjs";
import { applyNewMigration, MIGRATIONS_V2_ROOT } from "../src/migrate.js";

const ownership = "202610151200_exercise_library_ownership_and_collections.sql";
const integrity = "202610151300_exercise_copy_source_integrity.sql";

async function withFixture(label, work) {
  const database = await createDisposableDatabase({ prefix: "exercise_rehearsal", label });
  const client = new pg.Client({ connectionString: database.url });
  try {
    await client.connect();
    const target = (await client.query("select current_database() as database,host(inet_server_addr()) as host,inet_server_port() as port")).rows[0];
    assert.equal(target.database, database.name);
    assert.ok(["127.0.0.1", "::1"].includes(target.host));
    console.log("ISOLATED MIGRATION REHEARSAL", JSON.stringify({ ...target, runner: "applyNewMigration", files: [ownership, integrity] }));
    await client.query(`create schema library;
      create table public.users (id uuid primary key default gen_random_uuid());
      create table library.exercises (
        id uuid primary key default gen_random_uuid(),owner_scope text not null,owner_user_id uuid references public.users(id)
      );
      create table public.schema_migrations (
        migration_name text primary key,checksum text,execution_time_ms integer,runner_version text
      )`);
    const apply = (name) => applyNewMigration(client, MIGRATIONS_V2_ROOT, fileURLToPath(new URL(`../../migrations_v2/${name}`, import.meta.url)));
    await apply(ownership);
    await work(client, apply);
  } finally {
    try { await client.end(); }
    finally { await database.drop(); }
  }
}

test("empty-state rollback executes transactionally and can itself be rolled back without data loss", async () => {
  await withFixture("empty", async (client, apply) => {
    await apply(integrity);
    const sql = await readFile(new URL("../../docs/runbooks/exercise-library-collections-rollback.sql", import.meta.url), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      assert.equal((await client.query("select to_regclass('library.exercise_collections') as table")).rows[0].table, null);
    } finally { await client.query("rollback"); }
    assert.notEqual((await client.query("select to_regclass('library.exercise_collections') as table")).rows[0].table, null);
    assert.equal((await client.query("select count(*)::integer as count from pg_trigger where tgname='exercise_copy_source_guard'")).rows[0].count, 1);
    assert.equal((await client.query("select count(*)::integer as count from public.schema_migrations")).rows[0].count, 2);
  });
});

test("populated rollback refuses and preserves source, private copy and migration ledger", async () => {
  await withFixture("populated", async (client, apply) => {
    await apply(integrity);
    const owner = (await client.query("insert into public.users default values returning id")).rows[0].id;
    const source = (await client.query("insert into library.exercises (owner_scope) values ('system') returning id")).rows[0].id;
    await client.query("insert into library.exercises (owner_scope,owner_user_id,source_exercise_id) values ('user',$1,$2)", [owner, source]);
    const before = (await client.query("select * from library.exercises order by id")).rows;
    await client.query("begin");
    try {
      await assert.rejects(client.query(await readFile(new URL("../../docs/runbooks/exercise-library-collections-rollback.sql", import.meta.url), "utf8")), /Rollback refused/);
    } finally { await client.query("rollback"); }
    assert.deepEqual((await client.query("select * from library.exercises order by id")).rows, before);
    assert.equal((await client.query("select count(*)::integer as count from public.schema_migrations")).rows[0].count, 2);
  });
});

test("invalid pre-existing private source fails closed without installing guard or rewriting rows", async () => {
  await withFixture("invalid", async (client, apply) => {
    const owner = (await client.query("insert into public.users default values returning id")).rows[0].id;
    const source = (await client.query("insert into library.exercises (owner_scope,owner_user_id) values ('user',$1) returning id", [owner])).rows[0].id;
    await client.query("insert into library.exercises (owner_scope,owner_user_id,source_exercise_id) values ('user',$1,$2)", [owner, source]);
    const before = (await client.query("select * from library.exercises order by id")).rows;
    await assert.rejects(apply(integrity), /ABORT.*23514/);
    assert.deepEqual((await client.query("select * from library.exercises order by id")).rows, before);
    assert.equal((await client.query("select count(*)::integer as count from pg_trigger where tgname='exercise_copy_source_guard'")).rows[0].count, 0);
    assert.equal((await client.query("select count(*)::integer as count from public.schema_migrations")).rows[0].count, 1);
  });
});

test("official runner fails closed when its transaction default is REPEATABLE READ", async () => {
  await withFixture("isolation", async (client, apply) => {
    await client.query("set default_transaction_isolation='repeatable read'");
    await assert.rejects(apply(integrity), /ABORT.*23514/);
    await client.query("set default_transaction_isolation='read committed'");
    assert.equal((await client.query("select count(*)::integer as count from public.schema_migrations")).rows[0].count, 1);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDisposableDatabase } from "./support/disposable-db.mjs";
import { applyNewMigration, MIGRATIONS_V2_ROOT } from "../src/migrate.js";

const ownership = "202610151200_exercise_library_ownership_and_collections.sql";
const integrity = "202610151300_exercise_copy_source_integrity.sql";

test("block catalog migration preserves grants, membership and exercises with private-by-default previews", async () => {
  await withFixture("block_catalog",async(client,apply)=>{
    const owner=(await client.query("insert into public.users default values returning id")).rows[0].id;
    const exercise=(await client.query("insert into library.exercises (owner_scope) values ('system') returning id")).rows[0].id;
    const block=(await client.query("insert into library.exercise_collections (name,created_by_user_id) values ('Existing',$1) returning id",[owner])).rows[0].id;
    await client.query("insert into library.exercise_collection_items (collection_id,exercise_id) values ($1,$2)",[block,exercise]);
    await client.query("insert into library.exercise_collection_users (collection_id,user_id) values ($1,$2)",[block,owner]);
    const before=(await client.query("select * from library.exercises")).rows;
    await apply("202610162230_exercise_block_catalog.sql");
    assert.deepEqual((await client.query("select * from library.exercises")).rows,before);
    assert.deepEqual((await client.query("select access_all,block_preview,exercise_preview,description,cover_image_url from library.exercise_collections where id=$1",[block])).rows[0],
      {access_all:false,block_preview:"hidden",exercise_preview:"hidden",description:"",cover_image_url:""});
    assert.equal((await client.query("select count(*)::integer as count from library.exercise_collection_users where collection_id=$1",[block])).rows[0].count,1);
    await assert.rejects(client.query("insert into library.exercise_collection_items (collection_id,exercise_id) values ($1,$2)",[block,exercise]),/duplicate key/);
    await assert.rejects(client.query("update library.exercise_collections set exercise_preview='public' where id=$1",[block]),/check constraint/);
    assert.equal((await client.query("select count(*)::integer as count from public.schema_migrations")).rows[0].count,2);
  });
});

test("personal classification migration preserves existing rows and enables scoped metadata and private provenance", async () => {
  await withFixture("classification", async (client, apply) => {
    await apply(integrity);
    await client.query(`create table library.filter_hidden (
      user_id uuid not null references public.users(id),kind text not null,
      item_id uuid not null,unique(user_id,kind,item_id),
      constraint filter_hidden_kind_check check(kind in ('domain','category','section','tag','attractor'))
    )`);
    const owner = (await client.query("insert into public.users default values returning id")).rows[0].id;
    const source = (await client.query("insert into library.exercises (owner_scope) values ('system') returning id")).rows[0].id;
    const copy = (await client.query("insert into library.exercises (owner_scope,owner_user_id,source_exercise_id) values ('user',$1,$2) returning id", [owner, source])).rows[0].id;
    await client.query("insert into library.filter_hidden (user_id,kind,item_id) values ($1,'domain',$2)", [owner, source]);
    const before = (await client.query("select id,owner_scope,owner_user_id,source_exercise_id from library.exercises order by id")).rows;
    await apply("202610161400_exercise_personal_classification.sql");
    assert.deepEqual((await client.query("select id,owner_scope,owner_user_id,source_exercise_id from library.exercises order by id")).rows, before);
    assert.equal((await client.query("select count(*)::int as count from library.exercises where copy_parent_id is not null")).rows[0].count, 0);
    assert.equal((await client.query("select relrowsecurity from pg_class where oid='library.exercise_classifications'::regclass")).rows[0].relrowsecurity, true);
    await client.query("insert into library.exercise_classifications (user_id,exercise_id,overrides) values ($1,$2,'{\"purposes\":[]}')", [owner, source]);
    await client.query("insert into library.filter_hidden (user_id,kind,item_id) values ($1,'exercise',$2)", [owner, source]);
    await assert.rejects(client.query("insert into library.filter_hidden (user_id,kind,item_id) values ($1,'invalid',$2)", [owner, source]), /filter_hidden_kind_check/);
    const descendant = (await client.query("insert into library.exercises (owner_scope,owner_user_id,copy_parent_id) values ('user',$1,$2) returning id", [owner, copy])).rows[0].id;
    await assert.rejects(client.query("update library.exercises set copy_parent_id=$1 where id=$2", [source, descendant]), /provenance/);
    await assert.rejects(client.query("insert into library.exercises (owner_scope,owner_user_id,source_exercise_id) values ('user',$1,$2)", [owner, source]), /duplicate key/);
    await assert.rejects(client.query("delete from library.exercises where id=$1", [copy]), /foreign key/);
    assert.equal((await client.query("select count(*)::int as count from public.schema_migrations")).rows[0].count, 3);
  });
});

test("personal tag migration is additive, idempotent and keeps per-user names private", async () => {
  await withFixture("personal_tags", async (client, apply) => {
    const name = "202610161100_exercise_personal_tags.sql";
    const owner = (await client.query("insert into public.users default values returning id")).rows[0].id;
    const other = (await client.query("insert into public.users default values returning id")).rows[0].id;
    const source = (await client.query("insert into library.exercises (owner_scope) values ('system') returning id")).rows[0].id;
    const before = (await client.query("select * from library.exercises")).rows;
    await apply(name);
    await client.query("insert into library.exercise_personal_tags (user_id,exercise_id,name) values ($1,$3,'skip'),($2,$3,'skip')", [owner, other, source]);
    await assert.rejects(client.query("insert into library.exercise_personal_tags (user_id,exercise_id,name) values ($1,$2,'SKIP')", [owner, source]), /duplicate key/);
    await client.query(await readFile(new URL(`../../migrations_v2/${name}`, import.meta.url), "utf8"));
    assert.equal((await client.query("select count(*)::int as count from library.exercise_personal_tags")).rows[0].count, 2);
    assert.equal((await client.query("select relrowsecurity from pg_class where oid='library.exercise_personal_tags'::regclass")).rows[0].relrowsecurity, true);
    assert.deepEqual((await client.query("select * from library.exercises")).rows, before);
  });
});

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

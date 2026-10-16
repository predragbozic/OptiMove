import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { applyNewMigration, MIGRATIONS_V2_ROOT } from "../src/migrate.js";
import { createDisposableDatabase } from "./support/disposable-db.mjs";

describe("source guard migration integration", () => {
  let database;
  let client;
  let sourceId;
  let privateId;
  let foreignId;
  let copyId;
  const ownerId = crypto.randomUUID();
  const otherId = crypto.randomUUID();

  before(async () => {
    database = await createDisposableDatabase({ prefix: "exercise_source_integrity", label: "guard" });
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    assert.equal((await client.query("select current_database() as name")).rows[0].name, database.name);
    await client.query(`create schema library;
      create table public.users (id uuid primary key);
      create table library.exercises (
        id uuid primary key default gen_random_uuid(), owner_scope text not null, owner_user_id uuid references public.users(id)
      );
      create table public.schema_migrations (migration_name text primary key,checksum text,execution_time_ms integer,runner_version text)`);
    await client.query("insert into public.users values ($1),($2)", [ownerId, otherId]);
    for (const migration of [
      "202610151200_exercise_library_ownership_and_collections.sql",
      "202610151300_exercise_copy_source_integrity.sql",
    ]) {
      await applyNewMigration(client, MIGRATIONS_V2_ROOT, fileURLToPath(new URL(`../../migrations_v2/${migration}`, import.meta.url)));
    }
    sourceId = await insertExercise("system", null);
    privateId = await insertExercise("user", ownerId);
    foreignId = await insertExercise("user", otherId);
    copyId = await insertExercise("user", ownerId, sourceId);
  });

  after(async () => {
    try { await client?.end(); }
    finally { await database?.drop(); }
  });

  async function insertExercise(scope, owner, source = null, id = crypto.randomUUID()) {
    await client.query("insert into library.exercises (id,owner_scope,owner_user_id,source_exercise_id) values ($1,$2,$3,$4)", [id, scope, owner, source]);
    return id;
  }

  test("canonical system source accepts an owner's private copy", async () => {
    assert.equal((await client.query("select source_exercise_id from library.exercises where id=$1", [copyId])).rows[0].source_exercise_id, sourceId);
  });

  test("official per-file migration runner records both checksums and safely skips replay", async () => {
    assert.equal((await client.query("select count(*)::integer as count from public.schema_migrations")).rows[0].count, 2);
    const migration = "202610151300_exercise_copy_source_integrity.sql";
    await applyNewMigration(client, MIGRATIONS_V2_ROOT, fileURLToPath(new URL(`../../migrations_v2/${migration}`, import.meta.url)));
    assert.equal((await client.query("select count(*)::integer as count from public.schema_migrations")).rows[0].count, 2);
  });

  for (const kind of ["own private", "foreign private", "derived private", "missing", "self"]) {
    test(`rejects ${kind} source through direct SQL`, async () => {
      const targetId = crypto.randomUUID();
      const sources = { "own private": privateId, "foreign private": foreignId, "derived private": copyId, missing: crypto.randomUUID(), self: targetId };
      await assert.rejects(insertExercise("user", otherId, sources[kind], targetId), { code: "23514" });
    });
  }

  test("copy provenance cannot detach, repoint, transfer owner or change scope", async () => {
    const alternateSource = await insertExercise("system", null);
    for (const [column, value] of [
      ["source_exercise_id", null], ["source_exercise_id", alternateSource],
      ["owner_user_id", otherId], ["owner_scope", "system"],
    ]) {
      await assert.rejects(client.query(`update library.exercises set ${column}=$2 where id=$1`, [copyId, value]), { code: "23514" });
    }
  });

  test("referenced system source cannot become private or derived", async () => {
    const alternateSource = await insertExercise("system", null);
    await assert.rejects(client.query("update library.exercises set owner_scope='user',owner_user_id=$2 where id=$1", [sourceId, ownerId]), { code: "23514" });
    await assert.rejects(client.query("update library.exercises set owner_scope='user',owner_user_id=$2,source_exercise_id=$3 where id=$1", [sourceId, otherId, alternateSource]), { code: "23514" });
    await assert.rejects(client.query("delete from library.exercises where id=$1", [sourceId]), { code: "23503" });
  });

  test("source demotion fails closed under an older repeatable-read snapshot", async () => {
    const source = await insertExercise("system", null);
    const second = new pg.Client({ connectionString: database.url });
    await second.connect();
    try {
      await second.query("begin isolation level repeatable read");
      await second.query("select count(*) from library.exercises");
      await insertExercise("user", ownerId, source);
      await assert.rejects(second.query("update library.exercises set owner_scope='user',owner_user_id=$2 where id=$1", [source, otherId]), { code: "23514" });
    } finally {
      await second.query("rollback");
      await second.end();
    }
  });

  async function waitForConnectionLock(observer, pid) {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const row = (await observer.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0];
      if (row?.wait_event_type === "Lock") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Expected the other connection to wait on a source row lock");
  }

  test("READ COMMITTED copy-first race prevents subsequent source demotion", async () => {
    const source = await insertExercise("system", null);
    const second = new pg.Client({ connectionString: database.url });
    await second.connect();
    let demotion;
    try {
      const pid = (await second.query("select pg_backend_pid() as pid")).rows[0].pid;
      await client.query("begin isolation level read committed");
      await insertExercise("user", ownerId, source);
      demotion = assert.rejects(second.query("update library.exercises set owner_scope='user',owner_user_id=$2 where id=$1", [source, otherId]), { code: "23514" });
      await waitForConnectionLock(client, pid);
      await client.query("commit");
      await demotion;
    } finally {
      await client.query("rollback");
      await Promise.allSettled([demotion].filter(Boolean));
      await second.end();
    }
  });

  test("READ COMMITTED demotion-first race rejects a waiting copy", async () => {
    const source = await insertExercise("system", null);
    const second = new pg.Client({ connectionString: database.url });
    await second.connect();
    let copy;
    try {
      const pid = (await client.query("select pg_backend_pid() as pid")).rows[0].pid;
      await second.query("begin isolation level read committed");
      await second.query("update library.exercises set owner_scope='user',owner_user_id=$2 where id=$1", [source, otherId]);
      copy = assert.rejects(insertExercise("user", ownerId, source), { code: "23514" });
      await waitForConnectionLock(second, pid);
      await second.query("commit");
      await copy;
    } finally {
      await second.query("rollback");
      await Promise.allSettled([copy].filter(Boolean));
      await second.end();
    }
  });

  test("migration rejects an older repeatable-read preflight snapshot", async () => {
    const legacy = await createDisposableDatabase({ prefix: "exercise_source_integrity", label: "preflight" });
    const writer = new pg.Client({ connectionString: legacy.url });
    const migrator = new pg.Client({ connectionString: legacy.url });
    try {
      await writer.connect();
      await migrator.connect();
      await writer.query(`create schema library;
        create table public.users (id uuid primary key);
        create table library.exercises (id uuid primary key,owner_scope text,owner_user_id uuid)`);
      await writer.query("insert into public.users values ($1),($2)", [ownerId, otherId]);
      await writer.query(await readFile(new URL("../../migrations_v2/202610151200_exercise_library_ownership_and_collections.sql", import.meta.url), "utf8"));
      const privateSource = crypto.randomUUID();
      await writer.query("insert into library.exercises values ($1,'user',$2,null)", [privateSource, ownerId]);
      await migrator.query("begin isolation level repeatable read");
      await migrator.query("select count(*) from library.exercises");
      await writer.query("insert into library.exercises values ($1,'user',$2,$3)", [crypto.randomUUID(), otherId, privateSource]);
      const sql = await readFile(new URL("../../migrations_v2/202610151300_exercise_copy_source_integrity.sql", import.meta.url), "utf8");
      await assert.rejects(migrator.query(sql), { code: "23514" });
    } finally {
      try { await migrator.query("rollback"); } catch {}
      await Promise.allSettled([writer.end(), migrator.end()]);
      await legacy.drop();
    }
  });
});

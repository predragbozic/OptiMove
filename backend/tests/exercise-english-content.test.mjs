// Migration 202611031200_exercise_english_content.sql (owner, 2026-11-03:
// English names and instructions of exercises, shown by the reader's
// language): applied by the real runner on a disposable database, its CHECKs,
// and docs/runbooks/exercise-english-content-rollback.sql - every refusal, the
// rollback back to the schema as it was, and a second apply. The routes that
// read and write the columns are tested in exercises-upsert.test.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb } from "./_gpexe-disposable-db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = "202611031200_exercise_english_content.sql";
const RECORD = `migrations_v2/${MIGRATION}`;
const ROLLBACK_SQL = path.resolve(__dirname, "../../docs/runbooks/exercise-english-content-rollback.sql");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
if (!ORIGINAL_DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");

let db;
let c;

before(async () => {
  // The legacy scaffold (public.users, a minimal library.exercises) and the
  // runner's own bookkeeping, with no migration applied yet.
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "exen", migrations: [] });
  c = new pg.Client({ connectionString: db.url });
  await c.connect();
  assert.equal((await c.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
});

after(async () => {
  await c?.end();
  await db?.drop();
});

// The two tables' columns and constraints, as the catalog shows them.
async function shape() {
  return (await c.query(`
    select 'c:' || table_schema || '.' || table_name || '.' || column_name || '=' || data_type || '/' || is_nullable || '/' || coalesce(column_default, '') as x
      from information_schema.columns
     where (table_schema = 'library' and table_name = 'exercises') or (table_schema = 'public' and table_name = 'users')
    union all
    select 'k:' || conrelid::regclass::text || '.' || conname || '=' || md5(pg_get_constraintdef(oid))
      from pg_constraint where conrelid in ('library.exercises'::regclass, 'public.users'::regclass)
    order by 1`)).rows.map((row) => row.x);
}

// The tables' storage files: a rewrite gives a table a new one.
const storage = async () => (await c.query("select relname, relfilenode from pg_class where oid in ('public.users'::regclass, 'library.exercises'::regclass) order by relname")).rows;

const recorded = async () => Number((await c.query("select count(*) from public.schema_migrations where migration_name = $1", [RECORD])).rows[0].count);
const rollbackSql = () => fsp.readFile(ROLLBACK_SQL, "utf8");

let before_;
let after_;
let exerciseId;
let userId;

test("1. the runner applies it: two nullable English columns and the reader's language, Serbian by default; no row is rewritten", async () => {
  exerciseId = (await c.query("insert into library.exercises default values returning id")).rows[0].id;
  userId = (await c.query("insert into public.users (email) values ('reader@test.local') returning id")).rows[0].id;
  before_ = await shape();
  const files = await storage();
  await applyGpexeTestMigrations(db.url, [MIGRATION]);
  after_ = await shape();
  assert.deepEqual(await storage(), files, "neither table is rewritten");
  assert.equal(await recorded(), 1);
  const added = after_.filter((x) => !before_.includes(x)).map((x) => x.split("=")[0]);
  assert.deepEqual(added.sort(), [
    "c:library.exercises.instruction_en",
    "c:library.exercises.name_en",
    "c:public.users.content_language",
    "k:library.exercises.exercises_instruction_en_trimmed",
    "k:library.exercises.exercises_name_en_trimmed",
    "k:users.users_content_language_known",
  ]);
  assert.deepEqual(before_.filter((x) => !after_.includes(x)), [], "nothing that existed changed");
  assert.ok(after_.includes("c:library.exercises.name_en=text/YES/"));
  assert.ok(after_.includes("c:library.exercises.instruction_en=text/YES/"));
  assert.ok(after_.includes("c:public.users.content_language=text/NO/'sr'::text"));
  const row = (await c.query("select name_en, instruction_en from library.exercises where id = $1", [exerciseId])).rows[0];
  assert.deepEqual(row, { name_en: null, instruction_en: null }, "an existing exercise has no English text");
  assert.equal((await c.query("select content_language from public.users where id = $1", [userId])).rows[0].content_language, "sr", "an existing user reads in Serbian");
});

test("2. the CHECKs: English text is NULL or trimmed and non-empty; the language is sr or en", async () => {
  for (const column of ["name_en", "instruction_en"]) {
    for (const value of ["", " ", " Lunge", "Lunge ", "\tLunge", "Lunge\n", "\r\nLunge"]) {
      await assert.rejects(
        c.query(`update library.exercises set ${column} = $2 where id = $1`, [exerciseId, value]),
        (error) => error.code === "23514" && error.constraint === `exercises_${column}_trimmed`,
        `${column} = ${JSON.stringify(value)} is refused`,
      );
    }
    for (const value of ["Lunge", "First line\nsecond line", null]) {
      await c.query(`update library.exercises set ${column} = $2 where id = $1`, [exerciseId, value]);
      assert.equal((await c.query(`select ${column} as v from library.exercises where id = $1`, [exerciseId])).rows[0].v, value);
    }
  }
  for (const value of ["de", "EN", "", "sr "]) {
    await assert.rejects(
      c.query("update public.users set content_language = $2 where id = $1", [userId, value]),
      (error) => error.code === "23514" && error.constraint === "users_content_language_known",
      `content_language = ${JSON.stringify(value)} is refused`,
    );
  }
  await assert.rejects(c.query("update public.users set content_language = null where id = $1", [userId]), (error) => error.code === "23502");
  await c.query("update public.users set content_language = 'en' where id = $1", [userId]);
  await c.query("update public.users set content_language = 'sr' where id = $1", [userId]);
  assert.equal((await c.query("insert into public.users (email) values ('new@test.local') returning content_language")).rows[0].content_language, "sr");
});

test("3. the rollback refuses while it would lose data or another migration depends on it, then returns the schema exactly; the migration applies again", async () => {
  const refused = async (pattern, label) => {
    await assert.rejects(c.query(await rollbackSql()), pattern, label);
    // The refused script opened its transaction and stopped inside it (as
    // psql -v ON_ERROR_STOP=1 would); end it on this connection.
    await c.query("rollback");
    assert.deepEqual(await shape(), after_, `${label}: nothing changed`);
    assert.equal(await recorded(), 1, `${label}: still recorded`);
  };

  const later = "migrations_v2/202612311200_later.sql";
  await c.query("insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ($1, $2, 0, 'test')", [later, "0".repeat(64)]);
  await refused(/a later migration is recorded/, "under a later migration");
  await c.query("delete from public.schema_migrations where migration_name = $1", [later]);

  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("select pg_advisory_lock(822026)");
    await refused(/the migrator holds its lock/, "while the migrator runs");
    await holder.query("select pg_advisory_unlock(822026)");
  } finally {
    await holder.end();
  }

  await c.query("update library.exercises set name_en = 'Lunge' where id = $1", [exerciseId]);
  await refused(/exercises with English content exist/, "an English name");
  await c.query("update library.exercises set name_en = null, instruction_en = 'Step forward.' where id = $1", [exerciseId]);
  await refused(/exercises with English content exist/, "an English instruction");
  await c.query("update library.exercises set instruction_en = null where id = $1", [exerciseId]);
  await c.query("update public.users set content_language = 'en' where id = $1", [userId]);
  await refused(/users who read exercises in English exist/, "an English reader");
  await c.query("update public.users set content_language = 'sr' where id = $1", [userId]);

  // A transaction still writing an exercise: the rollback waits at most its
  // lock_timeout (5 s), then stops with nothing dropped.
  const writer = new pg.Client({ connectionString: db.url });
  await writer.connect();
  try {
    await writer.query("begin");
    await writer.query("update library.exercises set name_en = null where id = $1", [exerciseId]);
    const started = Date.now();
    await assert.rejects(c.query(await rollbackSql()), (error) => error.code === "55P03", "a lock timeout");
    await c.query("rollback");
    const waited = Date.now() - started;
    assert.ok(waited >= 4500 && waited < 9000, `it waited for the 5 s lock_timeout, no longer (${waited} ms)`);
    assert.deepEqual(await shape(), after_, "a held exercise: nothing changed");
  } finally {
    await writer.query("rollback").catch(() => {});
    await writer.end();
  }

  await c.query(await rollbackSql());
  assert.deepEqual(await shape(), before_, "the columns and constraints are exactly as before the migration");
  assert.equal(await recorded(), 0, "the record is gone, so the runner applies it again");
  await assert.rejects(c.query(await rollbackSql()), /the migration is not recorded/, "a second rollback refuses");
  await c.query("rollback");

  await applyGpexeTestMigrations(db.url, [MIGRATION]);
  assert.deepEqual(await shape(), after_, "it applies again, identically");
  assert.equal(await recorded(), 1);
});

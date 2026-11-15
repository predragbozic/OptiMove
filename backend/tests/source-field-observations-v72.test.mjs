// I1, migration v72 on disposable databases: the preflight on the database before it, the refusal over an existing table, the
// post-check after it, the rollback back to the catalog before v72 exactly and its refusal once an observation exists, and v72
// applies again. The writer rules are proven through a real check in gpexe-in-app-import.test.mjs ("I1: ...").
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const V72_FILE = "202611151200_training_load_v72_source_field_observations.sql";
const MAIN_MIGRATIONS = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V72_FILE) + 1).filter((m) => !m.includes("app_error_events"));
const BEFORE_V72 = MAIN_MIGRATIONS.filter((m) => m !== V72_FILE);
const RUNBOOK = (name) => new URL(`../../docs/runbooks/${name}`, import.meta.url);

async function catalogOf(client) {
  const q = async (sql) => (await client.query(sql)).rows.map((r) => r.d);
  return {
    tables: await q(`select table_name d from information_schema.tables where table_schema = 'training_load' order by 1`),
    constraints: await q(`select c.relname || '.' || conname || ' :: ' || pg_get_constraintdef(k.oid) d from pg_constraint k join pg_class c on c.oid = k.conrelid
                           join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'training_load' order by 1`),
    indexes: await q(`select indexname || ' :: ' || indexdef d from pg_indexes where schemaname = 'training_load' order by 1`),
    functions: await q(`select n.nspname || '.' || p.proname || ' ' || md5(p.prosrc) d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('training_load', 'training') order by 1`),
    triggers: await q(`select c.relname || '.' || t.tgname || ' ' || t.tgenabled::text d from pg_trigger t join pg_class c on c.oid = t.tgrelid
                        join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'training_load' and not t.tgisinternal order by 1`),
    migrations: await q(`select migration_name d from public.schema_migrations order by 1`),
  };
}
async function booleansOf(client, sql) {
  const results = [].concat(await client.query(sql));
  const out = [];
  for (const res of results) for (const row of res.rows) for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") out.push([k, v]);
  return out;
}

test("1. v72: the preflight passes before it; it refuses over an existing table, changing nothing; the post-check passes after it; the rollback restores the catalog exactly, refuses once an observation exists, and v72 applies again", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "sfo70rb", migrations: BEFORE_V72 });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    const pre = await booleansOf(client, fs.readFileSync(RUNBOOK("source-field-observations-v72-preflight.sql"), "utf8"));
    assert.equal(pre.length, 14, "the preflight returns its 14 booleans");
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok before v72");
    const before = await catalogOf(client);

    await client.query(`create table training_load.source_field_observations (id int)`);
    await assert.rejects(applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS), /v72_source_field_observations\.sql" \(SQLSTATE 23514\)/);
    await client.query(`drop table training_load.source_field_observations`);
    assert.deepEqual(await catalogOf(client), before, "nothing of v72 was applied over an existing table");

    await applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS);
    const post = await booleansOf(client, fs.readFileSync(RUNBOOK("source-field-observations-v72-postcheck.sql"), "utf8"));
    assert.equal(post.length, 11, "the post-check returns its 11 booleans");
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok after v72");
    const after = await catalogOf(client);
    assert.notDeepEqual(after, before);

    await client.query(fs.readFileSync(RUNBOOK("source-field-observations-v72-rollback.sql"), "utf8"));
    assert.deepEqual(await catalogOf(client), before, "the rollback restores the catalog before v72 exactly");
    await applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS);
    assert.deepEqual(await catalogOf(client), after, "re-applied: the same catalog");

    // Once an observation exists the rollback refuses and changes nothing. (The row is planted with the triggers and the
    // foreign keys off, as a replica would write it; the writer itself is proven in gpexe-in-app-import.test.mjs.)
    await client.query("set session_replication_role = replica");
    await client.query(
      `insert into training_load.source_field_observations (source_connection_id, api_family, endpoint, field_name, value_kind, answers_seen, first_seen_check_id, last_seen_check_id)
       values ($1, 'rest_v1', 'athlete_session', 'planted', 'number', 1, $2, $2)`, [crypto.randomUUID(), crypto.randomUUID()]);
    await client.query("set session_replication_role = origin");
    await assert.rejects(client.query(fs.readFileSync(RUNBOOK("source-field-observations-v72-rollback.sql"), "utf8")), /v72 rollback refused: a field observation exists/);
    await client.query("rollback").catch(() => {});
    assert.deepEqual(await catalogOf(client), after, "the refused rollback changed nothing");
  } finally {
    await client.end();
    await rb.drop();
  }
});

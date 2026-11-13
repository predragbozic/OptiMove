// MT-A, migration v67 on disposable databases: the preflight on the database before it, the md5 gate on the approver function,
// the post-check after it, the rollback back to the catalog before v67 exactly and its refusal once a choice exists, and a
// second apply. The routes are gpexe-track-choices-mt-a.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const V67_FILE = "202611131200_training_load_v67_gpexe_track_choices.sql";
const MAIN_MIGRATIONS = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V67_FILE) + 1).filter((m) => !m.includes("app_error_events"));
const BEFORE_V67 = MAIN_MIGRATIONS.filter((m) => m !== V67_FILE);
const RUNBOOK = (name) => new URL(`../../docs/runbooks/${name}`, import.meta.url);

async function catalogOf(client) {
  const q = async (sql) => (await client.query(sql)).rows.map((r) => r.d);
  return {
    tables: await q(`select table_name d from information_schema.tables where table_schema = 'training_load' order by 1`),
    columns: await q(`select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable d from information_schema.columns
                       where table_schema = 'training_load' and table_name = 'gpexe_track_choices' order by 1`),
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

test("1. v67: the preflight passes before it; it refuses over another approver body and over an existing table, changing nothing; the post-check passes after it; the rollback restores the catalog exactly, refuses once a choice exists, and v67 applies again", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "tc67rb", migrations: BEFORE_V67 });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    const pre = await booleansOf(client, fs.readFileSync(RUNBOOK("gpexe-track-choices-v67-preflight.sql"), "utf8"));
    assert.equal(pre.length, 13, "the preflight returns its 13 booleans");
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok before v67");
    const before = await catalogOf(client);

    // The md5 gate on the approver function.
    const approver = (await client.query(`select pg_get_functiondef('training_load.lock_gpexe_import_approver(uuid, uuid)'::regprocedure) d`)).rows[0].d;
    await client.query(approver.replace("$function$\ndeclare", "$function$\n-- changed\ndeclare"));
    await assert.rejects(applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS), /v67_gpexe_track_choices\.sql" \(SQLSTATE 23514\)/);
    await client.query(approver);
    assert.deepEqual(await catalogOf(client), before, "nothing of v67 was applied over another approver body");
    // An existing table of that name.
    await client.query(`create table training_load.gpexe_track_choices (id int)`);
    await assert.rejects(applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS), /v67_gpexe_track_choices\.sql" \(SQLSTATE 23514\)/);
    await client.query(`drop table training_load.gpexe_track_choices`);
    assert.deepEqual(await catalogOf(client), before, "nothing of v67 was applied over an existing table");

    await applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS);
    const post = await booleansOf(client, fs.readFileSync(RUNBOOK("gpexe-track-choices-v67-postcheck.sql"), "utf8"));
    assert.equal(post.length, 15, "the post-check returns its 15 booleans");
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok after v67");
    const after = await catalogOf(client);
    assert.notDeepEqual(after, before);

    await client.query(fs.readFileSync(RUNBOOK("gpexe-track-choices-v67-rollback.sql"), "utf8"));
    assert.deepEqual(await catalogOf(client), before, "the rollback restores the catalog before v67 exactly");
    await applyGpexeTestMigrations(rb.url, MAIN_MIGRATIONS);
    assert.deepEqual(await catalogOf(client), after, "re-applied: the same catalog");

    // Once a choice exists the rollback refuses and changes nothing.
    const u = (await client.query(`insert into public.users (email, full_name, display_name) values ('tc67@test.local','R','R') returning id`)).rows[0].id;
    await client.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [u]);
    const club = (await client.query(`insert into public.clubs (name) values ('C') returning id`)).rows[0].id;
    const team = (await client.query(`insert into public.teams (club_id, name) values ($1,'T') returning id`, [club])).rows[0].id;
    await client.query("begin");
    await client.query("select set_config('optimove.team_import_tx', txid_current()::text, true)");
    await client.query(`insert into training_load.gpexe_team_import_switch (owner_team_id, enabled, mode, changed_by_user_id, change_reason) values ($1,true,'pilot',$2,'test')`, [team, u]);
    await client.query(`insert into training_load.gpexe_team_import_switch_history (owner_team_id, enabled, mode, changed_by_user_id, basis, change_reason) values ($1,true,'pilot',$2,'platform_admin','test')`, [team, u]);
    await client.query("commit");
    await client.query("begin");
    await client.query(`select set_config('optimove.track_choice_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [u]);
    await client.query(
      `insert into training_load.gpexe_track_choices (owner_team_id, gpexe_team_session_id, gpexe_athlete_id, track_set_fingerprint, choice,
         chosen_by_user_id, chosen_basis, request_key, request_hash) values ($1,'1','1','1:1;2:2','none',$2,'platform_admin',$3,$4)`,
      [team, u, crypto.randomUUID(), "a".repeat(64)]);
    await client.query("commit");
    await assert.rejects(client.query(fs.readFileSync(RUNBOOK("gpexe-track-choices-v67-rollback.sql"), "utf8")), /v67 rollback refused: a track choice exists/);
    await client.query("rollback").catch(() => {});
    assert.deepEqual(await catalogOf(client), after, "the refused rollback changed nothing");
  } finally {
    await client.end();
    await rb.drop();
  }
});

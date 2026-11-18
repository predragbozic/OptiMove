// Central calendar K2b-2a-1 — migration v81 itself (plan
// docs/ai/central-calendar-k2b2-plan.md, 9.1.1, 9.1.8; the manager's GO
// 9.1.13): the preflight and post-check blocks, the md5 gate, the rollback
// (apply -> rollback -> the catalog identical -> re-apply, and every refusal),
// and the application on the whole chain of migrations_v2 (the real legacy
// snapshot, every migration on main, then v81). Disposable databases only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb } from "./_gpexe-disposable-db.mjs";
import { calendarMigrations } from "./support/calendar-fixture.mjs";
import { createDisposableDatabase, dropDisposableDatabase } from "./support/disposable-db.mjs";
import { bootstrapLegacySnapshot } from "./support/legacy-bootstrap.mjs";
import { runMigrations } from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const MIGRATIONS = path.join(ROOT, "migrations_v2");
const V81 = "202611191000_calendar_v81_athlete_questions.sql";
const V81_SHA256 = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V81))).digest("hex");
const BEFORE = calendarMigrations().filter((x) => x !== V81);
const MD5 = {
  materializeBefore: "2d961f5acd6c6309baa51de868773ba4",
  materializeAfter: "ef7e1093ca427ba0bf2f2bab120ba14f",
  tlBefore: "8410bf7298d6b3d5e4aea6dfb94e1a18",
  tlAfter: "a700c67786e79af8c03aae0b2d4a5fc3",
  settingsBefore: "75ed99731f6d61d19a8f0c2e473fedd1",
  settingsAfter: "b4189ddb507e607263ee6cb89760a891",
};

// The calendar's and the Tests module's catalog (the schemas v81 touches).
const DIGEST_SQL = `
  select md5(string_agg(x, '|' order by x)) as d from (
    select 'col:' || table_schema || '.' || table_name || '.' || column_name || ':' || data_type || ':' || coalesce(column_default, '') || ':' || is_nullable as x
      from information_schema.columns where table_schema in ('calendar', 'tests', 'training_load', 'public')
    union all
    select 'func:' || n.nspname || '.' || p.proname || ':' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('calendar', 'tests', 'training_load', 'public') and p.prokind = 'f'
    union all
    select 'trg:' || n.nspname || '.' || c.relname || '.' || t.tgname || ':' || t.tgenabled::text || ':' || pg_get_triggerdef(t.oid)
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname in ('calendar', 'tests', 'training_load', 'public')
    union all
    select 'idx:' || schemaname || '.' || indexname || ':' || indexdef from pg_indexes where schemaname in ('calendar', 'tests', 'training_load', 'public')
    union all
    select 'con:' || n.nspname || '.' || cl.relname || '.' || co.conname || ':' || pg_get_constraintdef(co.oid)
      from pg_constraint co join pg_class cl on cl.oid = co.conrelid join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname in ('calendar', 'tests', 'training_load', 'public')
  ) s`;

async function runbookBlocks(client, file) {
  const text = await fsp.readFile(path.join(ROOT, "docs/runbooks", file), "utf8");
  const statements = text.split(/\r?\n/).filter((line) => !line.trim().startsWith("--")).join("\n")
    .split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const statement of statements) out.push((await client.query(statement)).rows);
  return out;
}
const md5Of = async (client, schema, name) => (await client.query(
  `select md5(p.prosrc) as m from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1 and p.proname = $2`, [schema, name],
)).rows[0]?.m;

test("1. the preflight on the database before v81, the apply, the post-check; the md5s of the two replaced bodies before and after", async () => {
  const db = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "k2b2mig", migrations: BEFORE });
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    assert.ok(!BEFORE.some((f) => /_v7[89]_|_v80_/.test(f)), "this chain has no v78-v80 (v81 depends on none of them)");
    const pre = await runbookBlocks(client, "calendar-questions-v81-preflight.sql");
    assert.equal(pre[0][0].pg15_or_later, true, "block 1");
    const deps = pre[1][0];
    for (const [k, v] of Object.entries(deps)) if (k !== "v81_rows") assert.equal(v, true, `block 2 ${k}`);
    assert.equal(Number(deps.v81_rows), 0);
    assert.deepEqual(pre[2][0], { materialize_md5: MD5.materializeBefore, settings_changes_md5: MD5.settingsBefore, lock_event_writer_md5: "7ebf1bcf39cbb930fb913d89f25fd406", tl_materialize_md5: MD5.tlBefore }, "block 3");
    assert.deepEqual(Object.values(pre[3][0]).map(Number), [0, 0, 0], "block 4");
    assert.ok(Object.values(pre[4][0]).every((v) => v === true), `block 5 ${JSON.stringify(pre[4][0])}`);
    assert.ok("idle_in_transaction" in pre[5][0], "block 6 runs");
    assert.ok(Array.isArray(pre[6]), "block 7 runs");

    await applyGpexeTestMigrations(db.url, [V81]);
    const post = await runbookBlocks(client, "calendar-questions-v81-postcheck.sql");
    assert.equal(Number(post[0][0].v81_rows), 1, "block 1");
    assert.equal(post[0][0].v81_checksum, V81_SHA256);
    assert.deepEqual(
      [post[1][0].v81_tables, post[1][0].v81_columns, post[1][0].v81_functions, post[1][0].v81_triggers, post[1][0].disabled, post[1][0].switch_index, post[1][0].rpe_link_trigger].map(Number),
      [4, 3, 17, 14, 0, 1, 1], "block 2",
    );
    assert.deepEqual(post[2][0], { materialize_md5: MD5.materializeAfter, settings_changes_md5: MD5.settingsAfter, tl_materialize_md5: MD5.tlAfter }, "block 3");
    assert.deepEqual(Object.values(post[3][0]).map(Number), [0, 0, 0, 0, 0, 0], "block 4");
    assert.ok("lock_waits" in post[4][0], "block 5 runs");
  } finally {
    await client.end().catch(() => {});
    await db.drop();
  }
});

test("2. the md5 gate: a changed body refuses v81 with nothing applied", async () => {
  const db = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "k2b2gate", migrations: BEFORE });
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    const original = (await client.query(`select pg_get_functiondef('tests.materialize_test_assignments_for_occurrence(uuid)'::regprocedure) as d`)).rows[0].d;
    await client.query(original.replace("begin\n", "begin\n  -- changed\n"));
    assert.notEqual(await md5Of(client, "tests", "materialize_test_assignments_for_occurrence"), MD5.materializeBefore);
    await assert.rejects(applyGpexeTestMigrations(db.url, [V81]), (e) => /is not the phase-4 body/.test(String(e?.cause?.message ?? e?.message)));
    assert.equal((await client.query(`select to_regclass('calendar.event_questions') as t`)).rows[0].t, null, "nothing of v81 applied");
    await client.query(original);
    const settings = (await client.query(`select pg_get_functiondef('calendar.settings_changes_before_insert()'::regprocedure) as d`)).rows[0].d;
    await client.query(settings.replace("begin\n", "begin\n  -- changed\n"));
    await assert.rejects(applyGpexeTestMigrations(db.url, [V81]), (e) => /is not the v51 body/.test(String(e?.cause?.message ?? e?.message)));
    assert.equal((await client.query(`select to_regclass('calendar.event_questions') as t`)).rows[0].t, null);
    await client.query(settings);
    // Round 1b: the Training Load v4 body is gated too.
    const tlDef = (await client.query(`select pg_get_functiondef('training_load.materialize_external_assignments_for_occurrence(uuid)'::regprocedure) as d`)).rows[0].d;
    await client.query(tlDef.replace("begin\n", "begin\n  -- changed\n"));
    await assert.rejects(applyGpexeTestMigrations(db.url, [V81]), (e) => /is not the v4 body/.test(String(e?.cause?.message ?? e?.message)));
    assert.equal((await client.query(`select to_regclass('calendar.event_questions') as t`)).rows[0].t, null);
    await client.query(tlDef);
    // A dependency recorded with another checksum (review round 1, db L1).
    const dep = "migrations_v2/202609020900_training_load_v7_external_schedule_notification_rules.sql";
    const saved = (await client.query(`select checksum from public.schema_migrations where migration_name = $1`, [dep])).rows[0].checksum;
    await client.query(`update public.schema_migrations set checksum = $2 where migration_name = $1`, [dep, "0".repeat(64)]);
    await assert.rejects(applyGpexeTestMigrations(db.url, [V81]), (e) => /dependency is not recorded with its checksum/.test(String(e?.cause?.message ?? e?.message)));
    assert.equal((await client.query(`select to_regclass('calendar.event_questions') as t`)).rows[0].t, null);
    await client.query(`update public.schema_migrations set checksum = $2 where migration_name = $1`, [dep, saved]);
  } finally {
    await client.end().catch(() => {});
    await db.drop();
  }
});

test("3. the rollback: refused without v81; apply -> rollback -> the catalog identical -> re-apply; each refusal leaves v81 in place; a later training_load migration does not stop it", async () => {
  const db = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "k2b2rb", migrations: BEFORE });
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  const rollback = await fsp.readFile(path.join(ROOT, "docs/runbooks/calendar-questions-v81-rollback.sql"), "utf8");
  const refused = async (label, re) => {
    await assert.rejects(client.query(rollback), (e) => re.test(e.message), label);
    await client.query("rollback").catch(() => {});
    assert.ok((await client.query(`select to_regclass('calendar.event_questions') as t`)).rows[0].t, `${label}: nothing dropped`);
  };
  try {
    await assert.rejects(client.query(rollback), /v81 is not recorded/);
    await client.query("rollback").catch(() => {});
    const digestBefore = (await client.query(DIGEST_SQL)).rows[0].d;
    await applyGpexeTestMigrations(db.url, [V81]);
    assert.notEqual((await client.query(DIGEST_SQL)).rows[0].d, digestBefore);
    await client.query(rollback);
    assert.equal((await client.query(`select to_regclass('calendar.event_questions') as t`)).rows[0].t, null);
    assert.equal((await client.query(DIGEST_SQL)).rows[0].d, digestBefore, "the catalog is exactly the one before v81 (columns, constraints, bodies, triggers, indexes)");
    assert.equal(await md5Of(client, "tests", "materialize_test_assignments_for_occurrence"), MD5.materializeBefore);
    assert.equal(await md5Of(client, "calendar", "settings_changes_before_insert"), MD5.settingsBefore);
    assert.equal(await md5Of(client, "training_load", "materialize_external_assignments_for_occurrence"), MD5.tlBefore);
    await applyGpexeTestMigrations(db.url, [V81]);
    assert.ok((await client.query(`select to_regclass('calendar.event_questions') as t`)).rows[0].t, "re-applied");

    const later = async (name, fn) => {
      await client.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ($1, $2, 'test')`, [`migrations_v2/${name}`, "f".repeat(64)]);
      try { await fn(); } finally { await client.query(`delete from public.schema_migrations where migration_name = $1`, [`migrations_v2/${name}`]); }
    };
    await later("209912311000_calendar_later_test_only.sql", () => refused("a later calendar migration", /later calendar \/ tests migration/));
    await later("209912311000_tests_later_test_only.sql", () => refused("a later tests migration", /later calendar \/ tests migration/));
    // A changed body (a later migration touched it): refused.
    const body = (await client.query(`select pg_get_functiondef('tests.materialize_test_assignments_for_occurrence(uuid)'::regprocedure) as d`)).rows[0].d;
    await client.query(body.replace("begin\n", "begin\n  -- later\n"));
    await refused("a changed body", /not v81's body/);
    await client.query(body);
    // The Training Load body changed since (round 1b).
    const tlBody = (await client.query(`select pg_get_functiondef('training_load.materialize_external_assignments_for_occurrence(uuid)'::regprocedure) as d`)).rows[0].d;
    await client.query(tlBody.replace("begin\n", "begin\n  -- later\n"));
    await refused("a changed training_load body", /materialize_external_assignments_for_occurrence is not v81's body/);
    await client.query(tlBody);
    // lock_event_writer changed since (review round 1, db L3).
    const writer = (await client.query(`select pg_get_functiondef('calendar.lock_event_writer(uuid, character varying, uuid, character varying)'::regprocedure) as d`)).rows[0].d;
    await client.query(writer.replace("begin\n", "begin\n  -- later\n"));
    await refused("a changed lock_event_writer", /lock_event_writer is not the body/);
    await client.query(writer);
    // A calendar migration whose name sorts before v81 but was applied after it.
    await client.query(`insert into public.schema_migrations (migration_name, checksum, runner_version, applied_at) values ('migrations_v2/202601010000_calendar_applied_late_test_only.sql', $1, 'test', now() + interval '1 minute')`, ["f".repeat(64)]);
    await refused("applied after v81", /later calendar \/ tests migration/);
    await client.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/202601010000_calendar_applied_late_test_only.sql'`);
    // A row that depends on v81.
    const clubId = (await client.query(`insert into public.clubs (name) values ('rb club') returning id`)).rows[0].id;
    await client.query(`alter table calendar.club_question_settings disable trigger club_question_settings_need_change`);
    const user = (await client.query(`insert into public.users (email, full_name, display_name) values ('rb@test.local', 'Rb', 'Rb') returning id`)).rows[0].id;
    await client.query(`insert into calendar.club_question_settings (club_id, enabled, reason, updated_by_user_id) values ($1, true, 'x', $2)`, [clubId, user]);
    await client.query(`alter table calendar.club_question_settings enable trigger club_question_settings_need_change`);
    await refused("a row that depends on v81", /depend on v81/);
    await client.query(`alter table calendar.club_question_settings disable trigger user`);
    await client.query(`delete from calendar.club_question_settings`);
    await client.query(`alter table calendar.club_question_settings enable trigger user`);
    const holder = new pg.Client({ connectionString: db.url });
    await holder.connect();
    try {
      await holder.query(`select pg_advisory_lock(822026)`);
      await refused("the migrator's lock", /migrator holds its lock/);
    } finally {
      await holder.end();
    }
    // A later migration of another part (not calendar / tests) does not stop it.
    await client.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912311000_training_load_vx_test_only.sql', $1, 'test')`, ["f".repeat(64)]);
    await client.query(rollback);
    assert.equal((await client.query(DIGEST_SQL)).rows[0].d, digestBefore, "and once more after the refusals");
  } finally {
    await client.end().catch(() => {});
    await db.drop();
  }
});

test("4. the whole chain: the real legacy snapshot, every migration of migrations_v2 on this branch (v81 included, v78-v80 absent), and the post-check", async () => {
  const snapshotSql = fs.readFileSync(path.join(__dirname, "support/legacy-schema.sql"), "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  const db = await createDisposableDatabase({ prefix: "calendar", label: "k2b2_chain", baseDatabaseUrl: process.env.DATABASE_URL });
  try {
    await bootstrapLegacySnapshot({ databaseUrl: db.url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
    await runMigrations({ databaseUrl: db.url, migrationsRoot: MIGRATIONS });
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      const recorded = (await client.query(`select migration_name from public.schema_migrations where migration_name like 'migrations_v2/%' order by 1`)).rows.map((r) => r.migration_name.replace("migrations_v2/", ""));
      const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{12}_.*\.sql$/.test(f)).sort();
      assert.deepEqual(recorded, files, "every file applied, v81 included");
      assert.ok(!files.some((f) => /_v7[89]_|_v80_/.test(f)), "v78-v80 are not on this branch");
      const post = await runbookBlocks(client, "calendar-questions-v81-postcheck.sql");
      assert.equal(post[0][0].v81_checksum, V81_SHA256);
      assert.deepEqual(post[2][0], { materialize_md5: MD5.materializeAfter, settings_changes_md5: MD5.settingsAfter, tl_materialize_md5: MD5.tlAfter });
      assert.deepEqual(Object.values(post[3][0]).map(Number), [0, 0, 0, 0, 0, 0]);
    } finally {
      await client.end();
    }
  } finally {
    await dropDisposableDatabase({ name: db.name, adminUrl: db.adminUrl, baseDatabaseUrl: process.env.DATABASE_URL });
  }
});

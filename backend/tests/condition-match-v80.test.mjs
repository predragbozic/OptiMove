// v80 step B (docs/ai/v80-condition-match-plan.md; the Rukovodilac's GO of 2026-11-19): the migration itself. On disposable
// optimove_tests_* databases only (never OPTIMOVE): one migrated through v79 rehearses v80's preflight / apply / post-check /
// rollback / re-apply, the rollback's refusals and v80's own refusal to apply; one built from the legacy schema snapshot
// (the production dump's structure) and every migration before v80 rehearses apply / rollback / re-apply there too; one
// migrated through v80 carries the database guards (any writer): a version's condition rule, an activation's match, the
// owner's confirmation of an event setting. The services, the board and the importer are condition-match-v80-unit.test.mjs
// and tests 25-31 of source-metric-board-18-2.test.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { createDisposableDatabase, dropDisposableDatabase } from "./support/disposable-db.mjs";
import { bootstrapLegacySnapshot } from "./support/legacy-bootstrap.mjs";
import { ensureMappedSystem, mappedBinding, platformAdmin } from "./support/mapped-world.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const MIGRATIONS = path.resolve(ROOT, "migrations_v2");
const V80 = "202611201100_training_load_v80_condition_match.sql";
const V80_NAME = `migrations_v2/${V80}`;
const UP_TO_PREV = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V80));
const RUNBOOK = (f) => path.resolve(ROOT, "docs/runbooks", f);
const ROLLBACK_PATH = RUNBOOK("condition-match-v80-rollback.sql");
const PREFLIGHT_PATH = RUNBOOK("condition-match-v80-preflight.sql");
const POSTCHECK_PATH = RUNBOOK("condition-match-v80-postcheck.sql");
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;

let rdb, db, r, k, pa, world, mapped;
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];

// The migrations up to `last` (inclusive) in a folder of their own, applied by the real runner.
async function applyUpTo(url, files) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v80-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of files) await fsp.copyFile(path.resolve(MIGRATIONS, f), path.join(dir, f));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}
async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    columns: await rows(c, `select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ${S} order by 1, 2, 3`),
    tables: (await rows(c, `select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ${S} and c.relkind in ('r', 'i') order by 1`)).map((x) => x.t),
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest, obj_description(p.oid, 'pg_proc') as comment from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    comments: await rows(c, `select c.relname, a.attname, col_description(c.oid, a.attnum) as comment from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'training_load' and a.attnum > 0 and not a.attisdropped and col_description(c.oid, a.attnum) is not null order by 1, 2`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
async function runbook(c, file) {
  const text = (await fsp.readFile(file, "utf8")).split("\n").filter((line) => !line.startsWith("--")).join("\n");
  const out = [];
  for (const statement of text.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) out.push(...(await c.query(statement)).rows);
  return out;
}
// Every boolean true, and every count of something v80 adds 0.
const ZEROES = ["kind_none_on_conditioned", "versions_with_rule", "matched_activations", "event_setting_confirmations"];
function allOk(blocks) {
  for (const row of blocks) {
    for (const [col, v] of Object.entries(row)) {
      if (typeof v === "boolean") assert.equal(v, true, `${col} in ${JSON.stringify(row)}`);
      if (ZEROES.includes(col)) assert.equal(Number(v), 0, `${col} in ${JSON.stringify(row)}`);
    }
  }
}
// A raw system variable with a condition: a definition with its levels and version 1.
async function conditioned(c, condition) {
  const d = (await one(c, `insert into training_load.metric_definitions (key, label, owner_scope) values ($1, $1, 'system') returning id`, [`v80_${uid()}`])).id;
  for (const level of ["session", "component"]) await c.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, $2)`, [d, level]);
  const v = (await one(c, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, condition_description)
    values ($1, 1, $2, 'numeric', 'sum', $3::jsonb) returning id`, [d, condition.unit === "m/s2" ? "count" : "m", JSON.stringify(condition)])).id;
  await c.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [v, d]);
  return { definitionId: d, versionId: v };
}
const ZONE3 = { operator: "between", min: 25, max: 60, unit: "W/kg" };
const ACC = { operator: ">=", value: 2.5, duration_seconds: 0.3, unit: "m/s2" };

// One write under v80's own trigger only: every other trigger and every foreign key off (replica role), v80's set to fire
// always - so the test reaches exactly v80's guard, with rows copied from real ones. Rolled back.
async function underGuard(c, tables, fn) {
  await c.query("begin");
  try {
    for (const [table, trigger] of tables) await c.query(`alter table training_load.${table} enable always trigger ${trigger}`);
    await c.query("set local session_replication_role = replica");
    const out = await fn();
    return { ok: true, out };
  } catch (error) {
    return { ok: false, error };
  } finally {
    await c.query("rollback").catch(() => {});
  }
}
// A copy of a row with some columns replaced (generated columns left to the database); an override is cast to its column's type.
async function copyRow(c, table, id, overrides) {
  const cols = await rows(c, `select column_name as name, udt_name as type from information_schema.columns where table_schema = 'training_load' and table_name = $1 and is_generated = 'NEVER' and column_name <> 'id' order by ordinal_position`, [table]);
  const names = Object.keys(overrides).filter((n) => overrides[n] !== undefined);
  const select = cols.map((col) => (names.includes(col.name) ? `$${names.indexOf(col.name) + 2}::${col.type}` : `"${col.name}"`));
  return one(c, `insert into training_load.${table} (${cols.map((x) => `"${x.name}"`).join(", ")}) select ${select.join(", ")} from training_load.${table} where id = $1 returning id`,
    [id, ...names.map((n) => (overrides[n] !== null && typeof overrides[n] === "object" ? JSON.stringify(overrides[n]) : overrides[n]))]);
}
function accepted(res, label = "") {
  assert.equal(res.ok, true, `${label}: ${res.error?.message}`);
}
function refused(res, code, pattern) {
  assert.equal(res.ok, false, `expected a refusal: ${pattern}`);
  assert.equal(res.error.code, code, res.error.message);
  assert.match(res.error.message, pattern);
}

before(async () => {
  // Later migrations may follow v80; the rehearsal database stops before v80 and applies the files up to v80 only.
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V80), "v80 is a test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v80rb", migrations: UP_TO_PREV }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "cond80" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  for (const c of [r, k]) await c.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  process.env.DATABASE_URL = db.url;
  pa = await platformAdmin(k);
  world = await ensureMappedSystem(k, { platformAdminId: pa });
  const clubId = (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`v80 club ${uid()}`])).id;
  const teamId = (await one(k, `insert into public.teams (club_id, name) values ($1, $2) returning id`, [clubId, `v80 team ${uid()}`])).id;
  mapped = await mappedBinding(k, { teamId, clubId, sourceTeamId: "980", by: pa, only: ["gpexe_time_min"] });
});

after(async () => {
  try {
    const { pool } = await import("../src/db.js");
    await pool.end().catch(() => {});
  } finally {
    for (const c of [r, k]) await c?.end().catch(() => {});
    await rdb?.drop();
    await db?.drop();
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
});

test("1. v80 on a database through v79: the preflight passes, it applies, the post-check passes, the rollback restores the catalog before v80 exactly, and it applies again", async () => {
  allOk(await runbook(r, PREFLIGHT_PATH));
  const before = await catalog(r);
  await applyUpTo(rdb.url, [...UP_TO_PREV, V80]);
  const post = await runbook(r, POSTCHECK_PATH);
  allOk(post);
  const sha = crypto.createHash("sha256").update(await fsp.readFile(path.resolve(MIGRATIONS, V80))).digest("hex");
  assert.equal(post[0].checksum, sha, "the recorded checksum is the file's sha256");
  await r.query(await fsp.readFile(ROLLBACK_PATH, "utf8"));
  assert.deepEqual(await catalog(r), before, "the rollback restores the catalog before v80 exactly (columns, tables, triggers, functions, constraints, comments)");
  await applyUpTo(rdb.url, [...UP_TO_PREV, V80]);
  allOk(await runbook(r, POSTCHECK_PATH));
});

test("2. the rollback refuses, changing nothing, without v80, while the migrator runs, and once a rule, a match or a confirmation exists", async () => {
  // rdb is at v80 (test 1 re-applied it).
  const atStart = await catalog(r);
  const holder = new pg.Client({ connectionString: rdb.url });
  await holder.connect();
  try {
    await holder.query(`select pg_advisory_lock(822026)`);
    await assert.rejects(r.query(await fsp.readFile(ROLLBACK_PATH, "utf8")), /v80 rollback refused: the migrator is running/);
    await r.query("rollback").catch(() => {});
  } finally {
    await holder.end();
  }
  // A confirmation of an event setting, planted raw (every trigger off): refused, changing nothing. (A rule and a match are
  // test 3, on the database that carries versions and activations.)
  const field = await one(r, `select d.id as field_id, v.id as revision_id from training_load.source_metric_definitions d join training_load.source_metric_definition_versions v on v.source_metric_definition_id = d.id limit 1`);
  const user = (await one(r, `insert into public.users (email, full_name, display_name) values ($1, 'x', 'x') returning id`, [`v80-${uid()}@test.local`])).id;
  await r.query("begin");
  await r.query("set local session_replication_role = replica");
  await r.query(`insert into training_load.source_metric_event_setting_confirmations (source_metric_definition_id, source_metric_version_id, event_kind, threshold_value, duration_seconds,
    observation_confirmation_id, threshold_set_id, confirmed_by_user_id, request_key, request_hash) values ($1, $2, 'acceleration', 2.5, 0.3, $3, '1473', $4, $5, $6)`,
  [field.field_id, field.revision_id, crypto.randomUUID(), user, crypto.randomUUID(), "a".repeat(64)]);
  await r.query("commit");
  const withRow = await catalog(r);
  await assert.rejects(r.query(await fsp.readFile(ROLLBACK_PATH, "utf8")), /a confirmation of an event setting exists/);
  await r.query("rollback").catch(() => {});
  assert.deepEqual(await catalog(r), withRow, "the refused rollback changed nothing");
  await r.query("begin");
  await r.query("set local session_replication_role = replica");
  await r.query(`delete from training_load.source_metric_event_setting_confirmations`);
  await r.query("commit");
  assert.deepEqual(await catalog(r), atStart);
  // Any later migration whose name contains training_load recorded - a made-up Metrics Core one and the real name of the
  // calendar's v83 - is refused, nothing changed (v80 is forward-only once v83 is applied); a later name without
  // training_load does not stop it (the Independent's MEDIUM-1 on PR #661).
  const later = (name) => r.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ($1, $2, 'test')`, [name, "f".repeat(64)]);
  const unrecord = (name) => r.query(`delete from public.schema_migrations where migration_name = $1`, [name]);
  await later("migrations_v2/209912311000_training_load_vx_test_only.sql");
  const withLater = await catalog(r);
  await assert.rejects(r.query(await fsp.readFile(ROLLBACK_PATH, "utf8")), /v80 rollback refused: a later training_load migration is recorded/);
  await r.query("rollback").catch(() => {});
  assert.deepEqual(await catalog(r), withLater, "the refused rollback changed nothing");
  await unrecord("migrations_v2/209912311000_training_load_vx_test_only.sql");
  const V83_REAL = "migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql";
  await later(V83_REAL);
  const withV83 = await catalog(r);
  await assert.rejects(r.query(await fsp.readFile(ROLLBACK_PATH, "utf8")), /v80 rollback refused: a later training_load migration is recorded/);
  await r.query("rollback").catch(() => {});
  assert.deepEqual(await catalog(r), withV83, "the refused rollback changed nothing");
  await unrecord(V83_REAL);
  await later("migrations_v2/209912311000_calendar_vx_test_only.sql");
  // Without v80 recorded: refused.
  await r.query(await fsp.readFile(ROLLBACK_PATH, "utf8"));
  await assert.rejects(r.query(await fsp.readFile(ROLLBACK_PATH, "utf8")), /v80 is not recorded/);
  await r.query("rollback").catch(() => {});
  await unrecord("migrations_v2/209912311000_calendar_vx_test_only.sql");
  await applyUpTo(rdb.url, [...UP_TO_PREV, V80]);
});

test("3. the rollback refuses on the mapped database once a version carries a rule or an activation records a match", async () => {
  for (const [label, table, set, pattern] of [
    ["a rule", "source_metric_mapping_versions", `condition_rule = '{"kind":"zone","family":"power","zone":3}'::jsonb`, /a mapping version carries a condition rule/],
    ["a match", "source_metric_mapping_activations", `matched_at = now()`, /an activation records a match/],
  ]) {
    const before = await catalog(k);
    await k.query("begin");
    try {
      await k.query("set local session_replication_role = replica");
      // The mapped database carries every test migration; a later training_load migration (v85 on) makes the rollback
      // refuse first for that reason, which is right but not what this test checks. Inside this rolled-back transaction
      // the later ones are unrecorded, so v80's own refusals are the ones reached.
      await k.query(`delete from public.schema_migrations where migration_name > $1 and migration_name like '%training_load%'`, [`migrations_v2/${V80}`]);
      await k.query(`update training_load.${table} set ${set} where id = (select id from training_load.${table} order by id limit 1)`);
      await assert.rejects(k.query((await fsp.readFile(ROLLBACK_PATH, "utf8")).replace(/^begin;$/m, "savepoint v80_rb;").replace(/^commit;$/m, "release savepoint v80_rb;")), pattern, label);
    } finally {
      await k.query("rollback").catch(() => {});
    }
    assert.deepEqual(await catalog(k), before, `${label}: nothing changed`);
  }
});

test("4. v80 refuses to apply, changing nothing, when a version without parameters already targets a variable version with a condition", async () => {
  const fresh = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v80pre", migrations: UP_TO_PREV });
  const c = new pg.Client({ connectionString: fresh.url });
  await c.connect();
  try {
    assert.match(fresh.name, DISPOSABLE_DB_NAME_PATTERN);
    const target = await conditioned(c, ZONE3);
    // Planted (the service never writes one): a version without parameters on that variable version, every trigger and
    // foreign key off.
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    const rnd = () => crypto.randomUUID();
    await c.query(`insert into training_load.source_metric_mapping_versions
        (mapping_id, source_metric_definition_id, metric_definition_id, source_metric_version_id, version_number, metric_definition_version_id,
         conversion_kind, scale, scale_divisor, "offset", source_unit, target_unit, parameter_kind, source_parameters, canonical_parameters,
         parameter_scale, parameter_scale_divisor, parameter_offset, applies_to_session, applies_to_drill, created_by_user_id, owner_key, parameter_fingerprint)
       values ($1, $2, $3, $4, 1, $5, 'numeric_linear', 1, 1, 0, 'm', 'm', 'none', '{}'::jsonb, '{}'::jsonb, 1, 1, 0, true, false, $6, 'system', $7)`,
    [rnd(), rnd(), target.definitionId, rnd(), target.versionId, rnd(), ""]);
    await c.query("commit");
    const before = await catalog(c);
    // The runner names the file and the SQLSTATE; the migration's own message ("v80 refused: a mapping version without
    // parameters already targets a variable version with a condition") is in its log line.
    await assert.rejects(applyUpTo(fresh.url, [...UP_TO_PREV, V80]), /ABORT while applying "migrations_v2\/202611201100_training_load_v80_condition_match.sql" \(SQLSTATE 23514\)/);
    assert.deepEqual(await catalog(c), before, "nothing of v80 was applied");
    assert.equal(Number((await runbook(c, PREFLIGHT_PATH)).find((x) => "kind_none_on_conditioned" in x).kind_none_on_conditioned), 1, "the preflight names it");
  } finally {
    await c.end().catch(() => {});
    await fresh.drop();
  }
});

test("5. the legacy schema snapshot (the production dump's structure) and every migration before v80: v80 applies, the rollback restores that catalog exactly, and it applies again", async () => {
  const snapshotSql = fs.readFileSync(path.join(__dirname, "support/legacy-schema.sql"), "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  // The repository's migrations up to v80 (later ones, of any track, are left out: this rehearsal is v80's own).
  const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{12}_.*\.sql$/.test(f)).sort();
  assert.ok(files.includes(V80), "v80 is a migration of the repository");
  const all = files.slice(0, files.indexOf(V80) + 1);
  const before80 = all.slice(0, -1);
  const legacy = await createDisposableDatabase({ prefix: "gpexe", label: "v80_legacy", baseDatabaseUrl: ORIGINAL_DATABASE_URL });
  const c = new pg.Client({ connectionString: legacy.url });
  try {
    await bootstrapLegacySnapshot({ databaseUrl: legacy.url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
    await applyUpTo(legacy.url, before80);
    await c.connect();
    allOk(await runbook(c, PREFLIGHT_PATH));
    const before = await catalog(c);
    await applyUpTo(legacy.url, all);
    allOk(await runbook(c, POSTCHECK_PATH));
    await c.query(await fsp.readFile(ROLLBACK_PATH, "utf8"));
    assert.deepEqual(await catalog(c), before, "the rollback restores the legacy-built catalog exactly");
    await applyUpTo(legacy.url, all);
    allOk(await runbook(c, POSTCHECK_PATH));
  } finally {
    await c.end().catch(() => {});
    await dropDisposableDatabase({ name: legacy.name, adminUrl: legacy.adminUrl, baseDatabaseUrl: ORIGINAL_DATABASE_URL });
  }
});

test("6. a version (any writer): without parameters on a variable with a condition only with a fitting rule; a rule only there; the rule written once", async () => {
  const source = world.gpexe_time_min.versionId; // a version without parameters on a variable without a condition
  const zone = await conditioned(k, ZONE3);
  const acc = await conditioned(k, ACC);
  const V = [["source_metric_mapping_versions", "source_metric_mapping_versions_condition_guard"]];
  const insert = (target, rule) => underGuard(k, V, () => copyRow(k, "source_metric_mapping_versions", source, {
    metric_definition_id: target.definitionId, metric_definition_version_id: target.versionId, version_number: 900 + Math.floor(Math.random() * 99), mapping_id: crypto.randomUUID(), source_metric_definition_id: crypto.randomUUID(), condition_rule: rule,
  }));
  refused(await insert(zone, null), "23514", /only through a fitting condition rule/);
  refused(await insert(zone, { kind: "event", event: "acceleration" }), "23514", /only through a fitting condition rule/);
  refused(await insert(acc, { kind: "event", event: "deceleration" }), "23514", /only through a fitting condition rule/);
  refused(await insert(acc, { kind: "zone", family: "power", zone: 3 }), "23514", /only through a fitting condition rule/);
  for (const bad of [{ kind: "zone", family: "power", zone: 0 }, { kind: "zone", family: "heart", zone: 3 }, { kind: "zone", family: "power", zone: "3" },
    { kind: "zone", family: "power", zone: 3, extra: 1 }, { kind: "event", event: "speed" }, { kind: "other" }, []]) {
    refused(await insert(zone, bad), "23514", /only through a fitting condition rule/);
  }
  accepted(await insert(zone, { kind: "zone", family: "power", zone: 3 }), "a zone rule on a zone condition");
  accepted(await insert(acc, { kind: "event", event: "acceleration" }), "an acceleration rule on a '>=' event condition");
  // A rule on a version whose variable has no condition.
  const plainTarget = await one(k, `select metric_definition_id as "definitionId", metric_definition_version_id as "versionId" from training_load.source_metric_mapping_versions where id = $1`, [source]);
  refused(await insert(plainTarget, { kind: "zone", family: "power", zone: 3 }), "23514", /only for a field without parameters on a variable with a condition/);
  // A version with parameters on a conditioned variable takes no rule (its own parameters say its range, v34).
  const zoneField = world.gpexe_power_zone_25_60_distance.versionId;
  const withParams = (rule) => underGuard(k, V, () => copyRow(k, "source_metric_mapping_versions", zoneField, {
    metric_definition_id: zone.definitionId, metric_definition_version_id: zone.versionId, version_number: 950, mapping_id: crypto.randomUUID(), source_metric_definition_id: crypto.randomUUID(), condition_rule: rule,
  }));
  accepted(await withParams(null));
  refused(await withParams({ kind: "zone", family: "power", zone: 3 }), "23514", /only for a field without parameters/);
  // Written once.
  const updated = await underGuard(k, V, async () => {
    const { id } = await copyRow(k, "source_metric_mapping_versions", source, {
      metric_definition_id: zone.definitionId, metric_definition_version_id: zone.versionId, version_number: 960, mapping_id: crypto.randomUUID(), source_metric_definition_id: crypto.randomUUID(), condition_rule: { family: "power", kind: "zone", zone: 3 },
    });
    await k.query(`update training_load.source_metric_mapping_versions set condition_rule = '{"family":"power","kind":"zone","zone":4}' where id = $1`, [id]);
  });
  refused(updated, "23514", /a version's condition rule is written once/);
  const sameAgain = await underGuard(k, V, async () => {
    const { id } = await copyRow(k, "source_metric_mapping_versions", source, {
      metric_definition_id: zone.definitionId, metric_definition_version_id: zone.versionId, version_number: 961, mapping_id: crypto.randomUUID(), source_metric_definition_id: crypto.randomUUID(), condition_rule: { family: "power", kind: "zone", zone: 3 },
    });
    await k.query(`update training_load.source_metric_mapping_versions set conversion_note = 'Another note.' where id = $1`, [id]);
  });
  accepted(sameAgain, "another column may change; the rule stays");
});

test("7. an activation (any writer): of a version with a rule, the match in full and the variable's own condition; of any other, no match; the match written once", async () => {
  const zone = await conditioned(k, ZONE3);
  const source = world.gpexe_time_min.versionId;
  const activation = (await one(k, `select id from training_load.source_metric_mapping_activations where mapping_version_id = $1 order by id limit 1`, [source])).id;
  const G = [["source_metric_mapping_versions", "source_metric_mapping_versions_condition_guard"], ["source_metric_mapping_activations", "source_metric_mapping_activations_match_guard"]];
  const RANGE = { max: "60", min: "25", operator: "between", unit: "W/kg" };
  const full = { matched_condition: ZONE3, matched_source_range: RANGE, matched_threshold_set_id: "1473", matched_at: new Date().toISOString() };
  const startOn = (match, { ruled = true } = {}) => underGuard(k, G, async () => {
    const { id: versionId } = ruled ? await copyRow(k, "source_metric_mapping_versions", source, {
      metric_definition_id: zone.definitionId, metric_definition_version_id: zone.versionId, version_number: 970, mapping_id: crypto.randomUUID(), source_metric_definition_id: crypto.randomUUID(), condition_rule: { family: "power", kind: "zone", zone: 3 },
    }) : { id: source };
    return copyRow(k, "source_metric_mapping_activations", activation, { mapping_version_id: versionId, source_team_binding_id: crypto.randomUUID(), metric_definition_id: ruled ? zone.definitionId : undefined, ...match });
  });
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const startClean = (match, opts) => startOn(clean(match), opts);
  accepted(await startClean(full), "the match in full");
  for (const missing of ["matched_condition", "matched_source_range", "matched_threshold_set_id", "matched_at"]) {
    refused(await startClean({ ...full, [missing]: null }), "23514", /records its match/);
  }
  refused(await startClean({ ...full, matched_condition: { ...ZONE3, max: 61 } }), "23514", /records its match/);
  refused(await startClean({ ...full, matched_source_range: [] }), "23514", /records its match/);
  refused(await startClean({ ...full, matched_threshold_set_id: " " }), "23514", /records its match/);
  refused(await startClean({ ...full, matched_threshold_set_id: "x".repeat(65) }), "23514", /records its match/);
  // An activation of a version without a rule records none.
  accepted(await startClean({ matched_condition: null, matched_source_range: null, matched_threshold_set_id: null, matched_at: null }, { ruled: false }));
  for (const one of ["matched_condition", "matched_source_range", "matched_threshold_set_id", "matched_at"]) {
    refused(await startClean({ matched_condition: null, matched_source_range: null, matched_threshold_set_id: null, matched_at: null, [one]: full[one] }, { ruled: false }), "23514", /only an activation of a version with a condition rule records a match/);
  }
  // Written once: another column may change (an end does), the match never.
  const written = (set) => underGuard(k, G, async () => {
    const { id: versionId } = await copyRow(k, "source_metric_mapping_versions", source, {
      metric_definition_id: zone.definitionId, metric_definition_version_id: zone.versionId, version_number: 971, mapping_id: crypto.randomUUID(), source_metric_definition_id: crypto.randomUUID(), condition_rule: { family: "power", kind: "zone", zone: 3 },
    });
    const { id } = await copyRow(k, "source_metric_mapping_activations", activation, { mapping_version_id: versionId, source_team_binding_id: crypto.randomUUID(), metric_definition_id: zone.definitionId, ...full });
    await k.query(`update training_load.source_metric_mapping_activations set ${set} where id = $1`, [id]);
  });
  accepted(await written(`reason = 'Another reason.'`), "another column");
  for (const set of [`matched_threshold_set_id = '1474'`, `matched_at = matched_at + interval '1 second'`, `matched_condition = null`,
    `matched_source_range = '{"max":"61","min":"25","operator":"between","unit":"W/kg"}'`]) {
    refused(await written(set), "23514", /a match is written once/);
  }
});

test("8. the owner's confirmation of an event setting (any writer): only by its acting user, an active platform administrator; the revision the field's own; never changed, removed or truncated", async () => {
  const field = await one(k, `select d.id as "fieldId", v.id as "revisionId" from training_load.source_metric_definitions d join training_load.source_metric_definition_versions v on v.source_metric_definition_id = d.id order by d.id limit 1`);
  const other = await one(k, `select v.id from training_load.source_metric_definition_versions v where v.source_metric_definition_id <> $1 limit 1`, [field.fieldId]);
  const plain = (await one(k, `insert into public.users (email, full_name, display_name) values ($1, 'x', 'x') returning id`, [`v80-plain-${uid()}@test.local`])).id;
  const C = [["source_metric_event_setting_confirmations", "source_metric_event_setting_confirmations_guard"]];
  const insert = ({ actor = pa, by = pa, revisionId = field.revisionId } = {}) => underGuard(k, C, async () => {
    if (actor) await k.query(CTX, [actor]);
    return one(k, `insert into training_load.source_metric_event_setting_confirmations (source_metric_definition_id, source_metric_version_id, event_kind, threshold_value, duration_seconds,
      observation_confirmation_id, threshold_set_id, confirmed_by_user_id, request_key, request_hash) values ($1, $2, 'acceleration', 2.5, 0.3, $3, '1473', $4, $5, $6) returning id`,
    [field.fieldId, revisionId, crypto.randomUUID(), by, crypto.randomUUID(), "a".repeat(64)]);
  });
  accepted(await insert());
  refused(await insert({ actor: null }), "42501", /no acting user/);
  refused(await insert({ by: plain }), "42501", /written by its acting user only/);
  refused(await insert({ actor: plain, by: plain }), "42501", /only an active platform administrator/);
  refused(await insert({ revisionId: other.id }), "23514", /the revision is not the field's/);
  for (const [label, sql] of [
    ["update", `update training_load.source_metric_event_setting_confirmations set threshold_value = 3`],
    ["delete", `delete from training_load.source_metric_event_setting_confirmations`],
  ]) {
    const res = await underGuard(k, C, async () => {
      await k.query(CTX, [pa]);
      await k.query(`insert into training_load.source_metric_event_setting_confirmations (source_metric_definition_id, source_metric_version_id, event_kind, threshold_value, duration_seconds,
        observation_confirmation_id, threshold_set_id, confirmed_by_user_id, request_key, request_hash) values ($1, $2, 'acceleration', 2.5, 0.3, $3, '1473', $4, $5, $6)`,
      [field.fieldId, field.revisionId, crypto.randomUUID(), pa, crypto.randomUUID(), "a".repeat(64)]);
      await k.query(sql);
    });
    refused(res, "23514", /never changed or removed/, label);
  }
  await k.query("begin");
  try {
    await assert.rejects(k.query(`truncate training_load.source_metric_event_setting_confirmations`), /never changed or removed/);
  } finally {
    await k.query("rollback");
  }
  // The column checks of the table itself.
  for (const [col, value] of [["event_kind", "speed"], ["duration_seconds", -1], ["threshold_set_id", " "], ["request_hash", "x"]]) {
    const res = await underGuard(k, C, async () => {
      await k.query(CTX, [pa]);
      await k.query(`insert into training_load.source_metric_event_setting_confirmations (source_metric_definition_id, source_metric_version_id, event_kind, threshold_value, duration_seconds,
        observation_confirmation_id, threshold_set_id, confirmed_by_user_id, request_key, request_hash) values ($1, $2, $3, 2.5, $4, $5, $6, $7, $8, $9)`,
      [field.fieldId, field.revisionId, col === "event_kind" ? value : "acceleration", col === "duration_seconds" ? value : 0.3, crypto.randomUUID(),
        col === "threshold_set_id" ? value : "1473", pa, crypto.randomUUID(), col === "request_hash" ? value : "a".repeat(64)]);
    });
    refused(res, "23514", /check/, col);
  }
});

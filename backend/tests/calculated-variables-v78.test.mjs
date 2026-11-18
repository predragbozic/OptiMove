// Calculated variables PR 2a (the owner's rule of 2026-11-18, "a sum adds only what can be added"; the Rukovodilac's decision A
// of the same day): migration v78, the database twins of the API's four rules. On disposable optimove_tests_gpexe_* databases
// only (never OPTIMOVE): one migrated through v77 that rehearses v78's preflight / apply / post-check / rollback / re-apply and
// its refusal over a stored violation, one migrated through v78 for the raw-write guards and the two races. The API's own
// refusals, with their sentences, are tests 7 and 16-19 of calculated-variables-v77.test.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V78 = "202611181100_training_load_v78_calculated_variables_additive.sql";
const V78_NAME = `migrations_v2/${V78}`;
const UP_TO_PREV = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V78));
const RUNBOOK = (f) => path.resolve(ROOT, "docs/runbooks", f);
const ROLLBACK_PATH = RUNBOOK("calculated-variables-v78-rollback.sql");
const PREFLIGHT_PATH = RUNBOOK("calculated-variables-v78-preflight.sql");
const POSTCHECK_PATH = RUNBOOK("calculated-variables-v78-postcheck.sql");

let rdb, db, r, k;
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];

async function applyV78(url) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v78-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of [...UP_TO_PREV, V78]) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}
async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest, obj_description(p.oid, 'pg_proc') as comment from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
async function runbook(c, file) {
  const text = (await fsp.readFile(file, "utf8")).split("\n").filter((line) => !line.startsWith("--")).join("\n");
  const out = [];
  for (const statement of text.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) out.push(...(await c.query(statement)).rows);
  return out;
}
// Every boolean true, and every count of a violation 0.
const VIOLATIONS = ["calculated_not_summed", "inputs_not_summed", "active_over_inactive"];
function allOk(blocks) {
  for (const row of blocks) {
    for (const [col, v] of Object.entries(row)) {
      if (typeof v === "boolean") assert.equal(v, true, `${col} in ${JSON.stringify(row)}`);
      if (VIOLATIONS.includes(col)) assert.equal(Number(v), 0, `${col} in ${JSON.stringify(row)}`);
    }
  }
}

// A raw variable: a definition with its levels and version 1 (a system one unless a club is named).
async function variable(c, { unit = "m", day = "sum", calculation = null, club = null, levels = ["session"] } = {}) {
  const d = (await one(c, `insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id) values ($1, $1, $2, $3) returning id`,
    [`v78_${uid()}`, club ? "club" : "system", club])).id;
  for (const level of levels) await c.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, $2)`, [d, level]);
  const v = (await one(c, `insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, calculation)
    values ($1, 1, $2, 'numeric', $3, $4) returning id`, [d, unit, day, calculation ? JSON.stringify(calculation) : null])).id;
  await c.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [v, d]);
  return d;
}
const sum = (...inputs) => ({ kind: "sum", inputs });
async function attempt(c, fn) {
  await c.query("begin");
  try {
    const out = await fn(c);
    await c.query("rollback");
    return { ok: true, out };
  } catch (error) {
    await c.query("rollback").catch(() => {});
    return { ok: false, error };
  }
}
function dbRefused(res, pattern) {
  assert.equal(res.ok, false, `expected a refusal: ${pattern}`);
  assert.equal(res.error.code, "23514", res.error.message);
  assert.match(res.error.message, pattern);
}

before(async () => {
  assert.equal(GPEXE_TEST_MIGRATIONS.at(-1), V78, "v78 is the last test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v78rb", migrations: UP_TO_PREV }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "calc78" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  for (const c of [r, k]) await c.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  assert.equal((await k.query(`select 1 from public.schema_migrations where migration_name = $1`, [V78_NAME])).rowCount, 1, "the behaviour database carries v78");
});

after(async () => {
  for (const c of [r, k]) await c?.end().catch(() => {});
  await rdb?.drop();
  await db?.drop();
});

test("1. v78 on a database through v77 (with a calculated variable over two summed inputs): the preflight passes, it applies, the post-check passes, the rollback restores v77's catalog exactly, and it applies again; over a stored violation the migration refuses and changes nothing", async () => {
  const a = await variable(r);
  const b = await variable(r);
  await variable(r, { calculation: sum(a, b) });
  allOk(await runbook(r, PREFLIGHT_PATH));
  const before = await catalog(r);
  await applyV78(rdb.url);
  allOk(await runbook(r, POSTCHECK_PATH));
  assert.equal((await one(r, `select count(*)::int n from public.schema_migrations where migration_name = $1`, [V78_NAME])).n, 1);
  await r.query(await fsp.readFile(ROLLBACK_PATH, "utf8"));
  assert.deepEqual(await catalog(r), before, "the rollback restores v77's catalog exactly (bodies, comments, triggers)");
  allOk(await runbook(r, PREFLIGHT_PATH));
  await applyV78(rdb.url);
  allOk(await runbook(r, POSTCHECK_PATH));
  // A later migration recorded: the rollback refuses and changes nothing.
  await r.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ('migrations_v2/209912312359_later.sql', $1, 0, 'test')`, ["0".repeat(64)]);
  const atRefusal = await catalog(r);
  await assert.rejects(r.query(await fsp.readFile(ROLLBACK_PATH, "utf8")), /v78 rollback refused: a later migration is recorded/);
  await r.query("rollback").catch(() => {});
  assert.deepEqual(await catalog(r), atRefusal, "the refused rollback changed nothing");
  await r.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/209912312359_later.sql'`);
  // Back to v77 and a stored violation (an input whose day rule is Highest, written while v77 allowed it): the preflight shows
  // it, and v78 refuses with nothing applied.
  await r.query(await fsp.readFile(ROLLBACK_PATH, "utf8"));
  const highest = await variable(r, { day: "max" });
  await variable(r, { calculation: sum(a, highest) });
  const counts = (await runbook(r, PREFLIGHT_PATH)).find((row) => "inputs_not_summed" in row);
  assert.equal(Number(counts.inputs_not_summed), 1);
  const atV77 = await catalog(r);
  // The migrator reports only the file and the SQLSTATE; the preflight's count above names the rule.
  await assert.rejects(applyV78(rdb.url), /ABORT while applying "migrations_v2\/202611181100_training_load_v78_calculated_variables_additive\.sql" \(SQLSTATE 23514\)/);
  assert.deepEqual(await catalog(r), atV77, "the refused migration applied nothing");
  // The migration's own refusal, run directly in a transaction, names the rule.
  await r.query("begin");
  await assert.rejects(r.query(await fsp.readFile(path.resolve(ROOT, "migrations_v2", V78), "utf8")), /v78 refused: an input of a calculated variable is not summed by day/);
  await r.query("rollback");
});

test("2. the raw-write guards (any writer, not only the API): a calculated version summed by day only, over inputs summed by day only; an input keeps Sum while used; an input of an active calculated variable is not archived; a calculated variable is restored only while its inputs are active", async () => {
  const a = await variable(k);
  const b = await variable(k);
  const highest = await variable(k, { day: "max" });
  const calc = await variable(k, { calculation: sum(a, b) });
  // The calculated version's own day rule.
  for (const day of ["avg", "max", "last", "none"]) {
    dbRefused(await attempt(k, (c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, calculation)
      values ($1, 2, 'm', 'numeric', $2, $3)`, [calc, day, JSON.stringify(sum(a, b))])), /calculated version's day rule is Sum/);
  }
  // An input not summed by day.
  dbRefused(await attempt(k, (c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, calculation)
    values ($1, 2, 'm', 'numeric', $2)`, [calc, JSON.stringify(sum(a, highest))])), /every input is added up by Sum/);
  // An input keeps Sum while used (a unit kept the same, so it is the day rule that refuses).
  for (const day of ["avg", "max", "last", "none"]) {
    dbRefused(await attempt(k, (c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method)
      values ($1, 2, 'm', 'numeric', $2)`, [a, day])), /adds up this variable; its day rule stays Sum/);
  }
  const keepsSum = await attempt(k, (c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method, max_value)
    values ($1, 2, 'm', 'numeric', 'sum', 100)`, [a]));
  assert.equal(keepsSum.ok, true, keepsSum.error?.message);
  // A variable no calculation uses may change its day rule.
  const free = await variable(k);
  const freeChange = await attempt(k, (c) => c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, daily_aggregation_method)
    values ($1, 2, 'm', 'numeric', 'max')`, [free]));
  assert.equal(freeChange.ok, true, freeChange.error?.message);
  // An input of an active calculated variable is not archived.
  dbRefused(await attempt(k, (c) => c.query(`update training_load.metric_definitions set state = 'archived' where id = $1`, [a])),
    /active calculated variable adds up this variable; it stays active/);
  // A calculated variable over an archived input is not restored (archived inputs written with the guard off, as a writer
  // before v78 could have left them).
  const x = await variable(k);
  const y = await variable(k);
  const c2 = await variable(k, { calculation: sum(x, y) });
  await k.query("begin");
  await k.query("set local session_replication_role = replica");
  await k.query(`update training_load.metric_definitions set state = 'archived' where id = any($1::uuid[])`, [[c2, x]]);
  await k.query("commit");
  dbRefused(await attempt(k, (c) => c.query(`update training_load.metric_definitions set state = 'active' where id = $1`, [c2])),
    /calculated variable is active only while every input is active/);
});

// Two concurrent transactions on their own connections.
async function client() {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  return c;
}
async function waitsForLock() {
  for (let i = 0; i < 100; i += 1) {
    if ((await one(k, `select count(*)::int n from pg_locks l join pg_stat_activity a on a.pid = l.pid
                        where not l.granted and l.locktype in ('tuple', 'transactionid') and a.datname = current_database()`)).n > 0) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}

test("3. the races (trigger 4): an archive of an input and a calculation being created over it wait for each other in both orders, and the second is refused; no active calculated variable is left over an archived input", async () => {
  const a = await client();
  const b = await client();
  try {
    // (i) The calculation first: it holds its inputs FOR SHARE; the archive waits, then sees it and is refused.
    const p = await variable(k);
    const q = await variable(k);
    const def = (await one(k, `insert into training_load.metric_definitions (key, label, owner_scope) values ($1, $1, 'system') returning id`, [`race_${uid()}`])).id;
    await k.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, 'session')`, [def]);
    await a.query("begin");
    await a.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, calculation) values ($1, 1, 'm', 'numeric', $2)`,
      [def, JSON.stringify(sum(p, q))]);
    await a.query(`update training_load.metric_definitions set current_version_id = (select id from training_load.metric_definition_versions where metric_definition_id = $1) where id = $1`, [def]);
    await b.query("begin");
    const archive = b.query(`update training_load.metric_definitions set state = 'archived' where id = $1`, [p]).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    assert.equal(await waitsForLock(), true, "the archive waits for the calculation");
    await a.query("commit");
    dbRefused(await archive, /active calculated variable adds up this variable; it stays active/);
    await b.query("rollback");
    // (ii) The archive first: it holds the input's row; the calculation waits, then sees an archived input and is refused.
    const s = await variable(k);
    const t = await variable(k);
    const def2 = (await one(k, `insert into training_load.metric_definitions (key, label, owner_scope) values ($1, $1, 'system') returning id`, [`race_${uid()}`])).id;
    await k.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, 'session')`, [def2]);
    await a.query("begin");
    // The archive side's own triggers are off (no actor exists here for v38's change record); what is tested is the version
    // guard of the waiting calculation. session_replication_role takes no table lock, so the wait is the input's row.
    await a.query("set local session_replication_role = replica");
    await a.query(`update training_load.metric_definitions set state = 'archived' where id = $1`, [s]);
    await b.query("begin");
    const creating = b.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, calculation) values ($1, 1, 'm', 'numeric', $2)`,
      [def2, JSON.stringify(sum(s, t))]).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    assert.equal(await waitsForLock(), true, "the calculation waits for the archive");
    await a.query("commit");
    dbRefused(await creating, /every input is an active variable of the same owner or a system one/);
    await b.query("rollback");
  } finally {
    await a.query("rollback").catch(() => {});
    await b.query("rollback").catch(() => {});
    await a.end();
    await b.end();
  }
  // No active calculated variable over an input that is not active, anywhere in this database.
  assert.equal((await one(k, `select count(*)::int n from training_load.metric_definitions cd
      join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
      join training_load.metric_definitions i on i.id = any (training_load.metric_calculation_inputs(cv.calculation))
     where cd.state = 'active' and cv.calculation is not null and i.state <> 'active'`)).n, 0);
});

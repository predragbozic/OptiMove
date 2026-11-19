#!/usr/bin/env node
// The rehearsal of migration v83 (an athlete changes their own RPE answer while
// the question is open, K4b; docs/ai/central-calendar-k4b-contract.md section 5)
// on ANY PostgreSQL server you point it at - written so that it runs unchanged on
// PostgreSQL 17 (production runs 17.6) as on 16. Same shape and arguments as
// backend/scripts/permission-roles-v84-rehearsal.mjs, so the owner runs both in
// one sitting (docs/runbooks/rpe-answer-change-v83.md, "The rehearsal"):
//
//   1. a disposable database built from the legacy snapshot and the real runner,
//      every migration before v83;
//   2. the read-only preflight (every ok column true);
//   3. v83 applied by the real runner, recorded once with the file's sha256;
//   4. the read-only post-check (every ok column true);
//   5. the runner again: v83 skipped by its checksum;
//   6. the rollback (docs/runbooks/rpe-answer-change-v83-rollback.sql): the
//      catalog equal to the one before v83;
//   7. v83 applied again, the post-check again;
//   8. one real change on that database: an athlete, a one-time question, the
//      answer, then training_load.change_external_rpe(): the answer changed in
//      place, srpe followed, one history row; a raw update without the function
//      refused; then the rollback REFUSED (a history row exists) and v83 still
//      in place;
//   9. pg_dump -Fc of that database, pg_restore into a second disposable
//      database, and v83's catalog compared (constraints read back by
//      pg_get_constraintdef, triggers with their deferral, indexes, function
//      bodies);
//  10. both disposable databases dropped, whatever happened.
//
// Safety: a loopback server only (localhost, 127.0.0.1, ::1); the two databases
// it creates are named optimove_tests_k4bv83rehearsal_* and are the only ones it
// writes or drops; it takes no database name. The password is read from
// OPTIMOVE_REHEARSAL_PASSWORD (or PGPASSWORD) and never printed; pg_dump and
// pg_restore get host, port, user and database as arguments and inherit no other
// PG* variable. It needs this repository's backend dependencies
// (`npm --prefix backend ci`) and pg_dump / pg_restore of the SAME major version
// as the server (on PATH, or --pg-bin <dir>). The user needs CREATEDB (a
// superuser for the legacy seed replay: session_replication_role).
//
// Usage:
//   node backend/scripts/rpe-answer-change-v83-rehearsal.mjs --host 127.0.0.1 --port 5432 --user postgres [--pg-bin <dir>]
// Exit code 0 when every step passed, 1 otherwise. Prints PASS / FAIL per step.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const MIGRATIONS = path.join(REPO, "migrations_v2");
const RUNBOOKS = path.join(REPO, "docs", "runbooks");
export const V83_FILE = "202611201200_training_load_v83_rpe_answer_change.sql";
const V83_NAME = `migrations_v2/${V83_FILE}`;
export const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const NAME_PREFIX = "optimove_tests_k4bv83rehearsal_";

export function parseArgs(argv) {
  const out = { host: null, port: "5432", user: null, pgBin: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined || v.startsWith("--")) throw new Error(`refusing: ${a} needs a value`); return v; };
    if (a === "--host") out.host = next();
    else if (a === "--port") out.port = next();
    else if (a === "--user") out.user = next();
    else if (a === "--pg-bin") out.pgBin = next();
    else throw new Error(`refusing: unknown argument ${a} (the rehearsal takes --host, --port, --user and --pg-bin only; it never takes a database name)`);
  }
  if (!out.host || !out.user) throw new Error("refusing: --host and --user are required");
  if (!LOOPBACK.includes(out.host)) throw new Error(`refusing: ${out.host} is not a loopback host (localhost, 127.0.0.1, ::1)`);
  if (!/^[0-9]{1,5}$/.test(out.port)) throw new Error("refusing: --port must be a number");
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/.test(out.user)) throw new Error("refusing: --user must be a plain role name");
  return out;
}

export function urlFor(args, database, password) {
  const host = args.host === "::1" ? "[::1]" : args.host;
  const auth = `${encodeURIComponent(args.user)}${password ? `:${encodeURIComponent(password)}` : ""}`;
  return `postgres://${auth}@${host}:${args.port}/${database}`;
}

export function assertOwnName(name) {
  if (!new RegExp(`^${NAME_PREFIX}[0-9a-f]{12}$`).test(name)) throw new Error("refusing: not a database this rehearsal created");
  return name;
}

function toolEnv(password) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^PG[A-Z]/.test(k.toUpperCase())) env[k] = v;
  if (password) env.PGPASSWORD = password;
  return env;
}
const tool = (pgBin, name) => (pgBin ? path.join(pgBin, process.platform === "win32" ? `${name}.exe` : name) : name);
const conn = (args, database) => ["--host", args.host.replace(/^\[|\]$/g, ""), "--port", args.port, "--username", args.user, "--dbname", database, "--no-password"];

// The catalog the rollback must restore exactly: training_load's relations, functions (body md5), constraints and triggers.
export const CATALOG_SQL = `select
  (select string_agg(c.relname || ':' || c.relkind::text, ',' order by c.relname) from pg_class c where c.relnamespace = 'training_load'::regnamespace) as rels,
  (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ',' order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace = 'training_load'::regnamespace) as procs,
  (select string_agg(k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid), ',' order by k.conrelid::regclass::text, k.conname) from pg_constraint k where k.connamespace = 'training_load'::regnamespace) as cons,
  (select string_agg(t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgfoid::regprocedure::text || ':' || t.tgenabled::text || t.tgdeferrable::text || t.tginitdeferred::text, ',' order by t.tgrelid::regclass::text, t.tgname)
     from pg_trigger t where not t.tgisinternal and t.tgrelid in (select oid from pg_class where relnamespace = 'training_load'::regnamespace)) as trigs`;
// v83's objects only, for the dump read-back.
const V83_CATALOG_SQL = `select
  (select string_agg(k.conname || '=' || pg_get_constraintdef(k.oid), E'\\n' order by k.conname) from pg_constraint k where k.conrelid = 'training_load.session_feedback_changes'::regclass) as constraints,
  (select string_agg(pg_get_indexdef(i.indexrelid), E'\\n' order by pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid = 'training_load.session_feedback_changes'::regclass) as indexes,
  (select string_agg(g.tgrelid::regclass::text || '.' || g.tgname || ':' || g.tgfoid::regprocedure::text || ':' || g.tgenabled::text || g.tgdeferrable::text || g.tginitdeferred::text, E'\\n' order by g.tgrelid::regclass::text, g.tgname)
     from pg_trigger g where g.tgrelid in ('training_load.session_feedback'::regclass, 'training_load.session_feedback_changes'::regclass) and not g.tgisinternal) as triggers,
  (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), E'\\n' order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace = 'training_load'::regnamespace
     and p.proname in ('rpe_change_marker_ok', 'rpe_change_current_xmin', 'session_feedback_changes_append_only', 'session_feedback_changes_guard',
                       'protect_session_feedback_snapshot_v83', 'session_feedback_change_link_check', 'rpe_change_state', 'change_external_rpe')) as functions,
  (select relrowsecurity::text from pg_class where oid = 'training_load.session_feedback_changes'::regclass) as rls`;

// One athlete with an answered one-time question whose window is open now (step 8). The legacy schema's own columns.
const SMOKE_SEED_SQL = `with u as (
    insert into public.users (email, first_name, last_name, full_name) values ('k4b-rehearsal@test.local', 'K4b', 'Rehearsal', 'K4b Rehearsal') returning id),
  a as (
    insert into public.athletes (athlete_id, user_id, first_name, last_name, full_name) select 'K4B-REHEARSAL', id, 'K4b', 'Rehearsal', 'K4b Rehearsal' from u returning id, user_id),
  s as (
    insert into training_load.external_schedules (schedule_kind, timezone, start_date, opens_time, closes_time, event_name, created_by_user_id, owner_scope, owner_user_id)
    select 'one_time', 'UTC', current_date, '00:00', '23:59', 'Rehearsal training', id, 'user', id from u returning id),
  o as (
    insert into training_load.external_schedule_occurrences (schedule_id, scheduled_date, opens_at, closes_at, status)
    select id, current_date, now() - interval '1 hour', now() + interval '1 hour', 'open' from s returning id),
  asg as (
    insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at, status, completed_at)
    select o.id, a.id, 'UTC', current_date, now() - interval '1 hour', now() + interval '1 hour', 'completed', now() from o, a returning id, athlete_id),
  f as (
    insert into training_load.session_feedback (athlete_id, external_assignment_id, source, event_name, session_date, rpe, duration_minutes, athlete_note)
    select asg.athlete_id, asg.id, 'scheduled_external', 'Rehearsal training', current_date, 7, 60, 'first' from asg returning id)
  select (select user_id from a) as user_id, (select id from asg) as assignment_id, (select id from f) as feedback_id`;

const results = [];
function report(step, ok, detail = "") {
  results.push({ step, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` - ${detail}` : ""}`);
}

export function blocks(text) {
  const out = {};
  for (const part of text.split(/\n(?=-- \d+a?\. )/)) {
    const m = part.match(/^-- (\d+a?)\. /);
    if (!m) continue;
    const sql = part.split("\n").filter((l) => !l.startsWith("--")).join("\n").trim();
    if (sql) out[m[1]] = sql;
  }
  return out;
}
async function readOnly(client, sql) {
  await client.query("begin transaction read only");
  try { return (await client.query(sql)).rows[0]; } finally { await client.query("rollback"); }
}
// Every ok_* column; a column that is not an ok column (information) is ignored.
export const falseOkColumns = (row) => Object.entries(row).filter(([k, v]) => k.startsWith("ok_") && v !== true).map(([k]) => k);

export async function runRollback(client) {
  try {
    await client.query(fs.readFileSync(path.join(RUNBOOKS, "rpe-answer-change-v83-rollback.sql"), "utf8"));
    return { ok: true };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    return { ok: false, error };
  }
}

export async function rehearse(args, password) {
  const { bootstrapLegacySnapshot } = await import("../tests/support/legacy-bootstrap.mjs");
  const { runMigrations } = await import("../src/migrate.js");
  const admin = new pg.Client({ connectionString: urlFor(args, "postgres", password) });
  await admin.connect();
  const names = [];
  const created = async () => {
    const name = assertOwnName(`${NAME_PREFIX}${crypto.randomBytes(6).toString("hex")}`);
    await admin.query(`create database ${name}`);
    names.push(name);
    return name;
  };
  let tmp = null;
  try {
    const version = (await admin.query("select current_setting('server_version') as v, current_setting('server_version_num')::int as n")).rows[0];
    console.log(`server: PostgreSQL ${version.v} on ${args.host}:${args.port}`);
    const major = async (name) => Number(((await run(tool(args.pgBin, name), ["--version"], { env: toolEnv(password), windowsHide: true })).stdout.match(/(\d+)(\.\d+)?/) || [])[1]);
    const dumpMajor = await major("pg_dump");
    const restoreMajor = await major("pg_restore");
    report("tools: pg_dump and pg_restore of the server's major version", dumpMajor === Math.floor(version.n / 10000) && restoreMajor === dumpMajor, `server ${Math.floor(version.n / 10000)}, pg_dump ${dumpMajor}, pg_restore ${restoreMajor}`);

    // 1. Build to the migration before v83.
    const name = await created();
    const url = urlFor(args, name, password);
    const snapshotSql = fs.readFileSync(path.join(REPO, "backend", "tests", "support", "legacy-schema.sql"), "utf8");
    const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
    await bootstrapLegacySnapshot({ databaseUrl: url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-k4b-rehearsal-"));
    const before = path.join(tmp, "migrations_v2");
    fs.mkdirSync(before);
    for (const f of fs.readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f !== V83_FILE) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(before, f));
    await runMigrations({ databaseUrl: url, migrationsRoot: before });
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      report("1. a disposable database through the migration before v83", true, name);

      // 2. Preflight.
      const pre = blocks(fs.readFileSync(path.join(RUNBOOKS, "rpe-answer-change-v83-preflight.sql"), "utf8"));
      const preFalse = [];
      for (const [b, sql] of Object.entries(pre)) preFalse.push(...falseOkColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
      const catalogBefore = (await c.query(CATALOG_SQL)).rows[0];
      report("2. preflight: every ok column true", preFalse.length === 0, preFalse.join(", "));

      // 3. Apply.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const recorded = (await c.query(`select checksum from public.schema_migrations where migration_name = $1`, [V83_NAME])).rows;
      const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V83_FILE))).digest("hex");
      report("3. v83 applied by the runner, recorded once with the file's sha256", recorded.length === 1 && recorded[0].checksum === sha);

      // 4. Post-check.
      const post = blocks(fs.readFileSync(path.join(RUNBOOKS, "rpe-answer-change-v83-postcheck.sql"), "utf8"));
      const postCheck = async () => {
        const bad = [];
        for (const [b, sql] of Object.entries(post)) bad.push(...falseOkColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
        return bad;
      };
      const bad1 = await postCheck();
      report("4. post-check: every ok column true", bad1.length === 0, bad1.join(", "));

      // 5. The runner again.
      const count = Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count);
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      report("5. the runner again: v83 skipped by its checksum", Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count) === count);

      // 6. Rollback.
      const rolled = await runRollback(c);
      const catalogAfter = (await c.query(CATALOG_SQL)).rows[0];
      const sameCatalog = JSON.stringify(catalogAfter) === JSON.stringify(catalogBefore);
      report("6. rollback: the catalog equal to the one before v83", rolled.ok && sameCatalog,
        rolled.ok ? (sameCatalog ? "" : Object.keys(catalogBefore).filter((k) => catalogBefore[k] !== catalogAfter[k]).join(", ")) : String(rolled.error?.message));

      // 7. Apply again.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const bad2 = await postCheck();
      report("7. v83 applied again; the post-check again", bad2.length === 0, bad2.join(", "));

      // 8. One real change, then the rollback refused.
      const seed = (await c.query(SMOKE_SEED_SQL)).rows[0];
      await c.query("begin");
      const changed = (await c.query(`select training_load.change_external_rpe($1, $2, $3, 5, 75, 'second', 0) as r`, [seed.user_id, seed.assignment_id, crypto.randomUUID()])).rows[0].r;
      await c.query("commit");
      const row = (await c.query(`select rpe, duration_minutes, srpe, athlete_note from training_load.session_feedback where id = $1`, [seed.feedback_id])).rows[0];
      const history = Number((await c.query(`select count(*) from training_load.session_feedback_changes where session_feedback_id = $1`, [seed.feedback_id])).rows[0].count);
      let rawRefused = false;
      try { await c.query(`update training_load.session_feedback set rpe = 9 where id = $1`, [seed.feedback_id]); } catch { rawRefused = true; }
      report("8a. a real change: the answer changed in place, srpe followed, one history row; a raw update refused",
        changed.outcome === "changed" && row.rpe === 5 && row.duration_minutes === 75 && row.srpe === 375 && row.athlete_note === "second" && history === 1 && rawRefused,
        `${changed.outcome}, rpe ${row.rpe}, srpe ${row.srpe}, history ${history}, raw refused ${rawRefused}`);
      const refused = await runRollback(c);
      const stillThere = (await c.query(`select to_regclass('training_load.session_feedback_changes') is not null as t,
          exists (select 1 from public.schema_migrations where migration_name = $1) as m`, [V83_NAME])).rows[0];
      report("8b. the rollback refused once a history row exists; v83 still in place",
        !refused.ok && /an answer was changed/.test(String(refused.error?.message)) && stillThere.t && stillThere.m, String(refused.error?.message || "the rollback ran"));

      // 9. pg_dump -Fc and pg_restore into a second database, v83's catalog compared.
      const source = (await c.query(V83_CATALOG_SQL)).rows[0];
      const dumpFile = path.join(tmp, "v83.dump");
      await run(tool(args.pgBin, "pg_dump"), ["--format", "custom", "--file", dumpFile, ...conn(args, name)], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const copy = await created();
      await run(tool(args.pgBin, "pg_restore"), ["--exit-on-error", "--no-owner", ...conn(args, copy), dumpFile], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const r = new pg.Client({ connectionString: urlFor(args, copy, password) });
      await r.connect();
      try {
        const restored = (await r.query(V83_CATALOG_SQL)).rows[0];
        const differs = Object.keys(source).filter((k) => source[k] !== restored[k]);
        for (const k of differs) {
          const a = String(source[k]).split("\n"); const b = String(restored[k]).split("\n");
          for (const line of a.filter((x) => !b.includes(x)).slice(0, 5)) console.log(`      source only:   ${line}`);
          for (const line of b.filter((x) => !a.includes(x)).slice(0, 5)) console.log(`      restored only: ${line}`);
        }
        report("9. pg_dump / pg_restore read-back: v83's constraints, indexes, triggers and functions identical", differs.length === 0, differs.join(", "));
      } finally {
        await r.end().catch(() => {});
      }
    } finally {
      await c.end().catch(() => {});
    }
  } catch (error) {
    report("the rehearsal ran to its end", false, String(error?.message || error).replace(/postgres:\/\/[^@\s]*@/g, "postgres://***@"));
  } finally {
    for (const n of names) {
      try {
        await admin.query(`drop database if exists ${assertOwnName(n)} with (force)`);
      } catch {
        report(`10. drop ${n}`, false);
      }
    }
    if (names.length) report("10. the rehearsal's databases dropped", (await admin.query(`select count(*)::int as n from pg_database where datname = any($1)`, [names])).rows[0].n === 0);
    await admin.end().catch(() => {});
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((x) => !x.ok).length;
  console.log(failed ? `RESULT: FAIL (${failed} step(s))` : "RESULT: PASS");
  return failed === 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const password = process.env.OPTIMOVE_REHEARSAL_PASSWORD ?? process.env.PGPASSWORD ?? "";
  rehearse(args, password).then((ok) => process.exit(ok ? 0 : 1), (error) => {
    console.error(`FAIL  ${String(error?.message || error).replace(/postgres:\/\/[^@\s]*@/g, "postgres://***@")}`);
    process.exit(1);
  });
}

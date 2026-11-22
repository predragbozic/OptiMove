#!/usr/bin/env node
// The rehearsal of migration v85 (session types, ST-1 of docs/ai/session-type-plan.md) on ANY PostgreSQL server you
// point it at - written so that it runs unchanged on PostgreSQL 17 (production runs 17.6) as on 16. The v84 rehearsal's
// shape (backend/scripts/permission-roles-v84-rehearsal.mjs):
//
//   1. a disposable database built from the legacy snapshot and the real runner, every migration before v85; one
//      activity of each v1 type planted (the source-map seed is covered by backend/tests/session-types-v85-migration.test.mjs);
//   2. the read-only preflight (every ok column true);
//   3. v85 applied by the real runner, recorded once with the file's sha256;
//  3b. a guarded write as the service writes it (the acting user, a club type, its log row, an activity of the club's team
//      with that type, every deferred guard fired), rolled back; the same type write without the acting user refused
//      (42501); a type of another club on that activity refused (23514);
//   4. the read-only post-check (every ok column true; block 6 equal to preflight 3a);
//   5. the runner again: v85 skipped by its checksum;
//   6. the rollback (docs/runbooks/session-types-v85-rollback.sql): the catalog and the rows of training.activity_types
//      equal to the ones before v85, the planted activities untouched;
//   7. v85 applied again, the post-check again;
//  7b. the guarded write of 3b again, committed this time;
//   8. pg_dump -Fc of that database, pg_restore into a second disposable database, and the catalog of v85's objects
//      compared (constraints read back by pg_get_constraintdef, triggers, indexes, function bodies);
//   9. both disposable databases dropped, whatever happened.
//
// Safety: a loopback server only (localhost, 127.0.0.1, ::1); the two databases it creates are named
// optimove_tests_st1rehearsal_* and are the only ones it writes or drops; it takes no database name. The password is
// read from OPTIMOVE_REHEARSAL_PASSWORD (or PGPASSWORD) and never printed; pg_dump and pg_restore get host, port, user
// and database as arguments and inherit no other PG* variable. It needs Node with this repository's backend dependencies
// (`npm --prefix backend ci`), and pg_dump / pg_restore of the SAME major version as the server (on PATH, or
// --pg-bin <dir>). The user needs CREATEDB (a superuser for the legacy seed replay: session_replication_role).
//
// Usage:
//   node backend/scripts/session-types-v85-rehearsal.mjs --host 127.0.0.1 --port 5432 --user postgres [--pg-bin <dir>]
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
const V85_FILE = "202611201500_training_load_v85_session_types.sql";
const V85_NAME = `migrations_v2/${V85_FILE}`;
export const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const NAME_PREFIX = "optimove_tests_st1rehearsal_";

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

const results = [];
function report(step, ok, detail = "") {
  results.push({ step, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` - ${detail}` : ""}`);
}

// The two schemas v85 touches, and the rows of the registry (the rollback puts them back).
export const CATALOG_SQL = `select
  (select string_agg(c.relnamespace::regnamespace::text || '.' || c.relname || ':' || c.relkind::text, ',' order by c.relnamespace::regnamespace::text || '.' || c.relname || ':' || c.relkind::text) from pg_class c where c.relnamespace in ('training'::regnamespace, 'training_load'::regnamespace)) as rels,
  (select string_agg(a.attrelid::regclass::text || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attrelid::regclass::text || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text)
     from pg_attribute a where a.attrelid = 'training.activity_types'::regclass and a.attnum > 0 and not a.attisdropped) as columns,
  (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ',' order by p.oid::regprocedure::text || '=' || md5(p.prosrc)) from pg_proc p where p.pronamespace in ('training'::regnamespace, 'training_load'::regnamespace)) as procs,
  (select string_agg(k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid), ',' order by k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid)) from pg_constraint k where k.connamespace in ('training'::regnamespace, 'training_load'::regnamespace)) as cons,
  (select string_agg(t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgenabled::text, ',' order by t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgenabled::text) from pg_trigger t
     where not t.tgisinternal and t.tgrelid in (select oid from pg_class where relnamespace in ('training'::regnamespace, 'training_load'::regnamespace))) as trigs,
  (select string_agg(key || '=' || label || ':' || is_active::text || ':' || created_at::text, ',' order by key) from training.activity_types) as type_rows`;
// v85's objects only, for the dump read-back.
const V85_CATALOG_SQL = `with t as (select oid from pg_class where oid in ('training.activity_types'::regclass, 'training.activity_type_changes'::regclass,
    'training_load.source_session_types'::regclass, 'training.activities'::regclass))
  select
  (select string_agg(k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid), E'\\n' order by k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid)) from pg_constraint k where k.conrelid in (select oid from t)) as constraints,
  (select string_agg(g.tgrelid::regclass::text || '.' || g.tgname || ':' || g.tgenabled::text || g.tgdeferrable::text || g.tginitdeferred::text, E'\\n' order by g.tgrelid::regclass::text || '.' || g.tgname || ':' || g.tgenabled::text || g.tgdeferrable::text || g.tginitdeferred::text) from pg_trigger g where g.tgrelid in (select oid from t) and not g.tgisinternal) as triggers,
  (select string_agg(i.indexrelid::regclass::text || '=' || pg_get_indexdef(i.indexrelid), E'\\n' order by i.indexrelid::regclass::text || '=' || pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid in (select oid from t)) as indexes,
  (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), E'\\n' order by p.oid::regprocedure::text || '=' || md5(p.prosrc)) from pg_proc p
     where p.proname in ('session_type_actor', 'session_type_basis', 'session_type_offered', 'activity_types_before_write', 'activity_types_no_truncate',
                         'activity_types_change_logged', 'activity_type_changes_before_insert', 'activity_type_changes_append_only',
                         'activities_session_type_guard', 'source_session_types_before_write')) as functions,
  (select string_agg(key || '=' || label || ':' || is_active::text, ',' order by key) from training.activity_types) as type_rows`;

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
  try { const r = await client.query(sql); return (Array.isArray(r) ? r[r.length - 1] : r).rows[0]; } finally { await client.query("rollback"); }
}
const falseColumns = (row) => Object.entries(row).filter(([, v]) => v === false).map(([k]) => k);

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
    const dumpMajor = Number(((await run(tool(args.pgBin, "pg_dump"), ["--version"], { env: toolEnv(password), windowsHide: true })).stdout.match(/(\d+)(\.\d+)?/) || [])[1]);
    const restoreMajor = Number(((await run(tool(args.pgBin, "pg_restore"), ["--version"], { env: toolEnv(password), windowsHide: true })).stdout.match(/(\d+)(\.\d+)?/) || [])[1]);
    report("tools: pg_dump and pg_restore of the server's major version", dumpMajor === Math.floor(version.n / 10000) && restoreMajor === dumpMajor, `server ${Math.floor(version.n / 10000)}, pg_dump ${dumpMajor}, pg_restore ${restoreMajor}`);

    // 1. Build to the migration before v85.
    const name = await created();
    const url = urlFor(args, name, password);
    const snapshotSql = fs.readFileSync(path.join(REPO, "backend", "tests", "support", "legacy-schema.sql"), "utf8");
    const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
    await bootstrapLegacySnapshot({ databaseUrl: url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-st1-rehearsal-"));
    const before = path.join(tmp, "migrations_v2");
    fs.mkdirSync(before);
    for (const f of fs.readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f !== V85_FILE) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(before, f));
    await runMigrations({ databaseUrl: url, migrationsRoot: before });
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const u = (await c.query(`insert into public.users (email, first_name, last_name, full_name) values ('st1-rehearsal@test.local','S','1','S 1') returning id`)).rows[0].id;
      const club = (await c.query(`insert into public.clubs (name) values ('Rehearsal club') returning id`)).rows[0].id;
      const club2 = (await c.query(`insert into public.clubs (name) values ('Rehearsal club two') returning id`)).rows[0].id;
      const team = (await c.query(`insert into public.teams (club_id, name) values ($1, 'Rehearsal team') returning id`, [club])).rows[0].id;
      await c.query(`insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'club_admin')`, [u, club]);
      const planted = [];
      for (const key of ["training_session", "match", "testing_session", "recovery_session"]) {
        planted.push((await c.query(`insert into training.activities (activity_type_key, occurred_local_date, timezone_snapshot, owner_scope, owner_team_id, origin)
            values ($1, '2026-11-20', 'UTC', 'team', $2, 'manual') returning id`, [key, team])).rows[0].id);
      }
      const activitiesDigest = async () => (await c.query(`select md5(string_agg(a::text, ';' order by a.id)) as d from training.activities a where a.id = any($1)`, [planted])).rows[0].d;
      const digest0 = await activitiesDigest();
      report("1. a disposable database through the migration before v85; one activity of each v1 type", planted.length === 4, name);

      // 2. Preflight.
      const pre = blocks(fs.readFileSync(path.join(RUNBOOKS, "session-types-v85-preflight.sql"), "utf8"));
      const preFalse = [];
      for (const [b, sql] of Object.entries(pre)) preFalse.push(...falseColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
      const pre3a = await readOnly(c, pre["3a"]);
      const catalogBefore = (await c.query(CATALOG_SQL)).rows[0];
      report("2. preflight: every ok column true", preFalse.length === 0, preFalse.join(", "));

      // 3. Apply.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const recorded = (await c.query(`select checksum from public.schema_migrations where migration_name = $1`, [V85_NAME])).rows;
      const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V85_FILE))).digest("hex");
      report("3. v85 applied by the runner, recorded once with the file's sha256", recorded.length === 1 && recorded[0].checksum === sha);

      // 3b. A guarded write as the service writes it; refusals without the acting user and for another club's type.
      const guardedWrite = async (label, { commit }) => {
        const key = `c_${crypto.randomBytes(4).toString("hex")}_rehearsal`;
        let ok = false; let detail = "";
        try {
          await c.query("begin");
          await c.query(`select set_config('optimove.session_type_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [u]);
          await c.query(`insert into training.activity_types (key, label, owner_scope, owner_club_id, created_by_user_id) values ($1, $2, 'club', $3, $4)`, [key, `Rehearsal ${label}`, club, u]);
          await c.query(`insert into training.activity_type_changes (type_key, action, new_label, performed_by_user_id, basis, request_key, request_hash)
              values ($1, 'create', $2, $3, 'club_admin', gen_random_uuid(), $4)`, [key, `Rehearsal ${label}`, u, "a".repeat(64)]);
          await c.query(`insert into training.activities (activity_type_key, occurred_local_date, timezone_snapshot, owner_scope, owner_team_id, origin)
              values ($1, '2026-11-20', 'UTC', 'team', $2, 'manual')`, [key, team]);
          await c.query("set constraints all immediate");
          await c.query(commit ? "commit" : "rollback");
          ok = true;
        } catch (error) {
          await c.query("rollback").catch(() => {});
          detail = `${error?.code ?? ""} ${String(error?.message ?? "").slice(0, 120)}`;
        }
        const refusedWith = async (fn) => {
          try {
            await c.query("begin");
            await fn();
            await c.query("set constraints all immediate");
            return "none";
          } catch (error) {
            return error?.code ?? "?";
          } finally {
            await c.query("rollback").catch(() => {});
          }
        };
        const noActor = await refusedWith(() => c.query(`insert into training.activity_types (key, label, owner_scope, owner_club_id, created_by_user_id) values ('c_0000000f_noactor', 'No actor', 'club', $1, $2)`, [club, u]));
        const foreign = await refusedWith(async () => {
          await c.query(`select set_config('optimove.session_type_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [u]);
          await c.query(`insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'club_admin')`, [u, club2]);
          await c.query(`insert into training.activity_types (key, label, owner_scope, owner_club_id, created_by_user_id) values ('c_0000000e_other', 'Other club', 'club', $1, $2)`, [club2, u]);
          await c.query(`insert into training.activity_type_changes (type_key, action, new_label, performed_by_user_id, basis, request_key, request_hash)
              values ('c_0000000e_other', 'create', 'Other club', $1, 'club_admin', gen_random_uuid(), $2)`, [u, "b".repeat(64)]);
          await c.query(`insert into training.activities (activity_type_key, occurred_local_date, timezone_snapshot, owner_scope, owner_team_id, origin)
              values ('c_0000000e_other', '2026-11-20', 'UTC', 'team', $1, 'manual')`, [team]);
        });
        return { ok: ok && noActor === "42501" && foreign === "23514", detail: `${detail} without actor: ${noActor}; another club's type: ${foreign}`.trim() };
      };
      const gw1 = await guardedWrite("after apply", { commit: false });
      report("3b. a guarded write as the service writes it passes (rolled back); without the acting user 42501; another club's type on the activity 23514", gw1.ok, gw1.detail);

      // 4. Post-check.
      const post = blocks(fs.readFileSync(path.join(RUNBOOKS, "session-types-v85-postcheck.sql"), "utf8"));
      const postCheck = async () => {
        const bad = [];
        for (const [b, sql] of Object.entries(post)) bad.push(...falseColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
        if ((await readOnly(c, post["6"])).activities_per_type !== pre3a.activities_per_type) bad.push("6: the activities per type changed");
        return bad;
      };
      const bad1 = await postCheck();
      report("4. post-check: every ok column true, block 6 equal to preflight 3a", bad1.length === 0, bad1.join(", "));

      // 5. The runner again.
      const count = Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count);
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      report("5. the runner again: v85 skipped by its checksum", Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count) === count);

      // 6. Rollback.
      await c.query(fs.readFileSync(path.join(RUNBOOKS, "session-types-v85-rollback.sql"), "utf8"));
      const catalogAfter = (await c.query(CATALOG_SQL)).rows[0];
      const sameCatalog = JSON.stringify(catalogAfter) === JSON.stringify(catalogBefore);
      report("6. rollback: the catalog and the type rows equal to the ones before v85, the planted activities untouched", sameCatalog && (await activitiesDigest()) === digest0,
        sameCatalog ? "" : Object.keys(catalogBefore).filter((k) => catalogBefore[k] !== catalogAfter[k]).join(", "));

      // 7. Apply again.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const bad2 = await postCheck();
      report("7. v85 applied again; the post-check again", bad2.length === 0, bad2.join(", "));
      const gw2 = await guardedWrite("after re-apply", { commit: true });
      report("7b. the guarded write again, COMMITTED; the refusals again", gw2.ok, gw2.detail);

      // 8. pg_dump -Fc and pg_restore into a second database, v85's catalog compared.
      const source = (await c.query(V85_CATALOG_SQL)).rows[0];
      const dumpFile = path.join(tmp, "v85.dump");
      await run(tool(args.pgBin, "pg_dump"), ["--format", "custom", "--file", dumpFile, ...conn(args, name)], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const copy = await created();
      await run(tool(args.pgBin, "pg_restore"), ["--exit-on-error", "--no-owner", ...conn(args, copy), dumpFile], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const r = new pg.Client({ connectionString: urlFor(args, copy, password) });
      await r.connect();
      try {
        const restored = (await r.query(V85_CATALOG_SQL)).rows[0];
        const differs = Object.keys(source).filter((k) => source[k] !== restored[k]);
        for (const k of differs) {
          const a = String(source[k]).split("\n"); const b = String(restored[k]).split("\n");
          for (const line of a.filter((x) => !b.includes(x)).slice(0, 5)) console.log(`      source only:   ${line}`);
          for (const line of b.filter((x) => !a.includes(x)).slice(0, 5)) console.log(`      restored only: ${line}`);
        }
        report("8. pg_dump / pg_restore read-back: v85's constraints, triggers, indexes, functions and type rows identical", differs.length === 0, differs.join(", "));
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
        report(`9. drop ${n}`, false);
      }
    }
    if (names.length) report("9. the rehearsal's databases dropped", (await admin.query(`select count(*)::int as n from pg_database where datname = any($1)`, [names])).rows[0].n === 0);
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

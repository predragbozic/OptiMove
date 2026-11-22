#!/usr/bin/env node
// The rehearsal of migration v87 (athlete positions, docs/ai/athlete-positions-plan.md) on ANY PostgreSQL server you point
// it at - written so that it runs unchanged on PostgreSQL 17 (production) as on 16. The v85 rehearsal's shape
// (backend/scripts/session-types-v85-rehearsal.mjs):
//
//   1. a disposable database built from the legacy snapshot and the real runner, every migration before v87; a club, a
//      second club, a team and an athlete of the team planted;
//   2. the read-only preflight (every ok column true);
//   3. v87 applied by the real runner, recorded once with the file's sha256;
//  3b. a guarded write as the service writes it (the acting user, a club position, its log row, the athlete's position on
//      the club_admin basis, every deferred guard fired), rolled back; the same position write without the acting user
//      refused (42501); another club's position on the athlete refused (23514);
//   4. the read-only post-check (every ok column true; block 6 equal to preflight 4);
//   5. the runner again: v87 skipped by its checksum;
//   6. the rollback (docs/runbooks/athlete-positions-v87-rollback.sql): the catalog and the rows of public.sports and
//      public.sport_positions equal to the ones before v87, the planted rows untouched;
//   7. v87 applied again, the post-check again;
//  7b. the guarded write of 3b again, committed this time;
//   8. pg_dump -Fc of that database, pg_restore into a second disposable database, and the catalog of v87's objects
//      compared (constraints read back by pg_get_constraintdef, triggers, indexes, function bodies);
//   9. both disposable databases dropped, whatever happened.
//
// Safety: a loopback server only (localhost, 127.0.0.1, ::1); the two databases it creates are named
// optimove_tests_pos87rehearsal_* and are the only ones it writes or drops; it takes no database name. The password is
// read from OPTIMOVE_REHEARSAL_PASSWORD (or PGPASSWORD) and never printed; pg_dump and pg_restore get host, port, user
// and database as arguments and inherit no other PG* variable. It needs Node with this repository's backend dependencies
// (`npm --prefix backend ci`), and pg_dump / pg_restore of the SAME major version as the server (on PATH, or
// --pg-bin <dir>). The user needs CREATEDB (a superuser for the legacy seed replay: session_replication_role).
//
// Usage:
//   node backend/scripts/athlete-positions-v87-rehearsal.mjs --host 127.0.0.1 --port 5432 --user postgres [--pg-bin <dir>]
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
export const V87_FILE = "202611221200_athletes_v87_positions.sql";
const V87_NAME = `migrations_v2/${V87_FILE}`;
export const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const NAME_PREFIX = "optimove_tests_pos87rehearsal_";

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

// What v87 touches: the public relations, the registry's columns, the functions of public and training_load, the
// constraints and triggers of the two tables v87 alters, and the rows of the registry and the sports.
export const CATALOG_SQL = `select
  (select string_agg(c.relname || ':' || c.relkind::text, ',' order by c.relname || ':' || c.relkind::text) from pg_class c where c.relnamespace = 'public'::regnamespace) as rels,
  (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attnum)
     from pg_attribute a where a.attrelid = 'public.sport_positions'::regclass and a.attnum > 0 and not a.attisdropped) as columns,
  (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ',' order by p.oid::regprocedure::text || '=' || md5(p.prosrc)) from pg_proc p where p.pronamespace in ('public'::regnamespace, 'training_load'::regnamespace)) as procs,
  (select string_agg(k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid), ',' order by k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid))
     from pg_constraint k where k.conrelid in ('public.sport_positions'::regclass, 'public.sports'::regclass, 'training_load.metric_value_estimates'::regclass)) as cons,
  (select string_agg(t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgenabled::text, ',' order by t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgenabled::text) from pg_trigger t
     where not t.tgisinternal and t.tgrelid in ('public.sport_positions'::regclass, 'public.sports'::regclass, 'training_load.metric_value_estimates'::regclass)) as trigs,
  (select string_agg(name, ',' order by name) from public.sports) as sport_rows,
  (select string_agg(name, ',' order by name) from public.sport_positions) as position_rows`;
// v87's objects only, for the dump read-back.
const V87_CATALOG_SQL = `with t as (select oid from pg_class where oid in ('public.sport_positions'::regclass, 'public.sport_position_changes'::regclass,
    'public.athlete_positions'::regclass, 'public.club_position_overrides'::regclass, 'training_load.metric_value_estimates'::regclass))
  select
  (select string_agg(k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid), E'\\n' order by k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid)) from pg_constraint k where k.conrelid in (select oid from t)) as constraints,
  (select string_agg(g.tgrelid::regclass::text || '.' || g.tgname || ':' || g.tgenabled::text || g.tgdeferrable::text || g.tginitdeferred::text, E'\\n' order by g.tgrelid::regclass::text || '.' || g.tgname || ':' || g.tgenabled::text || g.tgdeferrable::text || g.tginitdeferred::text) from pg_trigger g where g.tgrelid in (select oid from t) and not g.tgisinternal) as triggers,
  (select string_agg(i.indexrelid::regclass::text || '=' || pg_get_indexdef(i.indexrelid), E'\\n' order by i.indexrelid::regclass::text || '=' || pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid in (select oid from t)) as indexes,
  (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), E'\\n' order by p.oid::regprocedure::text || '=' || md5(p.prosrc)) from pg_proc p
     where p.proname in ('position_actor', 'sport_position_basis', 'athlete_position_right', 'sport_position_offered', 'athlete_position_in_force',
                         'sport_positions_before_write', 'sport_positions_no_truncate', 'sport_positions_change_logged',
                         'sport_position_changes_before_insert', 'position_history_append_only', 'athlete_positions_before_insert',
                         'club_position_overrides_before_write', 'club_position_overrides_no_truncate', 'club_position_overrides_change_logged',
                         'estimate_basis_ok', 'validate_metric_value_estimate')) as functions,
  (select string_agg(name || ':' || owner_scope || ':' || sort_order, ',' order by sort_order, name) from public.sport_positions) as position_rows`;

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

    // 1. Build to the migration before v87.
    const name = await created();
    const url = urlFor(args, name, password);
    const snapshotSql = fs.readFileSync(path.join(REPO, "backend", "tests", "support", "legacy-schema.sql"), "utf8");
    const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
    await bootstrapLegacySnapshot({ databaseUrl: url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-pos87-rehearsal-"));
    const before = path.join(tmp, "migrations_v2");
    fs.mkdirSync(before);
    for (const f of fs.readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f !== V87_FILE) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(before, f));
    await runMigrations({ databaseUrl: url, migrationsRoot: before });
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const u = (await c.query(`insert into public.users (email, first_name, last_name, full_name) values ('pos87-rehearsal@test.local','P','88','P 88') returning id`)).rows[0].id;
      const club = (await c.query(`insert into public.clubs (name) values ('Rehearsal club') returning id`)).rows[0].id;
      const club2 = (await c.query(`insert into public.clubs (name) values ('Rehearsal club two') returning id`)).rows[0].id;
      const team = (await c.query(`insert into public.teams (club_id, name) values ($1, 'Rehearsal team') returning id`, [club])).rows[0].id;
      const athlete = (await c.query(`insert into public.athletes (athlete_id, first_name, last_name, full_name) values ('pos87-a', 'R', 'A', 'R A') returning id`)).rows[0].id;
      await c.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status) values ($1, $2, $3, 'team', 'active')`, [athlete, club, team]);
      await c.query(`insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'club_admin')`, [u, club]);
      await c.query(`insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'club_admin')`, [u, club2]);
      const plantedDigest = async () => (await c.query(
        `select md5(coalesce((select string_agg(a::text, ';') from public.athletes a where a.id = $1), '') ||
                    coalesce((select string_agg(m::text, ';') from public.athlete_memberships m where m.athlete_id = $1), '')) as d`, [athlete])).rows[0].d;
      const digest0 = await plantedDigest();
      report("1. a disposable database through the migration before v87; two clubs, a team and an athlete planted", true, name);

      // 2. Preflight.
      const pre = blocks(fs.readFileSync(path.join(RUNBOOKS, "athlete-positions-v87-preflight.sql"), "utf8"));
      const preFalse = [];
      for (const [b, sql] of Object.entries(pre)) preFalse.push(...falseColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
      const pre4 = await readOnly(c, pre["4"]);
      const catalogBefore = (await c.query(CATALOG_SQL)).rows[0];
      report("2. preflight: every ok column true", preFalse.length === 0, preFalse.join(", "));

      // 3. Apply.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const recorded = (await c.query(`select checksum from public.schema_migrations where migration_name = $1`, [V87_NAME])).rows;
      const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V87_FILE))).digest("hex");
      report("3. v87 applied by the runner, recorded once with the file's sha256", recorded.length === 1 && recorded[0].checksum === sha);

      // 3b. A guarded write as the service writes it; refusals without the acting user and for another club's position.
      const actor = () => c.query(`select set_config('optimove.position_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [u]);
      const addPosition = async (clubId, label) => {
        const id = (await c.query(`insert into public.sport_positions (sport_id, name, owner_scope, owner_club_id, created_by_user_id)
            values ((select id from public.sports where name = 'Football'), $1, 'club', $2, $3) returning id`, [label, clubId, u])).rows[0].id;
        await c.query(`insert into public.sport_position_changes (position_id, action, new_name, performed_by_user_id, basis, request_key, request_hash)
            values ($1, 'create', $2, $3, 'club_admin', gen_random_uuid(), $4)`, [id, label, u, "a".repeat(64)]);
        return id;
      };
      const setPosition = (positionId) => c.query(`insert into public.athlete_positions (athlete_id, club_id, position_id, set_by_user_id, basis, request_key, request_hash)
          values ($1, $2, $3, $4, 'club_admin', gen_random_uuid(), $5)`, [athlete, club, positionId, u, "b".repeat(64)]);
      const guardedWrite = async (label, { commit }) => {
        let ok = false; let detail = "";
        try {
          await c.query("begin");
          await actor();
          const id = await addPosition(club, `Rehearsal ${label}`);
          await setPosition(id);
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
        const noActor = await refusedWith(() => c.query(`insert into public.sport_positions (sport_id, name, owner_scope, owner_club_id, created_by_user_id)
            values ((select id from public.sports where name = 'Football'), 'No actor', 'club', $1, $2)`, [club, u]));
        const foreign = await refusedWith(async () => {
          await actor();
          const other = await addPosition(club2, "Other club");
          await setPosition(other);
        });
        return { ok: ok && noActor === "42501" && foreign === "23514", detail: `${detail} without actor: ${noActor}; another club's position on the athlete: ${foreign}`.trim() };
      };
      const gw1 = await guardedWrite("after apply", { commit: false });
      report("3b. a guarded write as the service writes it passes (rolled back); without the acting user 42501; another club's position 23514", gw1.ok, gw1.detail);

      // 4. Post-check.
      const post = blocks(fs.readFileSync(path.join(RUNBOOKS, "athlete-positions-v87-postcheck.sql"), "utf8"));
      const postCheck = async () => {
        const bad = [];
        for (const [b, sql] of Object.entries(post)) bad.push(...falseColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
        if ((await readOnly(c, post["6"])).estimates_per_method !== pre4.estimates_per_method) bad.push("6: the estimates per method changed");
        return bad;
      };
      const bad1 = await postCheck();
      report("4. post-check: every ok column true, block 6 equal to preflight 4", bad1.length === 0, bad1.join(", "));

      // 5. The runner again.
      const count = Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count);
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      report("5. the runner again: v87 skipped by its checksum", Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count) === count);

      // 6. Rollback.
      await c.query(fs.readFileSync(path.join(RUNBOOKS, "athlete-positions-v87-rollback.sql"), "utf8"));
      const catalogAfter = (await c.query(CATALOG_SQL)).rows[0];
      const sameCatalog = JSON.stringify(catalogAfter) === JSON.stringify(catalogBefore);
      report("6. rollback: the catalog, the sports and the positions equal to the ones before v87, the planted rows untouched", sameCatalog && (await plantedDigest()) === digest0,
        sameCatalog ? "" : Object.keys(catalogBefore).filter((k) => catalogBefore[k] !== catalogAfter[k]).join(", "));

      // 7. Apply again.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const bad2 = await postCheck();
      report("7. v87 applied again; the post-check again", bad2.length === 0, bad2.join(", "));
      const gw2 = await guardedWrite("after re-apply", { commit: true });
      report("7b. the guarded write again, COMMITTED; the refusals again", gw2.ok, gw2.detail);

      // 8. pg_dump -Fc and pg_restore into a second database, v87's catalog compared.
      const source = (await c.query(V87_CATALOG_SQL)).rows[0];
      const dumpFile = path.join(tmp, "v87.dump");
      await run(tool(args.pgBin, "pg_dump"), ["--format", "custom", "--file", dumpFile, ...conn(args, name)], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const copy = await created();
      await run(tool(args.pgBin, "pg_restore"), ["--exit-on-error", "--no-owner", ...conn(args, copy), dumpFile], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const r = new pg.Client({ connectionString: urlFor(args, copy, password) });
      await r.connect();
      try {
        const restored = (await r.query(V87_CATALOG_SQL)).rows[0];
        // A restored CHECK over a varchar column (v63's note check, the method check) is printed back with its casts and
        // parentheses placed differently (`(ARRAY[...])::text[]` against `ARRAY[(...)::text, ...]`); the constraints are
        // compared with the casts and parentheses removed, every other column byte for byte.
        const normal = (text) => String(text).split("\n").map((l) => l.replace(/::character varying|::text\[\]|::text/g, "").replace(/[()\s]/g, "")).join("\n");
        const same = (k) => (k === "constraints" ? normal(source[k]) === normal(restored[k]) : source[k] === restored[k]);
        const differs = Object.keys(source).filter((k) => !same(k));
        for (const k of differs) {
          const a = String(source[k]).split("\n"); const b = String(restored[k]).split("\n");
          for (const line of a.filter((x) => !b.includes(x)).slice(0, 5)) console.log(`      source only:   ${line}`);
          for (const line of b.filter((x) => !a.includes(x)).slice(0, 5)) console.log(`      restored only: ${line}`);
        }
        report("8. pg_dump / pg_restore read-back: v87's constraints, triggers, indexes, functions and position rows identical", differs.length === 0, differs.join(", "));
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

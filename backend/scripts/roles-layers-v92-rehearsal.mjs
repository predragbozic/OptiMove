#!/usr/bin/env node
// The rehearsal of migration v92 (roles R4-1, the layers foundation; docs/ai/roles-r4-contract.md section 7) on ANY
// PostgreSQL server you point it at - written so that it runs unchanged on PostgreSQL 17 (production) as on 16. The v87
// rehearsal's shape (backend/scripts/athlete-positions-v87-rehearsal.mjs), in PRODUCTION's order: production applied
// v93 (calendar, 202611251000) before v92, so this tool builds every migration but v92 - v93 included - and then
// applies v92 last:
//
//   1. a disposable database built from the legacy snapshot and the real runner, every migration but v92 (v93
//      included); a club with an admin, a team with a coach and a platform admin planted;
//   2. the read-only preflight (every ok column true);
//   3. v92 applied by the real runner after v93, recorded once with the file's sha256;
//  3b. a guarded write as R4-3's writer will write it (the acting platform admin, the club's exclusive ceiling lock, a
//      ceiling row and its change row, every deferred guard fired), rolled back; the same write without the club lock
//      refused (55000); without the acting user refused (42501); the twin: the club admin still holds staff.assign,
//      the team coach athletes.manage, both hold the seeded view word;
//   4. the read-only post-check (every ok column true);
//   5. the runner again: v92 skipped by its checksum;
//   6. the rollback (docs/runbooks/roles-layers-v92-rollback.sql): the catalog equal to the one before v92, the planted
//      rows untouched (allowed although v93 sorts after v92: v93 was APPLIED before it);
//   7. v92 applied again, the post-check again; 7b. the guarded write again, COMMITTED; the rollback then refuses;
//   8. pg_dump -Fc of that database, pg_restore into a second disposable database, and v92's catalog compared;
//   9. both disposable databases dropped, whatever happened.
//
// Safety: a loopback server only (localhost, 127.0.0.1, ::1); the two databases it creates are named
// optimove_tests_roles92rehearsal_* and are the only ones it writes or drops; it takes no database name. The password
// is read from OPTIMOVE_REHEARSAL_PASSWORD (or PGPASSWORD) and never printed; pg_dump and pg_restore get host, port,
// user and database as arguments and inherit no other PG* variable. Node 20 or later with this repository's backend
// dependencies (`npm --prefix backend ci`), and pg_dump / pg_restore of the SAME major version as the server (on PATH,
// or --pg-bin <dir>). The user needs CREATEDB (a superuser for the legacy seed replay: session_replication_role).
//
// Usage:
//   node backend/scripts/roles-layers-v92-rehearsal.mjs --host 127.0.0.1 --port 5432 --user postgres [--pg-bin <dir>]
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
export const V92_FILE = "202611241000_roles_v92_layers_foundation.sql";
const V92_NAME = `migrations_v2/${V92_FILE}`;
export const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const NAME_PREFIX = "optimove_tests_roles92rehearsal_";

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

// What v92 touches: the public relations, the public functions, the constraints and triggers of the role tables, and
// the basic roles' items.
export const CATALOG_SQL = `select
  (select string_agg(c.relname || ':' || c.relkind::text, ',' order by c.relname || ':' || c.relkind::text) from pg_class c where c.relnamespace = 'public'::regnamespace) as rels,
  (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ',' order by p.oid::regprocedure::text || '=' || md5(p.prosrc)) from pg_proc p where p.pronamespace = 'public'::regnamespace) as procs,
  (select string_agg(k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid), ',' order by k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid))
     from pg_constraint k where k.conrelid in ('public.permission_requests'::regclass, 'public.permission_roles'::regclass, 'public.user_club_roles'::regclass, 'public.user_team_roles'::regclass)) as cons,
  (select string_agg(t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgenabled::text, ',' order by t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgenabled::text) from pg_trigger t
     where not t.tgisinternal and t.tgrelid in ('public.permission_requests'::regclass, 'public.permission_roles'::regclass, 'public.permission_role_items'::regclass, 'public.user_club_roles'::regclass, 'public.user_team_roles'::regclass)) as trigs,
  (select string_agg(role_id || ':' || permission_word, ',' order by role_id || ':' || permission_word) from public.permission_role_items) as items`;
// v92's objects only, for the dump read-back.
const V92_CATALOG_SQL = `with t as (select c.oid from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('club_permission_ceiling',
    'club_permission_ceiling_changes', 'permission_club_role_versions', 'permission_club_role_version_items', 'permission_club_role_version_changes',
    'permission_custom_roles', 'permission_custom_role_items', 'permission_custom_role_changes', 'permission_requests', 'user_club_roles', 'user_team_roles'))
  select
  (select string_agg(k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid), E'\\n' order by k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid)) from pg_constraint k where k.conrelid in (select oid from t)) as constraints,
  (select string_agg(g.tgrelid::regclass::text || '.' || g.tgname || ':' || g.tgenabled::text || g.tgdeferrable::text || g.tginitdeferred::text, E'\\n' order by g.tgrelid::regclass::text || '.' || g.tgname || ':' || g.tgenabled::text || g.tgdeferrable::text || g.tginitdeferred::text) from pg_trigger g where g.tgrelid in (select oid from t) and not g.tgisinternal) as triggers,
  (select string_agg(i.indexrelid::regclass::text || '=' || pg_get_indexdef(i.indexrelid), E'\\n' order by i.indexrelid::regclass::text || '=' || pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid in (select oid from t)) as indexes,
  (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), E'\\n' order by p.oid::regprocedure::text || '=' || md5(p.prosrc)) from pg_proc p
     where p.pronamespace = 'public'::regnamespace and (p.proname like 'permission%' or p.proname in ('user_has_permission', 'user_holds_role_items', 'lock_permission_actor', 'lock_club_ceiling'))) as functions`;

// The runbook SQL's blocks: "-- Block N: ..." headers.
export function blocks(text) {
  const out = {};
  for (const part of text.split(/\n(?=-- Block \d+:)/)) {
    const m = part.match(/^-- Block (\d+):/);
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
const falseColumns = (row) => Object.entries(row).filter(([k, v]) => k.endsWith("ok") && v !== true).map(([k]) => k);

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

    // 1. Every migration but v92 (v93 included).
    const name = await created();
    const url = urlFor(args, name, password);
    const snapshotSql = fs.readFileSync(path.join(REPO, "backend", "tests", "support", "legacy-schema.sql"), "utf8");
    const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
    await bootstrapLegacySnapshot({ databaseUrl: url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-roles92-rehearsal-"));
    const before = path.join(tmp, "migrations_v2");
    fs.mkdirSync(before);
    for (const f of fs.readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f !== V92_FILE) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(before, f));
    await runMigrations({ databaseUrl: url, migrationsRoot: before });
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const user = async (label) => (await c.query(`insert into public.users (email, first_name, last_name, full_name, is_active) values ($1, 'R', $2, $2, true) returning id`, [`roles92-${label}@test.local`, label])).rows[0].id;
      const pa = await user("pa"); const ca = await user("ca"); const tc = await user("tc");
      const club = (await c.query(`insert into public.clubs (name) values ('Rehearsal club') returning id`)).rows[0].id;
      const team = (await c.query(`insert into public.teams (club_id, name) values ($1, 'Rehearsal team') returning id`, [club])).rows[0].id;
      await c.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'platform_admin', true)`, [pa]);
      await c.query(`insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'club_admin')`, [ca, club]);
      await c.query(`insert into public.user_team_roles (user_id, team_id, role) values ($1, $2, 'team_coach')`, [tc, team]);
      const plantedDigest = async () => (await c.query(
        `select md5(coalesce((select string_agg(r::text, ';' order by r.id) from public.user_club_roles r where r.club_id = $1), '') ||
                    coalesce((select string_agg(r::text, ';' order by r.id) from public.user_team_roles r where r.team_id = $2), '')) as d`, [club, team])).rows[0].d;
      const digest0 = await plantedDigest();
      const v93 = (await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = 'migrations_v2/202611251000_calendar_v93_event_delete.sql'`)).rows[0].n;
      report("1. a disposable database through every migration but v92 (v93 applied first, as on production); a club, a team, their admin and coach, a platform admin planted", v93 === 1, name);

      // 2. Preflight.
      const pre = blocks(fs.readFileSync(path.join(RUNBOOKS, "roles-layers-v92-preflight.sql"), "utf8"));
      const preFalse = [];
      for (const [b, sql] of Object.entries(pre)) preFalse.push(...falseColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
      const catalogBefore = (await c.query(CATALOG_SQL)).rows[0];
      report("2. preflight: every ok column true", preFalse.length === 0, preFalse.join(", "));

      // 3. Apply.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const recorded = (await c.query(`select checksum from public.schema_migrations where migration_name = $1`, [V92_NAME])).rows;
      const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V92_FILE))).digest("hex");
      report("3. v92 applied by the runner after v93, recorded once with the file's sha256", recorded.length === 1 && recorded[0].checksum === sha);

      // 3b. A guarded write; refusals; the twin.
      const guardedWrite = async ({ commit }) => {
        const attempt = async (fn) => {
          try {
            await c.query("begin");
            await fn();
            await c.query("set constraints all immediate");
            await c.query(commit ? "commit" : "rollback");
            return "none";
          } catch (error) {
            await c.query("rollback").catch(() => {});
            return error?.code ?? "?";
          }
        };
        const actor = () => c.query(`select set_config('optimove.permission_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [pa]);
        const close = async () => {
          await c.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, 'imports', $2, 'Rehearsal')`, [club, pa]);
          await c.query(`insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason) values ($1, 'imports', 'close', $2, 'Rehearsal')`, [club, pa]);
        };
        const written = await attempt(async () => { await actor(); await c.query(`select public.lock_club_ceiling($1::uuid[], 'exclusive')`, [[club]]); await close(); });
        const saved = commit;
        commit = false;
        const noLock = await attempt(async () => { await actor(); await close(); });
        const noActor = await attempt(async () => { await c.query(`select public.lock_club_ceiling($1::uuid[], 'exclusive')`, [[club]]); await close(); });
        commit = saved;
        const twin = async (u, w, t, id) => (await c.query(`select public.user_has_permission($1, $2, $3, $4) as ok`, [u, w, t, id])).rows[0].ok;
        const twinOk = (await twin(ca, "staff.assign", "club", club)) && (await twin(tc, "athletes.manage", "team", team))
          && (await twin(ca, "calendar.view", "club", club)) && (await twin(tc, "calendar.view", "team", team))
          && !(await twin(tc, "staff.assign", "club", club));
        return { ok: written === "none" && noLock === "55000" && noActor === "42501" && twinOk, detail: `write ${written}; without the club lock ${noLock}; without the acting user ${noActor}; twin ${twinOk}` };
      };
      const gw1 = await guardedWrite({ commit: false });
      report("3b. a guarded ceiling write passes (rolled back); without the club lock 55000; without the acting user 42501; the twin answers", gw1.ok, gw1.detail);

      // 4. Post-check.
      const post = blocks(fs.readFileSync(path.join(RUNBOOKS, "roles-layers-v92-postcheck.sql"), "utf8"));
      const postCheck = async () => {
        const bad = [];
        for (const [b, sql] of Object.entries(post)) bad.push(...falseColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
        return bad;
      };
      const bad1 = await postCheck();
      report("4. post-check: every ok column true", bad1.length === 0, bad1.join(", "));

      // 5. The runner again.
      const count = Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count);
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      report("5. the runner again: v92 skipped by its checksum", Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count) === count);

      // 6. Rollback (allowed: v93 was applied before v92).
      const rollback = fs.readFileSync(path.join(RUNBOOKS, "roles-layers-v92-rollback.sql"), "utf8");
      await c.query(rollback);
      const catalogAfter = (await c.query(CATALOG_SQL)).rows[0];
      const sameCatalog = JSON.stringify(catalogAfter) === JSON.stringify(catalogBefore);
      report("6. rollback: the catalog and the basic roles' items equal to the ones before v92, the planted rows untouched", sameCatalog && (await plantedDigest()) === digest0,
        sameCatalog ? "" : Object.keys(catalogBefore).filter((k) => catalogBefore[k] !== catalogAfter[k]).join(", "));

      // 7. Apply again.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const bad2 = await postCheck();
      report("7. v92 applied again; the post-check again", bad2.length === 0, bad2.join(", "));
      const gw2 = await guardedWrite({ commit: true });
      let refusedNow = "none";
      try { await c.query(rollback); } catch (error) { refusedNow = error?.code ?? "?"; await c.query("rollback").catch(() => {}); }
      report("7b. the guarded write again, COMMITTED; the refusals again; the rollback now refuses (23514)", gw2.ok && refusedNow === "23514", `${gw2.detail}; rollback ${refusedNow}`);

      // 8. pg_dump -Fc and pg_restore into a second database, v92's catalog compared.
      const source = (await c.query(V92_CATALOG_SQL)).rows[0];
      const dumpFile = path.join(tmp, "v92.dump");
      await run(tool(args.pgBin, "pg_dump"), ["--format", "custom", "--file", dumpFile, ...conn(args, name)], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const copy = await created();
      await run(tool(args.pgBin, "pg_restore"), ["--exit-on-error", "--no-owner", ...conn(args, copy), dumpFile], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const r = new pg.Client({ connectionString: urlFor(args, copy, password) });
      await r.connect();
      try {
        const restored = (await r.query(V92_CATALOG_SQL)).rows[0];
        const normal = (text) => String(text).split("\n").map((l) => l.replace(/::character varying|::text\[\]|::text/g, "").replace(/[()\s]/g, "")).join("\n");
        const same = (k) => (k === "constraints" ? normal(source[k]) === normal(restored[k]) : source[k] === restored[k]);
        const differs = Object.keys(source).filter((k) => !same(k));
        for (const k of differs) {
          const a = String(source[k]).split("\n"); const b = String(restored[k]).split("\n");
          for (const line of a.filter((x) => !b.includes(x)).slice(0, 5)) console.log(`      source only:   ${line}`);
          for (const line of b.filter((x) => !a.includes(x)).slice(0, 5)) console.log(`      restored only: ${line}`);
        }
        report("8. pg_dump / pg_restore read-back: v92's constraints, triggers, indexes and functions identical", differs.length === 0, differs.join(", "));
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
  if (Number(process.versions.node.split(".")[0]) < 20) {
    console.error(`refusing: Node ${process.versions.node} is older than 20`);
    process.exit(2);
  }
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

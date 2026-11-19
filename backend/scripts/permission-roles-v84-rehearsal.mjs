#!/usr/bin/env node
// The rehearsal of migration v84 (roles R2; docs/ai/roles-r2-contract.md 7.3,
// 7.4) on ANY PostgreSQL server you point it at - written so that it runs
// unchanged on PostgreSQL 17 (production runs 17.6) as on 16:
//
//   1. a disposable database built from the legacy snapshot and the real runner,
//      every migration before v84; old role rows planted;
//   2. the read-only preflight (every ok column true);
//   3. v84 applied by the real runner;
//  3b. a guarded write as the service writes it (the acting user, a club role,
//      an item, its change row and request record, every deferred guard fired),
//      rolled back; the same write without the acting user refused (42501);
//   4. the read-only post-check (every ok column true, the old role tables'
//      fingerprint equal to the preflight's);
//   5. the runner again: v84 skipped by its checksum;
//   6. the rollback (docs/runbooks/permission-roles-v84-rollback.sql): the
//      catalog equal to the one before v84, the old rows untouched;
//   7. v84 applied again, the post-check again;
//  7b. the guarded write of 3b again, committed this time;
//   8. (M7) pg_dump -Fc of that database, pg_restore into a second disposable
//      database, and the catalog of v84's objects compared (constraints read
//      back by pg_get_constraintdef, the stored generated columns, triggers,
//      function bodies) - a CHECK that reads back differently fails here;
//   9. both disposable databases dropped, whatever happened.
//
// Safety: a loopback server only (localhost, 127.0.0.1, ::1); the two
// databases it creates are named optimove_tests_r2rehearsal_* and are the only
// ones it writes or drops; it takes no database name. The password is read
// from OPTIMOVE_REHEARSAL_PASSWORD (or PGPASSWORD) and never printed; pg_dump
// and pg_restore get host, port, user and database as arguments and inherit no
// other PG* variable. It needs psql-free Node with this repository's backend
// dependencies (`npm --prefix backend ci`), and pg_dump / pg_restore of the
// SAME major version as the server (on PATH, or --pg-bin <dir>). No admin
// rights: the user needs CREATEDB on the server (a superuser for the legacy
// seed replay, which the bootstrap requires: session_replication_role).
//
// Usage:
//   node backend/scripts/permission-roles-v84-rehearsal.mjs --host 127.0.0.1 --port 5432 --user postgres [--pg-bin <dir>]
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
const V84_FILE = "202611201300_roles_v84_permission_roles.sql";
const V84_NAME = `migrations_v2/${V84_FILE}`;
export const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const NAME_PREFIX = "optimove_tests_r2rehearsal_";

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

// pg_dump / pg_restore: host, port, user, database as arguments; only the password through the environment.
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

const CATALOG_SQL = `select
  (select string_agg(c.relname || ':' || c.relkind::text, ',' order by c.relname) from pg_class c where c.relnamespace = 'public'::regnamespace) as rels,
  (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ',' order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace = 'public'::regnamespace) as procs,
  (select string_agg(k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid), ',' order by k.conrelid::regclass::text, k.conname) from pg_constraint k where k.connamespace = 'public'::regnamespace) as cons,
  (select string_agg(t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgenabled::text, ',' order by t.tgrelid::regclass::text, t.tgname) from pg_trigger t where not t.tgisinternal and t.tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)) as trigs`;
// v84's objects only, for the dump read-back (M7).
const V84_CATALOG_SQL = `with t as (select oid from pg_class where relnamespace = 'public'::regnamespace and relname in ('permission_modules', 'permissions', 'permission_scope_types',
    'permission_roles', 'permission_role_items', 'permission_role_module_display', 'permission_role_changes', 'user_role_assignments', 'permission_requests', 'user_club_roles', 'user_team_roles'))
  select
  (select string_agg(k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid), E'\\n' order by k.conrelid::regclass::text, k.conname) from pg_constraint k where k.conrelid in (select oid from t)) as constraints,
  (select string_agg(a.attrelid::regclass::text || '.' || a.attname || '=' || a.attgenerated::text || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), E'\\n' order by a.attrelid::regclass::text, a.attname)
     from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where a.attrelid in (select oid from t) and a.attnum > 0 and not a.attisdropped) as columns,
  (select string_agg(g.tgrelid::regclass::text || '.' || g.tgname || ':' || g.tgenabled::text || g.tgdeferrable::text || g.tginitdeferred::text, E'\\n' order by g.tgrelid::regclass::text, g.tgname) from pg_trigger g where g.tgrelid in (select oid from t) and not g.tgisinternal) as triggers,
  (select string_agg(i.indexrelid::regclass::text || '=' || pg_get_indexdef(i.indexrelid), E'\\n' order by i.indexrelid::regclass::text) from pg_index i where i.indrelid in (select oid from t)) as indexes,
  (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), E'\\n' order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'permission\\_%' or p.proname in ('user_has_permission', 'user_holds_role_items', 'lock_permission_actor') or p.proname like 'user\\_role\\_assignments\\_%')) as functions,
  (select relrowsecurity::text from pg_class where oid = 'public.permission_roles'::regclass) as rls`;

function blocks(text) {
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
  // A block may start with `set local ...` (block 3): the last statement's row is the answer.
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

    // 1. Build to the migration before v84.
    const name = await created();
    const url = urlFor(args, name, password);
    const snapshotSql = fs.readFileSync(path.join(REPO, "backend", "tests", "support", "legacy-schema.sql"), "utf8");
    const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
    await bootstrapLegacySnapshot({ databaseUrl: url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-r2-rehearsal-"));
    const before = path.join(tmp, "migrations_v2");
    fs.mkdirSync(before);
    for (const f of fs.readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f !== V84_FILE) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(before, f));
    await runMigrations({ databaseUrl: url, migrationsRoot: before });
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const u = (await c.query(`insert into public.users (email, first_name, last_name, full_name) values ('rehearsal@test.local','R','2','R 2') returning id`)).rows[0].id;
      // One row in each old role table (an active and an inactive scoped row), so preflight 3a / post-check 6a
      // digest non-empty tables and the rollback is shown to leave them untouched. Only the two allowed literals;
      // this file is on R1's list of role-table writers on purpose (permissions-r1 c1), and it writes only its own
      // disposable database.
      const club = (await c.query(`insert into public.clubs (name) values ('Rehearsal club') returning id`)).rows[0].id;
      const team = (await c.query(`insert into public.teams (club_id, name) values ($1, 'Rehearsal team') returning id`, [club])).rows[0].id;
      await c.query(`insert into public.user_global_roles (user_id, role) values ($1,'platform_admin')`, [u]);
      await c.query(`insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'club_admin')`, [u, club]);
      await c.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1, $2, 'team_coach', false)`, [u, team]);
      const planted = (await c.query(`select (select count(*) from public.user_global_roles) as g, (select count(*) from public.user_club_roles) as cr,
          (select count(*) from public.user_team_roles) as tr`)).rows[0];
      if (!(Number(planted.g) > 0 && Number(planted.cr) > 0 && Number(planted.tr) > 0)) throw new Error("the old role rows were not planted");
      report("1. a disposable database through the migration before v84", true, name);

      // 2. Preflight.
      const pre = blocks(fs.readFileSync(path.join(RUNBOOKS, "permission-roles-v84-preflight.sql"), "utf8"));
      const preFalse = [];
      for (const [b, sql] of Object.entries(pre)) if (b !== "5") preFalse.push(...falseColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
      const fingerprint = await readOnly(c, pre["3a"]);
      const catalogBefore = (await c.query(CATALOG_SQL)).rows[0];
      report("2. preflight: every ok column true", preFalse.length === 0, preFalse.join(", "));

      // 3. Apply.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const recorded = (await c.query(`select checksum from public.schema_migrations where migration_name = $1`, [V84_NAME])).rows;
      const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V84_FILE))).digest("hex");
      report("3. v84 applied by the runner, recorded once with the file's sha256", recorded.length === 1 && recorded[0].checksum === sha);

      // 3b. (The review's D1) a real guarded write: every write guard reads xmin in plpgsql and
      // pg_current_xact_id() % 2^32 (permission_current_xmin) - the most version-sensitive part. One
      // transaction as the service writes it (the acting user set, a club role, one item, its change row and its
      // request record), every deferred guard fired by SET CONSTRAINTS ALL IMMEDIATE, then COMMIT (or, before the
      // rollback step, ROLLBACK: the rollback refuses once a role exists); the same write without the acting user
      // must be refused with 42501.
      const guardedWrite = async (label, { commit }) => {
        const roleName = `Rehearsal role ${label}`;
        let wrote = false; let detail = "";
        try {
          await c.query("begin");
          await c.query(`select set_config('optimove.permission_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [u]);
          const roleId = (await c.query(`insert into public.permission_roles (owner_scope, owner_club_id, name, assignable_club, assignable_team, created_by_user_id)
              values ('club', $1, $2, true, false, $3) returning id`, [club, roleName, u])).rows[0].id;
          await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, 'org.view', $2)`, [roleId, u]);
          const changeId = (await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, items_added, scope_types_added)
              values ($1, 1, 'create', $2, public.permission_actor_basis($2, 'roles.manage', 'club', $3), array['org.view'], array['club']) returning id`, [roleId, u, club])).rows[0].id;
          await c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, role_change_id)
              values (gen_random_uuid(), $1, 'role_create', $2, 'club', $3, public.permission_actor_basis($1, 'roles.manage', 'club', $3), $4)`, [u, "b".repeat(64), club, changeId]);
          await c.query("set constraints all immediate");
          await c.query(commit ? "commit" : "rollback");
          wrote = commit ? (await c.query(`select count(*)::int as n from public.permission_roles where name = $1`, [roleName])).rows[0].n === 1 : true;
        } catch (error) {
          await c.query("rollback").catch(() => {});
          detail = `${error?.code ?? ""} ${String(error?.message ?? "").slice(0, 120)}`;
        }
        let refused = false;
        try {
          await c.query("begin");
          await c.query(`insert into public.permission_roles (owner_scope, owner_club_id, name, assignable_club, assignable_team, created_by_user_id)
              values ('club', $1, $2, true, false, $3)`, [club, `${roleName} without actor`, u]);
          await c.query("set constraints all immediate");
        } catch (error) {
          refused = error?.code === "42501";
          if (!refused) detail += ` without actor: ${error?.code ?? ""}`;
        } finally {
          await c.query("rollback").catch(() => {});
        }
        return { ok: wrote && refused, detail: detail.trim() };
      };
      const gw1 = await guardedWrite("after apply", { commit: false });
      report("3b. a guarded write as the service writes it passes every guard (rolled back before the rollback step); without the acting user it is refused (42501)", gw1.ok, gw1.detail);

      // 4. Post-check.
      const post = blocks(fs.readFileSync(path.join(RUNBOOKS, "permission-roles-v84-postcheck.sql"), "utf8"));
      const postCheck = async () => {
        const bad = [];
        for (const [b, sql] of Object.entries(post)) if (b !== "6a") bad.push(...falseColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
        const same = JSON.stringify(await readOnly(c, post["6a"])) === JSON.stringify(fingerprint);
        if (!same) bad.push("6a: the old role tables changed");
        return bad;
      };
      const bad1 = await postCheck();
      report("4. post-check: every ok column true, 6a equal to preflight 3a", bad1.length === 0, bad1.join(", "));

      // 5. The runner again.
      const count = Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count);
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      report("5. the runner again: v84 skipped by its checksum", Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count) === count);

      // 6. Rollback.
      await c.query(fs.readFileSync(path.join(RUNBOOKS, "permission-roles-v84-rollback.sql"), "utf8"));
      const catalogAfter = (await c.query(CATALOG_SQL)).rows[0];
      const sameCatalog = JSON.stringify(catalogAfter) === JSON.stringify(catalogBefore);
      const sameRows = JSON.stringify(await readOnly(c, pre["3a"])) === JSON.stringify(fingerprint);
      report("6. rollback: the catalog equal to the one before v84, the old role rows untouched", sameCatalog && sameRows,
        sameCatalog ? "" : Object.keys(catalogBefore).filter((k) => catalogBefore[k] !== catalogAfter[k]).join(", "));

      // 7. Apply again.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const bad2 = await postCheck();
      report("7. v84 applied again; the post-check again", bad2.length === 0, bad2.join(", "));
      const gw2 = await guardedWrite("after re-apply", { commit: true });
      report("7b. the guarded write again, COMMITTED; without the acting user refused (42501)", gw2.ok, gw2.detail);

      // 8. M7: pg_dump -Fc and pg_restore into a second database, v84's catalog compared.
      const source = (await c.query(V84_CATALOG_SQL)).rows[0];
      const dumpFile = path.join(tmp, "v84.dump");
      await run(tool(args.pgBin, "pg_dump"), ["--format", "custom", "--file", dumpFile, ...conn(args, name)], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const copy = await created();
      await run(tool(args.pgBin, "pg_restore"), ["--exit-on-error", "--no-owner", ...conn(args, copy), dumpFile], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const r = new pg.Client({ connectionString: urlFor(args, copy, password) });
      await r.connect();
      try {
        const restored = (await r.query(V84_CATALOG_SQL)).rows[0];
        const differs = Object.keys(source).filter((k) => source[k] !== restored[k]);
        for (const k of differs) {
          const a = String(source[k]).split("\n"); const b = String(restored[k]).split("\n");
          for (const line of a.filter((x) => !b.includes(x)).slice(0, 5)) console.log(`      source only:   ${line}`);
          for (const line of b.filter((x) => !a.includes(x)).slice(0, 5)) console.log(`      restored only: ${line}`);
        }
        report("8. (M7) pg_dump / pg_restore read-back: v84's constraints, generated columns, triggers, indexes and functions identical", differs.length === 0, differs.join(", "));
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

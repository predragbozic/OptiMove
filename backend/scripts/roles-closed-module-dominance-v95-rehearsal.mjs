#!/usr/bin/env node
// The rehearsal of migration v95 (R2's dominance inside a club whose licence closes a module,
// docs/runbooks/roles-closed-module-dominance-v95.md) on ANY PostgreSQL server you point it at - written so that it runs
// unchanged on PostgreSQL 17 (production) as on 16. The shape of the earlier rehearsals (v93):
//
//   1. a disposable database built from the legacy snapshot and the real runner, every migration but v95; a club, a
//      team, its club admin and coach, a platform admin; the club's licence closes Tests (whose view words Team coach
//      and Club admin carry);
//   2. the read-only preflight (every ok column true);
//   3. v95 applied by the real runner, recorded once with the file's sha256;
//  3b. the club's admin writes a club version of Team coach as R4-3 writes it (rolled back): it passes; the same write
//      as a user who is no club admin is refused (42501);
//   4. the read-only post-check (every ok column true);
//   5. the runner again: v95 skipped by its checksum;
//   6. the rollback (docs/runbooks/roles-closed-module-dominance-v95-rollback.sql): the five bodies equal to the ones
//      before v95 (v92's four by md5, the helper gone), and the 3b write refused again (42501) - the gap v95 closes;
//   7. v95 applied again, the post-check again, the 3b write passing again;
//   8. pg_dump -Fc of that database, pg_restore into a second disposable database, the v95 bodies and the helper's
//      privileges compared;
//   9. both disposable databases dropped, whatever happened.
//
// Safety: a loopback server only (localhost, 127.0.0.1, ::1); the two databases it creates are named
// optimove_tests_v95rehearsal_* and are the only ones it writes or drops; it takes no database name. The password is
// read from OPTIMOVE_REHEARSAL_PASSWORD (or PGPASSWORD) and never printed; pg_dump and pg_restore get host, port, user
// and database as arguments and inherit no other PG* variable. It needs Node 20 or later with this repository's backend
// dependencies (`npm --prefix backend ci`), and pg_dump / pg_restore of the SAME major version as the server (on PATH,
// or --pg-bin <dir>). The user needs CREATEDB (a superuser for the legacy seed replay: session_replication_role).
//
// Usage:
//   node backend/scripts/roles-closed-module-dominance-v95-rehearsal.mjs --host 127.0.0.1 --port 5432 --user postgres [--pg-bin <dir>]
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
export const V95_FILE = "202611271000_roles_v95_closed_module_dominance.sql";
const V95_NAME = `migrations_v2/${V95_FILE}`;
export const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const NAME_PREFIX = "optimove_tests_v95rehearsal_";
export const MIN_NODE_MAJOR = 20;
const TEAM_COACH = "00000000-0000-4000-8000-000000000843";
const FUNCTIONS = ["permission_actor_holds_in_club", "permission_club_role_version_items_guard", "permission_club_role_versions_complete",
  "permission_custom_role_items_guard", "permission_custom_roles_complete"];

export function nodeMajorOk(version = process.versions.node) {
  return Number(String(version).split(".")[0]) >= MIN_NODE_MAJOR;
}

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

// The five bodies v95 touches (absent ones read as "-") and the helper's PUBLIC privilege.
export const CATALOG_SQL = `select
  (select string_agg(n || '=' || coalesce((select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = n), '-'), E'\\n' order by n)
     from unnest($1::text[]) n) as functions,
  (select coalesce(has_function_privilege('public', p.oid, 'execute')::text, '-') from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'permission_actor_holds_in_club') as helper_public`;

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
    console.log(`server: PostgreSQL ${version.v} on ${args.host}:${args.port}; node ${process.versions.node}`);
    const dumpMajor = Number(((await run(tool(args.pgBin, "pg_dump"), ["--version"], { env: toolEnv(password), windowsHide: true })).stdout.match(/(\d+)(\.\d+)?/) || [])[1]);
    const restoreMajor = Number(((await run(tool(args.pgBin, "pg_restore"), ["--version"], { env: toolEnv(password), windowsHide: true })).stdout.match(/(\d+)(\.\d+)?/) || [])[1]);
    report("tools: pg_dump and pg_restore of the server's major version", dumpMajor === Math.floor(version.n / 10000) && restoreMajor === dumpMajor, `server ${Math.floor(version.n / 10000)}, pg_dump ${dumpMajor}, pg_restore ${restoreMajor}`);

    // 1. Build to every migration but v95.
    const name = await created();
    const url = urlFor(args, name, password);
    const snapshotSql = fs.readFileSync(path.join(REPO, "backend", "tests", "support", "legacy-schema.sql"), "utf8");
    const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
    await bootstrapLegacySnapshot({ databaseUrl: url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-v95-rehearsal-"));
    const before = path.join(tmp, "migrations_v2");
    fs.mkdirSync(before);
    for (const f of fs.readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f < V95_FILE) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(before, f));
    await runMigrations({ databaseUrl: url, migrationsRoot: before });
    // Every migration up to and including v95, never a later one (v96 replaces v95's helper; its own rehearsal covers it).
    // The runner records a migration by its folder's name, so this folder is called migrations_v2 too.
    const upToV95 = path.join(tmp, "up-to-v95", "migrations_v2");
    fs.mkdirSync(upToV95, { recursive: true });
    for (const f of fs.readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f <= V95_FILE) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(upToV95, f));
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const user = async (label) => (await c.query(`insert into public.users (email, first_name, last_name, full_name, is_active) values ($1,'V','95','V 95', true) returning id`,
        [`v95-${label}-${crypto.randomBytes(3).toString("hex")}@test.local`])).rows[0].id;
      const clubAdmin = await user("admin");
      const stranger = await user("stranger");
      const pa = await user("pa");
      await c.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'platform_admin', true)`, [pa]);
      const club = (await c.query(`insert into public.clubs (name, is_active) values ('Rehearsal club', true) returning id`)).rows[0].id;
      await c.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1, $2, 'club_admin', true)`, [clubAdmin, club]);
      // The licence closes Tests, as a platform admin writes it.
      await c.query("begin");
      await c.query(`select set_config('optimove.permission_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [pa]);
      await c.query(`select public.lock_club_ceiling($1::uuid[], 'exclusive')`, [[club]]);
      await c.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, 'tests', $2, 'licence')`, [club, pa]);
      await c.query(`insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason) values ($1, 'tests', 'close', $2, 'licence')`, [club, pa]);
      await c.query("commit");
      report("1. a disposable database through every migration but v95; a club with its admin, its licence closing Tests", true, name);

      // The write of 3b: a club version of Team coach without athletes.remove, as the acting user, rolled back.
      const versionWrite = async (actor) => {
        try {
          await c.query("begin");
          await c.query(`select set_config('optimove.permission_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [actor]);
          await c.query(`select public.lock_club_ceiling($1::uuid[], 'exclusive')`, [[club]]);
          const rev = (await c.query(`select revision from public.permission_roles where id = $1`, [TEAM_COACH])).rows[0].revision;
          const id = (await c.query(`insert into public.permission_club_role_versions (club_id, system_role_id, based_on_revision, answered_revision, created_by_user_id)
              values ($1, $2, $3, $3, $4) returning id`, [club, TEAM_COACH, rev, actor])).rows[0].id;
          const items = (await c.query(`select array(select permission_word from public.permission_role_items where role_id = $1 and permission_word <> 'athletes.remove') as w`, [TEAM_COACH])).rows[0].w;
          for (const w of items) await c.query(`insert into public.permission_club_role_version_items (version_id, permission_word) values ($1, $2)`, [id, w]);
          const basis = (await c.query(`select public.permission_actor_basis($1, 'roles.manage', 'club', $2) as b`, [actor, club])).rows[0].b;
          await c.query(`insert into public.permission_club_role_version_changes (version_id, revision_after, kind, performed_by_user_id, basis, reason, items_added)
              values ($1, 1, 'create', $2, $3, 'rehearsal', $4)`, [id, actor, basis, items]);
          await c.query("set constraints all immediate");
          return "none";
        } catch (error) {
          return error?.code ?? "?";
        } finally {
          await c.query("rollback").catch(() => {});
        }
      };

      // 2. Preflight.
      const pre = blocks(fs.readFileSync(path.join(RUNBOOKS, "roles-closed-module-dominance-v95-preflight.sql"), "utf8"));
      const preFalse = [];
      for (const [b, sql] of Object.entries(pre)) preFalse.push(...falseColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
      const catalogBefore = (await c.query(CATALOG_SQL, [FUNCTIONS])).rows[0];
      const beforeWrite = await versionWrite(clubAdmin);
      report("2. preflight: every ok column true; before v95 the club admin's version is refused (the gap)", preFalse.length === 0 && beforeWrite === "42501", `${preFalse.join(", ")} write: ${beforeWrite}`);

      // 3. Apply.
      await runMigrations({ databaseUrl: url, migrationsRoot: upToV95 });
      const recorded = (await c.query(`select checksum from public.schema_migrations where migration_name = $1`, [V95_NAME])).rows;
      const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V95_FILE))).digest("hex");
      report("3. v95 applied by the runner, recorded once with the file's sha256", recorded.length === 1 && recorded[0].checksum === sha);
      const admitted = await versionWrite(clubAdmin);
      const strangerCode = await versionWrite(stranger);
      report("3b. the club admin's version passes (rolled back); a user who is no club admin is refused (42501)", admitted === "none" && strangerCode === "42501", `admin: ${admitted}; stranger: ${strangerCode}`);

      // 4. Post-check.
      const post = blocks(fs.readFileSync(path.join(RUNBOOKS, "roles-closed-module-dominance-v95-postcheck.sql"), "utf8"));
      const postCheck = async () => {
        const bad = [];
        for (const [b, sql] of Object.entries(post)) bad.push(...falseColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
        return bad;
      };
      const bad1 = await postCheck();
      report("4. post-check: every ok column true", bad1.length === 0, bad1.join(", "));

      // 5. The runner again.
      const count = Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count);
      await runMigrations({ databaseUrl: url, migrationsRoot: upToV95 });
      report("5. the runner again: v95 skipped by its checksum", Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count) === count);

      // 6. Rollback.
      const rollbackSql = fs.readFileSync(path.join(RUNBOOKS, "roles-closed-module-dominance-v95-rollback.sql"), "utf8");
      await c.query(rollbackSql);
      const catalogAfter = (await c.query(CATALOG_SQL, [FUNCTIONS])).rows[0];
      const sameCatalog = JSON.stringify(catalogAfter) === JSON.stringify(catalogBefore);
      const afterRollback = await versionWrite(clubAdmin);
      report("6. rollback: the bodies equal to the ones before v95 (v92's by md5, the helper gone); the write refused again", sameCatalog && afterRollback === "42501",
        `${sameCatalog ? "" : "catalog differs; "}write: ${afterRollback}`);

      // 7. Apply again.
      await runMigrations({ databaseUrl: url, migrationsRoot: upToV95 });
      const bad2 = await postCheck();
      const again = await versionWrite(clubAdmin);
      report("7. v95 applied again; the post-check again; the write passes again", bad2.length === 0 && again === "none", `${bad2.join(", ")} write: ${again}`);

      // 8. pg_dump -Fc and pg_restore into a second database, the bodies and the privilege compared.
      const source = (await c.query(CATALOG_SQL, [FUNCTIONS])).rows[0];
      const dumpFile = path.join(tmp, "v95.dump");
      await run(tool(args.pgBin, "pg_dump"), ["--format", "custom", "--file", dumpFile, ...conn(args, name)], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const copy = await created();
      await run(tool(args.pgBin, "pg_restore"), ["--exit-on-error", "--no-owner", ...conn(args, copy), dumpFile], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const r = new pg.Client({ connectionString: urlFor(args, copy, password) });
      await r.connect();
      try {
        const restored = (await r.query(CATALOG_SQL, [FUNCTIONS])).rows[0];
        const differs = Object.keys(source).filter((k) => source[k] !== restored[k]);
        report("8. pg_dump / pg_restore read-back: the five bodies and the helper's privilege identical", differs.length === 0, differs.join(", "));
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
  if (!nodeMajorOk()) {
    console.error(`refusing: Node ${MIN_NODE_MAJOR} or later is needed (this is ${process.versions.node})`);
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

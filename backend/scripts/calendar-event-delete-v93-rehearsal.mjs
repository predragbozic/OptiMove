#!/usr/bin/env node
// The rehearsal of migration v93 (central calendar: delete an event that holds nothing,
// docs/runbooks/calendar-event-delete-v93.md) on ANY PostgreSQL server you point it at - written so that it runs
// unchanged on PostgreSQL 17 (production) as on 16. The shape of the earlier rehearsals (session types v89):
//
//   1. a disposable database built from the legacy snapshot and the real runner, every migration but v93; a club with
//      its event types, a team, its coach and one planted event (with its target, request and change rows);
//   2. the read-only preflight (every ok column true);
//   3. v93 applied by the real runner, recorded once with the file's sha256;
//  3b. a sanctioned delete as the service sends it (calendar.delete_event on the coach's team_coach basis), rolled
//      back; the same call for another user refused (42501); a raw delete of the event refused (23514);
//   4. the read-only post-check (every ok column true);
//   5. the runner again: v93 skipped by its checksum;
//   6. the rollback (docs/runbooks/calendar-event-delete-v93-rollback.sql): the catalog of the calendar schema equal to
//      the one before v93 (v49's two bodies back by md5), the planted rows untouched;
//   7. v93 applied again, the post-check again;
//  7b. the sanctioned delete again, COMMITTED (the event and its own rows gone, one log row); the rollback then
//      refuses (23514) and changes nothing;
//   8. pg_dump -Fc of that database, pg_restore into a second disposable database, and the catalog of v93's objects
//      compared (constraints read back by pg_get_constraintdef, triggers, indexes, function bodies, the log row);
//   9. both disposable databases dropped, whatever happened.
//
// Safety: a loopback server only (localhost, 127.0.0.1, ::1); the two databases it creates are named
// optimove_tests_v93rehearsal_* and are the only ones it writes or drops; it takes no database name. The password is
// read from OPTIMOVE_REHEARSAL_PASSWORD (or PGPASSWORD) and never printed; pg_dump and pg_restore get host, port, user
// and database as arguments and inherit no other PG* variable. It needs Node with this repository's backend dependencies
// (`npm --prefix backend ci`), and pg_dump / pg_restore of the SAME major version as the server (on PATH, or
// --pg-bin <dir>). The user needs CREATEDB (a superuser for the legacy seed replay: session_replication_role).
//
// Usage:
//   node backend/scripts/calendar-event-delete-v93-rehearsal.mjs --host 127.0.0.1 --port 5432 --user postgres [--pg-bin <dir>]
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
export const V93_FILE = "202611251000_calendar_v93_event_delete.sql";
const V93_NAME = `migrations_v2/${V93_FILE}`;
export const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const NAME_PREFIX = "optimove_tests_v93rehearsal_";

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

// The calendar schema's catalog (what v93 and its rollback touch), sorted by its text.
export const CATALOG_SQL = `select
  (select string_agg(x, E'\\n' order by x) from (select g.tgrelid::regclass::text || '.' || g.tgname || ':' || g.tgfoid::regproc::text || ':' || g.tgtype::text || g.tgenabled::text || g.tgdeferrable::text || g.tginitdeferred::text as x
     from pg_trigger g where not g.tgisinternal and g.tgrelid::regclass::text like 'calendar.%') t) as triggers,
  (select string_agg(x, E'\\n' order by x) from (select p.oid::regprocedure::text || '=' || md5(p.prosrc) as x from pg_proc p where p.pronamespace = 'calendar'::regnamespace) f) as functions,
  (select string_agg(x, E'\\n' order by x) from (select k.conrelid::regclass::text || '.' || k.conname as x from pg_constraint k join pg_class c on c.oid = k.conrelid where c.relnamespace = 'calendar'::regnamespace) k) as constraints,
  (select string_agg(x, ',' order by x) from (select c.oid::regclass::text as x from pg_class c where c.relnamespace = 'calendar'::regnamespace) r) as relations`;
// v93's objects only, for the dump read-back.
const V93_CATALOG_SQL = `select
  (select string_agg(x, E'\\n' order by x) from (select k.conname || '=' || pg_get_constraintdef(k.oid) as x from pg_constraint k where k.conrelid = 'calendar.event_deletion_log'::regclass) k) as constraints,
  (select string_agg(x, E'\\n' order by x) from (select g.tgrelid::regclass::text || '.' || g.tgname || ':' || g.tgfoid::regproc::text || ':' || g.tgtype::text || g.tgenabled::text || g.tgdeferrable::text || g.tginitdeferred::text as x
     from pg_trigger g where not g.tgisinternal and g.tgrelid::regclass::text like 'calendar.%') t) as triggers,
  (select string_agg(x, E'\\n' order by x) from (select pg_get_indexdef(i.indexrelid) as x from pg_index i where i.indrelid = 'calendar.event_deletion_log'::regclass) i) as indexes,
  (select string_agg(x, E'\\n' order by x) from (select p.oid::regprocedure::text || '=' || md5(p.prosrc) as x from pg_proc p where p.pronamespace = 'calendar'::regnamespace) f) as functions,
  (select string_agg(event_id::text || '=' || title || ':' || basis, ',' order by event_id::text) from calendar.event_deletion_log) as log_rows`;

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

    // 1. Build to every migration but v93.
    const name = await created();
    const url = urlFor(args, name, password);
    const snapshotSql = fs.readFileSync(path.join(REPO, "backend", "tests", "support", "legacy-schema.sql"), "utf8");
    const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
    await bootstrapLegacySnapshot({ databaseUrl: url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-v93-rehearsal-"));
    const before = path.join(tmp, "migrations_v2");
    fs.mkdirSync(before);
    for (const f of fs.readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f !== V93_FILE) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(before, f));
    await runMigrations({ databaseUrl: url, migrationsRoot: before });
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const user = async (label) => (await c.query(`insert into public.users (email, first_name, last_name, full_name) values ($1,'V','93','V 93') returning id`, [`v93-${label}-${crypto.randomBytes(3).toString("hex")}@test.local`])).rows[0].id;
      const coach = await user("coach");
      const stranger = await user("stranger");
      const club = (await c.query(`insert into public.clubs (name) values ('Rehearsal club') returning id`)).rows[0].id;
      await c.query(`select calendar.seed_club_event_types($1)`, [club]);
      const team = (await c.query(`insert into public.teams (club_id, name) values ($1, 'Rehearsal team') returning id`, [club])).rows[0].id;
      await c.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1, $2, 'team_coach', true)`, [coach, team]);
      const type = (await c.query(`select id from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 and kind = 'training'`, [club])).rows[0].id;
      // One event as the service writes it: the event, its target, its request record and its change row.
      await c.query("begin");
      const event = (await c.query(`insert into calendar.events (owner_scope, owner_team_id, event_type_id, title, day, timezone, created_by_user_id)
          values ('team', $1, $2, 'Rehearsal training', '2026-12-01', 'UTC', $3) returning id`, [team, type, coach])).rows[0].id;
      await c.query(`insert into calendar.event_targets (event_id, target_kind, target_team_id) values ($1, 'team', $2)`, [event, team]);
      const request = (await c.query(`insert into calendar.event_requests (request_key, request_hash, operation, performed_by_user_id, event_id, result)
          values (gen_random_uuid(), repeat('d', 64), 'create', $1, $2, '{}'::jsonb) returning id`, [coach, event])).rows[0].id;
      await c.query(`insert into calendar.event_changes (event_id, kind, basis, performed_by_user_id, request_id, revision) values ($1, 'create', 'team_coach', $2, $3, 1)`, [event, coach, request]);
      await c.query("commit");
      const plantedDigest = async () => (await c.query(
        `select md5(coalesce((select string_agg(e::text, ';') from calendar.events e where e.id = $1), '') ||
                    coalesce((select string_agg(t::text, ';') from calendar.event_targets t where t.event_id = $1), '') ||
                    coalesce((select string_agg(r::text, ';') from calendar.event_requests r where r.event_id = $1), '')) as d`, [event])).rows[0].d;
      const digest0 = await plantedDigest();
      report("1. a disposable database through every migration but v93; a club, a team, its coach and one event planted", true, name);

      // 2. Preflight.
      const pre = blocks(fs.readFileSync(path.join(RUNBOOKS, "calendar-event-delete-v93-preflight.sql"), "utf8"));
      const preFalse = [];
      for (const [b, sql] of Object.entries(pre)) preFalse.push(...falseColumns(await readOnly(c, sql)).map((k) => `${b}.${k}`));
      const catalogBefore = (await c.query(CATALOG_SQL)).rows[0];
      report("2. preflight: every ok column true", preFalse.length === 0, preFalse.join(", "));

      // 3. Apply.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const recorded = (await c.query(`select checksum from public.schema_migrations where migration_name = $1`, [V93_NAME])).rows;
      const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V93_FILE))).digest("hex");
      report("3. v93 applied by the runner, recorded once with the file's sha256", recorded.length === 1 && recorded[0].checksum === sha);

      // 3b. The sanctioned delete as the service sends it; another user refused; a raw delete refused.
      const sanctioned = async ({ commit }) => {
        let detail = "";
        let ok = false;
        const codeOf = async (sql, params) => {
          try { await c.query("begin"); await c.query(sql, params); await c.query("set constraints all immediate"); return "none"; } catch (error) { return error?.code ?? "?"; } finally { await c.query("rollback").catch(() => {}); }
        };
        const strangerCode = await codeOf(`select calendar.delete_event($1, 1, $2, 'team_coach', gen_random_uuid(), repeat('e', 64), '{}'::jsonb)`, [event, stranger]);
        const rawCode = await codeOf(`delete from calendar.events where id = $1`, [event]);
        try {
          await c.query("begin");
          await c.query(`select calendar.delete_event($1, 1, $2, 'team_coach', gen_random_uuid(), repeat('e', 64), '{"httpStatus":200}'::jsonb)`, [event, coach]);
          await c.query("set constraints all immediate");
          const left = (await c.query(`select (select count(*) from calendar.events where id = $1) + (select count(*) from calendar.event_targets where event_id = $1)
              + (select count(*) from calendar.event_requests where event_id = $1) + (select count(*) from calendar.event_changes where event_id = $1) as n`, [event])).rows[0].n;
          const logged = (await c.query(`select count(*)::int as n from calendar.event_deletion_log where event_id = $1`, [event])).rows[0].n;
          await c.query(commit ? "commit" : "rollback");
          ok = Number(left) === 0 && logged === 1;
          detail = `rows left ${left}, log rows ${logged}`;
        } catch (error) {
          await c.query("rollback").catch(() => {});
          detail = `${error?.code ?? ""} ${String(error?.message ?? "").slice(0, 120)}`;
        }
        return { ok: ok && strangerCode === "42501" && rawCode === "23514", detail: `${detail}; another user: ${strangerCode}; raw delete: ${rawCode}` };
      };
      const s1 = await sanctioned({ commit: false });
      report("3b. the sanctioned delete passes (rolled back); another user 42501; a raw delete 23514; the event is still there", s1.ok && (await plantedDigest()) === digest0, s1.detail);

      // 4. Post-check.
      const post = blocks(fs.readFileSync(path.join(RUNBOOKS, "calendar-event-delete-v93-postcheck.sql"), "utf8"));
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
      report("5. the runner again: v93 skipped by its checksum", Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count) === count);

      // 6. Rollback.
      const rollbackSql = fs.readFileSync(path.join(RUNBOOKS, "calendar-event-delete-v93-rollback.sql"), "utf8");
      await c.query(rollbackSql);
      const catalogAfter = (await c.query(CATALOG_SQL)).rows[0];
      const sameCatalog = JSON.stringify(catalogAfter) === JSON.stringify(catalogBefore);
      report("6. rollback: the calendar catalog equal to the one before v93 (v49's two bodies by md5), the planted rows untouched", sameCatalog && (await plantedDigest()) === digest0,
        sameCatalog ? "" : Object.keys(catalogBefore).filter((k) => catalogBefore[k] !== catalogAfter[k]).join(", "));

      // 7. Apply again.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const bad2 = await postCheck();
      report("7. v93 applied again; the post-check again", bad2.length === 0, bad2.join(", "));
      const s2 = await sanctioned({ commit: true });
      let refused = "none";
      try { await c.query(rollbackSql); } catch (error) { refused = error?.code ?? "?"; }
      await c.query("rollback").catch(() => {});
      const still = (await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V93_NAME])).rows[0].n;
      report("7b. the sanctioned delete again, COMMITTED; the rollback then refuses (23514) and changes nothing", s2.ok && refused === "23514" && still === 1, `${s2.detail}; rollback: ${refused}`);

      // 8. pg_dump -Fc and pg_restore into a second database, v93's catalog compared.
      const source = (await c.query(V93_CATALOG_SQL)).rows[0];
      const dumpFile = path.join(tmp, "v93.dump");
      await run(tool(args.pgBin, "pg_dump"), ["--format", "custom", "--file", dumpFile, ...conn(args, name)], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const copy = await created();
      await run(tool(args.pgBin, "pg_restore"), ["--exit-on-error", "--no-owner", ...conn(args, copy), dumpFile], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const r = new pg.Client({ connectionString: urlFor(args, copy, password) });
      await r.connect();
      try {
        const restored = (await r.query(V93_CATALOG_SQL)).rows[0];
        // A restored CHECK over a text list can be printed back with its casts and parentheses placed differently; the
        // constraints are compared with the casts and parentheses removed, every other column byte for byte.
        const normal = (text) => String(text).split("\n").map((l) => l.replace(/::character varying|::text\[\]|::text/g, "").replace(/[()\s]/g, "")).join("\n");
        const same = (k) => (k === "constraints" ? normal(source[k]) === normal(restored[k]) : source[k] === restored[k]);
        const differs = Object.keys(source).filter((k) => !same(k));
        for (const k of differs) {
          const a = String(source[k]).split("\n"); const b = String(restored[k]).split("\n");
          for (const line of a.filter((x) => !b.includes(x)).slice(0, 5)) console.log(`      source only:   ${line}`);
          for (const line of b.filter((x) => !a.includes(x)).slice(0, 5)) console.log(`      restored only: ${line}`);
        }
        report("8. pg_dump / pg_restore read-back: v93's constraints, triggers, indexes, functions and the log row identical", differs.length === 0, differs.join(", "));
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

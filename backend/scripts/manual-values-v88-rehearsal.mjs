#!/usr/bin/env node
// The rehearsal of migration v88 (manual values on the roster, ST-4 of docs/ai/session-type-plan.md) on ANY PostgreSQL
// server you point it at - written so that it runs unchanged on PostgreSQL 17 (production runs 17.6) as on 16. The v85
// rehearsal's shape (backend/scripts/session-types-v85-rehearsal.mjs):
//
//   1. a disposable database built from the legacy snapshot and the real runner, every migration before v88;
//   2. the read-only preflight (docs/runbooks/manual-values-v88-preflight.sql; every boolean true);
//   3. v88 applied by the real runner, recorded once with the file's sha256;
//  3b. a guarded write as the service writes it (the acting user, a manual whole-session occasion of a session's
//      participant, one value, its provenance row 'entry', every deferred guard fired), rolled back; and the refusals: a
//      provenance row without the acting user, a forged author, a manual occasion left without its provenance at COMMIT, a
//      value added to an occasion that has its provenance, a TRUNCATE of the provenance table;
//   4. the read-only post-check (docs/runbooks/manual-values-v88-postcheck.sql; every boolean true);
//   5. the runner again: v88 skipped by its checksum;
//   6. the rollback (docs/runbooks/manual-values-v88-rollback.sql): the catalog equal to the one before v88;
//   7. v88 applied again, the post-check again;
//  7b. the guarded write of 3b again, COMMITTED this time; then the rollback refuses (a manual value was written) and
//      changes nothing;
//   8. pg_dump -Fc of that database, pg_restore into a second disposable database, and the catalog of v88's objects
//      compared (constraints read back by pg_get_constraintdef, triggers, indexes, function bodies);
//   9. both disposable databases dropped, whatever happened.
//
// Safety: a loopback server only (localhost, 127.0.0.1, ::1); the two databases it creates are named
// optimove_tests_st4rehearsal_* and are the only ones it writes or drops; it takes no database name. The password is
// read from OPTIMOVE_REHEARSAL_PASSWORD (or PGPASSWORD) and never printed; pg_dump and pg_restore get host, port, user
// and database as arguments and inherit no other PG* variable. It needs Node with this repository's backend dependencies
// (`npm --prefix backend ci`), and pg_dump / pg_restore of the SAME major version as the server (on PATH, or
// --pg-bin <dir>). The user needs CREATEDB (a superuser for the legacy seed replay: session_replication_role).
//
// Usage:
//   node backend/scripts/manual-values-v88-rehearsal.mjs --host 127.0.0.1 --port 5432 --user postgres [--pg-bin <dir>]
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
const V88_FILE = "202611221300_training_load_v88_manual_values.sql";
const V88_NAME = `migrations_v2/${V88_FILE}`;
export const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const NAME_PREFIX = "optimove_tests_st4rehearsal_";

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
const redact = (text) => String(text).replace(/postgres:\/\/[^@\s]*@/g, "postgres://***@");

const results = [];
function report(step, ok, detail = "") {
  results.push({ step, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` - ${detail}` : ""}`);
}

// The two schemas v88 touches: relations, every column of their tables, function bodies, constraints, triggers, indexes.
export const CATALOG_SQL = `with s as (select oid from pg_namespace where nspname in ('training', 'training_load'))
  select
  (select string_agg(x, ',' order by x) from (select c.relnamespace::regnamespace::text || '.' || c.relname || ':' || c.relkind::text x from pg_class c where c.relnamespace in (select oid from s)) q) as rels,
  (select string_agg(x, ',' order by x) from (select a.attrelid::regclass::text || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') x
     from pg_attribute a join pg_class c on c.oid = a.attrelid left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where c.relnamespace in (select oid from s) and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped) q) as columns,
  (select string_agg(x, ',' order by x) from (select p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proconfig, ';'), '') x from pg_proc p where p.pronamespace in (select oid from s)) q) as procs,
  (select string_agg(x, ',' order by x) from (select k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid) x from pg_constraint k where k.connamespace in (select oid from s)) q) as cons,
  (select string_agg(x, ',' order by x) from (select t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgenabled::text || ':' || pg_get_triggerdef(t.oid) x from pg_trigger t
     where not t.tgisinternal and t.tgrelid in (select oid from pg_class where relnamespace in (select oid from s))) q) as trigs,
  (select string_agg(x, ',' order by x) from (select i.indexrelid::regclass::text || '=' || pg_get_indexdef(i.indexrelid) x from pg_index i join pg_class c on c.oid = i.indrelid where c.relnamespace in (select oid from s)) q) as idx`;
// v88's objects only, for the dump read-back.
const V88_CATALOG_SQL = `with t as (select oid from pg_class where oid in ('training_load.metric_manual_values'::regclass, 'training_load.import_deletion_log'::regclass,
    'training_load.gpexe_import_approvals'::regclass, 'training_load.metric_measurement_occasions'::regclass, 'training_load.metric_values'::regclass))
  select
  (select string_agg(x, E'\\n' order by x) from (select k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid) x from pg_constraint k where k.conrelid in (select oid from t)) q) as constraints,
  (select string_agg(x, E'\\n' order by x) from (select g.tgrelid::regclass::text || '.' || g.tgname || ':' || g.tgenabled::text || g.tgdeferrable::text || g.tginitdeferred::text || ':' || pg_get_triggerdef(g.oid) x from pg_trigger g where g.tgrelid in (select oid from t) and not g.tgisinternal) q) as triggers,
  (select string_agg(x, E'\\n' order by x) from (select i.indexrelid::regclass::text || '=' || pg_get_indexdef(i.indexrelid) x from pg_index i where i.indrelid in (select oid from t)) q) as indexes,
  (select string_agg(x, E'\\n' order by x) from (select p.oid::regprocedure::text || '=' || md5(p.prosrc) x from pg_proc p
     where p.proname in ('manual_value_context_actor', 'manual_value_actor_is_set', 'validate_metric_manual_value', 'protect_metric_manual_values',
                         'forbid_value_after_manual_provenance', 'check_manual_value_has_provenance', 'session_undo_manual_log_ok',
                         'undo_imported_session', 'session_undo_scope', 'activity_roster_needs_state')) q) as functions`;

// Every boolean column of every result of a whole (read-only) runbook file.
async function booleansOf(client, sql) {
  const out = [];
  for (const res of [].concat(await client.query(sql))) for (const row of res.rows || []) for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") out.push([k, v]);
  return out;
}
const falseOnes = (pairs) => pairs.filter(([, v]) => v !== true).map(([k]) => k);

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

    // 1. Build to the migration before v88.
    const name = await created();
    const url = urlFor(args, name, password);
    const snapshotSql = fs.readFileSync(path.join(REPO, "backend", "tests", "support", "legacy-schema.sql"), "utf8");
    const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
    await bootstrapLegacySnapshot({ databaseUrl: url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-st4-rehearsal-"));
    const before = path.join(tmp, "migrations_v2");
    fs.mkdirSync(before);
    for (const f of fs.readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f !== V88_FILE) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(before, f));
    await runMigrations({ databaseUrl: url, migrationsRoot: before });
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const notYet = (await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V88_NAME])).rows[0].n === 0;
      // One user (a team coach), a team, an athlete and a session with its participant: the world of the guarded write.
      const u = (await c.query(`insert into public.users (email, first_name, last_name, full_name) values ('st4-rehearsal@test.local','S','4','S 4') returning id`)).rows[0].id;
      const club = (await c.query(`insert into public.clubs (name) values ('Rehearsal club') returning id`)).rows[0].id;
      const team = (await c.query(`insert into public.teams (club_id, name) values ($1, 'Rehearsal team') returning id`, [club])).rows[0].id;
      await c.query(`insert into public.user_team_roles (user_id, team_id, role) values ($1, $2, 'team_coach')`, [u, team]);
      const athlete = (await c.query(`insert into public.athletes (athlete_id, first_name, last_name, full_name, display_name, club_id, team_id) values ('st4-rehearsal', 'Rehearsal', 'Athlete', 'Rehearsal Athlete', 'Rehearsal Athlete', $1, $2) returning id`, [club, team])).rows[0].id;
      const event = (await c.query(`insert into training_load.metric_events (occurred_date, scope_level, owner_scope, owner_team_id) values ('2026-11-20','session','team',$1) returning id`, [team])).rows[0].id;
      const participant = (await c.query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,'UTC') returning id`, [event, athlete])).rows[0].id;
      // One club variable measured per session, with its first version (the shape v77's rehearsal uses).
      const definitionId = (await c.query(`insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id) values ('st4_rehearsal_distance', 'Rehearsal distance', 'club', $1) returning id`, [club])).rows[0].id;
      await c.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, 'session')`, [definitionId]);
      const versionId = (await c.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1, 1, 'm', 'numeric') returning id`, [definitionId])).rows[0].id;
      await c.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [versionId, definitionId]);
      const definition = { id: definitionId, current_version_id: versionId };
      report("1. a disposable database through the migration before v88; a session with one participant", notYet && Boolean(definition), name);

      // 2. Preflight.
      const pre = await booleansOf(c, fs.readFileSync(path.join(RUNBOOKS, "manual-values-v88-preflight.sql"), "utf8"));
      const catalogBefore = (await c.query(CATALOG_SQL)).rows[0];
      report("2. preflight: every boolean true", pre.length >= 12 && falseOnes(pre).length === 0, `${pre.length} booleans${falseOnes(pre).length ? `; false: ${falseOnes(pre).join(", ")}` : ""}`);

      // 3. Apply.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const recorded = (await c.query(`select checksum from public.schema_migrations where migration_name = $1`, [V88_NAME])).rows;
      const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V88_FILE))).digest("hex");
      report("3. v88 applied by the runner, recorded once with the file's sha256", recorded.length === 1 && recorded[0].checksum === sha, `sha256 ${sha}`);

      // 3b. A guarded write as the service writes it, and the refusals.
      const setActor = (userId) => c.query(`select set_config('optimove.manual_value_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [userId]);
      const newOccasion = async () => (await c.query(`insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1, 'manual', $2) returning id`, [participant, u])).rows[0].id;
      const provenance = (occasion, author) => c.query(`insert into training_load.metric_manual_values (occasion_id, kind, entered_by_user_id, entered_by_basis, request_key, request_hash) values ($1, 'entry', $2, 'team_coach', gen_random_uuid(), repeat('a', 64))`, [occasion, author]);
      const refusedWith = async (fn) => {
        try {
          await c.query("begin");
          await fn();
          await c.query("commit");
          return "none";
        } catch (error) {
          return `${error?.code ?? "?"} ${String(error?.message ?? "").slice(0, 120)}`;
        } finally {
          await c.query("rollback").catch(() => {});
        }
      };
      const guardedWrite = async ({ commit }) => {
        let ok = false; let detail = "";
        try {
          await c.query("begin");
          await setActor(u);
          const occasion = await newOccasion();
          await c.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1, $2, $3, 1234)`, [occasion, definition.id, definition.current_version_id]);
          await provenance(occasion, u);
          await c.query("set constraints all immediate");
          await c.query(commit ? "commit" : "rollback");
          ok = true;
        } catch (error) {
          await c.query("rollback").catch(() => {});
          detail = `${error?.code ?? ""} ${String(error?.message ?? "").slice(0, 120)}`;
        }
        const noActor = await refusedWith(async () => provenance(await newOccasion(), u));
        const forged = await refusedWith(async () => { await setActor(crypto.randomUUID()); await provenance(await newOccasion(), u); });
        const orphan = await refusedWith(async () => { await setActor(u); await newOccasion(); });
        const closed = await refusedWith(async () => {
          await setActor(u);
          const occasion = await newOccasion();
          await provenance(occasion, u);
          await c.query(`insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric) values ($1, $2, $3, 1)`, [occasion, definition.id, definition.current_version_id]);
        });
        const truncate = await refusedWith(() => c.query("truncate training_load.metric_manual_values"));
        const refusals = { "without the acting user": /no acting user/.test(noActor), "a forged author": /author must be the acting user/.test(forged),
          "no provenance by COMMIT": /needs its provenance row/.test(orphan), "a value after the provenance": /takes no further values/.test(closed), "a TRUNCATE": truncate !== "none" };
        const missing = Object.entries(refusals).filter(([, v]) => !v).map(([k]) => k);
        return { ok: ok && missing.length === 0, detail: `${detail}${missing.length ? ` not refused: ${missing.join(", ")} (${[noActor, forged, orphan, closed, truncate].join(" | ")})` : "every refusal as expected"}`.trim() };
      };
      const gw1 = await guardedWrite({ commit: false });
      report("3b. a guarded entry as the service writes it passes (rolled back); without the acting user, a forged author, no provenance by COMMIT, a value after the provenance and a TRUNCATE are refused", gw1.ok, gw1.detail);

      // 4. Post-check.
      const postCheck = async () => {
        const post = await booleansOf(c, fs.readFileSync(path.join(RUNBOOKS, "manual-values-v88-postcheck.sql"), "utf8"));
        return { n: post.length, bad: falseOnes(post) };
      };
      const p1 = await postCheck();
      report("4. post-check: every boolean true", p1.n >= 16 && p1.bad.length === 0, `${p1.n} booleans${p1.bad.length ? `; false: ${p1.bad.join(", ")}` : ""}`);

      // 5. The runner again.
      const count = Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count);
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      report("5. the runner again: v88 skipped by its checksum", Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count) === count);

      // 6. Rollback.
      const rollbackSql = fs.readFileSync(path.join(RUNBOOKS, "manual-values-v88-rollback.sql"), "utf8");
      await c.query(rollbackSql);
      const catalogAfter = (await c.query(CATALOG_SQL)).rows[0];
      const sameCatalog = JSON.stringify(catalogAfter) === JSON.stringify(catalogBefore);
      const unrecorded = (await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V88_NAME])).rows[0].n === 0;
      report("6. rollback: the catalog of training and training_load equal to the one before v88, v88 no longer recorded", sameCatalog && unrecorded,
        sameCatalog ? "" : Object.keys(catalogBefore).filter((k) => catalogBefore[k] !== catalogAfter[k]).join(", "));

      // 7. Apply again.
      await runMigrations({ databaseUrl: url, migrationsRoot: MIGRATIONS });
      const p2 = await postCheck();
      report("7. v88 applied again; the post-check again", p2.n >= 16 && p2.bad.length === 0, p2.bad.join(", "));
      const gw2 = await guardedWrite({ commit: true });
      const rows = (await c.query(`select count(*)::int as n from training_load.metric_manual_values`)).rows[0].n;
      report("7b. the guarded entry again, COMMITTED (one provenance row); the refusals again", gw2.ok && rows === 1, `${gw2.detail}; provenance rows ${rows}`);
      const used = (await c.query(CATALOG_SQL)).rows[0];
      let refusal = "none";
      try { await c.query(rollbackSql); } catch (error) { refusal = String(error?.message ?? ""); }
      await c.query("rollback").catch(() => {});
      const unchanged = JSON.stringify((await c.query(CATALOG_SQL)).rows[0]) === JSON.stringify(used);
      report("7c. the rollback then refuses (a manual value was written on a roster) and changes nothing", /a manual value was written on a roster/.test(refusal) && unchanged, refusal.slice(0, 100));

      // 8. pg_dump -Fc and pg_restore into a second database, v88's catalog compared.
      const source = (await c.query(V88_CATALOG_SQL)).rows[0];
      const dumpFile = path.join(tmp, "v88.dump");
      await run(tool(args.pgBin, "pg_dump"), ["--format", "custom", "--file", dumpFile, ...conn(args, name)], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const copy = await created();
      await run(tool(args.pgBin, "pg_restore"), ["--exit-on-error", "--no-owner", ...conn(args, copy), dumpFile], { env: toolEnv(password), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const r = new pg.Client({ connectionString: urlFor(args, copy, password) });
      await r.connect();
      try {
        const restored = (await r.query(V88_CATALOG_SQL)).rows[0];
        // A restore re-prints a varchar IN-list (`ARRAY['a'::character varying]::text[]` comes back as
        // `ARRAY[('a'::character varying)::text]`, a v21 constraint included): the same expression. Constraints are compared
        // with the casts and parentheses taken out; how many differ only in that print is reported.
        const reprint = (text) => String(text).split("\n").map((l) => l.replace(/::(character varying|text)(\[\])?/g, "").replace(/[()\s]/g, "")).join("\n");
        const same = (k) => source[k] === restored[k] || (k === "constraints" && reprint(source[k]) === reprint(restored[k]));
        const differs = Object.keys(source).filter((k) => !same(k));
        const reprinted = source.constraints === restored.constraints ? 0
          : String(source.constraints).split("\n").filter((l) => !String(restored.constraints).split("\n").includes(l)).length;
        for (const k of Object.keys(source).filter((key) => source[key] !== restored[key] && !(key === "constraints" && same(key)))) {
          const a = String(source[k]).split("\n"); const b = String(restored[k]).split("\n");
          for (const line of a.filter((x) => !b.includes(x)).slice(0, 5)) console.log(`      source only:   ${line}`);
          for (const line of b.filter((x) => !a.includes(x)).slice(0, 5)) console.log(`      restored only: ${line}`);
        }
        const restoredRows = (await r.query(`select count(*)::int as n from training_load.metric_manual_values`)).rows[0].n;
        report("8. pg_dump / pg_restore read-back: v88's constraints, triggers, indexes and function bodies identical, the provenance row restored", differs.length === 0 && restoredRows === 1,
          [differs.join(", "), reprinted ? `${reprinted} constraint(s) equal after the varchar-array re-print` : ""].filter(Boolean).join("; "));
      } finally {
        await r.end().catch(() => {});
      }
    } finally {
      await c.end().catch(() => {});
    }
  } catch (error) {
    report("the rehearsal ran to its end", false, redact(error?.message || error));
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
    console.error(`FAIL  ${redact(error?.message || error)}`);
    process.exit(1);
  });
}

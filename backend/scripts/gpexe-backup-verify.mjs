// Backup of the local database before a GPEXE import, proven by a trial
// restore — not just a pg_dump that exited 0 (owner decision 2026-09-18).
//
//   node backend/scripts/gpexe-backup-verify.mjs \
//     --dump C:/somewhere/outside/the/repo/optimove-before-gpexe.dump \
//     [--pg-bin "C:/Program Files/PostgreSQL/17/bin"] [--database-url <url>]
//
// What it does:
//   1. Opens ONE read-only REPEATABLE READ transaction on the source and
//      exports its snapshot. pg_dump runs on that snapshot (--snapshot), and
//      the source fingerprint below is read in that same transaction, so the
//      dump and the fingerprint describe exactly the same state even if
//      something writes to the source meanwhile.
//   2. pg_dump -Fc into --dump (a new file; an existing one is refused, and so
//      is a path inside a git work tree — the dump holds personal data and
//      must never be committed).
//   3. Restores the dump into a NEW, uniquely named database
//      optimove_tests_gpexe_restore_<random> on the same server with
//      pg_restore --exit-on-error, and fingerprints it the same way.
//   4. Compares the two fingerprints:
//        * every table in every user schema: row count and an order-independent
//          digest of every row's full text (md5 of the sorted row md5s);
//        * catalog: schemas, columns (type, not null, default), constraints,
//          indexes, views, functions (full definition; one re-printed IN-list
//          shape is rewritten first — see normalizeCheck), triggers INCLUDING
//          whether each is enabled, sequences (last value), extensions;
//        * schema_migrations is a table, so it is covered row by row.
//   5. Drops the restore database in every case, and checks it is gone.
//
// The dump file is kept only if the comparison found no difference; a dump
// that failed verification is deleted. The report (<dump>.verify.json) is
// written last, only after a successful comparison, so a dump counts as
// verified only when its report sits next to it. The report records the
// source (host, port and database name — never the password), the dump's
// size and sha256, and the counts compared.
//
// Not compared (see NOT_COMPARED): ownership and privileges (restored with
// --no-owner --no-privileges into the test database), database-level
// settings, roles, domain constraints, comments, rules, row-level security
// policies and flags, storage options, enum labels, materialized view
// contents and large objects. None of them exists in migrations_v2 today.
//
// The source is only read. It must be on this machine (localhost): this mode
// is not a tool for the deployed database.
//
// The remote mode (--remote-source, see backupAndVerifyRemote below) is the
// owner's procedure for the deployed database (J17, O2): run from the owner's
// own computer, the source read over TLS, the trial restore into a new
// database on the owner's local Postgres:
//
//   node backend/scripts/gpexe-backup-verify.mjs --remote-source \
//     --source-url "postgresql://<user>@<host>:<port>/postgres" \
//     --restore-url "postgresql://postgres@localhost:5432/postgres" \
//     --dump C:/OptiMove-backups/optimove-production-<date>.dump \
//     --pg-bin "C:/Program Files/PostgreSQL/17/bin" [--ssl-root-cert <file>]
//
// Both passwords are asked for on the terminal; neither URL may carry one.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const run = promisify(execFile);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const NOT_COMPARED = [
  "ownership and privileges (restored with --no-owner --no-privileges)",
  "database-level settings",
  "roles",
  "domain constraints",
  "comments",
  "rules",
  "row-level security policies and flags",
  "storage options (reloptions)",
  "enum labels",
  "materialized view contents",
  "large objects",
];
export const RESTORE_DB_PATTERN = /^optimove_tests_gpexe_restore_[a-f0-9]{10}$/;

const USER_SCHEMA_FILTER = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'`;

// The application's own schemas: the ones backend/src reads and writes
// (library and plans predate migrations_v2; migrations_v2 creates calendar,
// media, tests, training and training_load; public holds the rest and
// schema_migrations). The remote mode dumps and compares only these: a
// hosted database (Supabase) carries schemas, extensions and roles of its own
// that a plain local Postgres cannot restore and the application never owns.
export const APP_SCHEMAS = Object.freeze(["calendar", "library", "media", "plans", "public", "tests", "training", "training_load"]);

// Schemas a hosted database (Supabase) keeps for itself. Any other schema the
// source has but the run does not dump stops the run before anything is
// dumped, until the owner either lists it (--schema) or states that it is not
// the application's (--skip-schema): a backup never silently leaves out a
// schema nobody has looked at.
export const HOSTING_SCHEMAS = Object.freeze([
  "_analytics", "_realtime", "auth", "cron", "extensions", "graphql", "graphql_public", "net", "pgbouncer",
  "pgsodium", "pgsodium_masks", "pgtle", "realtime", "storage", "supabase_functions", "supabase_migrations", "vault",
]);
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function checkSchemaList(schemas) {
  if (!Array.isArray(schemas) || schemas.length === 0) throw new Error("refusing: at least one schema is needed");
  const seen = new Set();
  for (const name of schemas) {
    if (typeof name !== "string" || !SCHEMA_NAME.test(name) || name.startsWith("pg_") || name === "information_schema") {
      throw new Error(`refusing: ${JSON.stringify(name)} is not an application schema name`);
    }
    if (seen.has(name)) throw new Error(`refusing: schema ${name} is listed twice`);
    seen.add(name);
  }
  return [...seen].sort();
}

// The namespace filter of the fingerprint: every user schema by default (the
// local mode, unchanged), or exactly the listed ones. Names are checked by
// checkSchemaList, so quoting them as literals is safe.
function schemaFilter(schemas, column = "n.nspname") {
  if (!schemas) return USER_SCHEMA_FILTER.replaceAll("n.nspname", column);
  return `${column} in (${schemas.map((name) => `'${name}'`).join(", ")})`;
}

// In a schema-limited fingerprint an extension's member objects (a function
// that came with an extension installed in a listed schema) are not the
// application's: pg_dump --schema leaves them out, so they are left out here
// on both sides, and the extensions themselves are reported, not compared.
function notExtensionMember(classId, objId, schemas) {
  return schemas ? `and not exists (select 1 from pg_depend dep where dep.classid = '${classId}'::regclass and dep.objid = ${objId} and dep.deptype = 'e')` : "";
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function describe(url) {
  const database = decodeURIComponent(url.pathname.slice(1));
  // pg_dump/pg_restore read a --dbname containing "=" or a URI prefix as a
  // whole connection string, which could name another host.
  if (!database || database.includes("=") || /^postgres(ql)?:/i.test(database)) {
    throw new Error("refusing: the database name must be a plain name");
  }
  return { host: url.hostname, port: url.port || "5432", database };
}

// The environment for pg_dump and pg_restore. Every libpq variable the parent
// process carries (PGHOST, PGHOSTADDR, PGPORT, PGDATABASE, PGUSER, PGSERVICE,
// PGSERVICEFILE, PGPASSFILE, PGOPTIONS, PGSSLMODE, ...) is dropped: PGHOSTADDR
// alone would send the tool to a different server than the one the host check
// approved, and a service entry can supply host, port, user and database.
// Only the password is passed through the environment (never on the command
// line); host, port, user and database go as explicit arguments
// (pgConnectionArgs). PG_BIN is not a libpq variable and is kept.
//
// The remote mode passes its password separately (never part of the URL) and
// adds exactly two libpq variables of its own: PGSSLMODE, and PGSSLROOTCERT
// for verify-full.
export function pgEnv(url, parentEnv = process.env, { password, sslMode, sslRootCert } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (!/^PG[A-Z]/.test(key.toUpperCase())) env[key] = value;
  }
  env.PGPASSWORD = password !== undefined ? password : decodeURIComponent(url.password);
  if (sslMode) env.PGSSLMODE = sslMode;
  if (sslRootCert) env.PGSSLROOTCERT = sslRootCert;
  return env;
}

export function pgConnectionArgs(url, database) {
  return [
    "--host", url.hostname.replace(/^\[|\]$/g, ""),
    "--port", url.port || "5432",
    "--username", decodeURIComponent(url.username),
    "--dbname", database,
    "--no-password",
  ];
}

// With a schema list (the remote mode) only those schemas are dumped, and
// --strict-names makes pg_dump fail on a listed schema the source lacks.
export function pgDumpArgs(source, database, snapshot, dump, schemas = null) {
  const only = schemas ? ["--strict-names", ...schemas.flatMap((name) => ["--schema", name])] : [];
  return ["-Fc", `--snapshot=${snapshot}`, ...only, "-f", dump, ...pgConnectionArgs(source, database)];
}

export function pgRestoreArgs(source, restoreDatabase, dump) {
  return ["--exit-on-error", "--no-owner", "--no-privileges", ...pgConnectionArgs(source, restoreDatabase), dump];
}

function tool(pgBin, name) {
  return pgBin ? path.join(pgBin, process.platform === "win32" ? `${name}.exe` : name) : name;
}

async function insideGitWorkTree(dir) {
  try {
    await run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { windowsHide: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("refusing: git is needed to check that the dump is written outside any repository");
    return false;
  }
}

// The path is claimed by creating the file exclusively ("wx"), in one atomic
// step: a file that appears at that path at any moment after the check
// cannot be overwritten by pg_dump, because the check IS the creation.
async function claimDumpTarget(dumpPath) {
  if (!dumpPath) throw new Error("--dump <path> is required");
  const resolved = path.resolve(dumpPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) throw new Error(`refusing: directory ${dir} does not exist`);
  if (fs.existsSync(`${resolved}.verify.json`)) throw new Error(`refusing: ${resolved}.verify.json already exists`);
  if (await insideGitWorkTree(dir)) throw new Error(`refusing: ${dir} is inside a git work tree — the dump holds personal data and must stay outside any repository`);
  try {
    await (await fsp.open(resolved, "wx")).close();
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`refusing: ${resolved} already exists — a backup is never overwritten`);
    throw error;
  }
  return resolved;
}

// Session settings that make every value's text form identical on both
// sides, whatever the connecting role's defaults are.
async function pinTextOutput(client) {
  await client.query(`set local search_path = pg_catalog`);
  await client.query(`set local timezone = 'UTC'`);
  await client.query(`set local datestyle = 'ISO, YMD'`);
  await client.query(`set local intervalstyle = 'postgres'`);
  await client.query(`set local extra_float_digits = 1`);
  await client.query(`set local bytea_output = 'hex'`);
}

// Postgres re-prints one expression shape differently after a dump and
// restore: an IN list whose elements are cast as a whole,
//   (ARRAY['a'::character varying, 'b'::character varying])::text[]
// comes back with each element cast on its own,
//   ARRAY[('a'::character varying)::text, ('b'::character varying)::text]
// Only that exact shape is rewritten into the second form, on both sides;
// every other character of a CHECK or of a partial index's WHERE — casts,
// parentheses, AND/OR grouping — is compared as it is.
const ARRAY_ITEM = String.raw`'(?:[^']|'')*'::[a-z][a-z ]*[a-z]`;
const WHOLE_ARRAY_CAST = new RegExp(String.raw`\(ARRAY\[(${ARRAY_ITEM}(?:, ${ARRAY_ITEM})*)\]\)::([a-z][a-z ]*[a-z])\[\]`, "g");
export function normalizeCheck(def) {
  return def.replace(WHOLE_ARRAY_CAST, (_, items, type) =>
    `ARRAY[${items.match(new RegExp(ARRAY_ITEM, "g")).map((item) => `(${item})::${type}`).join(", ")}]`);
}

export function normalizeIndex(def) {
  const at = def.indexOf(" WHERE ");
  return at < 0 ? def : `${def.slice(0, at)} WHERE ${normalizeCheck(def.slice(at + 7))}`;
}

export async function fingerprint(client, { schemas = null } = {}) {
  const F = schemaFilter(schemas);
  const tables = {};
  const tableRows = (await client.query(
    `select n.nspname as schema, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and ${F} ${notExtensionMember("pg_class", "c.oid", schemas)}
      order by 1, 2`,
  )).rows;
  for (const { schema, name } of tableRows) {
    const r = (await client.query(
      `select count(*)::bigint as rows, md5(coalesce(string_agg(h, '' order by h), '')) as digest
         from (select md5(t::text) as h from ${quoteIdent(schema)}.${quoteIdent(name)} t) x`,
    )).rows[0];
    tables[`${schema}.${name}`] = { rows: Number(r.rows), digest: r.digest };
  }

  const list = async (sql) => (await client.query(sql)).rows.map((r) => r.item).sort();
  const constraintRows = (await client.query(
    `select con.conrelid::regclass::text || ' ' || con.conname || ' ' || con.contype::text as head, con.contype::text as type,
            con.conrelid::regclass::text as tbl, con.conname as name, pg_get_constraintdef(con.oid) as def
       from pg_constraint con join pg_namespace n on n.oid = con.connamespace
      where con.conrelid <> 0 and ${F}`,
  )).rows;
  // The CHECKs with their parts, for reconcileReprintedChecks (not compared
  // on their own: the constraints list above is).
  const checks = constraintRows.filter((r) => r.type === "c")
    .map((r) => ({ item: `${r.head} ${normalizeCheck(r.def)}`, table: r.tbl, name: r.name, def: r.def }));
  const catalog = {
    schemas: await list(`select n.nspname as item from pg_namespace n where ${F}`),
    extensions: schemas ? [] : await list(`select extname || ' ' || extversion as item from pg_extension`),
    columns: await list(
      `select n.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
              || case when a.attnotnull then ' not null' else '' end
              || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') as item
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where c.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped and ${F} ${notExtensionMember("pg_class", "c.oid", schemas)}`,
    ),
    constraints: constraintRows.map((r) => `${r.head} ${r.type === "c" ? normalizeCheck(r.def) : r.def}`).sort(),
    // A partial index's WHERE is re-printed the same way as a CHECK.
    indexes: (await client.query(
      `select pg_get_indexdef(i.indexrelid) as def
         from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
        where ${F} ${notExtensionMember("pg_class", "i.indrelid", schemas)}`,
    )).rows.map((r) => normalizeIndex(r.def)).sort(),
    views: await list(
      `select n.nspname || '.' || c.relname || ' ' || c.relkind::text || ' ' || md5(pg_get_viewdef(c.oid)) as item
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('v', 'm') and ${F} ${notExtensionMember("pg_class", "c.oid", schemas)}`,
    ),
    functions: await list(
      `select p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) as item
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prokind in ('f', 'p') and ${F} ${notExtensionMember("pg_proc", "p.oid", schemas)}`,
    ),
    // tgenabled is part of the item on purpose: a restored copy whose
    // protective triggers came back disabled is not the same database.
    triggers: await list(
      `select t.tgrelid::regclass::text || ' ' || t.tgname || ' enabled=' || t.tgenabled::text || ' ' || md5(pg_get_triggerdef(t.oid)) as item
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where not t.tgisinternal and ${F}`,
    ),
    sequences: await list(
      `select schemaname || '.' || sequencename || ' last=' || coalesce(last_value::text, 'unused') as item
         from pg_sequences where ${schemas ? schemaFilter(schemas, "schemaname") : "schemaname not in ('pg_catalog', 'information_schema')"}`,
    ),
  };
  return { tables, catalog, checks };
}

// A CHECK can come back from a dump and restore printed with a different but
// equivalent grouping: Postgres flattens nested ANDs when it parses the
// dumped text again, so "((a AND b) AND c)" is printed "(a AND b AND c)".
// A text rule cannot tell that apart from a real change. So, for a CHECK that
// differs only in its text (same table, same name), the source's definition
// is parsed by Postgres itself in the throwaway restored database: added to
// an empty temporary copy of the table inside a transaction that is rolled
// back, and printed again. When that print equals the restored CHECK, the two
// are the same constraint and the source item is replaced by the restored
// one; otherwise the difference stays and the dump is not verified (a
// narrowed CHECK is still caught). Returns the names reconciled.
export async function reconcileReprintedChecks(clientConfig, sourcePrint, restoredPrint) {
  const restoredItems = new Set(restoredPrint.catalog.constraints);
  const sourceItems = new Set(sourcePrint.catalog.constraints);
  const restoredByKey = new Map(restoredPrint.checks.map((c) => [`${c.table}\u0000${c.name}`, c]));
  const candidates = sourcePrint.checks.filter((c) => !restoredItems.has(c.item))
    .map((c) => ({ source: c, restored: restoredByKey.get(`${c.table}\u0000${c.name}`) }))
    .filter((pair) => pair.restored && !sourceItems.has(pair.restored.item));
  if (!candidates.length) return [];
  const reconciled = [];
  const client = new pg.Client(clientConfig);
  client.on("error", () => {});
  await client.connect();
  try {
    await client.query("begin");
    await pinTextOutput(client);
    for (const { source, restored } of candidates) {
      await client.query("savepoint reprint");
      try {
        await client.query(`create temp table optimove_reprint (like ${source.table})`);
        await client.query(`alter table pg_temp.optimove_reprint add constraint optimove_reprint_check ${source.def}`);
        const reprinted = (await client.query(
          `select pg_get_constraintdef(oid) as def from pg_constraint
            where conrelid = 'pg_temp.optimove_reprint'::regclass and conname = 'optimove_reprint_check'`,
        )).rows[0]?.def;
        if (reprinted !== undefined && normalizeCheck(reprinted) === normalizeCheck(restored.def)) {
          const at = sourcePrint.catalog.constraints.indexOf(source.item);
          sourcePrint.catalog.constraints[at] = restored.item;
          reconciled.push(`${source.table}.${source.name}`);
        }
      } catch {
        // Not parseable here: the difference stays and is reported.
      }
      await client.query("rollback to savepoint reprint");
    }
    sourcePrint.catalog.constraints.sort();
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  }
  return reconciled;
}

function setDifference(a, b) {
  const bs = new Set(b);
  return a.filter((x) => !bs.has(x));
}

export function compareFingerprints(source, restored) {
  const mismatches = [];
  const names = new Set([...Object.keys(source.tables), ...Object.keys(restored.tables)]);
  for (const name of [...names].sort()) {
    const s = source.tables[name];
    const r = restored.tables[name];
    if (!s) mismatches.push({ kind: "table", name, problem: "only in the restored copy" });
    else if (!r) mismatches.push({ kind: "table", name, problem: "missing from the restored copy" });
    else if (s.rows !== r.rows) mismatches.push({ kind: "table", name, problem: `row count ${s.rows} in the source, ${r.rows} restored` });
    else if (s.digest !== r.digest) mismatches.push({ kind: "table", name, problem: `same row count (${s.rows}) but different content` });
  }
  for (const category of Object.keys(source.catalog)) {
    const missing = setDifference(source.catalog[category], restored.catalog[category] ?? []);
    const extra = setDifference(restored.catalog[category] ?? [], source.catalog[category]);
    if (missing.length || extra.length) {
      mismatches.push({ kind: "catalog", name: category, problem: "differs", missing: missing.slice(0, 20), extra: extra.slice(0, 20) });
    }
  }
  return mismatches;
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// The server actually reached must be this machine and the named database:
// the URL alone does not prove it.
async function assertConnectedLocally(client, database) {
  const r = (await client.query(`select current_database() as db, host(inet_server_addr()) as addr`)).rows[0];
  if (r.db !== database) throw new Error(`SAFETY: connected to database ${r.db}, expected ${database}`);
  if (r.addr !== null && r.addr !== "127.0.0.1" && r.addr !== "::1") throw new Error(`refusing: connected to server address ${r.addr}, not this machine`);
}

async function readFingerprint(url, database) {
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await assertConnectedLocally(client, database);
    await client.query("begin transaction isolation level repeatable read read only");
    await pinTextOutput(client);
    return await fingerprint(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

export async function backupAndVerify({ databaseUrl, dumpPath, pgBin = "", onSnapshotExported, onDumpStarted, onRestored, log = () => {} }) {
  const source = new URL(databaseUrl);
  // A query string can redirect the connection (?host=...) past the host
  // check below, so none is accepted.
  if (source.search || source.hash) throw new Error("refusing: --database-url must not carry query parameters");
  if (!LOCAL_HOSTS.has(source.hostname)) {
    throw new Error(`refusing: source host ${source.hostname} is not this machine — this tool only backs up a local database`);
  }
  const sourceInfo = describe(source);
  const restoreName = `optimove_tests_gpexe_restore_${crypto.randomBytes(5).toString("hex")}`;
  if (!RESTORE_DB_PATTERN.test(restoreName) || restoreName === sourceInfo.database) throw new Error("SAFETY: bad restore database name");
  const restoreUrl = new URL(source);
  restoreUrl.pathname = `/${restoreName}`;
  const maintenanceUrl = new URL(source);
  maintenanceUrl.pathname = "/postgres";
  // Claimed last: from here on, every failure passes through the finally
  // below, which removes the file again.
  const dump = await claimDumpTarget(dumpPath);
  log(`source (read only): host ${sourceInfo.host}, port ${sourceInfo.port}, database ${sourceInfo.database}`);

  const report = {
    source: sourceInfo,
    dump: { path: dump },
    restoreDatabase: restoreName,
    notCompared: NOT_COMPARED,
  };
  let verified = false;
  let restoreCreated = false;
  let failure = null;
  const cleanupProblems = [];
  const sourceClient = new pg.Client({ connectionString: source.toString() });
  // A dropped connection also surfaces through the pending query; without a
  // listener the 'error' event would end the process before the cleanup.
  sourceClient.on("error", () => {});
  try {
    await sourceClient.connect();
    await assertConnectedLocally(sourceClient, sourceInfo.database);
    // 1. One snapshot for the dump and for the source fingerprint.
    await sourceClient.query("begin transaction isolation level repeatable read read only");
    const snapshot = (await sourceClient.query("select pg_export_snapshot() as id")).rows[0].id;
    await pinTextOutput(sourceClient);
    report.serverVersion = (await sourceClient.query("show server_version")).rows[0].server_version;
    if (onSnapshotExported) await onSnapshotExported();

    // 2. Dump and source fingerprint, concurrently, on the same snapshot.
    const env = pgEnv(source);
    const dumping = run(tool(pgBin, "pg_dump"), pgDumpArgs(source, sourceInfo.database, snapshot, dump), { env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (onDumpStarted) await onDumpStarted({ sourcePid: sourceClient.processID });
    // allSettled, not all: if the fingerprint fails, pg_dump is still writing
    // the file, and it must have finished before the file can be removed.
    const [printed, dumped] = await Promise.allSettled([fingerprint(sourceClient), dumping]);
    if (printed.status === "rejected") throw printed.reason;
    if (dumped.status === "rejected") throw dumped.reason;
    const sourcePrint = printed.value;
    await sourceClient.query("rollback");
    report.dump.bytes = (await fsp.stat(dump)).size;
    report.dump.sha256 = await sha256(dump);
    report.pgDumpVersion = (await run(tool(pgBin, "pg_dump"), ["--version"], { env, windowsHide: true })).stdout.trim();
    log(`dump written: ${report.dump.bytes} bytes, sha256 ${report.dump.sha256}`);

    // 3. Trial restore into a new database.
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    try {
      await maintenance.query(`create database ${quoteIdent(restoreName)}`);
      restoreCreated = true;
    } finally {
      await maintenance.end();
    }
    await run(tool(pgBin, "pg_restore"), pgRestoreArgs(source, restoreName, dump), { env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    log(`restored into ${restoreName}`);
    if (onRestored) await onRestored(restoreUrl.toString());

    // 4. Compare.
    const restoredPrint = await readFingerprint(restoreUrl, restoreName);
    report.reprintedChecks = await reconcileReprintedChecks({ connectionString: restoreUrl.toString() }, sourcePrint, restoredPrint);
    const mismatches = compareFingerprints(sourcePrint, restoredPrint);
    report.tablesCompared = Object.keys(sourcePrint.tables).length;
    report.rowsCompared = Object.values(sourcePrint.tables).reduce((sum, t) => sum + t.rows, 0);
    report.catalogCompared = Object.fromEntries(Object.entries(sourcePrint.catalog).map(([k, v]) => [k, v.length]));
    report.mismatches = mismatches;
    verified = mismatches.length === 0;
    report.verified = verified;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await sourceClient.end().catch(() => {});
    // A dump that was not verified never stays on disk. This runs first, and
    // on its own, so a failing drop below cannot keep it.
    if (!verified) {
      try {
        await fsp.rm(dump, { force: true });
      } catch (error) {
        cleanupProblems.push(`the unverified dump ${dump} could not be deleted (${error.message}) — delete it by hand`);
      }
    }
    // 5. The restore database never outlives the run.
    if (restoreCreated) {
      try {
        const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
        await maintenance.connect();
        try {
          await maintenance.query(`drop database if exists ${quoteIdent(restoreName)} with (force)`);
          report.restoreDropped = (await maintenance.query(`select 1 from pg_database where datname = $1`, [restoreName])).rowCount === 0;
        } finally {
          await maintenance.end();
        }
      } catch (error) {
        report.restoreDropped = false;
        cleanupProblems.push(`restore database ${restoreName} could not be dropped (${error.message}) — drop it by hand`);
      }
      if (!report.restoreDropped && !cleanupProblems.some((p) => p.includes(restoreName))) {
        cleanupProblems.push(`restore database ${restoreName} is still there — drop it by hand`);
      }
    }
    // The original error stays the one thrown; cleanup trouble is added to it.
    if (failure && cleanupProblems.length) failure.message += `; also: ${cleanupProblems.join("; ")}`;
  }
  if (cleanupProblems.length) throw new Error(cleanupProblems.join("; "));
  if (verified) {
    await fsp.writeFile(`${dump}.verify.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  return report;
}

// ---------------------------------------------------------------------------
// The remote mode (J17, O2): the deployed database (Supabase), read from the
// owner's own computer over TLS, restored into a NEW database on the owner's
// local Postgres and compared there. Owner decision 2026-11-01: „backup
// ručnim pg_dump-om sa mog računara i proverom vraćanja u lokalni Postgres”.
//
// What differs from the local mode, and why:
//   * the source may be any host, but only over TLS: sslmode require (the
//     owner's order) or verify-full with a root certificate; there is no
//     way to switch TLS off;
//   * no password is ever part of a URL: the CLI asks for both passwords on
//     the terminal without echo, so neither lands in a file or the shell's
//     history; a URL that carries one is refused;
//   * only the application's schemas are dumped and compared (APP_SCHEMAS):
//     a hosted database has schemas, extensions and roles of its own that a
//     plain Postgres cannot restore; the schemas left out are listed (names
//     only) in the report;
//   * the restore server is a separate URL that must be this machine.
// Everything else is the local mode's: one exported snapshot for the dump and
// the source fingerprint, a new file outside any git work tree, the restore
// database dropped in every case, an unverified dump deleted, the report
// written last.
export const SSL_MODES = Object.freeze(["require", "verify-full"]);

function checkConnectionUrl(raw, what) {
  const url = new URL(raw);
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error(`refusing: ${what} must be a postgresql:// URL`);
  if (url.search || url.hash) throw new Error(`refusing: ${what} must not carry query parameters`);
  if (url.password) throw new Error(`refusing: ${what} must not carry a password — it is asked for on the terminal`);
  if (!url.username) throw new Error(`refusing: ${what} must name the user`);
  return url;
}

function sslConfig(sslMode, sslRootCert, host) {
  if (sslMode === "require") return { rejectUnauthorized: false };
  return { ca: fs.readFileSync(sslRootCert, "utf8"), rejectUnauthorized: true, servername: host };
}

function clientConfig(url, database, password, ssl) {
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 5432),
    user: decodeURIComponent(url.username), password, database, ssl,
  };
}

async function readFingerprintWith(config, database, schemas) {
  const client = new pg.Client(config);
  client.on("error", () => {});
  await client.connect();
  try {
    await assertConnectedLocally(client, database);
    await client.query("begin transaction isolation level repeatable read read only");
    await pinTextOutput(client);
    return await fingerprint(client, { schemas });
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  }
}

export async function backupAndVerifyRemote({
  sourceUrl, sourcePassword, restoreUrl, restorePassword = "", dumpPath, schemas = APP_SCHEMAS, skipSchemas = [],
  sslMode = "require", sslRootCert = "", pgBin = "", onSnapshotExported, onDumpStarted, onRestored, log = () => {},
}) {
  const source = checkConnectionUrl(sourceUrl, "the source URL");
  const restoreServer = checkConnectionUrl(restoreUrl, "the restore URL");
  if (typeof sourcePassword !== "string") throw new Error("refusing: the source password is missing");
  if (!SSL_MODES.includes(sslMode)) throw new Error(`refusing: sslmode ${sslMode} is not one of ${SSL_MODES.join(", ")}`);
  if (sslMode === "verify-full" && !(sslRootCert && fs.existsSync(sslRootCert))) throw new Error("refusing: verify-full needs --ssl-root-cert <existing file>");
  if (sslMode !== "verify-full" && sslRootCert) throw new Error("refusing: --ssl-root-cert is used only with verify-full");
  if (!LOCAL_HOSTS.has(restoreServer.hostname)) throw new Error(`refusing: restore host ${restoreServer.hostname} is not this machine — the trial restore runs on the local Postgres`);
  const dumpSchemas = checkSchemaList(schemas);
  const acknowledged = skipSchemas.length ? checkSchemaList(skipSchemas) : [];
  if (acknowledged.some((name) => dumpSchemas.includes(name))) throw new Error("refusing: a schema is both dumped and skipped");
  const sourceInfo = describe(source);
  const restoreInfo = describe(restoreServer);
  const restoreName = `optimove_tests_gpexe_restore_${crypto.randomBytes(5).toString("hex")}`;
  if (!RESTORE_DB_PATTERN.test(restoreName)) throw new Error("SAFETY: bad restore database name");
  const ssl = sslConfig(sslMode, sslRootCert, source.hostname);
  const dump = await claimDumpTarget(dumpPath);
  log(`source (read only, sslmode ${sslMode}): host ${sourceInfo.host}, port ${sourceInfo.port}, database ${sourceInfo.database}`);
  log(`schemas dumped: ${dumpSchemas.join(", ")}`);

  const report = {
    mode: "remote-source",
    source: sourceInfo,
    sslMode,
    schemas: dumpSchemas,
    restoreServer: { host: restoreInfo.host, port: restoreInfo.port },
    dump: { path: dump },
    restoreDatabase: restoreName,
    notCompared: [...NOT_COMPARED, "schemas not listed, and the extensions (their member objects are left out on both sides)"],
  };
  let verified = false;
  let restoreCreated = false;
  let failure = null;
  const cleanupProblems = [];
  const restoreClientConfig = (database) => clientConfig(restoreServer, database, restorePassword, false);
  const sourceClient = new pg.Client(clientConfig(source, sourceInfo.database, sourcePassword, ssl));
  sourceClient.on("error", () => {});
  try {
    await sourceClient.connect();
    const who = (await sourceClient.query(`select current_database() as db`)).rows[0];
    if (who.db !== sourceInfo.database) throw new Error(`SAFETY: connected to database ${who.db}, expected ${sourceInfo.database}`);
    // 1. One snapshot for the dump and the source fingerprint. A hosted
    // server may cap statements or idle transactions; neither may cut the
    // fingerprint or the open snapshot while pg_dump still runs.
    await sourceClient.query("begin transaction isolation level repeatable read read only");
    await sourceClient.query("set local statement_timeout = 0");
    await sourceClient.query("set local idle_in_transaction_session_timeout = 0");
    if ((await sourceClient.query("show transaction_read_only")).rows[0].transaction_read_only !== "on") {
      throw new Error("SAFETY: the source transaction is not read only");
    }
    const present = (await sourceClient.query(
      `select nspname from pg_namespace where nspname = any($1::text[])`, [dumpSchemas],
    )).rows.map((r) => r.nspname);
    const missing = dumpSchemas.filter((name) => !present.includes(name));
    if (missing.length) throw new Error(`refusing: the source has no schema ${missing.join(", ")}`);
    report.schemasLeftOut = (await sourceClient.query(
      `select n.nspname as item from pg_namespace n where ${USER_SCHEMA_FILTER} and not (n.nspname = any($1::text[])) order by 1`, [dumpSchemas],
    )).rows.map((r) => r.item);
    const unknown = report.schemasLeftOut.filter((name) => !HOSTING_SCHEMAS.includes(name) && !acknowledged.includes(name));
    if (unknown.length) {
      throw new Error(`refusing: the source has schema ${unknown.join(", ")}, neither listed nor known as the hosting provider's — list it with --schema, or state with --skip-schema that it is not the application's`);
    }
    report.schemasSkippedByOwner = acknowledged.filter((name) => report.schemasLeftOut.includes(name));
    report.extensionsInDumpedSchemas = (await sourceClient.query(
      `select e.extname || ' ' || e.extversion as item from pg_extension e join pg_namespace n on n.oid = e.extnamespace
        where n.nspname = any($1::text[]) order by 1`, [dumpSchemas],
    )).rows.map((r) => r.item);
    const snapshot = (await sourceClient.query("select pg_export_snapshot() as id")).rows[0].id;
    await pinTextOutput(sourceClient);
    report.serverVersion = (await sourceClient.query("show server_version")).rows[0].server_version;
    if (onSnapshotExported) await onSnapshotExported();

    // 2. Dump and source fingerprint, concurrently, on the same snapshot.
    const dumpEnv = pgEnv(source, process.env, { password: sourcePassword, sslMode, sslRootCert: sslRootCert || undefined });
    const dumping = run(tool(pgBin, "pg_dump"), pgDumpArgs(source, sourceInfo.database, snapshot, dump, dumpSchemas), { env: dumpEnv, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (onDumpStarted) await onDumpStarted({ sourcePid: sourceClient.processID });
    const [printed, dumped] = await Promise.allSettled([fingerprint(sourceClient, { schemas: dumpSchemas }), dumping]);
    if (printed.status === "rejected") throw printed.reason;
    if (dumped.status === "rejected") throw dumped.reason;
    const sourcePrint = printed.value;
    await sourceClient.query("rollback");
    report.dump.bytes = (await fsp.stat(dump)).size;
    report.dump.sha256 = await sha256(dump);
    report.pgDumpVersion = (await run(tool(pgBin, "pg_dump"), ["--version"], { env: dumpEnv, windowsHide: true })).stdout.trim();
    log(`dump written: ${report.dump.bytes} bytes, sha256 ${report.dump.sha256}`);

    // 3. Trial restore into a new database on the local server.
    const restoreEnv = pgEnv(restoreServer, process.env, { password: restorePassword });
    const maintenance = new pg.Client(restoreClientConfig(restoreInfo.database));
    maintenance.on("error", () => {});
    await maintenance.connect();
    try {
      await assertConnectedLocally(maintenance, restoreInfo.database);
      await maintenance.query(`create database ${quoteIdent(restoreName)}`);
      restoreCreated = true;
    } finally {
      await maintenance.end().catch(() => {});
    }
    // A dump limited to schemas carries its own "CREATE SCHEMA public" when
    // public is listed, and every new database already has an empty public:
    // when the dump's table of contents holds that entry, the new database's
    // own (empty) public is dropped first, so the restore recreates it.
    const toc = (await run(tool(pgBin, "pg_restore"), ["--list", dump], { env: restoreEnv, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })).stdout;
    if (dumpCreatesSchema(toc, "public")) {
      const fresh = new pg.Client(restoreClientConfig(restoreName));
      fresh.on("error", () => {});
      await fresh.connect();
      try {
        await assertConnectedLocally(fresh, restoreName);
        const objects = (await fresh.query(
          `select count(*)::int as c from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'`,
        )).rows[0].c;
        if (objects !== 0) throw new Error("SAFETY: the new restore database's public schema is not empty");
        await fresh.query("drop schema public");
      } finally {
        await fresh.end().catch(() => {});
      }
    }
    await run(tool(pgBin, "pg_restore"), pgRestoreArgs(restoreServer, restoreName, dump), { env: restoreEnv, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    log(`restored into ${restoreName} on this machine`);
    if (onRestored) await onRestored(restoreClientConfig(restoreName));

    // 4. Compare, the listed schemas only.
    const restoredPrint = await readFingerprintWith(restoreClientConfig(restoreName), restoreName, dumpSchemas);
    report.reprintedChecks = await reconcileReprintedChecks(restoreClientConfig(restoreName), sourcePrint, restoredPrint);
    const mismatches = compareFingerprints(sourcePrint, restoredPrint);
    report.tablesCompared = Object.keys(sourcePrint.tables).length;
    report.rowsCompared = Object.values(sourcePrint.tables).reduce((sum, t) => sum + t.rows, 0);
    report.catalogCompared = Object.fromEntries(Object.entries(sourcePrint.catalog).map(([k, v]) => [k, v.length]));
    report.mismatches = mismatches;
    verified = mismatches.length === 0;
    report.verified = verified;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await sourceClient.end().catch(() => {});
    if (!verified) {
      try {
        await fsp.rm(dump, { force: true });
      } catch (error) {
        cleanupProblems.push(`the unverified dump ${dump} could not be deleted (${error.message}) — delete it by hand`);
      }
    }
    if (restoreCreated) {
      try {
        const maintenance = new pg.Client(restoreClientConfig(restoreInfo.database));
        maintenance.on("error", () => {});
        await maintenance.connect();
        try {
          await maintenance.query(`drop database if exists ${quoteIdent(restoreName)} with (force)`);
          report.restoreDropped = (await maintenance.query(`select 1 from pg_database where datname = $1`, [restoreName])).rowCount === 0;
        } finally {
          await maintenance.end().catch(() => {});
        }
      } catch (error) {
        report.restoreDropped = false;
        cleanupProblems.push(`restore database ${restoreName} could not be dropped (${error.message}) — drop it by hand`);
      }
      if (!report.restoreDropped && !cleanupProblems.some((p) => p.includes(restoreName))) {
        cleanupProblems.push(`restore database ${restoreName} is still there — drop it by hand`);
      }
    }
    if (failure && cleanupProblems.length) failure.message += `; also: ${cleanupProblems.join("; ")}`;
  }
  if (cleanupProblems.length) throw new Error(cleanupProblems.join("; "));
  if (verified) {
    await fsp.writeFile(`${dump}.verify.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  return report;
}

// Whether a pg_restore --list table of contents creates the schema: a line
// such as "215; 2615 2200 SCHEMA - public postgres".
export function dumpCreatesSchema(toc, name) {
  return toc.split(/\r?\n/).some((line) => {
    const m = /^\d+; \d+ \d+ SCHEMA - (\S+)/.exec(line);
    return m !== null && m[1] === name;
  });
}

// A password typed on the terminal, never echoed, never stored. Refused when
// the input is not an interactive terminal (a password is never piped in).
export function promptHidden(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      reject(new Error("refusing: a password is read only from an interactive terminal"));
      return;
    }
    const rl = readline.createInterface({ input, output, terminal: true });
    let muted = false;
    rl._writeToOutput = (text) => { if (!muted) output.write(text); };
    rl.question(question, (answer) => {
      rl.close();
      output.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

function parseCliArgs(argv) {
  const opts = { schemas: [], skipSchemas: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--remote-source") { opts.remote = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--dump") opts.dump = value;
    else if (flag === "--pg-bin") opts.pgBin = value;
    else if (flag === "--database-url") opts.databaseUrl = value;
    else if (flag === "--source-url") opts.sourceUrl = value;
    else if (flag === "--restore-url") opts.restoreUrl = value;
    else if (flag === "--schema") opts.schemas.push(value);
    else if (flag === "--skip-schema") opts.skipSchemas.push(value);
    else if (flag === "--ssl-root-cert") opts.sslRootCert = value;
    else throw new Error(`unknown argument ${flag}`);
    i += 1;
  }
  return opts;
}

async function mainRemote(opts, readPassword) {
  if (opts.databaseUrl) throw new Error("refusing: the remote mode takes --source-url and --restore-url, never --database-url");
  if (!opts.sourceUrl) throw new Error("--source-url is required with --remote-source");
  if (!opts.restoreUrl) throw new Error("--restore-url is required with --remote-source");
  if (!opts.dump) throw new Error("--dump <path> is required");
  // Every check that needs no password runs before the prompts.
  checkConnectionUrl(opts.sourceUrl, "the source URL");
  checkConnectionUrl(opts.restoreUrl, "the restore URL");
  const sourcePassword = await readPassword("Password of the source database (not shown): ");
  const restorePassword = await readPassword("Password of the local Postgres (not shown; Enter if none): ");
  const report = await backupAndVerifyRemote({
    sourceUrl: opts.sourceUrl, sourcePassword, restoreUrl: opts.restoreUrl, restorePassword, dumpPath: opts.dump,
    schemas: opts.schemas.length ? opts.schemas : APP_SCHEMAS, skipSchemas: opts.skipSchemas,
    sslMode: opts.sslRootCert ? "verify-full" : "require", sslRootCert: opts.sslRootCert ?? "",
    pgBin: opts.pgBin ?? process.env.PG_BIN ?? "", log: (line) => console.log(line),
  });
  return report;
}

export async function main(argv, { readPassword = promptHidden } = {}) {
  const opts = parseCliArgs(argv);
  let report;
  if (opts.remote) {
    report = await mainRemote(opts, readPassword);
  } else {
    if (opts.sourceUrl || opts.restoreUrl || opts.schemas.length || opts.skipSchemas.length || opts.sslRootCert) {
      throw new Error("refusing: --source-url, --restore-url, --schema, --skip-schema and --ssl-root-cert belong to --remote-source");
    }
    const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("--database-url or DATABASE_URL is required");
    report = await backupAndVerify({
      databaseUrl, dumpPath: opts.dump, pgBin: opts.pgBin ?? process.env.PG_BIN ?? "", log: (line) => console.log(line),
    });
  }
  console.log(JSON.stringify({ ...report, mismatches: report.mismatches?.length ?? null }, null, 2));
  if (!report.verified) {
    console.error(JSON.stringify(report.mismatches, null, 2));
    throw new Error("VERIFICATION FAILED — the restored copy differs from the source; the dump was deleted");
  }
  console.log(`VERIFIED: ${report.tablesCompared} tables, ${report.rowsCompared} rows, restore database dropped; report ${report.dump.path}.verify.json`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

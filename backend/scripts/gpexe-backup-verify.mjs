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
// The source is only read. It must be on this machine (localhost): this is
// not a tool for the deployed database.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
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
export function pgEnv(url, parentEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (!/^PG[A-Z]/.test(key.toUpperCase())) env[key] = value;
  }
  env.PGPASSWORD = decodeURIComponent(url.password);
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

export function pgDumpArgs(source, database, snapshot, dump) {
  return ["-Fc", `--snapshot=${snapshot}`, "-f", dump, ...pgConnectionArgs(source, database)];
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

export async function fingerprint(client) {
  const tables = {};
  const tableRows = (await client.query(
    `select n.nspname as schema, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and ${USER_SCHEMA_FILTER}
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
  const catalog = {
    schemas: await list(`select n.nspname as item from pg_namespace n where ${USER_SCHEMA_FILTER}`),
    extensions: await list(`select extname || ' ' || extversion as item from pg_extension`),
    columns: await list(
      `select n.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
              || case when a.attnotnull then ' not null' else '' end
              || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') as item
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where c.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped and ${USER_SCHEMA_FILTER}`,
    ),
    constraints: (await client.query(
      `select con.conrelid::regclass::text || ' ' || con.conname || ' ' || con.contype::text as head, con.contype::text as type, pg_get_constraintdef(con.oid) as def
         from pg_constraint con join pg_namespace n on n.oid = con.connamespace
        where con.conrelid <> 0 and ${USER_SCHEMA_FILTER}`,
    )).rows.map((r) => `${r.head} ${r.type === "c" ? normalizeCheck(r.def) : r.def}`).sort(),
    // A partial index's WHERE is re-printed the same way as a CHECK.
    indexes: (await client.query(
      `select pg_get_indexdef(i.indexrelid) as def
         from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
        where ${USER_SCHEMA_FILTER}`,
    )).rows.map((r) => normalizeIndex(r.def)).sort(),
    views: await list(
      `select n.nspname || '.' || c.relname || ' ' || c.relkind::text || ' ' || md5(pg_get_viewdef(c.oid)) as item
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('v', 'm') and ${USER_SCHEMA_FILTER}`,
    ),
    functions: await list(
      `select p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) as item
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prokind in ('f', 'p') and ${USER_SCHEMA_FILTER}`,
    ),
    // tgenabled is part of the item on purpose: a restored copy whose
    // protective triggers came back disabled is not the same database.
    triggers: await list(
      `select t.tgrelid::regclass::text || ' ' || t.tgname || ' enabled=' || t.tgenabled::text || ' ' || md5(pg_get_triggerdef(t.oid)) as item
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where not t.tgisinternal and ${USER_SCHEMA_FILTER}`,
    ),
    sequences: await list(
      `select schemaname || '.' || sequencename || ' last=' || coalesce(last_value::text, 'unused') as item
         from pg_sequences where schemaname not in ('pg_catalog', 'information_schema')`,
    ),
  };
  return { tables, catalog };
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

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--dump") opts.dump = value;
    else if (flag === "--pg-bin") opts.pgBin = value;
    else if (flag === "--database-url") opts.databaseUrl = value;
    else throw new Error(`unknown argument ${flag}`);
    i += 1;
  }
  return opts;
}

export async function main(argv) {
  const opts = parseCliArgs(argv);
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("--database-url or DATABASE_URL is required");
  const report = await backupAndVerify({
    databaseUrl, dumpPath: opts.dump, pgBin: opts.pgBin ?? process.env.PG_BIN ?? "", log: (line) => console.log(line),
  });
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

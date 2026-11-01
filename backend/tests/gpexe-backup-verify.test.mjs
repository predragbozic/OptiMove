// The backup check proves a trial restore, not a pg_dump exit code. Its
// source here is a disposable database holding a real GPEXE import; the
// restore copy is another disposable database the script drops itself.
// Nothing touches a persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { importGpexePlan } from "../src/gpexeImportWriter.js";
import { PassThrough } from "node:stream";
import { APP_SCHEMAS, backupAndVerify, backupAndVerifyRemote, checkSchemaList, dumpCreatesSchema, main as backupMain, normalizeCheck, normalizeIndex, NOT_COMPARED, pgConnectionArgs, pgDumpArgs, pgEnv, pgRestoreArgs, preflightRemote, promptHidden, reconcileMovedSequences, sanitizeRemoteError, sanitizeToolError } from "../scripts/gpexe-backup-verify.mjs";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const PG_BIN = process.env.PG_BIN ?? "";

function pgDumpAvailable() {
  try {
    execFileSync(PG_BIN ? path.join(PG_BIN, process.platform === "win32" ? "pg_dump.exe" : "pg_dump") : "pg_dump", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const skip = pgDumpAvailable() ? false : "pg_dump not found — set PG_BIN to the PostgreSQL bin directory";
// The remote mode names its tools by directory (--pg-bin), never by the PATH.
const BIN_DIR = skip ? "" : (PG_BIN || path.dirname(execFileSync("sh", ["-c", "command -v pg_dump"]).toString().trim()));
const stubSkip = skip || (process.platform === "win32" ? "the tool stubs are shell scripts" : false);

let db;
let admin;
let workDir;

before(async () => {
  if (skip) return;
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "backupsrc" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  const org = await createGpexePilotOrg(admin, { athleteNames: ["Athlete A", "Athlete B", "Athlete C"] });
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    await importGpexePlan(client, buildGpexeImportPlan(makeBundle({ sessionId: 6301, athletes: standardAthletes() })), {
      ownerTeamId: org.teamId, performedByUserId: org.userId,
      athleteIdByGpexeId: { 101: org.athleteIds[0], 102: org.athleteIds[1], 103: org.athleteIds[2] }, batchFilename: "backup verify",
    });
  } finally {
    await client.end();
  }
  // The shape that made the first real run against the local database fail:
  // a partial index whose WHERE is an IN list on a varchar column.
  await admin.query(`create table public.backup_probe (status varchar(20) not null)`);
  await admin.query(`create index backup_probe_open_idx on public.backup_probe (status) where status in ('pending', 'requires_login')`);
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gpexe-backup-verify-"));
});

after(async () => {
  if (admin) await admin.end();
  if (db) await db.drop();
  if (workDir) await fsp.rm(workDir, { recursive: true, force: true });
});

function dumpPath() {
  return path.join(workDir, `backup-${crypto.randomBytes(4).toString("hex")}.dump`);
}

async function databaseExists(name) {
  return (await admin.query(`select 1 from pg_database where datname = $1`, [name])).rowCount === 1;
}

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

test("backup: an untouched restore matches the source table by table and row by row; the copy is dropped, the dump kept", { skip }, async () => {
  const dump = dumpPath();
  let claimedBeforeDump;
  const report = await backupAndVerify({
    databaseUrl: db.url, dumpPath: dump, pgBin: PG_BIN,
    // The path is taken (created exclusively) before pg_dump starts, so no
    // file that appears in between can be written over.
    onSnapshotExported: () => { claimedBeforeDump = fs.existsSync(dump) && fs.statSync(dump).size === 0; },
  });
  assert.equal(claimedBeforeDump, true);
  assert.equal(report.verified, true, JSON.stringify(report.mismatches));
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.source.database, db.name);
  assert.ok(report.tablesCompared > 50, `${report.tablesCompared} tables`);
  const values = (await admin.query(`select count(*)::int as c from training_load.metric_values`)).rows[0].c;
  assert.ok(values > 0);
  assert.ok(report.rowsCompared >= values);
  assert.ok(report.catalogCompared.triggers > 0 && report.catalogCompared.functions > 0);
  assert.equal(report.restoreDropped, true);
  assert.equal(await databaseExists(report.restoreDatabase), false, "the restore copy is gone");
  // v32's CHECK comes back with its ANDs regrouped; Postgres's own re-parse
  // shows it is the same constraint (reconcileReprintedChecks).
  assert.ok(report.reprintedChecks.includes("training_load.gpexe_athlete_identities.gpexe_athlete_identities_display_name"), JSON.stringify(report.reprintedChecks));
  assert.ok(fs.existsSync(dump), "the verified dump is kept");
  const onDisk = crypto.createHash("sha256").update(fs.readFileSync(dump)).digest("hex");
  assert.equal(report.dump.sha256, onDisk);
  const written = JSON.parse(fs.readFileSync(`${dump}.verify.json`, "utf8"));
  assert.equal(written.verified, true);
  const password = decodeURIComponent(new URL(db.url).password);
  if (password) assert.ok(!JSON.stringify(written).includes(password), "the report never carries the password");
});

test("backup: a changed value in the restored copy is caught, and that dump is deleted", { skip }, async () => {
  const dump = dumpPath();
  const report = await backupAndVerify({
    databaseUrl: db.url, dumpPath: dump, pgBin: PG_BIN,
    // Same row count, one number different: only the content digest can see it.
    onRestored: (url) => withClient(url, async (c) => {
      await c.query(`alter table training_load.metric_values disable trigger user`);
      await c.query(`update training_load.metric_values set value_numeric = value_numeric + 1 where id = (select id from training_load.metric_values where value_numeric is not null order by id limit 1)`);
    }),
  });
  assert.equal(report.verified, false);
  const values = (await admin.query(`select count(*)::int as c from training_load.metric_values`)).rows[0].c;
  const tables = report.mismatches.filter((m) => m.kind === "table").map((m) => `${m.name}: ${m.problem}`);
  assert.deepEqual(tables, [`training_load.metric_values: same row count (${values}) but different content`]);
  assert.equal(await databaseExists(report.restoreDatabase), false);
  assert.equal(fs.existsSync(dump), false, "an unverified dump does not survive");
  assert.equal(fs.existsSync(`${dump}.verify.json`), false);
});

test("backup: a missing row, a protective trigger left disabled, a narrowed CHECK and a narrowed partial index are all caught", { skip }, async () => {
  const report = await backupAndVerify({
    databaseUrl: db.url, dumpPath: dumpPath(), pgBin: PG_BIN,
    onRestored: (url) => withClient(url, async (c) => {
      await c.query(`delete from public.optimove_disposable_test_database`);
      await c.query(`alter table training_load.metric_values disable trigger metric_values_immutable`);
      // A CHECK that allows less: comparing it without casts must still see it.
      await c.query(`alter table training.activities drop constraint activities_origin_check`);
      await c.query(`alter table training.activities add constraint activities_origin_check check (origin in ('api_import', 'manual')) not valid`);
      await c.query(`drop index public.backup_probe_open_idx`);
      await c.query(`create index backup_probe_open_idx on public.backup_probe (status) where status in ('pending')`);
    }),
  });
  assert.equal(report.verified, false);
  const marker = report.mismatches.find((m) => m.name === "public.optimove_disposable_test_database");
  assert.match(marker.problem, /^row count 1 in the source, 0 restored$/);
  const triggers = report.mismatches.find((m) => m.kind === "catalog" && m.name === "triggers");
  assert.ok(triggers, JSON.stringify(report.mismatches));
  assert.ok(triggers.missing.some((t) => t.includes("metric_values_immutable enabled=O")));
  assert.ok(triggers.extra.some((t) => t.includes("metric_values_immutable enabled=D")));
  const constraints = report.mismatches.find((m) => m.kind === "catalog" && m.name === "constraints");
  assert.deepEqual(constraints.missing.map((c) => c.split(" ")[1]), ["activities_origin_check"]);
  assert.deepEqual(constraints.extra.map((c) => c.split(" ")[1]), ["activities_origin_check"]);
  const indexes = report.mismatches.find((m) => m.kind === "catalog" && m.name === "indexes");
  assert.equal(indexes.missing.length, 1);
  assert.match(indexes.missing[0], /backup_probe_open_idx .* WHERE .*'pending'.*'requires_login'/);
  assert.match(indexes.extra[0], /backup_probe_open_idx .* WHERE .*'pending'/);
  assert.doesNotMatch(indexes.extra[0], /requires_login/);
});

test("backup: a write to the source after the snapshot is in neither the dump nor the fingerprint", { skip }, async () => {
  const clubName = `written after the snapshot ${crypto.randomBytes(3).toString("hex")}`;
  let restoredHasIt;
  const report = await backupAndVerify({
    databaseUrl: db.url, dumpPath: dumpPath(), pgBin: PG_BIN,
    onSnapshotExported: () => admin.query(`insert into public.clubs (name) values ($1)`, [clubName]),
    onRestored: (url) => withClient(url, async (c) => {
      restoredHasIt = (await c.query(`select 1 from public.clubs where name = $1`, [clubName])).rowCount === 1;
    }),
  });
  assert.equal(report.verified, true, JSON.stringify(report.mismatches));
  assert.equal(restoredHasIt, false, "the dump was taken on the exported snapshot");
  assert.equal((await admin.query(`select 1 from public.clubs where name = $1`, [clubName])).rowCount, 1, "while the source did get the row");
});

test("backup: refuses a remote source, an existing dump, and a dump path inside a git work tree", { skip }, async () => {
  const remote = new URL(db.url);
  remote.hostname = "db.example.com";
  await assert.rejects(backupAndVerify({ databaseUrl: remote.toString(), dumpPath: dumpPath(), pgBin: PG_BIN }), /is not this machine/);

  const existing = dumpPath();
  await fsp.writeFile(existing, "an earlier backup");
  await assert.rejects(backupAndVerify({ databaseUrl: db.url, dumpPath: existing, pgBin: PG_BIN }), /already exists — a backup is never overwritten/);
  assert.equal(fs.readFileSync(existing, "utf8"), "an earlier backup");

  const inRepo = path.resolve(import.meta.dirname, `backup-${crypto.randomBytes(4).toString("hex")}.dump`);
  await assert.rejects(backupAndVerify({ databaseUrl: db.url, dumpPath: inRepo, pgBin: PG_BIN }), /inside a git work tree/);
  assert.equal(fs.existsSync(inRepo), false);

  await assert.rejects(backupMain(["--database-url", db.url, "--pg-bin", PG_BIN]), /--dump <path> is required/);

  // A local-looking URL whose query string points the driver somewhere else.
  const redirected = new URL(db.url);
  redirected.search = "?host=db.example.com";
  const redirectedDump = dumpPath();
  await assert.rejects(backupAndVerify({ databaseUrl: redirected.toString(), dumpPath: redirectedDump, pgBin: PG_BIN }), /must not carry query parameters/);
  assert.equal(fs.existsSync(redirectedDump), false, "refused before the path was even claimed");

  // A database name that cannot be decoded fails before the path is claimed.
  const undecodable = new URL(db.url);
  undecodable.pathname = "/%E0%A4%A";
  const undecodableDump = dumpPath();
  await assert.rejects(backupAndVerify({ databaseUrl: undecodable.toString(), dumpPath: undecodableDump, pgBin: PG_BIN }), URIError);
  assert.equal(fs.existsSync(undecodableDump), false);
});

test("backup: when the source side fails while pg_dump is still writing, no dump and no restore database are left", { skip }, async () => {
  const dump = dumpPath();
  const restoreNamesBefore = (await admin.query(`select count(*)::int as c from pg_database where datname like 'optimove_tests_gpexe_restore_%'`)).rows[0].c;
  await assert.rejects(backupAndVerify({
    databaseUrl: db.url, dumpPath: dump, pgBin: PG_BIN,
    // The fingerprint's connection dies right after pg_dump has been started.
    onDumpStarted: ({ sourcePid }) => admin.query(`select pg_terminate_backend($1)`, [sourcePid]),
  }));
  // Anything pg_dump could still write would land within this window.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(fs.existsSync(dump), false, "no partial dump survives");
  assert.equal(fs.existsSync(`${dump}.verify.json`), false);
  const restoreNamesAfter = (await admin.query(`select count(*)::int as c from pg_database where datname like 'optimove_tests_gpexe_restore_%'`)).rows[0].c;
  assert.equal(restoreNamesAfter, restoreNamesBefore);
});

test("backup: pg_dump and pg_restore get no inherited libpq variable, only the password and explicit connection arguments", () => {
  const url = new URL("postgresql://backup_user:s%40cret@localhost:5433/OPTIMOVE");
  const env = pgEnv(url, {
    PGHOSTADDR: "203.0.113.10", PGSERVICE: "elsewhere", PGSERVICEFILE: "C:/x/pg_service.conf", PGPASSFILE: "C:/x/pgpass",
    PGHOST: "db.example.com", PGPORT: "6543", PGUSER: "someone", PGDATABASE: "other", PGOPTIONS: "-c x=y", PGSSLMODE: "disable",
    pghostaddr: "203.0.113.11", PG_BIN: "C:/pg/bin", Path: "C:/Windows", SystemRoot: "C:/Windows",
  });
  assert.deepEqual(Object.keys(env).sort(), ["PGPASSWORD", "PG_BIN", "Path", "SystemRoot"]);
  assert.equal(env.PGPASSWORD, "s@cret");
  assert.deepEqual(pgConnectionArgs(url, "OPTIMOVE"), ["--host", "localhost", "--port", "5433", "--username", "backup_user", "--dbname", "OPTIMOVE", "--no-password"]);
  assert.deepEqual(pgConnectionArgs(new URL("postgresql://u@[::1]/db"), "db").slice(0, 4), ["--host", "::1", "--port", "5432"]);
  const connection = ["--host", "localhost", "--port", "5433", "--username", "backup_user"];
  assert.deepEqual(pgDumpArgs(url, "OPTIMOVE", "00000003-1", "C:/b/x.dump"),
    ["-Fc", "--snapshot=00000003-1", "-f", "C:/b/x.dump", ...connection, "--dbname", "OPTIMOVE", "--no-password"]);
  assert.deepEqual(pgRestoreArgs(url, "optimove_tests_gpexe_restore_0123456789", "C:/b/x.dump"),
    ["--exit-on-error", "--no-owner", "--no-privileges", ...connection, "--dbname", "optimove_tests_gpexe_restore_0123456789", "--no-password", "C:/b/x.dump"]);
});

test("backup: a non-local PGHOSTADDR and a PGSERVICE in the parent environment do not reach pg_dump or pg_restore", { skip }, async () => {
  const saved = { PGHOSTADDR: process.env.PGHOSTADDR, PGSERVICE: process.env.PGSERVICE, PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT };
  // 203.0.113.0/24 is TEST-NET-3: never a real server. Were it inherited,
  // pg_dump would try it (and give up after 3 s) instead of localhost, and
  // the unknown service name alone would already make libpq refuse.
  process.env.PGHOSTADDR = "203.0.113.10";
  process.env.PGSERVICE = "optimove_no_such_service";
  process.env.PGCONNECT_TIMEOUT = "3";
  let report;
  try {
    report = await backupAndVerify({ databaseUrl: db.url, dumpPath: dumpPath(), pgBin: PG_BIN });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(report.verified, true, JSON.stringify(report.mismatches));
  assert.equal(report.source.database, db.name);
  assert.equal(report.restoreDropped, true);
});

test("backup: a database name that libpq would read as a connection string is refused", async () => {
  const u = new URL(ORIGINAL_DATABASE_URL);
  u.pathname = "/" + encodeURIComponent("host=db.example.com dbname=x");
  await assert.rejects(backupAndVerify({ databaseUrl: u.toString(), dumpPath: path.join(os.tmpdir(), "never-created.dump") }), /must be a plain name/);
  assert.equal(fs.existsSync(path.join(os.tmpdir(), "never-created.dump")), false);
});

test("backup: the catalog normalization rewrites only the re-printed IN list, nothing else", () => {
  const before = "CHECK (((status)::text = ANY ((ARRAY['a'::character varying, 'it''s, b'::character varying])::text[])))";
  const after = "CHECK (((status)::text = ANY (ARRAY[('a'::character varying)::text, ('it''s, b'::character varying)::text])))";
  assert.equal(normalizeCheck(before), normalizeCheck(after));
  assert.equal(normalizeCheck(after), after, "the restored form is left as it is");
  // Grouping and casts are still compared.
  assert.notEqual(normalizeCheck("CHECK (((a IS NULL) OR ((b > 0) AND (c > 0))))"), normalizeCheck("CHECK ((((a IS NULL) OR (b > 0)) AND (c > 0)))"));
  assert.notEqual(normalizeCheck("CHECK ((x = '1'::integer))"), normalizeCheck("CHECK ((x = '1'::text))"));
  assert.notEqual(normalizeCheck(before), normalizeCheck(after.replace("'a'", "'z'")));
  assert.equal(normalizeIndex("CREATE INDEX i ON t USING btree (s) WHERE ((s)::text = ANY ((ARRAY['a'::character varying])::text[]))"),
    "CREATE INDEX i ON t USING btree (s) WHERE ((s)::text = ANY (ARRAY[('a'::character varying)::text]))");
  assert.equal(normalizeIndex("CREATE INDEX i ON t USING btree (s)"), "CREATE INDEX i ON t USING btree (s)");
  for (const kind of ["ownership and privileges", "domain constraints", "row-level security", "materialized view contents"]) {
    assert.ok(NOT_COMPARED.some((line) => line.startsWith(kind)), kind);
  }
});

// ---------------------------------------------------------------------------
// The remote mode (J17, O2): the deployed database read from the owner's
// computer over TLS, only the application's schemas, restored into a new
// database on the local server. Here the "remote" source is a disposable
// database on this machine's server, reached over TLS like the real one.

function withoutPassword(raw, database) {
  const u = new URL(raw);
  const password = decodeURIComponent(u.password);
  u.password = "";
  if (database) u.pathname = `/${database}`;
  return { url: u.toString(), password };
}

async function withConfig(config, fn) {
  const client = new pg.Client(config);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function prepareOutsideObjects() {
  // What a hosted database has besides the application: a schema of its own,
  // and an extension installed into one of the application's schemas.
  await admin.query(`create schema if not exists outside_app`);
  await admin.query(`create table if not exists outside_app.not_ours (x int)`);
  await admin.query(`insert into outside_app.not_ours values (1)`);
  await admin.query(`create extension if not exists pgcrypto with schema public`);
}

// The disposable database carries migrations_v2's GPEXE subset, so not every
// application schema exists in it; the remote mode refuses a listed schema
// the source lacks, so the tests list the ones present.
async function presentAppSchemas() {
  const present = (await admin.query(`select nspname from pg_namespace where nspname = any($1::text[])`, [[...APP_SCHEMAS]])).rows.map((r) => r.nspname);
  assert.ok(present.includes("public") && present.includes("training_load"));
  return present.sort();
}

async function remoteArgs(dump, extra = {}) {
  const src = withoutPassword(db.url);
  const rst = withoutPassword(ORIGINAL_DATABASE_URL, "postgres");
  return {
    sourceUrl: src.url, sourcePassword: src.password, restoreUrl: rst.url, restorePassword: rst.password, dumpPath: dump, pgBin: BIN_DIR,
    schemas: await presentAppSchemas(), skipSchemas: ["outside_app"], ...extra,
  };
}

test("remote: a TLS source, the application's schemas only, restored into a new local database and compared; the rest is listed, not dumped", { skip }, async () => {
  await prepareOutsideObjects();
  const dump = dumpPath();
  let sourceUsedTls;
  let outsideRestored;
  const report = await backupAndVerifyRemote(await remoteArgs(dump, {
    onDumpStarted: async ({ sourcePid }) => {
      sourceUsedTls = (await admin.query(`select ssl from pg_stat_ssl where pid = $1`, [sourcePid])).rows[0]?.ssl;
    },
    onRestored: (config) => withConfig(config, async (c) => {
      outsideRestored = (await c.query(`select 1 from pg_namespace where nspname = 'outside_app'`)).rowCount;
    }),
  }));
  assert.equal(report.verified, true, JSON.stringify(report.mismatches));
  assert.equal(sourceUsedTls, true, "the source session ran over TLS");
  assert.equal(report.mode, "remote-source");
  assert.equal(report.sslMode, "require");
  assert.deepEqual(report.schemas, await presentAppSchemas());
  assert.ok(report.schemasLeftOut.includes("outside_app"), JSON.stringify(report.schemasLeftOut));
  assert.deepEqual(report.schemasSkippedByOwner, ["outside_app"]);
  assert.equal(outsideRestored, 0, "a schema that is not listed is not dumped");
  assert.ok(report.extensionsInDumpedSchemas.some((e) => e.startsWith("pgcrypto ")), "the extension is listed, not compared");
  assert.ok(report.tablesCompared > 50, `${report.tablesCompared} tables`);
  assert.equal(report.restoreDropped, true);
  assert.equal(await databaseExists(report.restoreDatabase), false, "the restore copy is gone");
  assert.ok(fs.existsSync(dump), "the verified dump is kept");
  if (process.platform !== "win32") assert.equal(fs.statSync(dump).mode & 0o777, 0o600, "the dump is readable by its owner only");
  assert.equal(report.dump.sha256, crypto.createHash("sha256").update(fs.readFileSync(dump)).digest("hex"));
  const written = JSON.parse(fs.readFileSync(`${dump}.verify.json`, "utf8"));
  assert.equal(written.verified, true);
  for (const secret of [withoutPassword(db.url).password, withoutPassword(ORIGINAL_DATABASE_URL).password]) {
    if (secret) assert.ok(!JSON.stringify(written).includes(secret), "the report never carries a password");
  }
});

test("remote: a changed value in the restored copy is caught, and that dump is deleted", { skip }, async () => {
  await prepareOutsideObjects();
  const dump = dumpPath();
  const report = await backupAndVerifyRemote(await remoteArgs(dump, {
    onRestored: (config) => withConfig(config, async (c) => {
      await c.query(`alter table training_load.metric_values disable trigger user`);
      await c.query(`update training_load.metric_values set value_numeric = value_numeric + 1 where id = (select id from training_load.metric_values where value_numeric is not null order by id limit 1)`);
    }),
  }));
  assert.equal(report.verified, false);
  assert.ok(report.mismatches.some((m) => m.name === "training_load.metric_values" && /different content/.test(m.problem)), JSON.stringify(report.mismatches));
  assert.equal(await databaseExists(report.restoreDatabase), false);
  assert.equal(fs.existsSync(dump), false, "an unverified dump does not survive");
  assert.equal(fs.existsSync(`${dump}.verify.json`), false);
});

test("remote: a password in a URL, a remote restore host, TLS settings and bad schema lists are refused before anything is written", { skip }, async () => {
  const base = await remoteArgs(dumpPath());
  const withPassword = new URL(db.url);
  const cases = [
    [{ sourceUrl: withPassword.toString() }, /must not carry a password/],
    [{ restoreUrl: new URL(ORIGINAL_DATABASE_URL).toString() }, /must not carry a password/],
    [{ restoreUrl: withoutPassword(ORIGINAL_DATABASE_URL.replace(/@[^/]+\//, "@db.example.com:5432/"), "postgres").url }, /is not this machine/],
    [{ sourceUrl: `${base.sourceUrl}?host=db.example.com` }, /must not carry query parameters/],
    [{ sslMode: "disable" }, /is not one of require, verify-full/],
    [{ sslMode: "verify-full" }, /verify-full needs --ssl-root-cert/],
    [{ sslRootCert: path.join(workDir, "ca.crt") }, /used only with verify-full/],
    [{ schemas: [] }, /at least one schema/],
    [{ schemas: ["public; drop schema public"] }, /not an application schema name/],
    [{ schemas: ["pg_catalog"] }, /not an application schema name/],
    [{ schemas: ["public", "public"] }, /listed twice/],
    [{ sourcePassword: undefined }, /source password is missing/],
  ];
  for (const [change, expected] of cases) {
    const dump = dumpPath();
    await assert.rejects(backupAndVerifyRemote({ ...base, dumpPath: dump, ...change }), expected, JSON.stringify(change));
    assert.equal(fs.existsSync(dump), false, `nothing claimed for ${JSON.stringify(change)}`);
  }
  // A schema the source has that is neither dumped, known as the hosting
  // provider's, nor acknowledged: refused before the dump, path removed.
  await prepareOutsideObjects();
  const notAcknowledged = dumpPath();
  await assert.rejects(backupAndVerifyRemote({ ...base, dumpPath: notAcknowledged, skipSchemas: [] }), /the source has schema outside_app, neither listed nor known/);
  assert.equal(fs.existsSync(notAcknowledged), false);
  await assert.rejects(backupAndVerifyRemote({ ...base, dumpPath: dumpPath(), skipSchemas: ["public"] }), /both dumped and skipped/);
  // A listed schema the source lacks: refused after connecting, and the
  // claimed path is removed again.
  const dump = dumpPath();
  await assert.rejects(backupAndVerifyRemote({ ...base, dumpPath: dump, schemas: ["public", "no_such_schema"] }), /the source has no schema no_such_schema/);
  assert.equal(fs.existsSync(dump), false);
  assert.deepEqual(checkSchemaList(["training_load", "public"]), ["public", "training_load"]);
});

test("remote: pg_dump gets the password, sslmode and root certificate through its own variables only, and only the listed schemas", () => {
  const url = new URL("postgresql://postgres.someproject@pooler.example.com:5432/postgres");
  const env = pgEnv(url, { PGSSLMODE: "disable", PGHOST: "elsewhere", PGSSLROOTCERT: "C:/old.crt", Path: "C:/Windows" }, { password: "s3cret", sslMode: "require" });
  assert.deepEqual(Object.keys(env).sort(), ["PGPASSWORD", "PGSSLMODE", "Path"]);
  assert.equal(env.PGPASSWORD, "s3cret");
  assert.equal(env.PGSSLMODE, "require");
  const full = pgEnv(url, {}, { password: "s3cret", sslMode: "verify-full", sslRootCert: "C:/ca.crt" });
  assert.deepEqual(full, { PGPASSWORD: "s3cret", PGSSLMODE: "verify-full", PGSSLROOTCERT: "C:/ca.crt" });
  assert.deepEqual(pgDumpArgs(url, "postgres", "00000003-1", "C:/b/x.dump", ["public", "training"]),
    ["-Fc", "--snapshot=00000003-1", "--strict-names", "--schema", "public", "--schema", "training", "-f", "C:/b/x.dump",
      "--host", "pooler.example.com", "--port", "5432", "--username", "postgres.someproject", "--dbname", "postgres", "--no-password"]);
  assert.deepEqual(pgDumpArgs(url, "postgres", "00000003-1", "C:/b/x.dump", ["public"], { lockWaitTimeout: "60s" }).slice(0, 5),
    ["-Fc", "--snapshot=00000003-1", "--lock-wait-timeout=60s", "--strict-names", "--schema"]);
});

test("remote: the CLI asks for both passwords only after its checks, never takes --database-url, and runs end to end", { skip }, async () => {
  const src = withoutPassword(db.url);
  const rst = withoutPassword(ORIGINAL_DATABASE_URL, "postgres");
  const asked = [];
  const readPassword = async (question) => {
    asked.push(question);
    return asked.length === 1 ? src.password : rst.password;
  };
  await assert.rejects(backupMain(["--remote-source", "--restore-url", rst.url, "--dump", dumpPath()], { readPassword }), /--source-url is required/);
  await assert.rejects(backupMain(["--remote-source", "--source-url", src.url, "--restore-url", rst.url, "--dump", dumpPath(), "--database-url", db.url], { readPassword }), /never --database-url/);
  await assert.rejects(backupMain(["--remote-source", "--source-url", db.url, "--restore-url", rst.url, "--dump", dumpPath(), "--pg-bin", BIN_DIR], { readPassword }), /must not carry a password/);
  await assert.rejects(backupMain(["--source-url", src.url, "--dump", dumpPath()], { readPassword }), /belong to --remote-source/);
  await assert.rejects(backupMain(["--remote-source", "--source-url"], { readPassword }), /--source-url needs a value/);
  // Every check that needs no password, through the real CLI: none of them asks.
  const savedPgBin = process.env.PG_BIN;
  delete process.env.PG_BIN;
  try {
    const cli = (extra, dump = dumpPath()) => backupMain(["--remote-source", "--source-url", src.url, "--restore-url", rst.url, "--dump", dump, ...extra], { readPassword });
    await assert.rejects(cli([]), /--pg-bin <the PostgreSQL bin directory> is required/);
    await assert.rejects(backupMain(["--remote-source", "--source-url", src.url, "--restore-url", withoutPassword(ORIGINAL_DATABASE_URL.replace(/@[^/]+\//, "@db.example.com:5432/"), "postgres").url, "--dump", dumpPath(), "--pg-bin", BIN_DIR], { readPassword }), /is not this machine/);
    const pooled = new URL(src.url);
    pooled.port = "6543";
    await assert.rejects(backupMain(["--remote-source", "--source-url", pooled.toString(), "--restore-url", rst.url, "--dump", dumpPath(), "--pg-bin", BIN_DIR], { readPassword }), /port 6543 is the transaction pooler/);
    await assert.rejects(cli(["--pg-bin", BIN_DIR], path.join(path.resolve(import.meta.dirname, "..", ".."), `x-${crypto.randomBytes(3).toString("hex")}.dump`)), /inside a git work tree/);
    await assert.rejects(cli(["--pg-bin", BIN_DIR], path.join(workDir, "no-such-dir", "x.dump")), /does not exist/);
    await assert.rejects(cli(["--pg-bin", BIN_DIR, "--schema", "Training"]), /not an application schema name/);
    await assert.rejects(cli(["--pg-bin", BIN_DIR, "--schema", "public", "--skip-schema", "public"]), /both dumped and skipped/);
    await assert.rejects(cli(["--pg-bin", path.join(workDir, "no-bin")]), /pg_dump was not found/);
    await assert.rejects(cli(["--pg-bin", BIN_DIR, "--ssl-root-cert", path.join(workDir, "missing.crt")]), /verify-full needs --ssl-root-cert/);
  } finally {
    if (savedPgBin !== undefined) process.env.PG_BIN = savedPgBin;
  }
  assert.deepEqual(asked, [], "no password is asked for before the checks pass");
  await prepareOutsideObjects();
  const dump = dumpPath();
  const schemaFlags = (await presentAppSchemas()).flatMap((name) => ["--schema", name]);
  const report = await backupMain(["--remote-source", "--source-url", src.url, "--restore-url", rst.url, "--dump", dump, ...schemaFlags, "--skip-schema", "outside_app", "--pg-bin", BIN_DIR], { readPassword });
  assert.equal(asked.length, 2);
  assert.equal(report.verified, true, JSON.stringify(report.mismatches));
  assert.equal(report.sslMode, "require");
  assert.ok(fs.existsSync(`${dump}.verify.json`));
});

test("remote: a password is read only from an interactive terminal", async () => {
  await assert.rejects(promptHidden("Password: ", { input: { isTTY: false }, output: { write() {} } }), /only from an interactive terminal/);
});

function fakeTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const written = [];
  const output = { isTTY: true, columns: 80, write(text) { written.push(String(text)); return true; } };
  return { input, output, written };
}

test("remote: a typed password is never echoed, and Ctrl+C cancels the prompt", async () => {
  const typed = fakeTerminal();
  const answer = promptHidden("Password: ", { input: typed.input, output: typed.output });
  typed.input.write("s3cret-Pa55");
  typed.input.write("\r");
  assert.equal(await answer, "s3cret-Pa55");
  assert.ok(typed.written.join("").includes("Password: "), "the question is shown");
  assert.ok(!typed.written.join("").includes("s3c"), "no typed character reaches the screen");
  const cancelled = fakeTerminal();
  const pending = promptHidden("Password: ", { input: cancelled.input, output: cancelled.output });
  cancelled.input.write("abc\u0003");
  await assert.rejects(pending, /cancelled/);
  assert.ok(!cancelled.written.join("").includes("abc"));
  // Ctrl+D on an empty line, and the input simply ending: never a silent wait (bounded, so a hang fails fast).
  const within = (promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("still waiting after 2 s")), 2000).unref())]);
  const eof = fakeTerminal();
  const closing = promptHidden("Password: ", { input: eof.input, output: eof.output });
  eof.input.write("\u0004");
  await assert.rejects(within(closing), /cancelled/);
  const ended = fakeTerminal();
  const ending = promptHidden("Password: ", { input: ended.input, output: ended.output });
  ended.input.end();
  await assert.rejects(within(ending), /cancelled/);
});

test("remote: the table of contents tells whether the dump recreates a schema", () => {
  const toc = [";", "; Archive created at 2026-11-01", "215; 2615 2200 SCHEMA - public postgres", "216; 2615 16385 SCHEMA - training postgres", "3001; 1259 16390 TABLE public clubs postgres"].join("\r\n");
  assert.equal(dumpCreatesSchema(toc, "public"), true);
  assert.equal(dumpCreatesSchema(toc, "training"), true);
  assert.equal(dumpCreatesSchema(toc, "plans"), false);
  assert.equal(dumpCreatesSchema("3001; 1259 16390 TABLE public clubs postgres", "public"), false);
});

// A directory whose pg_dump is a shell script around the real one, and whose
// pg_restore is the real one.
function stubBin(script) {
  const dir = fs.mkdtempSync(path.join(workDir, "bin-"));
  fs.symlinkSync(path.join(BIN_DIR, "pg_restore"), path.join(dir, "pg_restore"));
  fs.writeFileSync(path.join(dir, "pg_dump"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return dir;
}

test("remote: pg_dump itself runs with PGSSLMODE=require and a bounded lock wait", { skip: stubSkip }, async () => {
  await prepareOutsideObjects();
  const seen = path.join(workDir, `seen-${crypto.randomBytes(3).toString("hex")}`);
  const real = path.join(BIN_DIR, "pg_dump");
  const bin = stubBin(`if [ "$1" = "--version" ]; then exec "${real}" "$@"; fi\nprintf '%s %s' "$PGSSLMODE" "$*" > "${seen}"\nexec "${real}" "$@"`);
  const report = await backupAndVerifyRemote(await remoteArgs(dumpPath(), { pgBin: bin }));
  assert.equal(report.verified, true, JSON.stringify(report.mismatches));
  const [mode, ...args] = fs.readFileSync(seen, "utf8").split(" ");
  assert.equal(mode, "require", "the pg_dump process itself was told to require TLS");
  assert.ok(args.includes("--lock-wait-timeout=60s"), args.join(" "));
});

test("remote: a failed pg_dump is reported by its own error line, with host, user, quoted text and addresses masked; nothing is left behind", { skip: stubSkip }, async () => {
  await prepareOutsideObjects();
  const real = path.join(BIN_DIR, "pg_dump");
  const bin = stubBin([
    `if [ "$1" = "--version" ]; then exec "${real}" "$@"; fi`,
    `echo 'pg_dump: error: connection to server at "pooler.secret-host.example" (10.1.2.3), port 5432 failed: FATAL:  password authentication failed for user "postgres.secretref"' >&2`,
    `echo 'CONTEXT:  COPY athletes, line 1: "Petar Petrovic"' >&2`,
    `echo 'pg_dump: detail: Key (email)=(petar@example.com) already exists.' >&2`,
    `echo "pg_dump: error: pw=$PGPASSWORD args=$*" >&2`,
    "exit 1",
  ].join("\n"));
  const dump = dumpPath();
  const error = await backupAndVerifyRemote(await remoteArgs(dump, { pgBin: bin })).then(() => null, (e) => e);
  assert.ok(error, "the run fails");
  assert.match(error.message, /^pg_dump failed \(exit code 1\): pg_dump: error: connection to server at "…" \(<ip>\), port 5432 failed/);
  const src = withoutPassword(db.url);
  const sourceUser = decodeURIComponent(new URL(src.url).username);
  assert.match(error.message, /pw=<password> args=/, "the tool's own password line is masked, not dropped");
  for (const secret of ["secret-host", "10.1.2.3", "secretref", "Petar", "CONTEXT", "petar@", "Command failed", BIN_DIR, src.password, sourceUser, dump].filter(Boolean)) {
    assert.ok(!error.message.includes(secret), `the message does not carry ${secret}: ${error.message}`);
  }
  assert.equal(fs.existsSync(dump), false, "the unverified dump is gone");
});

test("remote: the tool error filter keeps only tool lines and masks the given values", () => {
  const error = { code: 1, stderr: [
    "pg_restore: error: could not execute query: ERROR:  invalid input syntax for type uuid: \"abc def\"",
    "Command was: COPY training.x (id) FROM stdin;",
    "pg_restore: error: COPY failed for table 'people': ERROR:  value too long",
    "DETAIL:  Failing row contains (Ana, 1990-01-01).",
  ].join("\n") };
  const text = sanitizeToolError("pg_restore", error, [["C:/b/x.dump", "<dump>"]]);
  assert.equal(text, "pg_restore failed (exit code 1): pg_restore: error: could not execute query: ERROR:  invalid input syntax for type uuid: \"…\" | pg_restore: error: COPY failed for table '…': ERROR:  value too long");
  assert.equal(sanitizeToolError("pg_dump", { code: "ENOENT" }), "pg_dump was not found — give the PostgreSQL bin directory with --pg-bin");
  assert.equal(sanitizeToolError("pg_dump", { code: 2, stderr: "something else" }), "pg_dump failed (exit code 2)");
  assert.match(sanitizeToolError("pg_dump", { code: 1, stderr: "pg_dump: error: at \"h\" (fe80::1:2), port 5432 failed: C:/b/x.dump" }, [["C:/b/x.dump", "<dump>"]]), /\(<ip>\), port 5432 failed: <dump>$/);
  // A quote left open runs to the end of the line; an address starting with "::"; a translated or detail line is dropped.
  assert.equal(sanitizeToolError("pg_restore", { code: 1, stderr: "pg_restore: error: bad value: \"Ana Petrovic\npg_restore: error: from (::1)\npg_restore: detail: Key (email)=(a@b.c)\npg_restore: fehler: Ana" }),
    "pg_restore failed (exit code 1): pg_restore: error: bad value: \"…\" | pg_restore: error: from (<ip>)");
  assert.equal(sanitizeToolError("pg_dump", { code: 1, stderr: "pg_dump: error: password postgres.ref s3cret" }, [["s3cret", "<password>"], ["postgres.ref", "<source user>"]]),
    "pg_dump failed (exit code 1): pg_dump: error: password <source user> <password>");
});

test("remote: a driver, network or TLS failure is reported by a fixed sentence and its code, never by its own text", () => {
  const own = new Error("refusing: the source has no schema x");
  assert.equal(sanitizeRemoteError(own), own, "the script's own refusals pass as they are");
  const tool = new Error("pg_dump failed (exit code 1): pg_dump: error: x");
  assert.equal(sanitizeRemoteError(tool), tool);
  const auth = Object.assign(new Error('password authentication failed for user "postgres.secretref"'), { code: "28P01" });
  assert.equal(sanitizeRemoteError(auth).message, "database connection or query failed (28P01): password authentication failed — check the password");
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND db.secretref.supabase.co"), { code: "ENOTFOUND" });
  assert.equal(sanitizeRemoteError(dns).message, "database connection or query failed (ENOTFOUND): the host was not found — check the host in the URL");
  const tls = new Error("Hostname/IP does not match certificate's altnames: DNS:*.pooler.supabase.com");
  assert.equal(sanitizeRemoteError(tls).message, "database connection or query failed: see the code (a TLS problem)");
  const odd = Object.assign(new Error("something with 10.1.2.3"), { code: "weird code; drop table" });
  assert.equal(sanitizeRemoteError(odd).message, "database connection or query failed: see the code");
});

test("remote: a wrong source password, a user with a project reference and a closed port come back without the user, the reference, the host or the address", { skip }, async () => {
  const base = await remoteArgs(dumpPath());
  const wrongPassword = await backupAndVerifyRemote({ ...base, dumpPath: dumpPath(), sourcePassword: "not-the-password" }).then(() => null, (e) => e);
  assert.match(wrongPassword.message, /^database connection or query failed \(28P01\): password authentication failed/);
  const withRef = new URL(base.sourceUrl);
  withRef.username = "postgres.secretref";
  const refUser = await backupAndVerifyRemote({ ...base, dumpPath: dumpPath(), sourceUrl: withRef.toString() }).then(() => null, (e) => e);
  assert.match(refUser.message, /^database connection or query failed \((28P01|28000)\)/);
  assert.ok(!refUser.message.includes("secretref"), refUser.message);
  const closed = new URL(base.sourceUrl);
  closed.hostname = "127.0.0.1";
  closed.port = "1";
  const refused = await backupAndVerifyRemote({ ...base, dumpPath: dumpPath(), sourceUrl: closed.toString() }).then(() => null, (e) => e);
  assert.match(refused.message, /^database connection or query failed \(ECONNREFUSED\)/);
  assert.ok(!refused.message.includes("127.0.0.1"), refused.message);
});

test("remote: a pg_dump older than the source server is refused before anything is dumped", { skip: stubSkip }, async () => {
  const real = path.join(BIN_DIR, "pg_dump");
  const bin = stubBin(`if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 9.6.24"; exit 0; fi\nexec "${real}" "$@"`);
  const dump = dumpPath();
  await assert.rejects(backupAndVerifyRemote(await remoteArgs(dump, { pgBin: bin })), /pg_dump 9 is older than the source server/);
  assert.equal(fs.existsSync(dump), false);
  // The same, without any connection: the preflight alone reads both tools.
  const facts = await preflightRemote({ ...(await remoteArgs(dumpPath())), pgBin: bin });
  assert.equal(facts.pgDumpMajor, 9);
  assert.ok(facts.pgRestoreMajor >= 9);
});

test("remote: a sequence a writer advances during the run is accepted only within the values read before and after pg_dump", { skip }, async () => {
  await admin.query(`create sequence if not exists public.backup_probe_seq`);
  await admin.query(`select nextval('public.backup_probe_seq')`);
  await prepareOutsideObjects();
  const report = await backupAndVerifyRemote(await remoteArgs(dumpPath(), {
    onDumpStarted: async () => {
      for (let i = 0; i < 3; i += 1) await admin.query(`select nextval('public.backup_probe_seq')`);
    },
  }));
  assert.equal(report.verified, true, JSON.stringify(report.mismatches));
  assert.ok(Array.isArray(report.sequencesMovedDuringRun));
  // The rule itself, on its own.
  const print = (value) => ({ catalog: { sequences: [`public.s last=${value}`] } });
  const within = print(5);
  assert.deepEqual(reconcileMovedSequences(within, print(7), new Map([["public.s", "5"]]), new Map([["public.s", "9"]])), ["public.s"]);
  assert.deepEqual(within.catalog.sequences, ["public.s last=7"]);
  const outside = print(5);
  assert.deepEqual(reconcileMovedSequences(outside, print(12), new Map([["public.s", "5"]]), new Map([["public.s", "9"]])), []);
  assert.deepEqual(outside.catalog.sequences, ["public.s last=5"], "a value outside the range stays a difference");
  const fromUnused = print("unused");
  assert.deepEqual(reconcileMovedSequences(fromUnused, print(2), new Map([["public.s", "unused"]]), new Map([["public.s", "3"]])), ["public.s"]);
  const notMoved = print(5);
  assert.deepEqual(reconcileMovedSequences(notMoved, print(4), new Map([["public.s", "5"]]), new Map([["public.s", "5"]])), []);
  const stillUnused = print(1);
  assert.deepEqual(reconcileMovedSequences(stillUnused, print("unused"), new Map([["public.s", "unused"]]), new Map([["public.s", "1"]])), ["public.s"], "pg_dump read it before its first use");
  const usedBefore = print(3);
  assert.deepEqual(reconcileMovedSequences(usedBefore, print("unused"), new Map([["public.s", "2"]]), new Map([["public.s", "3"]])), [], "a used sequence never comes back unused");
});

test("remote: an extension's member table, its constraint and a member sequence are left out on both sides", { skip }, async () => {
  await prepareOutsideObjects();
  await admin.query(`create table public.ext_member_probe (v int not null check (v > 0))`);
  await admin.query(`insert into public.ext_member_probe values (1)`);
  await admin.query(`create sequence public.ext_member_probe_seq`);
  await admin.query(`select nextval('public.ext_member_probe_seq')`);
  await admin.query(`alter extension pgcrypto add table public.ext_member_probe`);
  await admin.query(`alter extension pgcrypto add sequence public.ext_member_probe_seq`);
  try {
    const report = await backupAndVerifyRemote(await remoteArgs(dumpPath()));
    assert.equal(report.verified, true, JSON.stringify(report.mismatches));
  } finally {
    await admin.query(`alter extension pgcrypto drop table public.ext_member_probe`);
    await admin.query(`alter extension pgcrypto drop sequence public.ext_member_probe_seq`);
    await admin.query(`drop table public.ext_member_probe`);
    await admin.query(`drop sequence public.ext_member_probe_seq`);
  }
});

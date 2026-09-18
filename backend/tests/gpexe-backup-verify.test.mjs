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
import { backupAndVerify, main as backupMain, normalizeCheck, normalizeIndex, NOT_COMPARED, pgConnectionArgs, pgDumpArgs, pgEnv, pgRestoreArgs } from "../scripts/gpexe-backup-verify.mjs";
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

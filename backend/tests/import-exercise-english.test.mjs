// backend/scripts/import-exercise-english.mjs (owner, 2026-11-03: the
// English names and instructions of vezbe.xlsx, matched by exercise code) on
// a disposable database: the guard, a dry run that writes nothing, an apply
// that writes exactly name_en and instruction_en, the report of codes whose
// Serbian name differs, --overwrite, a second apply that writes nothing, the
// input checks, and the CLI itself.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb } from "./_gpexe-disposable-db.mjs";
import { assertTarget, createImportClient, MIGRATION, normalizeCode, parseArgs, QUERY_TIMEOUT_MS, readInput, runImport, targetOf, urlDatabaseName } from "../scripts/import-exercise-english.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../scripts/import-exercise-english.mjs");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
if (!ORIGINAL_DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");

// The legacy scaffold's library.exercises has only an id; the columns the
// import reads are added, then the English migration through the runner.
const EXERCISE_COLUMNS_SQL = `alter table library.exercises
  add column owner_scope text not null default 'system',
  add column owner_user_id uuid,
  add column exercise_code text,
  add column name text not null default '',
  add column instruction text,
  add column updated_at timestamptz not null default '2026-01-01T00:00:00Z'`;

let db;
let c;
let bare;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "exenimp", migrations: [] });
  c = new pg.Client({ connectionString: db.url });
  await c.connect();
  assert.equal((await c.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  await c.query(EXERCISE_COLUMNS_SQL);
  await applyGpexeTestMigrations(db.url, [MIGRATION]);
});

after(async () => {
  await c?.end();
  await db?.drop();
  await bare?.drop();
});

async function seed() {
  await c.query("delete from library.exercises");
  const add = (code, name, extra = {}) => c.query(
    `insert into library.exercises (exercise_code, name, instruction, owner_scope, name_en, instruction_en)
     values ($1, $2, $3, $4, $5, $6)`,
    [code, name, `Uputstvo ${code}`, extra.ownerScope || "system", extra.nameEn ?? null, extra.instructionEn ?? null],
  );
  await add("1", "Iskorak");
  await add("2", "Čučanj  sa tegom");
  await add("3", "Sklek");
  await add("4", "Most", { nameEn: "Bridge (kept)" });
  await add("5", "Plank novi");
  await add("6", "Moja vežba", { ownerScope: "user" });
  await add(null, "Bez koda");
}

const file = () => readInput([
  { code: "1", name_sr: "Iskorak", instr_sr: "…", name_en: " Forward lunge ", notes_en: "Step forward." },
  // The sheet's double space is no name difference.
  { code: 2, name_sr: "Čučanj sa  tegom", name_en: "Squat", notes_en: "" },
  { code: "3.0", name_sr: "Sklek", name_en: "", notes_en: null },
  { code: "4", name_sr: "Most", name_en: "Glute bridge", notes_en: "Lift the hips." },
  { code: "5", name_sr: "Plank", name_en: "Plank", notes_en: "Hold." },
  { code: "6", name_sr: "Moja vežba", name_en: "My exercise", notes_en: "" },
  { code: "99", name_sr: "Nema je", name_en: "Missing", notes_en: "" },
]);

async function table() {
  return (await c.query("select to_jsonb(e) as row from library.exercises e order by exercise_code nulls last, name")).rows.map((r) => r.row);
}
const withoutEnglish = (rows) => rows.map(({ name_en, instruction_en, ...rest }) => rest);
const run = (options) => runImport({ databaseUrl: db.url, databaseName: db.name, rows: file(), ...options });

test("1. the guard: the database must be named and must be the one the URL and the connection are on; a database without the migration is refused", async () => {
  assert.throws(() => parseArgs(["--file", "x.json"]), /Usage/);
  assert.throws(() => parseArgs(["--database-name", "x"]), /Usage/);
  assert.throws(() => parseArgs(["--file", "--apply", "--database-name", "x"]), /--file needs a value/);
  assert.throws(() => parseArgs(["--file", "x.json", "--database-name", "x", "--force"]), /Unknown argument --force/);
  assert.deepEqual(parseArgs(["--file", "x.json", "--database-name", "x", "--apply", "--overwrite"]), { file: "x.json", databaseName: "x", apply: true, overwrite: true });
  assert.equal(urlDatabaseName(db.url), db.name);
  await seed();
  const before_ = await table();
  await assert.rejects(runImport({ databaseUrl: db.url, databaseName: "OPTIMOVE", rows: file(), apply: true }), /DATABASE_URL does not name the database "OPTIMOVE"/);
  await assert.rejects(runImport({ databaseUrl: "", databaseName: db.name, rows: file() }), /Set DATABASE_URL explicitly/);
  await assert.rejects(assertTarget(c, "someone_else"), /connected to ".*", not to --database-name "someone_else"/);
  bare = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "exenbare", migrations: [] });
  await assert.rejects(runImport({ databaseUrl: bare.url, databaseName: bare.name, rows: file(), apply: true }), /migration 202611031200_exercise_english_content.sql is not applied/);
  assert.deepEqual(await table(), before_, "nothing was written");
});

test("2. a dry run writes nothing and reports what an apply would do", async () => {
  await seed();
  const before_ = await table();
  const report = await run();
  assert.deepEqual(await table(), before_, "the table is unchanged");
  assert.equal(report.mode, "dry-run");
  const url = new URL(db.url);
  assert.deepEqual(report.target, { host: url.hostname, port: url.port || "5432", database: db.name }, "host, port and database");
  assert.equal(Boolean(url.password) && JSON.stringify(report).includes(decodeURIComponent(url.password)), false, "never the password");
  assert.deepEqual(targetOf("postgresql://someone:secret@db.example.test:6543/postgres"), { host: "db.example.test", port: "6543", database: "postgres" });
  assert.equal(report.rows, 7);
  assert.equal(report.matched, 5);
  assert.deepEqual(report.notFound, ["6", "99"], "a coach's own exercise and an unknown code are not matched");
  assert.deepEqual(report.nameDiffers, [{ code: "5", sheet: "Plank", database: "Plank novi" }]);
  assert.deepEqual(report.noEnglish, ["3"]);
  assert.deepEqual(report.nameEn, { write: 3, alreadyFilled: 1, same: 0, blank: 1 });
  assert.deepEqual(report.instructionEn, { write: 3, alreadyFilled: 0, same: 0, blank: 2 });
  assert.equal(report.written, 0);
});

test("3. an apply writes exactly name_en and instruction_en, in one transaction; nothing else changes, an English value already there is kept", async () => {
  await seed();
  const before_ = await table();
  const report = await run({ apply: true });
  assert.equal(report.mode, "apply");
  assert.equal(report.written, 4, "codes 1, 2, 4 and 5");
  const after_ = await table();
  assert.deepEqual(withoutEnglish(after_), withoutEnglish(before_), "every other column, updated_at included, is unchanged");
  const english = Object.fromEntries(after_.map((row) => [row.exercise_code ?? row.name, [row.name_en, row.instruction_en]]));
  assert.deepEqual(english, {
    1: ["Forward lunge", "Step forward."],
    2: ["Squat", null],
    3: [null, null],
    4: ["Bridge (kept)", "Lift the hips."],
    5: ["Plank", "Hold."],
    6: [null, null],
    "Bez koda": [null, null],
  });
  // A second apply finds everything in place.
  const again = await run({ apply: true });
  assert.equal(again.written, 0);
  assert.deepEqual(again.nameEn, { write: 0, alreadyFilled: 1, same: 3, blank: 1 });
  assert.deepEqual(await table(), after_);
});

test("4. --overwrite replaces an English value that differs, never one that is the same, and never clears one with a blank", async () => {
  await seed();
  await c.query("update library.exercises set instruction_en = 'Keep it' where exercise_code = '3'");
  const dry = await run({ overwrite: true });
  assert.deepEqual(dry.nameEn, { write: 4, alreadyFilled: 0, same: 0, blank: 1 });
  const report = await run({ apply: true, overwrite: true });
  assert.equal(report.written, 4);
  const rows = Object.fromEntries((await table()).map((row) => [row.exercise_code, [row.name_en, row.instruction_en]]));
  assert.deepEqual(rows["4"], ["Glute bridge", "Lift the hips."], "the differing value is replaced");
  assert.deepEqual(rows["3"], [null, "Keep it"], "a blank value in the file clears nothing");
  const again = await run({ apply: true, overwrite: true });
  assert.equal(again.written, 0, "the same values are not written again");
});

test("5. the input: codes as numbers or 12.0, text only, one row per code; a code naming two system exercises is refused", async () => {
  assert.equal(normalizeCode(7), "7");
  assert.equal(normalizeCode("12.0"), "12");
  assert.equal(normalizeCode(" 12 "), "12");
  assert.equal(normalizeCode("1.5"), "1.5");
  assert.equal(normalizeCode(null), "");
  assert.throws(() => readInput({ rows: [] }), /JSON array/);
  assert.throws(() => readInput([null]), /Row 1 is not an object/);
  assert.throws(() => readInput([{ name_en: "x" }]), /Row 1 has no exercise code/);
  assert.throws(() => readInput([{ code: "1" }, { code: "1.0" }]), /Code 1 appears twice/);
  assert.throws(() => readInput([{ code: "1", name_en: 5 }]), /Code 1: name_en must be text/);
  assert.throws(() => readInput([{ code: "1", notes_en: ["x"] }]), /Code 1: notes_en must be text/);
  assert.throws(() => readInput([{ code: "1", name_en: "Lunge\u0000" }]), /Code 1: name_en holds a character the database cannot store/);
  assert.throws(() => readInput([{ code: "1", notes_en: "Step \ud800 forward" }]), /Code 1: notes_en holds a character the database cannot store/);
  await seed();
  await c.query("insert into library.exercises (exercise_code, name, owner_scope) values ('1', 'Iskorak drugi', 'system')");
  const before_ = await table();
  await assert.rejects(run({ apply: true }), /code 1 names more than one system exercise/);
  assert.deepEqual(await table(), before_, "nothing was written");
});

test("7. an answer lost after the COMMIT was sent is reported as not known, never as not written; the client has its own bound", async () => {
  await seed();
  // The real COMMIT goes out, then the answer is lost.
  let used = null;
  const losingCommit = (url) => {
    const client = new pg.Client({ connectionString: url });
    used = client;
    const query = client.query.bind(client);
    client.query = async (sql, params) => {
      if (sql === "commit") {
        await query(sql, params);
        throw Object.assign(new Error("Connection terminated unexpectedly"), { code: undefined });
      }
      return query(sql, params);
    };
    return client;
  };
  await assert.rejects(run({ apply: true, createClient: losingCommit }), /whether anything was written is not known\. Run the dry run again/);
  assert.equal((await c.query("select name_en from library.exercises where exercise_code = '1'")).rows[0].name_en, "Forward lunge", "it was written");
  const again = await run();
  assert.equal(again.nameEn.write, 0, "the dry run shows what is stored");
  assert.equal(QUERY_TIMEOUT_MS > 60000, true, "the client waits longer than the server's statement_timeout");
  assert.equal(createImportClient(db.url).connectionParameters.query_timeout, QUERY_TIMEOUT_MS, "and the real client waits no longer than that");
  assert.ok(used.listenerCount("error") >= 1, "a connection lost while idle is caught, never an uncaught error");
});

test("8. a close that fails after a COMMIT that went through never hides the answer", async () => {
  await seed();
  const failingClose = (url) => {
    const client = new pg.Client({ connectionString: url });
    const end = client.end.bind(client);
    client.end = async () => { await end(); throw new Error("close failed"); };
    return client;
  };
  const report = await run({ apply: true, createClient: failingClose });
  assert.equal(report.written, 4);
  assert.equal((await c.query("select name_en from library.exercises where exercise_code = '1'")).rows[0].name_en, "Forward lunge");
});

test("6. the CLI: a dry run prints the report and never the connection string; --apply writes", async () => {
  await seed();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-english-import-"));
  try {
    const input = path.join(dir, "vezbe-en.json");
    await fsp.writeFile(input, JSON.stringify([{ code: "1", name_sr: "Iskorak", name_en: "Forward lunge", notes_en: "Step forward." }]));
    const cli = (...args) => spawnSync(process.execPath, [SCRIPT, "--file", input, "--database-name", db.name, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: db.url }, encoding: "utf8", timeout: 60000,
    });
    const dry = cli();
    assert.equal(dry.status, 0, dry.stderr);
    const report = JSON.parse(dry.stdout);
    assert.equal(report.mode, "dry-run");
    assert.deepEqual(report.nameEn, { write: 1, alreadyFilled: 0, same: 0, blank: 0 });
    assert.ok(!`${dry.stdout}${dry.stderr}`.includes(db.url), "the connection string is never printed");
    assert.equal((await c.query("select name_en from library.exercises where exercise_code = '1'")).rows[0].name_en, null);
    const wrong = spawnSync(process.execPath, [SCRIPT, "--file", input, "--database-name", "OPTIMOVE", "--apply"], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: db.url }, encoding: "utf8", timeout: 60000,
    });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /DATABASE_URL does not name the database "OPTIMOVE"/);
    assert.ok(!wrong.stderr.includes(db.url));
    const applied = cli("--apply");
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).written, 1);
    assert.equal((await c.query("select name_en from library.exercises where exercise_code = '1'")).rows[0].name_en, "Forward lunge");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

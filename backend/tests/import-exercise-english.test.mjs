// backend/scripts/import-exercise-english.mjs (owner, 2026-11-03: the
// English names and instructions of vezbe.xlsx, matched by exercise code; and
// "Prihvatam sve": a code whose Serbian name differs is written only when
// named in --include-code, and an unchanged copy of a matched exercise gets
// the same English) on a disposable database: the guard, a dry run that
// writes nothing, an apply that writes exactly name_en and instruction_en,
// the include list, the copies, --overwrite, a second apply that writes
// nothing, the input checks, a lost COMMIT answer, a failing close, and the
// CLI itself.
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
import { assertTarget, createImportClient, MIGRATION, normalizeCode, parseArgs, planImport, QUERY_TIMEOUT_MS, readInput, runImport, targetOf, urlDatabaseName } from "../scripts/import-exercise-english.mjs";

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
  add column source_exercise_id uuid,
  add column copy_parent_id uuid,
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

// System exercises 1-5, a coach's coded exercise 6, one without a code, and
// six copies (no code): c1 of 1 unchanged (a double space only), c2 of 1
// renamed, c3 of 4 unchanged with an English name of its own, c4 of 2
// unchanged through copy_parent_id, c5 of 5 (whose Serbian name differs from
// the sheet's), c6 of 1 with another instruction; a copy cc of c1 and a copy
// ccc of cc (not followed, counted); and a coach's coded exercise 7 made from
// 1, which is no copy (it has a code of its own).
let ids;
async function seed() {
  await c.query("delete from library.exercises");
  const add = async (code, name, extra = {}) => (await c.query(
    `insert into library.exercises (exercise_code, name, instruction, owner_scope, name_en, instruction_en, source_exercise_id, copy_parent_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [code, name, extra.instruction ?? `Uputstvo ${code}`, extra.ownerScope || "system", extra.nameEn ?? null, extra.instructionEn ?? null,
      extra.source ?? null, extra.parent ?? null],
  )).rows[0].id;
  ids = {};
  ids[1] = await add("1", "Iskorak");
  ids[2] = await add("2", "Čučanj  sa tegom");
  ids[3] = await add("3", "Sklek");
  ids[4] = await add("4", "Most", { nameEn: "Bridge (kept)" });
  ids[5] = await add("5", "Plank novi");
  ids[6] = await add("6", "Moja vežba", { ownerScope: "user" });
  ids.none = await add(null, "Bez koda");
  ids.c1 = await add(null, "Iskorak", { ownerScope: "user", instruction: "Uputstvo  1", source: ids[1] });
  ids.c2 = await add(null, "Moj iskorak", { ownerScope: "user", instruction: "Uputstvo 1", source: ids[1] });
  ids.c3 = await add(null, "Most", { ownerScope: "user", instruction: "Uputstvo 4", source: ids[4], nameEn: "Own bridge" });
  ids.c4 = await add(null, "Čučanj sa tegom", { ownerScope: "user", instruction: "Uputstvo 2", parent: ids[2] });
  ids.c5 = await add(null, "Plank novi", { ownerScope: "user", instruction: "Uputstvo 5", source: ids[5] });
  ids.c6 = await add(null, "Iskorak", { ownerScope: "user", instruction: "Drugo uputstvo", source: ids[1] });
  ids.cc = await add(null, "Iskorak", { ownerScope: "user", instruction: "Uputstvo 1", parent: ids.c1 });
  ids.ccc = await add(null, "Iskorak", { ownerScope: "user", instruction: "Uputstvo 1", parent: ids.cc });
  ids.coded = await add("7", "Iskorak", { ownerScope: "user", instruction: "Uputstvo 1", source: ids[1] });
}

const file = () => readInput([
  // A trailing tab and newline are trimmed, as the database's CHECK requires.
  { code: "1", name_sr: "Iskorak", instr_sr: "…", name_en: " Forward lunge ", notes_en: "Step forward.\t\n" },
  // The sheet's double space is no name difference.
  { code: 2, name_sr: "Čučanj sa  tegom", name_en: "Squat", notes_en: "" },
  { code: "3.0", name_sr: "Sklek", name_en: "", notes_en: null },
  { code: "4", name_sr: "Most", name_en: "Glute bridge", notes_en: "Lift the hips." },
  { code: "5", name_sr: "Plank", name_en: "Plank", notes_en: "Hold." },
  { code: "6", name_sr: "Moja vežba", name_en: "My exercise", notes_en: "" },
  { code: "99", name_sr: "Nema je", name_en: "Missing", notes_en: "" },
]);

async function table() {
  return (await c.query("select to_jsonb(e) as row from library.exercises e order by id")).rows.map((r) => r.row);
}
const withoutEnglish = (rows) => rows.map(({ name_en, instruction_en, ...rest }) => rest);
const english = async () => {
  const rows = (await c.query("select id, name_en, instruction_en from library.exercises")).rows;
  const byId = new Map(rows.map((row) => [row.id, [row.name_en, row.instruction_en]]));
  return Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, byId.get(id)]));
};
const run = (options) => runImport({ databaseUrl: db.url, databaseName: db.name, rows: file(), ...options });
const sortedChanged = (report) => report.copies.changed.map((entry) => `${entry.code}:${entry.copyId}`).sort();

test("1. the guard: the database must be named and must be the one the URL and the connection are on; a database without the migration is refused; --include-code is parsed", async () => {
  assert.throws(() => parseArgs(["--file", "x.json"]), /Usage/);
  assert.throws(() => parseArgs(["--database-name", "x"]), /Usage/);
  assert.throws(() => parseArgs(["--file", "--apply", "--database-name", "x"]), /--file needs a value/);
  assert.throws(() => parseArgs(["--file", "x.json", "--database-name", "x", "--force"]), /Unknown argument --force/);
  assert.deepEqual(parseArgs(["--file", "x.json", "--database-name", "x", "--apply", "--overwrite"]), { file: "x.json", databaseName: "x", apply: true, overwrite: true, includeCodes: [] });
  assert.deepEqual(parseArgs(["--file", "x.json", "--database-name", "x", "--include-code", "758, 759", "--include-code", "1102.0,758"]).includeCodes, ["758", "759", "1102"]);
  assert.throws(() => parseArgs(["--file", "x.json", "--database-name", "x", "--include-code", "758,,759"]), /--include-code takes codes separated by commas/);
  assert.throws(() => parseArgs(["--file", "x.json", "--database-name", "x", "--include-code"]), /--include-code needs a value/);
  assert.equal(urlDatabaseName(db.url), db.name);
  await seed();
  const before_ = await table();
  await assert.rejects(runImport({ databaseUrl: db.url, databaseName: "OPTIMOVE", rows: file(), apply: true }), /DATABASE_URL does not name the database "OPTIMOVE"/);
  await assert.rejects(runImport({ databaseUrl: "", databaseName: db.name, rows: file() }), /Set DATABASE_URL explicitly/);
  await assert.rejects(assertTarget(c, "someone_else"), /connected to ".*", not to --database-name "someone_else"/);
  bare = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "exenbare", migrations: [] });
  await assert.rejects(runImport({ databaseUrl: bare.url, databaseName: bare.name, rows: file(), apply: true }), /migration 202611031200_exercise_english_content.sql is not applied/);
  // The English columns without the copy links (never so through the runner) is refused too.
  const bareClient = new pg.Client({ connectionString: bare.url });
  await bareClient.connect();
  try {
    await bareClient.query("alter table library.exercises add column name_en text, add column instruction_en text");
  } finally {
    await bareClient.end();
  }
  await assert.rejects(runImport({ databaseUrl: bare.url, databaseName: bare.name, rows: file(), apply: true }), /has no copy links on library\.exercises/);
  assert.deepEqual(await table(), before_, "nothing was written");
});

test("2. a dry run writes nothing and reports what an apply would do: a differing name listed and not written, unchanged copies counted, changed ones listed", async () => {
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
  assert.deepEqual(report.nameDiffers, [{ code: "5", database: "Plank novi", sheet: "Plank", written: false }], "the library's name and the sheet's, side by side, not written");
  assert.deepEqual(report.noEnglish, ["3"]);
  assert.deepEqual(report.nameEn, { write: 2, alreadyFilled: 1, same: 0, blank: 1 }, "codes 1, 2 write; 4 kept; 3 blank; 5 left out");
  assert.deepEqual(report.instructionEn, { write: 2, alreadyFilled: 0, same: 0, blank: 2 });
  assert.equal(report.copies.unchanged, 3, "c1, c3, c4");
  assert.deepEqual(sortedChanged(report), [`1:${ids.c2}`, `1:${ids.c6}`].sort(), "c2 renamed, c6 another instruction");
  assert.equal(report.copies.withSourceNotWritten, 1, "c5 follows its source 5");
  assert.equal(report.copies.ofCopiesNotFollowed, 2, "cc and ccc are counted, not followed");
  assert.deepEqual(report.copies.nameEn, { write: 2, alreadyFilled: 1, same: 0, blank: 0 });
  assert.deepEqual(report.copies.instructionEn, { write: 2, alreadyFilled: 0, same: 0, blank: 1 });
  assert.equal(report.written, 0);
});

test("3. an apply writes exactly name_en and instruction_en, of the matched exercises and their unchanged copies, in one transaction; nothing else changes", async () => {
  await seed();
  const before_ = await table();
  const report = await run({ apply: true });
  assert.equal(report.mode, "apply");
  assert.equal(report.written, 6, "codes 1, 2 and 4, copies c1, c3 and c4");
  const after_ = await table();
  assert.deepEqual(withoutEnglish(after_), withoutEnglish(before_), "every other column, updated_at included, is unchanged");
  assert.deepEqual(await english(), {
    1: ["Forward lunge", "Step forward."],
    2: ["Squat", null],
    3: [null, null],
    4: ["Bridge (kept)", "Lift the hips."],
    5: [null, null],
    6: [null, null],
    none: [null, null],
    c1: ["Forward lunge", "Step forward."],
    c2: [null, null],
    c3: ["Own bridge", "Lift the hips."],
    c4: ["Squat", null],
    c5: [null, null],
    c6: [null, null],
    cc: [null, null],
    ccc: [null, null],
    coded: [null, null],
  });
  // A second apply finds everything in place.
  const again = await run({ apply: true });
  assert.equal(again.written, 0);
  assert.deepEqual(again.nameEn, { write: 0, alreadyFilled: 1, same: 2, blank: 1 });
  assert.deepEqual(again.copies.nameEn, { write: 0, alreadyFilled: 1, same: 2, blank: 0 });
  assert.deepEqual(await table(), after_);
});

test("4. --include-code writes a differing code and its unchanged copies; a code that does not differ is refused with nothing written", async () => {
  await seed();
  const dry = await run({ includeCodes: ["5"] });
  assert.deepEqual(dry.nameDiffers, [{ code: "5", database: "Plank novi", sheet: "Plank", written: true }]);
  assert.equal(dry.copies.withSourceNotWritten, 0);
  assert.equal(dry.copies.unchanged, 4, "c5 is now an unchanged copy of an included source");
  const report = await run({ apply: true, includeCodes: ["5"] });
  assert.equal(report.written, 8, "the six of test 3, code 5 and c5");
  const stored = await english();
  assert.deepEqual(stored[5], ["Plank", "Hold."]);
  assert.deepEqual(stored.c5, ["Plank", "Hold."]);
  await seed();
  const before_ = await table();
  for (const stray of [["3"], ["99"], ["5", "1"]]) {
    await assert.rejects(run({ apply: true, includeCodes: stray }), /--include-code .* names no matched code whose Serbian name differs/, stray.join(","));
    assert.deepEqual(await table(), before_, `${stray.join(",")}: nothing was written`);
  }
});

test("5. --overwrite replaces an English value that differs, of a source and of an unchanged copy, never one that is the same, and never clears one with a blank", async () => {
  await seed();
  await c.query("update library.exercises set instruction_en = 'Keep it' where exercise_code = '3'");
  const dry = await run({ overwrite: true });
  assert.deepEqual(dry.nameEn, { write: 3, alreadyFilled: 0, same: 0, blank: 1 });
  assert.deepEqual(dry.copies.nameEn, { write: 3, alreadyFilled: 0, same: 0, blank: 0 });
  const report = await run({ apply: true, overwrite: true });
  assert.equal(report.written, 6);
  const stored = await english();
  assert.deepEqual(stored[4], ["Glute bridge", "Lift the hips."], "the differing value is replaced");
  assert.deepEqual(stored.c3, ["Glute bridge", "Lift the hips."], "and the copy's");
  assert.deepEqual(stored[3], [null, "Keep it"], "a blank value in the file clears nothing");
  const again = await run({ apply: true, overwrite: true });
  assert.equal(again.written, 0, "the same values are not written again");
});

test("6. the input: codes as numbers or 12.0, text only, one row per code, no text the database cannot store; a code naming two system exercises is refused", async () => {
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
  assert.deepEqual(readInput([{ code: "1", name_en: "\tLunge\r\n", notes_en: " Step.\t" }])[0], { code: "1", nameSr: "", nameEn: "Lunge", instructionEn: "Step." }, "space, tab, CR and LF are trimmed");
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
  assert.equal(report.written, 6);
  assert.equal((await c.query("select name_en from library.exercises where exercise_code = '1'")).rows[0].name_en, "Forward lunge");
});

test("9. the CLI: a dry run prints the report and never the connection string; --include-code and --apply write", async () => {
  await seed();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-english-import-"));
  try {
    const input = path.join(dir, "vezbe-en.json");
    await fsp.writeFile(input, JSON.stringify([
      { code: "1", name_sr: "Iskorak", name_en: "Forward lunge", notes_en: "Step forward." },
      { code: "5", name_sr: "Plank", name_en: "Plank", notes_en: "Hold." },
    ]));
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: db.url };
    const cli = (...args) => spawnSync(process.execPath, [SCRIPT, "--file", input, "--database-name", db.name, ...args], { env, encoding: "utf8", timeout: 60000 });
    const dry = cli();
    assert.equal(dry.status, 0, dry.stderr);
    const report = JSON.parse(dry.stdout);
    assert.equal(report.mode, "dry-run");
    assert.deepEqual(report.nameEn, { write: 1, alreadyFilled: 0, same: 0, blank: 0 });
    assert.deepEqual(report.nameDiffers, [{ code: "5", database: "Plank novi", sheet: "Plank", written: false }]);
    assert.ok(!`${dry.stdout}${dry.stderr}`.includes(db.url), "the connection string is never printed");
    assert.equal((await c.query("select name_en from library.exercises where exercise_code = '1'")).rows[0].name_en, null);
    const wrong = spawnSync(process.execPath, [SCRIPT, "--file", input, "--database-name", "OPTIMOVE", "--apply"], { env, encoding: "utf8", timeout: 60000 });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /DATABASE_URL does not name the database "OPTIMOVE"/);
    assert.ok(!wrong.stderr.includes(db.url));
    const applied = cli("--apply", "--include-code", "5");
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).written, 4, "codes 1 and 5, copies c1 and c5");
    assert.equal((await c.query("select name_en from library.exercises where exercise_code = '5'")).rows[0].name_en, "Plank");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("10. an apply holds the matched rows and every copy it read until it ends, and nothing else", async () => {
  await seed();
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    const statements = [];
    await planImport({ query: (sql, params) => { statements.push(sql); return holder.query(sql, params); } }, file(), { lock: true });
    // The app's order: its shared exercise_collections lock first, then the rows in id order.
    assert.equal(statements[0], "select pg_advisory_xact_lock_shared(hashtextextended('exercise_collections', 0))");
    assert.match(statements[1], /order by id for no key update/);
    assert.equal((await c.query("select pg_try_advisory_lock(hashtextextended('exercise_collections', 0)) as ok")).rows[0].ok, false, "a block write waits");
    assert.equal((await c.query("select pg_try_advisory_lock_shared(hashtextextended('exercise_collections', 0)) as ok")).rows[0].ok, true, "an editor save does not");
    await c.query("select pg_advisory_unlock_shared(hashtextextended('exercise_collections', 0))");
    await c.query("set lock_timeout = '200ms'");
    for (const key of [1, 4, "c1", "c4", "c6"]) {
      await assert.rejects(c.query("update library.exercises set name = name where id = $1", [ids[key]]), (error) => error.code === "55P03", `${key} is held`);
    }
    for (const key of ["none", 6, "coded", "cc", "ccc"]) {
      await c.query("update library.exercises set name = name where id = $1", [ids[key]]);
    }
  } finally {
    await c.query("reset lock_timeout");
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
});

test("11. an unchanged copy gets the English its source holds after the run, also one the source keeps", async () => {
  await seed();
  await c.query("update library.exercises set instruction_en = 'Keep it' where exercise_code = '3'");
  const add = async (name, instruction, source) => (await c.query(
    "insert into library.exercises (name, instruction, owner_scope, source_exercise_id) values ($1, $2, 'user', $3) returning id",
    [name, instruction, source],
  )).rows[0].id;
  const c7 = await add("Most", "Uputstvo 4", ids[4]);
  const c8 = await add("Sklek", "Uputstvo 3", ids[3]);
  const pair = async (id) => {
    const row = (await c.query("select name_en, instruction_en from library.exercises where id = $1", [id])).rows[0];
    return [row.name_en, row.instruction_en];
  };
  await run({ apply: true });
  assert.deepEqual(await pair(c7), ["Bridge (kept)", "Lift the hips."], "source 4 keeps its own name");
  assert.deepEqual(await pair(c7), await pair(ids[4]));
  assert.deepEqual(await pair(c8), [null, "Keep it"], "source 3 keeps its instruction (the sheet's is blank)");
  assert.deepEqual(await pair(c8), await pair(ids[3]));
  await run({ apply: true, overwrite: true });
  assert.deepEqual(await pair(c7), ["Glute bridge", "Lift the hips."], "with --overwrite both get the sheet's");
  assert.deepEqual(await pair(c7), await pair(ids[4]));
});

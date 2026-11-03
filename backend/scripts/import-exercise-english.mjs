// Imports the owner's English names and instructions of exercises (owner,
// 2026-11-03: the translation of vezbe.xlsx, exported as JSON), matched by
// exercise code. It writes only library.exercises.name_en and instruction_en
// (migration 202611031200_exercise_english_content.sql), never the Serbian
// name, the instruction or any other column, not even updated_at.
//
//   Dry run (the default) - reads, writes nothing, prints the report:
//     DATABASE_URL=<url> node backend/scripts/import-exercise-english.mjs \
//       --file vezbe-en.json --database-name <name of that database>
//   Apply - one transaction, the same report with what was written:
//     ... --apply [--overwrite]
//
// The input is a JSON array of { code, name_sr, instr_sr, name_en, notes_en };
// notes_en is the English of the Serbian instruction (instr_sr). Only system
// exercises are matched (a coach's own copy has no code). An English value
// is written only where the exercise has none; --overwrite also replaces one
// that differs. A blank English value is never written and never clears
// anything. A code whose Serbian name differs from the database's is still
// matched by its code, and listed in the report so the owner can take it out
// of the file first.
//
// Guard: DATABASE_URL comes from the environment only (no .env file is
// read) and is never printed; --database-name must name the database the URL
// points at and the one the connection is really on (current_database()).
// The production run is the owner's, on its own order (database-safety.md).
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

export const MIGRATION = "202611031200_exercise_english_content.sql";
const USAGE = "Usage: DATABASE_URL=<url> node backend/scripts/import-exercise-english.mjs --file <json> --database-name <name> [--apply] [--overwrite]";

export function parseArgs(argv) {
  const options = { file: "", databaseName: "", apply: false, overwrite: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--overwrite") options.overwrite = true;
    else if (arg === "--file" || arg === "--database-name") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value. ${USAGE}`);
      options[arg === "--file" ? "file" : "databaseName"] = value;
      index += 1;
    } else throw new Error(`Unknown argument ${arg}. ${USAGE}`);
  }
  if (!options.file || !options.databaseName) throw new Error(USAGE);
  return options;
}

// The spreadsheet's codes may arrive as numbers or as "12.0".
export function normalizeCode(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const code = String(value).trim();
  return /^\d+\.0+$/.test(code) ? code.replace(/\.0+$/, "") : code;
}

function englishText(value, field, code) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`Code ${code}: ${field} must be text.`);
  // Text the database refuses (a NUL, a lone surrogate) is refused here, so
  // the dry run never passes what the apply would fail on.
  if (value.includes("\u0000") || !value.isWellFormed()) throw new Error(`Code ${code}: ${field} holds a character the database cannot store.`);
  return value.trim();
}

// The file's rows, checked before any database is opened.
export function readInput(rows) {
  if (!Array.isArray(rows)) throw new Error("The file must hold a JSON array of rows.");
  const seen = new Set();
  return rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Row ${index + 1} is not an object.`);
    const code = normalizeCode(row.code);
    if (!code) throw new Error(`Row ${index + 1} has no exercise code.`);
    if (seen.has(code)) throw new Error(`Code ${code} appears twice in the file.`);
    seen.add(code);
    return {
      code,
      nameSr: typeof row.name_sr === "string" ? row.name_sr.trim() : "",
      nameEn: englishText(row.name_en, "name_en", code),
      instructionEn: englishText(row.notes_en, "notes_en", code),
    };
  });
}

// Both names must agree: the one the URL points at and the one the
// connection is really on.
export function urlDatabaseName(databaseUrl) {
  const url = new URL(databaseUrl);
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

export async function assertTarget(client, databaseName) {
  const database = (await client.query("select current_database() as db")).rows[0].db;
  if (database !== databaseName) throw new Error(`Refusing: connected to "${database}", not to --database-name "${databaseName}".`);
  const columns = Number((await client.query(`select count(*) from information_schema.columns
    where table_schema = 'library' and table_name = 'exercises' and column_name in ('name_en', 'instruction_en')`)).rows[0].count);
  if (columns !== 2) throw new Error(`Refusing: "${database}" has no English exercise columns (migration ${MIGRATION} is not applied).`);
  return database;
}

// The sheet's Serbian names often carry a double space the library does not;
// only a difference beyond whitespace is reported.
const sameName = (a, b) => String(a || "").replace(/\s+/g, " ").trim() === String(b || "").replace(/\s+/g, " ").trim();

function field(planned, stored, overwrite) {
  if (!planned) return "blank";
  if (stored === planned) return "same";
  if (stored !== null && !overwrite) return "alreadyFilled";
  return "write";
}

// What the file would change, read inside the caller's transaction (FOR NO
// KEY UPDATE of the matched rows when applying - what the UPDATE needs, and
// no conflict with the foreign-key checks of a plan save - so nothing changes
// between the plan and the write).
export async function planImport(client, rows, { overwrite = false, lock = false } = {}) {
  const found = (await client.query(
    `select id, exercise_code, name, name_en, instruction_en from library.exercises
      where owner_scope = 'system' and exercise_code = any($1::text[])
      order by exercise_code, id${lock ? " for no key update" : ""}`,
    [rows.map((row) => row.code)],
  )).rows;
  const byCode = new Map();
  for (const exercise of found) {
    if (byCode.has(exercise.exercise_code)) throw new Error(`Refusing: code ${exercise.exercise_code} names more than one system exercise.`);
    byCode.set(exercise.exercise_code, exercise);
  }
  const counts = () => ({ write: 0, alreadyFilled: 0, same: 0, blank: 0 });
  const report = { rows: rows.length, matched: 0, notFound: [], nameDiffers: [], noEnglish: [], nameEn: counts(), instructionEn: counts() };
  const writes = [];
  for (const row of rows) {
    const exercise = byCode.get(row.code);
    if (!exercise) { report.notFound.push(row.code); continue; }
    report.matched += 1;
    if (row.nameSr && !sameName(row.nameSr, exercise.name)) {
      report.nameDiffers.push({ code: row.code, sheet: row.nameSr, database: exercise.name });
    }
    if (!row.nameEn && !row.instructionEn) report.noEnglish.push(row.code);
    const name = field(row.nameEn, exercise.name_en, overwrite);
    const instruction = field(row.instructionEn, exercise.instruction_en, overwrite);
    report.nameEn[name] += 1;
    report.instructionEn[instruction] += 1;
    if (name === "write" || instruction === "write") {
      writes.push({ id: exercise.id, code: row.code, name_en: name === "write" ? row.nameEn : null, instruction_en: instruction === "write" ? row.instructionEn : null });
    }
  }
  return { report, writes };
}

// One statement for every planned write; a NULL in the plan leaves that
// column as it is.
export async function applyWrites(client, writes) {
  if (!writes.length) return 0;
  const written = await client.query(
    `update library.exercises e set
       name_en = coalesce(w.name_en, e.name_en),
       instruction_en = coalesce(w.instruction_en, e.instruction_en)
     from jsonb_to_recordset($1::jsonb) as w(id uuid, name_en text, instruction_en text)
     where e.id = w.id
     returning e.id`,
    [JSON.stringify(writes.map(({ id, name_en, instruction_en }) => ({ id, name_en, instruction_en })))],
  );
  if (written.rowCount !== writes.length) throw new Error(`Refusing: ${written.rowCount} rows written instead of ${writes.length}; nothing is kept.`);
  return written.rowCount;
}

// Every statement, the COMMIT included, has a client-side bound beyond the
// server's statement_timeout (60 s): an answer that never comes ends in the
// "not known" message instead of a CLI that waits for TCP keepalive.
export const QUERY_TIMEOUT_MS = 75000;
// TLS as the deployed server connects (backend/src/db.js): the Supabase
// pooler's certificate is not in Node's trust store; the same reason applies
// here, and to no other host.
export const createImportClient = (databaseUrl) => new pg.Client({
  connectionString: databaseUrl, connectionTimeoutMillis: 10000, query_timeout: QUERY_TIMEOUT_MS,
  ssl: databaseUrl.includes("supabase.com") ? { rejectUnauthorized: false } : undefined,
});

// Where the run goes, for the report: host, port and database, never a user or
// a password (database-safety.md: check them before an apply).
export function targetOf(databaseUrl) {
  const url = new URL(databaseUrl);
  return { host: url.hostname, port: url.port || "5432", database: urlDatabaseName(databaseUrl) };
}

const notKnown = (error) => new Error(`The COMMIT's answer was lost (${error.code || error.message}): whether anything was written is not known. Run the dry run again; it shows what is stored.`);

// createClient: the tests' seam for a lost answer and a failing close.
export async function runImport({ databaseUrl, databaseName, rows, apply = false, overwrite = false, createClient = createImportClient }) {
  if (!databaseUrl) throw new Error("Set DATABASE_URL explicitly; no .env file is read.");
  if (urlDatabaseName(databaseUrl) !== databaseName) throw new Error(`Refusing: DATABASE_URL does not name the database "${databaseName}".`);
  const client = createClient(databaseUrl);
  // A connection lost while idle is reported here instead of ending the
  // process: the pending query, or the next one, fails with it.
  client.on("error", () => {});
  let commitSent = false;
  await client.connect();
  try {
    const database = await assertTarget(client, databaseName);
    await client.query(apply ? "begin isolation level read committed" : "begin read only");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '5s'");
    // A client that stops talking does not keep the rows locked.
    await client.query("set local idle_in_transaction_session_timeout = '30s'");
    const { report, writes } = await planImport(client, rows, { overwrite, lock: apply });
    let written = 0;
    if (apply) {
      written = await applyWrites(client, writes);
      commitSent = true;
      await client.query("commit");
    } else {
      await client.query("rollback");
    }
    return { mode: apply ? "apply" : "dry-run", target: { ...targetOf(databaseUrl), database }, overwrite, ...report, written };
  } catch (error) {
    if (commitSent) throw notKnown(error);
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    // A failing close never hides the answer of a COMMIT that went through.
    await client.end().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = readInput(JSON.parse(await readFile(options.file, "utf8")));
  const result = await runImport({ databaseUrl: process.env.DATABASE_URL, databaseName: options.databaseName, rows, apply: options.apply, overwrite: options.overwrite });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

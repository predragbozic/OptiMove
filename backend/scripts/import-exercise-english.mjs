// Imports the owner's English names and instructions of exercises (owner,
// 2026-11-03: the translation of vezbe.xlsx, exported as JSON), matched by
// exercise code. It writes only library.exercises.name_en and instruction_en
// (migration 202611031200_exercise_english_content.sql), never the Serbian
// name, the instruction or any other column, not even updated_at.
//
//   Dry run (the default) - reads, writes nothing, prints the report:
//     DATABASE_URL=<url> node backend/scripts/import-exercise-english.mjs \
//       --file vezbe-en.json --database-name <name of that database>
//   Apply - one transaction, the same report with what was written; the record
//   of every written field (with the value it replaced) goes to a new file:
//     ... --apply --report-json <new file> [--overwrite] [--include-code 758,759]
//   Undo - puts back exactly what that record says the import wrote, where it
//   is still there (dry run first, --apply to write):
//     ... --undo <record file> --database-name <name> [--apply]
//
// The input is a JSON array of { code, name_sr, instr_sr, name_en, notes_en };
// notes_en is the English of the Serbian instruction (instr_sr). System
// exercises are matched by code. An English value is written only where the
// exercise has none; --overwrite also replaces one that differs. A blank
// English value is never written and never clears anything. The report prints
// codes, names and counts; the copies' ids only with --verbose.
//
// Owner, 2026-11-03 ("Prihvatam sve", and the external review's findings):
// - a matched code whose Serbian name differs from the library's (beyond
//   whitespace), or whose row has no Serbian name to compare, is listed and
//   written only when named in --include-code; never silently;
// - a copy (no code; source_exercise_id or copy_parent_id pointing at a
//   matched exercise) whose name AND instruction still equal its source's
//   gets the same English (what the source holds after the run), only while
//   both its English fields are empty: --overwrite never reaches a copy, and
//   English on a copy that is not its source's is listed, not written. A copy
//   that differs is listed as "changed copy - not written". A copy follows its
//   source: not written while the source is. A copy of a copy is counted, not
//   followed.
//
// Guard: DATABASE_URL comes from the environment only (no .env file is
// read) and is never printed; --database-name must name the database the URL
// points at and the one the connection is really on (current_database()).
// The report names the host and port the client really connected to.
// The production run is the owner's, on its own order (database-safety.md).
import { access, open, readFile, rename, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

export const MIGRATION = "202611031200_exercise_english_content.sql";
export const RECORD_KIND = "exercise-english-import";
const USAGE = "Usage: DATABASE_URL=<url> node backend/scripts/import-exercise-english.mjs --database-name <name> (--file <json> [--include-code <code,code,...>] [--overwrite] [--verbose] [--apply --report-json <new file>] | --undo <record file> [--apply])";
const VALUED = { "--file": "file", "--undo": "undo", "--report-json": "reportJson", "--database-name": "databaseName" };

export function parseArgs(argv) {
  const options = { file: "", undo: "", reportJson: "", databaseName: "", apply: false, overwrite: false, verbose: false, includeCodes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--overwrite") options.overwrite = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (Object.hasOwn(VALUED, arg) || arg === "--include-code") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value. ${USAGE}`);
      if (arg === "--include-code") {
        const codes = value.split(",").map(normalizeCode);
        if (codes.some((code) => !code)) throw new Error(`--include-code takes codes separated by commas. ${USAGE}`);
        options.includeCodes.push(...codes);
      } else options[VALUED[arg]] = value;
      index += 1;
    } else throw new Error(`Unknown argument ${arg}. ${USAGE}`);
  }
  if (!options.databaseName || Boolean(options.file) === Boolean(options.undo)) throw new Error(USAGE);
  if (options.undo && (options.overwrite || options.verbose || options.reportJson || options.includeCodes.length)) {
    throw new Error(`--undo takes only --database-name and --apply. ${USAGE}`);
  }
  if (options.file && options.apply && !options.reportJson) throw new Error(`--apply needs --report-json <new file>: the record the undo reads. ${USAGE}`);
  options.includeCodes = [...new Set(options.includeCodes)];
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
  const links = Number((await client.query(`select count(*) from information_schema.columns
    where table_schema = 'library' and table_name = 'exercises' and column_name in ('source_exercise_id', 'copy_parent_id')`)).rows[0].count);
  if (links !== 2) throw new Error(`Refusing: "${database}" has no copy links on library.exercises (source_exercise_id, copy_parent_id).`);
  return database;
}

// Where the run went, for the report: the host and port the client really
// connected to (a ?host= or ?port= in the URL wins over its address), and the
// database; never a user or a password (database-safety.md).
export const connectedTarget = (client, database) => ({
  host: client.connectionParameters.host, port: String(client.connectionParameters.port), database,
});

// The sheet's Serbian names often carry a double space the library does not;
// two texts are the same when they differ only in whitespace (a missing text
// is an empty one).
const sameText = (a, b) => String(a || "").replace(/\s+/g, " ").trim() === String(b || "").replace(/\s+/g, " ").trim();

function field(planned, stored, overwrite) {
  if (!planned) return "blank";
  if (stored === planned) return "same";
  if (stored !== null && !overwrite) return "alreadyFilled";
  return "write";
}

const counts = () => ({ write: 0, alreadyFilled: 0, same: 0, blank: 0 });

// One target (a matched exercise or a copy) against the English it is to get:
// counted per field, and added to the writes when a field is to be written,
// with the value it replaces (the undo's record). Returns the two outcomes.
function planTarget(target, english, code, overwrite, tally, writes) {
  const name = field(english.nameEn, target.name_en, overwrite);
  const instruction = field(english.instructionEn, target.instruction_en, overwrite);
  tally.nameEn[name] += 1;
  tally.instructionEn[instruction] += 1;
  if (name === "write" || instruction === "write") {
    writes.push({
      id: target.id, code,
      name_en: name === "write" ? english.nameEn : null,
      instruction_en: instruction === "write" ? english.instructionEn : null,
      previous_name_en: name === "write" ? target.name_en : null,
      previous_instruction_en: instruction === "write" ? target.instruction_en : null,
    });
  }
  return { name, instruction };
}

// What a source holds after this run: the sheet's value where it is written
// or already the same, its own otherwise (kept without --overwrite, or a blank
// in the sheet). A copy gets exactly that.
const heldAfter = (outcome, planned, stored) => (outcome === "write" || outcome === "same" ? planned : stored);

const sharedCollectionsLock = (client) => client.query("select pg_advisory_xact_lock_shared(hashtextextended('exercise_collections', 0))");

// What the file would change, read inside the caller's transaction. When
// applying, the app's shared exercise_collections lock comes first (as an
// editor save takes it; block writes take it exclusively), then the matched
// rows and their copies FOR NO KEY UPDATE in id order (what the UPDATE needs,
// and no conflict with the foreign-key checks of a plan save), so nothing
// changes between the plan and the write.
export async function planImport(client, rows, { overwrite = false, lock = false, includeCodes = [], verbose = false } = {}) {
  if (lock) await sharedCollectionsLock(client);
  const found = (await client.query(
    `select id, exercise_code, name, instruction, name_en, instruction_en from library.exercises
      where owner_scope = 'system' and exercise_code = any($1::text[])
      order by id${lock ? " for no key update" : ""}`,
    [rows.map((row) => row.code)],
  )).rows;
  const byCode = new Map();
  for (const exercise of found) {
    if (byCode.has(exercise.exercise_code)) throw new Error(`Refusing: code ${exercise.exercise_code} names more than one system exercise.`);
    byCode.set(exercise.exercise_code, exercise);
  }
  const report = {
    overwrite, rows: rows.length, matched: 0, notFound: [], nameDiffers: [], noSerbianName: [], noEnglish: [], includeCodes,
    nameEn: counts(), instructionEn: counts(),
    copies: { unchanged: 0, changed: [], ownEnglish: [], withSourceNotWritten: 0, ofCopiesNotFollowed: 0, nameEn: counts(), instructionEn: counts() },
  };
  const writes = [];
  // The matched sources: id -> { exercise, row, english } ("english": what it
  // holds after this run, which its copies get; null when it is not written,
  // so its copies are not written either).
  const sources = new Map();
  for (const row of rows) {
    const exercise = byCode.get(row.code);
    if (!exercise) { report.notFound.push(row.code); continue; }
    report.matched += 1;
    if (!row.nameEn && !row.instructionEn) report.noEnglish.push(row.code);
    // A row without a Serbian name cannot be checked against the library's:
    // like a name that differs, it is listed and written only when named.
    const unchecked = !row.nameSr;
    const differs = !unchecked && !sameText(row.nameSr, exercise.name);
    const included = includeCodes.includes(row.code);
    if (unchecked) report.noSerbianName.push({ code: row.code, database: exercise.name, written: included });
    if (differs) report.nameDiffers.push({ code: row.code, database: exercise.name, sheet: row.nameSr, written: included });
    const source = { exercise, row, english: null };
    sources.set(exercise.id, source);
    if ((differs || unchecked) && !included) continue;
    const outcome = planTarget(exercise, row, row.code, overwrite, report, writes);
    source.english = {
      nameEn: heldAfter(outcome.name, row.nameEn, exercise.name_en),
      instructionEn: heldAfter(outcome.instruction, row.instructionEn, exercise.instruction_en),
    };
  }
  // An --include-code that names no listed code is a typo: refused before
  // anything is written.
  const listed = new Set([...report.nameDiffers, ...report.noSerbianName].map((entry) => entry.code));
  const stray = includeCodes.filter((code) => !listed.has(code));
  if (stray.length) throw new Error(`Refusing: --include-code ${stray.join(",")} names no matched code whose Serbian name differs from the library's or is missing.`);

  // The copies: no code of their own, pointing at a matched exercise.
  const copies = sources.size ? (await client.query(
    `select id, name, instruction, name_en, instruction_en, source_exercise_id, copy_parent_id from library.exercises
      where exercise_code is null and (source_exercise_id = any($1::uuid[]) or copy_parent_id = any($1::uuid[]))
      order by id${lock ? " for no key update" : ""}`,
    [[...sources.keys()]],
  )).rows : [];
  for (const copy of copies) {
    const source = sources.get(copy.source_exercise_id) || sources.get(copy.copy_parent_id);
    if (!source.english) { report.copies.withSourceNotWritten += 1; continue; }
    const entry = verbose ? { code: source.row.code, copyId: copy.id } : { code: source.row.code };
    if (!sameText(copy.name, source.exercise.name) || !sameText(copy.instruction, source.exercise.instruction)) {
      report.copies.changed.push(entry);
      continue;
    }
    // --overwrite never reaches a copy (owner, 2026-11-03): it is filled only
    // while both its English fields are empty; one that already holds what its
    // source holds is the same; any other English on it is the coach's own.
    const empty = copy.name_en === null && copy.instruction_en === null;
    const asSource = copy.name_en === source.english.nameEn && copy.instruction_en === source.english.instructionEn;
    if (!empty && !asSource) {
      report.copies.ownEnglish.push(entry);
      continue;
    }
    report.copies.unchanged += 1;
    planTarget(copy, source.english, source.row.code, false, report.copies, writes);
  }
  // A copy of a copy (no code, pointing at one of these copies, at any depth)
  // is not followed; counted, so none is skipped silently.
  if (copies.length) {
    report.copies.ofCopiesNotFollowed = Number((await client.query(
      `with recursive chain (id) as (
         select id from library.exercises
          where exercise_code is null and (source_exercise_id = any($1::uuid[]) or copy_parent_id = any($1::uuid[]))
         union
         select e.id from library.exercises e join chain on e.source_exercise_id = chain.id or e.copy_parent_id = chain.id
          where e.exercise_code is null
       ) select count(*) from chain`,
      [copies.map((copy) => copy.id)],
    )).rows[0].count);
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

// The undo's record: what an apply wrote, field by field, with the value it
// replaced (null where the field was empty or not written).
const recordOf = (target, outcome, writes) => JSON.stringify({ kind: RECORD_KIND, target, outcome, at: new Date().toISOString(), writes }, null, 2);

// The record, on disk and synced before the file is closed; a file this call
// created and could not fill is removed again.
async function writeDurably(file, content) {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(file).catch(() => {});
    throw error;
  }
  await handle.close();
}

const isText = (value) => value === null || typeof value === "string";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readRecord(record) {
  const target = record?.target;
  const ok = record?.kind === RECORD_KIND && Array.isArray(record.writes)
    && ["host", "port", "database"].every((key) => typeof target?.[key] === "string")
    && record.writes.every((entry) => typeof entry?.id === "string" && UUID.test(entry.id)
      && ["name_en", "instruction_en", "previous_name_en", "previous_instruction_en"].every((key) => isText(entry[key])));
  if (!ok) throw new Error("Refusing: the file is not a record of this import.");
  return record.writes;
}

// What the record says the import wrote, read inside the caller's transaction
// (the same locks as an apply), only through the host, port and database the
// apply used: a field still holding what the import wrote gets the value it
// replaced; one back at that value already is counted (alreadyPutBack); any
// other is left and counted (changedSince).
export async function planUndo(client, record, target, { lock = false } = {}) {
  const writes = readRecord(record);
  const from = record.target;
  if (from.host !== target.host || from.port !== target.port || from.database !== target.database) {
    throw new Error(`Refusing: the record is of ${from.host}:${from.port}/${from.database}, not of ${target.host}:${target.port}/${target.database}; run the undo through the connection the apply used.`);
  }
  if (lock) await sharedCollectionsLock(client);
  const current = new Map((await client.query(
    `select id, name_en, instruction_en from library.exercises where id = any($1::uuid[]) order by id${lock ? " for no key update" : ""}`,
    [writes.map((entry) => entry.id)],
  )).rows.map((row) => [row.id, row]));
  const report = {
    fromRecord: { outcome: record.outcome, rows: writes.length, target: from }, missing: 0,
    reverted: { nameEn: 0, instructionEn: 0 }, alreadyPutBack: { nameEn: 0, instructionEn: 0 }, changedSince: { nameEn: 0, instructionEn: 0 },
  };
  const reverts = [];
  for (const entry of writes) {
    const row = current.get(entry.id);
    if (!row) { report.missing += 1; continue; }
    const revert = { id: entry.id, set_name: false, name_en: null, set_instruction: false, instruction_en: null };
    for (const [column, key, flag] of [["name_en", "nameEn", "set_name"], ["instruction_en", "instructionEn", "set_instruction"]]) {
      if (entry[column] === null) continue;
      if (row[column] === entry[column]) {
        revert[flag] = true;
        revert[column] = entry[`previous_${column}`];
        report.reverted[key] += 1;
      } else if (row[column] === entry[`previous_${column}`]) report.alreadyPutBack[key] += 1;
      else report.changedSince[key] += 1;
    }
    if (revert.set_name || revert.set_instruction) reverts.push(revert);
  }
  return { report, reverts };
}

export async function applyReverts(client, reverts) {
  if (!reverts.length) return 0;
  const written = await client.query(
    `update library.exercises e set
       name_en = case when w.set_name then w.name_en else e.name_en end,
       instruction_en = case when w.set_instruction then w.instruction_en else e.instruction_en end
     from jsonb_to_recordset($1::jsonb) as w(id uuid, set_name boolean, name_en text, set_instruction boolean, instruction_en text)
     where e.id = w.id
     returning e.id`,
    [JSON.stringify(reverts)],
  );
  if (written.rowCount !== reverts.length) throw new Error(`Refusing: ${written.rowCount} rows written instead of ${reverts.length}; nothing is kept.`);
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

const notKnown = (error, recheck) => new Error(`The COMMIT's answer was lost (${error.code || error.message}): whether anything was written is not known. ${recheck}`);

// One transaction for an import or an undo: the guards, the bounds, then
// work(client, target) plans and returns { report, write, beforeCommit,
// afterCommit }. createClient: the tests' seam for a lost answer and a
// failing close. recheck: what to run after a lost COMMIT answer.
async function inTransaction({ databaseUrl, databaseName, apply, createClient, recheck }, work) {
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
    const target = connectedTarget(client, database);
    await client.query(apply ? "begin isolation level read committed" : "begin read only");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '5s'");
    // A client that stops talking does not keep the rows locked.
    await client.query("set local idle_in_transaction_session_timeout = '30s'");
    const { report, write, beforeCommit, afterCommit } = await work(client, target);
    let written = 0;
    let record = {};
    if (apply) {
      written = await write();
      await beforeCommit?.(target);
      commitSent = true;
      await client.query("commit");
      // The COMMIT went through: a record that cannot be marked so is left as
      // it was written ("commit_sent", every write in it), which is all the
      // undo reads.
      if (afterCommit) {
        record = await afterCommit(target).then(() => ({ record: "committed" }), (error) => ({ record: "commit_sent", recordError: error.code || "unknown" }));
      }
    } else {
      await client.query("rollback");
    }
    return { mode: apply ? "apply" : "dry-run", target, ...report, written, ...record };
  } catch (error) {
    if (commitSent) throw notKnown(error, recheck);
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    // A failing close never hides the answer of a COMMIT that went through.
    await client.end().catch(() => {});
  }
}

export async function runImport({ databaseUrl, databaseName, rows, apply = false, overwrite = false, includeCodes = [], verbose = false, reportJson = "", createClient = createImportClient }) {
  if (apply && !reportJson) throw new Error("Refusing: an apply needs --report-json <new file>, the record the undo reads.");
  // An existing record is refused before anything is opened; the exclusive
  // create below still refuses one that appears meanwhile.
  if (apply) {
    await access(reportJson).then(() => {
      throw new Error(`Refusing: the record ${reportJson} already exists; name a new file. Nothing was written.`);
    }, () => {});
  }
  const recheck = "Run the dry run again; it shows what is stored. The record file holds every write either way.";
  return inTransaction({ databaseUrl, databaseName, apply, createClient, recheck }, async (client) => {
    const { report, writes } = await planImport(client, rows, { overwrite, lock: apply, includeCodes, verbose });
    return {
      report,
      write: () => applyWrites(client, writes),
      // On disk and synced before the COMMIT is sent, never over an existing
      // file: an apply never commits without its record.
      beforeCommit: (target) => writeDurably(reportJson, recordOf(target, "commit_sent", writes)).catch((error) => {
        throw new Error(`Refusing: the record ${reportJson} could not be written (${error.code || error.message}); nothing was written.`);
      }),
      // Marked committed through a new file renamed over it: the record is
      // never rewritten in place, so a failure here leaves it as it was.
      afterCommit: async (target) => {
        const next = `${reportJson}.tmp`;
        await writeDurably(next, recordOf(target, "committed", writes));
        await rename(next, reportJson);
      },
    };
  });
}

export async function runUndo({ databaseUrl, databaseName, record, apply = false, createClient = createImportClient }) {
  const recheck = "Run the undo's dry run again: alreadyPutBack counts what is back.";
  return inTransaction({ databaseUrl, databaseName, apply, createClient, recheck }, async (client, target) => {
    const { report, reverts } = await planUndo(client, record, target, { lock: apply });
    return { report: { undo: true, ...report }, write: () => applyReverts(client, reverts) };
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const common = { databaseUrl: process.env.DATABASE_URL, databaseName: options.databaseName, apply: options.apply };
  const result = options.undo
    ? await runUndo({ ...common, record: JSON.parse(await readFile(options.undo, "utf8")) })
    : await runImport({
      ...common, rows: readInput(JSON.parse(await readFile(options.file, "utf8"))),
      overwrite: options.overwrite, includeCodes: options.includeCodes, verbose: options.verbose, reportJson: options.reportJson,
    });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
// Generates backend/tests/support/legacy-schema.sql from a schema-only dump.
//
//   pg_restore --schema-only -f schema.sql <the verified production dump>   (the owner, once)
//   node tools/legacy-schema-from-dump.mjs schema.sql
//
// Offline by construction: it reads two things - the SQL text file named on the
// command line and the migrations directory - and writes two files. It opens no
// database connection and no network connection, runs no other program, and
// refuses to write anything (exit 1, nothing on disk) when the scanner finds data
// or a secret-shaped text. It prints rule names and line numbers, never the text.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory } from "./legacy-schema/inventory.mjs";
import { generateSnapshot, GeneratorRefusal } from "./legacy-schema/generate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(code) {
  process.stderr.write("usage: node tools/legacy-schema-from-dump.mjs <schema.sql> [--migrations-dir DIR] [--out FILE] [--check] [--json]\n");
  process.exit(code);
}

const args = process.argv.slice(2);
let input = null;
let migrationsDir = path.join(root, "migrations_v2");
let out = path.join(root, "backend/tests/support/legacy-schema.sql");
let check = false;
let json = false;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--migrations-dir") migrationsDir = path.resolve(args[++i] ?? usage(2));
  else if (a === "--out") out = path.resolve(args[++i] ?? usage(2));
  else if (a === "--check") check = true;
  else if (a === "--json") json = true;
  else if (a.startsWith("--")) usage(2);
  else if (input === null) input = a;
  else usage(2);
}
if (!input) usage(2);

let result;
try {
  const dumpText = fs.readFileSync(path.resolve(input), "utf8");
  result = generateSnapshot({ dumpText, inventory: buildInventory(migrationsDir) });
} catch (error) {
  if (error instanceof GeneratorRefusal) {
    process.stderr.write(`${error.message}\n`);
    for (const f of error.findings.slice(0, 50)) process.stderr.write(`  ${f.rule} at line ${f.line}\n`);
    process.stderr.write("nothing was written\n");
    process.exit(1);
  }
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const hashFile = `${out}.sha256`;
const hashLine = `${result.sha256}  ${path.basename(out)}\n`;
if (check) {
  const same = fs.existsSync(out) && fs.readFileSync(out, "utf8") === result.sql && fs.existsSync(hashFile) && fs.readFileSync(hashFile, "utf8") === hashLine;
  process.stdout.write(same ? "up to date\n" : "DIFFERS from the generated snapshot\n");
  process.exit(same ? 0 : 1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, result.sql);
fs.writeFileSync(hashFile, hashLine);
if (json) process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
else {
  const r = result.report;
  process.stdout.write(`wrote ${path.relative(root, out)} (sha256 ${result.sha256})\n`);
  process.stdout.write(`statements ${r.statements}, kept ${r.kept}, legacy tables ${r.legacyTables.length}\n`);
  process.stdout.write(`dropped: ${Object.entries(r.dropped).map(([k, v]) => `${k} ${v}`).join(", ")}\n`);
  if (r.strippedColumns.length) process.stdout.write(`columns left to the migrations: ${r.strippedColumns.join(", ")}\n`);
  for (const w of r.warnings) process.stdout.write(`WARNING ${w}\n`);
}

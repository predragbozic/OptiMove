#!/usr/bin/env node
// Generates backend/tests/support/legacy-schema.sql from a schema-only dump.
//
//   pg_restore --schema-only -f schema.sql <the verified production dump>   (the owner, once)
//   node tools/legacy-schema-from-dump.mjs schema.sql --last-migration <the last migration file the dump contains>
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
  process.stderr.write("usage: node tools/legacy-schema-from-dump.mjs <schema.sql> --last-migration <file.sql> [--migrations-dir DIR] [--out FILE] [--check] [--json]\n");
  process.exit(code);
}

const args = process.argv.slice(2);
let input = null;
let migrationsDir = path.join(root, "migrations_v2");
let out = path.join(root, "backend/tests/support/legacy-schema.sql");
let lastMigration = null;
let check = false;
let json = false;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--migrations-dir") migrationsDir = path.resolve(args[++i] ?? usage(2));
  else if (a === "--last-migration") lastMigration = args[++i] ?? usage(2);
  else if (a === "--out") out = path.resolve(args[++i] ?? usage(2));
  else if (a === "--check") check = true;
  else if (a === "--json") json = true;
  else if (a.startsWith("--")) usage(2);
  else if (input === null) input = a;
  else usage(2);
}
if (!input || !lastMigration) usage(2);

const real = (f) => { try { return fs.realpathSync(f); } catch { return path.resolve(f); } };
if ([out, `${out}.sha256`].some((t) => real(t) === real(input) || path.join(real(path.dirname(t)), path.basename(t)) === real(input))) {
  process.stderr.write("--out must not be the input file\n");
  process.exit(2);
}
for (const target of [out, `${out}.sha256`]) {
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    process.stderr.write(`${path.basename(target)} is a symbolic link: refusing to write through it\n`);
    process.exit(2);
  }
}
let result;
try {
  const dumpText = fs.readFileSync(path.resolve(input), "utf8");
  if (dumpText.includes("\u0000") || !/\bcreate\s+(?:table|schema)\b/i.test(dumpText)) throw new Error("the input is not the text of a schema-only dump (binary, or no CREATE statement)");
  result = generateSnapshot({ dumpText, inventory: buildInventory(migrationsDir), lastMigration });
} catch (error) {
  if (error instanceof GeneratorRefusal) {
    process.stderr.write(`${error.message}\n`);
    for (const f of error.findings.slice(0, 50)) process.stderr.write(`  ${f.rule}${f.line ? ` at ${f.in === "header" ? "header" : "dump"} line ${f.line}` : ""}${f.detail ? ` (${f.detail})` : ""}\n`);
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
for (const target of [out, hashFile]) {
  // Never overwrite a file that this tool did not write.
  if (fs.existsSync(target)) {
    const head = fs.readFileSync(target, "utf8").slice(0, 80);
    const ours = target === out ? head.startsWith("-- OptiMove legacy schema snapshot") : /^[0-9a-f]{64}  /.test(head);
    if (!ours) { process.stderr.write(`${path.basename(target)} exists and is not a file of this tool: refusing to overwrite it\n`); process.exit(2); }
  }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
for (const [target, content] of [[out, result.sql], [hashFile, hashLine]]) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}
if (json) process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
else {
  const r = result.report;
  process.stdout.write(`wrote ${path.relative(root, out)} (sha256 ${result.sha256})\n`);
  process.stdout.write(`last migration in the dump: ${r.lastMigration} (${r.migrationsInDump} files)\n`);
  process.stdout.write(`statements ${r.statements}, kept ${r.kept}, tables ${r.tables.length}, extensions kept: ${r.keptExtensions.join(", ") || "none"}\n`);
  process.stdout.write(`dropped: ${Object.entries(r.dropped).map(([k, v]) => `${k} ${v}`).join(", ")}\n`);
  for (const w of r.warnings) process.stdout.write(`WARNING ${w}\n`);
}

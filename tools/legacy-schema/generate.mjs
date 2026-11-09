// The legacy-schema snapshot: the WHOLE application schema of a schema-only dump,
// with everything environment-specific removed (decision of the Rukovodilac,
// 2026-11-09: do not subtract migration objects - they also change legacy
// tables - snapshot the application schema as the dump has it, record the
// migrations up to the dump's last one as applied, and let the real runner apply
// the rest).
//
// Pure and deterministic: the same dump text, inventory and last migration give
// the same bytes. Nothing here reads a database or the network.
import crypto from "node:crypto";
import { splitStatements } from "./sql-split.mjs";
import { describe } from "./classify.mjs";
import { scanText } from "./scan.mjs";

export const TOOL_VERSION = 2;

// Schemas that belong to the hosting platform, never to the application.
// (`extensions` is handled apart: it only holds extension objects, which are not dumped.)
export const PLATFORM_SCHEMAS = new Set([
  "auth", "storage", "graphql", "graphql_public", "realtime", "vault", "pgsodium", "pgsodium_masks",
  "supabase_functions", "supabase_migrations", "net", "cron", "pgbouncer", "pg_catalog", "information_schema", "pg_toast", "_realtime", "_analytics", "pgtle",
]);

// Extensions of a stock PostgreSQL that application objects may use. Every other
// extension (the platform's own) is dropped and named in the report.
export const KEPT_EXTENSIONS = new Set(["pgcrypto", "uuid-ossp", "citext", "pg_trgm", "btree_gist", "unaccent", "plpgsql"]);

const PREAMBLE = [
  "SET statement_timeout = 0;",
  "SET lock_timeout = 0;",
  "SET client_encoding = 'UTF8';",
  "SET standard_conforming_strings = on;",
  "SET check_function_bodies = false;",
  "SET client_min_messages = warning;",
  "SET row_security = off;",
  "SELECT pg_catalog.set_config('search_path', '', false);",
];

// Statements about the server, its roles and its publications: environment, not application.
const ENVIRONMENT_STATEMENT = /^(?:alter default privileges|create publication|alter publication|create (?:role|user|database|event trigger|server)|alter (?:role|user|database|system))\b/i;

const PLATFORM_REFERENCE = /\b(?:auth|storage|vault|realtime|graphql|graphql_public|pgsodium|supabase_functions|net)\./i;

export class GeneratorRefusal extends Error {
  constructor(message, findings = []) {
    super(message);
    this.name = "GeneratorRefusal";
    this.findings = findings;
  }
}

// Which migrations the dump already contains: every table a migration up to the
// last one creates must be in the dump (unless a later migration drops it), and
// no table of a later migration may be. A wrong `lastMigration` is a refusal,
// never a silent mix.
export function checkLastMigration({ inventory, lastMigration, dumpTables }) {
  const files = inventory.perFile.map((p) => p.file);
  const at = files.indexOf(lastMigration);
  if (at === -1) throw new GeneratorRefusal(`the last migration "${lastMigration}" is not a file of the migrations directory`);
  const problems = [];
  inventory.perFile.forEach((entry, i) => {
    for (const t of entry.tables) {
      if (inventory.dropped.has(t)) continue;
      const present = dumpTables.has(t);
      if (i <= at && !present) problems.push({ rule: "migration-missing-from-dump", line: 0, detail: `${entry.file}: ${t}` });
      if (i > at && present) problems.push({ rule: "migration-newer-than-last", line: 0, detail: `${entry.file}: ${t}` });
    }
  });
  if (problems.length) throw new GeneratorRefusal(`the dump does not match the last migration "${lastMigration}": ${problems.length} table(s), first: ${problems[0].detail}`, problems);
  return at;
}

export function generateSnapshot({ dumpText, inventory, lastMigration }) {
  if (!lastMigration) throw new GeneratorRefusal("the last migration of the dump is required");
  dumpText = dumpText.replace(/\r\n?/g, "\n"); // the same dump gives the same bytes on every platform
  const { statements, metaLines, dataBlocks } = splitStatements(dumpText);
  const refusals = [];
  for (const b of dataBlocks) refusals.push({ rule: "data-block", line: b.line });
  const kept = [];
  const keptLines = []; // the dump line each kept statement starts at
  const dropped = new Map();
  const drop = (reason) => dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
  const warnings = [];
  const dumpTables = new Set();
  const keptExtensions = [];
  const droppedExtensions = [];
  let extensionsSchema = false;
  const isPlatform = (s) => PLATFORM_SCHEMAS.has(s) || s.startsWith("pg_");

  for (const s of statements) {
    const d = describe(s.text);
    if (d.kind === "data") { refusals.push({ rule: "data-statement", line: s.line }); continue; }
    if (d.kind === "session") { drop("session"); continue; }
    if (d.kind === "extension") {
      const m = /^create\s+extension\s+(?:if\s+not\s+exists\s+)?("?)([A-Za-z0-9_-]+)\1/i.exec(s.text.trim());
      const name = (m?.[2] ?? "").toLowerCase();
      if (KEPT_EXTENSIONS.has(name)) { keptExtensions.push(name); kept.push(s.text); keptLines.push(s.line); } else { droppedExtensions.push(name || "?"); drop("extension"); }
      continue;
    }
    if (["other-create", "other-alter"].includes(d.kind) && ENVIRONMENT_STATEMENT.test(s.text.trim().replace(/\s+/g, " "))) { drop("environment"); continue; }
    if (["other-create", "other-alter"].includes(d.kind)) {
      warnings.push(`line ${s.line}: a statement of kind ${d.kind} (${s.text.split(/\s+/).slice(0, 3).join(" ").toLowerCase()}) was dropped; check that nothing in the application depends on it`);
      drop(d.kind);
      continue;
    }
    if (["owner", "acl", "comment", "other-dml"].includes(d.kind)) { drop(d.kind); continue; }
    if (d.kind === "unknown") { warnings.push(`line ${s.line}: statement not recognised, dropped`); drop("unknown"); continue; }
    if (d.kind === "schema") {
      if (d.name === "public") { drop("public-schema"); continue; }
      if (d.name === "extensions") { extensionsSchema = true; drop("extensions-schema"); continue; }
      if (isPlatform(d.name)) { drop("platform-schema"); continue; }
      kept.push(s.text); keptLines.push(s.line);
      continue;
    }
    if (d.schema && isPlatform(d.schema)) { drop("platform-schema"); continue; }
    switch (d.kind) {
      case "table":
        dumpTables.add(`${d.schema}.${d.name}`);
        kept.push(s.text); keptLines.push(s.line);
        continue;
      case "sequence": case "type": case "view": case "function": case "index": case "trigger":
        kept.push(s.text); keptLines.push(s.line);
        continue;
      case "policy":
        if (PLATFORM_REFERENCE.test(s.text)) { drop("policy-on-platform-function"); continue; }
        kept.push(s.text); keptLines.push(s.line);
        continue;
      case "alter-sequence":
        if (d.action === "owner") { drop("owner"); continue; }
        if (d.action === "other") { warnings.push(`line ${s.line}: ALTER SEQUENCE other than OWNED BY dropped (it could carry a counter value)`); drop("alter-sequence-other"); continue; }
        kept.push(s.text); keptLines.push(s.line);
        continue;
      case "alter-table":
        if (d.action === "owner") { drop("owner"); continue; }
        if (d.action === "rls" && /disable\s+trigger|enable\s+(?:replica|always)\s+trigger/i.test(d.rest)) warnings.push(`line ${s.line}: a trigger state (${d.rest.slice(0, 40)}) is kept - check it`);
        kept.push(s.text); keptLines.push(s.line);
        continue;
      default:
        warnings.push(`line ${s.line}: ${d.kind} not handled, dropped`);
        drop(d.kind);
    }
  }
  // A kept statement that names a platform schema or an extension schema depends on
  // something the snapshot does not have: reported (never silent), with the dump line.
  const dependency = /\b(auth|storage|extensions|graphql|graphql_public|realtime|vault|pgsodium|supabase_functions|net)\.[A-Za-z_]/g;
  kept.forEach((text, i) => {
    if (/^create\s+extension/i.test(text)) return;
    const hits = [...new Set([...text.matchAll(dependency)].map((m) => m[1]))];
    if (hits.length) warnings.push(`line ${keptLines[i]}: a kept statement refers to ${hits.sort().join(", ")} (a platform or extension schema); the snapshot may not apply`);
  });
  // The platform puts its extensions in the `extensions` schema; application
  // objects (a default calling extensions.uuid_generate_v4()) may refer to it.
  const needsExtensionsSchema = extensionsSchema || keptExtensions.length > 0;
  const at = checkLastMigration({ inventory, lastMigration, dumpTables });
  for (const u of inventory.unanalysed) warnings.push(`informational, a migration step the tool cannot analyse (any change it makes to a legacy table is not checked): ${u}`);
  for (const a of inventory.alterations) warnings.push(`informational, a migration changes a legacy definition in place: ${a}`);
  if (droppedExtensions.length) warnings.push(`extensions dropped (not in a stock PostgreSQL): ${[...new Set(droppedExtensions)].sort().join(", ")}`);

  const inputHash = crypto.createHash("sha256").update(dumpText).digest("hex");
  const head = needsExtensionsSchema ? ["CREATE SCHEMA IF NOT EXISTS extensions;"] : [];
  const body = `${PREAMBLE.join("\n")}\n\n${[...head, ...kept.map((k) => k.replace(/\s+$/g, ""))].join("\n\n")}\n`;
  const header = [
    "-- OptiMove legacy schema snapshot (GENERATED - do not edit by hand).",
    `-- Tool: tools/legacy-schema-from-dump.mjs, version ${TOOL_VERSION}.`,
    `-- Input: a schema-only dump, sha256 ${inputHash}.`,
    `-- Last migration contained in the dump: ${lastMigration}.`,
    "-- The whole application schema as the dump has it; structure only: no data, no owners, no grants, no platform schemas.",
    "",
  ].join("\n");
  const sql = `${header}${body}`;
  // Findings are reported against the DUMP's lines (the generated file is never
  // opened by the owner): each kept statement is scanned on its own and its
  // findings are shifted to the line the statement starts at in the dump.
  const findings = [...refusals.map((f) => ({ ...f, in: "dump" }))];
  kept.forEach((text, i) => {
    for (const f of scanText(text)) findings.push({ rule: f.rule, line: keptLines[i] + f.line - 1, in: "dump" });
  });
  for (const f of scanText(header)) findings.push({ rule: f.rule, line: f.line, in: "header" });
  if (findings.length) {
    throw new GeneratorRefusal(`refused: ${findings.length} finding(s) - ${[...new Set(findings.map((f) => f.rule))].join(", ")}`, findings);
  }
  return {
    sql,
    sha256: crypto.createHash("sha256").update(sql).digest("hex"),
    lastMigration,
    report: {
      inputSha256: inputHash,
      lastMigration,
      migrationsInDump: at + 1,
      statements: statements.length,
      kept: kept.length,
      metaLinesDropped: metaLines.length,
      dropped: Object.fromEntries([...dropped].sort(([a], [b]) => a.localeCompare(b))),
      tables: [...dumpTables].sort(),
      keptExtensions: [...new Set(keptExtensions)].sort(),
      droppedExtensions: [...new Set(droppedExtensions)].sort(),
      warnings,
    },
  };
}

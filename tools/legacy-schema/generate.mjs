// The legacy-schema snapshot: the objects of a schema-only dump that the
// migrations (migrations_v2) do NOT create, with everything environment-specific
// removed. Pure and deterministic: the same dump text and the same inventory give
// the same bytes. Nothing here reads a database or the network.
import crypto from "node:crypto";
import { splitStatements } from "./sql-split.mjs";
import { describe, parseName, unquote } from "./classify.mjs";
import { scanText } from "./scan.mjs";

export const TOOL_VERSION = 1;

// Schemas that belong to the hosting platform, never to the application.
export const PLATFORM_SCHEMAS = new Set([
  "auth", "storage", "extensions", "graphql", "graphql_public", "realtime", "vault", "pgsodium", "pgsodium_masks",
  "supabase_functions", "supabase_migrations", "net", "cron", "pgbouncer", "pg_catalog", "information_schema", "pg_toast", "_realtime", "_analytics", "pgtle",
]);

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

export class GeneratorRefusal extends Error {
  constructor(message, findings = []) {
    super(message);
    this.name = "GeneratorRefusal";
    this.findings = findings;
  }
}

// Splits the body of CREATE TABLE ( ... ) at top-level commas.
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "'") {
      let j = i + 1;
      while (j < body.length) { if (body[j] === "'") { if (body[j + 1] === "'") { j += 2; continue; } break; } j += 1; }
      cur += body.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < body.length && body[j] !== '"') j += 1;
      cur += body.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Removes the columns and constraints a migration adds from a CREATE TABLE.
export function stripAddedFromCreateTable(statement, { columns = new Set(), constraints = new Set() }) {
  const open = statement.indexOf("(");
  const close = statement.lastIndexOf(")");
  if (open === -1 || close < open) return { text: statement, removedColumns: [], removedConstraints: [] };
  const head = statement.slice(0, open + 1);
  const tail = statement.slice(close);
  const parts = splitTopLevel(statement.slice(open + 1, close));
  const removedColumns = [];
  const removedConstraints = [];
  const kept = parts.filter((raw) => {
    const part = raw.trim();
    const c = /^constraint\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)/i.exec(part);
    if (c) {
      if (constraints.has(unquote(c[1]))) { removedConstraints.push(unquote(c[1])); return false; }
      return true;
    }
    if (/^(?:primary key|unique|check|foreign key|exclude|like)\b/i.test(part)) return true;
    const col = parseName(part);
    if (col && columns.has(col.name) && !part.includes(".")) { removedColumns.push(col.name); return false; }
    return true;
  });
  const body = kept.map((p) => `\n    ${p.trim()}`).join(",");
  return { text: `${head}${body}\n${tail}`, removedColumns, removedConstraints };
}

export function generateSnapshot({ dumpText, inventory }) {
  const { statements, metaLines, dataBlocks } = splitStatements(dumpText);
  const refusals = [];
  for (const b of dataBlocks) refusals.push({ rule: "data-block", line: b.line });
  const kept = [];
  const dropped = new Map();
  const drop = (reason) => dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
  const warnings = [];
  const strippedColumns = [];
  const legacyTables = new Set();
  const isV2Schema = (s) => inventory.schemas.has(s);
  const isPlatform = (s) => PLATFORM_SCHEMAS.has(s) || s.startsWith("pg_");
  const v2Object = (kind, schema, name) => inventory.objects.has(`${kind}:${schema}.${name}`);
  const v2Table = (schema, name) => v2Object("table", schema, name);
  const dropReasonFor = (d) => {
    if (d.schema && isPlatform(d.schema)) return "platform-schema";
    if (d.schema && isV2Schema(d.schema)) return "migration-schema";
    return null;
  };

  for (const s of statements) {
    const d = describe(s.text);
    if (d.kind === "data") { refusals.push({ rule: "data-statement", line: s.line }); continue; }
    if (d.kind === "session") { drop("session"); continue; }
    if (["extension", "owner", "acl", "comment", "other-create", "other-alter", "other-dml"].includes(d.kind)) { drop(d.kind); continue; }
    if (d.kind === "unknown") { warnings.push(`line ${s.line}: statement not recognised, dropped`); drop("unknown"); continue; }
    const reason = dropReasonFor(d);
    if (reason) { drop(reason); continue; }
    switch (d.kind) {
      case "schema":
        if (d.name === "public") { drop("public-schema"); continue; }
        kept.push(s.text);
        continue;
      case "table": {
        if (v2Table(d.schema, d.name)) { drop("migration-object"); continue; }
        const t = `${d.schema}.${d.name}`;
        legacyTables.add(t);
        const stripped = stripAddedFromCreateTable(s.text, { columns: inventory.addedColumns.get(t), constraints: inventory.addedConstraints.get(t) });
        for (const c of stripped.removedColumns) strippedColumns.push(`${t}.${c}`);
        kept.push(stripped.text);
        continue;
      }
      case "sequence":
      case "type":
      case "view":
      case "function":
        if (v2Object(d.kind, d.schema, d.name)) { drop("migration-object"); continue; }
        kept.push(s.text);
        continue;
      case "index":
        if (inventory.indexes.has(`${d.schema}.${d.name}`) || v2Table(d.schema, d.table)) { drop("migration-object"); continue; }
        kept.push(s.text);
        continue;
      case "trigger":
        if (inventory.triggers.has(`${d.schema}.${d.table}:${d.name}`) || v2Table(d.schema, d.table)) { drop("migration-object"); continue; }
        kept.push(s.text);
        continue;
      case "policy":
        drop("policy");
        continue;
      case "alter-sequence":
        if (d.action === "owner") { drop("owner"); continue; }
        if (v2Object("sequence", d.schema, d.name)) { drop("migration-object"); continue; }
        kept.push(s.text);
        continue;
      case "alter-table": {
        if (d.action === "owner") { drop("owner"); continue; }
        if (d.action === "rls") { drop("row-level-security"); continue; }
        const t = `${d.schema}.${d.table}`;
        if (v2Table(d.schema, d.table)) { drop("migration-object"); continue; }
        if (d.action === "add-constraint" && d.constraint && inventory.addedConstraints.get(t)?.has(d.constraint)) { drop("migration-object"); continue; }
        if (d.action === "add-column" && d.columns.every((c) => inventory.addedColumns.get(t)?.has(c))) { drop("migration-object"); continue; }
        kept.push(s.text);
        continue;
      }
      default:
        warnings.push(`line ${s.line}: ${d.kind} not handled, dropped`);
        drop(d.kind);
    }
  }
  for (const a of inventory.alterations) warnings.push(`a migration changes a legacy definition the tool cannot undo: ${a}`);
  for (const u of inventory.unanalysed) warnings.push(`a migration step the tool cannot analyse: ${u}`);

  const inputHash = crypto.createHash("sha256").update(dumpText).digest("hex");
  const body = `${PREAMBLE.join("\n")}\n\n${kept.map((k) => k.replace(/\s+$/g, "")).join("\n\n")}\n`;
  const header = [
    "-- OptiMove legacy schema snapshot (GENERATED - do not edit by hand).",
    "-- Tool: tools/legacy-schema-from-dump.mjs, version " + TOOL_VERSION + ".",
    `-- Input: a schema-only dump, sha256 ${inputHash}.`,
    `-- Migrations considered: ${inventory.files} files of migrations_v2.`,
    "-- Only objects that no migration creates; structure only, no data, no owners, no grants.",
    "",
  ].join("\n");
  const sql = `${header}${body}`;
  const findings = [...refusals, ...scanText(sql)];
  if (findings.length) {
    throw new GeneratorRefusal(`refused: ${findings.length} finding(s) - ${[...new Set(findings.map((f) => f.rule))].join(", ")}`, findings);
  }
  return {
    sql,
    sha256: crypto.createHash("sha256").update(sql).digest("hex"),
    report: {
      inputSha256: inputHash,
      statements: statements.length,
      kept: kept.length,
      metaLinesDropped: metaLines.length,
      dropped: Object.fromEntries([...dropped].sort(([a], [b]) => a.localeCompare(b))),
      legacyTables: [...legacyTables].sort(),
      strippedColumns: strippedColumns.sort(),
      warnings,
    },
  };
}

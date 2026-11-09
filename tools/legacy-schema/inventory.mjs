// What the migrations (migrations_v2/*.sql) create or change, so that the legacy
// snapshot can leave exactly that out. Offline: reads files, runs nothing.
import fs from "node:fs";
import path from "node:path";
import { splitStatements } from "./sql-split.mjs";
import { describe } from "./classify.mjs";

const key = (kind, schema, name) => `${kind}:${schema}.${name}`;

// Used by the generator only to PROVE which migrations a dump already contains:
// it never removes anything from the snapshot (the snapshot is the whole
// application schema of the dump, see generate.mjs).
export function buildInventory(migrationsDir) {
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const inv = {
    files: files.length,
    schemas: new Set(),          // schemas a migration creates: wholly v2
    objects: new Set(),          // kind:schema.name of tables, sequences, types, views, functions a migration creates
    droppedNames: new Set(),     // bare names of triggers/indexes some migration drops
    indexes: new Set(),          // schema.name
    triggers: new Set(),         // table:name  (a trigger name is per table)
    policies: new Set(),
    addedColumns: new Map(),     // schema.table -> Set(column)  on tables the migrations do NOT create
    addedConstraints: new Map(), // schema.table -> Set(constraint name)
    alterations: [],             // changes to a legacy definition the tool cannot undo: reported, never silent
    unanalysed: [],              // DO blocks and anything else that may change objects
    perFile: [],                 // [{ file, tables: ["schema.name"] }] in order
    dropped: new Set(),          // "schema.name" of any table a migration drops
  };
  const created = [];
  const alters = [];
  for (const f of files) {
    const { statements } = splitStatements(fs.readFileSync(path.join(migrationsDir, f), "utf8"));
    const entry = { file: f, tables: [], indexes: [], triggers: [] };
    inv.perFile.push(entry);
    for (const s of statements) {
      const drop = /^drop\s+table\s+(?:if\s+exists\s+)?([\w".]+)/i.exec(s.text.trim());
      if (drop) {
        const n = drop[1].replace(/"/g, "").toLowerCase();
        inv.dropped.add(n.includes(".") ? n : `public.${n}`);
      }
      const dropObj = /^drop\s+(trigger|index)\s+(?:concurrently\s+)?(?:if\s+exists\s+)?([\w".]+)/i.exec(s.text.trim());
      if (dropObj) inv.droppedNames.add(dropObj[2].replace(/"/g, "").toLowerCase().split(".").pop().slice(0, 63));
      const d = describe(s.text);
      const where = `${f}:${s.line}`;
      if (d.kind === "schema") inv.schemas.add(d.name);
      else if (["table", "sequence", "type", "view", "function"].includes(d.kind)) {
        inv.objects.add(key(d.kind, d.schema, d.name));
        created.push(d);
        if (d.kind === "table") entry.tables.push(`${d.schema}.${d.name}`);
      }
      else if (d.kind === "index") { inv.indexes.add(`${d.schema}.${d.name}`); entry.indexes.push(`${d.schema}.${String(d.name).slice(0, 63)}`); }
      else if (d.kind === "trigger") { inv.triggers.add(`${d.schema}.${d.table}:${d.name}`); entry.triggers.push(`${d.schema}.${d.table}:${String(d.name).slice(0, 63)}`); }
      else if (d.kind === "policy") inv.policies.add(`${d.schema}.${d.table}:${d.name}`);
      else if (d.kind === "alter-table") alters.push({ d, where });
      else if (d.kind === "other-dml" && /^do\s/i.test(s.text.trim())) inv.unanalysed.push(`${where} DO block: ${s.text.replace(/\s+/g, " ").slice(0, 60)}`);
    }
  }
  const createdTables = new Set([...inv.objects].filter((o) => o.startsWith("table:")).map((o) => o.slice(6)));
  for (const { d, where } of alters) {
    const t = `${d.schema}.${d.table}`;
    if (createdTables.has(t) || inv.schemas.has(d.schema)) continue; // a table of the migrations: dropped as a whole
    if (d.action === "add-column") {
      if (!inv.addedColumns.has(t)) inv.addedColumns.set(t, new Set());
      for (const c of d.columns) inv.addedColumns.get(t).add(c);
    } else if (d.action === "add-constraint" && d.constraint) {
      if (!inv.addedConstraints.has(t)) inv.addedConstraints.set(t, new Set());
      inv.addedConstraints.get(t).add(d.constraint);
    } else if (["alter-column", "modify", "other", "add-constraint", "partition"].includes(d.action)) {
      inv.alterations.push(`${where} ${t}: ${d.rest.slice(0, 80)}`);
    }
  }
  return inv;
}

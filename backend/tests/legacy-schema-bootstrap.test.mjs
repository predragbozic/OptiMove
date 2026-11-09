// Step 0, the end-to-end proof on a real PostgreSQL, with REAL pg_dump output and
// the repository's REAL migrations (the curated GPEXE_TEST_MIGRATIONS list):
//   P   a disposable database at migration K (legacy scaffold + the first K+1 files)
//   dump = pg_dump --schema-only of P (what pg_restore --schema-only gives for the owner's dump)
//   S   the snapshot the generator makes from that dump, with K as the last migration
//   F   a fresh database: S, the migrations up to K recorded as applied (with the
//       repository files' checksums) and their seed rows replayed, then the REAL
//       runner applies the migrations after K
//   R   the reference: a fresh database built by the existing path (all files)
// F and R must have the same catalog and the same seed rows. Disposable
// optimove_tests_* databases only; nothing here touches a persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { createDisposableDatabase, dropDisposableDatabase } from "./support/disposable-db.mjs";
import { bootstrapLegacySnapshot } from "./support/legacy-bootstrap.mjs";
import { runMigrations } from "../src/migrate.js";
import { buildInventory } from "../../tools/legacy-schema/inventory.mjs";
import { generateSnapshot } from "../../tools/legacy-schema/generate.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL = process.env.DATABASE_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const LAST = GPEXE_TEST_MIGRATIONS[12]; // training_activity_v4_canonical_functions: legacy tables AND later migrations on both sides
let tmp;
let migrationsRoot;
let preDb;
let refDb;
let freshDb;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-bootstrap-"));
  migrationsRoot = path.join(tmp, "migrations_v2");
  fs.mkdirSync(migrationsRoot);
  for (const f of GPEXE_TEST_MIGRATIONS) fs.copyFileSync(path.resolve(here, "../../migrations_v2", f), path.join(migrationsRoot, f));
});
after(async () => {
  for (const db of [preDb, refDb]) if (db) await db.drop().catch(() => {});
  if (freshDb) await dropDisposableDatabase({ name: freshDb.name, adminUrl: freshDb.adminUrl, baseDatabaseUrl: ORIGINAL }).catch(() => {});
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// A restored CHECK constraint is the same constraint with a differently deparsed
// text (`ANY ((ARRAY['a'::character varying])::text[])` becomes
// `ANY (ARRAY[('a'::character varying)::text])`): the known round trip of the
// backup verifier's note on v32. Only CHECK constraints are compared through this
// normalisation (casts, parentheses, blanks and the ARRAY keyword removed); every
// other definition is compared as the database prints it.
function normalizeCheck(line) {
  const parts = line.split(" | ");
  if (parts[3] !== "c") return line;
  parts[4] = parts[4].toLowerCase().replace(/::[a-z_ ]+(\[\])?/g, "").replace(/array|[()\s]/g, "");
  return parts.join(" | ");
}

async function catalog(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const q = async (sql) => (await client.query(sql)).rows.map((r) => Object.values(r).join(" | "));
  const S = `n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema' and n.nspname <> 'extensions'`;
  try {
    return {
      columns: await q(`select table_schema, table_name, ordinal_position, column_name, data_type, is_nullable, coalesce(column_default,'') from information_schema.columns where table_schema not like 'pg\\_%' and table_schema not in ('information_schema','extensions') order by 1,2,3`),
      constraints: (await q(`select n.nspname, t.relname, c.conname, c.contype, pg_get_constraintdef(c.oid) from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace where ${S} order by 1,2,3`)).map(normalizeCheck),
      indexes: await q(`select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname not like 'pg\\_%' and schemaname not in ('information_schema','extensions') order by 1,2,3`),
      triggers: await q(`select n.nspname, t.relname, g.tgname, pg_get_triggerdef(g.oid) from pg_trigger g join pg_class t on t.oid = g.tgrelid join pg_namespace n on n.oid = t.relnamespace where not g.tgisinternal and ${S} order by 1,2,3`),
      functions: await q(`select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.prokind in ('f','p') and ${S} and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1,2,3`),
      views: await q(`select schemaname, viewname, md5(definition) from pg_views where schemaname not like 'pg\\_%' and schemaname not in ('information_schema','extensions') order by 1,2`),
      sequences: await q(`select schemaname, sequencename, data_type, increment_by from pg_sequences where schemaname not like 'pg\\_%' order by 1,2`),
      enums: await q(`select n.nspname, t.typname, e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace where ${S} order by 1,2,e.enumsortorder`),
      rls: await q(`select n.nspname, c.relname, c.relrowsecurity::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and ${S} order by 1,2`),
      policies: await q(`select schemaname, tablename, policyname from pg_policies order by 1,2,3`),
    };
  } finally {
    await client.end();
  }
}

async function rowCounts(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tables = (await client.query(`select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE' and table_schema not like 'pg\\_%' and table_schema not in ('information_schema','extensions') order by 1,2`)).rows;
    const out = {};
    for (const t of tables) {
      if (t.table_name === "schema_migrations" || t.table_name === "migration_cutovers" || t.table_name.startsWith("optimove_disposable")) continue;
      out[`${t.table_schema}.${t.table_name}`] = Number((await client.query(`select count(*) from "${t.table_schema}"."${t.table_name}"`)).rows[0].count);
    }
    return out;
  } finally {
    await client.end();
  }
}

test("a snapshot of a real pg_dump at migration K, plus the runner for the migrations after K, equals the database the existing path builds (catalog and seed rows)", async () => {
  const upTo = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(LAST) + 1);
  preDb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL, label: "boot_pre", migrations: upTo });
  const env = { PATH: process.env.PATH };
  const dumped = spawnSync("pg_dump", ["--schema-only", "--dbname", preDb.url], { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
  assert.equal(dumped.status, 0, dumped.stderr);
  assert.ok(dumped.stdout.includes("CREATE TABLE"));

  const inventory = buildInventory(migrationsRoot);
  const { sql, report } = generateSnapshot({ dumpText: dumped.stdout, inventory, lastMigration: LAST });
  assert.equal(report.migrationsInDump, upTo.length);
  assert.ok(report.tables.some((t) => t.startsWith("training_load.")) && report.tables.includes("public.users"));

  freshDb = await createDisposableDatabase({ prefix: "legacy", label: "boot", baseDatabaseUrl: ORIGINAL });
  const boot = await bootstrapLegacySnapshot({ databaseUrl: freshDb.url, snapshotSql: sql, migrationsRoot, lastMigration: LAST });
  assert.equal(boot.recorded, upTo.length);
  await runMigrations({ databaseUrl: freshDb.url, migrationsRoot });

  refDb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL, label: "boot_ref" });
  const [a, b] = [await catalog(freshDb.url), await catalog(refDb.url)];
  for (const key of Object.keys(b)) {
    const missing = b[key].filter((x) => !a[key].includes(x));
    const extra = a[key].filter((x) => !b[key].includes(x));
    if (missing.length || extra.length) console.error(`CATALOGDIFF ${key}\n  missing: ${missing.slice(0, 4).join("\n           ")}\n  extra:   ${extra.slice(0, 4).join("\n           ")}`);
    assert.ok(!missing.length && !extra.length, `catalog ${key}: ${missing.length} missing, ${extra.length} extra\nmissing: ${missing.slice(0, 3).join("\n         ")}\nextra:   ${extra.slice(0, 3).join("\n         ")}`);
  }
  assert.deepEqual(await rowCounts(freshDb.url), await rowCounts(refDb.url), "the seed rows of the migrations (replayed up to K, applied by the runner after K) equal the reference");
});

test("the runner refuses a repository migration whose file changed after it was recorded (the checksums the bootstrap wrote are the real ones)", async () => {
  const file = path.join(migrationsRoot, LAST);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([original, Buffer.from("\n-- drift\n")]));
  try {
    await assert.rejects(() => runMigrations({ databaseUrl: freshDb.url, migrationsRoot }), /checksum differs|recorded checksum/i);
  } finally {
    fs.writeFileSync(file, original);
  }
});

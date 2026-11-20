#!/usr/bin/env node
// Roles R2, v84 preflight block 1b (contract 7.1, item 1: "no checksum of a recorded file differs from the
// repository's"). Prints ONE read-only SQL statement that compares every recorded migrations_v2 checksum with the
// sha256 of the same file in this checkout (the runner's own checksum: sha256 of the file's bytes). Run it on the
// merge tree, then run its output in `begin transaction read only; ... rollback;`. It opens no connection and
// reads nothing but the migrations_v2 folder.
//
//   node backend/scripts/permission-roles-v84-checksums.mjs > /tmp/v84-checksums.sql
//
// Columns: no_recorded_checksum_differs (must be true); recorded_not_in_repo (for the reader: a recorded file
// this checkout does not have, e.g. a later migration of another branch).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations_v2");

export function repositoryChecksums(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => [`migrations_v2/${f}`, crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex")]);
}

export function checksumSql(rows = repositoryChecksums()) {
  for (const [name, sum] of rows) {
    if (!/^migrations_v2\/[0-9]{12}_[A-Za-z0-9_]+\.sql$/.test(name) || !/^[0-9a-f]{64}$/.test(sum)) throw new Error(`unexpected migration file name: ${name}`);
  }
  const values = rows.map(([name, sum]) => `  ('${name}', '${sum}')`).join(",\n");
  return `-- v84 preflight block 1b, generated from the checkout's migrations_v2 (${rows.length} files).
with repo(migration_name, checksum) as (values
${values}
)
select not exists (select 1 from public.schema_migrations m join repo r using (migration_name) where m.checksum <> r.checksum) as no_recorded_checksum_differs,
       (select count(*) from public.schema_migrations m where m.migration_name like 'migrations_v2/%'
          and not exists (select 1 from repo r where r.migration_name = m.migration_name)) as recorded_not_in_repo;
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(checksumSql());
}

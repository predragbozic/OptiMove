// Brings a fresh disposable database to "the dump's state" from a generated
// legacy-schema snapshot, so that the real runner can apply the migrations that
// come AFTER the dump's last one (decision of the Rukovodilac, 2026-11-09):
//   1. the snapshot (the application schema of the dump, structure only);
//   2. one public.schema_migrations row for every migration up to the dump's last
//      one, named exactly as the runner will name it (folder name + file) with the
//      sha256 of the repository file - so the runner skips them and refuses a
//      drifted file;
//   3. the data statements (INSERT / UPDATE / DELETE) of those migrations, in
//      order - the reference rows the repository's own migrations seed. Rows that
//      only the production database had are not in a schema-only dump and are not
//      invented here.
// The caller then runs the real runner (migrate.js runMigrations) with the same
// migrations folder. Disposable databases only.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { migrationIdentity, sha256OfBuffer, RUNNER_VERSION } from "../../src/migrate.js";
import { splitStatements } from "../../../tools/legacy-schema/sql-split.mjs";
import { describe } from "../../../tools/legacy-schema/classify.mjs";
import { assertDisposableDatabaseName, parseServerUrl } from "./disposable-db.mjs";

export async function bootstrapLegacySnapshot({ databaseUrl, snapshotSql, migrationsRoot, lastMigration, replaySeeds = true }) {
  assertDisposableDatabaseName(new URL(databaseUrl).pathname.slice(1));
  parseServerUrl(databaseUrl); // a loopback server, none of the forbidden markers
  const files = fs.readdirSync(migrationsRoot).filter((f) => f.endsWith(".sql")).sort();
  const at = files.indexOf(lastMigration);
  if (at === -1) throw new Error(`the last migration ${lastMigration} is not in ${migrationsRoot}`);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const replayed = { files: 0, statements: 0, skippedUnreplayable: 0 };
  try {
    await client.query(snapshotSql);
    // The snapshot's preamble empties search_path for its own session; the seeds are
    // replayed the way the runner would run them.
    await client.query("reset search_path");
    // A seed of an early migration omits columns that a later migration added as NOT NULL
    // (and filled with an UPDATE that is replayed too). The snapshot has the final NOT NULLs,
    // so they are lifted for the replay and restored after it; restoring fails loudly when a
    // row is still null.
    const notNull = replaySeeds ? (await client.query(`select n.nspname, c.relname, a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace where a.attnotnull and a.attnum > 0 and not a.attisdropped and c.relkind = 'r' and a.attidentity = '' and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\\_%' and not exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey))`)).rows : [];
    for (const r of notNull) await client.query(`alter table "${r.nspname}"."${r.relname}" alter column "${r.attname}" drop not null`);
    // The same for table CHECK constraints: an early seed can be valid only after a later
    // migration's UPDATE. They are dropped for the replay and re-added afterwards (re-adding
    // validates every row, so a row that is still invalid fails loudly).
    const checks = replaySeeds ? (await client.query(`select n.nspname, c.relname, k.conname, pg_get_constraintdef(k.oid) as def from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where k.contype = 'c' and c.relkind = 'r' and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\\_%'`)).rows : [];
    for (const r of checks) await client.query(`alter table "${r.nspname}"."${r.relname}" drop constraint "${r.conname}"`);
    for (const file of files.slice(0, at + 1)) {
      const abs = path.join(migrationsRoot, file);
      const buffer = fs.readFileSync(abs);
      await client.query(
        `insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ($1,$2,0,$3)`,
        [migrationIdentity(migrationsRoot, abs), sha256OfBuffer(buffer), RUNNER_VERSION],
      );
      if (!replaySeeds) continue;
      // DO blocks and SELECT calls may seed rows too; they are not replayed and are counted.
      replayed.skippedUnreplayable += splitStatements(buffer.toString("utf8")).statements.filter((s) => /^(?:do|select)\s/i.test(s.text.trim())).length;
      const data = splitStatements(buffer.toString("utf8")).statements.filter((s) => describe(s.text).kind === "data" && !/^(?:copy|truncate)\b/i.test(s.text.trim()));
      if (data.length) replayed.files += 1;
      if (data.length) {
        // The snapshot already carries the FINAL guard triggers (a seed-window guard that
        // a later migration replaced, actor guards ...); a seed of an earlier migration
        // cannot pass them. The replay therefore runs with triggers off, which needs a
        // superuser; the session setting is reset right after.
        const su = await client.query("select current_setting('is_superuser') as su");
        if (su.rows[0].su !== "on") throw new Error("replaying the seeds needs a superuser on the disposable server (session_replication_role)");
        await client.query("set session_replication_role = replica");
        try {
          for (const s of data) {
            await client.query(s.text);
            replayed.statements += 1;
          }
        } finally {
          await client.query("reset session_replication_role");
        }
      }
    }
    for (const r of notNull) await client.query(`alter table "${r.nspname}"."${r.relname}" alter column "${r.attname}" set not null`);
    // A seed row that only a skipped trigger would have completed (published_at of an activated
    // version) stays as the seed left it: the constraint comes back NOT VALID, enforced for new
    // rows, and is reported - never silently relaxed.
    replayed.checksNotValidated = [];
    for (const r of checks) {
      try {
        await client.query(`alter table "${r.nspname}"."${r.relname}" add constraint "${r.conname}" ${r.def}`);
      } catch (e) {
        if (e.code !== "23514") throw e;
        await client.query(`alter table "${r.nspname}"."${r.relname}" add constraint "${r.conname}" ${r.def} not valid`);
        replayed.checksNotValidated.push(`${r.nspname}.${r.relname}.${r.conname}`);
      }
    }
  } finally {
    await client.end();
  }
  return { recorded: at + 1, replayed };
}

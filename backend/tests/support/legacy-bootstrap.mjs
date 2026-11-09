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
      for (const s of data) {
        await client.query(s.text);
        replayed.statements += 1;
      }
    }
  } finally {
    await client.end();
  }
  return { recorded: at + 1, replayed };
}

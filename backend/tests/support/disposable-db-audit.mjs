// Lists the databases on the local test server, so a test file whose cleanup
// did not run (a crash, an ended process, a lost connection) is visible
// instead of silently filling the server. Run from backend/:
//
//   node tests/support/disposable-db-audit.mjs                 readable list
//   node tests/support/disposable-db-audit.mjs --json          one JSON document
//   node tests/support/disposable-db-audit.mjs --drop --yes    drop the droppable ones
//   ... --drop --yes --only=<name> [--only=<name> ...]         drop only these (still checked)
//
// scripts/test-runner.mjs runs the --json form before and after every
// disposable-kind step and reports what the step left behind. --drop is an
// operator's explicit decision (--yes is required): it drops only names that
// match the strict disposable pattern (optimove_tests_<prefix>_<label>_<12 hex>),
// skips a database that still has sessions open unless --force is given (a
// test in another worktree may be using it), and never touches anything else
// on the server. Every other listed database is reported for a manual
// decision.
import "dotenv/config";
import { DROPPABLE_DATABASE_NAME_PATTERN, countMaintenanceObjects, dropDisposableDatabase, listDatabases, parseServerUrl } from "./disposable-db.mjs";

const argv = process.argv.slice(2);
const args = new Set(argv.filter((a) => !a.startsWith("--only=")));
// --only=<name>: the runner drops the databases of one file it had to end, never the rest
const only = argv.filter((a) => a.startsWith("--only=")).map((a) => a.slice("--only=".length));
const asJson = args.has("--json");
const drop = args.has("--drop");
const yes = args.has("--yes");
const force = args.has("--force");

try {
  if (drop && !yes) throw new Error("--drop needs --yes: it ends sessions and drops every droppable test database on the server");
  const serverUrl = parseServerUrl();
  const rows = await listDatabases();
  const maintenanceObjects = await countMaintenanceObjects();
  const dropped = [];
  const refused = [];
  if (drop) {
    for (const row of rows) {
      if (only.length && !only.includes(row.name)) continue;
      if (!row.disposable || !DROPPABLE_DATABASE_NAME_PATTERN.test(row.name)) {
        refused.push({ name: row.name, reason: "not a droppable test database name" });
        continue;
      }
      if (row.sessions > 0 && !force) {
        refused.push({ name: row.name, reason: `${row.sessions} session(s) still open (pass --force to end them)` });
        continue;
      }
      try {
        // without --force the drop is a plain DROP: PostgreSQL refuses it (55006) if a session
        // opened since the list above, so a session is never ended unless --force was given
        await dropDisposableDatabase({ name: row.name, force });
        dropped.push(row.name);
      } catch (error) {
        refused.push({ name: row.name, reason: error.message });
      }
    }
  }
  const report = { server: `${serverUrl.hostname}:${serverUrl.port || 5432}`, databases: rows, maintenanceObjects, dropped, refused };
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    const disposable = rows.filter((r) => r.disposable);
    process.stdout.write(`databases on ${report.server}: ${rows.length} (${disposable.length} droppable test database(s)); user objects in "postgres": ${maintenanceObjects}\n`);
    for (const row of rows) process.stdout.write(`  ${row.disposable ? "droppable " : "kept      "} ${row.name}${row.sessions ? `  (${row.sessions} session(s) open)` : ""}\n`);
    if (drop) {
      process.stdout.write(`dropped ${dropped.length}, refused ${refused.length}\n`);
      for (const r of refused) if (r.reason !== "not a droppable test database name") process.stdout.write(`  refused ${r.name}: ${r.reason}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`audit failed: ${error.message}\n`);
  process.exitCode = 1;
}

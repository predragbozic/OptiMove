// Roles V-4: the server's role read (authz.js ROLE_PERMISSIONS_SQL) needs the objects of v84 and v92. Since V-4 a club
// admin's and a team coach's Tests paths ask can() for tests.view / tests.results.view, which fails closed (503
// permissions_unavailable) on a database without them. The older Tests suites build their database from the Tests
// migrations only; after those they call applyRoleReadMigrations(url), which runs the real runner once more over a
// temporary folder named migrations_v2 that holds only v84 and v92 (their seed guards read the runner's own record,
// `migrations_v2/<file>`). The same two files as createGpexeDisposableDb({ roleRead: true }) uses.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_READ_MIGRATIONS } from "../_gpexe-disposable-db.mjs";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations_v2");

export async function applyRoleReadMigrations(databaseUrl) {
  const runner = await import("../../src/migrate.js");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-role-read-"));
  const dir = path.join(root, "migrations_v2");
  try {
    await fsp.mkdir(dir);
    for (const name of ROLE_READ_MIGRATIONS) await fsp.copyFile(path.join(MIGRATIONS, name), path.join(dir, name));
    await runner.runMigrations({ databaseUrl, migrationsRoot: dir });
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

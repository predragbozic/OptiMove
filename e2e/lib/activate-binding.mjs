// Run as a child process with DATABASE_URL set to the e2e world's disposable database: the mapped-world helper loads the
// backend services, which read DATABASE_URL when they are imported. Activates the three system mappings (time, distance,
// top speed) on one binding, exactly as the backend suites' fixtures do.
import pg from "pg";
import { activateBinding } from "../../backend/tests/support/mapped-world.mjs";

const bindingId = process.argv[2];
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await activateBinding(client, bindingId);
} finally {
  await client.end();
}
process.exit(0);

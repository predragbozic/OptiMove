// Standalone CLI entrypoint for the training_load external-scheduling
// notification worker - a structural copy of testsNotificationWorkerCli.js.
// Meant to be invoked periodically by an external scheduler; this file is
// the ONLY place that opens a real DB connection and takes the advisory
// lock - processTrainingLoadNotificationCycle() itself
// (trainingLoadNotificationWorker.js) stays a plain, testable function
// that only ever receives an already-connected pool.
//
// No setInterval() here and none in the web server - same rule
// testsNotificationWorkerCli.js documents.
import pg from "pg";
import { pathToFileURL } from "node:url";
import { processTrainingLoadNotificationCycle } from "./trainingLoadNotificationWorker.js";

// A distinct key from migrate.js's own MIGRATION_LOCK_KEY (822026n) and
// from the Tests worker's own WORKER_LOCK_KEY (822027n) - three
// completely different jobs, three completely different locks. Same
// non-blocking pg_try_advisory_lock convention as the Tests worker: if
// another cycle is still running when this one starts, it simply skips
// itself and exits 0 - every phase here is fully idempotent, so the next
// scheduled run picks up right where an uninterrupted cycle would have.
const WORKER_LOCK_KEY = 822028n;

function buildPgPoolConfig(databaseUrl) {
  return {
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("supabase.com") ? { rejectUnauthorized: false } : undefined,
    max: 5,
  };
}

export async function runTrainingLoadNotificationWorkerOnce({ now = new Date(), databaseUrl = process.env.DATABASE_URL } = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool(buildPgPoolConfig(databaseUrl));
  const lockClient = await pool.connect();
  try {
    const lockResult = await lockClient.query("select pg_try_advisory_lock($1) as locked", [WORKER_LOCK_KEY]);
    if (!lockResult.rows[0].locked) {
      return { ok: true, skipped: true, reason: "another worker cycle is already running" };
    }
    try {
      const summary = await processTrainingLoadNotificationCycle({ now, pool });
      return { ok: true, skipped: false, ...summary };
    } finally {
      await lockClient.query("select pg_advisory_unlock($1)", [WORKER_LOCK_KEY]).catch(() => {});
    }
  } finally {
    lockClient.release();
    await pool.end();
  }
}

async function main() {
  const result = await runTrainingLoadNotificationWorkerOnce({});
  console.log(JSON.stringify(result, null, 2));
  const hadFailures = (result.errors || []).length > 0;
  process.exitCode = hadFailures ? 1 : 0;
}

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}

// Standalone CLI entrypoint for the Tests notification worker - meant to be
// invoked periodically (e.g. every 5 minutes) by an external scheduler
// (`npm run tests:notifications:worker`, see README-tests-notification-
// worker.md for the recommended interval and how to wire it up). This file
// is intentionally the ONLY place that opens a real DB connection and takes
// the advisory lock - processTestNotificationCycle() itself (
// testsNotificationWorker.js) stays a plain, testable function that only
// ever receives an already-connected pool.
//
// No setInterval() here and none in the web server (src/server.js) - the
// web server and this worker are, and stay, two separate processes. A
// scheduler (cron, Render Cron Job, a plain `watch`/task scheduler, etc.)
// is what decides WHEN this runs; this file only knows how to run once and
// exit with the right code. Wiring an actual scheduler is explicitly out of
// scope for this phase (see the README).
import pg from "pg";
import { pathToFileURL } from "node:url";
import { processTestNotificationCycle } from "./testsNotificationWorker.js";

// A distinct key from migrate.js's own MIGRATION_LOCK_KEY (822026n) - two
// completely different jobs, two completely different locks. Unlike
// migrate.js's polling wait-for-the-lock convention (appropriate for a
// one-time deploy step that should wait its turn), this worker uses a
// single, non-blocking pg_try_advisory_lock: if another cycle is still
// running when this one starts, it simply skips itself and exits 0 - the
// next scheduled run picks up right where an uninterrupted cycle would have
// been anyway, since every phase here is fully idempotent. This is what
// makes "two overlapping worker invocations" safe by construction rather
// than by locking one of them into a long wait.
const WORKER_LOCK_KEY = 822027n;

function buildPgPoolConfig(databaseUrl) {
  return {
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("supabase.com") ? { rejectUnauthorized: false } : undefined,
    max: 5,
  };
}

export async function runTestsNotificationWorkerOnce({ now = new Date(), databaseUrl = process.env.DATABASE_URL } = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool(buildPgPoolConfig(databaseUrl));
  const lockClient = await pool.connect();
  try {
    const lockResult = await lockClient.query("select pg_try_advisory_lock($1) as locked", [WORKER_LOCK_KEY]);
    if (!lockResult.rows[0].locked) {
      return { ok: true, skipped: true, reason: "another worker cycle is already running" };
    }
    try {
      const summary = await processTestNotificationCycle({ now, pool });
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
  const result = await runTestsNotificationWorkerOnce({});
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

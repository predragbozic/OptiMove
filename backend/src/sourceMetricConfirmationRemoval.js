// The removal of expired confirmation values (J18, C118;
// docs/ai/c112-drag-mapping-contract.md, sections 5.8 and 15): the two
// athletes' values of a board save leave the live table 90 days after the
// save. The database function removes one bounded batch of whole
// confirmations (training_load.remove_expired_confirmation_values, v65); this
// module is its only caller without an acting user:
//   - removeExpiredBatch(): ONE batch in its own short transaction, bounded in
//     the database and on the client. The board's reads run it first.
//   - runExpiredRemoval(): batch after batch until none is left (a scheduled
//     run).
//   - startConfirmationRemovalSchedule(): the server's timer, every 6 hours.
// It writes no audit row (the function's rows carry the removal themselves),
// logs codes and counts only, and never throws into its caller.
//
// Two server processes cannot remove the same confirmation: the function
// takes each confirmation's row FOR UPDATE SKIP LOCKED, so a second run skips
// what the first holds and takes it only if the first rolled back.
import { pool } from "./db.js";

export const REMOVAL_BATCH = 200;
export const REMOVAL_INTERVAL_HOURS = 6;
// A batch's bounds: its statement and lock waits in the database, and the
// whole step on the client (the connection is closed when it runs out).
const STATEMENT_MS = 2000;
const LOCK_MS = 500;
const BOUND_MS = 4000;
// At most this many batches in one scheduled run (40 000 confirmations).
const MAX_BATCHES_PER_RUN = 200;

// Test seams (never set by the application): a fault before the batch, and
// the client bound.
let fault = null;
let boundMs = BOUND_MS;
export function setRemovalFaultForTests(fn, { boundMs: bound = BOUND_MS } = {}) { fault = fn ?? null; boundMs = fn ? bound : BOUND_MS; }

// One batch. Returns the number of confirmations whose values were removed,
// or null when the batch failed or ran out of time (logged by its code).
export async function removeExpiredBatch({ limit = REMOVAL_BATCH } = {}) {
  let client = null;
  let abandoned = false;
  let timer;
  const close = (destroy) => { const c = client; client = null; if (c) c.release(destroy); };
  const work = (async () => {
    if (fault) await fault();
    const c = await pool.connect();
    if (abandoned) { c.release(true); return null; }
    client = c;
    await c.query("begin");
    await c.query(`set local statement_timeout = ${STATEMENT_MS}`);
    await c.query(`set local lock_timeout = ${LOCK_MS}`);
    const ids = (await c.query(`select training_load.remove_expired_confirmation_values($1) as ids`, [limit])).rows[0].ids;
    await c.query("commit");
    close(false);
    return ids.length;
  })();
  work.catch(() => {});
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("removal bound"), { code: "removal_bound_exceeded" })), boundMs);
    })]);
  } catch (error) {
    abandoned = true;
    close(true); // the connection is closed, so nothing of the batch stays open
    console.error(`[source-metric-board] expired_values_removal_failed (${error?.code ?? error?.name ?? "error"})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// A scheduled run: batches until one removes less than a full batch, fails,
// or the run's cap is reached. One run at a time in this process.
let running = false;
export async function runExpiredRemoval({ limit = REMOVAL_BATCH, maxBatches = MAX_BATCHES_PER_RUN } = {}) {
  if (running) return { skipped: true, removed: 0, batches: 0 };
  running = true;
  let removed = 0;
  let batches = 0;
  try {
    while (batches < maxBatches) {
      const n = await removeExpiredBatch({ limit });
      if (n === null) return { skipped: false, removed, batches, failed: true };
      batches += 1;
      removed += n;
      if (n < limit) break;
    }
    return { skipped: false, removed, batches, failed: false };
  } finally {
    running = false;
  }
}

// In the web server process only (server.js). Never inside the test runner
// and never without a database: it then starts nothing. Timers are unref'd.
export function startConfirmationRemovalSchedule({ intervalHours = REMOVAL_INTERVAL_HOURS, startupDelayMs = 60_000, env = process.env } = {}) {
  // node:test's own marker, the T1 runner's marker (scripts/test-runner.mjs), or no database: nothing is started.
  if (env.NODE_TEST_CONTEXT || env.OPTIMOVE_TEST_RUNNER || !env.DATABASE_URL) return { started: false, stop: () => {} };
  const tick = () => runExpiredRemoval().catch((error) => console.error(`[source-metric-board] expired_values_removal_failed (${error?.code ?? error?.name ?? "error"})`));
  const first = setTimeout(tick, startupDelayMs);
  first.unref();
  const every = setInterval(tick, intervalHours * 3_600_000);
  every.unref();
  return { started: true, stop: () => { clearTimeout(first); clearInterval(every); } };
}

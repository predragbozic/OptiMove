// Purges raw GPEXE snapshots whose retention has expired (30 days after last
// seen for a candidate that was never imported, 90 days after import), and
// prints the retention status. Meant for an external scheduler (a Render Cron
// Job, Windows Task Scheduler), so the purge does not depend on the web
// server process running every day:
//
//   npm --prefix backend run gpexe:retention
//
// Exit code 1 when the purge fails, or when expired snapshots are still
// stored after it — that is the alarm to look at.
import { pathToFileURL } from "node:url";
import { pool } from "./db.js";
import { retentionStatus, runRetention } from "./gpexeImportService.js";

export async function runGpexeRetentionOnce() {
  const run = await runRetention("cli");
  const status = await retentionStatus();
  return { purged: run.purged, status };
}

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    const { purged, status } = await runGpexeRetentionOnce();
    console.log(JSON.stringify({ purged, ...status }, null, 2));
    if (!status.healthy) {
      console.error(`[gpexe] ${status.expiredNotPurged} expired snapshot(s) are still stored.`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[gpexe] retention failed: ${error?.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

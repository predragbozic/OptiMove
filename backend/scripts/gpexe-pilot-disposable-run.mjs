// GPEXE pilot run on a DISPOSABLE database with real saved GPEXE responses.
// Creates optimove_tests_gpexe_pilot_*, and through the real CLI (--apply
// with its guard):
//   1. optionally imports an earlier fetch of the same session
//      (--raw-dir-before, e.g. without drill details),
//   2. imports --raw-dir (created, or supplemented over step 1),
//   3. repeats step 2 and prints the database state before/after it,
// then runs two concurrent imports for a second team and compares them with a
// single import for a third team, and drops the database in every case.
// Never touches OPTIMOVE, monitoring2 or Supabase.
//
//   node --env-file=backend/.env backend/scripts/gpexe-pilot-disposable-run.mjs \
//     --raw-dir <dir> [--raw-dir-before <dir>] --team-session 186942 \
//     --athletes 10442,11176,9241,9697,9231 [--report <file>]
//
// DATABASE_URL is used only to reach the local Postgres server's "postgres"
// database to create and drop the disposable one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "../tests/_gpexe-disposable-db.mjs";
import { main as cliMain, parseArgs, loadGpexeBundle } from "./gpexe-import-pilot.mjs";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { importGpexePlan } from "../src/gpexeImportWriter.js";

const TABLES = {
  connections: `select count(*)::int as c from training_load.metric_source_connections where owner_team_id = $1`,
  definitions: `select count(*)::int as c from training_load.metric_definitions where owner_team_id = $1`,
  events: `select count(*)::int as c from training_load.metric_events where owner_team_id = $1`,
  segments: `select count(*)::int as c from training_load.metric_event_segments s join training_load.metric_events e on e.id = s.event_id where e.owner_team_id = $1`,
  event_participants: `select count(*)::int as c from training_load.metric_event_participants p join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
  source_identities: `select count(*)::int as c from training_load.metric_source_identities si join training_load.metric_source_connections c on c.id = si.source_connection_id where c.owner_team_id = $1`,
  import_batches: `select count(*)::int as c from training_load.metric_import_batches where owner_team_id = $1`,
  occasions: `select count(*)::int as c from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
  metric_values: `select count(*)::int as c from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
  activities: `select count(*)::int as c from training.activities where owner_team_id = $1`,
  activity_participants: `select count(*)::int as c from training.activity_participants ap join training.activities a on a.id = ap.activity_id where a.owner_team_id = $1`,
  activity_components: `select count(*)::int as c from training.activity_components ac join training.activities a on a.id = ac.activity_id where a.owner_team_id = $1`,
};

async function snapshot(client, teamId) {
  const out = {};
  for (const [name, sql] of Object.entries(TABLES)) out[name] = (await client.query(sql, [teamId])).rows[0].c;
  return out;
}

async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.rawDir || !opts.teamSession || !opts.athletes) throw new Error("--raw-dir, --team-session and --athletes are required");
  const gpexeAthleteIds = opts.athletes.split(",").map((s) => s.trim()).filter(Boolean);
  const report = { startedAt: new Date().toISOString() };

  const db = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "pilot" });
  const target = new URL(db.url);
  report.database = { host: target.hostname, port: target.port || "5432", name: db.name, droppedAfterRun: true };
  const admin = new pg.Client({ connectionString: db.url });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpexe-pilot-map-"));
  try {
    await admin.connect();
    const names = gpexeAthleteIds.map((id) => `GPEXE athlete ${id}`);
    const org = await createGpexePilotOrg(admin, { athleteNames: names });
    const athleteMap = Object.fromEntries(gpexeAthleteIds.map((id, i) => [id, org.athleteIds[i]]));
    const mapFile = path.join(tmpDir, "athlete-map.json");
    fs.writeFileSync(mapFile, JSON.stringify(athleteMap));
    const applyArgs = (rawDir) => [
      "--raw-dir", rawDir, "--team-session", opts.teamSession, "--apply", "--database-url", db.url,
      "--owner-team-id", org.teamId, "--performed-by-user-id", org.userId, "--athlete-map", mapFile,
    ];
    const skipSummary = (plan) => {
      const byReason = {};
      for (const skip of plan.metricSkips) {
        const key = `${skip.level}${skip.level === "drill" ? ` ${skip.drillIndex}` : ""} ${skip.metricKey}: ${skip.reason}`;
        byReason[key] = (byReason[key] || 0) + 1;
      }
      return { count: plan.metricSkips.length, byLevelMetricReason: byReason };
    };

    if (opts.rawDirBefore) {
      const earlier = await quietly(() => cliMain(applyArgs(opts.rawDirBefore)));
      report.earlierFetchImport = {
        rawDir: path.basename(opts.rawDirBefore), counts: earlier.summary.counts,
        definitionsCreated: earlier.summary.definitionsCreated.length, missingValues: skipSummary(earlier.plan),
      };
    }

    const first = await quietly(() => cliMain(applyArgs(opts.rawDir)));
    report.plan = {
      event: first.plan.event, thresholdsUsed: first.plan.thresholdsUsed, anomalies: first.plan.anomalies,
      metrics: first.plan.metrics, derivedNotImported: first.plan.derivedNotImported,
      drillDetailsFetched: Object.keys(loadGpexeBundle(opts.rawDir, opts.teamSession).details.drills).sort(),
      missingValues: skipSummary(first.plan),
    };
    report.import = {
      rawDir: path.basename(opts.rawDir), counts: first.summary.counts, definitionsCreated: first.summary.definitionsCreated.length,
      supplemented: first.summary.results.filter((r) => r.outcome === "supplemented").map((r) => ({ externalId: r.externalId, addedMetricKeys: r.addedMetricKeys })),
    };
    report.stateBeforeRepeatImport = await snapshot(admin, org.teamId);

    const second = await quietly(() => cliMain(applyArgs(opts.rawDir)));
    report.repeatImport = { counts: second.summary.counts, importBatchId: second.summary.importBatchId };
    report.stateAfterRepeatImport = await snapshot(admin, org.teamId);
    report.repeatImportChangedNothing = JSON.stringify(report.stateBeforeRepeatImport) === JSON.stringify(report.stateAfterRepeatImport);
    report.occasionChains = (await admin.query(
      `select count(*) filter (where o.superseded_by_occasion_id is not null)::int as superseded,
              count(*) filter (where o.import_conflict_status is not null)::int as flagged,
              count(*) filter (where si.current_occasion_id = o.id)::int as current
       from training_load.metric_measurement_occasions o
       join training_load.metric_source_identities si on si.id = o.source_identity_id
       join training_load.metric_source_connections c on c.id = si.source_connection_id
       where c.owner_team_id = $1`,
      [org.teamId],
    )).rows[0];

    report.storedValues = (await admin.query(
      `select si.source_external_id, d.key, v.value_numeric::float8 as value, v.unit_at_capture as unit, v.aggregation_role, v.coverage, v.is_derived, o.entry_method
       from training_load.metric_source_identities si
       join training_load.metric_source_connections c on c.id = si.source_connection_id
       join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id
       join training_load.metric_values v on v.occasion_id = o.id
       join training_load.metric_definitions d on d.id = v.metric_definition_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       where c.owner_team_id = $1 and p.athlete_id = $2
       order by si.source_external_id, d.key`,
      [org.teamId, athleteMap[gpexeAthleteIds[0]]],
    )).rows;

    // Concurrency on real data: a second team, two imports at the same time.
    const concurrentOrg = await createGpexePilotOrg(admin, { athleteNames: names });
    const concurrentMap = Object.fromEntries(gpexeAthleteIds.map((id, i) => [id, concurrentOrg.athleteIds[i]]));
    const plan = buildGpexeImportPlan(loadGpexeBundle(opts.rawDir, opts.teamSession));
    const runOne = async () => {
      const client = new pg.Client({ connectionString: db.url });
      await client.connect();
      try {
        return await importGpexePlan(client, plan, { ownerTeamId: concurrentOrg.teamId, performedByUserId: concurrentOrg.userId, athleteIdByGpexeId: concurrentMap, batchFilename: "concurrent" });
      } finally {
        await client.end();
      }
    };
    const concurrent = await Promise.all([runOne(), runOne()]);
    const singleOrg = await createGpexePilotOrg(admin, { athleteNames: names });
    const singleClient = new pg.Client({ connectionString: db.url });
    await singleClient.connect();
    try {
      await importGpexePlan(singleClient, plan, {
        ownerTeamId: singleOrg.teamId, performedByUserId: singleOrg.userId,
        athleteIdByGpexeId: Object.fromEntries(gpexeAthleteIds.map((id, i) => [id, singleOrg.athleteIds[i]])), batchFilename: "single",
      });
    } finally {
      await singleClient.end();
    }
    const concurrentState = await snapshot(admin, concurrentOrg.teamId);
    report.concurrentImports = {
      counts: concurrent.map((s) => s.counts),
      state: concurrentState,
      singleImportState: await snapshot(admin, singleOrg.teamId),
    };
    report.concurrentImports.matchesSingleImport = JSON.stringify(concurrentState) === JSON.stringify(report.concurrentImports.singleImportState);
  } finally {
    await admin.end().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await db.drop();
  }
  report.finishedAt = new Date().toISOString();
  const json = JSON.stringify(report, null, 2);
  if (opts.report) fs.writeFileSync(opts.report, json);
  console.log(json);
}

run().catch((error) => {
  console.error(`ERROR: ${error.stack || error.message}`);
  process.exit(1);
});

// GPEXE pilot import CLI.
//
//   Dry run (default) — reads saved GPEXE JSON, prints the import plan.
//   Opens no database connection and creates nothing (no definitions,
//   no connection, no rows):
//     node backend/scripts/gpexe-import-pilot.mjs --raw-dir <dir> --team-session 186942
//
//   Apply — only to a disposable test database in this phase:
//     node backend/scripts/gpexe-import-pilot.mjs --raw-dir <dir> --team-session 186942 --apply \
//       --database-url <url> --owner-team-id <uuid> --performed-by-user-id <uuid> --athlete-map <json>
//
// --apply refuses unless ALL of these hold (see assertDisposableApplyTarget):
//   - the URL is passed explicitly (DATABASE_URL / backend/.env is never read),
//   - host is localhost, database name matches optimove_tests_gpexe_*,
//     and is not OPTIMOVE or monitoring2,
//   - the connected database reports that same name,
//   - it contains the marker table written only by
//     backend/tests/_gpexe-disposable-db.mjs.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { buildGpexeImportPlan, GPEXE_METRIC_SPECS } from "../src/gpexeImportMapper.js";
import { importGpexePlan } from "../src/gpexeImportWriter.js";

const MARKER_TABLE = "public.optimove_disposable_test_database";
const DISPOSABLE_NAME = /^optimove_tests_gpexe_[a-z0-9_]+$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function parseArgs(argv) {
  const opts = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--dry-run") opts.apply = false;
    else if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      opts[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      i += 1;
    } else throw new Error(`unexpected argument ${arg}`);
  }
  if (argv.includes("--apply") && argv.includes("--dry-run")) throw new Error("--apply and --dry-run cannot be combined");
  return opts;
}

// Step 1 (before connecting): only a local, disposable-looking name.
export function describeApplyTarget(databaseUrl) {
  if (!databaseUrl) throw new Error("--apply requires an explicit --database-url");
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("--database-url is not a valid URL");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const target = { host: url.hostname, port: url.port || "5432", database };
  // pg's own connection-string parser lets query parameters (?host=, ?port=,
  // ...) override the host, so any query string is refused outright.
  if (url.search) throw new Error("refusing --apply: --database-url must not carry query parameters");
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error(`refusing --apply: host ${url.hostname} is not local`);
  if (database.toLowerCase() === "optimove" || /monitoring2/i.test(database)) throw new Error(`refusing --apply: ${database} is a persistent database`);
  if (!DISPOSABLE_NAME.test(database)) throw new Error(`refusing --apply: ${database} is not a disposable GPEXE test database (optimove_tests_gpexe_*)`);
  return target;
}

// Step 2 (connected): the server must agree on the name and the database
// must carry the disposable marker.
export async function assertDisposableApplyTarget(client, target) {
  const current = await client.query("select current_database() as db, inet_server_addr()::text as addr, inet_server_port() as port");
  const { db, addr, port } = current.rows[0];
  // null address = Unix socket; otherwise the server must be a loopback address.
  if (addr !== null && !/^(127\.\d+\.\d+\.\d+|::1)(\/\d+)?$/.test(addr)) throw new Error(`refusing --apply: connected server address ${addr} is not local`);
  if (db !== target.database) throw new Error(`refusing --apply: connected to ${db}, expected ${target.database}`);
  target.connectedServer = { address: addr ?? "unix socket", port, database: db };
  const marker = await client.query(`select to_regclass($1) is not null as present`, [MARKER_TABLE]);
  if (!marker.rows[0].present) throw new Error(`refusing --apply: ${target.database} has no ${MARKER_TABLE} marker`);
  const purpose = await client.query(`select 1 from ${MARKER_TABLE} where purpose = 'gpexe-pilot'`);
  if (!purpose.rowCount) throw new Error(`refusing --apply: ${target.database} marker is not for the GPEXE pilot`);
}

export function loadGpexeBundle(rawDir, teamSessionId) {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(rawDir, file), "utf8"));
  const files = fs.readdirSync(rawDir);
  const idOf = (file) => file.match(/\d+/)[0];
  const teamSession = read(`session_${teamSessionId}_detail.json`);
  const thresholdsFile = `team_${teamSession.team}_thresholds_${String(teamSession.start_timestamp).slice(0, 10)}.json`;
  const drillDetails = files
    .map((f) => f.match(new RegExp(`^session_${teamSessionId}_details_drill_index_(\\d+)\\.json$`)))
    .filter(Boolean);
  return {
    teamSession,
    teamThresholds: files.includes(thresholdsFile) ? read(thresholdsFile) : null,
    details: {
      full: files.includes(`session_${teamSessionId}_details_whole.json`) ? read(`session_${teamSessionId}_details_whole.json`) : null,
      drills: Object.fromEntries(drillDetails.map((m) => [m[1], read(m[0])])),
    },
    athleteSessions: files.filter((f) => /^athlete_session_\d+\.json$/.test(f)).map(read),
    more: Object.fromEntries(files.filter((f) => /^athlete_session_\d+_more\.json$/.test(f)).map((f) => [idOf(f), read(f)])),
    tracks: Object.fromEntries(files.filter((f) => /^track_\d+\.json$/.test(f)).map((f) => [idOf(f), read(f)])),
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export function formatPlan(plan) {
  const lines = [];
  lines.push(`Session ${plan.teamSessionId}: ${plan.event.name} (${plan.event.occurredInstant} UTC, ${plan.event.timezone}, local date ${plan.event.occurredLocalDate})`);
  lines.push(`Activity type: ${plan.event.activityTypeKey}; source updated_on: ${plan.event.sourceReportedAt}`);
  lines.push(`Drill segments: ${plan.segments.map((s) => s.label).join(", ") || "none"}`);
  lines.push(`GPEXE team thresholds used: id ${plan.thresholdsUsed.id}, valid ${plan.thresholdsUsed.validityStart} – ${plan.thresholdsUsed.validityEnd ?? "open"}`);
  lines.push("GPEXE metrics imported:");
  for (const m of plan.metrics) lines.push(`  ${m.key} "${m.label}" [${m.unit}, daily ${m.dailyAggregationMethod}, definition ${m.definition}] <- ${JSON.stringify(m.sourceContext)}`);
  lines.push("Derived metrics NOT imported (future OptiMove derived metrics):");
  for (const m of plan.derivedNotImported) lines.push(`  ${m.label} = ${m.formula}`);
  for (const p of plan.participants) {
    lines.push(`Athlete ${p.gpexeAthleteId}:`);
    for (const r of p.results) lines.push(`  ${r.externalId}: ${r.values.map((v) => `${v.metricKey}=${round(v.value)}`).join(" ")}`);
  }
  lines.push(`Anomalies: ${plan.anomalies.length ? "" : "none"}`);
  for (const a of plan.anomalies) lines.push(`  ${a.kind}${a.gpexeAthleteId ? ` athlete ${a.gpexeAthleteId}` : ""}: ${a.detail}`);
  lines.push(`Skipped values: ${plan.metricSkips.length}`);
  for (const s of plan.metricSkips) lines.push(`  ${s.athleteSessionId} ${s.metricKey}: ${s.reason}`);
  return lines.join("\n");
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.rawDir || !opts.teamSession) throw new Error("--raw-dir and --team-session are required");
  const plan = buildGpexeImportPlan(loadGpexeBundle(opts.rawDir, opts.teamSession));
  console.log(formatPlan(plan));
  if (!opts.apply) {
    console.log("\nDry run: no database connection was opened, nothing was written.");
    return { plan };
  }

  const target = describeApplyTarget(opts.databaseUrl);
  if (!opts.ownerTeamId || !opts.performedByUserId || !opts.athleteMap) throw new Error("--apply requires --owner-team-id, --performed-by-user-id and --athlete-map");
  const athleteIdByGpexeId = JSON.parse(fs.readFileSync(opts.athleteMap, "utf8"));
  console.log(`\nApply target: host ${target.host}, port ${target.port}, database ${target.database}`);
  const client = new pg.Client({ connectionString: opts.databaseUrl });
  await client.connect();
  try {
    await assertDisposableApplyTarget(client, target);
    console.log(`Connected server: address ${target.connectedServer.address}, port ${target.connectedServer.port}, database ${target.connectedServer.database}`);
    const summary = await importGpexePlan(client, plan, {
      ownerTeamId: opts.ownerTeamId, performedByUserId: opts.performedByUserId, athleteIdByGpexeId,
      batchFilename: `gpexe team_session ${plan.teamSessionId}`,
    });
    console.log(JSON.stringify({ counts: summary.counts, eventId: summary.eventId, activityId: summary.activityId, definitionsCreated: summary.definitionsCreated }, null, 2));
    return { plan, summary };
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

export { GPEXE_METRIC_SPECS };

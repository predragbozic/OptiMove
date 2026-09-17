// GPEXE pilot import: mapper (pure), writer (disposable database), dashboard
// api_import filter, and the CLI apply guard. Fixtures are synthetic and
// anonymized but keep the exact shape of real GPEXE v6 responses (team 980,
// session 186942): naive UTC timestamps, SI numeric fields, whole-session
// rows with drill=null and drill rows with drill=n, /more/ zones and events,
// team thresholds, details with burst/brake counts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { buildGpexeImportPlan, GPEXE_METRIC_SPECS, GPEXE_DERIVED_NOT_IMPORTED, GpexeMappingError } from "../src/gpexeImportMapper.js";
import { importGpexePlan, importedOccasionContentHash, referenceSetHash, GpexeImportError } from "../src/gpexeImportWriter.js";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import realTeamThresholds from "./fixtures/gpexe-team-thresholds-1473.json" with { type: "json" };
import { describeApplyTarget, assertDisposableApplyTarget, main as cliMain } from "../scripts/gpexe-import-pilot.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

// ------------------------------------------------------------
// Synthetic GPEXE bundle
// ------------------------------------------------------------
const TZ = "Europe/Sarajevo";
const ZONE_BOUNDS = { power: [[null, 20], [20, 25], [25, 60], [60, 75], [75, null]], speed: [[null, 5.5], [5.5, 7], [7, null]] };

function naive(date) {
  return date.toISOString().replace("Z", "");
}

function defaultThresholds(gpexeTeamId) {
  return {
    id: 1473, team: gpexeTeamId, validity_start: "2025-01-01T00:00:00", validity_end: null,
    power_thresholds: [20, 25, 60, 75], speed_thresholds: [5.5, 7],
    acceleration_events_threshold: 2.5, acceleration_events_duration: 0.3,
    deceleration_events_threshold: -2.5, deceleration_events_duration: 0.3,
  };
}

function moreFor(row, { powerZoneDistances, speedZoneDistances, acc, dec, powerBounds = ZONE_BOUNDS.power, accThreshold = 2.5 }) {
  const zones = (bounds, distances) => bounds.map((extremes, i) => ({ extremes, distance: distances[i], is_ready: true, show_distance: true }));
  return {
    track_id: row.track,
    athletesession_id: row.id,
    complementary_data: { power: zones(powerBounds, powerZoneDistances), speed: zones(ZONE_BOUNDS.speed, speedZoneDistances) },
    events: {
      acceleration_events_threshold_value: accThreshold, acceleration_events_duration: 0.3, acceleration_events_count: String(acc),
      deceleration_events_threshold_value: -2.5, deceleration_events_duration: 0.3, deceleration_events_count: String(dec),
    },
  };
}

// parts: [{ drill: null|n, time, distance, maxV, power: [5 zone distances], sprint, acc, dec, burst, brake }]
// details are "fetched" for the whole session and for the drill indexes in detailsDrills.
function makeBundle({
  sessionId = 5001, gpexeTeamId = 77, start = "2026-09-14T18:08:12", updatedOn = "2026-09-14T20:18:09.337", category = "FULL TRAINING",
  drillsCount = 2, athletes, trackTimestampOffsetMs = 0, powerBounds, accThreshold, thresholds, detailsDrills = [0],
}) {
  const athleteSessions = [];
  const more = {};
  const tracks = {};
  const details = { full: { players: {} }, drills: Object.fromEntries(detailsDrills.map((n) => [String(n), { players: {} }])) };
  let nextRowId = sessionId * 100;
  for (const athlete of athletes) {
    for (const trackId of athlete.tracks) {
      const trackStart = new Date(new Date(`${start}Z`).getTime() - 600_000);
      tracks[String(trackId)] = { id: trackId, athlete: athlete.id, timezone: TZ, timestamp: naive(trackStart), utc_timestamp: (trackStart.getTime() + trackTimestampOffsetMs) / 1000 };
    }
    for (const part of athlete.parts) {
      nextRowId += 1;
      const row = {
        id: nextRowId, athlete: athlete.id, track: part.track ?? athlete.tracks[0], teamsession: sessionId, drill: part.drill,
        is_stats_valid: true, total_time: part.time, total_distance: part.distance, max_v: part.maxV,
      };
      athleteSessions.push(row);
      const sprint = part.sprint ?? 0;
      more[String(row.id)] = moreFor(row, { powerZoneDistances: part.power, speedZoneDistances: [part.distance - 8 - sprint, 8, sprint], acc: part.acc, dec: part.dec, powerBounds, accThreshold });
      const target = part.drill === null ? details.full : details.drills[String(part.drill)];
      if (target) target.players[String(athlete.id)] = { tot_burst_events: { unit: "number", value: part.burst ?? 0 }, tot_brake_events: { unit: "number", value: part.brake ?? 0 } };
    }
  }
  return {
    teamSession: {
      id: sessionId, team: gpexeTeamId, category_name: category, is_stats_valid: true, drills_count: drillsCount,
      start_timestamp: start, end_timestamp: "2026-09-14T19:19:35", updated_on: updatedOn,
    },
    athleteSessions, more, tracks, details,
    teamThresholds: thresholds ?? defaultThresholds(gpexeTeamId),
  };
}

function standardAthletes() {
  return [
    {
      id: 101, tracks: [9001],
      parts: [
        { drill: null, time: 2400, distance: 3000, maxV: 7.5, power: [2400, 200, 300, 60, 40], sprint: 12, acc: 20, dec: 18, burst: 9, brake: 7 },
        { drill: 0, time: 1200, distance: 1600, maxV: 7.5, power: [1300, 100, 150, 30, 20], sprint: 12, acc: 12, dec: 8, burst: 5, brake: 4 },
        { drill: 1, time: 1200, distance: 1400, maxV: 6.0, power: [1100, 100, 150, 30, 20], sprint: 0, acc: 8, dec: 10, burst: 4, brake: 3 },
      ],
    },
    {
      id: 102, tracks: [9002],
      parts: [
        { drill: null, time: 1200, distance: 1500, maxV: 6.2, power: [1300, 100, 80, 15, 5], sprint: 0, acc: 6, dec: 7, burst: 2, brake: 2 },
        { drill: 0, time: 1200, distance: 1500, maxV: 6.2, power: [1300, 100, 80, 15, 5], sprint: 0, acc: 6, dec: 7, burst: 2, brake: 2 },
      ],
    },
    {
      // Device restart: two tracks for one athlete in the same session.
      id: 103, tracks: [9003, 9004],
      parts: [
        { drill: null, track: 9003, time: 600, distance: 700, maxV: 5, power: [600, 50, 40, 10, 0], acc: 2, dec: 2 },
        { drill: null, track: 9004, time: 900, distance: 1000, maxV: 5, power: [900, 50, 40, 10, 0], acc: 3, dec: 3 },
      ],
    },
  ];
}

function byExternalId(plan) {
  return new Map(plan.participants.flatMap((p) => p.results.map((r) => [r.externalId, r])));
}
function valueOf(result, key) {
  return result.values.find((v) => v.metricKey === key)?.value;
}
function skipsFor(plan, athleteSessionId) {
  return plan.metricSkips.filter((s) => s.athleteSessionId === athleteSessionId).map((s) => `${s.metricKey}:${s.reason}`).sort();
}

// ------------------------------------------------------------
// Mapper (no database)
// ------------------------------------------------------------
test("mapper: GPEXE source values only, units and conversions, separate full/drill identities, UTC -> local date", () => {
  const plan = buildGpexeImportPlan(makeBundle({ athletes: standardAthletes() }));
  assert.equal(plan.event.occurredInstant, "2026-09-14T18:08:12.000Z");
  assert.equal(plan.event.occurredLocalDate, "2026-09-14");
  assert.equal(plan.event.timezone, TZ);
  assert.equal(plan.event.name, "GPEXE FULL TRAINING 2026-09-14 20:08");
  assert.equal(plan.event.sourceExternalId, "team_session:5001");
  assert.deepEqual(plan.segments.map((s) => [s.drillIndex, s.order]), [[0, 1], [1, 2]]);
  assert.deepEqual(plan.metrics.map((m) => m.key), GPEXE_METRIC_SPECS.map((s) => s.key));
  assert.equal(plan.thresholdsUsed.id, "1473");
  assert.equal(plan.thresholdsUsed.validityStart, "2025-01-01T00:00:00.000Z");
  assert.equal(plan.thresholdsUsed.validityEnd, null);
  assert.deepEqual(plan.thresholdsUsed.payload, {
    power_thresholds: [20, 25, 60, 75], speed_thresholds: [5.5, 7],
    acceleration_events_threshold: 2.5, acceleration_events_duration: 0.3,
    deceleration_events_threshold: -2.5, deceleration_events_duration: 0.3,
  }, "the plan carries the threshold set itself, not only its id");
  const derivedLabels = ["m/min", "Acc+Dec", "Burst&brakes", "HMLD ≥25 W/kg (m)", "EXPDist ≥60 W/kg (m)"];
  assert.deepEqual(plan.derivedNotImported.map((m) => m.label), derivedLabels);
  assert.deepEqual(GPEXE_DERIVED_NOT_IMPORTED.map((m) => m.label), derivedLabels);
  for (const m of plan.metrics) assert.doesNotMatch(m.label, />/, `${m.key}: labels state the inclusive boundary the code applies`);

  const results = byExternalId(plan);
  const full = results.get("athlete_session:500101:full");
  const drill0 = results.get("athlete_session:500102:drill:0");
  assert.ok(full && drill0, "full and drill rows get separate identities");
  assert.equal(full.level, "full");
  assert.equal(drill0.level, "drill");
  assert.equal(drill0.drillIndex, 0);
  assert.equal(valueOf(full, "gpexe_time_min"), 40);
  assert.equal(valueOf(full, "gpexe_total_distance"), 3000);
  // Each GPEXE power zone is its own source value; nothing is summed.
  assert.equal(valueOf(full, "gpexe_power_zone_25_60_distance"), 300, "zone [25,60]");
  assert.equal(valueOf(full, "gpexe_power_zone_60_75_distance"), 60, "zone [60,75]");
  assert.equal(valueOf(full, "gpexe_power_zone_75_plus_distance"), 40, "zone [75,)");
  assert.equal(plan.metrics.find((m) => m.key === "gpexe_power_zone_75_plus_distance").label, "GPEXE zona snage ≥75 W/kg");
  assert.deepEqual(full.values.find((v) => v.metricKey === "gpexe_power_zone_25_60_distance").sourceContext.gpexeZoneExtremes, [25, 60]);
  assert.equal(valueOf(full, "gpexe_acceleration_events"), 20);
  assert.equal(valueOf(full, "gpexe_deceleration_events"), 18);
  assert.equal(valueOf(full, "gpexe_sprint_distance_7mps"), 12, "speed zone [7 m/s,)");
  assert.equal(valueOf(full, "gpexe_burst_events"), 9);
  assert.equal(valueOf(full, "gpexe_brake_events"), 7);
  assert.equal(valueOf(full, "gpexe_max_speed"), 7.5 * 3.6);
  assert.equal(full.values.find((v) => v.metricKey === "gpexe_max_speed").unit, "km/h");
  assert.equal(full.values.find((v) => v.metricKey === "gpexe_sprint_distance_7mps").sourceContext.gpexeThresholdMps, 7);
  const keys = full.values.map((v) => v.metricKey);
  for (const derived of ["gpexe_distance_per_min", "gpexe_acc_dec_count", "gpexe_burst_brake_count", "gpexe_hmld_25", "gpexe_exp_distance_60"]) assert.ok(!keys.includes(derived), `${derived} is never imported`);
  assert.equal(full.values.length, 11);

  const drill1 = results.get("athlete_session:500103:drill:1");
  assert.equal(drill1.values.length, 9, "burst/brake need details for that drill, which were not fetched");
  assert.deepEqual(skipsFor(plan, "500103"), ["gpexe_brake_events:details_not_fetched", "gpexe_burst_events:details_not_fetched"]);
});

test("mapper: an athlete on two tracks is reported and not imported", () => {
  const plan = buildGpexeImportPlan(makeBundle({ athletes: standardAthletes() }));
  assert.deepEqual(plan.participants.map((p) => p.gpexeAthleteId), ["101", "102"]);
  assert.deepEqual(plan.anomalies.map((a) => [a.kind, a.gpexeAthleteId]), [["multiple_tracks", "103"]]);
});

test("mapper: a changed zone boundary, event threshold or team threshold skips that metric instead of importing another meaning", () => {
  const plan = buildGpexeImportPlan(makeBundle({ athletes: standardAthletes().slice(0, 1), powerBounds: [[null, 20], [20, 24], [24, 60], [60, 75], [75, null]], accThreshold: 3 }));
  const full = byExternalId(plan).get("athlete_session:500101:full");
  assert.equal(valueOf(full, "gpexe_power_zone_25_60_distance"), undefined);
  assert.equal(valueOf(full, "gpexe_power_zone_60_75_distance"), 60, "the [60,75] zone is unchanged");
  assert.equal(valueOf(full, "gpexe_acceleration_events"), undefined);
  assert.equal(valueOf(full, "gpexe_deceleration_events"), 18, "deceleration threshold is unchanged");
  assert.deepEqual(skipsFor(plan, "500101"), ["gpexe_acceleration_events:threshold_mismatch", "gpexe_power_zone_25_60_distance:zone_boundary_missing"]);

  const changedTeamThresholds = buildGpexeImportPlan(makeBundle({ athletes: standardAthletes().slice(0, 1), thresholds: { ...defaultThresholds(77), speed_thresholds: [5.5, 6.5], power_thresholds: [20, 24, 60, 75] } }));
  assert.deepEqual(skipsFor(changedTeamThresholds, "500101"), ["gpexe_power_zone_25_60_distance:team_threshold_missing", "gpexe_sprint_distance_7mps:team_threshold_missing"], "the team's own thresholds for that date must contain the boundary");

  const movedUpper = buildGpexeImportPlan(makeBundle({ athletes: standardAthletes().slice(0, 1), powerBounds: [[null, 20], [20, 25], [25, 55], [55, 75], [75, null]] }));
  const movedUpperFull = byExternalId(movedUpper).get("athlete_session:500101:full");
  assert.equal(valueOf(movedUpperFull, "gpexe_power_zone_25_60_distance"), undefined, "a zone GPEXE delimits as [25,55] is not [25,60]");
  assert.equal(valueOf(movedUpperFull, "gpexe_power_zone_75_plus_distance"), 40, "the unchanged [75,) zone is still imported");
  assert.deepEqual(skipsFor(movedUpper, "500101"), ["gpexe_power_zone_25_60_distance:zone_boundary_missing", "gpexe_power_zone_60_75_distance:zone_boundary_missing"]);

  const duplicated = buildGpexeImportPlan(makeBundle({ athletes: standardAthletes().slice(0, 1), powerBounds: [[null, 20], [20, 25], [25, 60], [25, 60], [75, null]] }));
  assert.ok(skipsFor(duplicated, "500101").includes("gpexe_power_zone_25_60_distance:zone_boundary_ambiguous"), "two GPEXE zones with the same extremes are reported, not guessed");

  const splitZone = buildGpexeImportPlan(makeBundle({ athletes: standardAthletes().slice(0, 1), thresholds: { ...defaultThresholds(77), power_thresholds: [20, 25, 50, 60, 75], speed_thresholds: [5.5, 7, 8] } }));
  assert.deepEqual(skipsFor(splitZone, "500101"), ["gpexe_power_zone_25_60_distance:team_threshold_split", "gpexe_sprint_distance_7mps:team_threshold_split"], "a team threshold inside a zone means the zone no longer has that meaning");
});

test("mapper: the snapshot is built from the real captured GPEXE threshold set", () => {
  // backend/tests/fixtures/gpexe-team-thresholds-1473.json is GET
  // team/980/thresholds/?valid_on=2026-09-14 as GPEXE returned it on
  // 2026-09-17, with the "user" field removed. If GPEXE renames a field, this
  // test fails instead of the importer recording an empty provenance.
  const plan = buildGpexeImportPlan(makeBundle({ athletes: standardAthletes().slice(0, 1), gpexeTeamId: realTeamThresholds.team, thresholds: realTeamThresholds }));
  assert.equal(plan.thresholdsUsed.id, String(realTeamThresholds.id));
  assert.equal(plan.thresholdsUsed.validityStart, "2025-01-01T00:00:00.000Z");
  assert.equal(plan.thresholdsUsed.validityEnd, null);
  for (const [key, value] of Object.entries(plan.thresholdsUsed.payload)) {
    const numbers = Array.isArray(value) ? value : [value];
    assert.ok(numbers.length > 0 && numbers.every((n) => typeof n === "number" && Number.isFinite(n)), `${key}: ${JSON.stringify(value)}`);
  }
  assert.deepEqual(plan.thresholdsUsed.payload.power_thresholds, [20, 25, 60, 75]);
  assert.deepEqual(plan.thresholdsUsed.payload.speed_thresholds, [5.5, 7]);
});

test("mapper: a threshold set missing any of the fields the snapshot records is refused", () => {
  const athletes = standardAthletes().slice(0, 1);
  for (const field of ["power_thresholds", "speed_thresholds", "acceleration_events_threshold", "deceleration_events_duration"]) {
    const thresholds = { ...defaultThresholds(77) };
    delete thresholds[field];
    assert.throws(
      () => buildGpexeImportPlan(makeBundle({ athletes, thresholds })),
      (e) => e.code === "thresholds_payload_incomplete" && e.message.includes(field),
      field,
    );
  }
});

test("mapper: team thresholds must belong to the session's team and be valid at the session start", () => {
  const athletes = standardAthletes().slice(0, 1);
  assert.throws(() => buildGpexeImportPlan(makeBundle({ athletes, thresholds: { ...defaultThresholds(77), team: 78 } })), (e) => e.code === "thresholds_wrong_team");
  assert.throws(() => buildGpexeImportPlan(makeBundle({ athletes, thresholds: { ...defaultThresholds(77), validity_start: "2026-09-15T00:00:00" } })), (e) => e.code === "thresholds_not_valid_for_session");
  assert.throws(() => buildGpexeImportPlan(makeBundle({ athletes, thresholds: { ...defaultThresholds(77), validity_end: "2026-09-14T00:00:00" } })), (e) => e.code === "thresholds_not_valid_for_session");
  const bundle = makeBundle({ athletes });
  delete bundle.teamThresholds;
  assert.throws(() => buildGpexeImportPlan(bundle), (e) => e.code === "thresholds_missing");
});

test("mapper: refuses when naive track timestamps stop being UTC, and for unsupported categories", () => {
  assert.throws(() => buildGpexeImportPlan(makeBundle({ athletes: standardAthletes(), trackTimestampOffsetMs: 2 * 3600_000 })), (e) => e instanceof GpexeMappingError && e.code === "timestamp_semantics_changed");
  assert.throws(() => buildGpexeImportPlan(makeBundle({ athletes: standardAthletes(), category: "OFFICIAL MATCH" })), (e) => e instanceof GpexeMappingError && e.code === "unsupported_category");
});

test("mapper: a track without a timezone is refused instead of using the machine's zone", () => {
  const bundle = makeBundle({ athletes: standardAthletes().slice(0, 1) });
  delete bundle.tracks["9001"].timezone;
  assert.throws(() => buildGpexeImportPlan(bundle), (e) => e.code === "invalid_timezone");
});

test("mapper: a session after 22:00 UTC lands on the next local day", () => {
  const plan = buildGpexeImportPlan(makeBundle({ athletes: standardAthletes().slice(0, 1), start: "2026-09-02T22:32:59" }));
  assert.equal(plan.event.occurredLocalDate, "2026-09-03");
});

test("content hash changes when unit, level, aggregation role, coverage or GPEXE threshold change — not only the value", () => {
  const base = { level: "full", drillIndex: null, values: [{ metricKey: "k", metricDefinitionId: "d", metricDefinitionVersionId: "v", value: 1, unit: "m", aggregationRole: "source_rollup", coverage: "complete", sourceContext: { gpexeThresholdMps: 7 } }] };
  const hash = importedOccasionContentHash(base);
  const variants = [
    { ...base, level: "drill", drillIndex: 0 },
    { ...base, values: [{ ...base.values[0], unit: "km" }] },
    { ...base, values: [{ ...base.values[0], aggregationRole: "standalone" }] },
    { ...base, values: [{ ...base.values[0], coverage: "partial" }] },
    { ...base, values: [{ ...base.values[0], sourceContext: { gpexeThresholdMps: 6.5 } }] },
  ];
  for (const variant of variants) assert.notEqual(importedOccasionContentHash(variant), hash);
  assert.equal(importedOccasionContentHash(structuredClone(base)), hash);
});

// ------------------------------------------------------------
// Writer on a disposable database
// ------------------------------------------------------------
let db;
let admin;
let dashboardDbModule = null;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "suite" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  const own = await admin.query("select current_database() as db");
  assert.equal(own.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");
});

after(async () => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  try {
    if (dashboardDbModule) await dashboardDbModule.pool.end();
  } finally {
    if (admin) await admin.end();
    if (db) await db.drop();
  }
});

// App service modules read DATABASE_URL through db.js when first imported,
// so point it at the disposable database before loading any of them.
async function loadAppModule(specifier) {
  if (!dashboardDbModule) {
    process.env.DATABASE_URL = db.url;
    dashboardDbModule = await import("../src/db.js");
  }
  return import(specifier);
}

async function newClient() {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  return client;
}

async function setupTeam() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["Athlete A", "Athlete B", "Athlete C"] });
  return { ...org, athleteMap: { 101: org.athleteIds[0], 102: org.athleteIds[1], 103: org.athleteIds[2] } };
}

function contextFor(org) {
  return { ownerTeamId: org.teamId, performedByUserId: org.userId, athleteIdByGpexeId: org.athleteMap, batchFilename: "test" };
}

async function runImport(org, bundle, hooks) {
  const client = await newClient();
  try {
    return await importGpexePlan(client, buildGpexeImportPlan(bundle), contextFor(org), hooks);
  } finally {
    await client.end();
  }
}

const TEAM_TABLES = {
  connections: `select count(*)::int as c from training_load.metric_source_connections where owner_team_id = $1`,
  definitions: `select count(*)::int as c from training_load.metric_definitions where owner_team_id = $1`,
  definition_versions: `select count(*)::int as c from training_load.metric_definition_versions v join training_load.metric_definitions d on d.id = v.metric_definition_id where d.owner_team_id = $1`,
  scope_capabilities: `select count(*)::int as c from training_load.metric_definition_scope_capabilities sc join training_load.metric_definitions d on d.id = sc.metric_definition_id where d.owner_team_id = $1`,
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
  component_segment_links: `select count(*)::int as c from training.activity_component_metric_segment_links l join training.activity_components ac on ac.id = l.activity_component_id join training.activities a on a.id = ac.activity_id where a.owner_team_id = $1`,
  event_source_bindings: `select count(*)::int as c from training_load.metric_event_source_bindings b join training_load.metric_events e on e.id = b.event_id where e.owner_team_id = $1`,
};

async function snapshot(teamId) {
  const out = {};
  for (const [name, sql] of Object.entries(TEAM_TABLES)) out[name] = (await admin.query(sql, [teamId])).rows[0].c;
  return out;
}

test("writer: first import creates one event, activity, drill components and one current api_import occasion per identity", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ athletes: standardAthletes() }));
  assert.deepEqual(summary.counts, { created: 5 }, "101: full + 2 drills, 102: full + 1 drill; 103 skipped (two tracks)");
  assert.equal(summary.definitionsCreated.length, 11);
  assert.equal(summary.thresholdsUsed.id, "1473");
  assert.equal(summary.bindingCreated, true);

  const state = await snapshot(org.teamId);
  assert.deepEqual(state, {
    connections: 1, definitions: 11, definition_versions: 11, scope_capabilities: 22, events: 1, segments: 2, event_participants: 2,
    source_identities: 6, import_batches: 1, occasions: 5, metric_values: 53, activities: 1, activity_participants: 2,
    activity_components: 2, component_segment_links: 2, event_source_bindings: 1,
  });

  const reserved = (await admin.query(
    `select si.source_external_id, si.current_occasion_id from training_load.metric_source_identities si
     join training_load.metric_source_connections c on c.id = si.source_connection_id
     where c.owner_team_id = $1 and si.source_external_id = 'team_session:5001'`,
    [org.teamId],
  )).rows;
  assert.equal(reserved.length, 1, "the session itself is reserved as an identity");
  assert.equal(reserved[0].current_occasion_id, null, "the reservation never receives an occasion");

  const sprint = (await admin.query(
    `select d.label, v.unit, v.condition_description from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id = d.current_version_id
     where d.owner_team_id = $1 and d.key = 'gpexe_sprint_distance_7mps'`,
    [org.teamId],
  )).rows[0];
  assert.equal(sprint.label, "Sprint distanca ≥25,2 km/h");
  assert.equal(sprint.unit, "m");
  assert.equal(sprint.condition_description.sourceContext.gpexeThresholdMps, 7);
  const burst = (await admin.query(
    `select d.label, v.condition_description from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id = d.current_version_id where d.owner_team_id = $1 and d.key = 'gpexe_burst_events'`,
    [org.teamId],
  )).rows[0];
  assert.equal(burst.label, "GPEXE burst events (definicija nepotvrđena)");
  assert.equal(burst.condition_description.definition, "unconfirmed");

  const activity = (await admin.query(`select origin, activity_type_key, occurred_local_date::text as d, started_at, timezone_snapshot from training.activities where owner_team_id = $1`, [org.teamId])).rows[0];
  assert.equal(activity.origin, "source_import");
  assert.equal(activity.activity_type_key, "training_session");
  assert.equal(activity.d, "2026-09-14");
  assert.equal(activity.started_at.toISOString(), "2026-09-14T18:08:12.000Z");
  assert.equal(activity.timezone_snapshot, TZ);

  const identities = (await admin.query(
    `select si.source_external_id, o.entry_method, o.segment_id is not null as has_segment, o.import_batch_id is not null as has_batch, o.source_reported_at
     from training_load.metric_source_identities si join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id
     join training_load.metric_source_connections c on c.id = si.source_connection_id where c.owner_team_id = $1 order by si.source_external_id`,
    [org.teamId],
  )).rows;
  assert.deepEqual(identities.map((r) => r.source_external_id), [
    "athlete_session:500101:full", "athlete_session:500102:drill:0", "athlete_session:500103:drill:1",
    "athlete_session:500104:full", "athlete_session:500105:drill:0",
  ]);
  for (const r of identities) {
    assert.equal(r.entry_method, "api_import");
    assert.equal(r.has_batch, true);
    assert.equal(r.has_segment, r.source_external_id.includes(":drill:"));
    assert.equal(r.source_reported_at.toISOString(), "2026-09-14T20:18:09.337Z");
  }

  const roles = (await admin.query(
    `select distinct o.segment_id is not null as drill, v.aggregation_role, v.coverage, v.is_derived from training_load.metric_values v
     join training_load.metric_measurement_occasions o on o.id = v.occasion_id join training_load.metric_event_participants p on p.id = o.event_participant_id
     join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1 order by 1`,
    [org.teamId],
  )).rows;
  assert.deepEqual(roles, [
    { drill: false, aggregation_role: "source_rollup", coverage: "complete", is_derived: false },
    { drill: true, aggregation_role: "standalone", coverage: "not_applicable", is_derived: false },
  ]);

  const facts = (await admin.query(
    `select r.detail->>'segmentId' is not null as drill, count(*)::int as c from training.canonical_activity_results($1) r where r.fact_kind = 'metric_value' group by 1 order by 1`,
    [summary.activityId],
  )).rows;
  assert.deepEqual(facts, [{ drill: false, c: 22 }, { drill: true, c: 31 }], "canonical results expose whole-session and drill values separately");
});

test("writer: identical second import writes nothing (state before == after, no new batch)", async () => {
  const org = await setupTeam();
  const bundle = makeBundle({ sessionId: 5002, athletes: standardAthletes() });
  await runImport(org, bundle);
  const before = await snapshot(org.teamId);
  const second = await runImport(org, bundle);
  assert.deepEqual(second.counts, { unchanged: 5 });
  assert.equal(second.importBatchId, null);
  assert.deepEqual(second.definitionsCreated, []);
  assert.equal(second.connectionCreated, false);
  assert.equal(second.eventCreated, false);
  assert.deepEqual(await snapshot(org.teamId), before);
});

test("writer: a newer correction of the whole session supersedes only the :full identity; a drill correction only its :drill identity", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 5003, athletes: standardAthletes() }));

  const fullChanged = standardAthletes();
  fullChanged[0].parts[0].distance = 3100;
  const r1 = await runImport(org, makeBundle({ sessionId: 5003, athletes: fullChanged, updatedOn: "2026-09-15T08:00:00" }));
  assert.equal(r1.results.find((r) => r.externalId === "athlete_session:500301:full").outcome, "corrected");
  assert.deepEqual(r1.counts, { corrected: 1, unchanged: 4 }, "the updated_on bump alone does not rewrite unchanged identities");

  const drillChanged = structuredClone(fullChanged);
  drillChanged[0].parts[2].maxV = 6.5;
  const r2 = await runImport(org, makeBundle({ sessionId: 5003, athletes: drillChanged, updatedOn: "2026-09-16T08:00:00" }));
  assert.equal(r2.results.find((r) => r.externalId === "athlete_session:500303:drill:1").outcome, "corrected");
  assert.deepEqual(r2.counts, { corrected: 1, unchanged: 4 });

  const chains = (await admin.query(
    `select si.source_external_id, count(o.id)::int as occasions, count(o.superseded_by_occasion_id)::int as superseded
     from training_load.metric_source_identities si join training_load.metric_measurement_occasions o on o.source_identity_id = si.id
     join training_load.metric_source_connections c on c.id = si.source_connection_id where c.owner_team_id = $1 group by 1 order by 1`,
    [org.teamId],
  )).rows;
  assert.deepEqual(chains, [
    { source_external_id: "athlete_session:500301:full", occasions: 2, superseded: 1 },
    { source_external_id: "athlete_session:500302:drill:0", occasions: 1, superseded: 0 },
    { source_external_id: "athlete_session:500303:drill:1", occasions: 2, superseded: 1 },
    { source_external_id: "athlete_session:500304:full", occasions: 1, superseded: 0 },
    { source_external_id: "athlete_session:500305:drill:0", occasions: 1, superseded: 0 },
  ]);
  const current = (await admin.query(
    `select v.value_numeric from training_load.metric_source_identities si join training_load.metric_values v on v.occasion_id = si.current_occasion_id
     join training_load.metric_definitions d on d.id = v.metric_definition_id where si.source_external_id = 'athlete_session:500301:full' and d.key = 'gpexe_total_distance' and d.owner_team_id = $1`,
    [org.teamId],
  )).rows;
  assert.equal(Number(current[0].value_numeric), 3100);
});

test("writer: a changed value without a newer updated_on is flagged needs_review once; an older one is stale; current stays unchanged", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 5004, athletes: standardAthletes() }));
  const changed = standardAthletes();
  changed[1].parts[1].acc = 99;

  const sameTime = await runImport(org, makeBundle({ sessionId: 5004, athletes: changed }));
  assert.equal(sameTime.results.find((r) => r.externalId === "athlete_session:500405:drill:0").outcome, "needs_review");
  const again = await runImport(org, makeBundle({ sessionId: 5004, athletes: changed }));
  assert.equal(again.results.find((r) => r.externalId === "athlete_session:500405:drill:0").outcome, "needs_review_already_recorded");

  const older = await runImport(org, makeBundle({ sessionId: 5004, athletes: changed, updatedOn: "2026-09-13T10:00:00" }));
  assert.equal(older.results.find((r) => r.externalId === "athlete_session:500405:drill:0").outcome, "stale_resend_ignored");

  const rows = (await admin.query(
    `select o.import_conflict_status, (si.current_occasion_id = o.id) as is_current from training_load.metric_source_identities si
     join training_load.metric_measurement_occasions o on o.source_identity_id = si.id
     join training_load.metric_source_connections c on c.id = si.source_connection_id
     where c.owner_team_id = $1 and si.source_external_id = 'athlete_session:500405:drill:0' order by o.created_at`,
    [org.teamId],
  )).rows;
  assert.deepEqual(rows, [
    { import_conflict_status: null, is_current: true },
    { import_conflict_status: "needs_review", is_current: false },
    { import_conflict_status: "stale_resend_ignored", is_current: false },
  ]);
});

test("writer: two concurrent imports of the same session serialize on the team lock and leave exactly one copy", async () => {
  const org = await setupTeam();
  const bundle = makeBundle({ sessionId: 5005, athletes: standardAthletes() });
  let signalHeld;
  let release;
  const held = new Promise((resolve) => { signalHeld = resolve; });
  const released = new Promise((resolve) => { release = resolve; });

  const first = runImport(org, bundle, { onLocked: async () => { signalHeld(); await released; } });
  await held;

  const secondClient = await newClient();
  const secondPid = (await secondClient.query("select pg_backend_pid() as pid")).rows[0].pid;
  const second = importGpexePlan(secondClient, buildGpexeImportPlan(bundle), contextFor(org)).finally(() => secondClient.end());

  let waiting = false;
  for (let i = 0; i < 100 && !waiting; i += 1) {
    const r = await admin.query(`select wait_event_type, wait_event from pg_stat_activity where pid = $1`, [secondPid]);
    waiting = r.rows[0]?.wait_event_type === "Lock" && r.rows[0]?.wait_event === "advisory";
    if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(waiting, true, "the second import is blocked on the advisory lock while the first holds it");
  assert.equal((await snapshot(org.teamId)).events, 0, "nothing is visible before the first import commits");

  release();
  const [firstSummary, secondSummary] = await Promise.all([first, second]);
  assert.deepEqual(firstSummary.counts, { created: 5 });
  assert.deepEqual(secondSummary.counts, { unchanged: 5 });
  const state = await snapshot(org.teamId);
  assert.deepEqual(
    [state.connections, state.definitions, state.events, state.source_identities, state.occasions, state.import_batches, state.activities, state.activity_components],
    [1, 11, 1, 6, 5, 1, 1, 2],
  );
  assert.equal(state.event_source_bindings, 1, "one binding, whichever import created the event");
});

test("writer: three concurrent first imports without any test hook also end with one copy", async () => {
  const org = await setupTeam();
  const bundle = makeBundle({ sessionId: 5006, athletes: standardAthletes() });
  const summaries = await Promise.all([runImport(org, bundle), runImport(org, bundle), runImport(org, bundle)]);
  const outcomes = summaries.map((s) => JSON.stringify(s.counts)).sort();
  assert.deepEqual(outcomes, [JSON.stringify({ created: 5 }), JSON.stringify({ unchanged: 5 }), JSON.stringify({ unchanged: 5 })]);
  const state = await snapshot(org.teamId);
  assert.deepEqual([state.connections, state.definitions, state.events, state.source_identities, state.occasions, state.activities], [1, 11, 1, 6, 5, 1]);
  assert.equal(state.event_source_bindings, 1);
});

test("writer: an athlete without an active membership in the team stops the import with zero writes", async () => {
  const org = await setupTeam();
  await admin.query(`update public.athlete_memberships set status = 'archived' where athlete_id = $1`, [org.athleteIds[1]]);
  await assert.rejects(runImport(org, makeBundle({ sessionId: 5007, athletes: standardAthletes() })), (e) => e instanceof GpexeImportError && e.code === "athlete_not_in_team");
  const state = await snapshot(org.teamId);
  assert.ok(Object.values(state).every((c) => c === 0), JSON.stringify(state));
});

test("writer: an existing definition whose GPEXE source context changed stops the import", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 5010, athletes: standardAthletes() }));
  const plan = buildGpexeImportPlan(makeBundle({ sessionId: 5011, athletes: standardAthletes() }));
  plan.metrics = plan.metrics.map((m) => (m.key === "gpexe_sprint_distance_7mps" ? { ...m, sourceContext: { ...m.sourceContext, gpexeThresholdMps: 6.5 } } : m));
  const client = await newClient();
  try {
    await assert.rejects(importGpexePlan(client, plan, contextFor(org)), (e) => e.code === "metric_definition_mismatch");
  } finally {
    await client.end();
  }
  assert.equal((await snapshot(org.teamId)).events, 1, "the rejected session wrote nothing");
});

async function currentValuesOf(org, externalId) {
  const rows = (await admin.query(
    `select d.key, v.value_numeric::float8 as value from training_load.metric_source_identities si
     join training_load.metric_source_connections c on c.id = si.source_connection_id
     join training_load.metric_values v on v.occasion_id = si.current_occasion_id
     join training_load.metric_definitions d on d.id = v.metric_definition_id
     where c.owner_team_id = $1 and si.source_external_id = $2 order by d.key`,
    [org.teamId, externalId],
  )).rows;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function occasionChain(org, externalId) {
  return (await admin.query(
    `select o.import_conflict_status, o.supersedes_occasion_id is not null as supersedes, o.superseded_by_occasion_id is not null as superseded, (si.current_occasion_id = o.id) as is_current,
            (select count(*)::int from training_load.metric_values v where v.occasion_id = o.id) as values
     from training_load.metric_source_identities si
     join training_load.metric_source_connections c on c.id = si.source_connection_id
     join training_load.metric_measurement_occasions o on o.source_identity_id = si.id
     where c.owner_team_id = $1 and si.source_external_id = $2 order by o.created_at, o.id`,
    [org.teamId, externalId],
  )).rows;
}

// Drill 1 with values whose shortest decimal form has 17 digits, as real
// GPEXE data does (1397 s -> 23.283333333333335 min, 7.53 m/s -> 27.108000000000004 km/h).
function athletesWithLongDecimals() {
  const athletes = standardAthletes();
  Object.assign(athletes[0].parts[2], { time: 1397, maxV: 7.53 });
  return athletes;
}

test("writer: drill burst/brake fetched later are supplemented into the current result, even with the same updated_on", async () => {
  const org = await setupTeam();
  const drill1 = "athlete_session:501203:drill:1";
  const first = await runImport(org, makeBundle({ sessionId: 5012, athletes: athletesWithLongDecimals(), detailsDrills: [0] }));
  assert.equal(first.results.find((r) => r.externalId === drill1).outcome, "created");
  assert.equal((await currentValuesOf(org, drill1)).gpexe_burst_events, undefined, "drill 1 details were not fetched yet");

  // Same GPEXE session (same updated_on); details for drill 1 fetched afterwards.
  const withDrill1Details = await runImport(org, makeBundle({ sessionId: 5012, athletes: athletesWithLongDecimals(), detailsDrills: [0, 1] }));
  const supplemented = withDrill1Details.results.find((r) => r.externalId === drill1);
  assert.equal(supplemented.outcome, "supplemented");
  assert.deepEqual(supplemented.addedMetricKeys, ["gpexe_brake_events", "gpexe_burst_events"]);
  assert.deepEqual(withDrill1Details.counts, { supplemented: 1, unchanged: 4 });

  const current = await currentValuesOf(org, drill1);
  assert.equal(current.gpexe_burst_events, 4);
  assert.equal(current.gpexe_brake_events, 3);
  assert.equal(current.gpexe_total_distance, 1400, "values that were already imported are carried over unchanged");
  assert.equal(current.gpexe_time_min, 1397 / 60);
  assert.equal(current.gpexe_max_speed, 7.53 * 3.6);
  assert.equal(Object.keys(current).length, 11);
  assert.deepEqual(await occasionChain(org, drill1), [
    { import_conflict_status: null, supersedes: false, superseded: true, is_current: false, values: 9 },
    { import_conflict_status: null, supersedes: true, superseded: false, is_current: true, values: 11 },
  ]);
  const facts = (await admin.query(
    `select count(*)::int as c from training.canonical_activity_results($1) r where r.fact_kind = 'metric_value' and r.detail->>'segmentId' is not null`,
    [first.activityId],
  )).rows[0].c;
  assert.equal(facts, 33, "the canonical layer now sees 11 values for each of the three drill results");

  const before = await snapshot(org.teamId);
  const again = await runImport(org, makeBundle({ sessionId: 5012, athletes: athletesWithLongDecimals(), detailsDrills: [0, 1] }));
  assert.deepEqual(again.counts, { unchanged: 5 }, "a repeated supplement writes nothing");
  assert.deepEqual(await snapshot(org.teamId), before);
});

test("writer: added metrics with a newer updated_on are also supplemented", async () => {
  const org = await setupTeam();
  const drill1 = "athlete_session:502003:drill:1";
  await runImport(org, makeBundle({ sessionId: 5020, athletes: standardAthletes(), detailsDrills: [0] }));
  const newer = await runImport(org, makeBundle({ sessionId: 5020, athletes: standardAthletes(), detailsDrills: [0, 1], updatedOn: "2026-09-15T08:00:00" }));
  const result = newer.results.find((r) => r.externalId === drill1);
  assert.equal(result.outcome, "supplemented");
  assert.deepEqual(result.addedMetricKeys, ["gpexe_brake_events", "gpexe_burst_events"]);
  const reportedAt = (await admin.query(
    `select o.source_reported_at from training_load.metric_source_identities si join training_load.metric_source_connections c on c.id = si.source_connection_id
     join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id where c.owner_team_id = $1 and si.source_external_id = $2`,
    [org.teamId, drill1],
  )).rows[0].source_reported_at;
  assert.equal(reportedAt.toISOString(), "2026-09-15T08:00:00.000Z");
});

test("writer: drill details fetched later never supersede a manual correction of that drill, even with identical values", async () => {
  const org = await setupTeam();
  const drill1 = "athlete_session:501903:drill:1";
  await runImport(org, makeBundle({ sessionId: 5019, athletes: standardAthletes(), detailsDrills: [0] }));
  const identity = (await admin.query(
    `select si.id, si.current_occasion_id from training_load.metric_source_identities si join training_load.metric_source_connections c on c.id = si.source_connection_id
     where c.owner_team_id = $1 and si.source_external_id = $2`,
    [org.teamId, drill1],
  )).rows[0];
  const values = (await admin.query(
    `select metric_definition_id, metric_definition_version_id, value_numeric::float8 as value from training_load.metric_values where occasion_id = $1`,
    [identity.current_occasion_id],
  )).rows.map((v) => ({ metricDefinitionId: v.metric_definition_id, metricDefinitionVersionId: v.metric_definition_version_id, value: v.value }));

  const { correctImportedOccasionManually } = await loadAppModule("../src/trainingLoadMetricsMeasurements.js");
  const req = { user: { id: org.userId }, authz: { platformRoles: [], clubRoles: [], teamRoles: [{ role: "team_coach", teamId: org.teamId }], managedTeamIds: [] } };
  const scope = { type: "team", teamId: org.teamId, ownerContext: { ownerScope: "team", ownerTeamId: org.teamId, ownerClubId: null, ownerUserId: null } };
  const manual = await correctImportedOccasionManually(req, scope, { requestKey: `manual-drill-${org.teamId}`, sourceIdentityId: identity.id, expectedCurrentOccasionId: identity.current_occasion_id, values });
  assert.equal(manual.error, undefined, JSON.stringify(manual));

  const withDetails = await runImport(org, makeBundle({ sessionId: 5019, athletes: standardAthletes(), detailsDrills: [0, 1] }));
  assert.equal(withDetails.results.find((r) => r.externalId === drill1).outcome, "stale_resend_ignored");
  const current = (await admin.query(`select o.entry_method from training_load.metric_source_identities si join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id where si.id = $1`, [identity.id])).rows[0];
  assert.equal(current.entry_method, "manual", "the manual correction stays current");
  assert.equal((await currentValuesOf(org, drill1)).gpexe_burst_events, undefined);
});

test("writer: a supplement that also changes, drops or predates existing values is not applied automatically", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 5018, athletes: standardAthletes(), detailsDrills: [0] }));
  const drill1 = "athlete_session:501803:drill:1";

  const changedToo = standardAthletes();
  changedToo[0].parts[2].distance = 1450;
  const changed = await runImport(org, makeBundle({ sessionId: 5018, athletes: changedToo, detailsDrills: [0, 1] }));
  assert.equal(changed.results.find((r) => r.externalId === drill1).outcome, "needs_review", "added metrics plus a changed value");

  const older = await runImport(org, makeBundle({ sessionId: 5018, athletes: standardAthletes(), detailsDrills: [0, 1], updatedOn: "2026-09-13T10:00:00" }));
  assert.equal(older.results.find((r) => r.externalId === drill1).outcome, "needs_review", "added metrics from an older GPEXE version");

  const dropped = await runImport(org, makeBundle({ sessionId: 5018, athletes: standardAthletes(), detailsDrills: [] }));
  assert.equal(dropped.results.find((r) => r.externalId === "athlete_session:501802:drill:0").outcome, "needs_review", "burst/brake missing from a later fetch are not removed");

  assert.equal((await currentValuesOf(org, drill1)).gpexe_burst_events, undefined, "the current drill 1 result is unchanged");
  assert.equal((await currentValuesOf(org, "athlete_session:501802:drill:0")).gpexe_burst_events, 5, "drill 0 keeps its burst value");
});

test("writer: a manual correction as current makes a newer GPEXE resend stale_resend_ignored", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 5013, athletes: standardAthletes() }));
  const identity = (await admin.query(
    `select si.id, si.current_occasion_id from training_load.metric_source_identities si join training_load.metric_source_connections c on c.id = si.source_connection_id
     where c.owner_team_id = $1 and si.source_external_id = 'athlete_session:501301:full'`,
    [org.teamId],
  )).rows[0];
  const values = (await admin.query(
    `select metric_definition_id, metric_definition_version_id, value_numeric::float8 as value from training_load.metric_values where occasion_id = $1`,
    [identity.current_occasion_id],
  )).rows.map((v) => ({ metricDefinitionId: v.metric_definition_id, metricDefinitionVersionId: v.metric_definition_version_id, value: v.value }));

  const { correctImportedOccasionManually } = await loadAppModule("../src/trainingLoadMetricsMeasurements.js");
  const req = { user: { id: org.userId }, authz: { platformRoles: [], clubRoles: [], teamRoles: [{ role: "team_coach", teamId: org.teamId }], managedTeamIds: [] } };
  const scope = { type: "team", teamId: org.teamId, ownerContext: { ownerScope: "team", ownerTeamId: org.teamId, ownerClubId: null, ownerUserId: null } };
  const manual = await correctImportedOccasionManually(req, scope, { requestKey: `manual-${org.teamId}`, sourceIdentityId: identity.id, expectedCurrentOccasionId: identity.current_occasion_id, values });
  assert.equal(manual.error, undefined, JSON.stringify(manual));

  const changed = standardAthletes();
  changed[0].parts[0].distance = 3200;
  const resend = await runImport(org, makeBundle({ sessionId: 5013, athletes: changed, updatedOn: "2026-09-15T08:00:00" }));
  assert.equal(resend.results.find((r) => r.externalId === "athlete_session:501301:full").outcome, "stale_resend_ignored");
  const current = (await admin.query(`select o.entry_method from training_load.metric_source_identities si join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id where si.id = $1`, [identity.id])).rows[0];
  assert.equal(current.entry_method, "manual", "the manual correction stays current");
});

test("writer: a re-import that no longer contains a previously imported result stops with zero writes", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 5014, athletes: standardAthletes() }));
  const before = await snapshot(org.teamId);
  const secondTrack = standardAthletes();
  secondTrack[1].tracks = [9002, 9005];
  secondTrack[1].parts[1].track = 9005;
  await assert.rejects(
    runImport(org, makeBundle({ sessionId: 5014, athletes: secondTrack, updatedOn: "2026-09-15T08:00:00" })),
    (e) => e.code === "identities_missing_from_source" && JSON.stringify(e.missingExternalIds) === JSON.stringify(["athlete_session:501404:full", "athlete_session:501405:drill:0"]),
  );
  assert.deepEqual(await snapshot(org.teamId), before);
});

test("writer: a re-import holding the event does not deadlock with a manual correction path locking another identity and then the event", async () => {
  const org = await setupTeam();
  const first = await runImport(org, makeBundle({ sessionId: 5015, athletes: standardAthletes() }));
  const changed = standardAthletes();
  changed[0].parts[0].distance = 3300;

  // Pause the import right after its first result (athlete_session:501501:full,
  // a correction) is written: at that point it already holds the event row
  // lock taken by the occasion insert trigger.
  let signalPaused;
  let resume;
  const paused = new Promise((resolve) => { signalPaused = resolve; });
  const resumed = new Promise((resolve) => { resume = resolve; });
  const reimport = runImport(org, makeBundle({ sessionId: 5015, athletes: changed, updatedOn: "2026-09-15T08:00:00" }), {
    onResultImported: async (result) => {
      if (result.externalId === "athlete_session:501501:full") {
        signalPaused();
        await resumed;
      }
    },
  }).then((summary) => ({ summary }), (error) => ({ error }));
  await paused;

  // Same lock order as correctImportedOccasionManually: one identity, then the event.
  const manual = await newClient();
  try {
    await manual.query("begin");
    const identityLock = manual.query(
      `select si.id from training_load.metric_source_identities si join training_load.metric_source_connections c on c.id = si.source_connection_id
       where c.owner_team_id = $1 and si.source_external_id = 'athlete_session:501502:drill:0' for update`,
      [org.teamId],
    ).then(() => ({ ok: true }), (error) => ({ error }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    resume();
    const identityResult = await identityLock;
    assert.equal(identityResult.error, undefined, String(identityResult.error));
    const eventLock = await manual.query(`select 1 from training_load.metric_events where id = $1 for update`, [first.eventId]).then(() => ({ ok: true }), (error) => ({ error }));
    assert.equal(eventLock.error?.code, undefined, "manual path must not hit a deadlock");
    await manual.query("commit");
  } finally {
    await manual.end();
  }
  const outcome = await reimport;
  assert.equal(outcome.error?.code, undefined, `import must not hit a deadlock: ${outcome.error?.message}`);
  assert.equal(outcome.summary.results.find((r) => r.externalId === "athlete_session:501501:full").outcome, "corrected");
});

test("writer: an import racing a catalog archive of its definition waits and then refuses, never writing under the archived definition", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 5016, athletes: standardAthletes() }));
  const definitionId = (await admin.query(`select id from training_load.metric_definitions where owner_team_id = $1 and key = 'gpexe_total_distance'`, [org.teamId])).rows[0].id;
  const { archiveDefinition } = await loadAppModule("../src/trainingLoadMetricsCatalog.js");
  const req = { user: { id: org.userId }, authz: { platformRoles: [], clubRoles: [], teamRoles: [{ role: "team_coach", teamId: org.teamId }], managedTeamIds: [org.teamId] } };

  let signalLocked;
  let releaseArchive;
  const archiveHoldsLock = new Promise((resolve) => { signalLocked = resolve; });
  const archiveMayCommit = new Promise((resolve) => { releaseArchive = resolve; });
  const archive = archiveDefinition(req, definitionId, { onLocked: async () => { signalLocked(); await archiveMayCommit; } });
  await archiveHoldsLock;

  const importClient = await newClient();
  const importPid = (await importClient.query("select pg_backend_pid() as pid")).rows[0].pid;
  const reimport = importGpexePlan(importClient, buildGpexeImportPlan(makeBundle({ sessionId: 5017, athletes: standardAthletes() })), contextFor(org))
    .then((summary) => ({ summary }), (error) => ({ error }))
    .finally(() => importClient.end());
  let waiting = false;
  for (let i = 0; i < 100 && !waiting; i += 1) {
    const r = await admin.query(`select wait_event_type from pg_stat_activity where pid = $1`, [importPid]);
    waiting = r.rows[0]?.wait_event_type === "Lock";
    if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(waiting, true, "the import waits for the definition row the archive holds");
  releaseArchive();
  const archived = await archive;
  assert.equal(archived.row?.state, "archived", JSON.stringify(archived));

  const outcome = await reimport;
  assert.equal(outcome.error?.code, "metric_definition_mismatch", JSON.stringify(outcome.summary?.counts ?? outcome.error?.message));
  assert.equal((await snapshot(org.teamId)).events, 1, "the second session was not written");
});

test("writer: the event binding stores which GPEXE threshold set produced the session", async () => {
  const org = await setupTeam();
  const bundle = makeBundle({ sessionId: 5021, athletes: standardAthletes() });
  const summary = await runImport(org, bundle);
  const binding = (await admin.query(
    `select b.event_id, b.source_external_id, b.reference_set_external_id, b.reference_valid_from, b.reference_valid_to, b.reference_payload, b.reference_hash, b.created_by_user_id
     from training_load.metric_event_source_bindings b join training_load.metric_events e on e.id = b.event_id where e.owner_team_id = $1`,
    [org.teamId],
  )).rows;
  assert.equal(binding.length, 1);
  assert.equal(String(binding[0].event_id), String(summary.eventId));
  assert.equal(binding[0].source_external_id, "team_session:5021");
  assert.equal(binding[0].reference_set_external_id, "1473");
  assert.equal(binding[0].reference_valid_from.toISOString(), "2025-01-01T00:00:00.000Z");
  assert.equal(binding[0].reference_valid_to, null, "an open-ended set stays open-ended");
  assert.deepEqual(binding[0].reference_payload.power_thresholds, [20, 25, 60, 75]);
  assert.equal(binding[0].reference_payload.acceleration_events_duration, 0.3);
  assert.equal(binding[0].reference_hash, referenceSetHash(buildGpexeImportPlan(bundle).thresholdsUsed));
  // The same set serialized differently by GPEXE (numeric strings) is the same set.
  const restated = defaultThresholds(77);
  const asStrings = {
    ...restated,
    power_thresholds: restated.power_thresholds.map(String),
    speed_thresholds: restated.speed_thresholds.map(String),
    acceleration_events_duration: String(restated.acceleration_events_duration),
  };
  assert.equal(
    referenceSetHash(buildGpexeImportPlan(makeBundle({ sessionId: 5021, athletes: standardAthletes(), thresholds: asStrings })).thresholdsUsed),
    binding[0].reference_hash,
    "a re-serialized set must not read as a changed set",
  );
  assert.equal(String(binding[0].created_by_user_id), String(org.userId));

  // The binding is a record of what the source reported: it cannot be rewritten.
  await assert.rejects(
    admin.query(`update training_load.metric_event_source_bindings set reference_hash = 'x' where event_id = $1`, [summary.eventId]),
    /immutable/,
  );
  // Nor can a binding describe an event it does not belong to.
  const otherOrg = await setupTeam();
  const otherSummary = await runImport(otherOrg, makeBundle({ sessionId: 5022, athletes: standardAthletes() }));
  await assert.rejects(
    admin.query(
      `insert into training_load.metric_event_source_bindings (event_id, source_connection_id, source_external_id)
       select $1, source_connection_id, 'team_session:9999' from training_load.metric_events where id = $1`,
      [otherSummary.eventId],
    ),
    /does not match event/,
  );
});

test("writer: a re-import under a different GPEXE threshold set stops instead of restating what stored values mean", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 5023, athletes: standardAthletes() }));
  const before = await snapshot(org.teamId);

  // The thresholds themselves changed under the same set id: what the stored
  // values mean is no longer certain, so the import stops.
  const changedSet = { ...defaultThresholds(77), power_thresholds: [20, 25, 55, 75] };
  await assert.rejects(
    runImport(org, makeBundle({ sessionId: 5023, athletes: standardAthletes(), thresholds: changedSet, updatedOn: "2026-09-15T08:00:00" })),
    (e) => e.code === "source_reference_set_changed" && e.storedReferenceSet.externalId === "1473" && e.incomingReferenceSet.hash !== e.storedReferenceSet.hash,
  );
  assert.deepEqual(await snapshot(org.teamId), before, "a changed threshold set writes nothing at all");

  // A different set id with the same thresholds is also a stop: which set was
  // in force is part of the provenance.
  await assert.rejects(
    runImport(org, makeBundle({ sessionId: 5023, athletes: standardAthletes(), thresholds: { ...defaultThresholds(77), id: 1600 } })),
    (e) => e.code === "source_reference_set_changed",
  );

  // GPEXE closing the validity window when a successor set appears changes no
  // value's meaning, so the re-import continues and reports the difference.
  const closedWindow = await runImport(org, makeBundle({ sessionId: 5023, athletes: standardAthletes(), thresholds: { ...defaultThresholds(77), validity_end: "2027-01-01T00:00:00" } }));
  assert.deepEqual(closedWindow.counts, { unchanged: 5 });
  assert.equal(closedWindow.referenceSetWindowChanged, true);
  assert.equal(closedWindow.boundReferenceSet.validTo, null, "the summary reports the recorded window, not the incoming one");
  assert.equal(closedWindow.boundReferenceSet.hashVersion, 1);
  const storedWindow = (await admin.query(
    `select b.reference_valid_to from training_load.metric_event_source_bindings b join training_load.metric_events e on e.id = b.event_id where e.owner_team_id = $1`,
    [org.teamId],
  )).rows[0].reference_valid_to;
  assert.equal(storedWindow, null, "the recorded window stays what it was at import time");

  // An unchanged set still re-imports as usual.
  const again = await runImport(org, makeBundle({ sessionId: 5023, athletes: standardAthletes() }));
  assert.deepEqual(again.counts, { unchanged: 5 });
  assert.equal(again.referenceSetWindowChanged, false);
});

test("writer: a failure after the event leaves no reservation and no binding behind", async () => {
  const org = await setupTeam();
  // The reservation identity, the event and its binding are all written
  // before the first result. A failure at that point must take every one of
  // them back with the transaction.
  await assert.rejects(
    runImport(org, makeBundle({ sessionId: 5026, athletes: standardAthletes() }), {
      onResultImported: async () => { throw new Error("import interrupted after the first result"); },
    }),
    /import interrupted/,
  );
  const state = await snapshot(org.teamId);
  assert.ok(Object.values(state).every((c) => c === 0), JSON.stringify(state));
  const reservations = (await admin.query(
    `select count(*)::int as c from training_load.metric_source_identities si
     join training_load.metric_source_connections c on c.id = si.source_connection_id where c.owner_team_id = $1`,
    [org.teamId],
  )).rows[0].c;
  assert.equal(reservations, 0, "no reservation survives a rolled-back import");

  // The same session imports normally afterwards.
  const retry = await runImport(org, makeBundle({ sessionId: 5026, athletes: standardAthletes() }));
  assert.deepEqual(retry.counts, { created: 5 });
  assert.equal(retry.bindingCreated, true);
});

test("database: one active gpexe connection per team, other systems and inactive rows untouched", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 5024, athletes: standardAthletes() }));
  const other = await setupTeam();

  await assert.rejects(
    admin.query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1)`, [org.teamId]),
    (e) => e.code === "23505",
    "a second ACTIVE gpexe connection for the same team is refused by the database",
  );
  await assert.doesNotReject(
    admin.query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id, state) values ('gpexe','team',$1,'inactive')`, [org.teamId]),
    "an inactive one is still allowed",
  );
  await assert.doesNotReject(
    admin.query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1)`, [other.teamId]),
    "another team is unaffected",
  );
  // v11 deliberately allows several connections of the same system per owner;
  // only gpexe is narrowed (the dashboard suite relies on the generic rule).
  await assert.doesNotReject((async () => {
    await admin.query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('test-import','team',$1)`, [org.teamId]);
    await admin.query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('test-import','team',$1)`, [org.teamId]);
  })());
});

test("database: two concurrent transactions cannot both create an active gpexe connection for one team", async () => {
  const org = await setupTeam();
  const a = await newClient();
  const b = await newClient();
  try {
    await a.query("begin");
    await b.query("begin");
    await a.query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1)`, [org.teamId]);
    // A pg client runs one query at a time, so the second connection's pid has
    // to be read BEFORE its insert starts waiting.
    const pid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
    // The second transaction blocks on the unique index until the first one
    // commits, then fails — no advisory lock involved.
    const second = b.query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1)`, [org.teamId])
      .then(() => ({ ok: true }), (error) => ({ error }));
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i += 1) {
      const r = await admin.query(`select wait_event_type from pg_stat_activity where pid = $1`, [pid]);
      waiting = r.rows[0]?.wait_event_type === "Lock";
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(waiting, true, "the second insert waits on the index, it does not proceed");
    await a.query("commit");
    const result = await second;
    assert.equal(result.error?.code, "23505", "the loser of the race is refused by the database");
    await b.query("rollback");
  } finally {
    await a.end();
    await b.end();
  }
  const active = (await admin.query(
    `select count(*)::int as c from training_load.metric_source_connections where owner_team_id = $1 and source_system = 'gpexe' and state = 'active'`,
    [org.teamId],
  )).rows[0].c;
  assert.equal(active, 1);
});

test("database: a second event row for the same gpexe connection and team_session is refused outright", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 5025, athletes: standardAthletes() }));
  const connectionId = summary.connectionId;
  const insertEvent = (externalId, connection) => admin.query(
    `insert into training_load.metric_events
       (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_team_id, source_connection_id, source_external_id, event_timezone_snapshot)
     values ('rogue','2026-09-14','2026-09-14T18:08:12Z','session','team',$1,$2,$3,$4) returning id`,
    [org.teamId, connection, externalId, TZ],
  );

  // A writer that skips the advisory lock cannot create the duplicate at all.
  await assert.rejects(insertEvent("team_session:5025", connectionId), (e) => e.code === "23505");
  // Another GPEXE session on the same connection is unaffected.
  const other = await insertEvent("team_session:5025b", connectionId);
  assert.ok(other.rows[0].id);
  // And the generic v12 contract still holds for every other source system:
  // two events with the same external id on a non-gpexe connection are fine.
  const generic = (await admin.query(
    `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('test-import','team',$1) returning id`,
    [org.teamId],
  )).rows[0].id;
  await assert.doesNotReject((async () => {
    await insertEvent("team_session:5025", generic);
    await insertEvent("team_session:5025", generic);
  })());
});

test("database: an event cannot be moved onto an external id the same gpexe connection already uses", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 5029, athletes: standardAthletes() }));
  const second = (await admin.query(
    `insert into training_load.metric_events
       (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_team_id, source_connection_id, source_external_id, event_timezone_snapshot)
     values ('another session','2026-09-15','2026-09-15T18:08:12Z','session','team',$1,$2,'team_session:5029b',$3) returning id`,
    [org.teamId, summary.connectionId, TZ],
  )).rows[0].id;
  // v12 leaves source_external_id mutable, so the guard has to cover UPDATE.
  await assert.rejects(
    admin.query(`update training_load.metric_events set source_external_id = 'team_session:5029' where id = $1`, [second]),
    (e) => e.code === "23505",
  );
  // Moving it to a free id is still allowed, and a no-op update of the row
  // itself must not report a conflict with itself.
  await assert.doesNotReject(admin.query(`update training_load.metric_events set source_external_id = 'team_session:5029c' where id = $1`, [second]));
  await assert.doesNotReject(admin.query(`update training_load.metric_events set source_external_id = 'team_session:5029c' where id = $1`, [second]));
});

test("writer: a binding written under an older hash rule is reported as such, not as a changed threshold set", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 5030, athletes: standardAthletes() }));
  // Simulate a row written by an earlier version of the hash rule. The stored
  // hash then says nothing about whether the source changed.
  await admin.query(`alter table training_load.metric_event_source_bindings disable trigger metric_event_source_bindings_immutable`);
  await admin.query(`update training_load.metric_event_source_bindings set reference_hash_version = 0 where event_id = $1`, [summary.eventId]);
  await admin.query(`alter table training_load.metric_event_source_bindings enable trigger metric_event_source_bindings_immutable`);
  const before = await snapshot(org.teamId);
  await assert.rejects(
    runImport(org, makeBundle({ sessionId: 5030, athletes: standardAthletes() })),
    (e) => e.code === "reference_hash_version_outdated" && e.storedReferenceSet.hashVersion === 0,
  );
  assert.deepEqual(await snapshot(org.teamId), before, "an unreadable provenance stops the import, it does not overwrite it");
});

test("database: v20 adds no obstacle to any event that is not a gpexe import", async () => {
  const org = await setupTeam();
  // A connection and an event of another source system, the shape every
  // non-GPEXE importer and the existing test fixtures use.
  const connectionId = (await admin.query(
    `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('test-import','team',$1) returning id`,
    [org.teamId],
  )).rows[0].id;
  const withConnection = (await admin.query(
    `insert into training_load.metric_events
       (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_team_id, source_connection_id, source_external_id, event_timezone_snapshot)
     values ('csv upload','2026-09-14','2026-09-14T18:08:12Z','session','team',$1,$2,'file:rows.csv',$3) returning id`,
    [org.teamId, connectionId, TZ],
  )).rows[0].id;
  const withoutConnection = (await admin.query(
    `insert into training_load.metric_events
       (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_team_id, event_timezone_snapshot)
     values ('manual entry','2026-09-14','2026-09-14T18:08:12Z','session','team',$1,$2) returning id`,
    [org.teamId, TZ],
  )).rows[0].id;

  // No binding is created for them, so nothing new stands in the way: both
  // still delete exactly as they did before this migration.
  await assert.doesNotReject(admin.query(`delete from training_load.metric_events where id = any($1::uuid[])`, [[withConnection, withoutConnection]]));
  await assert.doesNotReject(admin.query(`delete from training_load.metric_source_connections where id = $1`, [connectionId]));
});

test("database: a binding can be neither updated nor deleted", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 5028, athletes: standardAthletes() }));
  await assert.rejects(
    admin.query(`update training_load.metric_event_source_bindings set reference_hash = 'x' where event_id = $1`, [summary.eventId]),
    /immutable/,
  );
  await assert.rejects(
    admin.query(`delete from training_load.metric_event_source_bindings where event_id = $1`, [summary.eventId]),
    /cannot be deleted/,
  );
});

test("writer: an existing event without a binding stops instead of recording a threshold set for values it did not produce", async () => {
  const org = await setupTeam();
  // An event that predates this guard: imported by an earlier writer, so no
  // binding exists and nothing says which threshold set produced its values.
  const connectionId = (await admin.query(
    `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1) returning id`,
    [org.teamId],
  )).rows[0].id;
  await admin.query(
    `insert into training_load.metric_events
       (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_team_id, source_connection_id, source_external_id, event_timezone_snapshot)
     values ('earlier import','2026-09-14','2026-09-14T18:08:12Z','session','team',$1,$2,'team_session:5027',$3)`,
    [org.teamId, connectionId, TZ],
  );
  await assert.rejects(
    runImport(org, makeBundle({ sessionId: 5027, athletes: standardAthletes() })),
    (e) => e.code === "binding_missing",
  );
  const bindings = (await admin.query(
    `select count(*)::int as c from training_load.metric_event_source_bindings b join training_load.metric_events e on e.id = b.event_id where e.owner_team_id = $1`,
    [org.teamId],
  )).rows[0].c;
  assert.equal(bindings, 0, "no binding is invented for it");
});

test("dashboard: source policy api_import now returns imported session and drill values; manual returns none", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 5008, athletes: standardAthletes() }));
  const distance = (await admin.query(`select id from training_load.metric_definitions where owner_team_id = $1 and key = 'gpexe_total_distance'`, [org.teamId])).rows[0].id;

  const { runDashboardBatchQuery } = await loadAppModule("../src/trainingLoadDashboardQuery.js");
  const spec = (id, dataScopeLevel, sourcePolicy) => ({
    widgetId: id, seriesId: id, metricDefinitionId: distance, dataScopeLevel, sourcePolicy,
    aggregationRolePolicy: "standalone_and_source_rollup", coveragePolicy: "complete_and_partial", groupBy: "athlete", analyticalAggregation: "sum",
  });
  const results = await runDashboardBatchQuery(
    { dataWorkspaceType: "team", dataWorkspaceScopeId: org.teamId, dateFrom: "2026-09-14", dateTo: "2026-09-14" },
    [spec("s-import", "session", "api_import"), spec("c-import", "component", "api_import"), spec("s-manual", "session", "manual")],
  );
  const byId = Object.fromEntries(results.map((r) => [r.widgetId, r]));
  for (const r of results) assert.equal(r.status, "ok", JSON.stringify(r));
  const total = (rows) => rows.reduce((acc, row) => acc + Number(row.value ?? 0), 0);
  assert.equal(total(byId["s-import"].data.current), 3000 + 1500, "whole-session distance of both imported athletes");
  assert.equal(total(byId["c-import"].data.current), 1600 + 1400 + 1500, "drill distances");
  assert.equal(byId["s-manual"].data.current.length, 0);
});

// ------------------------------------------------------------
// CLI guard
// ------------------------------------------------------------
test("CLI --apply refuses OPTIMOVE, monitoring2, remote hosts and non-disposable names before connecting", () => {
  for (const url of [
    "postgresql://u:p@localhost:5432/OPTIMOVE",
    "postgresql://u:p@localhost:5432/optimove",
    "postgresql://u:p@localhost:5432/monitoring2",
    "postgresql://u:p@db.example.supabase.com:5432/optimove_tests_gpexe_x",
    "postgresql://u:p@localhost:5432/optimove_tests_tlmetrics_primary_abc",
    // pg's connection-string parser lets query parameters override host/port.
    "postgresql://u:p@localhost:5432/optimove_tests_gpexe_x?host=db.example.supabase.com",
    "postgresql://u:p@localhost:5432/optimove_tests_gpexe_x?port=6543",
  ]) {
    assert.throws(() => describeApplyTarget(url), /refusing --apply/, url);
  }
  assert.throws(() => describeApplyTarget(undefined), /explicit --database-url/);
  assert.deepEqual(describeApplyTarget("postgresql://u:p@localhost:5432/optimove_tests_gpexe_ok_1"), { host: "localhost", port: "5432", database: "optimove_tests_gpexe_ok_1" });
});

test("CLI --apply refuses a disposable-looking database without the marker, and a name mismatch", async () => {
  const base = new URL(ORIGINAL_DATABASE_URL);
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  const name = `optimove_tests_gpexe_nomarker_${Date.now()}`;
  const server = new pg.Client({ connectionString: adminUrl.toString() });
  await server.connect();
  await server.query(`create database "${name}"`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    await assert.rejects(assertDisposableApplyTarget(client, { database: name }), /has no public\.optimove_disposable_test_database marker/);
    await assert.rejects(assertDisposableApplyTarget(client, { database: "optimove_tests_gpexe_other" }), /connected to/);
  } finally {
    await client.end();
    await server.query(`drop database if exists "${name}"`);
    await server.end();
  }
  const markedClient = await newClient();
  try {
    await assert.doesNotReject(assertDisposableApplyTarget(markedClient, { database: db.name }));
  } finally {
    await markedClient.end();
  }
});

test("CLI dry run opens no database connection and creates nothing", async () => {
  const org = await setupTeam();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gpexe-dry-run-"));
  try {
    const bundle = makeBundle({ sessionId: 5009, athletes: standardAthletes() });
    await fsp.writeFile(path.join(dir, "session_5009_detail.json"), JSON.stringify(bundle.teamSession));
    await fsp.writeFile(path.join(dir, "team_77_thresholds_2026-09-14.json"), JSON.stringify(bundle.teamThresholds));
    await fsp.writeFile(path.join(dir, "session_5009_details_whole.json"), JSON.stringify(bundle.details.full));
    await fsp.writeFile(path.join(dir, "session_5009_details_drill_index_0.json"), JSON.stringify(bundle.details.drills["0"]));
    for (const row of bundle.athleteSessions) {
      await fsp.writeFile(path.join(dir, `athlete_session_${row.id}.json`), JSON.stringify(row));
      await fsp.writeFile(path.join(dir, `athlete_session_${row.id}_more.json`), JSON.stringify(bundle.more[String(row.id)]));
    }
    for (const track of Object.values(bundle.tracks)) await fsp.writeFile(path.join(dir, `track_${track.id}.json`), JSON.stringify(track));

    const connectionsBefore = (await admin.query(`select count(*)::int as c from pg_stat_activity where datname = $1`, [db.name])).rows[0].c;
    const log = console.log;
    console.log = () => {};
    let result;
    try {
      // An unreachable URL proves no connection is attempted in dry-run mode.
      result = await cliMain(["--raw-dir", dir, "--team-session", "5009", "--database-url", "postgresql://u:p@192.0.2.1:5432/optimove_tests_gpexe_x"]);
    } finally {
      console.log = log;
    }
    assert.equal(result.summary, undefined);
    assert.equal(result.plan.participants.length, 2);
    assert.equal(byExternalId(result.plan).get("athlete_session:500902:drill:0").values.length, 11, "drill 0 details were loaded from the raw dir");
    assert.deepEqual(await snapshot(org.teamId), Object.fromEntries(Object.keys(TEAM_TABLES).map((k) => [k, 0])));
    const definitions = (await admin.query(`select count(*)::int as c from training_load.metric_definitions where key like 'gpexe_%' and owner_team_id = $1`, [org.teamId])).rows[0].c;
    assert.equal(definitions, 0);
    const connectionsAfter = (await admin.query(`select count(*)::int as c from pg_stat_activity where datname = $1`, [db.name])).rows[0].c;
    assert.equal(connectionsAfter, connectionsBefore);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
